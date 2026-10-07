import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { appendEvent, controllerId, listTasks, readJson, readRuntime, readTask, writeTask } from "./managed-state.mjs";
import { createManagedTask, taskSummary } from "./managed-service.mjs";
import { checkAlias, resolveManagedReference, restoreTask } from "./managed-management.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalized(cwd) {
  if (!cwd) return null;
  let value; try { value = fs.realpathSync.native(cwd); } catch { value = path.resolve(cwd); }
  return process.platform === "win32" ? value.toLowerCase() : value;
}
function metadata(file, index) {
  if (index?.projectPath && index.created) return { cwd: index.projectPath, createdAt: index.created,
    title: typeof index.summary === "string" ? index.summary.slice(0, 180) : "未命名会话" };
  const bytes = Buffer.alloc(65536), fd = fs.openSync(file, "r");
  let count; try { count = fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
  let cwd = index?.projectPath || null, firstAt = null;
  for (const line of bytes.subarray(0, count).toString("utf8").split("\n")) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
    if (!firstAt && entry.timestamp) firstAt = entry.timestamp;
    if (cwd && firstAt) break;
  }
  return { cwd, createdAt: index?.created || firstAt, title: typeof index?.summary === "string" ? index.summary.slice(0, 180) : "未命名会话" };
}

export function discoverSessions(args = {}) {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  const master = args.controller_id || controllerId();
  let folders; try { folders = fs.readdirSync(root, { withFileTypes: true }); } catch { return { sessions: [], total: 0, nextOffset: null }; }
  const tasks = listTasks(), candidates = [];
  for (const folder of folders.filter((entry) => entry.isDirectory())) {
    const dir = path.join(root, folder.name), index = readJson(path.join(dir, "sessions-index.json"));
    const entries = new Map((Array.isArray(index?.entries) ? index.entries : []).map((entry) => [entry.sessionId, entry]));
    let files; try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of files) {
      const sessionId = entry.name.slice(0, -6);
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !UUID.test(sessionId) || entries.get(sessionId)?.isSidechain) continue;
      if (args.session_id && sessionId.toLowerCase() !== String(args.session_id).toLowerCase()) continue;
      const file = path.join(dir, entry.name);
      let info, stat; try { info = metadata(file, entries.get(sessionId)); stat = fs.statSync(file); } catch { continue; }
      if (args.cwd && normalized(args.cwd) !== normalized(info.cwd)) continue;
      if (args.query && !`${sessionId} ${info.title} ${info.cwd || ""}`.toLowerCase().includes(String(args.query).toLowerCase())) continue;
      const managed = tasks.filter((task) => task.sessionId?.toLowerCase() === sessionId.toLowerCase());
      const reserved = managed.some((task) => !task.archivedAt && (["queued", "starting"].includes(task.state) || readRuntime(task.id)?.status && readRuntime(task.id).status !== "exited"));
      candidates.push({ sessionId, ...info, modifiedAt: stat.mtime.toISOString(),
        originalDirectoryExists: Boolean(info.cwd && fs.existsSync(info.cwd)),
        currentTaskIds: managed.filter((task) => task.controllerId === master).map((task) => task.id),
        managedReserved: reserved, requiresOriginalProcessExit: true, mtime: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50), offset = Math.max(0, Number(args.offset) || 0);
  return { sessions: candidates.slice(offset, offset + limit).map(({ mtime, ...entry }) => entry), total: candidates.length,
    nextOffset: offset + limit < candidates.length ? offset + limit : null };
}

export function selectedSession(sessionId, cwd) {
  if (!UUID.test(String(sessionId))) throw new Error("须使用精确 Claude 会话 UUID");
  const all = discoverSessions({ limit: 50, session_id: sessionId });
  const matches = all.sessions.filter((entry) => entry.sessionId.toLowerCase() === sessionId.toLowerCase());
  if (matches.length !== 1 || all.total !== 1) throw new Error("会话记录不存在或有多处候选，请核对精确会话 ID");
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("接入必须提供原绝对工作目录");
  if (matches[0].cwd && normalized(matches[0].cwd) !== normalized(cwd)) throw new Error("目录与该会话记录的原目录不一致");
  if (!fs.existsSync(cwd)) throw new Error("原工作目录不存在，需先恢复该任务目录");
  return matches[0];
}

export function attachSession(args = {}, sourceTask) {
  const sessionId = sourceTask?.sessionId || args.session_id;
  const cwd = sourceTask?.cwd || args.cwd;
  if (args.existing_idle_confirmed !== true) throw new Error("须先结束原 Claude 进程并确认，再按精确会话 ID 接入");
  selectedSession(sessionId, cwd);
  const created = createManagedTask({ ...args, session_id: sessionId, cwd,
    profile: args.profile || sourceTask?.coordinationProfile || undefined,
    existing_idle_confirmed: true, reused_from_task_id: sourceTask?.id || null,
    attach_request_id: args.request_id, attach_signature: args.attach_signature, attach_alias: args.alias,
    ...(sourceTask?.kind === "review" ? { kind: "review", review_of: sourceTask.reviewOf, review_ref: sourceTask.reviewRef } : {}) });
  return { ...created, reusedFromTaskId: sourceTask?.id || null,
    message: "已按精确 ID 在原目录续接，首条新指令仅使用本次提供的 prompt" };
}

function finishAlias(task) {
  if (task.attachFinished) return task;
  if (!task.attachAlias) { task.attachFinished = true; writeTask(task); return task; }
  const source = task.reusedFromTaskId && readTask(task.reusedFromTaskId);
  checkAlias(task.attachAlias, task.controllerId, source?.id || task.id);
  if (source?.alias?.toLowerCase() === task.attachAlias.toLowerCase()) {
    source.formerAliases = [...new Set([...(source.formerAliases || []), source.alias])];
    source.alias = null; writeTask(source);
  }
  task.alias = task.attachAlias; task.attachFinished = true;
  writeTask(task); appendEvent(task.id, { type: "alias_changed", alias: task.alias });
  return task;
}

export function sessionTools(args = {}) {
  if (args.action === "list") return discoverSessions(args);
  if (!["attach", "reuse"].includes(args.action)) throw new Error("未知会话操作");
  const controller = args.controller_id || controllerId();
  if (!controller) throw new Error("请提供 Codex 主控任务 ID");
  if (!args.request_id || typeof args.request_id !== "string" || args.request_id.length > 120) throw new Error("接入会话须提供稳定的 request_id");
  const signature = crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(args)
    .filter((key) => !["controller_id", "request_id"].includes(key)).sort().map((key) => [key, args[key]])))).digest("hex");
  const prior = listTasks(String(controller)).find((task) => task.attachRequestId === args.request_id);
  if (prior) {
    if (prior.attachSignature !== signature) throw new Error("request_id 已用于另一项接入请求");
    return { ...taskSummary(finishAlias(prior)), duplicate: true };
  }
  if (args.existing_idle_confirmed !== true) throw new Error("先结束原会话进程并确认，再接入指定会话");
  let source;
  if (args.action === "reuse") {
    if (!args.source_task_id) throw new Error("复用需要原任务 ID 或唯一别名");
    source = resolveManagedReference(args.source_task_id, String(controller));
    if (source.archivedAt) source = restoreTask(source.id, String(controller));
  }
  const alias = args.alias || source?.alias || null;
  if (alias) checkAlias(alias, String(controller), source?.id);
  const created = attachSession({ ...args, alias, attach_signature: signature, controller_id: String(controller) }, source);
  return { ...created, ...taskSummary(finishAlias(readTask(created.id))) };
}
