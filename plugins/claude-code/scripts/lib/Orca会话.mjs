import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MANAGED_ROOT, controllerId, readJson, writeJson, resolveModel, listTasks, readRuntime } from "./managed-state.mjs";
import { observeInstruction, readHistory, diagnoseCursor, observeHumanActivity } from "./会话读取.mjs";
import { effectiveProfile, validateProfile, prepareRecordDocuments, deliveryInstruction } from "./协作策略.mjs";
import { orcaLaunch, executable as resolveExecutable } from "./平台适配.mjs";

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
  error.code = code; error.details = { code, operation, cliExitCode: typeof failure?.code === "number" ? failure.code : null,
    retryable: !["send", "create", "close"].includes(args[1]), uncertain: ["send", "create", "close"].includes(args[1]) };
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
  return Boolean(prompts.length && /^\s*[❯>]\s*(?:Try\s+".*")?\s*$/.test(prompts.at(-1)));
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
  const screen = (await call(["terminal", "read", "--terminal", r.terminalId, "--limit", "24"], r.cwd)).result.terminal;
  const lines = screen.tail || [];
  const busy = lines.some((line) => /^\s*[✢✳✻✶✽].*…|(?:Generating|Thinking|Working).*…|esc to interrupt/i.test(line));
  const needsInput = lines.some((line) => /Do you want to|Permission rule .*requires confirmation/i.test(line)) && lines.some((line) => /^\s*[❯>]\s*1\.\s*(?:Yes|Allow)/i.test(line));
  const draft = typeof screen.draft === "string" ? screen.draft : "";
  const fingerprint = draft ? crypto.createHash("sha256").update(draft).digest("hex") : null;
  const matchesBridge = Boolean(fingerprint && r.lastInstruction?.sentPromptHash === fingerprint);
  return { busy, needsInput, draft: Boolean(screen.draft), draftEvidence: { present: Boolean(screen.draft), length: draft.length, fingerprint,
    source: "unknown", matchesBridgeRequest: matchesBridge }, revision: crypto.createHash("sha256").update(JSON.stringify([busy, needsInput, fingerprint])).digest("hex") };
}

export function createOrcaAdapter({ call = orcaCall, root = path.join(MANAGED_ROOT, "orca"), observe = readTurn } = {}) {
  const folder = path.join(root, "会话"), requests = path.join(root, "请求");
  const recordPath = (id) => { if (!UUID.test(String(id))) throw new Error("须使用精确 Orca 接入记录 ID"); return path.join(folder, `${id}.json`); };
  const records = () => { try { return fs.readdirSync(folder).filter((f) => f.endsWith(".json")).map((f) => readJson(path.join(folder, f))).filter(Boolean); } catch { return []; } };
  const summary = (r) => ({ id: r.id, controllerId: r.controllerId, sessionId: r.sessionId, cwd: r.cwd,
    terminalId: r.terminalId, incarnationId: r.incarnationId, runtimeId: r.runtimeId, createdByPlugin: r.createdByPlugin,
    state: r.state, owner: r.owner || "codex", management: r.state === "attached" ? "retained" : "released", terminalBlocker: r.terminalBlocker || null, humanActivity: r.humanActivity || null, model: r.model, profile: effectiveProfile(r), revision: r.revision || null, lastInstruction: r.lastInstruction ? { requestId: r.lastInstruction.requestId,
      state: r.lastInstruction.state, orcaRequestId: r.lastInstruction.orcaRequestId } : null });

  async function bound(r) {
    const response = await call(["terminal", "show", "--terminal", r.terminalId], r.cwd), t = response.result.terminal;
    if (response._meta?.runtimeId !== r.runtimeId || t.incarnationId !== r.incarnationId || normalized(t.worktreePath) !== normalized(r.cwd) || !t.connected || !t.writable || t.agentIdentity !== "claude") {
      throw Object.assign(new Error("Orca 运行时、终端实例或目录已变化，须重新列出并按原会话 ID 接入；不会自动重开或双发"), { code: "BINDING_STALE" });
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
    if (before.draft) throw new Error("存在未发送草稿，来源尚未确认；保留内容，不能注入/status、Esc或任务");
    if (before.tail.some((line) => /^\s*[✢✳✻✶✽].*…|(?:Generating|Thinking|Working).*…|esc to interrupt/i.test(line))) throw new Error("屏幕仍有执行信号，不能把空输入框当成工作已停止");
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

  function updateTurn(r, args = {}) {
    if (!r.lastInstruction) return { ...summary(r), turn: null };
    const turn = observe(r.sessionId, r.cwd, r.lastInstruction, r.observation || {});
    if (turn.logged && !["cancelled", "human_handoff"].includes(r.lastInstruction.terminalState)) r.lastInstruction.state = turn.completed ? "completed" : "logged";
    if (turn.failed && !["cancelled", "human_handoff"].includes(r.lastInstruction.terminalState)) r.lastInstruction.state = "failed";
    if (turn.nextUserObserved) r.owner = "human";
    r.observation = turn;
    r.revision = crypto.createHash("sha256").update(JSON.stringify([r.lastInstruction.state, turn.text, turn.ambiguous, turn.changed, turn.available, r.owner, r.cancelRequested, turn.backgroundOutstanding])).digest("hex");
    const fresh = readJson(recordPath(r.id));
    if (fresh && (fresh.lastInstruction?.requestId !== r.lastInstruction.requestId || fresh.controlRevision !== r.controlRevision || fresh.state !== r.state)) return { ...summary(fresh), changedDuringObservation: true, turn: null };
    writeJson(recordPath(r.id), r);
    const { text, ...short } = turn;
    const unchanged = args.after_revision === r.revision;
    return { ...summary(r), unchanged, turn: unchanged ? null : { ...short, ...(args.include_text ? { text } : {}) } };
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

  async function operation(args, master) {
    if (args.action === "history") return readHistory(args);
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
    const r = readJson(recordPath(args.id));
    if (!r || r.controllerId !== master) throw new Error("该 Orca 接入记录不属于当前 Codex 主控");
    if (r.state !== "attached") throw new Error("接入已释放或关闭，须重新接入");
    if (args.action === "release") { r.controlRevision = (r.controlRevision || 0) + 1; r.state = "released"; writeJson(recordPath(r.id), r); return { ...summary(r), terminalKeptAlive: true }; }
    if (args.action === "rebind") return rebind(r, args);
    let t;
    try { t = await bound(r); }
    catch (error) {
      if (args.action === "status" && ["terminal_handle_stale", "BINDING_STALE"].includes(error.code)) return { ...summary(r), binding: { state: "stale", code: error.code }, terminal: { connected: false }, nextAction: "list后按精确Claude UUID与原目录调用rebind，保留原记录；不要继续等交付" };
      throw error;
    }
    if (args.action === "human_activity") {
      const activity = observeHumanActivity(r.sessionId, r.cwd, r.humanActivity || { cursor: r.observation?.humanBoundary || r.managementCursor || r.observation?.cursor || {} });
      const fresh = readJson(recordPath(r.id));
      if (fresh?.controlRevision !== r.controlRevision || fresh?.lastInstruction?.requestId !== r.lastInstruction?.requestId || fresh?.state !== r.state) return { ...summary(fresh), changedDuringObservation: true };
      r.humanActivity = activity; writeJson(recordPath(r.id), r);
      return { ...summary(r), management: "retained", humanActivity: activity, message: "人类临时操作期间保留观察；读取新增消息理解意图，不自动释放" };
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
    if (args.action === "transcript") return readHistory({ ...args, session_id: r.sessionId, cwd: r.cwd });
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
        do { const next = updateTurn(r, args); if (!next.unchanged) return next; await pause(Math.min(500, Math.max(1, until - Date.now()))); } while (Date.now() < until);
        return { ...summary(r), unchanged: true, timedOut: true };
      }
      const wait = await call(["terminal", "wait", "--terminal", r.terminalId, "--for", "tui-idle", "--timeout-ms", String(Math.min(Math.max(Number(args.timeout_ms) || 10000, 1), 60000))], r.cwd);
      return { ...updateTurn(r, args), wait: { ...wait.result.wait, timedOut: !wait.result.wait.satisfied } };
    }
    if (args.action !== "send") throw new Error("未知 Orca 会话操作");
    if (r.owner === "human" || r.cancelRequested) throw new Error("会话由人类控制或取消尚未确认，先明确交回控制权");
    if (r.observation?.backgroundOutstanding) throw new Error("主轮结束但后台任务范围尚未确认，不继续派发");
    if (!args.prompt || typeof args.prompt !== "string" || args.prompt.length > 50000 || /^[\s]*\//.test(args.prompt) || /[\u0000-\u0008\u001b]/.test(args.prompt)) throw new Error("须提供普通任务正文；不接受斜杠命令或终端控制字符");
    if (r.lastInstruction && !["completed", "cancelled", "interrupted_by_human"].includes(updateTurn(r).lastInstruction.state)) throw new Error("上一条指令尚未确认完成，先读取并核对，不能重复派发");
    if (r.owner === "human" || r.observation?.nextUserObserved) throw new Error("发现新增人类输入，保留管理；先理解新增意图并确认空闲后接续");
    const checked = await identity(t, r.cwd);
    if (checked.sessionId !== r.sessionId) throw new Error("Claude 实际会话 ID 已变化，停止发送，须按新 ID 重新接入");
    const file = transcriptFile(r.sessionId);
    const marker = `<bridge-instruction:${crypto.createHash("sha256").update(`${master}:${args.request_id}`).digest("hex").slice(0,24)}>`;
    r.controlRevision = (r.controlRevision || 0) + 1;
    r.lastInstruction = { requestId: args.request_id, marker, prompt: args.prompt, state: "pending", baseline: file ? fs.statSync(file).size : 0 };
    r.observation = null;
    r.humanActivity = null; r.managementCursor = { offset: r.lastInstruction.baseline };
    const docs = args.process_docs === false ? null : prepareRecordDocuments(r, args.prompt);
    const sentPrompt = args.prompt + `\n\n${marker}` + (docs ? deliveryInstruction(r, docs) : "");
    r.lastInstruction.sentPromptHash = crypto.createHash("sha256").update(sentPrompt).digest("hex");
    writeJson(recordPath(r.id), r);
    // 写入不明时禁止自动重发；请求日志保留 pending，后续只读取实际状态。
    const response = await call(["terminal", "send", "--terminal", r.terminalId, "--text", sentPrompt, "--enter", "--wait-submit", "10"], r.cwd);
    const receipt = response.result.send;
    r.lastInstruction.state = receipt.prompt?.stages?.includes("turn_started") ? "started" : receipt.accepted ? "accepted" : "rejected";
    r.lastInstruction.orcaRequestId = receipt.prompt?.requestId || response.result.mutation?.requestId;
    writeJson(recordPath(r.id), r);
    return { ...updateTurn(r, args), receipt, processDocuments: docs, message: "accepted 仅表示输入接收；logged/completed 由精确会话记录核对。回执不明时不重发。" };
  }

  return async (args = {}) => {
    const master = args.controller_id || controllerId();
    if (!master) throw new Error("请提供 Codex 主控任务 ID");
    const mutate = ["create", "attach", "send", "release", "close", "takeover", "cancel", "repair_cursor", "rebind"].includes(args.action);
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
