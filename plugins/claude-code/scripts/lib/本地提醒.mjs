import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeWakeJson, readWakeJson } from "./事件队列.mjs";
import { redactText } from "./会话读取.mjs";

export function attentionNotice(folder, run) {
  const file = path.join(folder, "attention.json"), old = readWakeJson(file);
  if (old?.runId === run.id) return false;
  const notice = { runId: run.id, reason: redactText(run.summary || "续接需要处理"), at: new Date().toISOString(),
    diagnostic: run.diagnostic || null, targets: (run.events || []).map((e) => ({ taskId: e.taskId, decisionId: e.decisionId || null })) };
  writeWakeJson(file, notice);
  fs.writeFileSync(path.join(folder, "需要处理.md"), `# Claude 协作需要处理\n\n${notice.reason}\n\n运行编号：${run.id}\n\n请在 Codex 查询 delegate_wake inspect，再决定确认或重试。\n`, "utf8");
  if (process.env.CC_PLUGIN_CODEX_DISABLE_NOTIFICATIONS === "1") return true;
  let child;
  if (process.platform === "darwin") child = spawn("/usr/bin/osascript", ["-e", 'display notification "事件续接已暂停，请在 Codex 查看诊断与待办" with title "Claude 协作需要处理"'], { stdio: "ignore" });
  if (process.platform === "win32") {
    const script = path.join(folder, "需要处理提醒.ps1");
    fs.writeFileSync(script, 'Add-Type -AssemblyName System.Windows.Forms\n$n=New-Object System.Windows.Forms.NotifyIcon\n$n.Icon=[System.Drawing.SystemIcons]::Warning\n$n.Visible=$true\n$n.ShowBalloonTip(5000,"Claude 协作需要处理","事件续接已暂停，请在 Codex 查看诊断与待办",[System.Windows.Forms.ToolTipIcon]::Warning)\nStart-Sleep -Seconds 6\n$n.Dispose()\n', "utf8");
    child = spawn("powershell.exe", ["-NoProfile", "-File", script], { windowsHide: true, stdio: "ignore" });
  }
  if (child) { child.on("error", () => {}); child.unref(); }
  return true;
}
