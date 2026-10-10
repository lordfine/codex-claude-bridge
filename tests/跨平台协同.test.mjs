import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-platform-test-"));
process.env.CC_PLUGIN_CODEX_MANAGED_DIR = path.join(root, "状态");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "配置");
process.env.CC_PLUGIN_CODEX_DISABLE_NOTIFICATIONS = "1";
const state = await import("../plugins/claude-code/scripts/lib/managed-state.mjs");
const reader = await import("../plugins/claude-code/scripts/lib/会话读取.mjs");
const platform = await import("../plugins/claude-code/scripts/lib/平台适配.mjs");
const { executionClock } = await import("../plugins/claude-code/scripts/lib/执行计时.mjs");
const { managedWorkflow } = await import("../plugins/claude-code/scripts/lib/managed-workflow.mjs");
const { taskSummary, pendingPermissions, decidePermission } = await import("../plugins/claude-code/scripts/lib/managed-service.mjs");
const { overview, compactObservation } = await import("../plugins/claude-code/scripts/lib/进度摘要.mjs");
const { prepareClaudeSettings } = await import("../plugins/claude-code/scripts/lib/managed-config.mjs");

test("完整子代理包装继续读取，普通引用仍是人类输入", () => {
  const id = crypto.randomUUID(), cwd = root, folder = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "会话"); fs.mkdirSync(folder, { recursive: true });
  const entry = (type, text) => ({ type, sessionId: id, cwd, uuid: crypto.randomUUID(), message: { content: [{ type: "text", text }], stop_reason: type === "assistant" ? "end_turn" : null } });
  const rows = [entry("user", "任务 <bridge-instruction:测试>"), entry("assistant", "前一轮"), entry("user", 'Another Claude session sent a message:\n<teammate-message teammate_id="检查员" color="green">已完成检查</teammate-message>'), entry("assistant", "最新交付")];
  Object.assign(rows[2], { userType: "external", entrypoint: "cli" });
  const file = path.join(folder, `${id}.jsonl`); fs.writeFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");
  const result = reader.observeInstruction(id, cwd, { marker: "<bridge-instruction:测试>" });
  assert.equal(result.nextUserObserved, undefined); assert.equal(result.completed, true); assert.match(result.text, /最新交付/); assert.equal(result.cursor.offset, fs.statSync(file).size);
  assert.equal(reader.messageOrigin(entry("user", '<teammate-message teammate_id="检查员">请看这段引用</teammate-message>')), "human_input");
  const offset = Buffer.byteLength(rows.slice(0, 2).map(JSON.stringify).join("\n") + "\n");
  assert.equal(reader.diagnoseCursor(id, cwd, { cursor: { offset } }).repairable, true);
});

test("执行计时排除审批与人类挂起，保留总持续时间", () => {
  const clock = executionClock({ elapsedMs: 100, waitingMs: 50 }, 0);
  clock.update(true, 1000); clock.update(false, 6000);
  const result = clock.snapshot(7000);
  assert.equal(result.elapsedMs, 2100); assert.equal(result.waitingMs, 5050); assert.equal(result.totalMs, 7150);
});

test("POSIX精确会话进程识别与查询失败保护", () => {
  const id = crypto.randomUUID(), run = () => ` 12345 /usr/bin/claude --resume '${id}'\n`;
  assert.equal(platform.sessionProcessRunning(id, { platform: "darwin", run }), true);
  assert.equal(platform.sessionProcessRunning(crypto.randomUUID(), { platform: "darwin", run }), false);
  assert.equal(platform.sessionProcessRunning(id, { platform: "darwin", run: () => { throw new Error(); } }), true);
  assert.equal(platform.shellQuote("中文 '路径"), "'中文 '\\''路径'");
});

test("自己的工作树等完整选择再信任，兼容编号与未编号提示", () => {
  const question = "Quick safety check: Is this a project you created or one you trust?\n";
  assert.equal(platform.trustConfirmationKey(question), null);
  assert.equal(platform.trustConfirmationKey(question + "❯ 1. Yes, I trust this folder"), "\r");
  assert.equal(platform.trustConfirmationKey(question + "❯ No, exit"), "\x1b[A\r");
});

test("退出历史状态统一投影，未发送队列仍保留", () => {
  const id = crypto.randomUUID(); state.writeTask({ id, controllerId: "终态", state: "cancelled", sessionId: crypto.randomUUID(), cwd: root });
  state.writeRuntime(id, { status: "exited", ready: true, busy: true, current: { id: "旧指令" }, queue: [{ id: "未发送" }], activeSubagents: ["子代理"] });
  const result = taskSummary(state.readTask(id)); assert.equal(result.busy, false); assert.equal(result.ready, false); assert.equal(result.current, null); assert.equal(result.activeSubagentCount, 0); assert.equal(result.queueLength, 1);
});

test("审查取消投影为待处理，新审查不受旧取消影响", async () => {
  const id = crypto.randomUUID(), impl = crypto.randomUUID(), review = crypto.randomUUID(), item = crypto.randomUUID(), controller = "父流程";
  const file = path.join(state.MANAGED_ROOT, "workflows", `${id}.json`);
  const value = { id, controllerId: controller, cwd: root, goal: "目标", stage: "reviewing", operations: {}, items: [{ id: item, stage: "reviewing", taskId: impl, reviewIds: [review] }] };
  state.writeJson(file, value); state.writeTask({ id: impl, controllerId: controller, cwd: root, state: "exited" }); state.writeTask({ id: review, controllerId: controller, cwd: root, state: "cancelled" });
  const result = await managedWorkflow({ action: "status", controller_id: controller, workflow_id: id });
  assert.equal(result.stage, "needs_attention"); assert.equal(result.items[0].stage, "review_blocked"); assert.equal(result.items[0].reviewState, "cancelled");
  const next = crypto.randomUUID(); value.items[0].reviewIds.push(next); state.writeJson(file, value); state.writeTask({ id: next, controllerId: controller, cwd: root, state: "queued" });
  assert.equal((await managedWorkflow({ action: "status", controller_id: controller, workflow_id: id })).items[0].stage, "reviewing");
});

test("人工升级待办仍可查但拒绝晚到批准，默认钩子等待覆盖五分钟", () => {
  const id = crypto.randomUUID(), decision = crypto.randomUUID(); state.writeTask({ id, controllerId: "审批", cwd: root, sessionId: crypto.randomUUID() }); state.writeRuntime(id, { pid: process.pid, status: "running" });
  state.writeJson(path.join(state.taskDir(id), "pending", `${decision}.json`), { id: decision, taskId: id, state: "awaiting_human", hookActive: false });
  assert.equal(pendingPermissions(id, "审批", decision)[0].actionable, false);
  assert.throws(() => decidePermission(id, decision, "allow", "", "审批"), /原钩子失效/);
  const settings = state.readJson(prepareClaudeSettings(state.readTask(id))); assert.equal(settings.hooks.PermissionRequest[0].hooks[0].timeout, 330);
});

test("聚合进度区分会话与目录，无变化返回短状态", () => {
  const id = crypto.randomUUID(); state.writeTask({ id, controllerId: "进度", state: "queued", sessionId: crypto.randomUUID(), cwd: root, kind: "implementation" });
  const first = overview({ controller_id: "进度" }); assert.equal(first.tasks[0].taskId, id); assert.equal(first.tasks[0].workspace, root);
  assert.equal(overview({ controller_id: "进度", after_revision: first.revision }).unchanged, true);
});

test("重复观察不再次取正文，用户主动查询可强制读取", async () => {
  const id = crypto.randomUUID(), controller = "观察"; state.writeTask({ id, controllerId: controller, state: "queued", cwd: root }); let calls = 0;
  const args = { controller_id: controller, task_id: id }, fn = () => { calls++; return { content: [] }; };
  await compactObservation("delegate_status", args, fn); const second = await compactObservation("delegate_status", args, fn);
  assert.equal(calls, 1); assert.match(second.content[0].text, /结束本轮/);
  await compactObservation("delegate_status", { ...args, force: true }, fn); assert.equal(calls, 2);
});
