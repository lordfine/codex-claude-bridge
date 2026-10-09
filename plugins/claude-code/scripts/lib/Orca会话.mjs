import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MANAGED_ROOT, controllerId, readJson, writeJson, resolveModel, listTasks, readRuntime } from "./managed-state.mjs";
import { observeInstruction, readHistory, diagnoseCursor, observeHumanActivity, readTaskResult, scanSession, entryText } from "./会话读取.mjs";
import { effectiveProfile, validateProfile, prepareRecordDocuments, deliveryInstruction } from "./协作策略.mjs";
import { orcaLaunch, executable as resolveExecutable } from "./平台适配.mjs";
import { statusResponse } from "./状态响应.mjs";
import { pendingWakeEvents, wakeDir } from "./事件队列.mjs";
import { updateJson } from "./原子文件.mjs";

const execute = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalized = (value) => {
  let resolved; try { resolved = fs.realpathSync.native(value); } catch { resolved = path.resolve(value); }
  const result = resolved.replace(/\\/g, "/"); return process.platform === "win32" ? result.toLowerCase() : result;
};
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
let executable;

export async function orcaCall(args, cwd) {
  if (!executable) {
    if (process.env.ORCA_CLI_COMMAND) executable = process.env.ORCA_CLI_COMMAND;
    else {
      const name = process.env.ORCA_DEV_REPO_ROOT ? "orca-dev" : process.platform === "linux" ? "orca-ide" : "orca";
      if (process.platform !== "win32") executable = resolveExecutable(name);
      else {
        const result = await execute("powershell.exe", ["-NoProfile", "-Command",
          `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); (Get-Command ${name} -ErrorAction Stop).Source`],
        { windowsHide: true, encoding: "utf8", timeout: 5000 });
        executable = result.stdout.trim();
      }
    }
  }
  let output, failure;
  try { output = await execute(executable, [...args, "--json"], { cwd, windowsHide: true, encoding: "utf8", timeout: 65000, maxBuffer: 2_000_000 }); }
  catch (error) { failure = error; output = { stdout: error.stdout || "" }; }
  return parseOrcaResponse(output.stdout, args, failure);
}

export function parseOrcaResponse(stdout, args, failure) {
  let response; try { response = JSON.parse(stdout); } catch {}
  if (response?.ok) return response;
  const rawCode = response?.error?.code;
  const code = typeof rawCode === "string" && /^[a-z0-9_-]{1,64}$/i.test(rawCode) ? rawCode : failure?.killed ? "TRANSPORT_TIMEOUT" : failure ? "CLI_EXIT" : "INVALID_JSON";
  const operation = args.slice(0, 2).join(".");
  if (/wait.*timeout|timeout.*wait/i.test(code) && args[1] === "wait") return { ok: true, result: { wait: { satisfied: false, timedOut: true, reason: "wait_timeout" } } };
  const error = new Error(`Orca 操作失败：${code}；阶段 ${operation}，不自动重发`);
  const rejectedBeforeInput = ["selector_not_found", "terminal_handle_stale"].includes(code);
  error.code = code; error.details = { code, operation, cliExitCode: typeof failure?.code === "number" ? failure.code : null,
    retryable: !["send", "create", "close"].includes(args[1]), uncertain: !rejectedBeforeInput && ["send", "create", "close"].includes(args[1]),
    inputRejected: rejectedBeforeInput, nextAction: code === "selector_not_found" ? "用worktree list核对已注册视图；repo add不等于终端可用，不重复创建Claude" : code === "terminal_handle_stale" ? "按原UUID与目录list/rebind，不判定Claude会话结束" : "按原请求核对回执" };
  throw error;
}

export function statusIdentity(lines) {
  const text = lines.join("\n");
  const id = text.match(/Session ID:\s*([0-9a-f-]{36})/i)?.[1];
  const cwd = text.match(/^\s*cwd:\s*(.+)$/im)?.[1]?.trim();
  return id && UUID.test(id) && cwd ? { sessionId: id.toLowerCase(), cwd } : null;
}

export function emptyPrompt(lines) {
  const prompts = lines.filter((line) => /^\s*[❯>]\s*/.test(line));
  return Boolean(prompts.length && /^\s*[❯>]\s*(?:(?:Try|试试|尝试)\s*["“「].*["”」])?\s*$/.test(prompts.at(-1)));
}

function transcriptFile(sessionId) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let folders; try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const matches = folders.filter((d) => d.isDirectory()).map((d) => path.join(root, d.name, `${sessionId}.jsonl`)).filter((f) => fs.existsSync(f));
  return matches.length === 1 ? matches[0] : null;
}

export function readTurn(sessionId, cwd, instruction, saved = {}) { return observeInstruction(sessionId, cwd, instruction, saved); }

export async function probeOrcaRecord(r, call = orcaCall) {
  let shown;
  try { shown = await call(["terminal", "show", "--terminal", r.terminalId], r.cwd); }
  catch (error) { if (error.code === "terminal_handle_stale") return { stale: true, code: error.code }; throw error; }
  const terminal = shown.result.terminal;
  if (shown._meta?.runtimeId !== r.runtimeId || terminal.incarnationId !== r.incarnationId || normalized(terminal.worktreePath) !== normalized(r.cwd) || !terminal.connected || !terminal.writable || terminal.agentIdentity !== "claude") return { stale: true, code: "BINDING_STALE" };
  const screen = (await call(["terminal", "read", "--terminal", r.terminalId, "--screen", "--limit", "24"], r.cwd)).result.terminal;
  const lines = screen.tail || [];
  const busy = lines.some((line) => /^\s*[✢✳✻✶✽*].*…|(?:Generating|Thinking|Working).*…|esc to interrupt/i.test(line));
  const needsInput = lines.some((line) => /Do you want to|Permission rule .*requires confirmation/i.test(line)) && lines.some((line) => /^\s*[❯>]\s*1\.\s*(?:Yes|Allow)/i.test(line));
  const draft = typeof screen.draft === "string" ? screen.draft : "";
  const fingerprint = draft ? crypto.createHash("sha256").update(draft).digest("hex") : null;
  const matchesBridge = Boolean(fingerprint && r.lastInstruction?.sentPromptHash === fingerprint);
  const recentInput = Date.now() - Date.parse(r.lastInstruction?.preparedAt || "") < 30000;
  const ownedEcho = Boolean(draft && recentInput && r.lastInstruction?.marker && draft.includes(r.lastInstruction.marker));
  const pendingInput = !busy && !needsInput && !statusIdentity(lines) && !emptyPrompt(lines);
  return { busy, needsInput, draft: Boolean(screen.draft), draftKind: "orca_ui_composer", inputPending: pendingInput,
    uiDraft: { present: Boolean(screen.draft), length: draft.length, fingerprint, source: "orca_ui_composer", author: "unknown", submitted: false },
    draftEvidence: { present: Boolean(screen.draft), length: draft.length, fingerprint, source: ownedEcho ? "bridge_submission_echo" : "orca_ui_composer", matchesBridgeRequest: matchesBridge, blocksDispatch: false },
    revision: crypto.createHash("sha256").update(JSON.stringify([busy, needsInput, pendingInput])).digest("hex") };
}

export function createOrcaAdapter({ call = orcaCall, root = path.join(MANAGED_ROOT, "orca"), observe = readTurn } = {}) {
  const folder = path.join(root, "会话"), requests = path.join(root, "请求");
  const recordPath = (id) => { if (!UUID.test(String(id))) throw new Error("须使用精确 Orca 接入记录 ID"); return path.join(folder, `${id}.json`); };
  const records = () => { try { return fs.readdirSync(folder).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(folder, f))).filter(Boolean); } catch { return []; } };
  const summary = (r) => ({ id: r.id, controllerId: r.controllerId, sessionId: r.sessionId, cwd: r.cwd,
    terminalId: r.terminalId, incarnationId: r.incarnationId, runtimeId: r.runtimeId, createdByPlugin: r.createdByPlugin,
    state: r.state, owner: r.owner || "codex", management: r.state === "attached" ? "retained" : "released", backgroundOutstanding: Boolean(r.observation?.backgroundOutstanding), terminalBlocker: r.terminalBlocker || null, humanActivity: r.humanActivity || null, model: r.model, profile: effectiveProfile(r), revision: r.revision || null, lastInstruction: r.lastInstruction ? { requestId: r.lastInstruction.requestId,
      state: r.lastInstruction.state, orcaRequestId: r.lastInstruction.orcaRequestId } : null });

  async function bound(r) {
    const response = await call(["terminal", "show", "--terminal", r.terminalId], r.cwd), t = response.result.terminal;
    if (response._meta?.runtimeId !== r.runtimeId || t.incarnationId !== r.incarnationId || normalized(t.worktreePath) !== normalized(r.cwd) || !t.connected || !t.writable || t.agentIdentity !== "claude") {
      throw Object.assign(new Error("Orca 运行时、终端实例或目录已变化，须重新列出并按原会话 ID 接入；不会自动重开或双发"), { code: "BINDING_STALE" });
    }
    return t;
  }

  async function screen(t, cwd) {
    const result = await call(["terminal", "read", "--terminal", t.handle, "--screen", "--limit", "100"], cwd);
    return result.result.terminal;
  }

  async function identity(t, cwd) {
    const idle = await call(["terminal", "wait", "--terminal", t.handle, "--for", "tui-idle", "--timeout-ms", "1000"], cwd);
    if (!idle.result.wait.satisfied) throw new Error(`Claude 尚未空闲：${idle.result.wait.blockedReason || "当前轮未结束"}`);
    const before = await screen(t, cwd);
    if (before.tail.some((line) => /^\s*[✢✳✻✶✽*].*…|(?:Generating|Thinking|Working).*…|esc to interrupt/i.test(line))) throw new Error("屏幕仍有执行信号，不能把空输入框当成工作已停止");
    let identity = statusIdentity(before.tail), opened = false;
    if (!identity) {
      if (!emptyPrompt(before.tail)) throw new Error("Claude终端输入区有未提交文字、弹窗或未就绪；UI composer与终端输入分开，不覆盖输入");
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
    for (let i = 0; i < 10; i++) { const current = await screen(t, cwd); if (emptyPrompt(current.tail)) { ready = true; break; } await pause(100); }
    if (!ready) throw new Error("状态面板关闭后仍有草稿或弹窗，停止派发");
    if (normalized(identity.cwd) !== normalized(cwd)) throw new Error("Claude /status 原目录与目标工作区不一致");
    return { ...identity, probed: opened };
  }

  function updateTurn(r, args = {}) {
    if (!r.lastInstruction) return statusResponse({ ...summary(r), turn: null });
    const turn = observe(r.sessionId, r.cwd, r.lastInstruction, r.observation || {});
    if (turn.logged && !["cancelled", "human_handoff"].includes(r.lastInstruction.terminalState)) r.lastInstruction.state = turn.completed ? "completed" : "logged";
    if (turn.failed && !["cancelled", "human_handoff"].includes(r.lastInstruction.terminalState)) r.lastInstruction.state = "failed";
    if (turn.nextUserObserved) r.owner = "human";
    r.observation = turn;
    r.revision = crypto.createHash("sha256").update(JSON.stringify([r.lastInstruction.state, turn.started, turn.firstAssistantUuid, turn.ambiguous, turn.changed, turn.available, r.owner, r.cancelRequested, turn.backgroundOutstanding, r.terminalBlocker, r.controlRevision])).digest("hex");
    const fresh = readJson(recordPath(r.id));
    if (fresh && (fresh.lastInstruction?.requestId !== r.lastInstruction.requestId || fresh.controlRevision !== r.controlRevision || fresh.state !== r.state)) return { ...summary(fresh), changedDuringObservation: true, turn: null };
    const committed = updateJson(recordPath(r.id), (current) => current?.lastInstruction?.requestId === r.lastInstruction.requestId && current.controlRevision === r.controlRevision && current.state === r.state ? { ...current, observation: r.observation, lastInstruction: r.lastInstruction, owner: r.owner, revision: r.revision } : undefined);
    if (committed?.lastInstruction?.requestId !== r.lastInstruction.requestId || committed?.controlRevision !== r.controlRevision) return { ...summary(committed), changedDuringObservation: true, turn: null };
    const { text, ...short } = turn;
    const unchanged = args.after_revision === r.revision;
    return statusResponse({ ...summary(r), unchanged, turn: unchanged ? null : { ...short, ...(args.include_text ? { text } : {}) },
      submission: { kind: r.lastInstruction.kind === "compact" ? "command" : "task", state: turn.completed ? "completed" : turn.started ? "started" : turn.logged ? "received" : ["accepted", "started"].includes(r.lastInstruction.state) ? "sent_unconfirmed" : "pending_send",
        logged: Boolean(turn.logged), started: Boolean(turn.started), userUuid: turn.userUuid || null, firstAssistantUuid: turn.firstAssistantUuid || null, requestId: r.lastInstruction.requestId } });
  }

  async function rebind(r, args, checkedTerminal, checkedResponse, verified) {
    if (args.idle_confirmed !== true) throw new Error("重绑定须确认人类当前轮、队列与草稿已处理");
    let response = checkedResponse, target = checkedTerminal, checked = verified;
    if (!target) {
      response = await call(["terminal", "list", "--worktree", `path:${r.cwd}`, "--limit", "100"], r.cwd);
      if (response.result.truncated) throw new Error("终端列表不完整，不自动选择替代终端");
      const candidates = response.result.terminals.filter((t) => t.agentIdentity === "claude" && t.connected && t.writable && normalized(t.worktreePath) === normalized(r.cwd) && (!args.terminal_id || t.handle === args.terminal_id));
      if (args.terminal_id) {
        if (candidates.length !== 1) throw new Error("指定替代终端不存在或不唯一");
        target = candidates[0];
      } else {
        const matches = [];
        for (const candidate of candidates) {
          const view = await screen(candidate, r.cwd), seen = statusIdentity(view.tail || []);
          if (seen?.sessionId === r.sessionId && normalized(seen.cwd) === normalized(r.cwd)) matches.push(candidate);
        }
        if (matches.length !== 1) throw new Error("未找到只读身份唯一匹配的替代终端；请从 list 指定 terminal_id，不猜测或重开");
        target = matches[0];
      }
    }
    if (records().some((other) => other.state === "attached" && other.id !== r.id && (other.terminalId === target.handle || other.sessionId === r.sessionId))) throw new Error("替代终端或该Claude会话被其他接入记录占用");
    checked ||= await identity(target, r.cwd);
    if (checked.sessionId !== r.sessionId || normalized(checked.cwd) !== normalized(r.cwd)) throw new Error("替代终端真实Claude身份不匹配，保留原绑定");
    const final = await call(["terminal", "show", "--terminal", target.handle], r.cwd), finalTerminal = final.result.terminal;
    if (final._meta?.runtimeId !== response._meta?.runtimeId || finalTerminal.incarnationId !== target.incarnationId || !finalTerminal.connected || !finalTerminal.writable || normalized(finalTerminal.worktreePath) !== normalized(r.cwd) || finalTerminal.agentIdentity !== "claude") throw new Error("身份握手期间Orca实例变化，保留原绑定");
    const fresh = readJson(recordPath(r.id));
    if (!fresh || fresh.controlRevision !== r.controlRevision || fresh.state !== "attached") throw new Error("重绑定期间原记录变化，停止写入");
    r.bindingHistory = [...(r.bindingHistory || []), { terminalId: r.terminalId, incarnationId: r.incarnationId, runtimeId: r.runtimeId, at: new Date().toISOString() }].slice(-20);
    r.terminalId = target.handle; r.incarnationId = target.incarnationId; r.runtimeId = response._meta.runtimeId;
    r.controlRevision = (r.controlRevision || 0) + 1; r.terminalBlocker = null; writeJson(recordPath(r.id), r);
    return { ...summary(r), binding: { state: "verified", rebound: true }, message: "保留原接入编号、指令、游标与交付关联；未重开、未重发" };
  }

  async function operation(args, master, transaction = {}) {
    if (args.action === "history") {
      const record = args.id ? readJson(recordPath(args.id)) : null;
      if (args.id && (!record || record.controllerId !== master)) throw new Error("接入记录不存在或属于其他主控");
      return readHistory({ ...args, session_id: record?.sessionId || args.session_id, cwd: record?.cwd || args.cwd });
    }
    if (args.action === "list") {
      if (!args.cwd || !path.isAbsolute(args.cwd)) throw new Error("须提供绝对工作区目录");
      const response = await call(["terminal", "list", "--worktree", `path:${args.cwd}`, "--limit", "100"], args.cwd);
      return { runtimeId: response._meta?.runtimeId, terminals: response.result.terminals.filter((t) => t.agentIdentity === "claude").map((t) => ({
        terminalId: t.handle, incarnationId: t.incarnationId, cwd: t.worktreePath, title: t.title, connected: t.connected,
        records: records().filter((r) => r.controllerId === master && r.terminalId === t.handle && r.state === "attached").map(summary) })), truncated: response.result.truncated };
    }
    if (["create", "attach"].includes(args.action)) {
      if (args.profile != null) validateProfile(args.profile);
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
            if (existing.sessionId !== checked.sessionId) throw new Error("原接入绑定的Claude身份变化，不替换目标会话");
            if (existing.incarnationId !== t.incarnationId || existing.runtimeId !== response._meta.runtimeId) return rebind(existing, args, t, response, checked);
            return { ...summary(existing), duplicate: true };
          }
          const sameSession = active.find((r) => r.sessionId === checked.sessionId);
          if (sameSession) {
            if (sameSession.controllerId !== master || normalized(sameSession.cwd) !== normalized(args.cwd)) throw new Error("该 Claude 会话已经被另一条 Orca 接入记录占用");
            return rebind(sameSession, args, t, response, checked);
          }
          const r = { id: crypto.randomUUID(), controllerId: master, ...checked, cwd: args.cwd, terminalId: t.handle,
            incarnationId: t.incarnationId, runtimeId: response._meta.runtimeId, createdByPlugin: false, state: "attached", coordinationProfile: args.profile || null, createdAt: new Date().toISOString() };
          const file = transcriptFile(r.sessionId); r.managementCursor = { offset: file ? fs.statSync(file).size : 0 };
          writeJson(recordPath(r.id), r); return summary(r);
        }
        throw new Error("没有找到身份吻合且空闲的 Orca Claude 终端；未重启任何会话");
      }
      const model = resolveModel(args.model), sessionId = crypto.randomUUID();
      // --command 由 PowerShell 执行，所有可变参数均使用单引号转义；不拼接任务正文。
      const launch = orcaLaunch(sessionId, model);
      const response = await call(["terminal", "create", "--worktree", `path:${args.cwd}`, "--title", args.title || "Codex 委派 Claude", "--shell", launch.shell, "--command", launch.command], args.cwd);
      const t = response.result.terminal;
      if (!t?.handle || !t.incarnationId || !response._meta?.runtimeId) throw new Error("Orca 未返回完整终端身份；新建回执不明，请先列出核对");
      const r = { id: crypto.randomUUID(), controllerId: master, sessionId, cwd: args.cwd, terminalId: t.handle,
        incarnationId: t.incarnationId, runtimeId: response._meta.runtimeId, createdByPlugin: true, state: "attached", model,
        coordinationProfile: args.profile || null, createdAt: new Date().toISOString() };
      writeJson(recordPath(r.id), r);
      return { ...summary(r), ready: false, message: "原生终端已创建。首次信任或配置弹窗请在 Orca 处理；空闲后用 send 派发任务。" };
    }
    const readOnly = ["status", "read", "wait", "transcript", "diagnose", "human_activity", "confirm_submission"].includes(args.action);
    let r = UUID.test(String(args.id)) ? readJson(recordPath(args.id)) : null;
    if (!r && readOnly) {
      const session = args.session_id || args.id;
      const candidates = records().filter((item) => item.controllerId === master && item.state === "attached" &&
        (session && item.sessionId === String(session).toLowerCase() || !session && args.request_id && item.lastInstruction?.requestId === args.request_id) &&
        (!args.cwd || normalized(item.cwd) === normalized(args.cwd)));
      if (candidates.length === 1) r = candidates[0];
      else throw new Error("查询需要精确接入id，或当前主控下唯一匹配的session_id＋cwd／request_id；不选择最近会话");
    }
    if (!r || r.controllerId !== master) throw new Error("该 Orca 接入记录不属于当前 Codex 主控；修改操作须用create/attach返回的id");
    if (r.state !== "attached") throw new Error("接入已释放或关闭，须重新接入");
    const queueFile = path.join(root, "队列", `${r.id}.json`);
    if (args.action === "cancel_queued") {
      const items = readJson(queueFile) || [], item = items.find((i) => i.requestId === args.queued_request_id);
      if (!item || !["queued", "cancelled"].includes(item.state)) throw new Error("只可取消尚未发送的精确队列项；已发送或回执不明须核对原请求");
      item.state = "cancelled"; item.cancelledAt ||= new Date().toISOString(); writeJson(queueFile, items);
      return { id: r.id, requestId: item.requestId, state: "cancelled", inputMayHaveBeenSent: false };
    }
    if (args.action === "queue") {
      const items = (readJson(queueFile) || []).map((item) => item.requestId === r.lastInstruction?.requestId && r.observation?.completed ? { ...item, state: "completed", commandCompleted: r.lastInstruction.kind === "compact", businessDelivered: r.lastInstruction.kind !== "compact" } : item);
      const count = Math.min(Math.max(Number(args.limit) || 10, 1), 30), cap = Math.min(Math.max(Number(args.max_chars) || 2400, 1), 16000); let remaining = cap;
      return { id: r.id, queue: items.slice(0, count).map(({ prompt, ...item }) => { const text = args.include_text ? redactText(prompt).slice(0, remaining) : undefined; remaining -= text?.length || 0; return { ...item, ...(text === undefined ? {} : { text }) }; }), total: items.length, truncated: items.length > count, message: "排队与提交回执不表示开工；命令完成与业务交付分别核验" };
    }
    if (args.action === "enqueue") {
      if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 50000 || /[\u0000-\u0008\u001b]/.test(args.prompt) || /^\s*\//.test(args.prompt) && !/^\/compact(?:\s|$)/.test(args.prompt)) throw new Error("排队仅支持普通正文或/compact，不能输入终端控制字符");
      const items = readJson(queueFile) || [];
      if (items.filter((i) => i.state === "queued").length >= 30) throw new Error("本会话等待队列已达30项");
      const item = { requestId: args.request_id, prompt: args.prompt, state: "queued", createdAt: new Date().toISOString(), processDocs: args.process_docs !== false, deliveryLevel: args.delivery_level || "batch" };
      writeJson(queueFile, [...items, item]);
      return { id: r.id, requestId: item.requestId, submission: { state: "queued", submitted: false, started: false }, position: items.filter((i) => i.state === "queued").length + 1 };
    }
    if (args.action === "task_result") {
      const turn = r.lastInstruction ? observe(r.sessionId, r.cwd, r.lastInstruction, r.observation || {}) : r.observation || {};
      return readTaskResult(r.sessionId, r.cwd, args.task_id, { ...turn.background, ...turn.finishedBackground }, args.max_chars);
    }
    if (args.action === "dispatch_queue") {
      const items = readJson(queueFile) || [];
      const uncertain = items.find((i) => ["sending", "uncertain"].includes(i.state));
      if (uncertain) {
        const proof = r.lastInstruction?.requestId === uncertain.requestId && observe(r.sessionId, r.cwd, r.lastInstruction, r.observation || {});
        if (!proof?.logged || !proof.userUuid || proof.changed || proof.gap || proof.ambiguous) return { id: r.id, needsAttention: true, requestId: uncertain.requestId, message: "排队输入回执不明，只核对confirm_submission，不重发" };
        uncertain.state = proof.completed ? "completed" : "submitted"; uncertain.reconciledUserUuid = proof.userUuid; uncertain.transportReceiptLost = true;
        writeJson(queueFile, items);
      }
      const item = items.find((i) => i.state === "queued");
      if (!item) return { id: r.id, unchanged: true, queueEmpty: true };
      if (item.retryAfter > Date.now()) return { id: r.id, submission: { state: "queued" }, retryAfter: item.retryAfter, modelCalls: 0 };
      const current = r.lastInstruction && observe(r.sessionId, r.cwd, r.lastInstruction, r.observation || {});
      if (current?.completed) for (const previous of items) if (previous.requestId === r.lastInstruction.requestId && previous.state === "submitted") { previous.state = "completed"; previous.completedAt = new Date().toISOString(); previous.commandCompleted = r.lastInstruction.kind === "compact"; previous.businessDelivered = r.lastInstruction.kind !== "compact"; }
      if (r.owner === "human" || current?.backgroundOutstanding || current && !current.completed || current?.nextUserObserved || r.cancelRequested) return { id: r.id, submission: { state: "queued" }, waitingFor: "当前主轮、实际后台任务或人类指令", modelCalls: 0 };
      if (pendingWakeEvents(wakeDir(path.dirname(root), master)).some((e) => e.taskId === r.id && e.requestId === r.lastInstruction?.requestId && ["instruction_completed", "stage_delivered"].includes(e.type))) return { id: r.id, submission: { state: "queued" }, waitingFor: "上一批交付尚未由主控接住", modelCalls: 0 };
      // 先记录发送意图；进程中断后不能自动重放。
      item.state = "sending"; writeJson(queueFile, items);
      try {
        const result = await operation({ action: item.prompt.startsWith("/compact") ? "command" : "send", id: r.id, controller_id: master,
          request_id: item.requestId, prompt: item.prompt, process_docs: item.processDocs, delivery_level: item.deliveryLevel }, master, transaction);
        item.state = "submitted"; item.submittedAt = new Date().toISOString(); item.orcaRequestId = result.receipt?.prompt?.requestId || null;
        writeJson(queueFile, items); return { ...result, queuedRequestId: item.requestId };
      } catch (error) { item.state = transaction.inputMayHaveBeenSent ? "uncertain" : "queued"; item.retryAfter = transaction.inputMayHaveBeenSent ? null : Date.now() + 5000; writeJson(queueFile, items); throw error; }
    }
    if (args.action === "release") { r.controlRevision = (r.controlRevision || 0) + 1; r.state = "released"; writeJson(recordPath(r.id), r); return { ...summary(r), terminalKeptAlive: true }; }
    if (args.action === "rebind") return rebind(r, args);
    let t;
    try { t = await bound(r); }
    catch (error) {
      if (["status", "wait"].includes(args.action) && ["terminal_handle_stale", "BINDING_STALE"].includes(error.code)) return statusResponse({ ...summary(r), binding: { state: "stale", code: error.code, claudeSessionEnded: null, processState: "unverified" }, terminal: { connected: false }, nextAction: "list后按精确Claude UUID与原目录调用rebind；终端失效不能推断Claude进程退出，不重开或重复派发" });
      throw error;
    }
    if (args.action === "human_activity") {
      const activity = observeHumanActivity(r.sessionId, r.cwd, r.humanActivity || { cursor: r.observation?.humanBoundary || r.managementCursor || r.observation?.cursor || {} });
      const fresh = readJson(recordPath(r.id));
      if (fresh?.controlRevision !== r.controlRevision || fresh?.lastInstruction?.requestId !== r.lastInstruction?.requestId || fresh?.state !== r.state) return { ...summary(fresh), changedDuringObservation: true };
      r.humanActivity = activity; writeJson(recordPath(r.id), r);
      return { ...summary(r), management: "retained", humanActivity: activity, message: "人类临时操作期间保留观察；读取新增消息理解意图，不自动释放" };
    }
    if (args.action === "confirm_submission") return updateTurn(r, { ...args, include_text: false });
    if (args.action === "submit_draft") {
      if (args.draft_confirmed !== true || args.idle_confirmed !== true) throw new Error("提交草稿须明确授权该内容，并确认人类队列已清空");
      const before = await screen(t, r.cwd), draft = before.draft;
      if (typeof draft !== "string" || !draft || crypto.createHash("sha256").update(draft).digest("hex") !== args.draft_hash) throw new Error("草稿不存在或指纹变化，不输入、不提交");
      const fullText = args.prompt;
      if (typeof fullText !== "string" || !fullText) return statusResponse({ ...summary(r), needsAttention: true, submission: { state: "draft_exists", source: "orca_ui_composer", originalTextVerified: false }, nextAction: "请提供已确认的完整prompt；UI composer未提交，未清空或发送" });
      const taskText = fullText || draft;
      if (r.draftSubmission?.hash === args.draft_hash && r.draftSubmission?.textHash === crypto.createHash("sha256").update(taskText).digest("hex") && r.lastInstruction?.requestId === r.draftSubmission.requestId) return { ...updateTurn(r), duplicateDraft: true, message: "此草稿原文已关联提交，返回真实日志状态，不再次投递" };
      if (fullText && fullText.replace(/\r?\n/g, "") !== draft.replace(/\r?\n/g, "")) throw new Error("完整正文与草稿显示不匹配，保留并停止提交");
      if (taskText.length > 50000 || /^\s*\//.test(taskText) || /[\u0000-\u0008\u001b]/.test(taskText)) throw new Error("仅支持普通任务草稿；内容不兼容时保留原文");
      const idle = await call(["terminal", "wait", "--terminal", r.terminalId, "--for", "tui-idle", "--timeout-ms", "1000"], r.cwd);
      if (!idle.result.wait.satisfied || r.observation?.backgroundOutstanding) throw new Error("执行或后台任务尚未结束，保留草稿");
      const currentDraft = (await screen(t, r.cwd)).draft;
      if (typeof currentDraft !== "string" || crypto.createHash("sha256").update(currentDraft).digest("hex") !== args.draft_hash) throw new Error("确认期间草稿变化，保留并停止提交");
      const prior = r.lastInstruction && observe(r.sessionId, r.cwd, r.lastInstruction, r.observation || {});
      if (r.lastInstruction && !["completed", "cancelled", "interrupted_by_human"].includes(r.lastInstruction.state) && !prior?.completed) throw new Error("上一条提交状态尚未核验，先confirm_submission，不重发");
      if (prior?.nextUserObserved) {
        const human = observeHumanActivity(r.sessionId, r.cwd, { cursor: prior.humanBoundary });
        if (!human.completed || Object.keys(human.background || {}).length) throw new Error("后续人类任务尚未完成，保留草稿，不清理或中断");
      }
      const backup = path.join(root, "草稿备份", `${crypto.randomUUID()}.txt`); fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.writeFileSync(backup, taskText, "utf8");
      r.draftSubmission = { hash: args.draft_hash, requestId: args.request_id, state: "draft_exists", source: before.source || "unknown", originalTextProvided: Boolean(fullText), textHash: crypto.createHash("sha256").update(taskText).digest("hex"), backup, at: new Date().toISOString() }; writeJson(recordPath(r.id), r);
      // UI composer不属于PTY输入；不发Enter/清行/中断去操作它，按已授权全文形成真实prompt。
      if (!emptyPrompt(before.tail) && !statusIdentity(before.tail)) throw new Error("终端输入区不为空，保留UI composer与正文备份，不覆盖终端文字");
      const checked = await identity(t, r.cwd);
      if (checked.sessionId !== r.sessionId) throw new Error(`会话身份变化，停止提交；原文备份 ${backup}`);
      r.owner = "codex"; r.terminalBlocker = null; r.humanActivity = null;
      if (r.observation) { r.observation.nextUserObserved = false; r.observation.ambiguous = false; r.observation.cursor = { offset: fs.statSync(transcriptFile(r.sessionId)).size }; }
      if (r.lastInstruction) r.lastInstruction.terminalState = "human_handoff";
      r.draftSubmission.state = "prepared_full_text"; writeJson(recordPath(r.id), r);
      const submitted = await operation({ ...args, action: "send", prompt: taskText }, master, transaction);
      return { ...submitted, uiComposerRetained: true };
    }
    if (args.action === "diagnose") return { ...summary(r), diagnosis: diagnoseCursor(r.sessionId, r.cwd, r.observation), nextAction: "人类操作保留管理，读取新增意图并等当前轮、队列和草稿结束后接续" };
    if (args.action === "repair_cursor") {
      if (args.idle_confirmed !== true) throw new Error("修复游标前须确认人类当前轮与队列已结束");
      const diagnosis = diagnoseCursor(r.sessionId, r.cwd, r.observation);
      if (!diagnosis.repairable) throw new Error("停留边界不是可识别通知，不能跳过人类输入或损坏记录");
      r.controlRevision = (r.controlRevision || 0) + 1;
      r.observation = { ...r.observation, nextUserObserved: false, ambiguous: false, humanInputEvidence: null, completed: false };
      // 重新从通知边界分类，丢弃旧识别器把系统通知累计成人类输入的缓存。
      r.humanActivity = null;
      writeJson(recordPath(r.id), r);
      return { ...updateTurn(r), cursorRepaired: true, ownerKept: true };
    }
    if (args.action === "close") {
      if (!r.createdByPlugin && args.close_attached_confirmed !== true) throw new Error("关闭已有用户终端须明确确认；只交还控制权请用 release");
      await call(["terminal", "close", "--terminal", r.terminalId], r.cwd);
      r.state = "closed"; writeJson(recordPath(r.id), r); return summary(r);
    }
    if (args.action === "status") return { ...updateTurn(r, args), terminal: { connected: t.connected, writable: t.writable, agentWait: t.agentWait } };
    if (args.action === "takeover") {
      if (args.idle_confirmed !== true) throw new Error("先确认人类当前轮与队列结束，再交回控制权");
      if (r.cancelRequested && args.stop_confirmed !== true) throw new Error("取消尚未确认覆盖后台工具与子代理；需有停止证据或用户明确确认");
      const checked = await identity(t, r.cwd); if (checked.sessionId !== r.sessionId) throw new Error("会话身份已变化");
      if (r.observation?.nextUserObserved || r.humanActivity?.userCount) {
        const activity = observeHumanActivity(r.sessionId, r.cwd, r.humanActivity || { cursor: r.observation?.humanBoundary || r.observation?.cursor || {} });
        if (!activity.completed || activity.changed || activity.gap) throw new Error("人类当前轮或队列尚未有完整结束证据，保留管理并继续观察");
        r.humanHandledCursor = activity.cursor; r.managementCursor = activity.cursor; r.humanActivity = null;
        r.observation = { ...r.observation, cursor: activity.cursor, humanBoundary: null, nextUserObserved: false, ambiguous: false, humanInputEvidence: null, completed: false, background: {}, backgroundOutstanding: false };
        if (r.lastInstruction) { r.lastInstruction.state = "interrupted_by_human"; r.lastInstruction.terminalState = "human_handoff"; }
      }
      r.owner = "codex";
      r.controlRevision = (r.controlRevision || 0) + 1;
      if (r.cancelRequested && r.lastInstruction) { r.lastInstruction.state = "cancelled"; r.lastInstruction.terminalState = "cancelled"; }
      r.cancelRequested = false;
      const file = transcriptFile(r.sessionId); if (args.stop_confirmed === true && r.observation && file) r.observation.cursor = { offset: fs.statSync(file).size };
      if (r.observation) r.observation.nextUserObserved = false;
      if (args.stop_confirmed === true && r.observation) { r.observation.background = {}; r.observation.backgroundOutstanding = false; }
      writeJson(recordPath(r.id), r); return summary(r);
    }
    if (args.action === "cancel") {
      await call(["terminal", "send", "--terminal", r.terminalId, "--interrupt"], r.cwd);
      r.controlRevision = (r.controlRevision || 0) + 1; r.cancelRequested = true; r.owner = "human"; writeJson(recordPath(r.id), r);
      return { ...summary(r), cancellation: "requested_unconfirmed", message: "已请求中断；尚未证明后台工具、子代理和人类队列全部停止，自动派发已暂停" };
    }
    if (args.action === "transcript") return readHistory({ ...args, cursor: args.cursor || { offset: r.lastInstruction?.baseline || 0 }, roles: ["assistant"], session_id: r.sessionId, cwd: r.cwd });
    if (args.action === "read") {
      const options = ["terminal", "read", "--terminal", r.terminalId, "--limit", String(Math.min(Math.max(Number(args.limit) || 60, 1), 300))];
      if (args.cursor != null) options.push("--cursor", String(args.cursor));
      const result = await call(options, r.cwd), screenValue = result.result.terminal;
      const screenRevision = crypto.createHash("sha256").update(JSON.stringify([screenValue.tail, screenValue.draft])).digest("hex");
      return { ...updateTurn(r, args), screen: args.screen_revision === screenRevision ? { unchanged: true, revision: screenRevision } : { ...screenValue, revision: screenRevision, cursorType: "orca_screen", warning: "屏幕游标不等同于 Claude 正文游标" } };
    }
    if (args.action === "wait") {
      if (args.after_revision != null) {
        const until = Date.now() + Math.min(Math.max(Number(args.timeout_ms) || 10000, 1), 60000);
        let lastCheck = 0, changed = false, wake; const file = transcriptFile(r.sessionId);
        const watcher = file && fs.watch(file, () => { changed = true; wake?.(); });
        try {
          do {
            const fresh = readJson(recordPath(r.id)); if (fresh) Object.assign(r, fresh);
            if (Date.now() - lastCheck >= 5000) {
              try { await bound(r); } catch (error) { return statusResponse({ ...summary(r), binding: { state: "stale", code: error.code || "PROBE_FAILED", claudeSessionEnded: null, processState: "unverified" } }); }
              lastCheck = Date.now();
            }
            const next = updateTurn(r, args); if (!next.unchanged) return next;
            if (changed) { changed = false; continue; }
            await new Promise((resolve) => { const timer = setTimeout(resolve, Math.min(1000, Math.max(1, until - Date.now()))); wake = () => { clearTimeout(timer); resolve(); }; }); wake = null;
          } while (Date.now() < until);
        } finally { watcher?.close(); wake = null; }
        return statusResponse({ ...summary(r), unchanged: true, timedOut: true });
      }
      try {
        const wait = await call(["terminal", "wait", "--terminal", r.terminalId, "--for", "tui-idle", "--timeout-ms", String(Math.min(Math.max(Number(args.timeout_ms) || 10000, 1), 60000))], r.cwd);
        return { ...updateTurn(r, args), wait: { ...wait.result.wait, timedOut: !wait.result.wait.satisfied } };
      } catch (error) {
        if (error.code !== "timeout") throw error;
        return statusResponse({ ...updateTurn(r, args), timedOut: true, wait: { satisfied: false, timedOut: true }, nextAction: "等待到期未证明结束；使用after_revision续读，不重新发送" });
      }
    }
    const isCommand = args.action === "command";
    if (args.action !== "send" && !isCommand) throw new Error("未知 Orca 会话操作");
    if (r.owner === "human" || r.cancelRequested) throw new Error("会话由人类控制或取消尚未确认，先明确交回控制权");
    if (r.observation?.backgroundOutstanding) throw new Error("主轮结束但后台任务范围尚未确认，不继续派发");
    if (!args.prompt || typeof args.prompt !== "string" || args.prompt.length > 50000 || (isCommand ? !/^\/compact(?:\s|$)/.test(args.prompt) : /^[\s]*\//.test(args.prompt)) || /[\u0000-\u0008\u001b]/.test(args.prompt)) throw new Error("send须为普通正文；command仅支持/compact；不接受终端控制字符");
    if (r.lastInstruction && !["completed", "cancelled", "interrupted_by_human"].includes(updateTurn(r).lastInstruction.state)) throw new Error("上一条指令尚未确认完成，先读取并核对，不能重复派发");
    if (r.owner === "human" || r.observation?.nextUserObserved) throw new Error("发现新增人类输入，保留管理；先理解新增意图并确认空闲后接续");
    const checked = await identity(t, r.cwd);
    if (checked.sessionId !== r.sessionId) throw new Error("Claude 实际会话 ID 已变化，停止发送，须按新 ID 重新接入");
    const file = transcriptFile(r.sessionId);
    const marker = `<bridge-instruction:${crypto.createHash("sha256").update(`${master}:${args.request_id}`).digest("hex").slice(0,24)}>`;
    r.controlRevision = (r.controlRevision || 0) + 1;
    if (args.delivery_level && !["subtask", "milestone", "batch", "review", "final"].includes(args.delivery_level)) throw new Error("交付级别无效");
    r.lastInstruction = { requestId: args.request_id, marker, prompt: args.prompt, state: "pending", preparedAt: new Date().toISOString(), deliveryLevel: args.delivery_level || "batch", baseline: file ? fs.statSync(file).size : 0 };
    r.observation = null;
    r.humanActivity = null; r.managementCursor = { offset: r.lastInstruction.baseline };
    const docs = args.process_docs === false || isCommand ? null : prepareRecordDocuments(r, args.prompt);
    const sentPrompt = args.prompt + `\n\n${marker}` + (docs ? deliveryInstruction(r, docs) : "");
    r.lastInstruction.kind = isCommand ? "compact" : "task";
    const registrationFile = path.join(path.dirname(root), "automation", `${r.sessionId}.json`);
    const registrations = readJson(registrationFile) || [];
    const registration = { sessionId: r.sessionId, cwd: r.cwd, incarnationId: r.incarnationId, runtimeId: r.runtimeId, controllerId: master,
      requestId: args.request_id, marker, kind: isCommand ? "compact" : "task", text: sentPrompt, preparedAt: r.lastInstruction.preparedAt, state: "submitting" };
    writeJson(registrationFile, [...registrations.slice(-99), registration]);
    r.lastInstruction.sentPromptHash = crypto.createHash("sha256").update(sentPrompt).digest("hex");
    writeJson(recordPath(r.id), r);
    // 写入不明时禁止自动重发；请求日志保留 pending，后续只读取实际状态。
    transaction.inputMayHaveBeenSent = true;
    const response = await call(["terminal", "send", "--terminal", r.terminalId, "--text", sentPrompt, "--enter", "--wait-submit", "10"], r.cwd);
    const receipt = response.result.send;
    r.lastInstruction.state = receipt.prompt?.stages?.includes("turn_started") ? "started" : receipt.accepted ? "accepted" : "rejected";
    r.lastInstruction.orcaRequestId = receipt.prompt?.requestId || response.result.mutation?.requestId;
    registration.state = receipt.accepted ? "accepted" : "rejected"; registration.orcaRequestId = r.lastInstruction.orcaRequestId;
    if (file && receipt.accepted) scanSession(file, { offset: r.lastInstruction.baseline }, { visit(entry) {
      if (entry.type === "user" && entry.sessionId === r.sessionId && entry.cwd && normalized(entry.cwd) === normalized(r.cwd) && entry.userType === "external" && entry.entrypoint === "cli" && entryText(entry).trim() === sentPrompt.trim()) {
        registration.messageUuid = entry.uuid || null; registration.messageAt = entry.timestamp || null; return { stop: true };
      }
    } });
    writeJson(registrationFile, [...registrations.slice(-99), registration]);
    writeJson(recordPath(r.id), r);
    return { ...updateTurn(r, args), receipt, processDocuments: docs, message: "accepted 仅表示输入接收；logged/completed 由精确会话记录核对。回执不明时不重发。" };
  }

  return async (args = {}) => {
    const master = args.controller_id || controllerId();
    if (!master) throw new Error("请提供 Codex 主控任务 ID");
    const mutate = ["create", "attach", "send", "command", "enqueue", "cancel_queued", "dispatch_queue", "release", "close", "takeover", "cancel", "repair_cursor", "rebind", "submit_draft"].includes(args.action);
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
      const signature = JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]])); let prior = readJson(file);
      if (prior?.signature === signature && prior.state === "rejected_before_submission") {
        writeJson(path.join(requests, "拒绝记录", `${key}-${crypto.randomUUID()}.json`), prior); prior = null;
      }
      if (prior) {
        if (prior.signature !== signature) throw new Error("request_id 已用于不同的 Orca 操作");
        if (prior.result?.id && ["create", "attach", "rebind"].includes(args.action)) {
          const current = readJson(recordPath(prior.result.id));
          if (current?.controllerId === master) return { ...prior.result, ...summary(current), duplicate: true, currentBinding: true };
        }
        return prior.result ? { ...prior.result, duplicate: true } : { uncertain: true, message: "原请求回执不明，先列出终端并核对接入记录；不会重发", requestId: args.request_id };
      }
      writeJson(file, { signature, state: "pending" });
      const transaction = {};
      try {
        const result = await operation(args, master, transaction); writeJson(file, { signature, state: "done", result }); return result;
      } catch (error) {
        const beforeInput = ["send", "command", "dispatch_queue", "submit_draft"].includes(args.action) && (!transaction.inputMayHaveBeenSent || error.details?.inputRejected === true);
        writeJson(file, { signature, state: beforeInput ? "rejected_before_submission" : "uncertain", inputMayHaveBeenSent: !beforeInput, message: error.message }); throw error;
      }
    } finally { fs.unlinkSync(path.join(lock, "持有者.json")); fs.rmdirSync(lock); }
  };
}

export const orcaSessions = createOrcaAdapter();
