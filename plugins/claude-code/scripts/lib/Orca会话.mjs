import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MANAGED_ROOT, controllerId, readJson, writeJson, resolveModel, listTasks, readRuntime } from "./managed-state.mjs";

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalized = (value) => {
  let resolved; try { resolved = fs.realpathSync.native(value); } catch { resolved = path.resolve(value); }
  const result = resolved.replace(/\\/g, "/"); return process.platform === "win32" ? result.toLowerCase() : result;
};
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
let executable;

async function orca(args, cwd) {
  if (!executable) {
    if (process.env.ORCA_CLI_COMMAND) executable = process.env.ORCA_CLI_COMMAND;
    else {
      const name = process.env.ORCA_DEV_REPO_ROOT ? "orca-dev" : process.platform === "linux" ? "orca-ide" : "orca";
      if (process.platform !== "win32") executable = name;
      else {
        const result = await execute("powershell.exe", ["-NoProfile", "-Command",
          `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); (Get-Command ${name} -ErrorAction Stop).Source`],
        { windowsHide: true, encoding: "utf8", timeout: 5000 });
        executable = result.stdout.trim();
      }
    }
  }
  let output;
  try { output = await execute(executable, [...args, "--json"], { cwd, windowsHide: true, encoding: "utf8", timeout: 65000, maxBuffer: 2_000_000 }); }
  catch (error) {
    // 不输出启动命令或配置内容，尤其不能把终端中的凭据带入错误摘要。
    throw new Error(`Orca CLI 调用失败（${error.code || "未知"}），请核对已选 CLI 和运行时；不会切换其他安装或重发指令`);
  }
  let response; try { response = JSON.parse(output.stdout); } catch { throw new Error("Orca 返回内容不是 JSON"); }
  if (!response.ok) throw new Error(`Orca 拒绝操作：${response.error?.code || "未知错误"}`);
  return response;
}

export function statusIdentity(lines) {
  const text = lines.join("\n");
  const id = text.match(/Session ID:\s*([0-9a-f-]{36})/i)?.[1];
  const cwd = text.match(/^\s*cwd:\s*(.+)$/im)?.[1]?.trim();
  return id && UUID.test(id) && cwd ? { sessionId: id.toLowerCase(), cwd } : null;
}

export function emptyPrompt(lines) {
  const prompts = lines.filter((line) => /^\s*[❯>]\s*/.test(line));
  return Boolean(prompts.length && /^\s*[❯>]\s*(?:Try\s+".*")?\s*$/.test(prompts.at(-1)));
}

function transcriptFile(sessionId) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let folders; try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const matches = folders.filter((d) => d.isDirectory()).map((d) => path.join(root, d.name, `${sessionId}.jsonl`)).filter((f) => fs.existsSync(f));
  return matches.length === 1 ? matches[0] : null;
}

export function readTurn(sessionId, cwd, instruction) {
  const file = transcriptFile(sessionId);
  if (!file) return { logged: false, completed: false, text: "", available: false };
  const size = fs.statSync(file).size, start = instruction.baseline || 0;
  if (size < start) return { logged: false, completed: false, text: "", available: false, changed: true };
  // 只读取本次指令之后的记录；超过限额明确报告，不把不完整数据当成验收依据。
  const length = Math.min(size - start, 512 * 1024), buffer = Buffer.alloc(length), fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, length, start); } finally { fs.closeSync(fd); }
  let logged = false, completed = false, text = "", ambiguous = false;
  for (const line of buffer.toString("utf8").split("\n")) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.sessionId !== sessionId || e.cwd && normalized(e.cwd) !== normalized(cwd) || e.isSidechain || e.isMeta) continue;
    const content = e.message?.content;
    const promptText = typeof content === "string" ? content : Array.isArray(content) && content.length && content.every((part) => part.type === "text") ? content.map((part) => part.text).join("\n") : null;
    if (e.type === "user" && promptText !== null) {
      if (!logged && promptText === instruction.prompt) logged = true;
      else if (logged) { if (!completed) ambiguous = true; break; }
    }
    if (logged && e.type === "assistant") {
      const body = (Array.isArray(content) ? content : []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
      if (body) text += `${text ? "\n" : ""}${body}`;
      if (body && e.message?.stop_reason === "end_turn") completed = true;
    }
  }
  return { logged, completed: completed && !ambiguous && size - start <= length, text: text.slice(-16000), available: true,
    ambiguous, truncated: size - start > length };
}

export function createOrcaAdapter({ call = orca, root = path.join(MANAGED_ROOT, "orca"), observe = readTurn } = {}) {
  const folder = path.join(root, "会话"), requests = path.join(root, "请求");
  const recordPath = (id) => { if (!UUID.test(String(id))) throw new Error("须使用精确 Orca 接入记录 ID"); return path.join(folder, `${id}.json`); };
  const records = () => { try { return fs.readdirSync(folder).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(folder, f))).filter(Boolean); } catch { return []; } };
  const summary = (r) => ({ id: r.id, controllerId: r.controllerId, sessionId: r.sessionId, cwd: r.cwd,
    terminalId: r.terminalId, incarnationId: r.incarnationId, runtimeId: r.runtimeId, createdByPlugin: r.createdByPlugin,
    state: r.state, model: r.model, lastInstruction: r.lastInstruction ? { requestId: r.lastInstruction.requestId,
      state: r.lastInstruction.state, orcaRequestId: r.lastInstruction.orcaRequestId } : null });

  async function bound(r) {
    const response = await call(["terminal", "show", "--terminal", r.terminalId], r.cwd), t = response.result.terminal;
    if (response._meta?.runtimeId !== r.runtimeId || t.incarnationId !== r.incarnationId || normalized(t.worktreePath) !== normalized(r.cwd) || !t.connected || !t.writable || t.agentIdentity !== "claude") {
      throw new Error("Orca 运行时、终端实例或目录已变化，须重新列出并按原会话 ID 接入；不会自动重开或双发");
    }
    return t;
  }

  async function screen(t, cwd) {
    const result = await call(["terminal", "read", "--terminal", t.handle, "--limit", "100"], cwd);
    return result.result.terminal;
  }

  async function identity(t, cwd) {
    const idle = await call(["terminal", "wait", "--terminal", t.handle, "--for", "tui-idle", "--timeout-ms", "1000"], cwd);
    if (!idle.result.wait.satisfied) throw new Error(`Claude 尚未空闲：${idle.result.wait.blockedReason || "当前轮未结束"}`);
    const before = await screen(t, cwd);
    let identity = statusIdentity(before.tail), opened = false;
    if (!identity) {
      if (before.draft || !emptyPrompt(before.tail)) throw new Error("Claude 当前有草稿、弹窗或未就绪，不能注入 /status 或任务");
      await call(["terminal", "send", "--terminal", t.handle, "--text", "/status", "--enter"], cwd);
      opened = true;
      for (let i = 0; i < 15; i++) {
        const current = await screen(t, cwd); identity = statusIdentity(current.tail);
        if (identity) break;
        await pause(200);
      }
    }
    if (!identity) throw new Error("无法从 Claude /status 验证真实会话身份；停止接入，不猜测目标");
    // 接入握手关闭刚读取的状态面板，只发送 Esc，不中断工作轮。
    await call(["terminal", "send", "--terminal", t.handle, "--text", "\u001b"], cwd);
    let ready = false;
    for (let i = 0; i < 10; i++) { const current = await screen(t, cwd); if (!current.draft && emptyPrompt(current.tail)) { ready = true; break; } await pause(100); }
    if (!ready) throw new Error("状态面板关闭后仍有草稿或弹窗，停止派发");
    if (normalized(identity.cwd) !== normalized(cwd)) throw new Error("Claude /status 原目录与目标工作区不一致");
    return { ...identity, probed: opened };
  }

  function updateTurn(r) {
    if (!r.lastInstruction) return { ...summary(r), turn: null };
    const turn = observe(r.sessionId, r.cwd, r.lastInstruction);
    if (turn.logged) r.lastInstruction.state = turn.completed ? "completed" : "logged";
    writeJson(recordPath(r.id), r);
    return { ...summary(r), turn };
  }

  async function operation(args, master) {
    if (args.action === "list") {
      if (!args.cwd || !path.isAbsolute(args.cwd)) throw new Error("须提供绝对工作区目录");
      const response = await call(["terminal", "list", "--worktree", `path:${args.cwd}`, "--limit", "100"], args.cwd);
      return { runtimeId: response._meta?.runtimeId, terminals: response.result.terminals.filter((t) => t.agentIdentity === "claude").map((t) => ({
        terminalId: t.handle, incarnationId: t.incarnationId, cwd: t.worktreePath, title: t.title, connected: t.connected,
        records: records().filter((r) => r.controllerId === master && r.terminalId === t.handle && r.state === "attached").map(summary) })), truncated: response.result.truncated };
    }
    if (["create", "attach"].includes(args.action)) {
      if (!args.cwd || !path.isAbsolute(args.cwd) || !fs.existsSync(args.cwd)) throw new Error("须提供存在的绝对工作区目录");
      const active = records().filter((r) => r.state === "attached");
      if (args.action === "attach") {
        if (!UUID.test(String(args.session_id))) throw new Error("须提供精确 Claude 会话 UUID");
        if (args.idle_confirmed !== true) throw new Error("接入需要确认人类队列已清空，允许空闲时执行 /status 身份握手");
        if (listTasks().some((task) => task.sessionId?.toLowerCase() === args.session_id.toLowerCase() && !task.archivedAt &&
          (["queued", "starting"].includes(task.state) || readRuntime(task.id)?.status && readRuntime(task.id).status !== "exited"))) throw new Error("该 Claude UUID 已被原生托管后端占用，不能同时交给 Orca 后端");
        const response = await call(["terminal", "list", "--worktree", `path:${args.cwd}`, "--limit", "100"], args.cwd);
        const candidates = response.result.terminals.filter((t) => t.agentIdentity === "claude" && t.connected && t.writable && (!args.terminal_id || t.handle === args.terminal_id));
        if (response.result.truncated && !args.terminal_id) throw new Error("终端列表未完整返回，须指定终端 ID 后核对");
        for (const t of candidates) {
          if (active.some((r) => r.terminalId === t.handle && r.controllerId !== master)) continue;
          let checked; try { checked = await identity(t, args.cwd); } catch { continue; }
          if (checked.sessionId !== args.session_id.toLowerCase()) continue;
          const existing = active.find((r) => r.terminalId === t.handle);
          if (existing) {
            if (existing.sessionId !== checked.sessionId || existing.incarnationId !== t.incarnationId || existing.runtimeId !== response._meta.runtimeId) throw new Error("原接入绑定已失效，请先释放旧记录");
            return { ...summary(existing), duplicate: true };
          }
          if (active.some((r) => r.sessionId === checked.sessionId)) throw new Error("该 Claude 会话已经被另一条 Orca 接入记录占用");
          const r = { id: crypto.randomUUID(), controllerId: master, ...checked, cwd: args.cwd, terminalId: t.handle,
            incarnationId: t.incarnationId, runtimeId: response._meta.runtimeId, createdByPlugin: false, state: "attached", createdAt: new Date().toISOString() };
          writeJson(recordPath(r.id), r); return summary(r);
        }
        throw new Error("没有找到身份吻合且空闲的 Orca Claude 终端；未重启任何会话");
      }
      if (process.platform !== "win32") throw new Error("Orca 新建启动命令当前仅适配 Windows PowerShell");
      const model = resolveModel(args.model), sessionId = crypto.randomUUID();
      // --command 由 PowerShell 执行，所有可变参数均使用单引号转义；不拼接任务正文。
      const command = `claude --session-id ${quote(sessionId)}${model ? ` --model ${quote(model)}` : ""}`;
      const response = await call(["terminal", "create", "--worktree", `path:${args.cwd}`, "--title", args.title || "Codex 委派 Claude", "--shell", "pwsh.exe", "--command", command], args.cwd);
      const t = response.result.terminal;
      if (!t?.handle || !t.incarnationId || !response._meta?.runtimeId) throw new Error("Orca 未返回完整终端身份；新建回执不明，请先列出核对");
      const r = { id: crypto.randomUUID(), controllerId: master, sessionId, cwd: args.cwd, terminalId: t.handle,
        incarnationId: t.incarnationId, runtimeId: response._meta.runtimeId, createdByPlugin: true, state: "attached", model,
        createdAt: new Date().toISOString() };
      writeJson(recordPath(r.id), r);
      return { ...summary(r), ready: false, message: "原生终端已创建。首次信任或配置弹窗请在 Orca 处理；空闲后用 send 派发任务。" };
    }
    const r = readJson(recordPath(args.id));
    if (!r || r.controllerId !== master) throw new Error("该 Orca 接入记录不属于当前 Codex 主控");
    if (r.state !== "attached") throw new Error("接入已释放或关闭，须重新接入");
    if (args.action === "release") { r.state = "released"; writeJson(recordPath(r.id), r); return { ...summary(r), terminalKeptAlive: true }; }
    const t = await bound(r);
    if (args.action === "close") {
      if (!r.createdByPlugin && args.close_attached_confirmed !== true) throw new Error("关闭已有用户终端须明确确认；只交还控制权请用 release");
      await call(["terminal", "close", "--terminal", r.terminalId], r.cwd);
      r.state = "closed"; writeJson(recordPath(r.id), r); return summary(r);
    }
    if (args.action === "status") return { ...updateTurn(r), terminal: { connected: t.connected, writable: t.writable, agentWait: t.agentWait } };
    if (args.action === "read") {
      const options = ["terminal", "read", "--terminal", r.terminalId, "--limit", String(Math.min(Math.max(Number(args.limit) || 60, 1), 300))];
      if (args.cursor != null) options.push("--cursor", String(args.cursor));
      const result = await call(options, r.cwd); return { ...updateTurn(r), screen: result.result.terminal };
    }
    if (args.action === "wait") {
      const wait = await call(["terminal", "wait", "--terminal", r.terminalId, "--for", "tui-idle", "--timeout-ms", String(Math.min(Math.max(Number(args.timeout_ms) || 10000, 1), 60000))], r.cwd);
      return { ...updateTurn(r), wait: wait.result.wait };
    }
    if (args.action !== "send") throw new Error("未知 Orca 会话操作");
    if (!args.prompt || typeof args.prompt !== "string" || args.prompt.length > 50000 || /^[\s]*\//.test(args.prompt) || /[\u0000-\u0008\u001b]/.test(args.prompt)) throw new Error("须提供普通任务正文；不接受斜杠命令或终端控制字符");
    if (r.lastInstruction && !["completed"].includes(updateTurn(r).lastInstruction.state)) throw new Error("上一条指令尚未确认完成，先读取并核对，不能重复派发");
    const checked = await identity(t, r.cwd);
    if (checked.sessionId !== r.sessionId) throw new Error("Claude 实际会话 ID 已变化，停止发送，须按新 ID 重新接入");
    const file = transcriptFile(r.sessionId);
    r.lastInstruction = { requestId: args.request_id, prompt: args.prompt, state: "pending", baseline: file ? fs.statSync(file).size : 0 };
    writeJson(recordPath(r.id), r);
    // 写入不明时禁止自动重发；请求日志保留 pending，后续只读取实际状态。
    const response = await call(["terminal", "send", "--terminal", r.terminalId, "--text", args.prompt, "--enter", "--wait-submit", "10"], r.cwd);
    const receipt = response.result.send;
    r.lastInstruction.state = receipt.prompt?.stages?.includes("turn_started") ? "started" : receipt.accepted ? "accepted" : "rejected";
    r.lastInstruction.orcaRequestId = receipt.prompt?.requestId || response.result.mutation?.requestId;
    writeJson(recordPath(r.id), r);
    return { ...updateTurn(r), receipt, message: "accepted 仅表示输入接收；logged/completed 由精确会话记录核对。回执不明时不重发。" };
  }

  return async (args = {}) => {
    const master = args.controller_id || controllerId();
    if (!master) throw new Error("请提供 Codex 主控任务 ID");
    const mutate = ["create", "attach", "send", "release", "close"].includes(args.action);
    if (!mutate) return operation(args, master);
    if (!args.request_id || typeof args.request_id !== "string" || args.request_id.length > 120) throw new Error("改变 Orca 会话须提供稳定 request_id");
    // 跨 MCP 进程串行修改，崩溃后的请求保持不明状态，不能凭空重复新建或发送。
    fs.mkdirSync(root, { recursive: true });
    const lock = path.join(root, "操作锁");
    try { fs.mkdirSync(lock); } catch {
      const owner = readJson(path.join(lock, "持有者.json"));
      let alive = owner?.pid ? true : Date.now() - fs.statSync(lock).mtimeMs < 5000;
      if (owner?.pid) { try { process.kill(owner.pid, 0); } catch { alive = false; } }
      if (alive) throw new Error("Orca 桥接器正在操作，请稍后重试原 request_id");
      if (fs.existsSync(path.join(lock, "持有者.json"))) fs.unlinkSync(path.join(lock, "持有者.json"));
      fs.rmdirSync(lock); fs.mkdirSync(lock);
    }
    writeJson(path.join(lock, "持有者.json"), { pid: process.pid });
    try {
      const key = crypto.createHash("sha256").update(`${master}\n${args.request_id}`).digest("hex"), file = path.join(requests, `${key}.json`);
      const signature = JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]])), prior = readJson(file);
      if (prior) {
        if (prior.signature !== signature) throw new Error("request_id 已用于不同的 Orca 操作");
        return prior.result ? { ...prior.result, duplicate: true } : { uncertain: true, message: "原请求回执不明，先列出终端并核对接入记录；不会重发", requestId: args.request_id };
      }
      writeJson(file, { signature, state: "pending" });
      try {
        const result = await operation(args, master); writeJson(file, { signature, state: "done", result }); return result;
      } catch (error) {
        writeJson(file, { signature, state: "uncertain", message: error.message }); throw error;
      }
    } finally { fs.unlinkSync(path.join(lock, "持有者.json")); fs.rmdirSync(lock); }
  };
}

export const orcaSessions = createOrcaAdapter();
