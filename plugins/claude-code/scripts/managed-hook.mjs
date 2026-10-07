#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { appendEvent, claudeSettingsPath, fingerprint, readJson, readTask, taskDir, writeJson } from "./lib/managed-state.mjs";
import { classifyPermission } from "./lib/managed-permission.mjs";

const taskId = process.env.CC_PLUGIN_CODEX_TASK_ID;
if (!taskId) process.exit(0);

let source = "";
for await (const chunk of process.stdin) source += chunk;
let request;
try { request = JSON.parse(source); }
catch { process.exit(1); }

const task = readTask(taskId);
if (!task) process.exit(1);

const base = {
  type: request.hook_event_name,
  sessionId: request.session_id || task.sessionId,
  promptId: request.prompt_id || null,
  agentId: request.agent_id || null,
  tool: request.tool_name || null,
  ...(request.hook_event_name === "StopFailure" ? { error: request.error || "unknown" } : {}),
  ...(request.hook_event_name === "Notification" ? { notificationType: request.notification_type || null } : {}),
  ...(["Stop", "SubagentStop"].includes(request.hook_event_name) && Array.isArray(request.background_tasks)
    ? { backgroundTasks: request.background_tasks.map((item) => ({ id: item.id, type: item.type, status: item.status })) }
    : {}),
  ...(["SubagentStart", "SubagentStop"].includes(request.hook_event_name)
    ? { agentType: request.agent_type || null } : {})
};

if (request.hook_event_name === "UserPromptExpansion" && request.command_name === "交还") {
  appendEvent(taskId, { ...base, type: "handback" });
  process.stdout.write(JSON.stringify({ decision: "block", reason: "控制权已交还 Codex" }));
  process.exit(0);
}

if (request.hook_event_name === "UserPromptSubmit") {
  const promptHash = crypto.createHash("sha256").update(String(request.prompt || "")).digest("hex");
  appendEvent(taskId, { ...base, promptHash });
  process.exit(0);
}

if (request.hook_event_name !== "PermissionRequest") {
  appendEvent(taskId, request.hook_event_name === "Notification" && request.notification_type === "agent_needs_input"
    ? { ...base, type: "needs_input" } : base);
  process.exit(0);
}

if (task.configFingerprint && fingerprint(claudeSettingsPath()) !== task.configFingerprint) {
  appendEvent(taskId, { ...base, type: "config_changed" });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "Claude Code 配置已变化，任务已暂停等待 Codex 检查" }
    }
  }));
  process.exit(0);
}

const classification = classifyPermission(request, task);
appendEvent(taskId, { ...base, type: "permission_checked", kind: classification.kind, reason: classification.reason });

if (classification.kind === "allow" || classification.kind === "deny") {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: classification.kind,
        ...(classification.kind === "deny" ? { message: classification.reason } : {})
      }
    }
  }));
  process.exit(0);
}

const decisionId = crypto.randomUUID();
const pendingFile = path.join(taskDir(taskId), "pending", `${decisionId}.json`);
const answerFile = path.join(taskDir(taskId), "decisions", `${decisionId}.json`);
const input = request.tool_input || {};
writeJson(pendingFile, {
  id: decisionId,
  taskId,
  kind: classification.kind,
  reason: classification.reason,
  tool: request.tool_name,
  promptId: request.prompt_id || null,
  agentId: request.agent_id || null,
  command: typeof input.command === "string" ? input.command.slice(0, 4000) : null,
  path: input.file_path || input.path || null,
  createdAt: new Date().toISOString()
});
appendEvent(taskId, { ...base, type: "permission_pending", decisionId, kind: classification.kind });

const configuredWait = Number(process.env.CC_PLUGIN_CODEX_PERMISSION_WAIT_MS);
const waitMs = Number.isFinite(configuredWait) && configuredWait > 0
  ? Math.min(30000, Math.max(100, configuredWait)) : 30000;
const deadline = Date.now() + waitMs;
while (Date.now() < deadline) {
  const answer = readJson(answerFile);
  if (answer && answer.id === decisionId && ["allow", "deny"].includes(answer.decision)) {
    try { fs.unlinkSync(answerFile); } catch { /* 决定已经读取。 */ }
    if (classification.kind === "user" && answer.decision === "allow") break;
    try { fs.unlinkSync(pendingFile); } catch { /* 状态文件可能已经清理。 */ }
    appendEvent(taskId, { type: "permission_decided", decisionId, decision: answer.decision, actor: "codex" });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: answer.decision,
          ...(answer.decision === "deny" ? { message: answer.reason || "Codex 拒绝本次工具调用" } : {})
        }
      }
    }));
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// 没有决定时让 Claude Code 保持原生人工权限提示，不主动批准。
appendEvent(taskId, { type: "permission_to_human", decisionId });
try { fs.unlinkSync(pendingFile); } catch { /* 状态文件可能已经清理。 */ }
