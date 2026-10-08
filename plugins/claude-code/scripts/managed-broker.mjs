#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import pty from "node-pty";
import { appendEvent, exitTaskState, readJson, readTask, taskDir, taskPath, writeRuntime, writeTask, writeJson } from "./lib/managed-state.mjs";
import { removeHandbackCommand } from "./lib/managed-config.mjs";
import { launchVisibleWindow } from "./lib/managed-window.mjs";
import { scheduleNext, invalidatePendingPermissions } from "./lib/managed-service.mjs";
import { activeTerminalInput, hasHumanIntervention } from "./lib/managed-input.mjs";
import { executable, ipcEndpoints, trustConfirmationKey } from "./lib/平台适配.mjs";
import { executionClock } from "./lib/执行计时.mjs";
import { findSession } from "./lib/会话读取.mjs";

const id = process.argv[2];
const task = id && readTask(id);
if (!task) throw new Error("任务不存在");

const endpoints = ipcEndpoints(id), terminalPipe = endpoints.terminal, controlPipe = endpoints.control;

const env = { ...process.env, CC_PLUGIN_CODEX_TASK_ID: id,
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(task.subagentLimit || 8) };
// 沿用 Claude Code 启动时可见的配置与环境变量；Codex 不切换 CCswitch。
const args = [task.resume ? "--resume" : "--session-id", task.sessionId,
  "--permission-mode", "bypassPermissions",
  "--settings", task.settingsPath];
if (task.model) args.push("--model", task.model);
if (task.initialPrompt) args.push(task.initialPrompt);
const claudeCommand = process.platform === "win32" ? "cmd.exe" : executable("claude");
const claudeArgs = process.platform === "win32" ? ["/c", "claude.cmd", ...args] : args;
const terminal = pty.spawn(claudeCommand, claudeArgs, {
  name: "xterm-256color", cols: 120, rows: 32, cwd: task.cwd, env
});
let startupResizeCount = 0;
const startupResize = setInterval(() => {
  if (ready || exited || startupResizeCount >= 12) return clearInterval(startupResize);
  startupResizeCount += 1;
  try { terminal.resize(120, 31); terminal.resize(120, 32); }
  catch { clearInterval(startupResize); }
}, 5000);
startupResize.unref();

let connected = null;
let exited = false;
let exitCode = null;
let finalState = null;
let limitHit = false;
let cancelRequested = false;
let ready = false;
let readyTimer = null;
let busy = Boolean(task.initialPrompt);
let failure = null;
let owner = "codex";
let takeoverPending = false;
let takeoverImmediate = false;
let humanInputSeen = false;
let humanStartCursor = null;
let humanQueued = 0;
let humanDraft = false;
let humanDraftLength = 0;
const inFlightPrompts = [];
let backgroundTasks = [];
const activeSubagents = new Set();
let settleTimer = null;
let interruptTimer = null;
let queue = Array.isArray(task.resumeQueue) ? task.resumeQueue : [];
let savedQueue = "";
let current = task.initialPrompt ? {
  id: crypto.randomUUID(), prompt: task.initialPrompt,
  createdAt: new Date().toISOString(), state: "written", initial: true
} : null;
let startupScreen = "";
let trustedOwnWorktree = false;
const declinedMcpServers = new Set();
const eventFile = taskPath(id, "events.jsonl");
let eventOffset = fs.existsSync(eventFile) ? fs.statSync(eventFile).size : 0;
let eventTail = "";
const eventDecoder = new StringDecoder("utf8");
function newEvents() {
  let size; try { size = fs.statSync(eventFile).size; } catch { return []; }
  if (size <= eventOffset) return [];
  const count = Math.min(size - eventOffset, 256_000);
  const bytes = Buffer.alloc(count);
  const fd = fs.openSync(eventFile, "r");
  let read;
  try { read = fs.readSync(fd, bytes, 0, count, eventOffset); }
  finally { fs.closeSync(fd); }
  eventOffset += read;
  eventTail += eventDecoder.write(bytes.subarray(0, read));
  const lines = eventTail.split("\n");
  eventTail = lines.pop() || "";
  return lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}
let mainTurns = Number(task.turnsUsed) || 0;
const startedAt = Date.now();
const elapsedBaseMs = Number(task.elapsedMs) || 0;
const clock = executionClock(task, startedAt), permissionWaits = new Map();
let lastActivity = null;
const writeState = () => {
  const timing = clock.update(exited || !ready || !busy || owner === "human" || permissionWaits.size > 0);
  const queueKey = JSON.stringify(queue);
  if (queueKey !== savedQueue) {
    writeTask({ ...readTask(id), queuedInstructions: queue });
    savedQueue = queueKey;
  }
  return writeRuntime(id, {
  pid: process.pid, claudePid: terminal.pid, terminalPipe, controlPipe,
  status: exited ? "exited" : !ready ? "starting" : busy ? "running" : "idle", ready, busy, owner, takeoverPending,
  humanQueued, humanDraft, humanInFlightCount: inFlightPrompts.filter((item) => item.kind === "human").length,
  backgroundTasks, activeSubagents: [...activeSubagents],
  current, queue, connected: Boolean(connected && !connected.destroyed),
  startupHints: !ready ? { trustQuestion: startupScreen.includes("Quick safety check"), trustYes: startupScreen.includes("Yes, I trust"), trustNo: startupScreen.includes("No, exit"), mcpQuestion: startupScreen.includes("New MCP server"), bypassNotice: /Bypass Permissions|bypass permissions/i.test(startupScreen), readyFooter: /bypass permissions on|plan mode on/i.test(startupScreen), titleEscape: /\x1b\][02];/.test(startupScreen), acceptancePrompt: /Yes, I accept|Do you want to proceed/i.test(startupScreen) } : null,
  exitCode, finalState, failure, elapsedBaseMs, ...timing, lastActivity, permissionWaiting: permissionWaits.size,
  startedAt: new Date(startedAt).toISOString(), updatedAt: new Date().toISOString()
  });
};
const submitted = (item) => {
  current = item;
  current.state = "written";
  busy = true;
  appendEvent(id, { type: "instruction_written", commandId: item.id });
  writeState();
  // 让交互界面先接收文本，再单独提交；同一批文本中的 Enter 可能早于输入状态更新。
  terminal.write(item.prompt);
  setTimeout(() => {
    if (!exited && current?.id === item.id && owner === "codex") terminal.write("\r");
  }, 180);
};
const pump = () => {
  if (exited || limitHit || failure || !ready || busy || owner !== "codex" || !queue.length) return;
  submitted(queue.shift());
};
const settleTakeover = () => {
  if (!takeoverPending || busy || humanQueued > 0 || humanDraft || settleTimer) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (!takeoverPending || busy || humanQueued > 0 || humanDraft) return;
    owner = "codex"; takeoverPending = false; takeoverImmediate = false; humanInputSeen = false;
    appendEvent(id, { type: "takeover_completed" });
    pump(); writeState();
  }, takeoverImmediate ? 0 : 5000);
};
const finishInterruptedPrompt = () => {
  interruptTimer = null;
  if (!takeoverImmediate || exited || humanQueued || humanDraft || activeSubagents.size || backgroundTasks.length) return;
  if (inFlightPrompts.some((item) => item.kind !== "codex")) return;
  // Claude 的 Escape 中断可能不会触发 Stop 回调，而是直接回到输入框。
  // 清掉恢复的草稿，再解除旧指令占位；下一条指令仍由接管流程派发。
  terminal.write("\x15");
  inFlightPrompts.length = 0;
  busy = false;
  appendEvent(id, { type: "interrupt_settled_without_stop" });
  settleTakeover();
  writeState();
};

terminal.onData((data) => {
  if (!ready) startupScreen = (startupScreen + data).slice(-8000);
  if (!ready && startupScreen.includes("Continue without using this MCP server")) {
    const match = startupScreen.match(/New MCP server found in this project:\s*([^\r\n\x1b]+)/);
    const serverName = match?.[1]?.trim();
    if (serverName && !declinedMcpServers.has(serverName)) {
      declinedMcpServers.add(serverName);
      terminal.write("\r");
      appendEvent(id, { type: "untrusted_mcp_declined", serverName });
      startupScreen = "";
    }
  }
  if (task.worktree && !trustedOwnWorktree) {
    const confirmation = trustConfirmationKey(startupScreen);
    if (confirmation) {
      trustedOwnWorktree = true;
      setTimeout(() => { if (!exited) terminal.write(confirmation); }, 200);
      appendEvent(id, { type: "own_worktree_trust_requested" });
    }
  }
  if (!ready && !readyTimer && /\x1b\][02];/.test(startupScreen) && /bypass permissions on|plan mode on/i.test(startupScreen)) {
    readyTimer = setTimeout(() => {
      if (exited) return;
      ready = true;
      appendEvent(id, { type: "terminal_ready" });
      pump(); writeState();
    }, 800);
  }
  if (connected && !connected.destroyed) connected.write(data);
});
terminal.onExit(({ exitCode: code }) => {
  lastActivity = { commandId: current?.id || null, busy, backgroundCount: backgroundTasks.length, activeSubagentCount: activeSubagents.size };
  exited = true;
  ready = false; busy = false; current = null; takeoverPending = false; takeoverImmediate = false;
  inFlightPrompts.length = 0; activeSubagents.clear(); backgroundTasks = []; humanQueued = 0; humanDraft = false;
  const timing = clock.update(true);
  exitCode = code;
  finalState = exitTaskState({ limitHit, cancelRequested, recoveryAttempts: task.recoveryAttempts }, code);
  writeTask({ ...readTask(id), state: finalState, elapsedMs: timing.elapsedMs, waitingMs: timing.waitingMs, timingMode: "execution" });
  invalidatePendingPermissions(task);
  if (finalState === "paused") appendEvent(id, { type: "recovery_failed", exitCode: code });
  removeHandbackCommand(task, task.handbackCommand?.owned);
  appendEvent(id, { type: "process_exit", exitCode: code });
  writeState();
  try {
    if (!scheduleNext(task.controllerId)) setTimeout(() => {
      try { scheduleNext(task.controllerId); } catch {}
    }, 600);
  }
  catch (error) { appendEvent(id, { type: "queue_start_failed", error: error.message }); }
  if (connected && !connected.destroyed) connected.end();
  terminalServer.close(); controlServer.close();
  if (endpoints.directory) { for (const file of [terminalPipe, controlPipe]) { try { fs.unlinkSync(file); } catch {} } try { fs.rmdirSync(endpoints.directory); } catch {} }
  setTimeout(() => process.exit(code || 0), 1500).unref();
});

const terminalServer = net.createServer((socket) => {
  if (connected && !connected.destroyed) connected.destroy();
  connected = socket;
  socket.write("\x1b[?25h\x1b[2J\x1b[H");
  const decoder = new StringDecoder("utf8");
  socket.on("data", (bytes) => {
    const text = decoder.write(bytes);
    if (!text || exited) return;
    if (hasHumanIntervention(text)) {
      if (!humanInputSeen) { try { humanStartCursor = { offset: fs.statSync(findSession(task.sessionId, task.cwd)).size }; } catch { humanStartCursor = null; } }
      owner = "human";
      humanInputSeen = true;
      if (ready) {
        for (const char of activeTerminalInput(text)) {
          if (char === "\r") { humanQueued += 1; humanDraftLength = 0; }
          else if (char === "\x03" || char === "\x15" || char === "\x1b") humanDraftLength = 0;
          else if (char === "\x7f" || char === "\b") humanDraftLength = Math.max(0, humanDraftLength - 1);
          else if (/[^\x00-\x1f\x7f]/u.test(char)) humanDraftLength += 1;
        }
        humanDraft = humanDraftLength > 0;
      }
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      appendEvent(id, { type: "human_terminal_control" });
    }
    terminal.write(text);
    writeState();
  });
  socket.on("close", () => {
    if (connected === socket) connected = null;
    writeState();
  });
  writeState();
});

function handle(request) {
  if (request.type === "status") return { ok: true, ...readJson(taskPath(id, "runtime.json")) };
  if (request.type === "send") {
    if (exited) return { ok: false, error: "会话已退出" };
    const prompt = String(request.prompt || "").trim();
    if (!prompt) return { ok: false, error: "指令为空" };
    const commandId = request.commandId || crypto.randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(commandId)) return { ok: false, error: "指令 ID 无效" };
    const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
    if (request.commandId) {
      const history = fs.readFileSync(eventFile, "utf8").split("\n").filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((event) => event?.commandId === commandId);
      if (history.length) {
        const original = history.find((event) => event.promptHash);
        if (original && original.promptHash !== promptHash) return { ok: false, error: "指令 ID 已用于另一条指令" };
        const written = history.some((event) => ["instruction_written", "instruction_submitted", "instruction_completed", "instruction_failed"].includes(event.type));
        if (written || current?.id === commandId || queue.some((item) => item.id === commandId)) {
          return { ok: true, commandId, state: history.at(-1).type, duplicate: true };
        }
      }
    }
    const item = { id: commandId, prompt, createdAt: new Date().toISOString(), state: "queued" };
    queue.push(item);
    appendEvent(id, { type: "instruction_queued", commandId: item.id, promptHash });
    pump();
    writeState();
    return { ok: true, commandId: item.id, state: current?.id === item.id ? "written" : "queued" };
  }
  if (request.type === "takeover") {
    failure = null;
    if (request.immediate) {
      const wasBusy = busy;
      terminal.write("\x1b");
      if (current) appendEvent(id, { type: "instruction_interrupted", commandId: current.id });
      current = null;
      takeoverPending = true;
      takeoverImmediate = true;
      // Escape 只请求中断；等 Claude 的 Stop 回调确认后才能写入下一条指令。
      busy = Boolean(wasBusy || inFlightPrompts.length || humanQueued || humanDraft);
      if (interruptTimer) clearTimeout(interruptTimer);
      if (busy) interruptTimer = setTimeout(finishInterruptedPrompt, 1500);
      settleTakeover();
    } else if (busy || owner === "human") {
      takeoverPending = true;
      takeoverImmediate = false;
      settleTakeover();
    } else {
      owner = "codex";
      takeoverImmediate = false;
      pump();
    }
    appendEvent(id, { type: "takeover_requested", immediate: Boolean(request.immediate) });
    writeState();
    return { ok: true, waiting: busy || takeoverPending };
  }
  if (request.type === "resize") {
    const cols = Number(request.cols), rows = Number(request.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 500 || rows < 5 || rows > 200) return { ok: false, error: "窗口尺寸无效" };
    if (request.first) terminal.resize(cols, rows === 5 ? 6 : rows - 1);
    terminal.resize(cols, rows);
    return { ok: true };
  }
  if (request.type === "cancel") {
    cancelRequested = true;
    terminal.kill();
    appendEvent(id, { type: "cancel_requested" });
    return { ok: true };
  }
  return { ok: false, error: "未知请求" };
}

const controlServer = net.createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (part) => {
    buffer += part;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { socket.write(JSON.stringify(handle(JSON.parse(line))) + "\n"); }
      catch (error) { socket.write(JSON.stringify({ ok: false, error: error.message }) + "\n"); }
    }
  });
});

terminalServer.listen(terminalPipe);
controlServer.listen(controlPipe, () => {
  writeState();
  appendEvent(id, { type: "process_started", pid: process.pid, claudePid: terminal.pid, sessionId: task.sessionId });
  if (current) appendEvent(id, { type: "instruction_written", commandId: current.id, initial: true });
  if (task.autoVisible) {
    try {
      const window = launchVisibleWindow(task);
      appendEvent(id, { type: "visible_window_open_requested", pid: window.pid || null });
    } catch (error) {
      appendEvent(id, { type: "visible_window_open_failed", error: error.message });
    }
  }
});

setInterval(() => {
  const inbox = path.join(taskDir(id), "inbox");
  let messages; try { messages = fs.readdirSync(inbox).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)); } catch { messages = []; }
  const incoming = messages.map((name) => ({ name, file: path.join(inbox, name), message: readJson(path.join(inbox, name)) }))
    .sort((a, b) => a.message?.order && b.message?.order ? a.message.order - b.message.order :
      String(a.message?.createdAt || "").localeCompare(String(b.message?.createdAt || "")));
  for (const { name, file, message } of incoming) {
    if (!message || name !== `${message.id}.json` || typeof message.prompt !== "string") continue;
    const answer = handle({ type: "send", commandId: message.id, prompt: message.prompt });
    if (answer.ok) { try { fs.unlinkSync(file); } catch {} }
  }
  for (const event of newEvents()) {
    if (exited) break;
    if (event.type === "permission_pending") permissionWaits.set(event.decisionId, { tool: event.tool, promptId: event.promptId, agentId: event.agentId });
    if (["permission_decided", "permission_invalidated"].includes(event.type)) permissionWaits.delete(event.decisionId);
    if (event.type === "PostToolUse") {
      for (const [decisionId, p] of permissionWaits) if (p.tool === event.tool && p.agentId === event.agentId && (!p.promptId || p.promptId === event.promptId)) {
        permissionWaits.delete(decisionId);
        const file = path.join(taskDir(id), "pending", `${decisionId}.json`), record = readJson(file);
        if (record?.state === "awaiting_human") writeJson(file, { ...record, state: "resolved_by_tool", resolvedAt: new Date().toISOString(), hookActive: false });
      }
    }
    if (event.type === "StopFailure" && !event.agentId) {
      failure = { error: event.error || "unknown", at: event.at };
      if (current) appendEvent(id, { type: "instruction_failed", commandId: current.id, error: failure.error });
      current = null; inFlightPrompts.length = 0; busy = false;
      if (interruptTimer) { clearTimeout(interruptTimer); interruptTimer = null; }
      writeState();
    }
    if (event.type === "UserPromptSubmit") {
      const expected = current && crypto.createHash("sha256").update(current.prompt).digest("hex");
      if (current && (event.promptHash === expected || current.initial)) {
        current.state = "submitted";
        current.initial = false;
        current.promptId = event.promptId;
        if (humanQueued > 0) { humanQueued -= 1; humanDraft = false; humanDraftLength = 0; }
        inFlightPrompts.push({ kind: "codex", promptId: event.promptId, commandId: current.id });
        appendEvent(id, { type: "instruction_submitted", commandId: current.id });
      } else {
        if (humanInputSeen) owner = "human";
        if (humanQueued > 0) {
          humanQueued = Math.max(0, humanQueued - 1);
          humanDraft = false; humanDraftLength = 0;
          inFlightPrompts.push({ kind: "human", promptId: event.promptId });
          appendEvent(id, { type: "human_prompt_submitted", promptId: event.promptId });
        } else if (current?.backgroundPending || backgroundTasks.length) {
          appendEvent(id, { type: "background_prompt_submitted", promptId: event.promptId });
        } else {
          inFlightPrompts.push({ kind: "unattributed", promptId: event.promptId });
          appendEvent(id, { type: "unattributed_prompt_submitted", promptId: event.promptId });
        }
      }
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
      busy = true; writeState();
    }
    if (event.type === "Stop") {
      if (interruptTimer) { clearTimeout(interruptTimer); interruptTimer = null; }
      if (!event.agentId) {
        mainTurns += 1;
        writeTask({ ...readTask(id), turnsUsed: mainTurns });
        if (mainTurns >= (task.maxTurns || 120)) {
          limitHit = true;
          appendEvent(id, { type: "turn_limit_reached", mainTurns });
          terminal.kill();
        }
      }
      backgroundTasks = Array.isArray(event.backgroundTasks) ? event.backgroundTasks : [];
      if (backgroundTasks.length || activeSubagents.size) {
        if (current) current.backgroundPending = true;
        if (inFlightPrompts[0]) inFlightPrompts[0].backgroundPending = true;
        busy = true;
        appendEvent(id, { type: "background_work_pending", count: Math.max(backgroundTasks.length, activeSubagents.size),
          kinds: backgroundTasks.map((item) => item.type) });
        writeState();
        continue;
      }
      const finished = inFlightPrompts.shift();
      if (finished?.kind === "human") {
        appendEvent(id, { type: "human_prompt_completed", promptId: finished.promptId, humanCursor: humanStartCursor });
      }
      if (current && (!finished || finished.kind === "codex")) {
        appendEvent(id, { type: "instruction_completed", commandId: current.id });
        current = null;
      }
      busy = Boolean(current || inFlightPrompts.length);
      if (takeoverPending) {
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        settleTakeover();
      } else if (!busy) pump();
      writeState();
    }
    if (event.type === "SubagentStart" && event.agentId) {
      activeSubagents.add(event.agentId);
      appendEvent(id, { type: "subagent_started", agentId: event.agentId, agentType: event.agentType });
      writeState();
    }
    if (event.type === "SubagentStop" && event.agentId) {
      const tracked = activeSubagents.delete(event.agentId);
      if (Array.isArray(event.backgroundTasks)) {
        backgroundTasks = event.backgroundTasks.filter((item) => item.id !== event.agentId);
      }
      if (tracked) appendEvent(id, { type: "subagent_completed", agentId: event.agentId,
        remaining: Math.max(backgroundTasks.length, activeSubagents.size) });
      writeState();
    }
    if (event.type === "handback") {
      permissionWaits.clear();
      if (current?.prompt === "/交还") appendEvent(id, { type: "instruction_completed", commandId: current.id, handback: true });
      current = null; busy = false; failure = null;
      owner = "codex"; takeoverPending = false; takeoverImmediate = false; humanInputSeen = false;
      humanQueued = 0; humanDraft = false;
      humanDraftLength = 0;
      inFlightPrompts.length = 0;
      pump(); writeState();
    }
    if (event.type === "config_changed") { owner = "human"; writeState(); }
  }
  writeState();
}, 250).unref();

if (task.maxMinutes > 0) setInterval(() => {
  if (!exited && !limitHit && clock.snapshot().elapsedMs >= task.maxMinutes * 60000) {
    limitHit = true;
    appendEvent(id, { type: "time_limit_reached", maxMinutes: task.maxMinutes });
    terminal.kill();
  }
}, 250).unref();
