import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MANAGED_ROOT, listTasks, readJson, writeJson, readRuntime } from "./managed-state.mjs";
import { readTurn, probeOrcaRecord } from "./Orca会话.mjs";
import { readHandoff } from "./协作策略.mjs";
import { enqueueWakeEvent, wakeDir, readWakeJson, writeWakeJson } from "./事件队列.mjs";
import { recordSchedulerFault } from "./续接诊断.mjs";
import { attentionNotice } from "./本地提醒.mjs";
import { observeHumanActivity } from "./会话读取.mjs";
import { logActivity } from "./日志活动.mjs";
import { coordinationConfig } from "./协作策略.mjs";
import { updateJson } from "./原子文件.mjs";

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
export async function observeLocalRecords(controller, { root = MANAGED_ROOT, observe = readTurn, probe = probeOrcaRecord, now = Date.now() } = {}) {
  let orca = [];
  try { orca = fs.readdirSync(path.join(root, "orca", "会话")).filter((n) => /^[0-9a-f-]{36}\.json$/i.test(n)).map((n) => readJson(path.join(root, "orca", "会话", n))).filter((r) => r?.controllerId === controller && r.state === "attached"); } catch {}
  const native = root === MANAGED_ROOT ? listTasks(controller).filter((r) => !r.archivedAt && !r.supersededBy && !["merged", "cancelled"].includes(r.state)) : [];
  let changes = 0, errors = 0;
  for (const [backend, records] of [["orca", orca], ["native", native]]) for (const r of records) {
    const stateFile = path.join(root, "observers", `${backend}-${r.id}.json`), previous = readJson(stateFile) || {};
    if (previous.retryAfter > now) continue;
    const next = { ...previous, completionCandidate: null };
    try {
    const emit = (type, key, extra = {}) => {
      const eventId = hash(`${backend}:${r.id}:${key}:${type}`);
      if (next.emitted?.includes(eventId)) return;
      const event = { type, eventId, backend, requestId: r.lastInstruction?.requestId || null, at: new Date(now).toISOString(), ...extra };
      // 原始事件只包含定位信息，正文和工具日志保留在原文件里。
      const file = path.join(root, "observers", `${backend}-${r.id}.events.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
      next.emitted = [...(next.emitted || []), eventId].slice(-2000);
      enqueueWakeEvent(root, r.id, event); changes++;
    };
    let completed = false;
    if (next.controlRevision !== r.controlRevision) { next.observation = r.observation || {}; next.humanActivity = r.humanActivity || null; next.controlRevision = r.controlRevision; }
    if (backend === "orca" && now - (next.lastProbeAt || 0) >= 5000) {
      try { next.probe = await probe(r); }
      catch (error) { next.probe = { error: error.code || "PROBE_FAILED" }; }
      next.lastProbeAt = now;
      const blockingInput = Boolean(next.probe.inputPending || next.probe.draft && next.probe.draftKind !== "orca_ui_composer");
      if (next.probe.stale) emit("binding_stale", `${r.runtimeId}:${r.terminalId}:${next.probe.code || "stale"}`);
      if (next.probe.error) emit("recovery_uncertain", `${r.runtimeId}:${r.terminalId}:${next.probe.error}`);
      if (next.probe.needsInput) emit("needs_input", `${r.lastInstruction?.requestId}:${next.probe.revision}`);
      const ownedEcho = next.probe.draftEvidence?.source === "bridge_submission_echo";
      if (blockingInput && !ownedEcho) emit("draft_blocked", `${r.terminalId}:${next.probe.draftEvidence?.fingerprint || next.probe.revision || "unknown"}`);
      const confirmedDraft = previous.probe?.draftEvidence?.source === "bridge_submission_echo" || Boolean(r.draftSubmission && r.lastInstruction && r.draftSubmission.requestId === r.lastInstruction.requestId && Date.now() - Date.parse(r.draftSubmission.at || "") < 30000);
      if (previous.probe?.draft && previous.probe.draftKind !== "orca_ui_composer" && !next.probe.draft && !next.probe.stale && !next.probe.error && !confirmedDraft) emit("draft_cleared", `${r.terminalId}:${previous.probe.draftEvidence?.fingerprint || "unknown"}`);
      const recordFile = path.join(root, "orca", "会话", `${r.id}.json`), fresh = readJson(recordFile);
      if (fresh?.state === "attached" && fresh.controlRevision === r.controlRevision) {
        fresh.uiDraft = next.probe.uiDraft || null;
        fresh.terminalBlocker = next.probe.stale ? { kind: "binding_stale", code: next.probe.code || "BINDING_STALE" } : next.probe.error ? { kind: "probe_error", code: next.probe.error } : blockingInput && !ownedEcho ? { kind: "terminal_input", ...(next.probe.draftEvidence || { present: true, source: "unknown" }) } : null;
        updateJson(recordFile, (current) => current?.controlRevision === r.controlRevision && current?.state === "attached" ? { ...current, uiDraft: fresh.uiDraft, terminalBlocker: fresh.terminalBlocker } : undefined);
      }
    }
    if (backend === "orca" && r.lastInstruction && !["cancelled", "human_handoff"].includes(r.lastInstruction.terminalState)) {
      const request = r.lastInstruction.requestId;
      if (next.requestId !== request) { next.requestId = request; next.observation = r.observation || {}; next.handoff = null; }
      const turn = observe(r.sessionId, r.cwd, r.lastInstruction, next.observation || {}); next.observation = turn;
      try { next.activity = logActivity(r.sessionId, r.cwd, { now, quietMs: (coordinationConfig(controller).stallSeconds || 900) * 1000 }); }
      catch { next.activity = { available: false, evidence: "main_and_subagent_jsonl" }; }
      if (turn.notificationBoundaryRepaired) next.humanActivity = null;
      completed = turn.completed && !turn.failed && !turn.changed && !turn.gap && !turn.ambiguous;
      if (turn.backgroundOutstanding) completed = false;
      if (turn.failed) emit("instruction_failed", request);
      if (turn.changed || turn.gap || turn.ambiguous && !turn.nextUserObserved) emit("recovery_uncertain", request);
      completed = completed && !next.probe?.busy && !next.probe?.stale && !next.probe?.error && !next.probe?.inputPending && (!next.probe?.draft || next.probe.draftKind === "orca_ui_composer" || next.probe.draftEvidence?.source === "bridge_submission_echo");
      next.completionCandidate = completed && !turn.nextUserObserved && r.owner !== "human" ? request : null;
      if (turn.logged && (!turn.completed || turn.backgroundOutstanding) && r.owner !== "human" && !next.probe?.stale && !next.probe?.draft && next.activity?.suspectedStall) emit("activity_stalled", `${request}:${next.activity.revision}`);
      if (turn.logged) {
        const recordFile = path.join(root, "orca", "会话", `${r.id}.json`), fresh = readJson(recordFile);
        if (fresh?.lastInstruction?.requestId === request && fresh.state === "attached" && fresh.controlRevision === r.controlRevision) {
          fresh.observation = turn; fresh.lastInstruction.state = turn.failed ? "failed" : completed ? "completed" : "logged";
          fresh.activityEvidence = next.activity;
          if (turn.notificationBoundaryRepaired) fresh.humanActivity = null;
          if (turn.nextUserObserved) fresh.owner = "human";
          fresh.revision = hash(JSON.stringify([fresh.lastInstruction.state, turn.text, turn.ambiguous, turn.changed, turn.available, fresh.owner, fresh.cancelRequested, turn.backgroundOutstanding]));
          updateJson(recordFile, (current) => current?.controlRevision === r.controlRevision && current?.lastInstruction?.requestId === r.lastInstruction?.requestId && current?.state === "attached" ? { ...current, observation: fresh.observation, lastInstruction: { ...current.lastInstruction, state: fresh.lastInstruction.state }, activityEvidence: fresh.activityEvidence, owner: fresh.owner, revision: fresh.revision, humanActivity: fresh.humanActivity } : undefined);
        }
      }
    } else if (backend === "native") {
      const runtime = readRuntime(r.id);
      completed = Boolean(runtime && !runtime.busy && !runtime.activeSubagents?.length && !runtime.humanDraft && !runtime.humanQueued && !runtime.queue?.length);
    }
    if (backend === "orca" && !r.cancelRequested) {
      const boundary = next.observation?.humanBoundary;
      const saved = next.observation?.notificationBoundaryRepaired ? { cursor: boundary || next.observation.cursor, background: next.observation.background || {} } : r.humanActivity || next.humanActivity || { cursor: boundary || r.managementCursor || r.observation?.cursor || { offset: r.lastInstruction?.baseline || 0 }, background: next.observation?.background || r.observation?.background || {} };
      // 原指令仍在执行时由其观察器定位人类边界，避免把桥接器自己的指令算作人类输入。
      if (boundary || r.owner === "human" || r.lastInstruction?.terminalState === "human_handoff" || !r.lastInstruction) {
        const activity = observeHumanActivity(r.sessionId, r.cwd, saved); next.humanActivity = activity;
        const recordFile = path.join(root, "orca", "会话", `${r.id}.json`), fresh = readJson(recordFile);
        if (fresh?.state === "attached" && fresh.controlRevision === r.controlRevision && fresh.lastInstruction?.requestId === r.lastInstruction?.requestId) {
          fresh.humanActivity = activity;
          if (activity.userCount && !activity.changed && !activity.gap) fresh.owner = "human";
          updateJson(recordFile, (current) => current?.controlRevision === r.controlRevision && current?.lastInstruction?.requestId === r.lastInstruction?.requestId && current?.state === "attached" ? { ...current, humanActivity: activity, owner: fresh.owner } : undefined);
        }
        if (activity.userCount && activity.completed) {
          const checked = await probe(r); next.probe = checked;
          if (!checked.busy && !checked.stale && (!checked.draft || checked.draftKind === "orca_ui_composer") && !checked.inputPending && !checked.error) emit("human_prompt_completed", activity.lastUserUuid, { humanCursor: activity.firstUserCursor });
        }
      }
    }
    const handoffFile = path.join(r.cwd || "", ".协作记录", r.id, "当前交付.md");
    let signature; try { const s = fs.statSync(handoffFile); signature = `${s.size}:${s.mtimeMs}`; } catch {}
    if (signature && (signature !== next.handoffSignature || next.pendingHandoff)) {
      let handoff; try { handoff = readHandoff(r); } catch { handoff = { invalid: "快照核验失败" }; }
      if (handoff?.invalid) { next.handoffInvalid = handoff.invalid; next.pendingHandoff = null; }
      else if (handoff) {
        if (!handoff.requiresDecision) emit("stage_delivered", handoff.phaseId, { level: handoff.level, phaseId: handoff.phaseId, requiresDecision: false });
        else if (completed && next.pendingHandoff?.revision === handoff.revision && next.pendingHandoff?.snapshot === handoff.snapshot) {
          emit("stage_delivered", handoff.phaseId, { level: handoff.level, phaseId: handoff.phaseId, requiresDecision: true }); next.pendingHandoff = null;
          next.handoffVerified = { revision: handoff.revision, snapshot: handoff.snapshot };
        } else next.pendingHandoff = { revision: handoff.revision, snapshot: handoff.snapshot };
        next.handoff = handoff; next.handoffInvalid = null;
      }
      next.handoffSignature = signature;
    }
    next.checkedAt = now; next.retryAfter = null;
    if (backend === "orca" && next.completionCandidate && !next.pendingHandoff && r.lastInstruction.kind !== "compact") emit("instruction_completed", next.completionCandidate, { level: r.lastInstruction.deliveryLevel || "batch" });
    if (previous.faultId) {
      const file = path.join(wakeDir(root, controller), "faults", `${previous.faultId}.json`), fault = readWakeJson(file);
      if (fault?.state === "active") {
        const recoveredAt = new Date().toISOString();
        writeWakeJson(file, { ...fault, state: "observation_recovered", recoveredAt });
        const noticeFile = path.join(wakeDir(root, controller), "attention.json"), notice = readWakeJson(noticeFile);
        if (notice?.faultId === fault.id) writeWakeJson(noticeFile, { ...notice, state: "observation_recovered", recoveredAt, requiresAction: false });
      }
    }
    next.faultId = null; writeJson(stateFile, next);
    } catch (error) {
      errors++;
      const fault = recordSchedulerFault(wakeDir(root, controller), error, { stage: "observe_record", taskId: r.id, backend }, { notify: attentionNotice });
      // 不覆盖最后有效游标或交付；仅该记录退避，其他记录继续观察。
      writeJson(stateFile, { ...previous, faultId: fault.id, retryAfter: now + 5000, lastObservationErrorAt: new Date().toISOString() });
    }
  }
  return { changes, observed: orca.length + native.length, errors, modelCalls: 0 };
}
