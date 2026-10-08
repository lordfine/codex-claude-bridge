export function executionClock(task, now = Date.now()) {
  let mark = now, executed = Math.max(0, Number(task.elapsedMs) || 0), waited = Math.max(0, Number(task.waitingMs) || 0), waiting = false;
  return {
    update(isWaiting, at = Date.now()) { const delta = Math.max(0, at - mark); if (waiting) waited += delta; else executed += delta; mark = at; waiting = isWaiting; return this.snapshot(at); },
    snapshot(at = Date.now()) { const delta = Math.max(0, at - mark); return { elapsedMs: executed + (waiting ? 0 : delta), waitingMs: waited + (waiting ? delta : 0), totalMs: executed + waited + delta, timingMode: "execution", waiting }; }
  };
}
