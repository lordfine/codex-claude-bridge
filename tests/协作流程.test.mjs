import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { startServer, initialized, text } from "./helpers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-workflow-test-"));
process.env.CC_PLUGIN_CODEX_MANAGED_DIR = path.join(root, "状态");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "Claude配置");
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({
  env: { ANTHROPIC_MODEL: "本地默认", ANTHROPIC_DEFAULT_SONNET_MODEL: "本地实现" }
}));
const state = await import("../plugins/claude-code/scripts/lib/managed-state.mjs");
const service = await import("../plugins/claude-code/scripts/lib/managed-service.mjs");
const preferences = await import("../plugins/claude-code/scripts/lib/managed-preferences.mjs");
const { managedWorkflow } = await import("../plugins/claude-code/scripts/lib/managed-workflow.mjs");
const { prepareClaudeSettings } = await import("../plugins/claude-code/scripts/lib/managed-config.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"] }).trim();
function repository(name) {
  const cwd = path.join(root, name); fs.mkdirSync(cwd);
  git(cwd, "init", "-b", "main");
  fs.writeFileSync(path.join(cwd, "说明.md"), "初始内容\n");
  git(cwd, "add", "--all");
  git(cwd, "-c", "user.name=测试", "-c", "user.email=test@local", "commit", "-m", "初始");
  return cwd;
}
function occupy(controller) {
  service.setConcurrencyLimit(1, controller);
  const id = crypto.randomUUID();
  state.writeTask({ id, controllerId: controller, state: "running" });
  state.writeRuntime(id, { pid: process.pid, status: "running" });
}
function transcript(task, messages) {
  const folder = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", task.id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `${task.sessionId}.jsonl`), messages.map((text) => JSON.stringify({
    type: "assistant", message: { content: [{ type: "text", text }] }
  })).join("\n") + "\n");
}
test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(fs.realpathSync.native(root), { recursive: true, force: true });
});

test("角色模型按仓库共享工作树，单次继承可覆盖角色偏好", () => {
  const cwd = repository("模型仓库"), worktree = path.join(root, "模型工作树");
  git(cwd, "worktree", "add", "--detach", worktree, "HEAD");
  preferences.projectModels(cwd, { implementation: "sonnet", review: "本地默认" });
  assert.equal(preferences.roleModel(worktree, "implementation"), "本地实现");
  assert.equal(preferences.roleModel(worktree, "implementation", "inherit"), null);
  assert.equal(preferences.roleModel(cwd, "review"), "本地默认");
  assert.throws(() => preferences.projectModels(cwd, { review: "不存在" }), /模型不在/);
  assert.equal(preferences.projectModels(cwd).defaults.review, "本地默认");
});

test("无效模型与上限在创建工作树前被拒绝", () => {
  const cwd = repository("无效参数仓库");
  const before = git(cwd, "worktree", "list", "--porcelain");
  assert.throws(() => service.createManagedTask({ cwd, controller_id: "无效参数主控", model: "不存在" }), /模型不在/);
  assert.throws(() => service.createManagedTask({ cwd, controller_id: "无效参数主控", max_minutes: -1 }), /执行时间/);
  assert.equal(git(cwd, "worktree", "list", "--porcelain"), before);
  assert.equal(git(cwd, "branch", "--list", "codex/*"), "");
});

test("批量等待越过多页普通事件，状态不重复附上任务提示", async () => {
  const controller = "分页主控", ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids) {
    state.writeTask({ id, controllerId: controller, state: "exited" });
    state.writeRuntime(id, { status: "exited", current: { id: "指令一", state: "submitted", prompt: "重复文本".repeat(1000) } });
  }
  for (let i = 0; i < 230; i++) state.appendEvent(ids[0], { type: "PostToolUse" });
  state.appendEvent(ids[0], { type: "instruction_completed", commandId: "完成一" });
  state.appendEvent(ids[1], { type: "needs_input" });
  const result = await service.waitManyManaged(ids.map((task_id) => ({ task_id, cursor: 0 })), 0, controller);
  assert.equal(result.changes.length, 2);
  assert.equal(result.cursors[ids[0]], 231);
  assert.equal(result.changes[0].events.events.length, 1);
  assert.ok(!JSON.stringify(result.tasks).includes("重复文本"));
  const empty = await service.waitManaged(ids[0], result.cursors[ids[0]], 0, controller);
  assert.deepEqual(empty.events.events, []);
  assert.equal(empty.timedOut, true);
});

test("达到并发上限时列表显示审查优先的启动顺序", () => {
  const controller = "启动顺序主控"; occupy(controller);
  const implementation = crypto.randomUUID(), review = crypto.randomUUID();
  state.writeTask({ id: implementation, controllerId: controller, state: "queued", kind: "implementation", createdAt: "2026-01-01" });
  state.writeTask({ id: review, controllerId: controller, state: "queued", kind: "review", createdAt: "2026-02-01" });
  const listed = service.listManagedTasks(controller);
  assert.deepEqual(listed.queueOrder, [review, implementation]);
  assert.equal(listed.running, 1);
});

test("增量正文分段后可完整重组，后续读取不重放旧消息", () => {
  const task = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), controllerId: "正文主控" };
  state.writeTask(task);
  const expected = ["甲".repeat(199) + "😀" + "甲".repeat(150), "乙".repeat(310)]; transcript(task, expected);
  let cursor = { message: 0, offset: 0 }, collected = "";
  for (let i = 0; i < 5; i++) {
    const result = service.managedTranscript(task.id, task.controllerId, 200, cursor);
    assert.ok(result.messages.every((item) => !/[\uD800-\uDBFF]$/.test(item.text)));
    collected += result.messages.map((item) => item.text).join(""); cursor = result.nextCursor;
    if (!result.hasMore) break;
  }
  assert.equal(collected, expected.join(""));
  assert.deepEqual(service.managedTranscript(task.id, task.controllerId, 200, cursor).messages, []);
});

test("恢复仅重放尚未写入的队列指令，已写入的保持回执不明", () => {
  const id = crypto.randomUUID(), queuedId = crypto.randomUUID(), writtenId = crypto.randomUUID();
  const task = { id, queuedInstructions: [{ id: queuedId, prompt: "尚未写入" }, { id: writtenId, prompt: "已经写入" }] };
  state.writeTask(task);
  state.appendEvent(id, { type: "instruction_queued", commandId: queuedId });
  state.appendEvent(id, { type: "instruction_written", commandId: writtenId });
  const result = service.recoverQueuedInstructions(task, { queue: task.queuedInstructions });
  assert.deepEqual(result.map((entry) => entry.id), [queuedId]);
});

test("协作流程从派发到快照审查和合并，重试不创建重复会话", async () => {
  const cwd = repository("完整流程仓库"), controller_id = "完整流程主控"; occupy(controller_id);
  const create = { action: "create", cwd, goal: "完善说明", acceptance: "新增一句说明", controller_id, request_id: "创建一" };
  const workflow = await managedWorkflow(create);
  assert.equal((await managedWorkflow(create)).id, workflow.id);
  const args = { action: "dispatch", workflow_id: workflow.id, controller_id, request_id: "派发一", visible: false };
  const dispatched = await managedWorkflow(args), item = dispatched.items[0];
  assert.equal((await managedWorkflow(args)).items[0].taskId, item.taskId);
  assert.equal(state.listTasks(controller_id).filter((task) => task.workflowId === workflow.id).length, 1);
  const implementation = state.readTask(item.taskId);
  fs.appendFileSync(path.join(implementation.cwd, "说明.md"), "新增一句说明\n");
  state.writeTask({ ...implementation, state: "exited" });
  state.writeRuntime(item.taskId, { status: "exited", busy: false });
  const reviewed = await managedWorkflow({ action: "review", workflow_id: workflow.id, item_id: item.id,
    controller_id, request_id: "审查一", visible: false });
  const review = state.readTask(reviewed.items[0].reviewId);
  transcript(review, ["审查通过，新增说明符合要求"]);
  state.writeTask({ ...review, state: "exited" }); state.writeRuntime(review.id, { status: "exited", busy: false });
  const accepted = await managedWorkflow({ action: "accept", workflow_id: workflow.id, item_id: item.id,
    controller_id, request_id: "验收一", verification: "Codex 核对说明内容通过" });
  assert.equal(accepted.stage, "delivered");
  assert.match(fs.readFileSync(path.join(cwd, "说明.md"), "utf8"), /新增一句说明/);
  assert.equal(git(cwd, "status", "--porcelain"), "");
  assert.equal(fs.existsSync(review.cwd), false, JSON.stringify(state.readEvents(review.id, 0, 100).events.slice(-1)));
});

test("中断后按持久关联恢复已创建任务，游标可保存但不能回退", async () => {
  const cwd = repository("续接流程仓库"), controller_id = "续接流程主控"; occupy(controller_id);
  const workflow = await managedWorkflow({ action: "create", cwd, goal: "续接目标", controller_id, request_id: "创建续接" });
  const dispatched = await managedWorkflow({ action: "dispatch", workflow_id: workflow.id, controller_id,
    request_id: "续接派发", visible: false });
  const item = dispatched.items[0], file = path.join(state.MANAGED_ROOT, "workflows", `${workflow.id}.json`);
  const value = state.readJson(file); value.items[0].taskId = null;
  value.operations["续接派发"].state = "running"; state.writeJson(file, value);
  const restored = await managedWorkflow({ action: "status", workflow_id: workflow.id, controller_id });
  assert.equal(restored.items[0].taskId, item.taskId);
  assert.deepEqual(restored.pendingOperations, []);
  await managedWorkflow({ action: "checkpoint", workflow_id: workflow.id, controller_id,
    cursors: [{ task_id: item.taskId, event_cursor: 5, transcript_cursor: { message: 1, offset: 0 } }] });
  await assert.rejects(managedWorkflow({ action: "checkpoint", workflow_id: workflow.id, controller_id,
    cursors: [{ task_id: item.taskId, event_cursor: 4 }] }), /不能回退/);
  const resumed = await managedWorkflow({ action: "resume", workflow_id: workflow.id, controller_id, request_id: "续接编排" });
  assert.equal(resumed.items[0].cursors[item.taskId].event, 5);
  assert.equal(resumed.items[0].taskId, item.taskId);
});

test("审查在创建前被阻塞，解除后同一请求可重试且只建一个会话", async () => {
  const cwd = repository("审查重试仓库"), controller_id = "审查重试主控"; occupy(controller_id);
  const workflow = await managedWorkflow({ action: "create", cwd, goal: "审查重试", controller_id, request_id: "创建" });
  const dispatched = await managedWorkflow({ action: "dispatch", workflow_id: workflow.id,
    controller_id, request_id: "派发", visible: false });
  const item = dispatched.items[0], task = state.readTask(item.taskId);
  state.writeTask({ ...task, state: "running" });
  state.writeRuntime(task.id, { status: "running", busy: true });
  const args = { action: "review", workflow_id: workflow.id, item_id: item.id,
    controller_id, request_id: "审查", visible: false };
  await assert.rejects(managedWorkflow(args), /尚未空闲/);
  assert.equal(state.listTasks(controller_id).filter((entry) => entry.workflowId === workflow.id).length, 1);
  state.writeTask({ ...task, state: "exited" }); state.writeRuntime(task.id, { status: "exited", busy: false });
  const reviewed = await managedWorkflow(args);
  assert.equal(reviewed.stage, "reviewing");
  assert.ok(reviewed.items[0].reviewId);
  assert.equal((await managedWorkflow(args)).items[0].reviewId, reviewed.items[0].reviewId);
  assert.equal(state.listTasks(controller_id).filter((entry) => entry.workflowId === workflow.id).length, 2);
});

test("部分派发失败后补齐剩余条目，已有任务保持原 ID", async () => {
  const cwd = repository("部分派发仓库"), controller_id = "部分派发主控"; occupy(controller_id);
  const workflow = await managedWorkflow({ action: "create", cwd, goal: "独立条目", controller_id, request_id: "创建部分" });
  await assert.rejects(managedWorkflow({ action: "dispatch", workflow_id: workflow.id, controller_id,
    request_id: "首次派发", visible: false, items: [{ prompt: "第一项" }, { prompt: "第二项", model: "不存在" }] }), /模型不在/);
  const before = await managedWorkflow({ action: "status", workflow_id: workflow.id, controller_id });
  assert.ok(before.items[0].taskId); assert.equal(before.items[1].taskId, null);
  const after = await managedWorkflow({ action: "dispatch", workflow_id: workflow.id, controller_id,
    request_id: "补齐派发", visible: false, items: [{ prompt: "第一项" }, { prompt: "第二项", model: "inherit" }] });
  assert.equal(after.items[0].taskId, before.items[0].taskId);
  assert.ok(after.items[1].taskId);
  assert.equal(state.listTasks(controller_id).filter((task) => task.workflowId === workflow.id).length, 2);
});

test("返工只有收到持久接收证据才计次数，恢复后不重复累计", async () => {
  const cwd = repository("返工接收仓库"), controller_id = "返工接收主控";
  const workflow = await managedWorkflow({ action: "create", cwd, goal: "接收确认", controller_id, request_id: "接收创建" });
  const taskId = crypto.randomUUID(), itemId = crypto.randomUUID(), commandId = crypto.randomUUID();
  state.writeTask({ id: taskId, controllerId: controller_id, state: "exited" });
  state.writeRuntime(taskId, { status: "exited" });
  const file = path.join(state.MANAGED_ROOT, "workflows", `${workflow.id}.json`), value = state.readJson(file);
  value.stage = "paused"; value.items = [{ id: itemId, taskId, reviewIds: [], stage: "revision_pending", repairs: 0, cursors: {} }];
  value.operations = { 修复: { id: "修复", action: "revise", itemId, commandId, state: "failed" } }; state.writeJson(file, value);
  assert.equal((await managedWorkflow({ action: "status", workflow_id: workflow.id, controller_id })).items[0].repairs, 0);
  state.appendEvent(taskId, { type: "instruction_queued", commandId });
  const recovered = await managedWorkflow({ action: "resume", workflow_id: workflow.id, controller_id, request_id: "接收续接" });
  assert.equal(recovered.items[0].repairs, 1); assert.equal(recovered.stage, "implementing");
  assert.equal((await managedWorkflow({ action: "status", workflow_id: workflow.id, controller_id })).items[0].repairs, 1);
});

test("空锁过期后可恢复，活进程持有的锁仍阻止并发修改", async () => {
  const cwd = repository("锁恢复仓库"), controller_id = "锁恢复主控";
  const workflow = await managedWorkflow({ action: "create", cwd, goal: "锁恢复", controller_id, request_id: "锁创建" });
  const lock = path.join(state.MANAGED_ROOT, "workflows", `${workflow.id}.json.lock`);
  fs.mkdirSync(lock); const old = new Date(Date.now() - 10000); fs.utimesSync(lock, old, old);
  await managedWorkflow({ action: "checkpoint", workflow_id: workflow.id, controller_id, cursors: [] });
  assert.equal(fs.existsSync(lock), false);
  fs.mkdirSync(lock); state.writeJson(path.join(lock, "owner.json"), { pid: process.pid });
  await assert.rejects(managedWorkflow({ action: "checkpoint", workflow_id: workflow.id, controller_id, cursors: [] }), /另一个操作/);
  fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock);
});

test("两轮返工后转 Codex 接手，不再给 Claude 派第三轮", async () => {
  const cwd = repository("返工仓库"), controller_id = "返工主控";
  const workflow = await managedWorkflow({ action: "create", cwd, goal: "返工目标", controller_id, request_id: "创建返工" });
  const file = path.join(state.MANAGED_ROOT, "workflows", `${workflow.id}.json`), value = state.readJson(file);
  const taskId = crypto.randomUUID(), reviewId = crypto.randomUUID(), itemId = crypto.randomUUID();
  for (const id of [taskId, reviewId]) {
    state.writeTask({ id, controllerId: controller_id, state: "exited" });
    state.writeRuntime(id, { status: "exited", busy: false });
  }
  value.stage = "reviewing"; value.items = [{ id: itemId, taskId, reviewIds: [reviewId], stage: "reviewing", repairs: 2, cursors: {} }];
  state.writeJson(file, value);
  const result = await managedWorkflow({ action: "revise", workflow_id: workflow.id, item_id: itemId,
    controller_id, request_id: "第三轮判断", feedback: "仍有问题" });
  assert.equal(result.items[0].repairs, 2);
  assert.equal(result.items[0].stage, "codex_work");
});

test("解决并提交合并冲突后可确认原任务交付", async () => {
  const cwd = repository("冲突仓库"), controllerId = "冲突主控", taskId = crypto.randomUUID(), reviewId = crypto.randomUUID();
  const baseRef = git(cwd, "rev-parse", "HEAD"), worktree = path.join(root, "冲突实现");
  git(cwd, "worktree", "add", "-b", "codex/冲突实现", worktree, baseRef);
  fs.writeFileSync(path.join(worktree, "说明.md"), "实现的修改\n");
  git(worktree, "add", "--all"); git(worktree, "-c", "user.name=测试", "-c", "user.email=test@local", "commit", "-m", "实现");
  const reviewRef = git(worktree, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(cwd, "说明.md"), "主线的修改\n");
  git(cwd, "add", "--all"); git(cwd, "-c", "user.name=测试", "-c", "user.email=test@local", "commit", "-m", "主线");
  const reviewPath = path.join(state.MANAGED_ROOT, "reviews", reviewId);
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true }); git(cwd, "worktree", "add", "--detach", reviewPath, reviewRef);
  state.writeTask({ id: taskId, controllerId, kind: "implementation", state: "exited", cwd: worktree,
    source: cwd, sourceBranch: "main", branch: "codex/冲突实现", worktree, baseRef });
  const review = { id: reviewId, controllerId, kind: "review", state: "exited", sessionId: crypto.randomUUID(),
    reviewOf: taskId, reviewRef, cwd: reviewPath, worktree: reviewPath };
  state.writeTask(review); transcript(review, ["审查通过"]);
  for (const id of [taskId, reviewId]) state.writeRuntime(id, { status: "exited" });
  const conflict = await service.mergeManaged(taskId, reviewId, "检查通过", controllerId);
  assert.equal(conflict.conflict, true);
  fs.writeFileSync(path.join(cwd, "说明.md"), "保留主线与实现的明确意图\n");
  git(cwd, "add", "--all"); git(cwd, "-c", "user.name=测试", "-c", "user.email=test@local", "commit", "-m", "解决冲突");
  const completed = await service.mergeManaged(taskId, reviewId, "解决后重新验收通过", controllerId);
  assert.equal(completed.merged, true);
  assert.equal(state.readTask(taskId).state, "merged");
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test("API 失败回调只记录错误类别，配置包含失败和求助事件", async () => {
  const task = { id: crypto.randomUUID(), cwd: root, kind: "implementation", sessionId: crypto.randomUUID() };
  state.writeTask(task);
  const settings = state.readJson(prepareClaudeSettings(task));
  assert.ok(settings.hooks.StopFailure && settings.hooks.Notification);
  const child = spawn(process.execPath, [path.resolve("plugins/claude-code/scripts/managed-hook.mjs")], {
    env: { ...process.env, CC_PLUGIN_CODEX_TASK_ID: task.id }, stdio: ["pipe", "ignore", "pipe"]
  });
  child.stdin.end(JSON.stringify({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "不应输出的正文" }));
  await new Promise((resolve) => child.on("exit", resolve));
  const event = state.readEvents(task.id).events[0];
  assert.equal(event.type, "StopFailure"); assert.equal(event.error, "rate_limit");
  assert.ok(!JSON.stringify(event).includes("不应输出"));
});

test("MCP 可保存角色偏好并创建可恢复流程", async () => {
  const cwd = repository("协议流程仓库"), controller_id = "协议流程主控";
  const server = startServer({ ...process.env, CODEX_THREAD_ID: controller_id });
  try {
    await initialized(server);
    const model = await server.rpc("tools/call", { name: "delegate_models", arguments: { cwd, implementation: "sonnet" } });
    assert.equal(JSON.parse(text(model)).defaults.implementation, "sonnet");
    const created = await server.rpc("tools/call", { name: "delegate_workflow", arguments: {
      action: "create", cwd, goal: "通过协议创建", request_id: "协议创建"
    } });
    const workflow = JSON.parse(text(created));
    assert.equal(workflow.stage, "planning");
    const listed = await server.rpc("tools/call", { name: "delegate_workflow", arguments: { action: "list" } });
    assert.equal(JSON.parse(text(listed)).workflows[0].id, workflow.id);
  } finally { server.stop(); }
});
