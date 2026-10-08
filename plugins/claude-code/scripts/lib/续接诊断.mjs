import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readWakeJson, writeWakeJson } from "./事件队列.mjs";
import { redactText } from "./会话读取.mjs";

export function safeDiagnosticText(value, limit = 2000) {
  return redactText(String(value || ""))
    .replace(/\b(token|credential|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2[已隐藏]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[令牌已隐藏]")
    .replace(/\b(authorization|cookie|set-cookie)(\s*[:=]\s*)[^\r\n]+/gi, "$1$2[已隐藏]")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]+/g, "$1?[参数已隐藏]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[长值已隐藏]").slice(0, limit);
}
export function diagnosticError(error, context = {}) {
  const name = /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(error?.name || "") ? error.name : "Error";
  const code = /^[A-Z0-9_]{1,60}$/.test(error?.code || "") ? error.code : null;
  return { category: context.category || "SCHEDULER_ERROR", stage: context.stage || "unknown", name, code,
    message: safeDiagnosticText(error?.message || "未提供错误详情", 1000),
    frames: String(error?.stack || "").split("\n").filter((s) => /^\s*at\s/.test(s)).slice(0, 5).map((s) => safeDiagnosticText(s, 240)),
    taskId: context.taskId || null, backend: context.backend || null, at: new Date().toISOString() };
}
export function recordSchedulerFault(folder, error, context = {}, { fatal = false, notify } = {}) {
  const diagnostic = diagnosticError(error, context), key = crypto.createHash("sha256").update(JSON.stringify([diagnostic.stage, diagnostic.taskId, diagnostic.backend, diagnostic.name, diagnostic.code, diagnostic.message])).digest("hex");
  const indexFile = path.join(folder, "fault-index.json"), index = readWakeJson(indexFile) || {};
  const prior = index[key] && readWakeJson(path.join(folder, "faults", `${index[key]}.json`));
  const fault = prior?.state === "active" ? { ...prior, occurrences: prior.occurrences + 1, lastSeenAt: diagnostic.at } : {
    id: crypto.randomUUID(), state: "active", source: "scheduler", fatal, diagnostic, summary: `自动续接需要处理：${diagnostic.stage}／${diagnostic.code || diagnostic.name}`,
    createdAt: diagnostic.at, lastSeenAt: diagnostic.at, occurrences: 1, originalAt: context.originalAt || null, historical: context.historical === true };
  writeWakeJson(path.join(folder, "faults", `${fault.id}.json`), fault); index[key] = fault.id; writeWakeJson(indexFile, index);
  if (!prior || prior.state !== "active") fs.appendFileSync(path.join(folder, "diagnostics.jsonl"), JSON.stringify(fault) + "\n", "utf8");
  if (fatal) {
    const runtime = readWakeJson(path.join(folder, "runtime.json")) || {};
    writeWakeJson(path.join(folder, "runtime.json"), { ...runtime, paused: true, reason: fault.summary, faultId: fault.id, faultAt: fault.createdAt });
  }
  if (!prior || prior.state !== "active") {
    try { notify?.(folder, { id: fault.id, faultId: fault.id, source: "scheduler", summary: fault.summary, diagnostic,
      events: diagnostic.taskId ? [{ taskId: diagnostic.taskId }] : [] }); }
    catch (error) { fault.notificationError = diagnosticError(error, { stage: "notify" }); writeWakeJson(path.join(folder, "faults", `${fault.id}.json`), fault); }
  }
  return fault;
}
export function schedulerFaults(folder, id) {
  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("需要精确故障 ID");
    const fault = readWakeJson(path.join(folder, "faults", `${id}.json`)); if (!fault) throw new Error("故障记录不存在"); return fault;
  }
  let files; try { files = fs.readdirSync(path.join(folder, "faults")); } catch { return []; }
  return files.filter((s) => /^[0-9a-f-]{36}\.json$/i.test(s)).map((s) => readWakeJson(path.join(folder, "faults", s))).filter(Boolean)
    .sort((a,b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))).slice(0, 20);
}
export function observerHeartbeat(folder, phase, details = {}) {
  writeWakeJson(path.join(folder, "observer-health.json"), { pid: process.pid, phase, heartbeatAt: new Date().toISOString(), ...details });
}
