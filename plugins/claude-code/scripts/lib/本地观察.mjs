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

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
export async function observeLocalRecords(controller, { root = MANAGED_ROOT, observe = readTurn, probe = probeOrcaRecord, now = Date.now() } = {}) {
  let orca = [];
  try { orca = fs.readdirSync(path.join(root, "orca", "会话")).filter((n) => /^[0-9a-f-]{36}\.json$/i.test(n)).map((n) => readJson(path.join(root, "orca", "会话", n))).filter((r) => r?.controllerId === controller && r.state === "attached"); } catch {}
  const native = root === MANAGED_ROOT ? listTasks(controller).filter((r) => !r.archivedAt && !r.supersededBy && !["merged", "cancelled"].includes(r.state)) : [];
  let changes = 0, errors = 0;
  for (const [backend, records] of [["orca", orca], ["native", native]]) for (const r of records) {
    const stateFile = path.join(root, "observers", `${backend}-${r.id}.json`), previous = readJson(stateFile) || {};
    if (previous.retryAfter > now) continue;
    const next = { ...previous };
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
      if (next.probe.stale) emit("binding_stale", `${r.runtimeId}:${r.terminalId}:${next.probe.code || "stale"}`);
      if (next.probe.error) emit("recovery_uncertain", `${r.runtimeId}:${r.terminalId}:${next.probe.error}`);
      if (next.probe.needsInput) emit("needs_input", `${r.lastInstruction?.requestId}:${next.probe.revision}`);
      if (next.probe.draft) emit("draft_blocked", `${r.terminalId}:${next.probe.draftEvidence?.fingerprint || next.probe.revision || "unknown"}`);
      if (previous.probe?.draft && !next.probe.draft && !next.probe.stale && !next.probe.error) emit("draft_cleared", `${r.terminalId}:${previous.probe.draftEvidence?.fingerprint || "unknown"}`);
      const recordFile = path.join(root, "orca", "会话", `${r.id}.json`), fresh = readJson(recordFile);
      if (fresh?.state === "attached" && fresh.controlRevision === r.controlRevision) {
        fresh.terminalBlocker = next.probe.stale ? { kind: "binding_stale", code: next.probe.code || "BINDING_STALE" } : next.probe.error ? { kind: "probe_error", code: next.probe.error } : next.probe.draft ? { kind: "draft", ...(next.probe.draftEvidence || { present: true, source: "unknown" }) } : null;
        writeJson(recordFile, fresh);
      }
    }
    if (backend === "orca" && r.lastInstruction && !["cancelled", "human_handoff"].includes(r.lastInstruction.terminalState)) {
      const request = r.lastInstruction.requestId;
      if (next.requestId !== request) { next.requestId = request; next.observation = r.observation || {}; next.handoff = null; }
      const turn = observe(r.sessionId, r.cwd, r.lastInstruction, next.observation || {}); next.observation = turn;
      if (turn.notificationBoundaryRepaired) next.humanActivity = null;
      completed = turn.completed && !turn.failed && !turn.changed && !turn.gap && !turn.ambiguous;
      if (turn.backgroundOutstanding && turn.completed) { emit("needs_input", `${request}:background_unverified`); completed = false; }
      if (turn.failed) emit("instruction_failed", request);
      if (turn.changed || turn.gap || turn.ambiguous && !turn.nextUserObserved) emit("recovery_uncertain", request);
      completed = completed && !next.probe?.busy && !next.probe?.stale && !next.probe?.error && !next.probe?.draft;
      if (completed && !turn.nextUserObserved && r.owner !== "human") emit("instruction_completed", request);
      if (turn.logged) {
        const recordFile = path.join(root, "orca", "会话", `${r.id}.json`), fresh = readJson(recordFile);
        if (fresh?.lastInstruction?.requestId === request && fresh.state === "attached" && fresh.controlRevision === r.controlRevision) {
          fresh.observation = turn; fresh.lastInstruction.state = turn.failed ? "failed" : completed ? "completed" : "logged";
          if (turn.notificationBoundaryRepaired) fresh.humanActivity = null;
          if (turn.nextUserObserved) fresh.owner = "human";
          fresh.revision = hash(JSON.stringify([fresh.lastInstruction.state, turn.text, turn.ambiguous, turn.changed, turn.available, fresh.owner, fresh.cancelRequested, turn.backgroundOutstanding]));
          writeJson(recordFile, fresh);
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
          writeJson(recordFile, fresh);
        }
        if (activity.userCount && activity.completed) {
          const checked = await probe(r); next.probe = checked;
          if (!checked.busy && !checked.stale && !checked.draft && !checked.error) emit("human_prompt_completed", activity.lastUserUuid, { humanCursor: activity.firstUserCursor });
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
    if (previous.faultId) {
      const file = path.join(wakeDir(root, controller), "faults", `${previous.faultId}.json`), fault = readWakeJson(file);
      if (fault?.state === "active") writeWakeJson(file, { ...fault, state: "observation_recovered", recoveredAt: new Date().toISOString() });
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
