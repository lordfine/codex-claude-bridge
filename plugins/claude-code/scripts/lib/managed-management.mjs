import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { MANAGED_ROOT, appendEvent, controllerId, listTasks, readJson, readRuntime, readTask,
  taskDir, taskPath, writeJson, writeTask } from "./managed-state.mjs";
import { cancelManaged, claudeSessionStillRunning, control, listManagedTasks, managedTranscript,
  openVisibleWindow, resumeManagedTask, suspendIdleManaged, taskSummary } from "./managed-service.mjs";
import { withSessionLock } from "./managed-lock.mjs";
import { removeHandbackCommand } from "./managed-config.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED = new Set(["merged", "exited", "cancelled", "failed", "timed_out"]);
function master(value) {
  const id = value || controllerId(); if (!id) throw new Error("请提供当前 Codex 主控任务 ID"); return String(id);
}
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function archivedGit(record, source, ...args) {
  if (!record.gitDir) return git(source, ...args);
  return execFileSync("git", ["--git-dir", record.gitDir, ...args], { cwd: MANAGED_ROOT,
    windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function alive(pid) { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch { return false; } }
function native(file) { return fs.realpathSync.native(file); }

export function resolveManagedReference(reference, controller) {
  const owner = master(controller);
  if (UUID.test(String(reference))) {
    const task = readTask(reference);
    if (!task || task.controllerId !== owner) throw new Error("任务不存在或不属于当前主控");
    return task;
  }
  const matches = listTasks(owner).filter((task) => task.alias?.toLowerCase() === String(reference).trim().toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? "别名有多个匹配，请从列表选择精确任务 ID" : "别名未找到，请先查看任务列表");
  return matches[0];
}

export function checkAlias(alias, controller, exceptId) {
  const value = String(alias || "").trim();
  if (!value || value.length > 60 || /[\x00-\x1f]/.test(value) || UUID.test(value)) throw new Error("别名须为 1 至 60 个字符，且不能是会话 UUID");
  if (listTasks(master(controller)).some((task) => task.id !== exceptId && task.alias?.toLowerCase() === value.toLowerCase())) throw new Error("该别名已被当前主控的另一项任务使用");
  return value;
}
export function labelTask(reference, alias, controller) {
  const task = resolveManagedReference(reference, controller), value = checkAlias(alias, controller, task.id);
  task.alias = value; writeTask(task); appendEvent(task.id, { type: "alias_changed", alias: value });
  return taskSummary(task);
}
function linkedWorkflow(task) {
  if (!task.workflowId) return null;
  if (!UUID.test(task.workflowId)) throw new Error("任务的协作流程关联无效");
  return readJson(path.join(MANAGED_ROOT, "workflows", `${task.workflowId}.json`));
}
function checkWorkflowArchive(task) {
  const workflow = linkedWorkflow(task);
  if (task.workflowId && (!workflow || !["delivered", "cancelled"].includes(workflow.stage))) throw new Error("协作流程尚未交付或取消，归档会影响续接，请先处理该流程");
}
function ownedWorkspace(task) {
  if (!task.worktree) return false;
  return path.resolve(task.cwd) === path.resolve(MANAGED_ROOT, task.kind === "review" ? "reviews" : "worktrees", task.id) &&
    path.resolve(task.worktree) === path.resolve(task.cwd);
}
function sharedWorkspace(task) {
  const normalized = (value) => { try { return native(value).toLowerCase(); } catch { return path.resolve(value).toLowerCase(); } };
  const target = normalized(task.cwd);
  return listTasks().some((other) => {
    if (other.id === task.id || normalized(other.cwd || ".") !== target) return false;
    const runtime = readRuntime(other.id);
    return !other.archivedAt && (["queued", "starting"].includes(other.state) || runtime?.status !== "exited" && alive(runtime?.pid));
  });
}

export function archiveTask(reference, controller, summary, cleanup = true, noReuse = false) {
  const selected = resolveManagedReference(reference, controller);
  return withSessionLock(selected.sessionId, () => {
    const task = readTask(selected.id), runtime = readRuntime(task.id);
    checkWorkflowArchive(task);
    if (task.state === "queued" || task.state === "starting" && runtime?.status !== "exited" ||
      runtime?.status !== "exited" && alive(runtime?.pid) || claudeSessionStillRunning(task)) throw new Error("会话仍在运行或无法确认，先结束执行再归档");
    if (sharedWorkspace(task)) throw new Error("该目录正被另一项续接任务使用，归档已暂停");
    removeHandbackCommand(task, task.handbackCommand?.owned);
    const report = managedTranscript(task.id, task.controllerId, 4000);
    let head = null; try { head = git(task.cwd, "rev-parse", "HEAD"); } catch {}
    const snapshot = task.archivedAt ? task.archive?.snapshotRef || head || task.reviewRef : head || task.reviewRef || task.archive?.snapshotRef;
    const record = { ...task.archive, summary: String(summary || (task.archivedAt && task.archive?.summary) || report.messages.at(-1)?.text || task.archive?.summary ||
      "会话已结束，暂无可读取的交付正文").slice(0, 4000), snapshotRef: snapshot,
      stateBeforeArchive: task.archivedAt ? task.archive?.stateBeforeArchive || task.state : task.state,
      cwdRemoved: task.archive?.cwdRemoved || Boolean(ownedWorkspace(task) && snapshot && !fs.existsSync(task.cwd)), cleanupReason: null };
    if (!record.gitDir) {
      const origin = task.reviewOf && readTask(task.reviewOf);
      const directory = [task.cwd, task.source, origin?.source].find((candidate) => candidate && fs.existsSync(candidate));
      try { record.gitDir = native(git(directory, "rev-parse", "--path-format=absolute", "--git-common-dir")); } catch {}
    }
    task.archive = record; task.archivedAt = task.archivedAt || new Date().toISOString();
    // 先保存交付与恢复信息，再执行可重试的目录清理。
    writeTask(task); appendEvent(task.id, { type: "task_archived" });
    if (cleanup && !record.cwdRemoved && fs.existsSync(task.cwd)) {
      if (!ownedWorkspace(task)) record.cleanupReason = "既有或非托管目录保留";
      else if (task.workspaceRetainedForReuse) record.cleanupReason = "目录已用于会话复用，保留原目录";
      else {
        const root = native(path.join(MANAGED_ROOT, task.kind === "review" ? "reviews" : "worktrees"));
        const target = native(task.cwd);
        if (path.dirname(target) !== root) record.cleanupReason = "真实目录不在托管清理范围，保留";
        else {
          if (noReuse && task.processDocuments) {
            const processDir = path.join(target, ".协作记录", task.id);
            const names = ["任务说明.md", "当前交付.md", "验证记录.md"];
            if (fs.existsSync(processDir) && !fs.lstatSync(path.dirname(processDir)).isSymbolicLink() && !fs.lstatSync(processDir).isSymbolicLink() &&
              fs.readdirSync(processDir).every(name => names.includes(name) && fs.lstatSync(path.join(processDir, name)).isFile() && !fs.lstatSync(path.join(processDir, name)).isSymbolicLink())) {
              const saved = path.join(taskDir(task.id), "交付留档"); fs.mkdirSync(saved, { recursive: true });
              for (const name of fs.readdirSync(processDir)) fs.copyFileSync(path.join(processDir, name), path.join(saved, name));
              for (const name of fs.readdirSync(processDir)) fs.unlinkSync(path.join(processDir, name));
              fs.rmdirSync(processDir);
              if (!fs.readdirSync(path.dirname(processDir)).length) fs.rmdirSync(path.dirname(processDir));
            }
            const edit = task.processDocuments.ignoreEdit, ignore = path.join(target, ".gitignore");
            if (edit && !fs.existsSync(path.dirname(processDir)) && fs.existsSync(ignore) && !fs.lstatSync(ignore).isSymbolicLink() && fs.readFileSync(ignore, "utf8") === edit.after) {
              let tracked = null; try { tracked = git(target, "show", "HEAD:.gitignore"); } catch {}
              if (tracked === null && !edit.existed) fs.unlinkSync(ignore);
              else if (tracked !== null && tracked === edit.before.trimEnd()) fs.writeFileSync(ignore, edit.before, "utf8");
            }
          }
          if (git(task.cwd, "status", "--porcelain", "--ignored")) record.cleanupReason = "存在未提交或忽略文件，保留目录";
          else {
            let included = task.kind === "review";
            if (!included && snapshot) {
              try { git(task.source, "merge-base", "--is-ancestor", snapshot, "HEAD"); included = true; } catch {}
            }
            if (!included) record.cleanupReason = "工作提交尚未进入目标分支，保留目录";
            else {
              try {
                archivedGit(record, task.source, "worktree", "remove", task.cwd);
                if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
                record.cwdRemoved = !fs.existsSync(task.cwd);
                if (!record.cwdRemoved) record.cleanupReason = "目录仍被占用，可稍后重试清理";
              } catch (error) { record.cleanupReason = `清理未完成：${error.message}`; }
            }
          }
        }
      }
    }
    if (cleanup && noReuse && record.cwdRemoved && ownedWorkspace(task) && task.branch?.startsWith("codex/") && !record.branchRemoved) {
      try { archivedGit(record, task.source, "branch", "-d", "--", task.branch); record.branchRemoved = true; }
      catch { record.branchCleanupReason = "分支仍有未合入提交、被占用或已不存在，未强制删除"; }
    }
    writeTask(task);
    return { id: task.id, alias: task.alias || null, archived: true, cwdRemoved: record.cwdRemoved, branchRemoved: record.branchRemoved || false, branchCleanupReason: record.branchCleanupReason || null,
      cleanupReason: record.cleanupReason, summary: record.summary.slice(0, 300) };
  });
}

export function restoreTask(reference, controller) {
  const selected = resolveManagedReference(reference, controller);
  return withSessionLock(selected.sessionId, () => {
    const task = readTask(selected.id);
    if (!task.archivedAt) return task;
    if (task.archive?.cwdRemoved) {
      if (!ownedWorkspace(task) || !/^[0-9a-f]{40,64}$/i.test(task.archive.snapshotRef || "")) throw new Error("缺少可验证的托管快照，不能恢复目录");
      if (fs.existsSync(task.cwd)) {
        let completed = false;
        try {
          const common = native(git(task.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
          const actual = native(task.cwd);
          const registered = archivedGit(task.archive, task.source, "worktree", "list", "--porcelain", "-z").split("\0")
            .filter((line) => line.startsWith("worktree ")).some((line) => {
              try { return native(line.slice(9)) === actual; } catch { return false; }
            });
          completed = registered && common === native(task.archive.gitDir) && git(task.cwd, "rev-parse", "HEAD") === task.archive.snapshotRef;
          if (completed) task.branch = git(task.cwd, "branch", "--show-current") || task.branch;
        } catch {}
        if (!completed) throw new Error("归档目录已被其他内容占用，恢复不会覆盖它");
      } else {
      let originalBranch = false;
      if (task.branch) {
        try {
          originalBranch = archivedGit(task.archive, task.source, "rev-parse", `refs/heads/${task.branch}`) === task.archive.snapshotRef &&
            !archivedGit(task.archive, task.source, "worktree", "list", "--porcelain", "-z").split("\0").includes(`branch refs/heads/${task.branch}`);
        } catch {}
      }
      if (originalBranch) archivedGit(task.archive, task.source, "worktree", "add", task.cwd, task.branch);
      else {
        const branch = `codex/claude-restore-${task.id.slice(0, 8)}-${crypto.randomBytes(3).toString("hex")}`;
        archivedGit(task.archive, task.source, "worktree", "add", "-b", branch, task.cwd, task.archive.snapshotRef); task.branch = branch;
      }
      }
      task.archive.cwdRemoved = false;
    }
    if (!fs.existsSync(task.cwd)) throw new Error("原目录不存在，需先恢复原目录后再续接");
    task.archivedAt = null; task.archive.restoredAt = new Date().toISOString();
    writeTask(task); appendEvent(task.id, { type: "task_restored" }); return task;
  });
}

export function queueInstruction(reference, prompt, requestId, controller) {
  const selected = resolveManagedReference(reference, controller);
  return withSessionLock(selected.sessionId, () => queueInstructionUnlocked(readTask(selected.id), prompt, requestId));
}

function queueInstructionUnlocked(task, prompt, requestId) {
  if (task.supersededBy) throw new Error(`会话已由任务 ${task.supersededBy} 续接，请向新的执行记录追加指令`);
  if (task.archivedAt || CLOSED.has(task.state)) throw new Error("会话已结束或归档，请先恢复或复用会话");
  if (!String(prompt || "").trim() || !requestId || typeof requestId !== "string" || requestId.length > 120) throw new Error("追加指令需要 prompt 与稳定 request_id");
  const hash = crypto.createHash("sha256").update(`${task.controllerId}:${task.id}:${requestId}`).digest("hex").slice(0, 32);
  const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20)}`;
  const text = String(prompt).trim(), promptHash = crypto.createHash("sha256").update(text).digest("hex");
  const folder = path.join(taskDir(task.id), "inbox"), file = path.join(folder, `${id}.json`);
  const prior = readJson(file);
  let events = [];
  try { events = fs.readFileSync(taskPath(task.id, "events.jsonl"), "utf8").split("\n")
    .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((event) => event?.commandId === id); } catch {}
  const known = prior || events.find((event) => event.promptHash);
  if (known && known.promptHash !== promptHash) throw new Error("request_id 已用于另一条指令");
  if (prior || events.length) return { id: task.id, commandId: id, state: events.at(-1)?.type || "inbox_queued", duplicate: true };
  const counter = taskPath(task.id, "inbox-counter.json"), order = (readJson(counter)?.next || 0) + 1;
  writeJson(counter, { next: order });
  writeJson(file, { id, prompt: text, promptHash, order, createdAt: new Date().toISOString() });
  appendEvent(task.id, { type: "instruction_inbox_queued", commandId: id, promptHash });
  return { id: task.id, commandId: id, state: "inbox_queued" };
}

export async function manageTasks(args = {}) {
  const controller = master(args.controller_id), action = args.action;
  if (action === "list") {
    const list = listManagedTasks(controller, args.include_archived === true);
    const tasks = list.tasks.filter((task) => (!args.workflow_id || task.workflowId === args.workflow_id) && (!args.completed || CLOSED.has(task.state)) && (!args.query || `${task.alias || ""} ${task.title} ${task.cwd} ${task.sessionId}`
      .toLowerCase().includes(String(args.query).toLowerCase())));
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50), offset = Math.max(Number(args.offset) || 0, 0);
    return { controllerId: controller, limit: list.limit, running: list.running, queueOrder: list.queueOrder,
      tasks: tasks.slice(offset, offset + limit), total: tasks.length, nextOffset: offset + limit < tasks.length ? offset + limit : null };
  }
  let references = args.task_ids;
  if ([args.task_ids !== undefined, args.completed === true, Boolean(args.workflow_id)].filter(Boolean).length !== 1) throw new Error("批量操作须明确选择任务、流程或已结束集合中的一种");
  if (args.completed === true) references = listTasks(controller).filter((task) => !task.archivedAt && !task.supersededBy && CLOSED.has(task.state) &&
    (!task.workflowId || ["delivered", "cancelled"].includes(linkedWorkflow(task)?.stage))).slice(0, 50).map((task) => task.id);
  if (args.workflow_id) {
    if (!UUID.test(args.workflow_id)) throw new Error("协作流程 ID 无效");
    const workflow = readJson(path.join(MANAGED_ROOT, "workflows", `${args.workflow_id}.json`));
    if (!workflow || workflow.controllerId !== controller) throw new Error("协作流程不属于当前主控");
    references = workflow.items.flatMap((item) => [item.taskId, ...item.reviewIds]).filter(Boolean);
  }
  if (!Array.isArray(references) || references.length > 50 || !references.length && !args.completed) throw new Error("须选择 1 至 50 个任务或已结束任务集合");
  const selected = references.map((reference) => {
    try { return resolveManagedReference(reference, controller); }
    catch (error) { return { id: null, reference, selectionError: error.message }; }
  });
  const validIds = selected.filter((task) => !task.selectionError).map((task) => task.id);
  if (new Set(validIds).size !== validIds.length) throw new Error("选择中有重复任务");
  if (action === "label" && selected.length !== 1) throw new Error("设置别名一次只选择一项任务");
  if (action === "archive") selected.sort((a, b) => Number(b.kind === "review") - Number(a.kind === "review"));
  const results = [];
  for (const task of selected) {
    try {
      if (task.selectionError) throw new Error(task.selectionError);
      let result;
      if (action === "label") result = labelTask(task.id, args.alias, controller);
      else if (action === "send") result = queueInstruction(task.id, args.prompt, args.request_id, controller);
      else if (action === "takeover") result = await control(task.id, { type: "takeover", immediate: args.immediate === true }, controller);
      else if (action === "cancel") result = await cancelManaged(task.id, controller);
      else if (action === "suspend") { await suspendIdleManaged(task.id, controller); result = { state: "suspended" }; }
      else if (action === "restore") result = taskSummary(restoreTask(task.id, controller));
      else if (action === "resume") { if (task.archivedAt) restoreTask(task.id, controller); result = resumeManagedTask(task.id, controller); }
      else if (action === "archive") {
        checkWorkflowArchive(task);
        if (readRuntime(task.id)?.status === "idle") await suspendIdleManaged(task.id, controller);
        result = archiveTask(task.id, controller, args.summary, args.cleanup !== false, args.no_reuse_confirmed === true);
      }
      else if (action === "open") result = readRuntime(task.id)?.connected && !args.reconnect ? { alreadyVisible: true } : openVisibleWindow(task.id, controller);
      else throw new Error("未知管理操作");
      if (result?.ok === false) throw new Error(result.error || "桥接器拒绝本次操作");
      results.push({ taskId: task.id, alias: task.alias || null, ok: true, result });
    } catch (error) { results.push({ taskId: task.id, alias: task.alias || null, ok: false, error: error.message,
      ...(task.selectionError ? { reference: task.reference } : {}) }); }
  }
  return { action, succeeded: results.filter((entry) => entry.ok).length, failed: results.filter((entry) => !entry.ok).length, results };
}
