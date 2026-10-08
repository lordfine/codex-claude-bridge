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
    .replace(/\b(?:sk-ant-|sk-proj-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, "[密钥已隐藏]")
    .replace(/\bsshpass\s+-p\s+["']?[^\s"']+/gi, "sshpass -p [已隐藏]")
    .replace(/([a-z]+:\/\/[^\s\/@:]+:)[^\s\/@]+(@)/gi, "$1[已隐藏]$2")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))(["']?\s*[:=]\s*["']?)([^\s"',;]+)/g, "$1$2[已隐藏]")
    .replace(/\b(password|passwd|api[_-]?key|auth[_-]?token|access[_-]?token|secret|ANTHROPIC_AUTH_TOKEN)(["']?\s*[:=]\s*["']?)([^\s"',;]+)/gi, "$1$2[已隐藏]");
}
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalizedText = (text) => String(text || "").replace(/\r\n/g, "\n").trim();
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
  if ((entry.attachment || entry.data)?.type === "task_notification") return "task_notification";
  const text = normalizedText(entryText(entry));
  // 兼容 Claude 的完整系统投递包装；普通聊天中引用标签不按通知处理。
  if (/^Another Claude session sent a message:\s*<teammate-message\s+teammate_id="[^"<>\r\n]+"(?:\s+[^<>]*)?>[\s\S]*<\/teammate-message>\s*$/.test(text)) return "agent_notification";
  if (entry.isMeta && /^<(?:teammate-message|task-notification)\b[\s\S]*<\/(?:teammate-message|task-notification)>\s*$/.test(text)) return "agent_notification";
  return entry.type === "user" ? "human_input" : entry.type;
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

export function findSession(sessionId, cwd) {
  if (!UUID.test(String(sessionId))) throw new Error("须提供精确 Claude 会话 UUID");
  if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) throw new Error("须提供存在的原绝对目录");
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
  const cursor = result.cursor || { offset: instruction.baseline || 0 };
  const scan = scanSession(file, cursor, { visit: (e, position) => {
    const notification = e.attachment || e.data;
    if (e.sessionId?.toLowerCase() !== sessionId.toLowerCase() || e.isSidechain || e.isMeta && notification?.type !== "task_notification" || e.cwd && normalizedDirectory(e.cwd) !== normalizedDirectory(cwd)) return;
    if (result.logged && notification?.type === "task_notification" && ["completed", "failed", "cancelled", "stopped"].includes(notification.status)) {
      const taskId = notification.taskId || notification.task_id;
      for (const [key, job] of Object.entries(result.background || {})) if (job.taskId === taskId || key === taskId) delete result.background[key];
    }
    if (e.type === "user") {
      const content = e.message?.content;
      const origin = messageOrigin(e);
      if (["task_notification", "agent_notification"].includes(origin)) { result.notificationCount = (result.notificationCount || 0) + 1; return; }
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
      const text = entryText(e), hasTools = (e.message?.content || []).some?.((part) => part.type === "tool_use");
      if (hasTools) result.completed = false;
      for (const part of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (part.type === "tool_use" && part.input?.run_in_background === true && part.id) {
          result.background ||= {}; result.background[part.id] = { toolUseId: part.id, taskId: part.id };
        }
      }
      if (text) result.text = redactText(`${result.text}${result.text ? "\n" : ""}${text}`).slice(-16000);
      if (!hasTools && text && e.message?.stop_reason === "end_turn") result.completed = true;
      if (e.isApiErrorMessage || e.error) result.failed = true;
    }
    if (result.logged && e.type === "user" && Array.isArray(e.message?.content)) {
      for (const part of e.message.content) if (part.type === "tool_result") {
        if (e.toolUseResult?.backgroundTaskId) { result.background ||= {}; result.background[part.tool_use_id] ||= { toolUseId: part.tool_use_id, taskId: e.toolUseResult.backgroundTaskId }; }
        if (!result.background?.[part.tool_use_id]) continue;
        if (part.is_error) delete result.background[part.tool_use_id];
        else if (e.toolUseResult?.backgroundTaskId || e.toolUseResult?.taskId) result.background[part.tool_use_id].taskId = e.toolUseResult.backgroundTaskId || e.toolUseResult.taskId;
      }
    }
    // 官方失败事件须明确存在，不用“没有完成”推断失败或求助。
    if (result.logged && e.type === "system" && e.subtype === "stop_failure") result.failed = true;
  } });
  result.cursor = scan.cursor; result.changed = scan.changed; result.gap ||= scan.gap;
  result.backgroundOutstanding = Boolean(Object.keys(result.background || {}).length);
  result.hasMore = scan.hasMore && !result.ambiguous; result.awaitingData = scan.awaitingData; result.truncated = false;
  if (scan.changed || result.gap || result.ambiguous) result.completed = false;
  result.revision = hash(JSON.stringify([result.logged, result.completed, result.failed, result.ambiguous, result.cursor, result.text]));
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
    const note = e.attachment || e.data;
    if (e.sessionId?.toLowerCase() !== sessionId.toLowerCase() || e.isSidechain || e.isMeta && note?.type !== "task_notification" || e.cwd && normalizedDirectory(e.cwd) !== normalizedDirectory(cwd)) return;
    const origin = messageOrigin(e);
    if (origin === "human_input") {
      result.userCount++; result.lastUserUuid = e.uuid || hash(`${position.start}`); result.lastUserAt = e.timestamp || null;
      result.lastUserCursor = { offset: position.start, generation: position.generation }; result.mainTurnEnded = false;
      result.firstUserCursor ||= result.lastUserCursor;
    }
    if (result.userCount && e.type === "assistant") {
      const parts = Array.isArray(e.message?.content) ? e.message.content : [];
      if (parts.some((p) => p.type === "tool_use")) result.mainTurnEnded = false;
      for (const p of parts) if (p.type === "tool_use" && p.input?.run_in_background && p.id) result.background[p.id] = { taskId: p.id };
      if (!parts.some((p) => p.type === "tool_use") && entryText(e) && e.message?.stop_reason === "end_turn") result.mainTurnEnded = true;
    }
    if (result.userCount && origin === "tool_result" && Array.isArray(e.message?.content)) for (const p of e.message.content) {
      if (p.type !== "tool_result") continue;
      if (e.toolUseResult?.backgroundTaskId) result.background[p.tool_use_id] ||= { taskId: e.toolUseResult.backgroundTaskId };
      if (!result.background[p.tool_use_id]) continue;
      if (p.is_error) delete result.background[p.tool_use_id];
      else if (e.toolUseResult?.backgroundTaskId || e.toolUseResult?.taskId) result.background[p.tool_use_id].taskId = e.toolUseResult.backgroundTaskId || e.toolUseResult.taskId;
    }
    if (note?.type === "task_notification" && ["completed", "failed", "cancelled", "stopped"].includes(note.status)) for (const [key, job] of Object.entries(result.background)) {
      if (key === (note.taskId || note.task_id) || job.taskId === (note.taskId || note.task_id)) delete result.background[key];
    }
  } });
  return { ...result, cursor: scan.cursor, hasMore: scan.hasMore, awaitingData: scan.awaitingData, changed: scan.changed, gap: result.gap || scan.gap,
    completed: result.userCount > 0 && result.mainTurnEnded && !scan.hasMore && !scan.awaitingData && !scan.changed && !result.gap && !scan.gap && !Object.keys(result.background).length,
    revision: hash(JSON.stringify([result.lastUserUuid, result.mainTurnEnded, scan.cursor, result.background])) };
}

export function readHistory(args = {}) {
  const file = findSession(args.session_id, args.cwd), limit = Math.min(Math.max(Number(args.max_chars) || 2400, 1), 16000);
  const cursor = args.cursor || {}, messages = []; let used = 0, partial = null;
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
    if (used >= limit) return { stop: true };
  } });
  return { sessionId: args.session_id, cwd: args.cwd, messages, nextCursor: partial || scan.cursor,
    hasMore: Boolean(partial) || scan.hasMore, awaitingData: scan.awaitingData, changed: scan.changed, gap: scan.gap, cursorType: "claude_jsonl_bytes", readOnly: true };
}
