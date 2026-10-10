#!/usr/bin/env node
// MCP 标准输入输出入口。Claude 执行进程由独立桥接器持有。
import process from "node:process";
import fs from "node:fs";
import { checkManagedReadiness } from "./lib/managed-readiness.mjs";
import {
  createManagedTask, createReviewTask, listManagedTasks, managedStatus, managedTranscript, control, waitManaged,
  pendingPermissions, decidePermission, openVisibleWindow, setConcurrencyLimit, cancelManaged,
  managedDiff, mergeManaged, waitManyManaged
} from "./lib/managed-service.mjs";
import { projectModels } from "./lib/managed-preferences.mjs";
import { managedWorkflow } from "./lib/managed-workflow.mjs";
import { manageTasks } from "./lib/managed-management.mjs";
import { sessionTools } from "./lib/managed-sessions.mjs";
import { wakeControl } from "./lib/事件续接.mjs";
import { orcaSessions } from "./lib/Orca会话.mjs";

import { TOOLS } from "./lib/工具定义.mjs";
import { coordinationControl } from "./lib/协作策略.mjs";
import { readHistory } from "./lib/会话读取.mjs";
import { overview, compactObservation } from "./lib/进度摘要.mjs";
import { statusResponse } from "./lib/状态响应.mjs";

const SERVER_NAME = "claude-code";
const SERVER_VERSION = JSON.parse(fs.readFileSync(new URL("../.codex-plugin/plugin.json", import.meta.url), "utf8")).version;
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const cancelled = new Set();
const active = new Set();
function log(message) { process.stderr.write("[claude-code-mcp] " + message + "\n"); }
function send(message) { try { process.stdout.write(JSON.stringify(message) + "\n"); } catch { log("响应输出失败"); } }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }
function managedResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function handleManagedCreate(args) {
  const created = createManagedTask(args);
  return managedResult({ ...created, window: args.visible === false ? "disabled" : "opens_when_started",
    initialPrompt: args.prompt ? "passed_to_claude_startup" : null });
}

async function handleManagedReview(args) {
  const created = createReviewTask(args.task_id, args);
  return managedResult({ ...created, window: args.visible === false ? "disabled" : "opens_when_started" });
}


async function handleSetup(args) { return managedResult({ ...checkManagedReadiness({ deep: Boolean(args?.deep) }), service: { version: SERVER_VERSION, pid: process.pid,
  executorReport: { protocol: 1, mcp: true, cli: true, receipt: true, durablePerReport: true }, scheduling: { default: "event_driven", activeGoalExternalWait: "unverified", perEventResults: true, preparedReports: true }, iterationEvidence: { skill: "bridge-retrospective", localOnly: true }, typedStatusCursor: true,
  wakeActions: TOOLS.find((t) => t.name === "delegate_wake").inputSchema.properties.action.enum, orcaActions: TOOLS.find((t) => t.name === "delegate_orca").inputSchema.properties.action.enum } }); }

async function handleMessage(message) {
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) {
    if (method === "notifications/cancelled" && active.has(params?.requestId)) cancelled.add(params.requestId);
    return;
  }
  if (method === "initialize") {
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : null;
    reply(id, { protocolVersion: requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } });
    return;
  }
  if (method === "ping") { reply(id, {}); return; }
  if (method === "tools/list") { reply(id, { tools: TOOLS }); return; }
  if (method !== "tools/call") { replyError(id, -32601, "未知 MCP 方法：" + method); return; }
      const handlers = {
        setup: handleSetup,
        delegate_create: handleManagedCreate,
        delegate_list: (args) => managedResult(listManagedTasks(args.controller_id, args.include_archived)),
        delegate_status: (args) => managedResult(statusResponse(managedStatus(args.task_id, args.controller_id, args.cursor, args.limit))),
        delegate_transcript: (args) => managedResult(managedTranscript(args.task_id, args.controller_id, args.max_chars, args.cursor)),
        delegate_wait: async (args) => managedResult(statusResponse(await waitManaged(args.task_id, args.cursor, args.seconds, args.controller_id))),
        delegate_send: async (args) => managedResult(await control(args.task_id, { type: "send", prompt: args.prompt }, args.controller_id)),
        delegate_takeover: async (args) => managedResult(await control(args.task_id, { type: "takeover", immediate: args.immediate }, args.controller_id)),
        delegate_permissions: (args) => managedResult(args.decision_id && args.decision
          ? decidePermission(args.task_id, args.decision_id, args.decision, args.reason, args.controller_id)
          : pendingPermissions(args.task_id, args.controller_id, args.decision_id)),
        delegate_open: (args) => managedResult(openVisibleWindow(args.task_id, args.controller_id)),
        delegate_limit: (args) => managedResult(setConcurrencyLimit(args.limit, args.controller_id)),
        delegate_cancel: async (args) => managedResult(await cancelManaged(args.task_id, args.controller_id)),
        delegate_review: handleManagedReview,
        delegate_diff: (args) => managedResult(managedDiff(args.task_id, args.controller_id)),
        delegate_merge: async (args) => managedResult(await mergeManaged(args.task_id, args.review_id, args.verification, args.controller_id)),
        delegate_wait_many: async (args) => managedResult(await waitManyManaged(args.targets, args.seconds, args.controller_id)),
        delegate_models: (args) => managedResult(projectModels(args.cwd,
          Object.fromEntries(["implementation", "review"].filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]])))),
        delegate_workflow: async (args) => managedResult(await managedWorkflow(args)),
        delegate_manage: async (args) => managedResult(await manageTasks(args)),
        delegate_sessions: (args) => managedResult(sessionTools(args)),
        delegate_wake: async (args) => managedResult(await wakeControl(args)),
        delegate_orca: async (args) => managedResult(await orcaSessions(args)),
        delegate_coordination: (args) => managedResult(coordinationControl(args)),
        delegate_history: (args) => managedResult(readHistory(args)),
        delegate_overview: (args) => managedResult(overview(args))
      };

  const handler = Object.hasOwn(handlers, params?.name) && handlers[params.name];
  if (!handler) { replyError(id, -32602, "未知工具：" + params?.name); return; }
  active.add(id);
  try {
    const args = params?.arguments ?? {};
    const result = await compactObservation(params.name, args, () => handler(args));
    if (!cancelled.has(id)) reply(id, result);
  } catch (error) {
    if (!cancelled.has(id)) reply(id, { content: [{ type: "text", text: JSON.stringify({ error: { code: error.code || "TOOL_ERROR", message: error?.message ?? String(error), ...error.details } }) }], isError: true });
  } finally { active.delete(id); cancelled.delete(id); }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message; try { message = JSON.parse(line); } catch { log("忽略无法解析的协议行"); continue; }
    // 等待工具不阻塞读取后续请求。取消请求停止回传，不取消已托管的 Claude 任务。
    Promise.resolve(handleMessage(message)).catch(() => log("请求处理异常"));
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGHUP", () => process.exit(0));
process.on("SIGINT", () => log("忽略终端中断；会话生命周期由宿主控制"));
process.stdout.on("error", () => log("标准输出连接异常"));
process.on("uncaughtException", () => log("未捕获异常，请检查任务状态"));
process.on("unhandledRejection", () => log("异步请求异常，请检查任务状态"));
