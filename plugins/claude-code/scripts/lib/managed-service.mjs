import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MANAGED_ROOT, appendEvent, claudeSettingsPath, controllerId, fingerprint,
  listTasks, newTaskId, readEvents, readJson, readRuntime, readTask,
  resolveModel, taskDir, taskPath, writeJson, writeTask
} from "./managed-state.mjs";
import { prepareClaudeSettings, prepareHandbackCommand, removeHandbackCommand } from "./managed-config.mjs";
import { launchVisibleWindow } from "./managed-window.mjs";
import { ensurePtyRuntime } from "./managed-runtime.mjs";
import { roleModel } from "./managed-preferences.mjs";
import { withSessionLock } from "./managed-lock.mjs";
import { validateProfile, effectiveProfile, prepareRecordDocuments, deliveryInstruction } from "./协作策略.mjs";

const BROKER = fileURLToPath(new URL("../managed-broker.mjs", import.meta.url));
const WATCHDOG = fileURLToPath(new URL("../managed-watchdog.mjs", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function controller(value) {
  const id = value || controllerId();
  if (!id) throw new Error("无法识别 Codex 主控任务 ID；请提供 controller_id");
  return String(id);
}

function ownership(id, controllerIdValue) {
  const task = readTask(id);
  if (!task) throw new Error("任务不存在");
  if (task.controllerId !== controller(controllerIdValue)) throw new Error("任务不属于当前 Codex 主控任务");
  return task;
}

function isAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch { return false; }
}

export function claudeSessionStillRunning(task) {
  if (process.platform !== "win32") return false;
  if (!/^[0-9a-f-]{36}$/i.test(task.sessionId)) return true;
  try {
    const query = `(Get-CimInstance Win32_Process -Filter "Name='claude.exe' OR Name='node.exe' OR Name='cmd.exe'" | Where-Object { $_.CommandLine -match '--(?:resume|session-id)\\s+\"?${task.sessionId}(?:\"|\\s|$)' } | Measure-Object).Count`;
    return Number(execFileSync("powershell.exe", ["-NoProfile", "-Command", query], {
      encoding: "utf8", windowsHide: true, timeout: 5000
    }).trim()) > 0;
  } catch {
    // 不能可靠确认进程已退出时，不启动第二份 Claude。
    return true;
  }
}

function controllerSettings(id) {
  const file = path.join(MANAGED_ROOT, "controllers", `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
  return { file, value: readJson(file) || { limit: 3 } };
}

export function setConcurrencyLimit(limit, controllerIdValue) {
  const id = controller(controllerIdValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("并发上限须为 1 至 10");
  const { file } = controllerSettings(id);
  writeJson(file, { limit });
  schedule(id);
  return { controllerId: id, limit };
}

function runningTasks(id) {
  return listTasks(id).filter((task) => {
    if (task.archivedAt || task.supersededBy) return false;
    const runtime = readRuntime(task.id);
    return runtime && runtime.status !== "exited" && isAlive(runtime.pid);
  });
}

function orderedQueue(id) {
  return listTasks(id).filter((task) => !task.archivedAt && !task.supersededBy && task.state === "queued")
    .sort((a, b) => Number(b.kind === "review") - Number(a.kind === "review") ||
      String(a.createdAt).localeCompare(String(b.createdAt)));
}

function invalidatePendingPermissions(task) {
  const folder = path.join(taskDir(task.id), "pending");
  let names; try { names = fs.readdirSync(folder); } catch { return; }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
    const file = path.join(folder, name);
    const pending = readJson(file);
    if (!pending || pending.taskId !== task.id) continue;
    try { fs.unlinkSync(file); } catch { continue; }
    appendEvent(task.id, { type: "permission_invalidated", decisionId: pending.id,
      reason: "原 Claude 进程已退出，旧工具调用不再有效" });
  }
}

export function recoverQueuedInstructions(task, runtime) {
  let events;
  try {
    events = fs.readFileSync(taskPath(task.id, "events.jsonl"), "utf8").split("\n")
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { events = []; }
  const written = new Set(events.filter((event) => ["instruction_written", "instruction_submitted",
    "instruction_completed", "instruction_failed"].includes(event.type)).map((event) => event.commandId));
  const queue = [...new Map([...(runtime?.queue || []), ...(task.queuedInstructions || []), ...(task.resumeQueue || [])]
    .map((entry) => [entry.id, entry])).values()];
  return queue.filter((entry) => typeof entry.prompt === "string" && /^[0-9a-f-]{36}$/i.test(entry.id) && !written.has(entry.id));
}

function reconcile(task) {
  if (task.archivedAt || task.supersededBy) return;
  const replacement = listTasks().find((other) => other.reusedFromTaskId === task.id);
  if (replacement) { task.supersededBy = replacement.id; writeTask(task); return; }
  const runtime = readRuntime(task.id);
  if (!runtime) return;
  if (runtime.status === "exited") {
    if (["starting", "running"].includes(task.state)) {
      task.state = runtime.finalState || (runtime.exitCode === 0 ? "exited"
        : task.recoveryAttempts ? "paused" : "failed");
      writeTask(task);
      appendEvent(task.id, { type: "exited_state_repaired", state: task.state });
    }
    return;
  }
  if (isAlive(runtime.pid)) return;
  if (isAlive(runtime.claudePid) || claudeSessionStillRunning(task)) {
    task.state = "paused";
    writeTask(task);
    appendEvent(task.id, { type: "broker_lost_claude_alive", claudePid: runtime.claudePid });
    return;
  }
  invalidatePendingPermissions(task);
  if ((task.recoveryAttempts || 0) >= 1) {
    const runKey = `${runtime.pid || 0}:${runtime.startedAt || ""}`;
    const alreadyRecorded = task.recoveryExhaustedRun === runKey;
    task.state = "paused";
    task.recoveryExhaustedRun = runKey;
    writeTask(task);
    if (!alreadyRecorded) appendEvent(task.id, { type: "recovery_exhausted" });
    return;
  }
  const transcriptExists = managedTranscript(task.id, task.controllerId, 200).available;
  if (!transcriptExists && task.initialPrompt) {
    task.state = "paused";
    writeTask(task);
    appendEvent(task.id, { type: "recovery_uncertain", reason: "首条指令可能已被 Claude 接收，但会话记录尚不可用" });
    return;
  }
  if (runtime.current && runtime.busy) {
    task.recoveryInterrupted = { commandId: runtime.current.id,
      state: runtime.current.state || "unknown", at: new Date().toISOString() };
    appendEvent(task.id, { type: "recovery_interrupted_instruction",
      commandId: runtime.current.id, previousState: runtime.current.state || "unknown" });
  }
  task.recoveryAttempts = 1;
  task.resumeQueue = recoverQueuedInstructions(task, runtime);
  if (runtime.startedAt) task.elapsedMs = Math.max(Number(task.elapsedMs) || 0,
    (Number(runtime.elapsedBaseMs) || 0) + Date.now() - Date.parse(runtime.startedAt));
  task.resume = transcriptExists;
  task.initialPrompt = null;
  task.state = "queued";
  writeTask(task);
  appendEvent(task.id, { type: "recovery_queued", reason: "桥接进程意外退出，原 Claude 进程已不在" });
}

export function reconcileTask(id) {
  const task = readTask(id);
  if (!task) return false;
  reconcile(task);
  return schedule(task.controllerId);
}

function start(task) {
  try { return withSessionLock(task.sessionId, () => startUnlocked(task)); }
  catch (error) { return { started: false, retry: error.code === "SESSION_LOCK_BUSY", reason: error.message }; }
}

function startUnlocked(task) {
  const latest = readTask(task.id);
  if (latest?.archivedAt || latest?.supersededBy || sessionReserved(task.sessionId, task.id)) return { started: false, reason: "会话已归档、被替代或被另一项任务占用" };
  if (task.resume && claudeSessionStillRunning(task)) return { started: false, reason: "原会话进程仍在或无法确认" };
  const runtime = readRuntime(task.id);
  if (runtime && isAlive(runtime.pid)) return { started: false, reason: "进程仍在运行" };
  const output = fs.openSync(taskPath(task.id, "broker.log"), "a");
  const error = fs.openSync(taskPath(task.id, "broker-error.log"), "a");
  const child = spawn(process.execPath, [BROKER, task.id], {
    cwd: task.cwd, detached: true, windowsHide: true, stdio: ["ignore", output, error]
  });
  child.unref(); fs.closeSync(output); fs.closeSync(error);
  writeJson(taskPath(task.id, "runtime.json"), {
    pid: child.pid, status: "starting", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  appendEvent(task.id, { type: "launch_requested", pid: child.pid });
  const watcher = spawn(process.execPath, [WATCHDOG, task.id, String(child.pid)], {
    cwd: task.cwd, detached: true, windowsHide: true, stdio: "ignore"
  });
  watcher.unref();
  return { started: true, pid: child.pid };
}

function schedule(id) {
  const lock = path.join(MANAGED_ROOT, "controllers", `${crypto.createHash("sha256").update(id).digest("hex")}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); }
  catch {
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
        fs.rmdirSync(lock);
        fs.mkdirSync(lock);
      } else return false;
    } catch { return false; }
  }
  try {
    const limit = controllerSettings(id).value.limit;
    let remaining = Math.max(0, limit - runningTasks(id).length);
    const pending = orderedQueue(id);
    for (const task of pending) {
      if (!remaining) break;
      task.state = "starting";
      writeTask(task);
      const result = start(task);
      if (result.started) remaining -= 1;
      else {
        task.state = result.retry ? "queued" : "paused"; writeTask(task);
        if (result.retry) setTimeout(() => { try { schedule(id); } catch {} }, 200).unref();
        else appendEvent(task.id, { type: "session_start_blocked", reason: result.reason });
      }
    }
    return true;
  } finally {
    fs.rmdirSync(lock);
  }
}

export function scheduleNext(controllerIdValue) {
  return schedule(controller(controllerIdValue));
}

function integer(value, fallback, minimum, maximum, label) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${label}须为 ${minimum} 至 ${maximum}`);
  return number;
}

export function createManagedTask(options = {}) {
  const sessionId = options.session_id || crypto.randomUUID();
  return withSessionLock(String(sessionId), () => createManagedTaskUnlocked({ ...options, new_session_id: sessionId }));
}

function sessionReserved(sessionId, exceptId) {
  return listTasks().some((other) => {
    if (other.id === exceptId || other.sessionId?.toLowerCase() !== sessionId.toLowerCase()) return false;
    const runtime = readRuntime(other.id);
    return !other.archivedAt && !other.supersededBy && (["queued", "starting"].includes(other.state) ||
      runtime?.status !== "exited" && isAlive(runtime?.pid));
  });
}

function createManagedTaskUnlocked(options = {}) {
  const master = controller(options.controller_id);
  if (!options.cwd || !path.isAbsolute(options.cwd)) throw new Error("cwd 必须为绝对路径");
  const source = path.resolve(String(options.cwd));
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error("cwd 必须是已存在的目录");
  const existing = Boolean(options.session_id);
  if (existing && options.existing_idle_confirmed !== true) {
    throw new Error("既有窗口需先结束当前 Claude 进程，再以 existing_idle_confirmed=true 按精确会话 ID 续接；不能同时控制未托管的活动窗口");
  }
  const id = newTaskId();
  const sessionId = existing ? String(options.session_id).toLowerCase() : options.new_session_id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new Error("必须提供精确的 Claude 会话 UUID");
  if (sessionReserved(sessionId)) {
    throw new Error("该 Claude 会话 ID 已由另一个托管任务运行，不能创建并发副本");
  }
  if (existing && claudeSessionStillRunning({ sessionId })) throw new Error("原 Claude 进程仍在运行或无法确认，不能创建并发副本");
  // 在创建工作树和进程之前完成参数校验，失败不遗留资源。
  const kind = options.kind === "review" ? "review" : "implementation";
  const reviewTarget = kind === "review" ? ownership(options.review_of, master) : null;
  if (reviewTarget && !reviewTarget.worktree) throw new Error("只能审查托管的新任务工作树");
  if (reviewTarget && (!options.review_ref || !/^[0-9a-f]{40}$/i.test(options.review_ref))) throw new Error("审查快照提交无效");
  const model = roleModel(reviewTarget?.source || source, kind, options.model);
  if (options.profile != null) validateProfile(options.profile);
  const maxMinutes = integer(options.max_minutes, 90, 1, 1440, "执行时间");
  const maxTurns = integer(options.max_turns, 120, 1, 1000, "主会话轮数");
  const subagentLimit = integer(options.subagent_limit, 8, 1, 20, "子代理并发");
  ensurePtyRuntime();
  let cwd = source;
  let worktree = null;
  let baseRef = null;
  if (!existing && kind !== "review") {
    const gitRoot = git(source, "rev-parse", "--show-toplevel");
    baseRef = git(source, "rev-parse", "HEAD");
    worktree = path.join(MANAGED_ROOT, "worktrees", id);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(gitRoot, "worktree", "add", "-b", `codex/claude-${id.slice(0, 8)}`, worktree, baseRef);
    cwd = worktree;
  }
  if (kind === "review" && !options.review_of) throw new Error("审查任务必须指定 review_of");
  if (kind === "review") {
    const target = ownership(options.review_of, master);
    if (!target.worktree) throw new Error("只能审查托管的新任务工作树");
    if (!options.review_ref || !/^[0-9a-f]{40}$/i.test(options.review_ref)) throw new Error("审查快照提交无效");
    baseRef = target.baseRef;
    if (!existing) {
    worktree = path.join(MANAGED_ROOT, "reviews", id);
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(target.cwd, "worktree", "add", "--detach", worktree, options.review_ref);
    cwd = worktree;
    }
  }
  const task = {
    id, controllerId: master, kind, state: "queued", source, cwd, worktree, baseRef,
    sourceBranch: worktree && kind !== "review" ? git(source, "branch", "--show-current") : null,
    branch: worktree && kind !== "review" ? `codex/claude-${id.slice(0, 8)}` : null,
    sessionId, resume: existing, reviewOf: options.review_of || null,
    reviewRef: kind === "review" ? options.review_ref : null,
    model, coordinationProfile: options.profile || null, initialPrompt: options.prompt || null,
    originalPrompt: options.prompt || null,
    workflowId: options.workflow_id || null, workflowItemId: options.workflow_item_id || null,
    workflowOperationId: options.workflow_operation_id || null,
    reusedFromTaskId: options.reused_from_task_id || null,
    attachRequestId: options.attach_request_id || null, attachSignature: options.attach_signature || null,
    attachAlias: options.attach_alias || null,
    autoVisible: options.visible !== false,
    maxMinutes, maxTurns, subagentLimit,
    configFingerprint: fingerprint(claudeSettingsPath()),
    createdAt: new Date().toISOString()
  };
  try {
    fs.mkdirSync(taskDir(id), { recursive: true });
    if (kind === "implementation" && options.process_docs === true && task.initialPrompt) {
      task.processDocuments = prepareRecordDocuments(task, options.prompt);
      task.initialPrompt += deliveryInstruction(task, task.processDocuments);
    }
    task.settingsPath = prepareClaudeSettings(task);
    task.handbackCommand = prepareHandbackCommand(task);
    writeTask(task);
    if (existing) {
      for (const previous of listTasks().filter((entry) => entry.id !== id && entry.sessionId?.toLowerCase() === sessionId.toLowerCase())) {
        previous.supersededBy = id; previous.workspaceRetainedForReuse = true; writeTask(previous);
      }
    }
    appendEvent(id, { type: "task_created", kind, sessionId, cwd });
    schedule(master);
    return taskSummary(readTask(id));
  } catch (error) {
    if (worktree) {
      try { git(source, "worktree", "remove", "--force", worktree); } catch {}
    }
    throw error;
  }
}

export function createReviewTask(targetId, options = {}) {
  ensurePtyRuntime();
  const target = ownership(targetId, options.controller_id);
  if (target.supersededBy) throw new Error("原会话已用于新任务，先核对新的执行记录再审查原目标");
  if (target.kind !== "implementation" || !target.worktree) throw new Error("审查对象必须是独立工作树实现任务");
  if (target.state === "merged") throw new Error("已合并的任务不能再次创建审查快照");
  const runtime = readRuntime(target.id);
  if (!runtime || (runtime.status !== "exited" && (runtime.busy || runtime.status === "starting" || runtime.owner === "human" ||
      runtime.humanDraft || runtime.humanQueued || runtime.queue?.length))) {
    throw new Error("实现会话尚未空闲，先等本轮和人工输入队列完成");
  }
  // 模型不可用时不能先提交快照。
  roleModel(target.source, "review", options.model);
  const bridgeFile = ".claude/commands/交还.md";
  if (target.handbackCommand?.owned && git(target.cwd, "ls-files", "--", bridgeFile)) {
    throw new Error("桥接器临时命令已被纳入版本控制，请先处理该改动");
  }
  git(target.cwd, "add", "--all");
  if (target.handbackCommand?.owned && git(target.cwd, "diff", "--cached", "--name-only", "--", bridgeFile)) {
    git(target.cwd, "reset", "--", bridgeFile);
  }
  if (git(target.cwd, "diff", "--cached", "--name-only")) {
    git(target.cwd, "-c", "user.name=Codex", "-c", "user.email=codex@local", "commit", "-m", "保存 Claude 审查快照");
  }
  const reviewRef = git(target.cwd, "rev-parse", "HEAD");
  const prompt = [
    "请独立审查当前审查工作树相对基准提交的代码改动。不要编辑代码、提交或推送；可在这个隔离副本运行相关的定向检查。",
    "`.claude/commands/交还.md` 是桥接器在审查时临时创建的命令文件，不属于实现差异，请忽略。",
    `基准提交：${target.baseRef}`,
    `审查快照：${reviewRef}`,
    `原任务要求：${target.originalPrompt || target.initialPrompt || "详见实现会话"}`,
    options.focus ? `重点：${options.focus}` : "",
    "先给结论和阻塞问题，最多三条带文件与行号的关键证据；检查结果与剩余风险各用一句话。保持短报告。"
  ].filter(Boolean).join("\n");
  return createManagedTask({
    cwd: target.cwd, kind: "review", review_of: targetId, review_ref: reviewRef, prompt,
    model: options.model, max_minutes: options.max_minutes ?? 30,
    workflow_id: target.workflowId, workflow_item_id: target.workflowItemId,
    workflow_operation_id: options.workflow_operation_id,
    controller_id: options.controller_id, visible: options.visible, profile: options.profile || target.coordinationProfile || undefined
  });
}

export function taskSummary(task) {
  const runtime = readRuntime(task.id);
  const runtimeActive = runtime && runtime.status !== "exited" && isAlive(runtime.pid);
  let inboxCount = 0;
  try { inboxCount = fs.readdirSync(path.join(taskDir(task.id), "inbox")).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).length; } catch {}
  return { id: task.id, controllerId: task.controllerId, kind: task.kind, profile: effectiveProfile(task),
    alias: task.alias || null, formerAlias: task.formerAliases?.at(-1) || null, title: (task.originalPrompt || "").slice(0, 180),
    supersededBy: task.supersededBy || null,
    archivedAt: task.archivedAt || null, summary: task.archive?.summary || null,
    state: task.archivedAt ? "archived" : task.supersededBy ? "superseded" : runtimeActive ? runtime.status : task.state,
    sessionId: task.sessionId, cwd: task.cwd, worktree: task.worktree, branch: task.branch,
    model: task.model || "inherit", owner: runtime?.owner || "codex", busy: runtime?.busy ?? null,
    recoveryInterrupted: task.recoveryInterrupted || null,
    backgroundCount: runtime?.backgroundTasks?.length || 0,
    activeSubagentCount: runtime?.activeSubagents?.length || 0,
    humanInFlightCount: runtime?.humanInFlightCount || 0,
    current: runtime?.current ? { id: runtime.current.id, state: runtime.current.state } : null,
    workflowId: task.workflowId || null, workflowItemId: task.workflowItemId || null,
    takeoverPending: runtime?.takeoverPending || false, humanQueued: runtime?.humanQueued || 0, inboxCount,
    failure: runtime?.failure || null, queueLength: runtime?.queue?.length || 0,
    pid: runtime?.pid || null, visible: runtime?.connected || false, createdAt: task.createdAt };
}

export function listManagedTasks(controllerIdValue, includeArchived = false) {
  const id = controller(controllerIdValue);
  for (const task of listTasks(id)) reconcile(task);
  schedule(id);
  const limit = controllerSettings(id).value.limit;
  return { controllerId: id, limit, running: runningTasks(id).length,
    queueOrder: orderedQueue(id).map((task) => task.id),
    tasks: listTasks(id).filter((task) => includeArchived || !task.archivedAt && !task.supersededBy).map(taskSummary) };
}

export function managedStatus(id, controllerIdValue, cursor = 0, limit = 30) {
  const task = ownership(id, controllerIdValue);
  reconcile(task);
  schedule(task.controllerId);
  return { task: taskSummary(readTask(id)), events: readEvents(id, cursor, limit) };
}

export function managedTranscript(id, controllerIdValue, maxChars = 6000, cursor) {
  const task = ownership(id, controllerIdValue);
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let folders;
  try { folders = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return { sessionId: task.sessionId, messages: [], available: false }; }
  const fileName = `${task.sessionId}.jsonl`;
  const candidates = folders.filter((item) => item.isDirectory())
    .map((item) => path.join(root, item.name, fileName))
    .filter((file) => fs.existsSync(file));
  if (candidates.length !== 1) return { sessionId: task.sessionId, messages: [], available: false, matches: candidates.length };
  const lines = fs.readFileSync(candidates[0], "utf8").split("\n");
  const messages = [];
  for (const line of lines) {
    if (!line) continue;
    let item; try { item = JSON.parse(line); } catch { continue; }
    if (item.type !== "assistant" || !Array.isArray(item.message?.content)) continue;
    const text = item.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
    if (text) messages.push({ at: item.timestamp || null, text });
  }
  const cap = Math.min(Math.max(Number(maxChars) || 6000, 200), 20000);
  if (cursor !== undefined) {
    const message = Number(cursor?.message ?? 0), offset = Number(cursor?.offset ?? 0);
    if (!Number.isInteger(message) || message < 0 || message > messages.length ||
        !Number.isInteger(offset) || offset < 0 || offset > (messages[message]?.text.length || 0)) {
      throw new Error("正文游标无效，需提供 message 与 offset");
    }
    const selected = [];
    let index = message, position = offset, remaining = cap;
    while (index < messages.length && remaining > 0) {
      const item = messages[index];
      let end = Math.min(item.text.length, position + remaining);
      if (end < item.text.length && /[\uD800-\uDBFF]/.test(item.text[end - 1])) end -= 1;
      if (end <= position) break;
      const text = item.text.slice(position, end);
      selected.push({ at: item.at, message: index, offset: position, text });
      remaining -= text.length; position += text.length;
      if (position === item.text.length) { index += 1; position = 0; }
    }
    return { sessionId: task.sessionId, available: true, messages: selected,
      nextCursor: { message: index, offset: position }, hasMore: index < messages.length };
  }
  let remaining = cap;
  const selected = [];
  for (const message of messages.reverse()) {
    if (remaining <= 0) break;
    selected.push({ ...message, text: message.text.slice(-remaining) });
    remaining -= Math.min(message.text.length, remaining);
  }
  return { sessionId: task.sessionId, available: true, messages: selected.reverse(),
    nextCursor: { message: messages.length, offset: 0 }, hasMore: false };
}

export function managedDiff(id, controllerIdValue) {
  const task = ownership(id, controllerIdValue);
  if (!task.worktree) throw new Error("该任务没有独立工作树");
  return {
    taskId: id, baseRef: task.baseRef, branch: task.branch,
    committed: git(task.cwd, "-c", "core.quotePath=false", "diff", "--name-status", `${task.baseRef}..HEAD`),
    working: git(task.cwd, "-c", "core.quotePath=false", "status", "--short"),
    stat: git(task.cwd, "-c", "core.quotePath=false", "diff", "--stat", task.baseRef),
    temporaryCommand: ".claude/commands/交还.md 由桥接器临时创建，验收时排除"
  };
}

async function stopForMerge(task) {
  const runtime = readRuntime(task.id);
  if (!runtime || (!isAlive(runtime.pid) && !isAlive(runtime.claudePid))) return;
  if (runtime.status !== "exited" && (runtime.busy || runtime.owner === "human" || runtime.humanDraft ||
      runtime.humanQueued || runtime.queue?.length)) {
    throw new Error(`会话 ${task.id} 尚有执行或人工输入；请等队列清空并交还控制权`);
  }
  if (runtime.status !== "exited") await control(task.id, { type: "cancel" }, task.controllerId);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const latest = readRuntime(task.id);
    if (!isAlive(latest?.pid) && !isAlive(latest?.claudePid)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`会话 ${task.id} 未在 10 秒内退出，合并已暂停`);
}

function cleanupReviewWorktree(task, review) {
  if (review.workspaceRetainedForReuse) {
    appendEvent(review.id, { type: "review_workspace_retained_for_reuse" }); return;
  }
  const reviewRoot = path.resolve(MANAGED_ROOT, "reviews"), reviewPath = path.resolve(review.cwd);
  if (!review.worktree || path.dirname(reviewPath) !== reviewRoot) return;
  try {
    if (fs.existsSync(reviewPath)) {
      const actual = fs.realpathSync.native(reviewPath);
      if (path.dirname(actual) !== fs.realpathSync.native(reviewRoot)) throw new Error("审查目录的真实路径超出托管清理范围");
      const registered = git(task.source, "worktree", "list", "--porcelain", "-z").split("\0")
        .filter((line) => line.startsWith("worktree ")).some((line) => {
          try { return fs.realpathSync.native(line.slice(9)) === actual; } catch { return false; }
        });
      if (registered) git(task.source, "worktree", "remove", "--force", reviewPath);
      // Git 可能已移除登记，但 Windows 文件占用让上一次目录清理未完成。
      // 绝对目标的父目录已与托管 reviews 目录精确核对，且调用前已确认进程退出。
      else {
        fs.rmSync(actual, { recursive: true, force: true });
      }
      if (fs.existsSync(reviewPath) && fs.readdirSync(reviewPath).length === 0) fs.rmdirSync(reviewPath);
    }
    review.worktreeRemoved = !fs.existsSync(reviewPath); writeTask(review);
    appendEvent(review.id, { type: review.worktreeRemoved ? "review_worktree_removed" : "review_cleanup_deferred" });
  } catch (error) {
    appendEvent(review.id, { type: "review_cleanup_failed", error: error.message });
  }
}

export async function mergeManaged(id, reviewId, verification, controllerIdValue) {
  const task = ownership(id, controllerIdValue);
  const review = ownership(reviewId, controllerIdValue);
  if (!task.worktree || review.kind !== "review" || review.reviewOf !== id) throw new Error("必须提供此实现任务对应的独立审查任务");
  if (task.state === "merged") {
    if (!review.workspaceRetainedForReuse) await stopForMerge(review);
    cleanupReviewWorktree(task, review);
    return { merged: true, alreadyMerged: true, commit: task.mergeCommit || null,
      cleanupPending: !review.worktreeRemoved && !review.workspaceRetainedForReuse };
  }
  if (task.supersededBy) throw new Error("原会话已用于新任务，不能沿用旧目标自动合并");
  if (!managedTranscript(reviewId, controllerIdValue, 2000).messages.length) throw new Error("尚无可读取的审查报告");
  if (!verification || !String(verification).trim()) throw new Error("必须写明 Codex 的定向检查及验收结论");
  await stopForMerge(review);
  await stopForMerge(task);
  removeHandbackCommand(task, task.handbackCommand?.owned);
  removeHandbackCommand(review, review.handbackCommand?.owned);
  const sourceBranch = git(task.source, "branch", "--show-current");
  if (!sourceBranch || sourceBranch !== task.sourceBranch) throw new Error("目标仓库当前分支与任务创建时不同，合并已暂停");
  let resolvedMerge = false;
  if (task.mergePending) {
    const conflicts = git(task.source, "diff", "--name-only", "--diff-filter=U");
    let merging = false;
    try { git(task.source, "rev-parse", "--verify", "MERGE_HEAD"); merging = true; } catch {}
    if (conflicts || merging) return { merged: false, conflict: true,
      files: conflicts.split("\n").filter(Boolean), message: "解决冲突后需要提交合并结果，再确认验收" };
    try { git(task.source, "merge-base", "--is-ancestor", review.reviewRef, "HEAD"); resolvedMerge = true; }
    catch { throw new Error("上次合并已中止或未包含审查快照，请核对目标分支后再处理"); }
  }
  if (git(task.source, "status", "--porcelain")) throw new Error("目标分支有未提交改动，合并已暂停");
  if (git(task.cwd, "rev-parse", "HEAD") !== review.reviewRef) {
    throw new Error("实现分支已在审查快照后发生变化，需重新审查再合并");
  }
  const bridgeFile = ".claude/commands/交还.md";
  const bridgeTracked = Boolean(git(task.cwd, "ls-files", "--", bridgeFile));
  if (bridgeTracked && task.handbackCommand?.owned) throw new Error("临时交还命令已被纳入版本控制，请先处理该改动");
  if (git(task.cwd, "status", "--porcelain")) throw new Error("实现工作树在审查快照后仍有改动，需重新审查再合并");
  const noChanges = git(task.cwd, "rev-parse", "HEAD") === task.baseRef;
  try {
    if (!noChanges && !resolvedMerge) {
    git(task.source, "-c", "user.name=Codex", "-c", "user.email=codex@local", "merge", "--no-ff", "--no-edit", task.branch);
    }
  } catch (error) {
    const conflicts = git(task.source, "diff", "--name-only", "--diff-filter=U");
    if (!conflicts) throw new Error(`合并失败，未发现文件冲突：${error.message}`);
    task.mergePending = { reviewId, reviewRef: review.reviewRef };
    writeTask(task);
    appendEvent(id, { type: "merge_conflict", files: conflicts.split("\n").filter(Boolean) });
    return { merged: false, conflict: true, files: conflicts.split("\n").filter(Boolean),
      message: "Codex 需按任务意图解决明确冲突；业务取舍不明时请用户决定。合并状态保留在目标仓库。" };
  }
  task.state = "merged";
  task.mergedAt = new Date().toISOString();
  task.mergeCommit = git(task.source, "rev-parse", "HEAD");
  task.mergePending = null;
  writeTask(task);
  appendEvent(id, { type: "merged", sourceBranch, commit: git(task.source, "rev-parse", "HEAD"), verification: String(verification).slice(0, 1000) });
  cleanupReviewWorktree(task, review);
  return { merged: !noChanges, noChanges, sourceBranch, commit: task.mergeCommit,
    cleanupPending: !review.worktreeRemoved && !review.workspaceRetainedForReuse };
}

export function control(id, request, controllerIdValue) {
  ownership(id, controllerIdValue);
  const runtime = readRuntime(id);
  if (!runtime?.controlPipe || !isAlive(runtime.pid)) throw new Error("桥接进程未就绪或已退出");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(runtime.controlPipe);
    let buffer = "";
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("桥接器响应超时")); }, 5000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (data) => {
      buffer += data;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timeout); socket.end();
      try { resolve(JSON.parse(buffer.slice(0, index))); }
      catch (error) { reject(error); }
    });
    socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

export async function cancelManaged(id, controllerIdValue) {
  const task = ownership(id, controllerIdValue);
  if (task.state === "queued") {
    task.state = "cancelled";
    writeTask(task);
    appendEvent(id, { type: "task_cancelled_in_queue" });
    return { ok: true, queued: true };
  }
  const runtime = readRuntime(id);
  if (runtime?.status === "exited") return { ok: true, alreadyExited: true };
  return control(id, { type: "cancel" }, controllerIdValue);
}

const KEY_EVENTS = new Set(["permission_pending", "permission_to_human", "process_exit", "instruction_completed",
  "background_work_pending", "recovery_interrupted_instruction", "recovery_uncertain", "recovery_failed",
  "broker_lost_claude_alive", "handback", "time_limit_reached", "turn_limit_reached", "config_changed",
  "instruction_failed", "StopFailure", "needs_input", "takeover_completed", "takeover_confirmation_required",
  "task_cancelled_in_queue", "task_archived", "task_restored", "session_start_blocked"]);

export async function waitManyManaged(targets, seconds = 45, controllerIdValue) {
  if (!Array.isArray(targets) || !targets.length || targets.length > 10) throw new Error("须提供 1 至 10 个等待任务");
  if (new Set(targets.map((item) => item.task_id)).size !== targets.length) throw new Error("等待任务不能重复");
  const cursors = new Map(targets.map((item) => {
    ownership(item.task_id, controllerIdValue);
    const cursor = Number(item.cursor ?? 0);
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("事件游标须为非负整数");
    return [item.task_id, cursor];
  }));
  const duration = seconds === undefined ? 45 : Number(seconds);
  if (!Number.isFinite(duration)) throw new Error("等待时长无效");
  const deadline = Date.now() + Math.min(Math.max(duration, 0), 60) * 1000;
  for (;;) {
    const tasks = [], changes = [];
    for (const target of targets) {
      const first = managedStatus(target.task_id, controllerIdValue, cursors.get(target.task_id), 100);
      tasks.push(first.task);
      let page = first.events;
      const events = [];
      do {
        events.push(...page.events.filter((event) => KEY_EVENTS.has(event.type)));
        cursors.set(target.task_id, page.nextCursor);
        if (!page.hasMore || events.length >= 100) break;
        page = readEvents(target.task_id, page.nextCursor, 100);
      } while (true);
      if (events.length) changes.push({ taskId: target.task_id,
        events: { events, nextCursor: cursors.get(target.task_id), hasMore: page.hasMore } });
    }
    if (changes.length || Date.now() >= deadline) return { tasks, changes,
      cursors: Object.fromEntries(cursors), timedOut: !changes.length };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function waitManaged(id, cursor = 0, seconds = 45, controllerIdValue) {
  const result = await waitManyManaged([{ task_id: id, cursor }], seconds, controllerIdValue);
  return { task: result.tasks[0], events: result.changes[0]?.events ||
    { events: [], nextCursor: result.cursors[id], hasMore: false }, timedOut: result.timedOut };
}

export async function suspendIdleManaged(id, controllerIdValue) {
  const task = ownership(id, controllerIdValue);
  await stopForMerge(task);
  writeTask({ ...readTask(id), state: "suspended" });
  appendEvent(id, { type: "session_suspended", reason: "为协作流程释放执行名额，保留会话与工作树" });
}

export function resumeManagedTask(id, controllerIdValue) {
  const task = ownership(id, controllerIdValue);
  return withSessionLock(task.sessionId, () => resumeManagedTaskUnlocked(id, controllerIdValue));
}

function resumeManagedTaskUnlocked(id, controllerIdValue) {
  const task = ownership(id, controllerIdValue);
  if (task.supersededBy) throw new Error(`该会话已由任务 ${task.supersededBy} 续接，请使用新的执行记录`);
  if (task.archivedAt) throw new Error("任务已归档，请先恢复记录与工作树");
  if (["merged", "timed_out"].includes(task.state)) throw new Error("已合并或达到运行上限的任务不能原样恢复");
  if ((task.elapsedMs || 0) >= (task.maxMinutes || 90) * 60_000) throw new Error("任务累计运行时间已达到上限，不能通过续接重置");
  const runtime = readRuntime(id);
  if (runtime?.status !== "exited" && isAlive(runtime?.pid) || task.state === "queued") return taskSummary(task);
  if (sessionReserved(task.sessionId, id)) throw new Error("该会话已由另一项任务占用，不能创建并发副本");
  if (isAlive(runtime?.claudePid) || claudeSessionStillRunning(task)) throw new Error("原 Claude 进程仍在或无法确认，恢复已暂停");
  const transcriptExists = managedTranscript(id, controllerIdValue, 200).available;
  const history = fs.existsSync(taskPath(id, "events.jsonl")) ? fs.readFileSync(taskPath(id, "events.jsonl"), "utf8") : "";
  const neverStarted = !/"type":"(?:launch_requested|process_started|instruction_written|UserPromptSubmit)"/.test(history);
  if (!transcriptExists && !neverStarted) throw new Error("没有可定位的会话记录，不能无损恢复");
  roleModel(task.source, task.kind, task.model || "inherit");
  ensurePtyRuntime();
  if (!neverStarted) task.initialPrompt = null;
  task.resume = transcriptExists; task.state = "queued";
  task.resumeQueue = recoverQueuedInstructions(task, runtime);
  task.settingsPath = prepareClaudeSettings(task);
  task.handbackCommand = prepareHandbackCommand(task);
  writeTask(task); appendEvent(id, { type: "session_resume_requested" });
  schedule(task.controllerId);
  return taskSummary(readTask(id));
}

export function pendingPermissions(id, controllerIdValue) {
  ownership(id, controllerIdValue);
  const folder = path.join(taskDir(id), "pending");
  let files; try { files = fs.readdirSync(folder); } catch { return []; }
  return files.filter((name) => /^[0-9a-f-]+\.json$/.test(name))
    .map((name) => readJson(path.join(folder, name))).filter(Boolean)
    .filter((pending) => !readJson(path.join(taskDir(id), "decisions", `${pending.id}.json`)));
}

export function decidePermission(id, decisionId, decision, reason, controllerIdValue) {
  const task = ownership(id, controllerIdValue);
  const runtime = readRuntime(id);
  if (task.state === "paused" || !runtime || runtime.status === "exited" || !isAlive(runtime.pid)) {
    throw new Error("原权限请求所属的 Claude 会话已暂停或退出，不能批准旧调用");
  }
  if (!/^[0-9a-f-]{36}$/i.test(decisionId)) throw new Error("无效的决定 ID");
  const pending = readJson(path.join(taskDir(id), "pending", `${decisionId}.json`));
  if (!pending) throw new Error("待决操作不存在");
  if (pending.kind === "user" && decision === "allow") throw new Error("该操作必须由用户在 Claude 窗口批准");
  if (!["allow", "deny"].includes(decision)) throw new Error("decision 只能是 allow 或 deny");
  writeJson(path.join(taskDir(id), "decisions", `${decisionId}.json`), { id: decisionId, decision, reason: reason || null });
  appendEvent(id, { type: "permission_answer_written", decisionId, decision });
  return { id: decisionId, decision };
}

export function openVisibleWindow(id, controllerIdValue) {
  const task = ownership(id, controllerIdValue);
  const runtime = readRuntime(id);
  if (!runtime?.terminalPipe || !isAlive(runtime.pid)) throw new Error("任务尚未启动");
  const result = launchVisibleWindow(task);
  appendEvent(id, { type: "visible_window_open_requested" });
  return result;
}

export async function waitUntilReady(id, controllerIdValue, seconds = 12) {
  ownership(id, controllerIdValue);
  const deadline = Date.now() + seconds * 1000;
  do {
    const runtime = readRuntime(id);
    if (runtime?.terminalPipe && runtime?.controlPipe && isAlive(runtime.pid)) return runtime;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error("桥接进程未在限定时间内就绪；请查看任务状态和 broker-error.log");
}
