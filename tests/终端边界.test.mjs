import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-broker-boundary-"));
process.env.CC_PLUGIN_CODEX_MANAGED_DIR = path.join(root, "状态");
const state = await import("../plugins/claude-code/scripts/lib/managed-state.mjs");
const broker = fileURLToPath(new URL("../plugins/claude-code/scripts/managed-broker.mjs", import.meta.url));

// 仅替换 ConPTY 依赖；预算、事件处理、控制管道和退出流程运行实际桥接器源码。
const fake = `const pty = { spawn(command, args, options) {
  writeJson(taskPath(id, "fixture.json"), { command, args, subagentLimit: options.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS });
  let ended = false, onExit;
  return { pid: process.pid, write() {}, resize() {}, onData(callback) {
    setTimeout(() => callback("\\x1b]0;验收\\x07bypass permissions on"), 10);
  }, onExit(callback) { onExit = callback; }, kill() {
    if (!ended) { ended = true; setTimeout(() => onExit({ exitCode: 0 }), 5); }
  } };
} };`;
const source = fs.readFileSync(broker, "utf8").replace('import pty from "node-pty";', fake)
  .replace('taskPath, writeRuntime,', 'taskPath, writeJson, writeRuntime,')
  .replace(/from "(\.\/[^\"]+)"/g, (_, relative) => `from ${JSON.stringify(pathToFileURL(path.resolve(path.dirname(broker), relative)).href)}`);
assert.ok(source.includes(fake), "ConPTY 夹具未替换，禁止启动真实模型");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(options) {
  const task = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), controllerId: crypto.randomUUID(),
    kind: "implementation", state: "starting", source: root, cwd: root, settingsPath: path.join(root, "settings.json"),
    autoVisible: false, ...options };
  state.writeTask(task);
  let error = "";
  const child = spawn(process.execPath, ["--input-type=module", "-", task.id], {
    env: process.env, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  child.stderr.on("data", (data) => { error = (error + data).slice(-2000); });
  const completed = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end(source);
  const deadline = Date.now() + 5000;
  while (!state.readRuntime(task.id) && Date.now() < deadline && child.exitCode === null) await delay(20);
  assert.ok(state.readRuntime(task.id), error);
  return { task, child, completed, error: () => error };
}
async function finish(run) {
  let timer;
  try {
    const code = await Promise.race([run.completed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("桥接器边界夹具未退出")), 5000);
    })]);
    assert.equal(code, 0, run.error());
  } finally { clearTimeout(timer); if (run.child.exitCode === null) run.child.kill(); }
}
async function control(taskId, request) {
  const runtime = state.readRuntime(taskId);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(runtime.controlPipe);
    socket.setEncoding("utf8"); let buffer = "";
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("夹具控制管道超时")); });
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (part) => { buffer += part; if (buffer.includes("\n")) { socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0])); } });
  });
}
test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  fs.rmSync(fs.realpathSync.native(root), { recursive: true, force: true });
});

test("实际桥接器默认 90 分钟累计预算到达时退出，默认子代理上限为 8", async () => {
  const run = await start({ elapsedMs: 90 * 60000 - 500 });
  await finish(run);
  assert.equal(state.readTask(run.task.id).state, "timed_out");
  assert.ok(state.readEvents(run.task.id).events.some((event) => event.type === "time_limit_reached" && event.maxMinutes === 90));
  const startup = state.readJson(state.taskPath(run.task.id, "fixture.json"));
  assert.equal(startup.subagentLimit, "8");
  assert.ok(startup.args.includes("bypassPermissions"));
});

test("实际桥接器默认 120 主轮预算，子代理结束不计主轮且上限 20 传入进程", async () => {
  const run = await start({ turnsUsed: 119, subagentLimit: 20 });
  state.appendEvent(run.task.id, { type: "Stop", agentId: "子代理" });
  await delay(400);
  assert.equal(state.readTask(run.task.id).turnsUsed, 119);
  state.appendEvent(run.task.id, { type: "Stop", agentId: null });
  await finish(run);
  assert.equal(state.readTask(run.task.id).turnsUsed, 120);
  assert.equal(state.readTask(run.task.id).state, "timed_out");
  assert.equal(state.readJson(state.taskPath(run.task.id, "fixture.json")).subagentLimit, "20");
});

test("实际桥接器 API 失败保留错误并停止自动派发，取消可正常收尾", async () => {
  const run = await start({ initialPrompt: "夹具初始指令" });
  try {
    await delay(900);
    state.appendEvent(run.task.id, { type: "StopFailure", agentId: null, error: "rate_limit" });
    await delay(400);
    assert.equal(state.readRuntime(run.task.id).failure.error, "rate_limit");
    const response = await control(run.task.id, { type: "send", prompt: "失败后的待发指令" });
    assert.equal(response.ok, true);
    assert.equal(state.readRuntime(run.task.id).current, null);
    assert.equal(state.readRuntime(run.task.id).queue.length, 1);
    await control(run.task.id, { type: "cancel" });
    await finish(run);
    assert.equal(state.readTask(run.task.id).state, "cancelled");
  } finally { if (run.child.exitCode === null) run.child.kill(); }
});
