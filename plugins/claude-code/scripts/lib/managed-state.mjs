import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { enqueueWakeEvent } from "./事件队列.mjs";
import { atomicJson } from "./原子文件.mjs";

export const MANAGED_ROOT = process.env.CC_PLUGIN_CODEX_MANAGED_DIR ||
  path.join(os.homedir(), ".cache", "cc-plugin-codex", "managed");

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newTaskId() {
  return crypto.randomUUID();
}

export function exitTaskState({ limitHit, cancelRequested, recoveryAttempts }, code) {
  if (limitHit) return "timed_out";
  if (cancelRequested) return "cancelled";
  if (recoveryAttempts && code !== 0) return "paused";
  return code === 0 ? "exited" : "failed";
}

export function taskDir(id) {
  if (!TASK_ID.test(String(id))) throw new Error("无效的任务 ID");
  return path.join(MANAGED_ROOT, "tasks", id);
}

export function taskPath(id, name) {
  if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw new Error("无效的任务文件名");
  return path.join(taskDir(id), name);
}

export const writeJson = atomicJson;

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

export function readTask(id) {
  return readJson(taskPath(id, "task.json"));
}

export function writeTask(task) {
  return writeJson(taskPath(task.id, "task.json"), task);
}

export function readRuntime(id) {
  return readJson(taskPath(id, "runtime.json"));
}

export function writeRuntime(id, runtime) {
  return writeJson(taskPath(id, "runtime.json"), runtime);
}

export function listTasks(controllerId = null) {
  let names;
  try { names = fs.readdirSync(path.join(MANAGED_ROOT, "tasks")); }
  catch { return []; }
  return names.filter((name) => TASK_ID.test(name))
    .map((name) => readTask(name))
    .filter((task) => task && (!controllerId || task.controllerId === controllerId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function appendEvent(id, event) {
  const file = taskPath(id, "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const item = { at: new Date().toISOString(), ...event, eventId: event.eventId || crypto.randomUUID() };
  fs.appendFileSync(file, JSON.stringify(item) + "\n", "utf8");
  try { enqueueWakeEvent(MANAGED_ROOT, id, item); } catch { /* 原事件已保存；调度异常不影响 Claude 执行。 */ }
  return item;
}

export function readEvents(id, cursor = 0, limit = 30) {
  let lines;
  try { lines = fs.readFileSync(taskPath(id, "events.jsonl"), "utf8").split("\n").filter(Boolean); }
  catch { lines = []; }
  const from = Math.max(0, Math.min(Number(cursor) || 0, lines.length));
  const count = Math.max(1, Math.min(Number(limit) || 30, 100));
  const events = [];
  for (const line of lines.slice(from, from + count)) {
    try { events.push(JSON.parse(line)); }
    catch { events.push({ type: "corrupt_event" }); }
  }
  return { events, nextCursor: from + events.length, hasMore: from + events.length < lines.length };
}

export function controllerId() {
  return process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null;
}

export function fingerprint(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
  catch { return null; }
}

export function claudeSettingsPath() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
}

export function configuredModels() {
  const settings = readJson(claudeSettingsPath()) || {};
  const env = settings.env || {};
  const slots = {
    default: env.ANTHROPIC_MODEL || settings.model || process.env.ANTHROPIC_MODEL || null,
    opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || null,
    sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || null,
    haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || null
  };
  return { slots, values: [...new Set(Object.values(slots).filter(Boolean))] };
}

export function resolveModel(choice) {
  if (choice == null || choice === "" || choice === "inherit") return null;
  const { slots, values } = configuredModels();
  if (Object.hasOwn(slots, choice) && slots[choice]) return slots[choice];
  if (values.includes(choice)) return choice;
  throw new Error(`模型不在当前 Claude Code 配置中。可用：${JSON.stringify(slots)}`);
}
