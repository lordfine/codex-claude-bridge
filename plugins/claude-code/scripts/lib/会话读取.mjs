import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE = 8 * 1024 * 1024;
export function normalizedDirectory(value) {
  let result; try { result = fs.realpathSync.native(value); } catch { result = path.resolve(value); }
  return process.platform === "win32" ? result.toLowerCase() : result;
}
export function redactText(text) {
  return String(text).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[私钥已隐藏]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [已隐藏]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [已隐藏]")
    .replace(/\b(?:sk-ant-|sk-proj-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[密钥已隐藏]")
    .replace(/\bsshpass\s+-p\s+["']?[^\s"']+/gi, "sshpass -p [已隐藏]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s\/@]+@/gi, "$1[身份已隐藏]@")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))(["']?\s*[:=]\s*["']?)([^\s"',;]+)/g, "$1$2[已隐藏]")
    .replace(/\b(password|passwd|api[_-]?key|auth[_-]?token|access[_-]?token|secret|ANTHROPIC_AUTH_TOKEN)(["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi, "$1$2[已隐藏]");
}
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalizedText = (text) => String(text || "").replace(/\r\n/g, "\n").trim();
const systemTaskOrigin = (entry) => entry.origin?.kind === "task-notification" && entry.promptSource === "system" && (entry.turnOrigin === "task_notification" || entry.origin?.producer === "session-task");
export function taskNotification(entry) {
  const note = entry.attachment || entry.data;
  if (note?.type === "task_notification") return note;
  if (!systemTaskOrigin(entry) && !entry.isMeta) return null;
  const text = normalizedText(entryText(entry));
  if (!/^<task-notification(?:\s[^<>]*)?>[\s\S]*<\/task-notification>$/.test(text)) return null;
  // 只读通知头，不把 result 中的正文当元数据或新指令。
  const header = text;
  const values = {}, stack = [], starts = {};
  for (const match of header.matchAll(/<(\/?)([a-z][a-z0-9-]*)(?:\s[^<>]*)?>/gi)) {
    const [, closing, name] = match;
    if (!closing && stack.length === 1 && name === "result") break;
    if (!closing) { if (stack.length === 1 && ["task-id", "tool-use-id", "status"].includes(name)) starts[name] = match.index + match[0].length; stack.push(name); }
    else if (stack.at(-1) === name) {
      if (stack.length === 2 && starts[name] !== undefined) { const value = header.slice(starts[name], match.index).trim(); if (value.length <= 160 && !/[<>\r\n]/.test(value)) values[name] ||= value; }
      stack.pop();
    }
  }
  return { type: "task_notification", taskId: values["task-id"], toolUseId: values["tool-use-id"], status: values.status };
}
export function entryText(entry, tools = false) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).flatMap((part) => {
    if (part.type === "text") return [part.text || ""];
    if (tools && part.type === "tool_result") return [typeof part.content === "string" ? part.content : JSON.stringify(part.content || [])];
    return [];
  }).join("\n");
}

export function messageOrigin(entry) {
  const content = entry.message?.content;
  if (Array.isArray(content) && content.some((p) => p.type === "tool_result")) return "tool_result";
  if (taskNotification(entry)) return "task_notification";
  if (systemTaskOrigin(entry)) return "task_notification";
  const text = normalizedText(entryText(entry));
  if (entry.type === "user" && entry.userType === "external" && entry.entrypoint === "cli" && entry.isCompactSummary === true && entry.isVisibleInTranscriptOnly === true) return "system_summary";
  if (entry.type === "user" && entry.userType === "external" && entry.entrypoint === "cli" && registeredAutomation(entry, text)) return "automation_input";
  if (entry.type === "user" && entry.userType === "external" && entry.entrypoint === "cli" && /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(text)) return "local_command_result";
  // 兼容 Claude 的完整系统投递包装；普通聊天中引用标签不按通知处理。
  if (entry.userType === "external" && entry.entrypoint === "cli" && /^Another Claude session sent a message:\s*<teammate-message\s+teammate_id="[^"<>\r\n]+"(?:\s+[^<>]*)?>[\s\S]*?<\/teammate-message>(?:\s[\s\S]*)?$/.test(text)) return "agent_notification";
  if (entry.isMeta && /^<(?:teammate-message|task-notification)\b[\s\S]*<\/(?:teammate-message|task-notification)>\s*$/.test(text)) return "agent_notification";
  return entry.type === "user" ? "human_input" : entry.type;
}

function automationFile(sessionId) {
  return path.join(process.env.CC_PLUGIN_CODEX_MANAGED_DIR || path.join(os.homedir(), ".cache", "cc-plugin-codex", "managed"), "automation", `${sessionId}.json`);
}
function registeredAutomation(entry, text) {
  if (!UUID.test(entry.sessionId || "")) return false;
  let registrations; try { registrations = JSON.parse(fs.readFileSync(automationFile(entry.sessionId), "utf8")); } catch { return false; }
  const command = text.match(/^<command-name>\/compact<\/command-name>\s*<command-message>compact<\/command-message>\s*<command-args>([\s\S]*?)<\/command-args>$/)?.[1];
  return registrations.some((r) => ["submitting", "accepted"].includes(r.state) && r.sessionId === entry.sessionId && entry.cwd && normalizedDirectory(r.cwd) === normalizedDirectory(entry.cwd) &&
    r.incarnationId && r.marker && Date.parse(entry.timestamp) >= Date.parse(r.preparedAt) && Date.parse(entry.timestamp) <= Date.parse(r.preparedAt) + 86400000 &&
    (text === normalizedText(r.text) && (r.messageUuid ? entry.uuid === r.messageUuid : Date.parse(entry.timestamp) <= Date.parse(r.preparedAt) + 30000) ||
      r.kind === "compact" && normalizedText(command) === normalizedText(r.text.slice("/compact ".length)) && Math.abs(Date.parse(entry.timestamp) - Date.parse(r.messageAt || r.preparedAt)) <= (r.messageAt ? 2000 : 30000)));
}

// 仅接受明确映射的任务ID；空输出不等于运行中，优先读取原子代理JSONL的终态。
export function readTaskResult(sessionId, cwd, taskId, known = {}, maxChars = 2400) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId || "")) throw new Error("须提供原始任务ID");
  const job = Object.values(known).find((j) => [j.taskId, j.agentId, j.toolUseId].includes(taskId));
  if (!job) throw new Error("该任务未在精确会话中登记，不能猜测结果路径");
  const file = findSession(sessionId, cwd), dir = path.join(path.dirname(file), sessionId, "subagents");
  const agentId = job.agentId || job.taskId;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(agentId || "")) return { taskId, taskState: job.status || "unknown", resultState: "unavailable", replayAllowed: false };
  const log = path.join(dir, `agent-${agentId}.jsonl`); let final = null;
  if (fs.existsSync(log)) {
    let cursor = {}, pages = 0, scan;
    do {
      scan = scanSession(log, cursor, { visit(e) {
        if (e.type === "user" && entryText(e) && !e.message?.content?.some?.((p) => p.type === "tool_result")) final = null;
        if (e.type === "assistant" && e.message?.stop_reason === "end_turn" && entryText(e)) final = { uuid: e.uuid || null, text: redactText(entryText(e)) };
        if (e.type === "assistant" && e.message?.content?.some?.((p) => p.type === "tool_use")) final = null;
      } }); cursor = scan.cursor;
    } while (scan.hasMore && !scan.awaitingData && ++pages < 8);
    if (scan.hasMore || scan.changed || scan.gap || scan.awaitingData) final = null;
  }
  return { taskId, taskState: final ? "completed" : job.status || "unknown", resultState: final ? "available" : "unavailable",
    source: final ? "original_subagent_jsonl" : null, logPath: fs.existsSync(log) ? log : null, uuid: final?.uuid || null,
    text: final?.text.slice(0, Math.min(Math.max(Number(maxChars) || 2400, 1), 16000)) || "", replayAllowed: false,
    nextAction: final ? "读取原审查结果并验收，不重新派发" : "只核对任务终态与原日志；空输出不能证明运行中，不创建等待哨兵" };
}

function finishBackground(result, note) {
  if (!note || !["completed", "failed", "cancelled", "stopped"].includes(note.status)) return;
  const taskId = note.taskId || note.task_id;
  for (const [key, job] of Object.entries(result.background || {})) if (key === taskId || job.taskId === taskId || key === note.toolUseId) {
    result.finishedBackground ||= {};
    result.finishedBackground[key] = { ...job, status: note.status };
    delete result.background[key];
  }
}

// 游标始终位于完整 JSONL 行边界。超长行会被明确标记，不把读到的片段当终态。
export function scanSession(file, cursor = {}, { budget = 4 * 1024 * 1024, visit } = {}) {
  const stat = fs.statSync(file), generation = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  if (cursor.generation && (cursor.generation !== generation || cursor.offset > stat.size)) return { changed: true, cursor, hasMore: false };
  if (cursor.offset !== undefined && (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0)) throw new Error("正文游标须为非负整数字节位置");
  const start = Math.max(0, Number(cursor.offset) || 0), fd = fs.openSync(file, "r");
  let offset = start, readAt = start, tail = Buffer.alloc(0), gap = false, skipping = false, stopped = false;
  try {
    while (readAt < stat.size && (readAt - start < budget || tail.length || skipping)) {
      const buffer = Buffer.alloc(Math.min(65536, stat.size - readAt));
      const length = fs.readSync(fd, buffer, 0, buffer.length, readAt); if (!length) break;
      readAt += length; tail = Buffer.concat([tail, buffer.subarray(0, length)]);
      let newline;
      while ((newline = tail.indexOf(10)) >= 0) {
        const bytes = tail.subarray(0, newline), lineEnd = readAt - tail.length + newline + 1;
        tail = tail.subarray(newline + 1);
        if (skipping || bytes.length > MAX_LINE) { gap = true; skipping = false; offset = lineEnd; continue; }
        let entry; try { entry = JSON.parse(bytes.toString("utf8")); } catch { offset = lineEnd; continue; }
        const result = visit?.(entry, { start: offset, end: lineEnd, generation });
        if (result?.stopBefore) { stopped = true; break; }
        offset = lineEnd;
        if (result?.stop) { stopped = true; break; }
      }
      if (stopped) break;
      if (tail.length > MAX_LINE) { tail = Buffer.alloc(0); skipping = true; gap = true; }
      if (skipping && readAt - start > 64 * 1024 * 1024) break;
    }
  } finally { fs.closeSync(fd); }
  const awaitingData = !stopped && readAt === stat.size && tail.length > 0;
  return { cursor: { offset, generation }, hasMore: offset < stat.size && !awaitingData, awaitingData, changed: false, gap, bytesScanned: readAt - start };
}

export function findSession(sessionId, cwd, { allowMissingDirectory = false } = {}) {
  if (!UUID.test(String(sessionId))) throw new Error("须提供精确 Claude 会话 UUID");
  if (!cwd || !path.isAbsolute(cwd) || !allowMissingDirectory && !fs.existsSync(cwd)) throw new Error("须提供存在的原绝对目录");
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { throw new Error("没有本地 Claude 会话记录"); }
  const matches = dirs.filter((d) => d.isDirectory()).map((d) => path.join(root, d.name, `${sessionId.toLowerCase()}.jsonl`)).filter(fs.existsSync);
  if (matches.length !== 1) throw new Error("会话记录不存在或不唯一，请核对 UUID 与配置目录");
  let original;
  scanSession(matches[0], {}, { budget: 1024 * 1024, visit: (e) => { if (e.cwd && (!e.sessionId || e.sessionId.toLowerCase() === sessionId.toLowerCase())) { original = e.cwd; return { stop: true }; } } });
  if (!original || normalizedDirectory(original) !== normalizedDirectory(cwd)) throw new Error("会话记录的原目录与给定目录不一致");
  return matches[0];
}

export function observeInstruction(sessionId, cwd, instruction, saved = {}) {
  let file; try { file = findSession(sessionId, cwd); } catch { return { ...saved, logged: false, completed: false, available: false, changed: Boolean(saved.cursor), text: saved.text || "" }; }
  const result = { logged: false, completed: false, failed: false, ambiguous: false, gap: false, text: "", ...saved, available: true };
  result.notificationBoundaryRepaired = false;
  const cursor = result.cursor || { offset: instruction.baseline || 0 };
  const scan = scanSession(file, cursor, { visit: (e, position) => {
    const notification = taskNotification(e);
    if (e.sessionId?.toLowerCase() !== sessionId.toLowerCase() || e.isSidechain || e.isMeta && notification?.type !== "task_notification" || e.cwd && normalizedDirectory(e.cwd) !== normalizedDirectory(cwd)) return;
    if (result.logged && notification?.type === "task_notification" && ["completed", "failed", "cancelled", "stopped"].includes(notification.status)) {
      const taskId = notification.taskId || notification.task_id;
      finishBackground(result, notification);
    }
    if (e.type === "user") {
      const content = e.message?.content;
      const origin = messageOrigin(e);
      const ownCommand = instruction.kind === "compact" && normalizedText(entryText(e)).includes(instruction.marker);
      if (ownCommand && origin === "automation_input") { result.logged = true; result.started = normalizedText(entryText(e)).startsWith("<command-name>"); result.userUuid = e.uuid || null; result.commandState = result.started ? "started" : "received"; return; }
      if (instruction.kind === "compact" && origin === "local_command_result" && result.logged && e.parentUuid === result.userUuid) { result.completed = true; result.commandState = "completed"; result.text = redactText(entryText(e)).slice(-16000); return; }
      if (["task_notification", "agent_notification", "local_command_result", "automation_input", "system_summary"].includes(origin) && !(origin === "automation_input" && instruction.kind !== "compact" && normalizedText(entryText(e)).includes(instruction.marker))) {
        if (result.nextUserObserved && position.start === result.humanBoundary?.offset && (!result.humanInputEvidence?.uuid || result.humanInputEvidence.uuid === e.uuid)) {
          result.nextUserObserved = false; result.ambiguous = false; result.humanInputEvidence = null; result.humanBoundary = null; result.notificationBoundaryRepaired = true;
        }
        result.notificationCount = (result.notificationCount || 0) + 1; return;
      }
      if (origin !== "tool_result") {
        const text = normalizedText(entryText(e));
        if (!result.logged && (instruction.marker ? text.includes(instruction.marker) : text === normalizedText(instruction.prompt))) {
          result.logged = true; result.userUuid = e.uuid || null;
        } else if (result.logged && text) {
          if (!result.completed) result.ambiguous = true;
          result.nextUserObserved = true;
          result.humanInputEvidence = { uuid: e.uuid || null, origin, at: e.timestamp || null };
          result.humanBoundary = { offset: position.start, generation: position.generation };
          return { stopBefore: true };
        }
      }
    }
    if (result.logged && e.type === "assistant") {
      result.started = true; result.firstAssistantUuid ||= e.uuid || null;
      const text = entryText(e), hasTools = (e.message?.content || []).some?.((part) => part.type === "tool_use");
      if (hasTools) result.completed = false;
      for (const part of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (part.type === "tool_use" && part.input?.run_in_background === true && part.id) {
          result.background ||= {}; result.background[part.id] = { toolUseId: part.id, taskId: part.id };
        }
      }
      if (text) result.text = redactText(`${result.text}${result.text ? "\n" : ""}${text}`).slice(-16000);
      if (!hasTools && text && e.message?.stop_reason === "end_turn") result.completed = true;
      if (e.isApiErrorMessage || e.error) { result.failed = true; result.completed = true; }
    }
    if (result.logged && e.type === "user" && Array.isArray(e.message?.content)) {
      const task = e.toolUseResult?.task;
      if (task?.task_id) finishBackground(result, { taskId: task.task_id, status: task.status });
      for (const part of e.message.content) if (part.type === "tool_result") {
        if (e.toolUseResult?.backgroundTaskId || e.toolUseResult?.agentId && e.toolUseResult?.status === "async_launched") { result.background ||= {}; result.background[part.tool_use_id] ||= { toolUseId: part.tool_use_id, taskId: e.toolUseResult.backgroundTaskId || e.toolUseResult.agentId, agentId: e.toolUseResult.agentId || null }; }
        if (!result.background?.[part.tool_use_id]) continue;
        if (part.is_error) delete result.background[part.tool_use_id];
        else if (e.toolUseResult?.backgroundTaskId || e.toolUseResult?.taskId || e.toolUseResult?.agentId) { result.background[part.tool_use_id].taskId = e.toolUseResult.backgroundTaskId || e.toolUseResult.taskId || e.toolUseResult.agentId; result.background[part.tool_use_id].agentId ||= e.toolUseResult.agentId || null; }
      }
    }
    // 官方失败事件须明确存在，不用“没有完成”推断失败或求助。
    if (result.logged && e.type === "system" && e.subtype === "stop_failure") { result.failed = true; result.completed = true; }
  } });
  result.cursor = scan.cursor; result.changed = scan.changed; result.gap ||= scan.gap;
  for (const [key, job] of Object.entries(result.background || {}).slice(0, 20)) {
    if (!job.agentId) continue;
    const original = readTaskResult(sessionId, cwd, job.agentId, { [key]: job }, 1);
    if (original.taskState === "completed" && original.resultState === "available") finishBackground(result, { taskId: job.taskId, status: "completed" });
  }
  result.backgroundServices = Object.keys(result.background || {}).filter(key => instruction.backgroundRoles?.[key]?.role === "service");
  result.backgroundOutstanding = Object.keys(result.background || {}).some(key => !result.backgroundServices.includes(key));
  result.hasMore = scan.hasMore && !result.ambiguous; result.awaitingData = scan.awaitingData; result.truncated = false;
  if (scan.changed || result.gap || result.ambiguous) result.completed = false;
  result.revision = hash(JSON.stringify([result.logged, result.started, result.completed, result.failed, result.ambiguous, result.cursor, result.text]));
  return result;
}

export function diagnoseCursor(sessionId, cwd, observation = {}) {
  const file = findSession(sessionId, cwd); let boundary = null;
  const scan = scanSession(file, observation.cursor || {}, { budget: 65536, visit: (e) => { boundary = { origin: messageOrigin(e), uuid: e.uuid || null, at: e.timestamp || null }; return { stop: true }; } });
  return { boundary, changed: scan.changed, repairable: !scan.changed && ["agent_notification", "task_notification"].includes(boundary?.origin), ownershipChanged: false };
}

export function observeHumanActivity(sessionId, cwd, saved = {}) {
  const file = findSession(sessionId, cwd), result = { userCount: 0, mainTurnEnded: false, background: {}, ...saved };
  result.background = { ...result.background };
  const scan = scanSession(file, result.cursor || {}, { visit: (e, position) => {
    const note = taskNotification(e);
    if (e.sessionId?.toLowerCase() !== sessionId.toLowerCase() || e.isSidechain || e.isMeta && note?.type !== "task_notification" || e.cwd && normalizedDirectory(e.cwd) !== normalizedDirectory(cwd)) return;
    const origin = messageOrigin(e);
    const text = normalizedText(entryText(e)), localSource = e.userType === "external" && e.entrypoint === "cli";
    if (result.lastUserCommand && e.type === "user" && localSource && e.parentUuid === result.lastUserUuid && /^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(text)) {
      result.mainTurnEnded = true; result.lastUserCommand = null; result.localCommandCompletedAt = e.timestamp || null; return;
    }
    if (origin === "human_input") {
      result.userCount++; result.lastUserUuid = e.uuid || hash(`${position.start}`); result.lastUserAt = e.timestamp || null;
      result.lastUserCursor = { offset: position.start, generation: position.generation }; result.mainTurnEnded = false;
      result.firstUserCursor ||= result.lastUserCursor;
      result.lastUserCommand = localSource ? text.match(/^<command-name>\/([a-z][a-z0-9-]{0,50})<\/command-name>\s*<command-message>[\s\S]*?<\/command-message>\s*<command-args>[\s\S]*?<\/command-args>$/)?.[1] || null : null;
    }
    if (result.userCount && e.type === "assistant") {
      const parts = Array.isArray(e.message?.content) ? e.message.content : [];
      if (parts.some((p) => p.type === "tool_use")) result.mainTurnEnded = false;
      for (const p of parts) if (p.type === "tool_use" && p.input?.run_in_background && p.id) result.background[p.id] = { taskId: p.id };
      if (!parts.some((p) => p.type === "tool_use") && entryText(e) && e.message?.stop_reason === "end_turn") result.mainTurnEnded = true;
    }
    if (result.userCount && origin === "tool_result" && Array.isArray(e.message?.content)) for (const p of e.message.content) {
      if (p.type !== "tool_result") continue;
      const task = e.toolUseResult?.task;
      if (task?.task_id) finishBackground(result, { taskId: task.task_id, status: task.status });
      if (e.toolUseResult?.backgroundTaskId) result.background[p.tool_use_id] ||= { taskId: e.toolUseResult.backgroundTaskId };
      if (!result.background[p.tool_use_id]) continue;
      if (p.is_error) delete result.background[p.tool_use_id];
      else if (e.toolUseResult?.backgroundTaskId || e.toolUseResult?.taskId) result.background[p.tool_use_id].taskId = e.toolUseResult.backgroundTaskId || e.toolUseResult.taskId;
    }
    finishBackground(result, note);
  } });
  return { ...result, cursor: scan.cursor, hasMore: scan.hasMore, awaitingData: scan.awaitingData, changed: scan.changed, gap: result.gap || scan.gap,
    completed: result.userCount > 0 && result.mainTurnEnded && !scan.hasMore && !scan.awaitingData && !scan.changed && !result.gap && !scan.gap && !Object.keys(result.background).length,
    revision: hash(JSON.stringify([result.lastUserUuid, result.mainTurnEnded, scan.cursor, result.background])) };
}

export function readHistory(args = {}) {
  const file = findSession(args.session_id, args.cwd), limit = Math.min(Math.max(Number(args.max_chars) || 2400, 1), 16000);
  const cursor = args.cursor || {}, messages = []; let used = 0, partial = null;
  const messageLimit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  if (cursor.character !== undefined && (!Number.isSafeInteger(cursor.character) || cursor.character < 0)) throw new Error("正文字符游标须为非负整数");
  const roles = args.roles || ["user", "assistant"];
  const scan = scanSession(file, cursor, { visit: (e, position) => {
    if (e.isSidechain || e.isMeta || e.sessionId?.toLowerCase() !== args.session_id.toLowerCase()) return;
    const role = e.message?.role || e.type;
    if (!roles.includes(role)) return;
    const all = redactText(entryText(e, args.include_tools === true)); if (!all) return;
    const from = position.start === cursor.offset ? Number(cursor.character) || 0 : 0;
    const count = Math.min(all.length - from, limit - used); if (count <= 0) return { stopBefore: true };
    messages.push({ uuid: e.uuid || null, role, origin: messageOrigin(e), at: e.timestamp || null, text: all.slice(from, from + count) }); used += count;
    if (from + count < all.length) { partial = { offset: position.start, generation: position.generation, character: from + count }; return { stopBefore: true }; }
    if (used >= limit || messages.length >= messageLimit) return { stop: true };
  } });
  return { sessionId: args.session_id, cwd: args.cwd, messages, nextCursor: partial || scan.cursor,
    hasMore: Boolean(partial) || scan.hasMore, awaitingData: scan.awaitingData, changed: scan.changed, gap: scan.gap, cursorType: "claude_jsonl_bytes", readOnly: true,
    page: { messageCount: messages.length, messageLimit, textCharacters: used, textCharacterLimit: limit } };
}
