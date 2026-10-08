import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer, initialized, text } from "./helpers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-wake-test-"));
process.env.CC_PLUGIN_CODEX_MANAGED_DIR = path.join(root, "状态");
process.env.CC_PLUGIN_CODEX_DISABLE_NOTIFICATIONS = "1";
const state = await import("../plugins/claude-code/scripts/lib/managed-state.mjs");
const queue = await import("../plugins/claude-code/scripts/lib/事件队列.mjs");
const wake = await import("../plugins/claude-code/scripts/lib/事件续接.mjs");
const line = (type, turn_id) => JSON.stringify({ type: "event_msg", payload: { type, turn_id } }) + "\n";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(enabled = true) {
  const controller = crypto.randomUUID(), id = crypto.randomUUID(), targetThreadId = crypto.randomUUID();
  const folder = queue.wakeDir(state.MANAGED_ROOT, controller), rolloutPath = path.join(root, `${controller}.jsonl`);
  fs.writeFileSync(rolloutPath, line("task_complete", "上一轮"));
  state.writeTask({ id, controllerId: controller, state: "running", sessionId: crypto.randomUUID() });
  const config = { controllerId: controller, targetThreadId, rolloutPath, cwd: root, enabled, enabledAt: "2020-01-01", quietMs: 1000 };
  queue.writeWakeJson(path.join(folder, "config.json"), config);
  return { id, controller, folder, config };
}
test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(fs.realpathSync.native(root), { recursive: true, force: true });
});
test("未启用及普通进度不排唤醒，关键事件只有元数据且稳定 ID 去重", () => {
  const off = fixture(false); state.appendEvent(off.id, { type: "instruction_completed" });
  assert.equal(queue.pendingWakeEvents(off.folder).length, 0);
  const f = fixture(); state.appendEvent(f.id, { type: "PostToolUse" });
  const event = { eventId: crypto.randomUUID(), type: "permission_pending", kind: "codex", command: "不应复制的命令", prompt: "不应复制的正文" };
  state.appendEvent(f.id, event); state.appendEvent(f.id, event);
  const pending = queue.pendingWakeEvents(f.folder);
  assert.equal(pending.length, 1); assert.ok(!JSON.stringify(pending).includes("不应复制"));
});
test("已归档任务及子代理失败不自动唤醒", () => {
  const f = fixture(); state.appendEvent(f.id, { type: "StopFailure", agentId: "子代理" });
  state.writeTask({ ...state.readTask(f.id), archivedAt: "2026-01-01" });
  state.appendEvent(f.id, { type: "instruction_completed" });
  assert.equal(queue.pendingWakeEvents(f.folder).length, 0);
});
test("确认记录先于删除队列，原事件回放不重复运行", () => {
  const f = fixture(), event = state.appendEvent(f.id, { type: "instruction_completed" });
  const pending = queue.pendingWakeEvents(f.folder); queue.acknowledgeWakeEvents(f.folder, pending);
  queue.enqueueWakeEvent(state.MANAGED_ROOT, f.id, event);
  assert.equal(queue.pendingWakeEvents(f.folder).length, 0);
  assert.ok(fs.existsSync(path.join(f.folder, "ack", `${pending[0].id}.json`)));
});
test("原日志补扫恢复丢失队列与半行，启用前和已确认事件不重放", () => {
  const f = fixture(); f.config.enabledAt = "2026-01-01"; queue.writeWakeJson(path.join(f.folder, "config.json"), f.config);
  const file = state.taskPath(f.id, "events.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "instruction_completed", at: "2025-01-01" }) + "\n" + '{"type":"needs_input",');
  queue.reconcileWakeQueue(state.MANAGED_ROOT, f.controller, f.folder, f.config);
  assert.equal(queue.pendingWakeEvents(f.folder).length, 0);
  fs.appendFileSync(file, '"at":"2026-10-07"}\n');
  queue.reconcileWakeQueue(state.MANAGED_ROOT, f.controller, f.folder, f.config);
  assert.equal(queue.pendingWakeEvents(f.folder).length, 1);
  queue.acknowledgeWakeEvents(f.folder, queue.pendingWakeEvents(f.folder));
  fs.unlinkSync(path.join(f.folder, "scan.json"));
  queue.reconcileWakeQueue(state.MANAGED_ROOT, f.controller, f.folder, f.config);
  assert.equal(queue.pendingWakeEvents(f.folder).length, 0);
});
test("Codex 活动或损坏记录暂停，完成记录为空闲", () => {
  const f = fixture(); assert.equal(queue.codexActivity(f.config.rolloutPath).state, "idle");
  fs.appendFileSync(f.config.rolloutPath, line("task_started", "新轮"));
  assert.equal(queue.codexActivity(f.config.rolloutPath).state, "busy");
  fs.appendFileSync(f.config.rolloutPath, '{"未完整');
  assert.equal(queue.codexActivity(f.config.rolloutPath).state, "unknown");
  assert.equal(queue.codexActivity(path.join(root, "不存在")).state, "unknown");
});
test("同主控执行锁不重复占用，失效锁可恢复", () => {
  const f = fixture(); assert.equal(wake.claimWakeRunner(f.folder), true);
  assert.equal(wake.claimWakeRunner(f.folder), false);
  queue.writeWakeJson(path.join(f.folder, "runner.lock", "owner.json"), { pid: 0 });
  assert.equal(wake.claimWakeRunner(f.folder), true);
});
test("成功且身份一致才确认，运行中新事件留给下一轮", async () => {
  const f = fixture(); state.appendEvent(f.id, { type: "instruction_completed" });
  const result = await wake.dispatchWakeBatch(f.config, f.folder, queue.pendingWakeEvents(f.folder), { runCodex: async (args) => {
    assert.ok(args.includes("resume")); assert.ok(args.includes(f.config.targetThreadId));
    assert.ok(args.includes('mcp_servers.claude-code.default_tools_approval_mode="approve"'));
    assert.ok(args.includes(`mcp_servers.claude-code.env.CC_PLUGIN_CODEX_MANAGED_DIR=${JSON.stringify(state.MANAGED_ROOT)}`));
    state.appendEvent(f.id, { type: "needs_input" });
    return { code: 0, threadId: f.config.targetThreadId, message: '{"status":"handled","summary":"已处理"}', usage: { input_tokens: 100 } };
  } });
  assert.equal(result.state, "handled"); assert.equal(queue.pendingWakeEvents(f.folder).length, 1);
  assert.equal(queue.readWakeJson(path.join(f.folder, "runtime.json")).paused, false);
});
test("错误身份、无结构结果及求助保留队列并暂停", async () => {
  for (const response of [{ code: 1 }, { code: 0, threadId: "错误身份", message: '{"status":"handled","summary":"处理"}' },
    { code: 0, message: "非结构化结果" }, { code: 0, message: '{"status":"needs_user","summary":"请决定"}' }]) {
    const f = fixture(); state.appendEvent(f.id, { type: "instruction_failed" });
    await wake.dispatchWakeBatch(f.config, f.folder, queue.pendingWakeEvents(f.folder), {
      runCodex: async () => ({ threadId: f.config.targetThreadId, ...response }) });
    assert.equal(queue.pendingWakeEvents(f.folder).length, 1);
    assert.equal(queue.readWakeJson(path.join(f.folder, "runtime.json")).paused, true);
  }
});

test("续接解析失败有分类、持久提醒和可读运行诊断", async () => {
  const f = fixture(); state.appendEvent(f.id, { type: "instruction_failed" });
  const run = await wake.dispatchWakeBatch(f.config, f.folder, queue.pendingWakeEvents(f.folder), { runCodex: async () => ({ code: 0, threadId: f.config.targetThreadId, message: "无结构回执" }) });
  assert.equal(run.diagnostic.category, "RESULT_PARSE"); assert.equal(run.usageDelta, undefined);
  assert.equal(queue.readWakeJson(path.join(f.folder, "attention.json")).runId, run.id);
  const inspected = await wake.wakeControl({ action: "inspect", controller_id: f.controller, run_id: run.id });
  assert.equal(inspected.run.id, run.id); assert.equal(inspected.run.events.length, 1);
});
test("外部新轮次到来不确认后台结果，保留事件核对", async () => {
  const f = fixture(); state.appendEvent(f.id, { type: "instruction_completed" });
  const run = await wake.dispatchWakeBatch(f.config, f.folder, queue.pendingWakeEvents(f.folder), {
    runCodex: async (args, prompt, options) => {
      options.onSpawn({ pid: 0, exitCode: null, signalCode: null });
      fs.appendFileSync(f.config.rolloutPath, line("task_started", "CLI轮")); await delay(650);
      fs.appendFileSync(f.config.rolloutPath, line("task_started", "人类轮")); await delay(650);
      return { code: 0, threadId: f.config.targetThreadId, message: '{"status":"handled","summary":"不能确认"}' };
    }
  });
  assert.equal(run.state, "uncertain"); assert.equal(queue.pendingWakeEvents(f.folder).length, 1);
});
test("后台进程主控忙碌时保留事件，不启动 CLI，停用后退出", async () => {
  const f = fixture(); fs.appendFileSync(f.config.rolloutPath, line("task_started", "人类轮"));
  state.appendEvent(f.id, { type: "instruction_completed" });
  const script = fileURLToPath(new URL("../plugins/claude-code/scripts/事件续接进程.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, f.controller], { env: process.env, windowsHide: true, stdio: "ignore" });
  const closed = new Promise((resolve) => child.on("exit", resolve));
  try {
    await delay(1500); assert.equal(fs.existsSync(path.join(f.folder, "runs")), false);
    assert.equal(queue.pendingWakeEvents(f.folder).length, 1);
    queue.writeWakeJson(path.join(f.folder, "config.json"), { ...f.config, enabled: false });
    await closed; assert.equal(child.exitCode, 0);
  } finally { if (child.exitCode === null) child.kill(); }
});
test("MCP 公开续接状态，未配置时不调用模型", async () => {
  const server = startServer({ ...process.env, CODEX_THREAD_ID: crypto.randomUUID() });
  try {
    await initialized(server);
    const result = await server.rpc("tools/call", { name: "delegate_wake", arguments: { action: "status" } });
    assert.equal(JSON.parse(text(result)).enabled, false);
  } finally { server.stop(); }
});

test("当前人类轮次可以核对暂停结果，重试仍由调度器等空闲", async () => {
  const f = fixture(false); queue.writeWakeJson(path.join(f.folder, "config.json"), { ...f.config, enabled: true });
  state.appendEvent(f.id, { type: "instruction_failed" });
  queue.writeWakeJson(path.join(f.folder, "config.json"), { ...f.config, enabled: false });
  const run = await wake.dispatchWakeBatch(f.config, f.folder, queue.pendingWakeEvents(f.folder), { runCodex: async () => ({ code: 1 }) });
  fs.appendFileSync(f.config.rolloutPath, line("task_started", "人类核对轮"));
  const result = await wake.wakeControl({ action: "resolve", controller_id: f.controller, run_id: run.id, decision: "retry" });
  assert.equal(result.paused, false); assert.equal(result.pending, 1);
  assert.equal(result.activity, "busy");
});

test("中断的运行意图在后台重启时挂起，不自动重放", async () => {
  const f = fixture(); state.appendEvent(f.id, { type: "instruction_completed" });
  const runId = crypto.randomUUID();
  queue.writeWakeJson(path.join(f.folder, "runtime.json"), { activeRunId: runId, paused: false });
  const script = fileURLToPath(new URL("../plugins/claude-code/scripts/事件续接进程.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, f.controller], { env: process.env, windowsHide: true, stdio: "ignore" });
  const closed = new Promise((resolve) => child.on("exit", resolve));
  try {
    await delay(1500);
    assert.equal(queue.readWakeJson(path.join(f.folder, "runtime.json")).paused, true);
    assert.equal(fs.existsSync(path.join(f.folder, "runs")), false);
    queue.writeWakeJson(path.join(f.folder, "config.json"), { ...f.config, enabled: false });
    await closed;
  } finally { if (child.exitCode === null) child.kill(); }
});

test("队列文件名不匹配记录时不处理，用量读取只取累计数值", () => {
  const f = fixture(), id = "a".repeat(64);
  queue.writeWakeJson(path.join(f.folder, "queue", `${id}.json`), { id: "../错误记录" });
  assert.equal(queue.pendingWakeEvents(f.folder).length, 0);
  fs.appendFileSync(f.config.rolloutPath, JSON.stringify({ type: "event_msg", payload: { type: "token_count",
    info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }) + "\n");
  assert.deepEqual(queue.codexTokenTotals(f.config.rolloutPath), { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 });
});

test("暂停或结束的协作流程不被后台事件自行恢复", () => {
  const f = fixture(), workflowId = crypto.randomUUID();
  state.writeTask({ ...state.readTask(f.id), workflowId });
  queue.writeWakeJson(path.join(state.MANAGED_ROOT, "workflows", `${workflowId}.json`), { stage: "paused" });
  state.appendEvent(f.id, { type: "instruction_completed" });
  assert.equal(queue.pendingWakeEvents(f.folder).length, 0);
  queue.writeWakeJson(path.join(state.MANAGED_ROOT, "workflows", `${workflowId}.json`), { stage: "implementing" });
  state.appendEvent(f.id, { type: "instruction_completed" });
  queue.writeWakeJson(path.join(state.MANAGED_ROOT, "workflows", `${workflowId}.json`), { stage: "paused" });
  assert.equal(wake.currentWakeEvents(f.folder, queue.pendingWakeEvents(f.folder), f.controller).length, 0);
});
