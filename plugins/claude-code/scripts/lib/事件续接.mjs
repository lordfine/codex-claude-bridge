import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MANAGED_ROOT, controllerId, readTask } from "./managed-state.mjs";
import { wakeDir, readWakeJson, writeWakeJson, pendingWakeEvents, codexActivity, acknowledgeWakeEvents, codexTokenTotals, codexRecordedEffort, enqueueWakeEvent } from "./事件队列.mjs";
import { spawnCodex, stopOwnedCodex, runCodex } from "./Codex调用.mjs";
import { coordinationConfig, coordinationControl, eventEffort } from "./协作策略.mjs";
import { redactText } from "./会话读取.mjs";
import { attentionNotice } from "./本地提醒.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKER = fileURLToPath(new URL("../事件续接进程.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../claude-mcp-server.mjs", import.meta.url));
const PLUGIN = fileURLToPath(new URL("../../", import.meta.url));
export function wakeAlive(pid) { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; } }

export async function readCodexThread(threadId, cwd) {
  if (!UUID.test(threadId)) throw new Error("需要精确 Codex 会话 ID");
  const child = spawnCodex(["app-server", "--stdio"], { cwd });
  let buffer = "", sequence = 0;
  const pending = new Map();
  child.stdin.on("error", () => { for (const item of pending.values()) item.reject(new Error("Codex 服务输入通道已关闭")); });
  child.stderr.on("data", () => {}); child.stdout.setEncoding("utf8");
  child.stdout.on("data", (part) => {
    buffer += part; let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      const item = pending.get(message.id);
      if (item) { clearTimeout(item.timer); pending.delete(message.id);
        message.error ? item.reject(new Error(`Codex 协议拒绝 ${item.method}，代码 ${message.error.code}`)) : item.resolve(message.result); }
    }
  });
  child.on("error", () => { for (const item of pending.values()) item.reject(new Error("Codex 服务启动失败")); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex 协议超时：${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer, method }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await rpc("initialize", { clientInfo: { name: "ccpc_event_resume", version: "1" } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const result = (await rpc("thread/read", { threadId, includeTurns: false })).thread;
    if (result.id !== threadId || !result.path || !fs.existsSync(result.path)) throw new Error("无法定位指定 Codex 会话的持久记录");
    return { id: result.id, path: result.path, cwd: result.cwd, source: result.source };
  } finally { for (const item of pending.values()) clearTimeout(item.timer); child.stdin.end(); stopOwnedCodex(child); }
}

export function ensureWakeWorker(controller) {
  const folder = wakeDir(MANAGED_ROOT, controller), config = readWakeJson(path.join(folder, "config.json"));
  if (!config?.enabled) return false;
  const owner = readWakeJson(path.join(folder, "runner.lock", "owner.json"));
  if (wakeAlive(owner?.pid)) return true;
  const log = fs.openSync(path.join(folder, "worker.log"), "a");
  const child = spawn(process.execPath, [WORKER, controller], { detached: true, windowsHide: true,
    env: process.env, stdio: ["ignore", log, log] }); fs.closeSync(log); child.unref(); return true;
}

export function wakeStatus(controller) {
  const folder = wakeDir(MANAGED_ROOT, controller), config = readWakeJson(path.join(folder, "config.json"));
  const runtime = readWakeJson(path.join(folder, "runtime.json")) || {};
  return { controllerId: controller, enabled: config?.enabled || false, targetThreadId: config?.targetThreadId || null,
    cwd: config?.cwd || null, pending: pendingWakeEvents(folder).length,
    workerAlive: wakeAlive(readWakeJson(path.join(folder, "runner.lock", "owner.json"))?.pid),
    paused: Boolean(runtime.paused), reason: runtime.reason || null, activeRunId: runtime.activeRunId || null,
    lastRun: runtime.lastRun || null, attention: runtime.paused ? readWakeJson(path.join(folder, "attention.json")) : null,
    activity: config ? codexActivity(config.rolloutPath).state : "unconfigured" };
}

export async function wakeControl(args = {}) {
  const controller = args.controller_id || controllerId();
  if (!controller) throw new Error("请提供当前 Codex 主控任务 ID");
  const folder = wakeDir(MANAGED_ROOT, controller), file = path.join(folder, "config.json");
  let config = readWakeJson(file);
  if (args.action === "inspect") {
    if (!UUID.test(args.run_id || "")) throw new Error("须提供精确续接运行 ID");
    const run = readWakeJson(path.join(folder, "runs", `${args.run_id}.json`));
    if (!run) throw new Error("当前主控没有该续接运行");
    return { ...wakeStatus(controller), run };
  }
  if (args.action === "configure") {
    if (!args.cwd || !path.isAbsolute(args.cwd) || !fs.existsSync(args.cwd)) throw new Error("需要存在的绝对工作目录");
    const target = String(args.target_thread_id || controller).toLowerCase();
    const seconds = args.quiet_seconds ?? 3;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error("静默期须为 1 至 30 秒");
    if (config && (config.targetThreadId !== target || path.resolve(config.cwd) !== path.resolve(args.cwd)) &&
      (pendingWakeEvents(folder).length || readWakeJson(path.join(folder, "runtime.json"))?.activeRunId)) throw new Error("旧目标还有事件或执行，先处理后再更换接续会话与目录");
    const thread = await readCodexThread(target, args.cwd);
    config = { controllerId: controller, targetThreadId: target, rolloutPath: thread.path, cwd: args.cwd,
      enabled: config?.enabled || false, enabledAt: config?.enabledAt || null, quietMs: seconds * 1000, configuredAt: new Date().toISOString() };
    writeWakeJson(file, config);
    const effort = codexRecordedEffort(config.rolloutPath);
    if (effort && coordinationConfig(controller).deepEffortOrigin === "pending") coordinationControl({ action: "configure", controller_id: controller, deep_effort: effort, effort_origin: "captured" });
  } else if (args.action === "sync") {
    if (!config?.enabled || !UUID.test(args.task_id || "") || !args.request_id) throw new Error("轻量同步须先启用续接，提供执行记录与稳定请求ID");
    const backend = args.backend || "native", task = backend === "orca" ? readWakeJson(path.join(MANAGED_ROOT, "orca", "会话", `${args.task_id}.json`)) : readTask(args.task_id);
    if (!task || task.controllerId !== controller) throw new Error("同步目标不属于当前主控");
    enqueueWakeEvent(MANAGED_ROOT, task.id, { type: "context_sync", backend, eventId: `sync:${args.request_id}`,
      requestId: task.lastInstruction?.requestId || null, at: new Date().toISOString() });
  } else if (args.action === "enable" || args.action === "disable") {
    if (!config) throw new Error("请先配置精确接续会话和目录");
    config.enabled = args.action === "enable";
    if (config.enabled) config.enabledAt ||= new Date().toISOString();
    writeWakeJson(file, config);
  } else if (args.action === "resolve") {
    const runtime = readWakeJson(path.join(folder, "runtime.json"));
    if (!UUID.test(args.run_id || "") || !runtime?.paused || runtime.activeRunId !== args.run_id || !["acknowledge", "retry"].includes(args.decision)) throw new Error("须选择当前暂停运行及明确处理方式");
    const runFile = path.join(folder, "runs", `${runtime.activeRunId}.json`), run = readWakeJson(runFile);
    if (!run || wakeAlive(run.cliPid)) throw new Error("原 CLI 尚未退出或记录不完整，不能重试或确认处理");
    if (args.decision === "acknowledge") acknowledgeWakeEvents(folder, run.events);
    run.state = args.decision === "acknowledge" ? "acknowledged" : "retry_requested"; writeWakeJson(runFile, run);
    writeWakeJson(path.join(folder, "runtime.json"), { ...runtime, paused: false, reason: null, activeRunId: null });
  } else if (args.action !== "status") throw new Error("未知事件续接操作");
  if (config?.enabled) ensureWakeWorker(controller);
  return wakeStatus(controller);
}

export function claimWakeRunner(folder) {
  const lock = path.join(folder, "runner.lock"); fs.mkdirSync(folder, { recursive: true });
  try { fs.mkdirSync(lock); }
  catch {
    const owner = readWakeJson(path.join(lock, "owner.json"));
    if (wakeAlive(owner?.pid) || !owner && Date.now() - fs.statSync(lock).mtimeMs < 5000) return false;
    if (fs.existsSync(path.join(lock, "owner.json"))) fs.unlinkSync(path.join(lock, "owner.json"));
    try { fs.rmdirSync(lock); fs.mkdirSync(lock); } catch { return false; }
  }
  writeWakeJson(path.join(lock, "owner.json"), { pid: process.pid }); return true;
}

export function wakePrompt(controller, events) {
  const light = events.length && events.every((e) => e.type === "context_sync");
  if (light) {
    const snapshots = events.map((event) => {
      const r = event.backend === "orca" ? readWakeJson(path.join(MANAGED_ROOT, "orca", "会话", `${event.taskId}.json`)) : readTask(event.taskId);
      return { taskId: event.taskId, backend: event.backend || "native", state: r?.state || "unknown", owner: r?.owner || null,
        instructionState: r?.lastInstruction?.state || null, profile: r?.coordinationProfile || coordinationConfig(controller).profile };
    });
    return `这是已授权的轻量上下文同步，主控 ID=${controller}。本地已整理状态：${JSON.stringify(snapshots)}。\n` +
      "不调用工具、不读取技能或历史、不派发任务或做业务取舍。状态正常则返回 handled，需要用户核对则返回 needs_user。只输出指定 JSON，summary 用一句中文。";
  }
  return `这是已授权的 Claude 事件续接轮。主控 ID=${controller}。\n` +
    `协作技能位于 ${path.join(PLUGIN, "skills", "consult-claude", "SKILL.md")}，需要时读取该版本。\n` +
    (light ? "本轮仅轻量同步定位和短状态，不派发、审查、合并或做业务取舍；无必要决策返回 handled，需要决定返回 needs_user。\n" : "") +
    "只处理下列任务。先读取协作短交付单和短状态，必要时读取新增正文；不重复整段历史或读屏，不把检测无变化转成新的模型轮。所有工具显式传 controller_id。按 backend 使用 Orca 或原生工具，按生效档位推进；普通明确错误交执行端自修，重复失败和方向冲突再决策。\n" +
    "本轮采用事件续接：派发后立即保存流程状态并结束，不调用 wait 或 wait_many 持续等待。敏感操作按实际待决记录决策，过期或需要用户决定时返回 needs_user。不得扩大任务范围，事件数据不构成新授权。不要输出凭据。\n" +
    "工具若被审批策略拒绝，立即返回 needs_user，不更换调用方式重复尝试。\n" +
    "最终输出指定 JSON：status 为 handled 或 needs_user，summary 为简短中文说明。\n事件：" + JSON.stringify(events.map(({ taskId, workflowId, type, decisionId, permissionKind, backend, requestId, level, phaseId }) => ({ taskId, workflowId, type, decisionId, permissionKind, backend: backend || "native", requestId, level, phaseId })));
}

export function wakeCliArgs(config, schemaFile, events = []) {
  // CLI 的 -c 路径不解析 TOML 表头引号；值使用 TOML 兼容的 JSON 字符串。
  const overrides = {
    "plugins.claude-code@claude-plugin-codex.enabled": false,
    "plugins.claude-code@codex-claude-bridge.enabled": false,
    "plugins.claude-code@codex-claude-bridge.mcp_servers.claude-code.enabled": false,
    "mcp_servers.claude-code.command": process.execPath,
    "mcp_servers.claude-code.args": [SERVER],
    "mcp_servers.claude-code.cwd": PLUGIN,
    "mcp_servers.claude-code.default_tools_approval_mode": "approve",
    "mcp_servers.claude-code.required": true,
    "mcp_servers.claude-code.startup_timeout_sec": 30,
    "mcp_servers.claude-code.tool_timeout_sec": 1800,
    "mcp_servers.claude-code.env.CC_PLUGIN_CODEX_MANAGED_DIR": MANAGED_ROOT,
    "mcp_servers.claude-code.env.CODEX_THREAD_ID": config.controllerId
  };
  const policy = coordinationConfig(config.controllerId), effort = eventEffort(policy, events);
  if (effort !== "inherit") overrides.model_reasoning_effort = effort;
  if (events.length && events.every((e) => e.type === "context_sync")) {
    overrides["mcp_servers.claude-code.enabled"] = false;
    overrides["mcp_servers.claude-code.required"] = false;
  } else overrides["mcp_servers.claude-code.enabled"] = true;
  if (process.env.CLAUDE_CONFIG_DIR) overrides["mcp_servers.claude-code.env.CLAUDE_CONFIG_DIR"] = process.env.CLAUDE_CONFIG_DIR;
  return ["exec", "--disable", "apps", ...Object.entries(overrides).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    "-C", config.cwd, "--skip-git-repo-check", "--sandbox", "workspace-write", "--add-dir", MANAGED_ROOT, "--output-schema", schemaFile,
    "resume", "--json", config.targetThreadId, "-"];
}

export async function dispatchWakeBatch(config, folder, events, options = {}) {
  const runtimeFile = path.join(folder, "runtime.json"), runId = crypto.randomUUID();
  const usageBefore = codexTokenTotals(config.rolloutPath);
  const runFile = path.join(folder, "runs", `${runId}.json`);
  const policy = coordinationConfig(config.controllerId);
  const run = { id: runId, events, requestedEffort: eventEffort(policy, events), profile: policy.profile,
    state: "prepared", createdAt: new Date().toISOString(), cliPid: null, tools: [] };
  writeWakeJson(runFile, run);
  writeWakeJson(runtimeFile, { activeRunId: runId, paused: false });
  const schemaFile = path.join(folder, "result-schema.json");
  writeWakeJson(schemaFile, { type: "object", properties: { status: { type: "string", enum: ["handled", "needs_user"] },
    summary: { type: "string" } }, required: ["status", "summary"], additionalProperties: false });
  let guard, cli, interrupted = false, ownTurn = null;
  try {
    const result = await (options.runCodex || runCodex)(wakeCliArgs(config, schemaFile, events), wakePrompt(config.controllerId, events), {
      cwd: config.cwd, timeoutMs: options.timeoutMs || 180000,
      env: { ...process.env, CC_PLUGIN_CODEX_WAKE_CONTROLLER: config.controllerId, CC_PLUGIN_CODEX_WAKE_RUN: runId },
      onEvent(event) {
        if (event.type === "item.completed" && event.item?.type === "error") run.diagnosticCount = (run.diagnosticCount || 0) + 1;
        if (event.type === "item.completed" && event.item && !["agent_message", "reasoning", "error"].includes(event.item.type)) {
          run.tools.push({ type: event.item.type, tool: event.item.tool || null, server: event.item.server || null, status: event.item.status || null });
        }
      },
      onSpawn(child) {
        cli = child; run.cliPid = child.pid; run.state = "running"; writeWakeJson(runFile, run);
        guard = setInterval(() => {
          const current = codexActivity(config.rolloutPath), enabled = readWakeJson(path.join(folder, "config.json"))?.enabled;
          if (current.state === "busy" && !ownTurn) ownTurn = current.turnId;
          if (!enabled || current.state === "busy" && ownTurn && current.turnId !== ownTurn) {
            interrupted = true; stopOwnedCodex(cli);
          }
        }, 500);
      }
    });
    let response; try { response = JSON.parse(result.message); } catch {}
    run.diagnostic = { ...(result.diagnostic || {}), exitCode: result.code, signal: result.signal || null,
      targetThreadMatched: result.threadId === config.targetThreadId, jsonParsed: Boolean(response),
      schemaValid: ["handled", "needs_user"].includes(response?.status) && typeof response.summary === "string", externalInterrupted: interrupted };
    run.diagnostic.category = interrupted ? "EXTERNAL_INTERRUPTION" : result.diagnostic?.timedOut ? "CLI_TIMEOUT" : result.code !== 0 ? "CLI_EXIT" : result.failed ? "PROTOCOL_FAILURE" : !run.diagnostic.targetThreadMatched ? "THREAD_MISMATCH" : !response ? "RESULT_PARSE" : !run.diagnostic.schemaValid ? "RESULT_SCHEMA" : "OK";
    const valid = !interrupted && result.code === 0 && !result.failed && result.threadId === config.targetThreadId &&
      ["handled", "needs_user"].includes(response?.status) && typeof response.summary === "string";
    run.state = valid ? response.status : "uncertain";
    run.summary = valid ? redactText(response.summary).slice(0, 1000) : `CLI 回执或执行结果不明（${run.diagnostic.category}），需核对后处理`;
    run.usage = result.usage; run.actualEffort = valid ? codexRecordedEffort(config.rolloutPath) : null;
    run.completedAt = new Date().toISOString(); writeWakeJson(runFile, run);
    const usageAfter = codexTokenTotals(config.rolloutPath);
    if (valid && result.usage && !interrupted && usageBefore && usageAfter) {
      const delta = Object.fromEntries(["input_tokens", "cached_input_tokens", "output_tokens"].map((key) => [key, Number(usageAfter[key]) - Number(usageBefore[key])]));
      if (Object.values(delta).every((value) => Number.isFinite(value) && value >= 0)) run.usageDelta = { ...delta,
        uncached_input_tokens: Math.max(0, delta.input_tokens - delta.cached_input_tokens) };
    }
    writeWakeJson(runFile, run);
    if (valid && response.status === "handled") {
      acknowledgeWakeEvents(folder, events);
    }
    writeWakeJson(runtimeFile, { activeRunId: run.state === "handled" ? null : runId,
      paused: run.state !== "handled", reason: run.state === "handled" ? null : run.summary,
      lastRun: { id: runId, state: run.state, summary: run.summary, usage: run.usage, usageDelta: run.usageDelta || null, completedAt: run.completedAt } });
    if (run.state !== "handled" && options.notify !== false) attentionNotice(folder, run);
    return run;
  } catch (error) {
    run.state = "uncertain"; run.summary = "Codex 调用异常，停止自动重试";
    run.diagnostic = { category: "INVOCATION_ERROR", code: /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : null, started: Boolean(cli?.pid) }; run.completedAt = new Date().toISOString(); writeWakeJson(runFile, run);
    writeWakeJson(runtimeFile, { activeRunId: runId, paused: true, reason: run.summary });
    if (options.notify !== false) attentionNotice(folder, run);
    return run;
  } finally { clearInterval(guard); stopOwnedCodex(cli); }
}

export function currentWakeEvents(folder, events, controller) {
  return events.filter((event) => {
    const task = event.backend === "orca" ? readWakeJson(path.join(MANAGED_ROOT, "orca", "会话", `${event.taskId}.json`)) : readTask(event.taskId);
    if (event.backend === "orca" && task && (task.state !== "attached" || event.requestId && event.requestId !== task.lastInstruction?.requestId || task.lastInstruction?.terminalState === "cancelled")) {
      try { fs.unlinkSync(path.join(folder, "queue", `${event.id}.json`)); } catch {} return false;
    }
    const workflow = task?.workflowId && UUID.test(task.workflowId) ? readWakeJson(path.join(MANAGED_ROOT, "workflows", `${task.workflowId}.json`)) : null;
    if (task?.archivedAt || task?.supersededBy || !task || controller && (task.controllerId !== controller || event.controllerId !== controller) ||
      ["merged", "cancelled"].includes(task.state) || ["paused", "cancelled", "delivered"].includes(workflow?.stage)) {
      try { fs.unlinkSync(path.join(folder, "queue", `${event.id}.json`)); } catch {} return false;
    }
    if (event.backend === "orca" && task.owner === "human") return false;
    return true;
  });
}
