import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const WAKE_EVENTS = new Set(["instruction_completed", "instruction_failed", "StopFailure", "needs_input",
  "permission_pending", "permission_to_human", "process_exit", "recovery_failed", "recovery_exhausted", "session_start_blocked", "handback",
  "recovery_uncertain", "recovery_interrupted_instruction", "broker_lost_claude_alive", "config_changed", "time_limit_reached", "turn_limit_reached"]);
export function wakeDir(root, controller) {
  return path.join(root, "wake", crypto.createHash("sha256").update(String(controller)).digest("hex").slice(0, 32));
}
export function readWakeJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
export function writeWakeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8"); fs.renameSync(temporary, file);
}
export function enqueueWakeEvent(root, taskId, event) {
  if (!WAKE_EVENTS.has(event.type) || event.type === "StopFailure" && event.agentId) return false;
  const task = readWakeJson(path.join(root, "tasks", taskId, "task.json"));
  if (!task?.controllerId || task.archivedAt || task.supersededBy || ["merged", "cancelled"].includes(task.state)) return false;
  if (task.workflowId && /^[0-9a-f-]{36}$/i.test(task.workflowId)) {
    const workflow = readWakeJson(path.join(root, "workflows", `${task.workflowId}.json`));
    if (["paused", "cancelled", "delivered"].includes(workflow?.stage)) return false;
  }
  const folder = wakeDir(root, task.controllerId), config = readWakeJson(path.join(folder, "config.json"));
  if (!config?.enabled) return false;
  const id = crypto.createHash("sha256").update(`${taskId}:${event.eventId}`).digest("hex");
  const file = path.join(folder, "queue", `${id}.json`);
  if (fs.existsSync(file) || fs.existsSync(path.join(folder, "ack", `${id}.json`))) return true;
  // 不向调度器复制任务正文、工具参数、凭据路径或 Claude 回复。
  writeWakeJson(file, { id, eventId: event.eventId, taskId, controllerId: task.controllerId,
    workflowId: task.workflowId || null, type: event.type, at: event.at,
    decisionId: event.decisionId || null, permissionKind: event.kind || null });
  return true;
}
export function pendingWakeEvents(folder) {
  let files; try { files = fs.readdirSync(path.join(folder, "queue")); } catch { return []; }
  return files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name) && !fs.existsSync(path.join(folder, "ack", name))).map((name) => {
    const event = readWakeJson(path.join(folder, "queue", name)); return event?.id === name.slice(0, -5) ? event : null;
  })
    .filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.id.localeCompare(b.id));
}

export function acknowledgeWakeEvents(folder, events) {
  for (const event of events) {
    writeWakeJson(path.join(folder, "ack", `${event.id}.json`), { id: event.id, at: new Date().toISOString() });
    try { fs.unlinkSync(path.join(folder, "queue", `${event.id}.json`)); } catch {}
  }
}

export function reconcileWakeQueue(root, controller, folder, config) {
  const file = path.join(folder, "scan.json"), scanned = readWakeJson(file) || {}; let changed = false;
  let tasks; try { tasks = fs.readdirSync(path.join(root, "tasks")); } catch { return; }
  for (const id of tasks.filter((name) => /^[0-9a-f-]{36}$/i.test(name))) {
    const task = readWakeJson(path.join(root, "tasks", id, "task.json"));
    if (task?.controllerId !== controller || task.archivedAt || task.supersededBy) continue;
    const eventFile = path.join(root, "tasks", id, "events.jsonl");
    let size; try { size = fs.statSync(eventFile).size; } catch { continue; }
    let saved = scanned[id] || { offset: 0, tail: "" };
    if (saved.offset > size) saved = { offset: 0, tail: "" };
    if (saved.offset === size) continue;
    const bytes = Buffer.alloc(Math.min(size - saved.offset, 256000)), fd = fs.openSync(eventFile, "r");
    let count; try { count = fs.readSync(fd, bytes, 0, bytes.length, saved.offset); } finally { fs.closeSync(fd); }
    const lines = (saved.tail + bytes.subarray(0, count).toString("utf8")).split("\n");
    const tail = lines.pop();
    if (tail.length > 1000000) throw new Error("委派事件记录过大，停止接续并保留原记录");
    for (const line of lines) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (!event.at || event.at < config.enabledAt) continue;
      event.eventId ||= crypto.createHash("sha256").update(`${id}:${line}`).digest("hex");
      enqueueWakeEvent(root, id, event);
    }
    scanned[id] = { offset: saved.offset + count, tail };
    changed = true;
  }
  if (changed) writeWakeJson(file, scanned);
}

export function codexActivity(file) {
  try {
    const stat = fs.statSync(file), length = Math.min(stat.size, 4_000_000), bytes = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, bytes, 0, length, stat.size - length); } finally { fs.closeSync(fd); }
    const lines = bytes.toString("utf8").split("\n"); if (length < stat.size) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index].trim()) continue;
      let entry; try { entry = JSON.parse(lines[index]); } catch { return { state: "unknown", signature: `${stat.size}:${stat.mtimeMs}` }; }
      if (entry.type !== "event_msg") continue;
      const type = entry.payload?.type;
      if (["task_started", "task_complete", "turn_aborted"].includes(type)) return {
        state: type === "task_started" ? "busy" : "idle", turnId: entry.payload.turn_id || null,
        signature: `${stat.size}:${stat.mtimeMs}`, at: entry.timestamp };
    }
    return { state: "unknown", signature: `${stat.size}:${stat.mtimeMs}` };
  } catch { return { state: "unknown", signature: "missing" }; }
}

export function codexTokenTotals(file) {
  try {
    const stat = fs.statSync(file), length = Math.min(stat.size, 4_000_000), bytes = Buffer.alloc(length), fd = fs.openSync(file, "r");
    try { fs.readSync(fd, bytes, 0, length, stat.size - length); } finally { fs.closeSync(fd); }
    const lines = bytes.toString("utf8").split("\n"); if (length < stat.size) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      let entry; try { entry = JSON.parse(lines[index]); } catch { continue; }
      if (entry.type === "event_msg" && entry.payload?.type === "token_count") return entry.payload.info?.total_token_usage || null;
    }
  } catch {}
  return null;
}
