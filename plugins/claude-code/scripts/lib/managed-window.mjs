import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MANAGED_ROOT, taskPath } from "./managed-state.mjs";
import { shellQuote } from "./平台适配.mjs";

const TERMINAL = fileURLToPath(new URL("../managed-terminal.mjs", import.meta.url));

export function launchVisibleWindow(task) {
  if (process.platform === "darwin") {
    const command = `CC_PLUGIN_CODEX_MANAGED_DIR=${shellQuote(MANAGED_ROOT)} ${shellQuote(process.execPath)} ${shellQuote(TERMINAL)} ${shellQuote(task.id)}; exit`;
    try {
      execFileSync("/usr/bin/osascript", ["-e", `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`],
        { timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
      return { requested: true, provider: "macOS Terminal", connectionConfirmed: false };
    } catch { throw new Error("无法打开 macOS Terminal；请检查自动化授权。后台任务保留，可再次打开或手动连接"); }
  }
  if (process.platform !== "win32") return { requested: false, command: `CC_PLUGIN_CODEX_MANAGED_DIR=${shellQuote(MANAGED_ROOT)} ${shellQuote(process.execPath)} ${shellQuote(TERMINAL)} ${shellQuote(task.id)}` };
  const file = taskPath(task.id, "open-terminal.ps1");
  const escape = (value) => String(value).replaceAll("'", "''");
  fs.writeFileSync(file, `$env:CC_PLUGIN_CODEX_MANAGED_DIR = '${escape(MANAGED_ROOT)}'\n& '${escape(process.execPath)}' '${escape(TERMINAL)}' '${escape(task.id)}'\nexit $LASTEXITCODE\n`, "utf8");
  const child = spawn("wt.exe", ["new-tab", "pwsh.exe", "-NoProfile", "-File", file], {
    detached: true, windowsHide: true, stdio: "ignore"
  });
  child.unref();
  return { requested: true, pid: child.pid, script: file };
}
