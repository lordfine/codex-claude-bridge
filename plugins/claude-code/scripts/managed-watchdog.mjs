#!/usr/bin/env node
import { readRuntime } from "./lib/managed-state.mjs";
import { reconcileTask } from "./lib/managed-service.mjs";

const id = process.argv[2];
if (!id) process.exit(1);
const pid = Number(process.argv[3]);
if (!Number.isInteger(pid) || pid <= 0) process.exit(1);
let deathObservedAt = null;

function alive(target) {
  try { process.kill(target, 0); return true; }
  catch { return false; }
}

const timer = setInterval(() => {
  const runtime = readRuntime(id);
  if (!runtime || runtime.status === "exited") {
    clearInterval(timer);
    process.exit(0);
  }
  if (runtime.pid !== pid) {
    clearInterval(timer);
    process.exit(0);
  }
  if (!alive(pid)) {
    if (deathObservedAt === null) deathObservedAt = Date.now();
    // ConPTY 子进程可能在桥接器退出后的数秒内才终止；先等其稳定。
    if (Date.now() - deathObservedAt < 8000) return;
    try { reconcileTask(id); }
    catch { /* 错误已保留在任务文件和桥接日志中，后续状态查询会再处理。 */ }
    clearInterval(timer);
    process.exit(0);
  }
}, 2000);
