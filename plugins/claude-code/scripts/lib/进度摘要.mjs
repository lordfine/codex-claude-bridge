import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MANAGED_ROOT, controllerId, listTasks, readJson, readRuntime } from "./managed-state.mjs";
import { coordinationConfig, effectiveProfile } from "./协作策略.mjs";
import { wakeStatus } from "./事件续接.mjs";
import { redactText } from "./会话读取.mjs";
import { statusResponse, validateStatusCursor } from "./状态响应.mjs";

const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
function needsAcceptance(backend, r, observer) {
  const accepted = readJson(path.join(MANAGED_ROOT, "acceptance", `${backend}-${r.id}.json`));
  return Boolean(observer?.handoffVerified && (accepted?.revision !== observer.handoffVerified.revision || accepted?.snapshot !== observer.handoffVerified.snapshot));
}
export function overview(args = {}) {
  const controller = args.controller_id || controllerId(); if (!controller) throw new Error("需要主控任务 ID");
  if (args.after_cursor !== undefined) args = { ...args, after_revision: validateStatusCursor(args.after_cursor, controller, "controller_overview") };
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
  const tasks = listTasks(controller).filter((r) => !r.archivedAt && !r.supersededBy).map((r) => {
    const runtime = readRuntime(r.id), observer = readJson(path.join(MANAGED_ROOT, "observers", `native-${r.id}.json`));
    return { backend: "native", taskId: r.id, sessionId: r.sessionId, workspace: r.cwd, profile: effectiveProfile(r), profileSource: r.coordinationProfile ? "session_override" : "controller", executor: r.kind === "review" ? "Claude 审查" : "Claude 执行", owner: runtime?.owner || "codex",
      state: runtime?.status === "exited" ? r.state : runtime?.status || r.state, phase: observer?.handoff?.phaseId || null,
      snapshot: observer?.handoffVerified?.snapshot || r.reviewRef || null, deliverySummary: redactText(observer?.handoff?.summary || "").slice(0, 300),
      needsAcceptance: needsAcceptance("native", r, observer), failure: runtime?.failure?.error || null, timing: { executionMs: runtime?.elapsedMs ?? r.elapsedMs ?? 0, waitingMs: runtime?.waitingMs ?? r.waitingMs ?? 0 } };
  });
  try { for (const name of fs.readdirSync(path.join(MANAGED_ROOT, "orca", "会话")).filter((n) => /^[0-9a-f-]{36}\.json$/i.test(n))) {
    const r = readJson(path.join(MANAGED_ROOT, "orca", "会话", name)); if (r?.controllerId !== controller || r.state !== "attached") continue;
    const observer = readJson(path.join(MANAGED_ROOT, "observers", `orca-${r.id}.json`));
    tasks.push({ backend: "orca", taskId: r.id, sessionId: r.sessionId, workspace: r.cwd, profile: effectiveProfile(r), profileSource: r.coordinationProfile ? "session_override" : "controller", executor: "Claude 执行", owner: r.owner || "codex", state: r.lastInstruction?.state || r.state,
      phase: observer?.handoff?.phaseId || null, snapshot: observer?.handoffVerified?.snapshot || null,
      deliverySummary: redactText(observer?.handoff?.summary || "").slice(0, 300), needsAcceptance: needsAcceptance("orca", r, observer), failure: observer?.probe?.error || null,
      binding: { state: observer?.probe?.stale ? "stale" : "observed", terminalId: r.terminalId }, terminalBlocker: r.terminalBlocker || null, uiDraft: r.uiDraft || null, activity: r.activityEvidence || null });
  } } catch {}
  const wake = wakeStatus(controller), revision = hash([tasks.map((t) => ({ ...t, activity: t.activity && { revision: t.activity.revision, suspectedStall: t.activity.suspectedStall } })), wake.enabled, wake.paused, wake.pending, wake.activeRunId]);
  const disconnected = tasks.some(t=>t.binding?.state==="stale"), needsAttention = Boolean(wake.paused || tasks.some(t=>t.terminalBlocker || t.failure || t.owner==="human"));
  const currentStatus = disconnected ? "disconnected" : needsAttention ? "needs_attention" : tasks.length && tasks.every(t=>["completed", "merged"].includes(t.state)) ? "completed" : tasks.length ? "running" : "idle";
  const flags = { currentStatus, completed: currentStatus === "completed" };
  if (args.after_revision === revision && !args.force) return statusResponse({ controllerId: controller, revision, unchanged: true, needsAttention, disconnected, nextAction: "结束本轮，等待交付或异常；用户主动查询时可读取细节" }, flags);
  return statusResponse({ controllerId: controller, profile: coordinationConfig(controller).profile, revision, tasks: tasks.slice(0, limit), truncated: tasks.length > limit, needsAttention, disconnected,
    wake: { enabled: wake.enabled, paused: wake.paused, effectiveState: wake.effectiveState, nextAction: wake.nextAction, pending: wake.pending, activeRunId: wake.activeRunId, attention: wake.attention },
    nextAction: wake.paused ? "读取续接诊断与审批待办" : "按执行线读取交付；无变化结束当前轮", warning: "这是登记的执行线；Codex 或用户在外部手工修改的成果需显式记录，不能归到原 Claude 会话" }, flags);
}

const recent = new Map();
export async function compactObservation(name, args, fn) {
  const orca = name === "delegate_orca" && ["read", "status"].includes(args.action);
  if (name !== "delegate_status" && !orca) return fn();
  const controller = args.controller_id || controllerId(), id = orca ? args.id : args.task_id;
  if (!/^[0-9a-f-]{36}$/i.test(id || "")) return fn();
  const r = orca ? readJson(path.join(MANAGED_ROOT, "orca", "会话", `${id}.json`)) : listTasks(controller).find((r) => r.id === id);
  if (!r || r.controllerId !== controller) return fn();
  const runtime = !orca && readRuntime(id), key = hash([name, { ...args, force: undefined }, controller]);
  let eventsSize = 0; try { eventsSize = fs.statSync(path.join(MANAGED_ROOT, "tasks", id, "events.jsonl")).size; } catch {}
  const signature = hash([r.state, r.owner, r.lastInstruction?.state, r.cancelRequested, r.controlRevision, r.terminalBlocker, runtime?.status, runtime?.failure, runtime?.owner, eventsSize]);
  const profile = r.coordinationProfile || coordinationConfig(controller).profile, cooldown = { low: 60000, medium: 15000, high: 3000 }[profile];
  const previous = recent.get(key);
  if (!args.force && previous?.signature === signature && Date.now() - previous.at < cooldown) return { content: [{ type: "text", text: JSON.stringify(statusResponse({ unchanged: true, taskId: id, incarnationId: r.incarnationId, revision: previous.revision || signature, lastInstruction: r.lastInstruction, owner: r.owner, terminalBlocker: r.terminalBlocker, nextAction: "结束本轮，等待阶段交付或关键异常", retryAfterMs: cooldown - (Date.now() - previous.at), forceForUserQuery: true })) }] };
  const result = await fn(); let response; try { response = JSON.parse(result.content?.[0]?.text); } catch {}
  if (!result.isError) recent.set(key, { signature, revision: response?.revision, at: Date.now() });
  if (recent.size > 1000) recent.delete(recent.keys().next().value);
  return result;
}
