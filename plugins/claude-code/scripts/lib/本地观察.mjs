import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MANAGED_ROOT, listTasks, readJson, writeJson, readRuntime } from "./managed-state.mjs";
import { readTurn, probeOrcaRecord } from "./Orca会话.mjs";
import { readHandoff } from "./协作策略.mjs";
import { enqueueWakeEvent } from "./事件队列.mjs";

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
export async function observeLocalRecords(controller, { root = MANAGED_ROOT, observe = readTurn, probe = probeOrcaRecord, now = Date.now() } = {}) {
  let orca = [];
  try { orca = fs.readdirSync(path.join(root, "orca", "会话")).filter((n) => /^[0-9a-f-]{36}\.json$/i.test(n)).map((n) => readJson(path.join(root, "orca", "会话", n))).filter((r) => r?.controllerId === controller && r.state === "attached"); } catch {}
  const native = root === MANAGED_ROOT ? listTasks(controller).filter((r) => !r.archivedAt && !r.supersededBy && !["merged", "cancelled"].includes(r.state)) : [];
  let changes = 0;
  for (const [backend, records] of [["orca", orca], ["native", native]]) for (const r of records) {
    const stateFile = path.join(root, "observers", `${backend}-${r.id}.json`), previous = readJson(stateFile) || {};
    const next = { ...previous };
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
    if (backend === "orca" && r.lastInstruction && r.lastInstruction.terminalState !== "cancelled") {
      const request = r.lastInstruction.requestId;
      if (next.requestId !== request) { next.requestId = request; next.observation = {}; next.handoff = null; }
      const turn = observe(r.sessionId, r.cwd, r.lastInstruction, next.observation || {}); next.observation = turn;
      completed = turn.completed && !turn.failed && !turn.changed && !turn.gap && !turn.ambiguous;
      if (turn.backgroundOutstanding && turn.completed) { emit("needs_input", `${request}:background_unverified`); completed = false; }
      if (turn.failed) emit("instruction_failed", request);
      if (turn.changed || turn.gap || turn.ambiguous) emit("recovery_uncertain", request);
      if (now - (next.lastProbeAt || 0) >= 5000) {
        try {
          next.probe = await probe(r); next.lastProbeAt = now;
          if (next.probe.stale) emit("recovery_uncertain", `${request}:stale`);
          if (next.probe.needsInput) emit("needs_input", `${request}:${next.probe.revision}`);
        } catch (error) { next.probe = { error: error.code || "PROBE_FAILED" }; emit("recovery_uncertain", `${request}:${next.probe.error}`); }
      }
      completed = completed && !next.probe?.busy && !next.probe?.stale && !next.probe?.error;
      if (completed && !turn.nextUserObserved && r.owner !== "human") emit("instruction_completed", request);
      if (turn.logged) {
        const recordFile = path.join(root, "orca", "会话", `${r.id}.json`), fresh = readJson(recordFile);
        if (fresh?.lastInstruction?.requestId === request && fresh.state === "attached" && fresh.controlRevision === r.controlRevision) {
          fresh.observation = turn; fresh.lastInstruction.state = turn.failed ? "failed" : completed ? "completed" : "logged";
          if (turn.nextUserObserved || next.probe?.draft) fresh.owner = "human";
          fresh.revision = hash(JSON.stringify([fresh.lastInstruction.state, turn.text, turn.ambiguous, turn.changed, turn.available, fresh.owner, fresh.cancelRequested, turn.backgroundOutstanding]));
          writeJson(recordFile, fresh);
        }
      }
    } else if (backend === "native") {
      const runtime = readRuntime(r.id);
      completed = Boolean(runtime && !runtime.busy && !runtime.activeSubagents?.length && !runtime.humanDraft && !runtime.humanQueued && !runtime.queue?.length);
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
    next.checkedAt = now; writeJson(stateFile, next);
  }
  return { changes, observed: orca.length + native.length, modelCalls: 0 };
}
