// 用户主动运行的隔离验收：一个真实 Claude 回复，有少量模型用量。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { startServer, initialized } from "../tests/helpers.mjs";
if (!process.argv.includes("--确认运行")) {
  process.stdout.write("此脚本在临时仓库新建自己的 Claude 可见窗口，验证一次真实回复和窗口连接，然后停止自己的任务。\n会消耗少量当前模型用量，不操作既有会话。运行：node scripts/实机验收.mjs --确认运行\n"); process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-live-")), cwd = path.join(root, "中文 空格仓库"), controller = `验收-${crypto.randomUUID()}`;
fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, "说明.md"), "# 隔离通信验收\n", "utf8");
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
git("init"); git("add", "."); git("-c", "user.name=验收", "-c", "user.email=check@example.invalid", "commit", "-m", "准备隔离验收");
const server = startServer({ ...process.env, CODEX_THREAD_ID: controller, CC_PLUGIN_CODEX_MANAGED_DIR: path.join(root, "状态") });
const result = { date: new Date().toISOString(), platform: process.platform, architecture: process.arch, originalWorkspacesTouched: false, report: path.join(root, "实机验收结果.json") };
let task;
async function call(name, args) {
  const r = await server.rpc("tools/call", { name, arguments: { ...args, controller_id: controller } }, 60000);
  if (r.error || r.result.isError) throw new Error("验收工具返回错误，请查看临时任务记录");
  return JSON.parse(r.result.content[0].text);
}
try {
  await initialized(server); const setup = await call("setup", { deep: false }); if (!setup.ready) throw new Error("环境准备未通过");
  task = await call("delegate_create", { cwd, visible: true, prompt: "这是隔离通信验证。不要调用工具，不修改文件。只回复：平台实机确认。", process_docs: false });
  fs.writeFileSync(path.join(root, "验收启动.json"), JSON.stringify({ taskId: task.id, managed: path.join(root, "状态") }), "utf8");
  const deadline = Date.now() + 150000; let status, body;
  do {
    status = await call("delegate_status", { task_id: task.id, force: true });
    body = await call("delegate_transcript", { task_id: task.id, max_chars: 2000 });
    if (JSON.stringify(body).includes("平台实机确认") && status.task.state === "idle") break;
    if (["failed", "paused", "timed_out"].includes(status.task.state)) throw new Error("测试任务异常，保留状态供核对");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  result.replyConfirmed = JSON.stringify(body).includes("平台实机确认"); result.terminalConnected = Boolean(status.task.visible);
  result.taskId = task.id; result.sessionId = task.sessionId; result.timeLimit = task.maxMinutes || 0;
  if (!result.replyConfirmed || !result.terminalConnected) throw new Error("回复或可见终端连接未确认，需检查首次授权及窗口");
  result.outcome = "reply_and_connection_verified";
  result.guiAppearance = "仍需用户确认中文、对齐与窗口显示";
} catch (error) { result.outcome = "needs_attention"; result.reason = error.message; process.exitCode = 1; }
finally {
  if (task) {
    try {
      await call("delegate_cancel", { task_id: task.id });
      const until = Date.now() + 15000;
      do { const s = await call("delegate_status", { task_id: task.id, force: true }); if (s.task.state === "cancelled") { result.ownedTaskStopped = true; break; } await new Promise((r) => setTimeout(r, 300)); } while (Date.now() < until);
    } catch { result.ownedTaskStopped = false; }
  }
  server.stop(); fs.writeFileSync(result.report, JSON.stringify(result, null, 2), "utf8"); process.stdout.write(JSON.stringify(result) + "\n");
}
