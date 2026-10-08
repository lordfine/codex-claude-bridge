import fs from "node:fs";
import path from "node:path";
import { MANAGED_ROOT } from "./lib/managed-state.mjs";
import { wakeDir, readWakeJson, writeWakeJson, pendingWakeEvents, codexActivity, reconcileWakeQueue } from "./lib/事件队列.mjs";
import { claimWakeRunner, currentWakeEvents, dispatchWakeBatch } from "./lib/事件续接.mjs";
import { observeLocalRecords } from "./lib/本地观察.mjs";
import { isUrgentEvent } from "./lib/协作策略.mjs";
import { recordSchedulerFault, observerHeartbeat } from "./lib/续接诊断.mjs";
import { attentionNotice } from "./lib/本地提醒.mjs";

const controller = process.argv[2]; if (!controller) process.exit(1);
const folder = wakeDir(MANAGED_ROOT, controller);
if (!claimWakeRunner(folder)) process.exit(0);
const runtimeFile = path.join(folder, "runtime.json");
const previous = readWakeJson(runtimeFile);
if (previous?.activeRunId) writeWakeJson(runtimeFile, { ...previous, paused: true, reason: "上次续接进程中断，先核对已记录的 CLI 运行，不自动重放" });
let quiet = null, phase = "starting", heartbeatAt = 0;
try {
  if (previous?.paused && !previous.faultId && /事件调度异常/.test(previous.reason || "")) {
    recordSchedulerFault(folder, new Error("旧版本未保存具体异常，历史原因不能追溯重建"), { stage: "legacy_scheduler", historical: true,
      category: "HISTORICAL_DETAIL_MISSING", originalAt: fs.statSync(runtimeFile).mtime.toISOString() }, { fatal: true, notify: attentionNotice });
  }
  observerHeartbeat(folder, "starting", { dispatchPaused: Boolean(previous?.paused), diagnosticVersion: "0.19.2" });
  while (true) {
    phase = "read_config";
    const config = readWakeJson(path.join(folder, "config.json")); if (!config?.enabled) break;
    phase = "reconcile_queue";
    reconcileWakeQueue(MANAGED_ROOT, controller, folder, config);
    phase = "observe_records";
    const observation = await observeLocalRecords(controller);
    phase = "select_events";
    const runtime = readWakeJson(runtimeFile);
    const pending = currentWakeEvents(folder, pendingWakeEvents(folder), controller);
    if (Date.now() - heartbeatAt >= 5000) { observerHeartbeat(folder, "observing", { dispatchPaused: Boolean(runtime?.paused), observed: observation.observed, errors: observation.errors || 0, pending: pending.length, diagnosticVersion: "0.19.2" }); heartbeatAt = Date.now(); }
    if (!runtime?.paused && pending.length) {
      const activity = codexActivity(config.rolloutPath);
      if (activity.state === "idle") {
        if (!quiet || quiet.signature !== activity.signature) quiet = { signature: activity.signature, since: Date.now() };
        if (pending.some(isUrgentEvent) || Date.now() - quiet.since >= config.quietMs) {
          const latest = codexActivity(config.rolloutPath);
          if (latest.state === "idle" && latest.signature === quiet.signature) {
            phase = "dispatch_cli";
            const beat = () => { try { observerHeartbeat(folder, phase, { diagnosticVersion: "0.19.2", dispatchPaused: false }); } catch {} };
            beat(); const pulse = setInterval(beat, 5000);
            try { await dispatchWakeBatch(config, folder, pending.slice(0, 20)); } finally { clearInterval(pulse); }
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
  try { observerHeartbeat(folder, "stopped", { dispatchPaused: Boolean(readWakeJson(runtimeFile)?.paused), lastStage: phase, diagnosticVersion: "0.19.2" }); } catch {}
  const lock = path.join(folder, "runner.lock"), owner = readWakeJson(path.join(lock, "owner.json"));
  if (owner?.pid === process.pid) { try { fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock); } catch {} }
}
