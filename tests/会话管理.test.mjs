import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { startServer, initialized, text } from "./helpers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-sessions-test-"));
process.env.CC_PLUGIN_CODEX_MANAGED_DIR = path.join(root, "状态");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "Claude配置");
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ env: { ANTHROPIC_MODEL: "本地模型" } }));
const state = await import("../plugins/claude-code/scripts/lib/managed-state.mjs");
const service = await import("../plugins/claude-code/scripts/lib/managed-service.mjs");
const management = await import("../plugins/claude-code/scripts/lib/managed-management.mjs");
const sessions = await import("../plugins/claude-code/scripts/lib/managed-sessions.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
function repository(name) {
  const cwd = path.join(root, name); fs.mkdirSync(cwd); git(cwd, "init", "-b", "main");
  fs.writeFileSync(path.join(cwd, "说明.md"), "初始\n");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".env\n");
  git(cwd, "add", "--all"); git(cwd, "-c", "user.name=测试", "-c", "user.email=test@local", "commit", "-m", "初始"); return cwd;
}
function occupy(controller) {
  service.setConcurrencyLimit(1, controller);
  const id = crypto.randomUUID(); state.writeTask({ id, controllerId: controller, state: "running" });
  state.writeRuntime(id, { status: "running", pid: process.pid });
}
function savedSession(sessionId, cwd, folder = sessionId, index) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", folder); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ type: "user", cwd, sessionId,
    timestamp: "2026-10-06T00:00:00Z", message: { content: "正文不应出现在元数据结果中" } }) + "\n" +
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "已完成测试" }] } }) + "\n");
  if (index) fs.writeFileSync(path.join(dir, "sessions-index.json"), JSON.stringify({ entries: [{ sessionId,
    projectPath: cwd, created: "2026-10-06", summary: "前端历史会话", firstPrompt: "正文不应出现在元数据结果中", ...index }] }));
}
function ended(cwd, controller) {
  occupy(controller);
  const created = service.createManagedTask({ cwd, controller_id: controller, prompt: "测试任务", visible: false });
  const task = state.readTask(created.id); task.state = "cancelled"; state.writeTask(task);
  state.writeRuntime(task.id, { status: "exited", busy: false }); return task;
}
test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(fs.realpathSync.native(root), { recursive: true, force: true });
});

test("别名唯一且按主控隔离，操作不使用模糊或最近匹配", () => {
  const id = crypto.randomUUID(), other = crypto.randomUUID(), controller = "别名主控";
  state.writeTask({ id, sessionId: crypto.randomUUID(), controllerId: controller, state: "exited" });
  state.writeTask({ id: other, sessionId: crypto.randomUUID(), controllerId: controller, state: "exited" });
  management.labelTask(id, "前端窗口", controller);
  assert.equal(management.resolveManagedReference("前端窗口", controller).id, id);
  assert.throws(() => management.labelTask(other, "前端窗口", controller), /已被/);
  assert.throws(() => management.resolveManagedReference("前端", controller), /未找到/);
  assert.throws(() => management.resolveManagedReference(id, "另一个主控"), /不属于/);
});

test("确认不再复用后清理自建工作树及已合入分支，保留主目录", () => {
  const cwd = repository("无复用清理"), controller = "清理主控", task = ended(cwd, controller);
  const result = management.archiveTask(task.id, controller, "隔离测试结束，没有复用价值", true, true);
  assert.equal(result.cwdRemoved, true); assert.equal(result.branchRemoved, true);
  assert.equal(fs.existsSync(task.cwd), false); assert.equal(fs.existsSync(cwd), true);
  assert.throws(() => git(cwd, "show-ref", "--verify", `refs/heads/${task.branch}`));
});

test("批量操作单项失败不会重复或丢弃其他结果", async () => {
  const controller_id = "批量主控", queued = crypto.randomUUID(), running = crypto.randomUUID();
  state.writeTask({ id: queued, sessionId: crypto.randomUUID(), controllerId: controller_id, state: "queued" });
  state.writeTask({ id: running, sessionId: crypto.randomUUID(), controllerId: controller_id, state: "running" });
  state.writeRuntime(running, { status: "running", pid: process.pid });
  const result = await management.manageTasks({ action: "cancel", controller_id, task_ids: [queued, running] });
  assert.equal(result.succeeded, 1); assert.equal(result.failed, 1);
  assert.equal(state.readTask(queued).state, "cancelled");
  assert.equal(result.results[1].taskId, running);
});

test("排队会话接受持久追加，稳定请求 ID 不重复写入", () => {
  const id = crypto.randomUUID(), controller = "追加主控";
  state.writeTask({ id, sessionId: crypto.randomUUID(), controllerId: controller, state: "queued" });
  const first = management.queueInstruction(id, "补充要求", "追加一", controller);
  const again = management.queueInstruction(id, "补充要求", "追加一", controller);
  assert.equal(again.commandId, first.commandId); assert.equal(again.duplicate, true);
  assert.equal(fs.readdirSync(path.join(state.taskDir(id), "inbox")).length, 1);
  assert.throws(() => management.queueInstruction(id, "另一个要求", "追加一", controller), /另一条指令/);
  assert.equal(service.taskSummary(state.readTask(id)).inboxCount, 1);
  const second = management.queueInstruction(id, "随后处理", "追加二", controller);
  const inbox = path.join(state.taskDir(id), "inbox");
  assert.equal(state.readJson(path.join(inbox, `${first.commandId}.json`)).order, 1);
  assert.equal(state.readJson(path.join(inbox, `${second.commandId}.json`)).order, 2);
});

test("批量目标有无效别名仍处理有效项，被替代任务拒绝追加", async () => {
  const controller_id = "目标错误主控", id = crypto.randomUUID(), old = crypto.randomUUID();
  state.writeTask({ id, sessionId: crypto.randomUUID(), controllerId: controller_id, state: "queued" });
  const result = await management.manageTasks({ action: "cancel", controller_id, task_ids: ["不存在的别名", id] });
  assert.equal(result.succeeded, 1); assert.equal(result.failed, 1);
  assert.equal(result.results[0].reference, "不存在的别名");
  assert.equal(state.readTask(id).state, "cancelled");
  state.writeTask({ id: old, sessionId: crypto.randomUUID(), controllerId: controller_id, state: "paused", supersededBy: id });
  assert.throws(() => management.queueInstruction(old, "旧任务新要求", "追加", controller_id), /新的执行记录/);
  assert.equal(fs.existsSync(path.join(state.taskDir(old), "inbox")), false);
});

test("会话选择索引优先并可回退元数据，不输出聊天或首条提示", () => {
  const cwd = repository("元数据仓库"), one = crypto.randomUUID(), two = crypto.randomUUID(), child = crypto.randomUUID();
  savedSession(one, cwd, one, {}); savedSession(two, cwd); savedSession(child, cwd, child, { isSidechain: true });
  const result = sessions.discoverSessions({ cwd });
  assert.equal(result.sessions.length, 2);
  assert.ok(result.sessions.some((item) => item.title === "前端历史会话"));
  assert.ok(!JSON.stringify(result).includes("正文不应"));
  assert.ok(result.sessions.every((item) => item.cwd === cwd));
});

test("接入拒绝错误目录和重复会话记录", () => {
  const cwd = repository("精确会话仓库"), id = crypto.randomUUID(); savedSession(id, cwd);
  assert.throws(() => sessions.selectedSession(id, root), /原目录不一致/);
  savedSession(id, cwd, "重复记录");
  assert.throws(() => sessions.selectedSession(id, cwd), /多处候选/);
});

test("同一会话已排队且无 PID 时仍拒绝另一份续接", () => {
  const cwd = repository("排队续接仓库"), session_id = crypto.randomUUID(), controller_id = "排队续接主控";
  occupy(controller_id); savedSession(session_id, cwd);
  const first = service.createManagedTask({ cwd, session_id, existing_idle_confirmed: true, controller_id, visible: false });
  assert.equal(first.state, "queued");
  assert.throws(() => service.createManagedTask({ cwd, session_id, existing_idle_confirmed: true,
    controller_id: "其他排队主控", visible: false }), /并发副本/);
});

test("归档清理干净已保留的插件工作树，记录与快照可恢复", () => {
  const cwd = repository("归档仓库"), controller = "归档主控", task = ended(cwd, controller);
  management.labelTask(task.id, "已结束任务", controller);
  const archived = management.archiveTask(task.id, controller, "测试交付摘要");
  assert.equal(archived.cwdRemoved, true); assert.equal(fs.existsSync(task.cwd), false);
  assert.equal(fs.existsSync(path.join(cwd, "说明.md")), true);
  assert.ok(state.readEvents(task.id).events.some((event) => event.type === "task_archived"));
  assert.ok(!service.listManagedTasks(controller).tasks.some((entry) => entry.id === task.id));
  const restored = management.restoreTask("已结束任务", controller);
  assert.equal(fs.existsSync(restored.cwd), true); assert.equal(restored.archivedAt, null);
  assert.equal(fs.readFileSync(path.join(restored.cwd, "说明.md"), "utf8").replace(/\r\n/g, "\n"), "初始\n");
});

test("未提交和忽略文件保留，归档不删未交付工作", () => {
  const cwd = repository("保留工作仓库"), controller = "保留工作主控", task = ended(cwd, controller);
  fs.writeFileSync(path.join(task.cwd, ".env"), "测试占位内容\n");
  const result = management.archiveTask(task.id, controller);
  assert.equal(result.cwdRemoved, false); assert.match(result.cleanupReason, /忽略文件/);
  assert.equal(fs.readFileSync(path.join(task.cwd, ".env"), "utf8"), "测试占位内容\n");
});

test("恢复后再归档保存最新快照，未合并的新提交保留目录", () => {
  const cwd = repository("再次归档仓库"), controller = "再次归档主控", task = ended(cwd, controller);
  management.archiveTask(task.id, controller, "第一版"); management.restoreTask(task.id, controller);
  fs.appendFileSync(path.join(task.cwd, "说明.md"), "新提交\n");
  git(task.cwd, "add", "--all"); git(task.cwd, "-c", "user.name=测试", "-c", "user.email=test@local", "commit", "-m", "尚未合并");
  const head = git(task.cwd, "rev-parse", "HEAD");
  const archived = management.archiveTask(task.id, controller, "第二版");
  assert.equal(archived.cwdRemoved, false); assert.match(archived.cleanupReason, /尚未进入/);
  assert.equal(state.readTask(task.id).archive.snapshotRef, head);
  assert.equal(state.readTask(task.id).archive.summary, "第二版");
});

test("未交付流程的归档在关闭进程之前被拒绝", async () => {
  const cwd = repository("流程保护仓库"), controller_id = "流程保护主控", task = ended(cwd, controller_id);
  const workflowId = crypto.randomUUID();
  state.writeTask({ ...task, workflowId });
  state.writeJson(path.join(state.MANAGED_ROOT, "workflows", `${workflowId}.json`), { controllerId: controller_id, stage: "implementing" });
  state.writeRuntime(task.id, { status: "idle", pid: process.pid, busy: false });
  const result = await management.manageTasks({ action: "archive", task_ids: [task.id], controller_id });
  assert.equal(result.failed, 1); assert.match(result.results[0].error, /尚未交付/);
  assert.equal(state.readTask(task.id).archivedAt, undefined);
  assert.equal(fs.existsSync(task.cwd), true);
});

test("另一项排队续接正引用目录时不能清理", () => {
  const cwd = repository("共享目录仓库"), controller = "共享目录主控", task = ended(cwd, controller);
  state.writeTask({ id: crypto.randomUUID(), sessionId: crypto.randomUUID(), controllerId: "另一个目录主控",
    cwd: fs.realpathSync.native(task.cwd), state: "queued" });
  assert.throws(() => management.archiveTask(task.id, controller), /另一项续接/);
  assert.equal(fs.existsSync(task.cwd), true);
});

test("复用已结束任务保留 Claude ID 与原目录，别名跟随新任务且重试幂等", () => {
  const cwd = repository("复用仓库"), controller_id = "复用主控", task = ended(cwd, controller_id);
  savedSession(task.sessionId, task.cwd); management.labelTask(task.id, "复用窗口", controller_id);
  const args = { action: "reuse", source_task_id: "复用窗口", controller_id, existing_idle_confirmed: true,
    request_id: "复用一次", prompt: "本次新工作", visible: false };
  const created = sessions.sessionTools(args), again = sessions.sessionTools(args);
  assert.equal(created.sessionId, task.sessionId); assert.equal(created.cwd, task.cwd);
  assert.notEqual(created.id, task.id); assert.equal(again.id, created.id);
  assert.equal(state.readTask(created.id).originalPrompt, "本次新工作");
  assert.equal(management.resolveManagedReference("复用窗口", controller_id).id, created.id);
  assert.equal(state.readTask(task.id).alias, null);
  management.labelTask(created.id, "后来修改的别名", controller_id);
  sessions.sessionTools(args);
  assert.equal(state.readTask(created.id).alias, "后来修改的别名");
  assert.throws(() => sessions.sessionTools({ ...args, prompt: "换一个工作" }), /另一项接入/);
});

test("复用异常退出的记录后，旧任务不再自动恢复同一会话", () => {
  const cwd = repository("替代任务仓库"), controller_id = "替代任务主控", task = ended(cwd, controller_id);
  savedSession(task.sessionId, task.cwd);
  state.writeTask({ ...task, state: "failed" });
  state.writeRuntime(task.id, { status: "running", pid: 99999998, claudePid: 99999997 });
  const created = sessions.sessionTools({ action: "reuse", source_task_id: task.id, controller_id,
    existing_idle_confirmed: true, request_id: "替代续接", visible: false });
  service.listManagedTasks(controller_id);
  assert.equal(state.readTask(task.id).supersededBy, created.id);
  assert.equal(state.readTask(created.id).state, "queued");
  assert.equal(state.readTask(task.id).recoveryAttempts, undefined);
  assert.throws(() => service.resumeManagedTask(task.id, controller_id), /新的执行记录/);
});

test("旧任务目录已转作会话复用，后续归档旧记录也保留它", async () => {
  const cwd = repository("复用归档仓库"), controller_id = "复用归档主控", task = ended(cwd, controller_id);
  savedSession(task.sessionId, task.cwd);
  const reused = sessions.sessionTools({ action: "reuse", source_task_id: task.id, controller_id,
    existing_idle_confirmed: true, request_id: "复用后归档", visible: false });
  await service.cancelManaged(reused.id, controller_id);
  const archived = management.archiveTask(task.id, controller_id);
  assert.equal(archived.cwdRemoved, false); assert.match(archived.cleanupReason, /会话复用/);
  assert.equal(fs.existsSync(task.cwd), true);
});

test("恢复目录成功后记录未写回，重试核对已恢复快照并完成", () => {
  const cwd = repository("恢复中断仓库"), controller = "恢复中断主控", task = ended(cwd, controller);
  management.archiveTask(task.id, controller);
  git(cwd, "worktree", "add", task.cwd, task.branch);
  assert.equal(state.readTask(task.id).archive.cwdRemoved, true);
  const restored = management.restoreTask(task.id, controller);
  assert.equal(restored.archivedAt, null); assert.equal(restored.archive.cwdRemoved, false);
  assert.equal(git(task.cwd, "rev-parse", "HEAD"), restored.archive.snapshotRef);
});

test("归档原分支被其他工作树使用时，恢复独立分支而不改其他目录", () => {
  const cwd = repository("分支占用仓库"), controller = "分支占用主控", task = ended(cwd, controller);
  management.archiveTask(task.id, controller);
  const other = path.join(root, "另一个工作树"); git(cwd, "worktree", "add", other, task.branch);
  const restored = management.restoreTask(task.id, controller);
  assert.notEqual(restored.branch, task.branch);
  assert.equal(git(other, "branch", "--show-current"), task.branch);
  assert.equal(git(task.cwd, "rev-parse", "HEAD"), restored.archive.snapshotRef);
});

test("既有目录归档保留原目录，未启动任务恢复不重置预算", async () => {
  const cwd = repository("原目录仓库"), controller_id = "原目录主控", session_id = crypto.randomUUID();
  occupy(controller_id); savedSession(session_id, cwd);
  const created = service.createManagedTask({ cwd, session_id, existing_idle_confirmed: true,
    controller_id, prompt: "首条新指令", visible: false, max_minutes: 17 });
  await service.cancelManaged(created.id, controller_id);
  const archived = management.archiveTask(created.id, controller_id);
  assert.equal(archived.cwdRemoved, false); assert.match(archived.cleanupReason, /目录保留/);
  assert.equal(fs.readFileSync(path.join(cwd, "说明.md"), "utf8"), "初始\n");
  management.restoreTask(created.id, controller_id); service.resumeManagedTask(created.id, controller_id);
  assert.equal(state.readTask(created.id).maxMinutes, 17);
  assert.equal(state.readTask(created.id).initialPrompt, "首条新指令");
});

test("Windows 精确进程标记检查阻止正在运行的外部会话", { skip: process.platform !== "win32" }, async () => {
  const sessionId = crypto.randomUUID();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", "--resume", sessionId], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(service.claudeSessionStillRunning({ sessionId }), true);
  } finally { child.kill(); await new Promise((resolve) => child.on("exit", resolve)); }
});

test("MCP 公开管理与会话元数据入口", async () => {
  const controller_id = "管理协议主控", id = crypto.randomUUID();
  state.writeTask({ id, sessionId: crypto.randomUUID(), controllerId: controller_id, state: "exited" });
  state.writeRuntime(id, { status: "exited" });
  const server = startServer({ ...process.env, CODEX_THREAD_ID: controller_id });
  try {
    await initialized(server);
    const named = await server.rpc("tools/call", { name: "delegate_manage", arguments: { action: "label", task_ids: [id], alias: "协议别名" } });
    assert.equal(JSON.parse(text(named)).succeeded, 1);
    const listed = await server.rpc("tools/call", { name: "delegate_sessions", arguments: { action: "list", cwd: root } });
    assert.ok(Array.isArray(JSON.parse(text(listed)).sessions));
  } finally { server.stop(); }
});
