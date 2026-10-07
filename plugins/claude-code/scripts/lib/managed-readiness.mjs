import os from "node:os";
import { spawnSync } from "node:child_process";

import { configuredModels } from "./managed-state.mjs";
import { ensurePtyRuntime } from "./managed-runtime.mjs";

function claudeCommand(args, options = {}) {
  const command = process.platform === "win32" ? "cmd.exe" : "claude";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "claude.cmd", ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: os.tmpdir(), encoding: "utf8", windowsHide: true, timeout: 30_000,
    maxBuffer: 1024 * 1024, ...options
  });
  return { ok: result.status === 0 && !result.error,
    output: String(result.stdout || "").trim(),
    error: result.error?.message || String(result.stderr || "").trim() || null };
}

export function checkManagedReadiness({ deep = false } = {}) {
  const claude = claudeCommand(["--version"]);
  let terminal;
  try { terminal = ensurePtyRuntime(); }
  catch (error) { terminal = { ready: false, error: error.message }; }
  const models = configuredModels();
  let login = { verified: false, detail: "未验证；创建任务时沿用当前 Claude Code／CCswitch 配置" };
  if (deep && claude.ok) {
    const probe = claudeCommand(["-p", "只回复 OK"], { input: "", timeout: 60_000 });
    login = probe.ok && /\bOK\b/i.test(probe.output)
      ? { verified: true, detail: "已通过一次真实 Claude 回复验证" }
      : { verified: false, detail: `深度验证未通过：${probe.error || probe.output.slice(0, 160) || "无回复"}` };
  }
  return {
    ready: claude.ok && terminal.ready && (!deep || login.verified),
    platform: process.platform,
    node: process.version,
    claude: { available: claude.ok, version: claude.output.split(/\r?\n/)[0] || null,
      error: claude.ok ? null : claude.error || "无法执行 claude --version" },
    terminal,
    models,
    login
  };
}
