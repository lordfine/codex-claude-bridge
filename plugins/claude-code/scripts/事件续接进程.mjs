import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MANAGED_ROOT } from "./lib/managed-state.mjs";
import { wakeDir, readWakeJson, writeWakeJson, pendingWakeEvents, codexActivity, reconcileWakeQueue, enqueueWakeEvent } from "./lib/事件队列.mjs";
import { claimWakeRunner, currentWakeEvents, dispatchWakeBatch } from "./lib/事件续接.mjs";
import { observeLocalRecords } from "./lib/本地观察.mjs";
import { isUrgentEvent, eventEffort, coordinationConfig } from "./lib/协作策略.mjs";
import { recordSchedulerFault, observerHeartbeat } from "./lib/续接诊断.mjs";
import { attentionNotice } from "./lib/本地提醒.mjs";
import { orcaSessions } from "./lib/Orca会话.mjs";
import { BRIDGE_VERSION } from "./lib/运行版本.mjs";

const controller = process.argv[2]; if (!controller) process.exit(1);
const folder = wakeDir(MANAGED_ROOT, controller);
if (!claimWakeRunner(folder)) process.exit(0);
const runtimeFile = path.join(folder, "runtime.json");
const previous = readWakeJson(runtimeFile);
if (previous?.activeRunId) writeWakeJson(runtimeFile, { ...previous, paused: true, reason: "上次续接进程中断，先核对已记录的 CLI 运行，不自动重放" });
let quiet = null, phase = "starting", heartbeatAt = 0;
const lockWaits = new Map();
try {
  if (previous?.paused && !previous.faultId && /事件调度异常/.test(previous.reason || "")) {
    recordSchedulerFault(folder, new Error("旧版本未保存具体异常，历史原因不能追溯重建"), { stage: "legacy_scheduler", historical: true,
      category: "HISTORICAL_DETAIL_MISSING", originalAt: fs.statSync(runtimeFile).mtime.toISOString() }, { fatal: true, notify: attentionNotice });
  }
  observerHeartbeat(folder, "starting", { dispatchPaused: Boolean(previous?.paused), diagnosticVersion: "0.22.0" });
  while (true) {
    phase = "read_config";
    const config = readWakeJson(path.join(folder, "config.json")); if (!config?.enabled) break;
    phase = "reconcile_queue";
    reconcileWakeQueue(MANAGED_ROOT, controller, folder, config);
    phase = "observe_records";
    const observation = await observeLocalRecords(controller);
    // 本地队列只在主轮及后台均结束后推进，不为无变化调用Codex模型。
    let queueNames = []; try { queueNames = fs.readdirSync(path.join(MANAGED_ROOT, "orca", "队列")); } catch {}
    for (const name of queueNames.filter((s) => /^[0-9a-f-]{36}\.json$/i.test(s))) {
      const dispatchState = readWakeJson(runtimeFile);
      if (dispatchState?.paused || dispatchState?.activeRunId) break;
      const id = name.slice(0, -5), record = readWakeJson(path.join(MANAGED_ROOT, "orca", "会话", `${id}.json`));
      if (record?.controllerId !== controller || record.state !== "attached" || record.owner === "human" || record.observation?.backgroundOutstanding || record.lastInstruction && !record.observation?.completed) continue;
      if (!(readWakeJson(path.join(MANAGED_ROOT, "orca", "队列", name)) || []).some((i) => i.state === "queued" && (!i.retryAfter || Date.now() >= i.retryAfter))) continue;
      try { await orcaSessions({ action: "dispatch_queue", id, controller_id: controller, request_id: `队列推进-${crypto.randomUUID()}` }); lockWaits.delete(id); }
      catch (error) {
        if (error.code === "ORCA_BRIDGE_BUSY") {
          const since = lockWaits.get(id) || Date.now(); lockWaits.set(id, since);
          if (Date.now() - since < 300000) continue;
        }
        const fault = recordSchedulerFault(folder, error, { stage: "dispatch_queue", taskId: id, backend: "orca" }, { notify: attentionNotice });
        enqueueWakeEvent(MANAGED_ROOT, id, { type: "recovery_uncertain", backend: "orca", eventId: `queue-fault:${fault.id}`, faultId: fault.id, requestId: record.lastInstruction?.requestId || null, at: fault.createdAt });
      }
    }
    phase = "select_events";
    const runtime = readWakeJson(runtimeFile);
    const pending = currentWakeEvents(folder, pendingWakeEvents(folder), controller);
    if (Date.now() - heartbeatAt >= 5000) { observerHeartbeat(folder, "observing", { dispatchPaused: Boolean(runtime?.paused), observed: observation.observed, errors: observation.errors || 0, pending: pending.length, localLockWaits: lockWaits.size, diagnosticVersion: BRIDGE_VERSION }); heartbeatAt = Date.now(); }
    if (!runtime?.paused && pending.length && (!runtime?.retryAfter || Date.now() >= Date.parse(runtime.retryAfter))) {
      const activity = codexActivity(config.rolloutPath);
      if (activity.state === "idle") {
        if (!quiet || quiet.signature !== activity.signature) quiet = { signature: activity.signature, since: Date.now() };
        if (pending.some(isUrgentEvent) || Date.now() - quiet.since >= config.quietMs) {
          const latest = codexActivity(config.rolloutPath);
          if (latest.state === "idle" && latest.signature === quiet.signature) {
            phase = "dispatch_cli";
            const beat = () => { try { observerHeartbeat(folder, phase, { diagnosticVersion: BRIDGE_VERSION, dispatchPaused: false }); } catch {} };
            beat(); const pulse = setInterval(beat, 5000);
            const policy = coordinationConfig(controller), first = pending.find(isUrgentEvent) || pending[0];
            const effort = eventEffort(policy, [first]);
            const batch = [first, ...pending.filter(event => event.id !== first.id && eventEffort(policy, [event]) === effort)].slice(0, 20);
            try { await dispatchWakeBatch(config, folder, batch); } finally { clearInterval(pulse); }
            quiet = null;
          }
        }
      } else quiet = null;
    } else quiet = null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} catch (error) {
  try { recordSchedulerFault(folder, error, { stage: phase }, { fatal: true, notify: attentionNotice }); }
  catch (recordError) { process.stderr.write(JSON.stringify({ type: "diagnostic_write_failed", stage: phase, code: recordError.code || null }) + "\n"); }
} finally {
  try { observerHeartbeat(folder, "stopped", { dispatchPaused: Boolean(readWakeJson(runtimeFile)?.paused), lastStage: phase, diagnosticVersion: "0.22.0" }); } catch {}
  const lock = path.join(folder, "runner.lock"), owner = readWakeJson(path.join(lock, "owner.json"));
  if (owner?.pid === process.pid) { try { fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock); } catch {} }
}
