import fs from "node:fs";
import path from "node:path";
import { MANAGED_ROOT } from "./lib/managed-state.mjs";
import { wakeDir, readWakeJson, writeWakeJson, pendingWakeEvents, codexActivity, reconcileWakeQueue } from "./lib/事件队列.mjs";
import { claimWakeRunner, currentWakeEvents, dispatchWakeBatch } from "./lib/事件续接.mjs";
import { observeLocalRecords } from "./lib/本地观察.mjs";
import { isUrgentEvent } from "./lib/协作策略.mjs";

const controller = process.argv[2]; if (!controller) process.exit(1);
const folder = wakeDir(MANAGED_ROOT, controller);
if (!claimWakeRunner(folder)) process.exit(0);
const runtimeFile = path.join(folder, "runtime.json");
const previous = readWakeJson(runtimeFile);
if (previous?.activeRunId) writeWakeJson(runtimeFile, { ...previous, paused: true, reason: "上次续接进程中断，先核对已记录的 CLI 运行，不自动重放" });
let quiet = null;
try {
  while (true) {
    const config = readWakeJson(path.join(folder, "config.json")); if (!config?.enabled) break;
    reconcileWakeQueue(MANAGED_ROOT, controller, folder, config);
    await observeLocalRecords(controller);
    const runtime = readWakeJson(runtimeFile);
    const pending = currentWakeEvents(folder, pendingWakeEvents(folder), controller);
    if (!runtime?.paused && pending.length) {
      const activity = codexActivity(config.rolloutPath);
      if (activity.state === "idle") {
        if (!quiet || quiet.signature !== activity.signature) quiet = { signature: activity.signature, since: Date.now() };
        if (pending.some(isUrgentEvent) || Date.now() - quiet.since >= config.quietMs) {
          const latest = codexActivity(config.rolloutPath);
          if (latest.state === "idle" && latest.signature === quiet.signature) {
            await dispatchWakeBatch(config, folder, pending.slice(0, 20)); quiet = null;
          }
        }
      } else quiet = null;
    } else quiet = null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} catch {
  const runtime = readWakeJson(runtimeFile) || {};
  writeWakeJson(runtimeFile, { ...runtime, paused: true, reason: "事件调度异常，保留原记录并停止自动派发" });
} finally {
  const lock = path.join(folder, "runner.lock"), owner = readWakeJson(path.join(lock, "owner.json"));
  if (owner?.pid === process.pid) { try { fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock); } catch {} }
}
