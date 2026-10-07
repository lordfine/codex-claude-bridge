import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { startServer, initialized, text } from "./helpers.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-managed-test-"));
process.env.CC_PLUGIN_CODEX_MANAGED_DIR = path.join(root, "状态");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "Claude配置");
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({
  env: { ANTHROPIC_MODEL: "glm-5.3", ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-flash" }
}));
const state = await import("../plugins/claude-code/scripts/lib/managed-state.mjs");
const { classifyPermission } = await import("../plugins/claude-code/scripts/lib/managed-permission.mjs");
const { activeTerminalInput, hasHumanIntervention } = await import("../plugins/claude-code/scripts/lib/managed-input.mjs");
const service = await import("../plugins/claude-code/scripts/lib/managed-service.mjs");

test.after(() => {
  const resolved = path.resolve(root), temporary = path.resolve(os.tmpdir());
  assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
  fs.rmSync(fs.realpathSync.native(resolved), { recursive: true, force: true });
});

test("任务状态和增量事件可持久化", () => {
  const id = crypto.randomUUID();
  state.writeTask({ id, controllerId: "主控一", state: "queued" });
  assert.equal(state.readTask(id).controllerId, "主控一");
  state.appendEvent(id, { type: "task_created" });
  state.appendEvent(id, { type: "instruction_submitted" });
  assert.deepEqual(state.readEvents(id, 1).events.map((event) => event.type), ["instruction_submitted"]);
});

test("进程已退出而任务仍显示启动中时自动修复状态", () => {
  const id = crypto.randomUUID(), controller = "退出对账主控";
  state.writeTask({ id, controllerId: controller, state: "starting", recoveryAttempts: 1 });
  state.writeRuntime(id, { status: "exited", exitCode: 1, finalState: "paused" });
  service.reconcileTask(id);
  assert.equal(state.readTask(id).state, "paused");
  assert.ok(state.readEvents(id, 0, 20).events.some((event) => event.type === "exited_state_repaired"));
});

test("自动恢复耗尽后显示暂停，同一失联进程不重复发出事件", () => {
  const id = crypto.randomUUID(), controllerId = "恢复耗尽主控";
  state.writeTask({ id, sessionId: crypto.randomUUID(), controllerId, state: "running", recoveryAttempts: 1 });
  state.writeRuntime(id, { status: "idle", pid: 0, startedAt: "2026-10-07T00:00:00Z" });
  service.reconcileTask(id); service.reconcileTask(id);
  assert.equal(state.readTask(id).state, "paused");
  assert.equal(state.readEvents(id).events.filter((event) => event.type === "recovery_exhausted").length, 1);
  assert.equal(service.taskSummary(state.readTask(id)).state, "paused");
});

test("主动取消优先于恢复失败，达到上限优先于主动取消", () => {
  assert.equal(state.exitTaskState({ recoveryAttempts: 1, cancelRequested: true }, 1), "cancelled");
  assert.equal(state.exitTaskState({ recoveryAttempts: 1, cancelRequested: true, limitHit: true }, 1), "timed_out");
  assert.equal(state.exitTaskState({ recoveryAttempts: 1 }, 1), "paused");
});

test("模型选择只接受当前 Claude Code 配置中的名称", () => {
  assert.equal(state.resolveModel(), null);
  assert.equal(state.resolveModel("sonnet"), "deepseek-flash");
  assert.equal(state.resolveModel("glm-5.3"), "glm-5.3");
  assert.throws(() => state.resolveModel("未配置模型"), /模型不在当前/);
});

test("查看与滚动终端不夺取控制权，输入和中断会夺取", () => {
  assert.equal(hasHumanIntervention("\x1b[A\x1b[5~\x1b[<64;12;8M"), false);
  assert.equal(activeTerminalInput("\x1b[B查看\r"), "查看\r");
  assert.equal(hasHumanIntervention("查看"), true);
  assert.equal(hasHumanIntervention("\r"), true);
  assert.equal(hasHumanIntervention("\x03"), true);
});

test("终端焦点和光标位置回报不冒充人工输入", () => {
  for (const input of ["\x1b[I", "\x1b[O", "\x1b[12;80R", "\x1b[I\x1b[O\x1b[12;80R"]) {
    assert.equal(hasHumanIntervention(input), false);
    assert.equal(activeTerminalInput(input), "");
  }
  assert.equal(activeTerminalInput("\x1b[I真实输入\r\x1b[O"), "真实输入\r");
  assert.equal(hasHumanIntervention("\x1b[I真实输入\r"), true);
});

test("同一精确 Claude 会话 ID 不创建并发副本", () => {
  const id = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const cwd = path.join(root, "单例仓库");
  fs.mkdirSync(cwd);
  state.writeTask({ id, controllerId: "其他主控", sessionId, cwd });
  state.writeRuntime(id, { pid: process.pid, status: "running" });
  assert.throws(() => service.createManagedTask({ cwd, session_id: sessionId,
    existing_idle_confirmed: true, controller_id: "当前主控", visible: false }), /并发副本/);
});

test("恢复中断指令时使原权限请求失效并保留审计事件", () => {
  const controller = "恢复测试主控";
  service.setConcurrencyLimit(1, controller);
  const cwd = path.join(root, "恢复测试仓库");
  fs.mkdirSync(cwd);
  const occupiedId = crypto.randomUUID();
  state.writeTask({ id: occupiedId, controllerId: controller, state: "running", createdAt: "2026-01-01" });
  state.writeRuntime(occupiedId, { pid: process.pid, status: "running" });
  const id = crypto.randomUUID(), sessionId = crypto.randomUUID(), commandId = crypto.randomUUID();
  state.writeTask({ id, controllerId: controller, state: "running", sessionId, cwd,
    initialPrompt: "原始指令", originalPrompt: "原始指令", createdAt: "2026-01-02" });
  state.writeRuntime(id, { pid: 99999999, claudePid: 99999998, status: "running",
    busy: true, current: { id: commandId, state: "submitted" } });
  const transcriptFolder = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "恢复测试");
  fs.mkdirSync(transcriptFolder, { recursive: true });
  fs.writeFileSync(path.join(transcriptFolder, `${sessionId}.jsonl`),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "已收到" }] } }) + "\n");
  const decisionId = crypto.randomUUID();
  const pendingFile = path.join(state.taskDir(id), "pending", `${decisionId}.json`);
  state.writeJson(pendingFile, { id: decisionId, taskId: id, kind: "codex" });
  service.reconcileTask(id);
  assert.equal(state.readTask(id).state, "queued");
  assert.equal(state.readTask(id).recoveryInterrupted.commandId, commandId);
  assert.equal(state.readTask(id).originalPrompt, "原始指令");
  assert.equal(fs.existsSync(pendingFile), false);
  assert.ok(state.readEvents(id, 0, 20).events.some((event) => event.type === "permission_invalidated"));
  assert.throws(() => service.decidePermission(id, decisionId, "allow", "", controller), /会话已暂停或退出/);
});

test("人工草稿或待发指令阻止审查快照", () => {
  const id = crypto.randomUUID(), controller = "人工队列审查主控";
  const cwd = path.join(root, "人工队列审查仓库");
  fs.mkdirSync(cwd);
  state.writeTask({ id, controllerId: controller, kind: "implementation", state: "running",
    cwd, worktree: cwd });
  state.writeRuntime(id, { status: "idle", busy: false, owner: "human", humanDraft: true, queue: [] });
  assert.throws(() => service.createReviewTask(id, { controller_id: controller }), /人工输入队列/);
  state.writeRuntime(id, { status: "idle", busy: false, owner: "codex", humanDraft: false,
    queue: [{ id: crypto.randomUUID() }] });
  assert.throws(() => service.createReviewTask(id, { controller_id: controller }), /人工输入队列/);
});

test("审查快照过期时拒绝合并，最新快照合并后清理隔离工作树", async () => {
  const repo = path.join(root, "审查合并仓库");
  fs.mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  git(repo, "init", "-b", "master");
  fs.writeFileSync(path.join(repo, "说明.md"), "初始\n");
  git(repo, "add", "--all");
  git(repo, "-c", "user.name=测试", "-c", "user.email=test@local", "commit", "-m", "初始");
  const baseRef = git(repo, "rev-parse", "HEAD");
  const controller = "审查合并测试主控", id = crypto.randomUUID();
  const implementation = path.join(root, "实现工作树");
  const branch = "codex/claude-merge-test";
  git(repo, "worktree", "add", "-b", branch, implementation, baseRef);
  fs.appendFileSync(path.join(implementation, "说明.md"), "第一版\n");
  git(implementation, "add", "--all");
  git(implementation, "-c", "user.name=测试", "-c", "user.email=test@local", "commit", "-m", "第一版");
  const firstRef = git(implementation, "rev-parse", "HEAD");
  state.writeTask({ id, controllerId: controller, kind: "implementation", state: "exited",
    source: repo, cwd: implementation, worktree: implementation, baseRef, sourceBranch: "master", branch });
  state.writeRuntime(id, { status: "exited" });
  const review = (ref) => {
    const reviewId = crypto.randomUUID(), sessionId = crypto.randomUUID();
    const reviewPath = path.join(state.MANAGED_ROOT, "reviews", reviewId);
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
    git(repo, "worktree", "add", "--detach", reviewPath, ref);
    state.writeTask({ id: reviewId, controllerId: controller, kind: "review", state: "exited",
      reviewOf: id, reviewRef: ref, sessionId, cwd: reviewPath, worktree: reviewPath });
    state.writeRuntime(reviewId, { status: "exited" });
    const folder = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", reviewId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${sessionId}.jsonl`),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "审查通过" }] } }) + "\n");
    return { reviewId, reviewPath };
  };
  const firstReview = review(firstRef);
  fs.appendFileSync(path.join(implementation, "说明.md"), "第二版\n");
  git(implementation, "add", "--all");
  git(implementation, "-c", "user.name=测试", "-c", "user.email=test@local", "commit", "-m", "第二版");
  await assert.rejects(service.mergeManaged(id, firstReview.reviewId, "定向检查通过", controller), /审查快照后发生变化/);
  assert.equal(git(repo, "rev-parse", "HEAD"), baseRef);
  const latestReview = review(git(implementation, "rev-parse", "HEAD"));
  const merged = await service.mergeManaged(id, latestReview.reviewId, "定向检查通过", controller);
  assert.equal(merged.merged, true);
  assert.equal(fs.existsSync(latestReview.reviewPath), false, JSON.stringify(state.readEvents(latestReview.reviewId, 0, 100).events.slice(-1)));
  assert.match(fs.readFileSync(path.join(repo, "说明.md"), "utf8"), /第二版/);
});

test("权限分类区分普通操作、敏感操作与只读审查", () => {
  const cwd = path.join(root, "仓库");
  fs.mkdirSync(cwd);
  const task = { cwd, kind: "implementation" };
  const check = (tool_name, tool_input, target = task) => classifyPermission({ tool_name, tool_input }, target).kind;
  assert.equal(check("Read", { file_path: path.join(cwd, "普通文件.txt") }), "allow");
  assert.equal(check("Read", { file_path: path.join(cwd, ".env") }), "user");
  assert.equal(check("Bash", { command: "git status --porcelain && echo \"---\" && git diff HEAD" }), "allow");
  assert.equal(check("Bash", { command: `cd "${cwd.replaceAll("\\", "/")}" && git status` }), "allow");
  assert.equal(check("Bash", { command: `git -C "${cwd.replaceAll("\\", "/")}" diff HEAD` }), "allow");
  assert.equal(check("Bash", { command: `git -C "${root.replaceAll("\\", "/")}" status` }), "codex");
  assert.equal(check("Bash", { command: "git diff --ext-diff HEAD" }), "codex");
  assert.equal(check("Bash", { command: "rg --pre=bad 关键词" }), "codex");
  assert.equal(check("Bash", { command: "git push origin main" }), "codex");
  assert.equal(check("Bash", { command: "docker compose -f docker-compose.215.yml up -d api" }), "codex");
  assert.equal(check("Bash", { command: "psql -h 192.168.0.215 -f migration.sql" }), "codex");
  assert.equal(check("Bash", { command: "curl -X POST https://example.invalid/hook" }), "codex");
  assert.equal(check("Bash", { command: "cat .env" }), "user");
  assert.equal(check("MultiEdit", { file_path: path.join(cwd, "普通文件.txt"), edits: Array(11).fill({}) }), "codex");
  assert.equal(check("Write", { file_path: path.join(cwd, "普通文件.txt") }, { ...task, kind: "review" }), "deny");
  assert.equal(check("Write", { file_path: path.join(root, "外部文件.txt") }, { ...task, kind: "review" }), "deny");
  assert.equal(check("Bash", { command: "npm test" }, { ...task, kind: "review" }), "allow");
  assert.equal(check("Bash", { command: "npm run build" }, { ...task, kind: "review" }), "allow");
  assert.equal(check("Bash", { command: "git status --short" }, { ...task, kind: "review" }), "allow");
  assert.equal(check("Bash", { command: "git ls-tree -r --name-only HEAD" }, { ...task, kind: "review" }), "allow");
  assert.equal(check("Task", { prompt: "编辑文件" }, { ...task, kind: "review" }), "deny");
});

test("MCP 能调整主控并发上限并列出任务", async () => {
  const controller_id = "测试主控";
  const server = startServer({ ...process.env, CODEX_THREAD_ID: controller_id });
  try {
    await initialized(server);
    const changed = await server.rpc("tools/call", { name: "delegate_limit", arguments: { limit: 2, controller_id } });
    assert.equal(JSON.parse(text(changed)).limit, 2);
    const listed = await server.rpc("tools/call", { name: "delegate_list", arguments: { controller_id } });
    assert.equal(JSON.parse(text(listed)).limit, 2);
    assert.deepEqual(JSON.parse(text(listed)).tasks, []);
  } finally { server.stop(); }
});

test("权限钩子等待 Codex 决定并把拒绝返回 Claude", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(root, "拒绝测试仓库");
  fs.mkdirSync(cwd);
  state.writeTask({ id, cwd, kind: "implementation", sessionId: crypto.randomUUID() });
  const hook = path.resolve("plugins/claude-code/scripts/managed-hook.mjs");
  const child = spawn(process.execPath, [hook], {
    env: { ...process.env, CC_PLUGIN_CODEX_TASK_ID: id }, stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash",
    tool_input: { command: "git push origin main" } }));
  const folder = path.join(state.taskDir(id), "pending");
  let pending;
  for (let attempt = 0; attempt < 100 && !pending; attempt += 1) {
    const names = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    if (names.length) pending = JSON.parse(fs.readFileSync(path.join(folder, names[0]), "utf8"));
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(pending?.kind, "codex");
  state.writeJson(path.join(state.taskDir(id), "decisions", `${pending.id}.json`), {
    id: pending.id, decision: "deny", reason: "测试拒绝远端写入"
  });
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(output).hookSpecificOutput.decision.behavior, "deny");
  assert.ok(state.readEvents(id, 0, 20).events.some((event) => event.type === "permission_decided"));
});

test("Codex 未响应时权限钩子不输出自动批准", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(root, "失联测试仓库");
  fs.mkdirSync(cwd);
  state.writeTask({ id, cwd, kind: "implementation", sessionId: crypto.randomUUID() });
  const child = spawn(process.execPath, [path.resolve("plugins/claude-code/scripts/managed-hook.mjs")], {
    env: { ...process.env, CC_PLUGIN_CODEX_TASK_ID: id, CC_PLUGIN_CODEX_PERMISSION_WAIT_MS: "200" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash",
    tool_input: { command: "git push origin main" } }));
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(exitCode, 0);
  assert.equal(output, "");
  assert.ok(state.readEvents(id, 0, 20).events.some((event) => event.type === "permission_to_human"));
});
