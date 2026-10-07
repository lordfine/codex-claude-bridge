import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const plugin = path.resolve(process.argv[2] || "plugins/claude-code");
const manifest = JSON.parse(fs.readFileSync(path.join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-installed-check-"));
const child = spawn(process.execPath, [path.join(plugin, "scripts", "claude-mcp-server.mjs")], {
  cwd: plugin, env: { ...process.env, CC_PLUGIN_CODEX_MANAGED_DIR: state, CODEX_THREAD_ID: "安装接口验证" },
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true
});
let sequence = 0, buffer = "", stderr = "";
const pending = new Map();
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    const callback = pending.get(message.id);
    if (callback) { clearTimeout(callback.timer); pending.delete(message.id); callback.resolve(message); }
  }
});
child.on("exit", () => {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error(`服务退出：${stderr}`)); }
  pending.clear();
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`请求超时：${method}`)); }, 60_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function call(name, args) {
  const response = await rpc("tools/call", { name, arguments: args });
  if (response.error || response.result?.isError) throw new Error(JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}
try {
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {},
    clientInfo: { name: "安装验证", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  if (initialized.result.serverInfo.version !== manifest.version) throw new Error("协议版本与安装清单不符");
  const tools = await rpc("tools/list", {});
  const required = ["delegate_workflow", "delegate_wait_many", "delegate_models", "delegate_manage", "delegate_sessions", "delegate_wake", "delegate_orca"];
  for (const name of required) {
    if (!tools.result.tools.some((tool) => tool.name === name)) throw new Error(`缺少工具 ${name}`);
  }
  const setup = await call("setup", { deep: false });
  if (!setup.ready) throw new Error("准备检查未通过");
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const created = await call("delegate_workflow", { action: "create", cwd, goal: "安装接口检查，不派发模型任务", request_id: "安装创建" });
  const restored = await call("delegate_workflow", { action: "status", workflow_id: created.id });
  if (restored.id !== created.id || restored.stage !== "planning") throw new Error("流程状态读取不一致");
  if (required.includes("delegate_manage")) {
    const managed = await call("delegate_manage", { action: "list" });
    const sessions = await call("delegate_sessions", { action: "list", cwd });
    if (!Array.isArray(managed.tasks) || !Array.isArray(sessions.sessions)) throw new Error("管理或会话选择入口异常");
  }
  if (required.includes("delegate_wake")) {
    const wake = await call("delegate_wake", { action: "status" });
    if (wake.enabled !== false || wake.pending !== 0) throw new Error("未配置的自动续接状态异常");
  }
  process.stdout.write(JSON.stringify({ 版本: manifest.version, 工具数: tools.result.tools.length,
    接口检查: "工作流、会话管理、事件续接及 Orca 会话", 准备检查: setup.ready, 状态恢复: true, 模型调用: 0 }) + "\n");
} finally { child.stdin.end(); }
