import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeWakeJson, readWakeJson } from "./事件队列.mjs";
import { safeDiagnosticText } from "./续接诊断.mjs";

export function writeWindowsNoticeScript(folder) {
  const script = path.join(folder, "需要处理提醒.ps1");
  // 仅该 Windows PowerShell 5.1 脚本使用 UTF-8 BOM；所有 JSON 继续无 BOM。
  const body = 'Add-Type -AssemblyName System.Windows.Forms\n$n=New-Object System.Windows.Forms.NotifyIcon\n$n.Icon=[System.Drawing.SystemIcons]::Warning\n$n.Visible=$true\n$n.add_BalloonTipShown({[Console]::Out.WriteLine("NOTICE_SHOWN")})\n$n.ShowBalloonTip(5000,"Claude 协作需要处理","自动续接出现故障，请在 Codex 查看最新诊断",[System.Windows.Forms.ToolTipIcon]::Warning)\n$until=[DateTime]::UtcNow.AddSeconds(6)\nwhile([DateTime]::UtcNow -lt $until){[System.Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 100}\n$n.Dispose()\n';
  fs.writeFileSync(script, "\uFEFF" + body, "utf8"); return script;
}

export function attentionNotice(folder, run, options = {}) {
  const file = path.join(folder, "attention.json"), old = readWakeJson(file), key = run.faultId || run.id;
  if (!/^[0-9a-f-]{36}$/i.test(key || "")) throw new Error("提醒需要精确故障或运行编号");
  if (old?.noticeId === key || !old?.noticeId && old?.runId === key) return false;
  const notice = { noticeId: key, runId: run.faultId ? null : run.id, faultId: run.faultId || null, source: run.source || "cli",
    reason: safeDiagnosticText(run.summary || "续接需要处理"), at: new Date().toISOString(), diagnostic: run.diagnostic || null,
    targets: (run.events || []).map((e) => ({ taskId: e.taskId, decisionId: e.decisionId || null })), notification: { state: "preparing", userSeenConfirmed: false } };
  const receiptFile = path.join(folder, "notification-receipts", `${key}.json`);
  const receipt = (update) => {
    try {
    notice.notification = { ...notice.notification, ...update, updatedAt: new Date().toISOString() };
    writeWakeJson(receiptFile, notice.notification);
    if (readWakeJson(file)?.noticeId === key) writeWakeJson(file, notice);
    } catch (error) { process.stderr.write(JSON.stringify({ type: "notification_receipt_failed", code: /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : null }) + "\n"); }
  };
  writeWakeJson(file, notice);
  fs.writeFileSync(path.join(folder, "需要处理.md"), `# Claude 协作需要处理\n\n${notice.reason}\n\n来源：${notice.source}\n故障／运行编号：${key}\n发生时间：${notice.at}\n\n调度故障用 delegate_wake diagnose；CLI运行用 inspect。通知尝试不代表用户已看到。\n`, "utf8");
  if (process.env.CC_PLUGIN_CODEX_DISABLE_NOTIFICATIONS === "1") { receipt({ state: "disabled" }); return true; }
  let child;
  try {
    const start = options.spawn || spawn;
    if (process.platform === "darwin") child = start("/usr/bin/osascript", ["-e", 'display notification "自动续接出现故障，请在 Codex 查看最新诊断" with title "Claude 协作需要处理"'], { stdio: ["ignore", "pipe", "pipe"] });
    if (process.platform === "win32") child = start("powershell.exe", ["-NoProfile", "-File", writeWindowsNoticeScript(folder)], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (!child) { receipt({ state: "unsupported" }); return true; }
    receipt({ state: "requested", pid: child.pid || null }); let stderr = "";
    child.stdout?.on("data", (s) => { if (String(s).includes("NOTICE_SHOWN")) receipt({ state: "shown_by_os", osReportedShown: true }); });
    child.stderr?.on("data", (s) => { stderr = safeDiagnosticText(stderr + String(s), 1000); });
    child.on("error", (error) => receipt({ state: "failed", error: safeDiagnosticText(error.message), code: error.code || null }));
    child.on("close", (code, signal) => receipt({ state: code === 0 ? notice.notification.osReportedShown ? "shown_by_os" : "sent_unconfirmed" : "failed", exitCode: code, signal, error: stderr || notice.notification.error || null }));
    child.unref();
  } catch (error) { receipt({ state: "failed", error: safeDiagnosticText(error.message) }); }
  return true;
}
