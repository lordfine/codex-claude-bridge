import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { MANAGED_ROOT, readJson, writeJson } from "./managed-state.mjs";
import { updateJson, atomicText } from "./原子文件.mjs";
import { redactText } from "./会话读取.mjs";
import { enqueueWakeEvent, wakeDir } from "./事件队列.mjs";

const digest = (s) => crypto.createHash("sha256").update(s).digest("hex");
const entry = fileURLToPath(new URL("../执行回传.mjs", import.meta.url));

export function prepareReportSession(record, { root = MANAGED_ROOT, backend = "orca" } = {}) {
  const file = path.join(root, "report-bindings", `${backend}-${record.id}.session.json`);
  writeJson(file, { scope: "session", root, backend, taskId: record.id, sessionId: record.sessionId, controllerId: record.controllerId });
  const config = file + ".mcp.json";
  writeJson(config, { mcpServers: { "claude-bridge-report": { command: process.execPath, args: [entry, "--context", file, "--mcp"] } } });
  return config;
}

export function resolveReportContext(context, requestId) {
  const session = readJson(context);
  if (session?.scope !== "session") return context;
  if (typeof requestId !== "string" || !requestId || requestId.length > 120) throw new Error("会话回传须携带本轮 request_id，不能猜测当前请求");
  const file = path.join(session.root, "report-bindings", `${digest(`${session.backend}:${session.taskId}:${requestId}`)}.json`);
  const binding = readJson(file);
  if (!binding || binding.sessionId !== session.sessionId || binding.controllerId !== session.controllerId || binding.taskId !== session.taskId) throw new Error("请求不属于此回传会话");
  return file;
}

// 每份入口绑定一项委派。调用者只提交结果，不能指定其他主控。
export function prepareReporter(record, { root = MANAGED_ROOT, backend = "orca", requestId = record.lastInstruction?.requestId } = {}) {
  if (!requestId || !record.sessionId || !record.controllerId) throw new Error("回传入口缺少精确会话、请求或主控绑定");
  const key = digest(`${backend}:${record.id}:${requestId}`);
  const file = path.join(root, "report-bindings", `${key}.json`);
  const binding = { root, backend, taskId: record.id, sessionId: record.sessionId, requestId, controllerId: record.controllerId, cwd: record.cwd };
  const old = readJson(file);
  if (old && JSON.stringify(old) !== JSON.stringify(binding)) throw new Error("回传绑定已存在且不匹配");
  if (!old) writeJson(file, binding);
  const config = path.join(root, "report-bindings", `${key}.mcp.json`);
  writeJson(config, { mcpServers: { "claude-bridge-report": { command: process.execPath, args: [entry, "--context", file, "--mcp"] } } });
  return { context: file, mcpConfig: config, cli: `node "${entry}" --context "${file}" --input "回传.json"` };
}

export function loadBinding(file, allowRetired = false) {
  const b = readJson(file);
  if (!b || !["orca", "native"].includes(b.backend) || !/^[0-9a-f-]{36}$/i.test(b.taskId || "")) throw new Error("回传绑定无效");
  const record = readJson(b.backend === "orca" ? path.join(b.root, "orca", "会话", `${b.taskId}.json`) : path.join(b.root, "tasks", b.taskId, "task.json"));
  if (!record || record.sessionId !== b.sessionId || record.controllerId !== b.controllerId || record.cwd !== b.cwd || !allowRetired && (record.archivedAt || record.supersededBy)) throw new Error("回传绑定已失效");
  return { b, record };
}

export function executorInbox(context, evidenceId) {
  const { b, record } = loadBinding(context);
  if (record.lastInstruction?.requestId !== b.requestId) throw new Error("请求已切换，不领取旧轮补充证据");
  const file = path.join(b.root, "evidence", digest(`${b.backend}:${b.taskId}:${b.requestId}`) + ".json");
  let result;
  updateJson(file, old => {
    const entries = old?.entries || [];
    if (evidenceId) {
      const item = entries.find(i => i.id === evidenceId);
      if (!item || !item.readAt) throw new Error("证据不存在或尚未读取，不能确认采用");
      item.acknowledgedAt ||= new Date().toISOString();
      result = { id: item.id, state: "acknowledged", message: "执行端确认采用；不等于修改或验收完成" };
    } else {
      const pending = entries.filter(i => !i.acknowledgedAt).slice(0, 8);
      for (const item of pending) item.readAt ||= new Date().toISOString();
      result = { requestId: b.requestId, entries: pending, more: entries.filter(i => !i.acknowledgedAt).length > pending.length, modelCalls: 0 };
    }
    return { entries };
  });
  return result;
}

export function reportReceipt(context, reportId) {
  const { b } = loadBinding(context, true);
  if (!/^[a-f0-9]{64}$/.test(reportId || "")) throw new Error("回执编号无效");
  const report = readJson(path.join(b.root, "reports", reportId + ".json"));
  if (!report || report.bindingKey !== digest(JSON.stringify(b))) throw new Error("回执不属于本次委派");
  const folder = wakeDir(b.root, b.controllerId), queueId = digest(`${b.taskId}:${report.eventId}`);
  const ack = readJson(path.join(folder, "ack", `${queueId}.json`));
  const latest = readJson(path.join(b.root, "reports", `${digest(JSON.stringify(b))}.index.json`))?.latest;
  return { reportId, requestId: b.requestId, saved: true, delivery: ack ? "processed" : fs.existsSync(path.join(folder, "queue", `${queueId}.json`)) ? "queued" : latest && latest !== reportId ? "superseded" : "pending_observation",
    acceptance: "not_verified", processedAt: ack?.at || null, modelCalls: 0 };
}

export function submitReport(context, input) {
  const { b, record } = loadBinding(context);
  if (b.backend === "orca" && (record.state !== "attached" || record.lastInstruction?.requestId !== b.requestId)) throw new Error("请求已切换或执行线已释放，不把迟到结果归入新请求");
  if (b.backend === "native") {
    const runtime = readJson(path.join(b.root, "tasks", b.taskId, "runtime.json"));
    if (runtime?.current?.id !== b.requestId) throw new Error("原生执行请求已变化，须使用当前轮回传入口");
  }
  if (!input || !["completed", "blocked", "needs_decision", "progress"].includes(input.status) || !/^[\p{L}\p{N}_-]{1,80}$/u.test(input.report_key || "") || typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 1500) throw new Error("回传须包含唯一 report_key、status 和不超过1500字的 summary");
  for (const field of ["checks", "unresolved"]) if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].length > 12 || input[field].some(s => typeof s !== "string" || s.length > 1000))) throw new Error("检查与遗留问题须为最多12项短文本");
  const level = input.level || "batch";
  if (!["subtask", "milestone", "batch", "review", "final"].includes(level)) throw new Error("交付级别无效");
  const data = { status: input.status, report_key: input.report_key, level, summary: redactText(input.summary), checks: (input.checks || []).map(redactText), unresolved: (input.unresolved || []).map(redactText) };
  const reportId = digest(`${JSON.stringify(b)}:${data.report_key}`), phase = `report-${reportId.slice(0, 40)}`;
  const urgent = ["blocked", "needs_decision"].includes(data.status);
  const eventId = urgent ? reportId : digest(`${b.backend}:${b.taskId}:${phase}:stage_delivered`);
  const file = path.join(b.root, "reports", `${reportId}.json`);
  let duplicate = false;
  updateJson(path.join(b.root, "reports", `${digest(JSON.stringify(b))}.index.json`), index => {
    const old = readJson(file);
    if (old) { if (JSON.stringify(old.data) !== JSON.stringify(data)) throw new Error("同一 report_key 内容变化；修订结果须使用新编号"); duplicate = true; return undefined; }
  const handoff = path.join(b.cwd, ".协作记录", b.taskId, "当前交付.md");
  // 重试已保存回执不覆盖随后产生的新交付。
  if (!duplicate) {
    for (const p of [path.dirname(path.dirname(handoff)), path.dirname(handoff), handoff]) if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error("交付路径不能为符号链接");
    fs.mkdirSync(path.dirname(handoff), { recursive: true });
    const contract = { task_id: b.taskId, session_id: b.sessionId, request_id: b.requestId, report_id: reportId, report_status: data.status, phase_id: phase, level,
      requires_decision: urgent || data.status === "completed" && ["batch", "review", "final"].includes(level), summary: data.summary, checks: data.checks, unresolved: data.unresolved, snapshot: "capture" };
    atomicText(handoff, `# 执行回传\n\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n`);
  }
    writeJson(file, { reportId, bindingKey: digest(JSON.stringify(b)), eventId, requestId: b.requestId, taskId: b.taskId, backend: b.backend, controllerId: b.controllerId, sessionId: b.sessionId, data, at: new Date().toISOString() });
    return { latest: reportId, previous: index?.latest || null };
  });
  if (urgent) enqueueWakeEvent(b.root, b.taskId, { type: "needs_input", eventId, reportId, backend: b.backend, requestId: b.requestId, at: new Date().toISOString(), requiresDecision: true });
  return { ...reportReceipt(context, reportId), duplicate };
}
