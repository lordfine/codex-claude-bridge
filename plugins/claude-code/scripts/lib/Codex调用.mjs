import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { executable } from "./平台适配.mjs";
import { safeDiagnosticText } from "./续接诊断.mjs";

export function codexCommand() {
  if (process.platform !== "win32") return { command: executable("codex"), prefix: [] };
  const source = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); (Get-Command codex -ErrorAction Stop).Source"],
    { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
  if (/\.exe$/i.test(source)) return { command: source, prefix: [] };
  const entry = path.join(path.dirname(source), "node_modules", "@openai", "codex", "bin", "codex.js");
  if (fs.existsSync(entry)) return { command: process.execPath, prefix: [entry] };
  throw new Error("找不到可直接调用的 Codex CLI，请安装官方 CLI 或检查 PATH");
}

export function spawnCodex(args, options = {}) {
  const cli = options.cli || codexCommand();
  return spawn(cli.command, [...cli.prefix, ...args], { cwd: options.cwd,
    env: options.env || process.env, windowsHide: true, detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"] });
}

export function stopOwnedCodex(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore", timeout: 5000 }); } catch {}
  } else { try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); } }
}

export async function runCodex(args, prompt, options = {}) {
  const child = spawnCodex(args, options);
  let buffer = "", threadId = null, message = "", usage = null, failed = false, timedOut = false, lastEventType = null, stderr = "";
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, threadId, message, usage, failed,
      diagnostic: { started: Boolean(child.pid), exitCode: code, signal, timedOut, protocolFailed: failed, lastEventType, stderrExcerpt: safeDiagnosticText(stderr, 2000) || null } }));
  });
  child.stdout.setEncoding("utf8");
  child.stdin.on("error", () => { failed = true; stopOwnedCodex(child); });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (part) => { stderr = (stderr + part).slice(-16000); }); // 只把最终脱敏摘要写入诊断，不落原始日志。
  child.stdout.on("data", (part) => {
    buffer += part;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      lastEventType = event.type || null;
      if (event.type === "thread.started") threadId = event.thread_id;
      if (event.type === "item.completed" && event.item?.type === "agent_message") message = event.item.text;
      if (event.type === "turn.completed") usage = event.usage;
      if (["error", "turn.failed"].includes(event.type)) failed = true;
      try { options.onEvent?.(event, child); } catch { failed = true; stopOwnedCodex(child); }
    }
    if (buffer.length > 2_000_000) { failed = true; stopOwnedCodex(child); }
  });
  try { options.onSpawn?.(child); } catch (error) { stopOwnedCodex(child); throw error; }
  child.stdin.end(prompt);
  const timer = setTimeout(() => { timedOut = true; stopOwnedCodex(child); }, options.timeoutMs || 120000);
  try { return await completed; } finally { clearTimeout(timer); stopOwnedCodex(child); }
}
