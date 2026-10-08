import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MANAGED_ROOT, controllerId, listTasks, newTaskId, readJson, readTask, readRuntime, taskPath, writeJson } from "./managed-state.mjs";
import { projectIdentity } from "./managed-preferences.mjs";
import { cancelManaged, control, createManagedTask, createReviewTask, listManagedTasks,
  managedTranscript, mergeManaged, resumeManagedTask, suspendIdleManaged, taskSummary, waitUntilReady } from "./managed-service.mjs";

const ROOT = path.join(MANAGED_ROOT, "workflows");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function master(value) {
  const id = value || controllerId();
  if (!id) throw new Error("请提供 Codex 主控任务 ID");
  return String(id);
}
function file(id) {
  if (!UUID.test(String(id))) throw new Error("无效的协作流程 ID");
  return path.join(ROOT, `${id}.json`);
}
function owned(id, controller) {
  const value = readJson(file(id));
  if (!value || value.controllerId !== controller) throw new Error("协作流程不存在或不属于当前主控任务");
  return value;
}
function save(value) {
  value.updatedAt = new Date().toISOString();
  writeJson(file(value.id), value);
}
function note(value, type, itemId) {
  value.history = [...(value.history || []), { at: new Date().toISOString(), type, itemId: itemId || null }].slice(-30);
}
function itemOf(value, id) {
  const item = value.items.find((entry) => entry.id === id);
  if (!item) throw new Error("协作条目不存在");
  return item;
}
function recoverLinks(value) {
  // 进程在创建成功与写回流程之间退出时，通过持久任务关联恢复，绝不重派同一工作。
  for (const task of listTasks(value.controllerId).filter((task) => task.workflowId === value.id)) {
    const item = value.items.find((entry) => entry.id === task.workflowItemId);
    if (!item) continue;
    if (task.kind === "implementation" && !item.taskId) { item.taskId = task.id; item.stage = "implementing"; }
    if (task.kind === "review" && !item.reviewIds.includes(task.id)) {
      item.reviewIds.push(task.id); item.stage = "reviewing";
    }
  }
  for (const operation of Object.values(value.operations || {})) {
    if (operation.state === "done") continue;
    const tasks = listTasks(value.controllerId).filter((task) => task.workflowId === value.id &&
      task.workflowOperationId === operation.id);
    const item = value.items.find((entry) => entry.id === operation.itemId);
    let confirmed = operation.action === "dispatch" && value.items.length && value.items.every((entry) => entry.taskId);
    if (operation.action === "review") confirmed = tasks.some((task) => task.kind === "review") &&
      (!operation.suspendTaskId || readRuntime(operation.suspendTaskId)?.status === "exited");
    if (operation.action === "revise" && operation.commandId && item?.taskId) {
      try {
        confirmed = fs.readFileSync(taskPath(item.taskId, "events.jsonl"), "utf8").split("\n")
          .some((line) => { try { return JSON.parse(line).commandId === operation.commandId; } catch { return false; } });
      } catch {}
      if (confirmed && item.stage === "revision_pending") {
        item.repairs += 1; item.lastCommandId = operation.commandId; item.stage = "implementing";
      }
    }
    if (operation.action === "accept" && item && readTask(item.taskId)?.state === "merged") {
      item.stage = "delivered"; item.summary = operation.summary; confirmed = true;
    }
    if (confirmed) { operation.state = "done"; operation.error = null; }
  }
  if (value.items.length && value.items.every((item) => item.stage === "delivered")) value.stage = "delivered";
  for (const item of value.items) {
    const review = item.reviewIds?.length && readTask(item.reviewIds.at(-1));
    if (item.stage === "reviewing" && review && ["cancelled", "timed_out", "failed", "paused"].includes(review.state)) {
      item.stage = "review_blocked"; item.reviewFailure = review.state;
    }
  }
  if (!["paused", "cancelled", "delivered"].includes(value.stage) && value.items.some((i) => i.stage === "review_blocked")) value.stage = "needs_attention";
}
function brief(value, detail = false) {
  recoverLinks(value);
  return { id: value.id, controllerId: value.controllerId, cwd: value.cwd,
    title: value.goal.slice(0, 180), stage: value.stage,
    pendingOperations: Object.values(value.operations || {}).filter((item) => item.state !== "done")
      .map((item) => ({ id: item.id, action: item.action, state: item.state, error: item.error || null })),
    ...(detail ? { goal: value.goal, acceptance: value.acceptance } : {}),
    items: value.items.map((item) => {
      const task = item.taskId && readTask(item.taskId), runtime = item.taskId && readRuntime(item.taskId);
      const reviewId = item.reviewIds.at(-1) || null;
      const review = reviewId && readTask(reviewId);
      const reviewRuntime = reviewId && readRuntime(reviewId);
      const state = task ? taskSummary(task).state : null;
      let nextAction = item.stage === "planned" ? "派发实现" : "等待关键事件";
      if (item.stage === "implementing" && state === "idle") nextAction = "读取交付正文并决定审查";
      if (item.stage === "reviewing" && reviewRuntime?.status === "idle") nextAction = "读取审查结论，决定返工或验收";
      if (item.stage === "review_blocked") nextAction = "审查已中断，核对原因后显式重新审查";
      if (item.stage === "codex_work") nextAction = "Codex 接手修改，然后重新审查";
      if (item.stage === "revision_pending") nextAction = "核对返工指令的发送回执";
      if (item.stage === "conflict") nextAction = "解决合并冲突并提交，再调用 accept 确认交付";
      if (["failed", "paused", "timed_out"].includes(state) || runtime?.failure) nextAction = "核对失败或中断记录，不能自动重发";
      if (["starting", "running", "idle"].includes(state) && runtime?.owner === "human") nextAction = "等待用户交还控制权";
      if (task?.supersededBy) nextAction = "该会话已用于新任务，请核对新目标再处理原流程";
      const cleanupPending = item.stage === "delivered" && reviewId && !readTask(reviewId)?.worktreeRemoved && !readTask(reviewId)?.workspaceRetainedForReuse;
      if (item.stage === "delivered") nextAction = cleanupPending ? "已交付，审查目录待清理" : "已交付";
      return { id: item.id, label: item.label, stage: item.stage, taskId: item.taskId || null,
        reviewId, reviewState: review?.state || null, repairs: item.repairs, state, nextAction, supersededBy: task?.supersededBy || null, cursors: item.cursors || {},
        summary: item.summary || null, cleanupPending: Boolean(cleanupPending), error: item.error || null };
    }),
    ...(detail ? { history: value.history, operations: value.operations } : {}),
    updatedAt: value.updatedAt };
}
function list(controller) {
  let names; try { names = fs.readdirSync(ROOT); } catch { return []; }
  return names.filter((name) => UUID.test(name.slice(0, -5)) && name.endsWith(".json"))
    .map((name) => readJson(path.join(ROOT, name))).filter((value) => value?.controllerId === controller)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
function requestKey(args) {
  if (!args.request_id || typeof args.request_id !== "string" || args.request_id.length > 120) {
    throw new Error("改变流程的操作须提供稳定的 request_id，重试使用同一个 ID");
  }
  return args.request_id;
}
async function locked(id, fn) {
  const lock = `${file(id)}.lock`;
  try { fs.mkdirSync(lock); }
  catch {
    const owner = readJson(path.join(lock, "owner.json"));
    let alive = owner?.pid ? true : Date.now() - fs.statSync(lock).mtimeMs < 5000;
    if (owner?.pid) { try { process.kill(owner.pid, 0); } catch { alive = false; } }
    if (alive) throw new Error("协作流程正被另一个操作处理，请稍后使用同一 request_id 重试");
    if (fs.existsSync(path.join(lock, "owner.json"))) fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock); fs.mkdirSync(lock);
  }
  try { writeJson(path.join(lock, "owner.json"), { pid: process.pid }); }
  catch (error) { fs.rmdirSync(lock); throw error; }
  try { return await fn(); }
  finally { fs.unlinkSync(path.join(lock, "owner.json")); fs.rmdirSync(lock); }
}

export async function managedWorkflow(args = {}) {
  const controller = master(args.controller_id), action = args.action;
  if (action === "list") return { workflows: list(controller).map((value) => brief(value)) };
  if (action === "create") {
    const key = requestKey(args);
    if (!args.goal || typeof args.goal !== "string" || !args.goal.trim()) throw new Error("请提供明确的工作目标 goal");
    projectIdentity(args.cwd);
    const existing = list(controller).find((value) => value.createRequestId === key);
    if (existing) {
      if (existing.goal !== args.goal.trim() || existing.cwd !== path.resolve(args.cwd) || existing.acceptance !== String(args.acceptance || "")) throw new Error("request_id 已用于其他工作目标");
      return brief(existing);
    }
    const value = { id: newTaskId(), controllerId: controller, createRequestId: key,
      cwd: path.resolve(args.cwd), goal: args.goal.trim(), acceptance: String(args.acceptance || ""),
      stage: "planning", items: [], operations: {}, createdAt: new Date().toISOString() };
    note(value, "created"); save(value);
    return brief(value);
  }
  const value = owned(args.workflow_id, controller);
  if (action === "status") return brief(value, args.detail === true);
  if (action === "checkpoint") {
    return locked(value.id, async () => {
      const fresh = owned(value.id, controller); recoverLinks(fresh);
      for (const entry of args.cursors || []) {
        const item = fresh.items.find((item) => item.taskId === entry.task_id || item.reviewIds.includes(entry.task_id));
        if (!item) throw new Error("游标任务不属于此协作流程");
        const prior = item.cursors[entry.task_id] || {};
        if (entry.event_cursor !== undefined && (!Number.isInteger(entry.event_cursor) || entry.event_cursor < (prior.event || 0))) throw new Error("事件游标不能回退");
        const transcript = entry.transcript_cursor;
        if (transcript && (!Number.isInteger(transcript.message) || transcript.message < 0 ||
          !Number.isInteger(transcript.offset) || transcript.offset < 0 ||
          transcript.message < (prior.transcript?.message || 0) ||
          (transcript.message === prior.transcript?.message && transcript.offset < prior.transcript.offset))) throw new Error("正文游标无效或回退");
        item.cursors[entry.task_id] = { ...prior,
          ...(entry.event_cursor !== undefined ? { event: entry.event_cursor } : {}),
          ...(transcript ? { transcript } : {}) };
      }
      save(fresh); return brief(fresh);
    });
  }
  const key = requestKey(args);
  return locked(value.id, async () => {
    const fresh = owned(value.id, controller); recoverLinks(fresh);
    const signature = crypto.createHash("sha256").update(JSON.stringify({ ...args, request_id: undefined })).digest("hex");
    const prior = fresh.operations[key];
    if (prior) {
      if (prior.signature !== signature) throw new Error("request_id 已用于另一项操作");
      // 创建前的明确失败可重试；已创建的审查仍通过关联恢复，不能重复派发。
      const reviewNotCreated = action === "review" && !listTasks(controller).some((task) =>
        task.workflowId === fresh.id && task.workflowOperationId === key && task.kind === "review");
      if (!(prior.state === "failed" && (["dispatch", "revise"].includes(action) || reviewNotCreated))) {
      return { ...brief(fresh), operation: { id: key, state: prior.state, error: prior.error || null },
        ...(prior.state !== "done" ? { attention: "上次操作回执不明或失败，先核对已关联的任务；不能自动重复派发" } : {}) };
      }
    }
    if (["delivered", "cancelled"].includes(fresh.stage)) throw new Error("协作流程已结束");
    fresh.operations[key] = { id: key, signature, action, itemId: args.item_id || null, state: "running",
      summary: String(args.summary || args.verification || "").slice(0, 2000) };
    save(fresh);
    try {
      if (action === "dispatch") {
        const inputs = args.items || [{ label: "实现", prompt: fresh.goal }];
        if (!Array.isArray(inputs) || !inputs.length || inputs.length > 10) throw new Error("一次派发须包含 1 至 10 个独立条目");
        if (inputs.some((entry) => typeof entry.prompt !== "string" || !entry.prompt.trim())) throw new Error("每个条目必须有明确的 prompt");
        if (!fresh.items.length) {
          fresh.items = inputs.map((entry, index) => ({ id: newTaskId(), label: String(entry.label || `实现 ${index + 1}`),
            prompt: entry.prompt, model: entry.model, stage: "planned", repairs: 0, reviewIds: [], cursors: {} }));
        } else if (args.items) {
          if (inputs.length !== fresh.items.length) throw new Error("补齐派发须保留原条目数量");
          for (let index = 0; index < inputs.length; index++) {
            const item = fresh.items[index], input = inputs[index];
            if (item.taskId && (item.prompt !== input.prompt || item.model !== input.model)) throw new Error("已派发条目不能替换，请追加指令");
            if (!item.taskId) { item.prompt = input.prompt; item.model = input.model; }
          }
        }
        fresh.stage = "implementing"; save(fresh);
        for (const item of fresh.items) {
          if (item.taskId) continue;
          const prompt = `${item.prompt}\n\n交付要求：${fresh.acceptance || "完成后简短报告改动、检查结果和未完成事项"}`;
          const task = createManagedTask({ cwd: fresh.cwd, prompt, model: item.model,
            profile: args.profile, process_docs: args.process_docs,
            workflow_id: fresh.id, workflow_item_id: item.id, workflow_operation_id: key, controller_id: controller,
            visible: args.visible, max_minutes: args.max_minutes, permission_wait_seconds: args.permission_wait_seconds, max_turns: args.max_turns,
            subagent_limit: args.subagent_limit });
          item.taskId = task.id; item.stage = "implementing";
          note(fresh, "implementation_dispatched", item.id); save(fresh);
        }
      } else if (action === "review") {
        const item = itemOf(fresh, args.item_id);
        if (!item.taskId || !["implementing", "codex_work", "review_blocked"].includes(item.stage)) throw new Error("当前条目不在可审查阶段");
        const capacity = listManagedTasks(controller);
        const runtime = readRuntime(item.taskId);
        const needsSlot = capacity.running >= capacity.limit && runtime?.status !== "exited";
        if (needsSlot) { fresh.operations[key].suspendTaskId = item.taskId; save(fresh); }
        const review = createReviewTask(item.taskId, { controller_id: controller, model: args.model,
          focus: args.feedback, visible: args.visible, workflow_operation_id: key });
        item.reviewIds.push(review.id); item.stage = "reviewing"; fresh.stage = "reviewing";
        save(fresh);
        if (needsSlot) await suspendIdleManaged(item.taskId, controller);
        note(fresh, "review_dispatched", item.id);
      } else if (action === "revise") {
        const item = itemOf(fresh, args.item_id);
        if (!["reviewing", "revision_pending"].includes(item.stage)) throw new Error("当前条目不在返工阶段");
        if (!args.feedback?.trim()) throw new Error("返工需要明确的反馈");
        if (item.repairs >= 2) {
          item.stage = "codex_work"; fresh.stage = "codex_work";
          await suspendIdleManaged(item.reviewIds.at(-1), controller);
          await suspendIdleManaged(item.taskId, controller);
          note(fresh, "codex_takeover_required", item.id);
        } else {
          await suspendIdleManaged(item.reviewIds.at(-1), controller);
          const runtime = readRuntime(item.taskId);
          if (!runtime || runtime.status === "exited") resumeManagedTask(item.taskId, controller);
          await waitUntilReady(item.taskId, controller, 15);
          const raw = crypto.createHash("sha256").update(`${fresh.id}:${key}`).digest("hex").slice(0, 32);
          const commandId = `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
          fresh.operations[key].commandId = commandId;
          item.stage = "revision_pending";
          save(fresh);
          const sent = await control(item.taskId, { type: "send", prompt: args.feedback, commandId }, controller);
          if (!sent.ok) throw new Error(sent.error || "返工指令未被桥接器接受");
          item.repairs += 1; item.lastCommandId = commandId; item.stage = "implementing"; fresh.stage = "implementing";
          note(fresh, "revision_dispatched", item.id);
        }
      } else if (action === "accept") {
        const item = itemOf(fresh, args.item_id);
        if (!["reviewing", "conflict"].includes(item.stage)) throw new Error("当前条目尚未完成独立审查");
        if (!args.verification?.trim()) throw new Error("必须提供 Codex 的检查与验收结论");
        const result = await mergeManaged(item.taskId, item.reviewIds.at(-1), args.verification, controller);
        item.summary = String(args.summary || args.verification).slice(0, 2000);
        item.stage = result.conflict ? "conflict" : "delivered";
        fresh.stage = result.conflict ? "conflict" : fresh.items.every((item) => item.stage === "delivered") ? "delivered" : "implementing";
        note(fresh, result.conflict ? "merge_conflict" : "delivered", item.id);
      } else if (action === "pause") {
        fresh.beforePause = fresh.stage; fresh.stage = "paused"; note(fresh, "coordination_paused");
      } else if (action === "resume") {
        for (const operation of Object.values(fresh.operations)) {
          if (operation.state !== "done" && operation.action === "review" && operation.suspendTaskId) {
            await suspendIdleManaged(operation.suspendTaskId, controller);
          }
        }
        recoverLinks(fresh);
        fresh.stage = !fresh.items.length ? "planning"
          : fresh.items.every((item) => item.stage === "delivered") ? "delivered"
          : fresh.items.some((item) => item.stage === "conflict") ? "conflict"
          : fresh.items.some((item) => item.stage === "codex_work") ? "codex_work"
          : fresh.items.some((item) => ["reviewing", "revision_pending"].includes(item.stage)) ? "reviewing" : "implementing";
        note(fresh, "coordination_resumed");
      } else if (action === "cancel") {
        for (const item of fresh.items) for (const taskId of [item.taskId, ...item.reviewIds].filter(Boolean)) {
          const task = readTask(taskId), runtime = readRuntime(taskId);
          if (task.state === "queued" || (runtime && runtime.status !== "exited")) await cancelManaged(taskId, controller);
        }
        fresh.stage = "cancelled"; note(fresh, "cancelled");
      } else throw new Error("未知的协作流程操作");
      fresh.operations[key].state = "done"; save(fresh);
      return { ...brief(fresh), operation: { id: key, state: "done" } };
    } catch (error) {
      recoverLinks(fresh);
      fresh.operations[key].state = "failed"; fresh.operations[key].error = error.message;
      fresh.beforePause = fresh.stage; fresh.stage = "paused";
      note(fresh, "operation_failed"); save(fresh);
      throw error;
    }
  });
}
