import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

export const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
export function trustConfirmationKey(screen) {
  const plain = screen.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  if (!plain.includes("Quick safety check: Is this a project you created or one you trust?")) return null;
  const selected = /[❯>]\s*(?:\d+[.)]\s*)?(Yes, I trust this folder|No, exit)/.exec(plain);
  return selected ? selected[1].startsWith("Yes") ? "\r" : "\x1b[A\r" : null;
}
const commands = new Map();
export function executable(name) {
  if (process.platform === "win32") return name;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("命令名称无效");
  const cached = commands.get(name); if (cached && fs.existsSync(cached)) return cached;
  const dirs = [...(process.env.PATH || "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
  for (const dir of dirs) { const file = path.join(dir, name); try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) { commands.set(name, file); return file; } } catch {} }
  try {
    const shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
    const value = execFileSync(shell, ["-lc", `command -v ${name}`], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!path.isAbsolute(value) || value.includes("\n")) throw new Error();
    fs.accessSync(value, fs.constants.X_OK); commands.set(name, value); return value;
  } catch { throw new Error(`找不到 ${name} 可执行文件，请先安装并检查登录 shell 的 PATH`); }
}

export function sessionProcessRunning(sessionId, { platform = process.platform, run = execFileSync } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return true;
  try {
    if (platform === "win32") {
      const query = `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter "Name='claude.exe' OR Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -match '--(?:resume|session-id)\\s+[\"\\x27]?${sessionId}(?:[\"\\x27]|\\s|$)' } | Measure-Object).Count`;
      const value = String(run("powershell.exe", ["-NoProfile", "-Command", query], { encoding: "utf8", windowsHide: true, timeout: 15000, stdio: ["ignore", "pipe", "pipe"] })).trim();
      return !/^\d+$/.test(value) || Number(value) > 0;
    }
    const output = String(run("/bin/ps", ["-axo", "pid=,args="], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4_000_000 }));
    const marker = new RegExp(`--(?:resume|session-id)\\s+["']?${sessionId}(?:["']|\\s|$)`, "i");
    return output.split("\n").some((line) => { const row = /^\s*(\d+)\s+(.+)$/.exec(line); return row && Number(row[1]) !== process.pid && marker.test(row[2]); });
  } catch { return true; }
}

export function ipcEndpoints(id) {
  const key = crypto.createHash("sha256").update(`${os.homedir()}:${id}`).digest("hex").slice(0, 20);
  if (process.platform === "win32") return { terminal: `\\\\.\\pipe\\ccpc-${key}-terminal`, control: `\\\\.\\pipe\\ccpc-${key}-control` };
  // macOS 的 Unix socket 长度有限；私有短目录避免长 TMPDIR 和其他用户访问。
  const dir = fs.mkdtempSync(path.join("/tmp", "ccb-")); fs.chmodSync(dir, 0o700);
  const result = { terminal: path.join(dir, "t.sock"), control: path.join(dir, "c.sock"), directory: dir };
  for (const file of [result.terminal, result.control]) if (Buffer.byteLength(file) > 100) throw new Error("终端通信路径超过平台长度限制");
  return result;
}

export function orcaLaunch(sessionId, model, platform = process.platform) {
  const quote = platform === "win32" ? (s) => `'${String(s).replaceAll("'", "''")}'` : shellQuote;
  return { shell: platform === "win32" ? "pwsh.exe" : "/bin/zsh", command: `${platform === "win32" ? "claude" : quote(executable("claude"))} --session-id ${quote(sessionId)}${model ? ` --model ${quote(model)}` : ""}` };
}
