import crypto from "node:crypto";
export function validateStatusCursor(cursor, targetId, kind, generation = "controller") {
  if (!cursor || cursor.kind !== kind || cursor.targetId !== targetId || cursor.generation !== generation || typeof cursor.revision !== "string") throw Object.assign(new Error("invalid_cursor：游标类型、目标或运行实例不匹配，请读取该目标的新状态"), { code: "invalid_cursor" });
  return cursor.revision;
}
export function statusResponse(value, options = {}) {
  const task = value.task, events = value.events?.events || [];
  const nativeAttention = task && (task.failure || ["failed", "paused", "cancelled"].includes(task.state) || task.owner === "human");
  const nativeCompleted = task && !task.busy && !task.activeSubagentCount && !task.backgroundCount && !task.queueLength && events.filter((e) => ["instruction_completed", "instruction_failed", "instruction_submitted"].includes(e.type)).at(-1)?.type === "instruction_completed";
  const disconnected = Boolean(value.disconnected || value.binding?.state === "stale" || value.terminal?.connected === false);
  const needsAttention = Boolean(value.needsAttention || nativeAttention || value.terminalBlocker || value.turn?.failed || value.turn?.ambiguous || value.turn?.changed || value.turn?.gap || value.owner === "human");
  const completed = !disconnected && !needsAttention && !value.backgroundOutstanding && !value.turn?.backgroundOutstanding && Boolean(options.completed ?? (nativeCompleted || value.turn?.completed || value.lastInstruction?.state === "completed"));
  const currentStatus = options.currentStatus || (disconnected ? "disconnected" : needsAttention ? "needs_attention" : completed ? "completed" : value.lastInstruction || task?.busy ? "running" : "idle");
  const unchanged = options.unchanged ?? value.unchanged ?? false, timedOut = options.timedOut ?? value.timedOut ?? false;
  const revision = value.revision || crypto.createHash("sha256").update(JSON.stringify([value.id || value.taskId || task?.id, currentStatus, value.lastInstruction, value.turn?.cursor, value.terminalBlocker, value.events?.nextCursor])).digest("hex");
  return { ...value, responseVersion: 1, status: timedOut ? "timed_out" : unchanged ? "unchanged" : currentStatus, currentStatus,
    revision, cursor: value.cursor ?? value.events?.nextCursor ?? { revision }, statusCursor: { kind: value.id || value.taskId || task?.id ? "task_status" : "controller_overview", targetId: value.id || value.taskId || task?.id || value.controllerId, generation: value.incarnationId || "controller", revision }, cursorType: value.cursorType || (typeof (value.cursor ?? value.events?.nextCursor) === "number" ? "native_event_index" : "bridge_status_revision"), unchanged: Boolean(unchanged), completed,
    needsAttention, disconnected, timedOut: Boolean(timedOut), endModelTurn: Boolean(unchanged || timedOut || ["running", "idle"].includes(currentStatus)),
    waitHint: { mode: "event_or_long_wait", afterRevision: revision, maxWaitMs: 60000, modelPolling: false } };
}
