import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MANAGED_ROOT, taskPath } from "./managed-state.mjs";

const TERMINAL = fileURLToPath(new URL("../managed-terminal.mjs", import.meta.url));

export function launchVisibleWindow(task) {
  if (process.platform !== "win32") return { command: `${process.execPath} ${TERMINAL} ${task.id}` };
  const file = taskPath(task.id, "open-terminal.ps1");
  const escape = (value) => String(value).replaceAll("'", "''");
  fs.writeFileSync(file, `$env:CC_PLUGIN_CODEX_MANAGED_DIR = '${escape(MANAGED_ROOT)}'\n& '${escape(process.execPath)}' '${escape(TERMINAL)}' '${escape(task.id)}'\nexit $LASTEXITCODE\n`, "utf8");
  const child = spawn("wt.exe", ["new-tab", "pwsh.exe", "-NoProfile", "-File", file], {
    detached: true, windowsHide: true, stdio: "ignore"
  });
  child.unref();
  return { requested: true, pid: child.pid, script: file };
}
