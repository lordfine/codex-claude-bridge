import fs from "node:fs";
import { updateJson } from "./原子文件.mjs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { MANAGED_ROOT, controllerId, readJson, writeJson, readTask, writeTask } from "./managed-state.mjs";
import { redactText } from "./会话读取.mjs";
import { prepareReporter, reportPath } from "./主动回传.mjs";

export const PROFILES = { high: 1, medium: 2, low: 3 };
const LEVELS = { subtask: 1, milestone: 2, batch: 3, review: 3, final: 3 };
const URGENT = new Set(["instruction_failed", "StopFailure", "needs_input", "permission_pending", "permission_to_human",
  "recovery_uncertain", "recovery_failed", "recovery_exhausted", "session_start_blocked", "broker_lost_claude_alive", "config_changed",
  "time_limit_reached", "turn_limit_reached", "process_exit", "cancel_uncertain", "direction_changed", "binding_stale", "draft_blocked", "draft_cleared", "activity_stalled"]);
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
export const isUrgentEvent = (event) => URGENT.has(event.type);
const configFile = (master) => path.join(MANAGED_ROOT, "coordination", `${hash(master)}.json`);
export function validateProfile(value) {
  if (!Object.hasOwn(PROFILES, value)) throw new Error("协作档位须为 low、medium 或 high"); return value;
}
export function validateEffort(value) {
  if (!["inherit", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value)) throw new Error("未知思考等级"); return value;
}
export function coordinationConfig(master) {
  return { controllerId: master, profile: "medium", lightEffort: "low", deepEffort: "inherit", deepEffortOrigin: "pending", summaryChars: 1500,
    ...readJson(configFile(master)) };
}
export function effectiveProfile(task) { return task.coordinationProfile || coordinationConfig(task.controllerId).profile; }
export function shouldWake(task, event) {
  if (URGENT.has(event.type)) return true;
  if (event.type === "instruction_completed") return (LEVELS[event.level || task.lastInstruction?.deliveryLevel || "batch"] || 0) >= PROFILES[effectiveProfile(task)];
  if (["handback", "human_prompt_completed"].includes(event.type)) return true;
  if (event.type !== "stage_delivered") return false;
  if (event.requiresDecision === true) return true;
  return (LEVELS[event.level] || 0) >= PROFILES[effectiveProfile(task)];
}
export function eventEffort(config, events) {
  return events.length && events.every((e) => e.type === "context_sync") ? config.lightEffort : config.deepEffort;
}

function record(id, backend) {
  const r = backend === "orca" ? readJson(path.join(MANAGED_ROOT, "orca", "会话", `${id}.json`)) : readTask(id);
  if (!r) throw new Error("执行记录不存在"); return r;
}
function save(r, backend) { return backend === "orca" ? writeJson(path.join(MANAGED_ROOT, "orca", "会话", `${r.id}.json`), r) : writeTask(r); }
function validateId(id) { if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error("须提供精确执行记录 ID"); }
function folder(r) {
  validateId(r.id);
  if (!path.isAbsolute(r.cwd) || !fs.existsSync(r.cwd)) throw new Error("执行目录不存在");
  const result = path.join(r.cwd, ".协作记录", r.id);
  for (const p of [path.dirname(result), result]) if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error("过程记录目录不能是符号链接");
  fs.mkdirSync(result, { recursive: true });
  return result;
}
export function prepareRecordDocuments(r, taskText) {
  const dir = folder(r), ignore = path.join(r.cwd, ".gitignore");
  if (fs.existsSync(ignore) && fs.lstatSync(ignore).isSymbolicLink()) throw new Error("不能自动修改符号链接的 gitignore");
  const previous = fs.existsSync(ignore) ? fs.readFileSync(ignore, "utf8") : "";
  let ignoreEdit = r.processDocuments?.ignoreEdit || null;
  if (!previous.split(/\r?\n/).some((line) => line.trim() === ".协作记录/")) {
    const after = previous + (previous && !previous.endsWith("\n") ? "\n" : "") + ".协作记录/\n";
    ignoreEdit = { existed: fs.existsSync(ignore), before: previous, after };
    fs.writeFileSync(ignore, after, "utf8");
  }
  const plan = path.join(dir, "任务说明.md");
  if (!fs.existsSync(plan)) fs.writeFileSync(plan, `# 任务说明\n\n执行记录：${r.id}\n\n${redactText(taskText || "目标与验收条件由主控补充。")}\n`, "utf8");
  return { directory: dir, plan, handoff: path.join(dir, "当前交付.md"), checks: path.join(dir, "验证记录.md"), ignoreEdit };
}

// 稳定快照包括提交与工作文件内容；协作记录自身不参与，避免写记录反过来改变快照。
export function workspaceFingerprint(cwd) {
  let values = [];
  const digestFile = (file) => {
    const digest = crypto.createHash("sha256"), fd = fs.openSync(file, "r"), buffer = Buffer.alloc(65536);
    try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count)); }
    finally { fs.closeSync(fd); } return digest.digest("hex");
  };
  try {
    const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 2_000_000 }).split("\0").filter(Boolean);
    values.push(["提交", execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim()]);
    for (const name of [...new Set(files)].sort()) {
      if (name.startsWith(".协作记录/")) continue;
      const file = path.resolve(cwd, name);
      if (!file.startsWith(path.resolve(cwd) + path.sep) || !fs.existsSync(file)) { values.push([name, "缺失"]); continue; }
      if (fs.lstatSync(file).isSymbolicLink()) { values.push([name, fs.readlinkSync(file)]); continue; }
      if (fs.statSync(file).isFile()) values.push([name, digestFile(file)]);
    }
    return hash(JSON.stringify(values));
  } catch { values = []; }
  const walk = (dir, depth = 0) => {
    if (depth > 12 || values.length > 20000) throw new Error("工作目录过大，请指定清楚的执行范围");
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", ".协作记录", ".venv", "__pycache__", ".本地", "dist", "build"].includes(e.name) || e.isSymbolicLink()) continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file, depth + 1);
      else if (e.isFile()) values.push([path.relative(cwd, file), digestFile(file)]);
    }
  };
  walk(cwd); values.sort((a, b) => a[0].localeCompare(b[0]));
  return hash(JSON.stringify(values));
}
export function readHandoff(r) {
  const file = path.join(r.cwd, ".协作记录", r.id, "当前交付.md");
  let body; try { const stat = fs.statSync(file); if (stat.size > 32768) return { invalid: "交付单超过 32 KiB" }; body = fs.readFileSync(file, "utf8"); } catch { return null; }
  const match = body.match(/```json\s*([\s\S]*?)```/);
  let data; try { data = JSON.parse(match?.[1] || ""); } catch { return { invalid: "交付单缺少可解析 JSON" }; }
  if (data.task_id !== r.id || typeof data.phase_id !== "string" || data.phase_id.length > 80 || !Object.hasOwn(LEVELS, data.level) || typeof data.summary !== "string" || data.summary.length > 1500 || !Array.isArray(data.checks) || !Array.isArray(data.unresolved)) return { invalid: "交付单字段不完整或身份不符" };
  if (data.session_id && data.session_id !== r.sessionId || data.request_id && r.lastInstruction && data.request_id !== r.lastInstruction.requestId) return { invalid: "交付单属于其他会话或旧请求" };
  const snapshot = workspaceFingerprint(r.cwd);
  if (!data.snapshot || data.snapshot !== "capture" && data.snapshot !== snapshot) return { invalid: "工作目录与交付快照不一致" };
  return { phaseId: data.phase_id, level: data.level, requiresDecision: data.requires_decision === true,
    summary: redactText(data.summary), checks: data.checks.slice(0, 12).map((s) => redactText(String(s)).slice(0, 240)),
    unresolved: data.unresolved.slice(0, 12).map((s) => redactText(String(s)).slice(0, 240)), snapshot, capture: data.snapshot === "capture",
    requestId: data.request_id || null, reportId: data.report_id || null, reportStatus: data.report_status || null, revision: hash(body), file };
}

export function deliveryInstruction(r, docs, reporterOptions = {}) {
  if (r.lastInstruction?.requestId && r.sessionId) {
    const reporter = prepareReporter(r, reporterOptions);
    r.reporter = reporter;
    const route = r.reportMcpConfig ? "调用 claude-bridge-report 的 report 工具。" : `运行以下 CLI（JSON 参数写入回传.json）：\n${reporter.cli}`;
    return `\n\n## 交付\n阶段边界与交付前，用${r.reportMcpConfig ? `inbox 工具，参数request_id=${r.lastInstruction.requestId}` : `CLI：${reporter.cli.replace('--input "回传.json"', '--inbox')}`}读取补充证据；有证据时判断并用ack确认采用，参数为request_id和evidence_id，不循环轮询。\n完成、受阻或需要决定时，${route}\n`
      + `回传参数：${JSON.stringify({ request_id: r.lastInstruction.requestId, report_key: "本次唯一编号", status: "completed", summary: "结果摘要", checks: ["实际检查结果"], unresolved: [] })}。受阻用 blocked，需决定用 needs_decision。收据仅表示已保存，不代表验收通过；无需轮询收据。\n详细证据保存到 ${docs.checks}。`;
  }
  const contract = { task_id: r.id, phase_id: "自定义且不可重复的阶段编号", level: "batch", requires_decision: true,
    summary: "本阶段完成项和改动范围，最多1500字", checks: ["实际执行的检查及结果"], unresolved: [], snapshot: "capture" };
  return `\n协作约定：进度不需要反复询问主控。普通明确错误在任务范围内自行修复，重复失败、方向冲突或需要决定时交付给主控。\n`
    + `在 ${docs.handoff} 写短交付单，包含 JSON 代码块：${JSON.stringify(contract)}。`
    + "子任务进度level=subtask，里程碑=milestone，完整实现批次=batch，独立审查=review，最终交付=final。"
    + "可继续执行时requires_decision=false；需主控决定或完整交付时为true。snapshot=capture由本地观察器核验稳定工作目录，不自行宣称所有后台任务已停止。详细检查证据放验证记录.md。";
}

export function coordinationControl(args = {}) {
  const master = args.controller_id || controllerId(); if (!master) throw new Error("请提供 Codex 主控 ID");
  if (args.action === "status") return coordinationConfig(master);
  if (args.action === "configure") {
    const next = coordinationConfig(master);
    if (args.profile !== undefined) next.profile = validateProfile(args.profile);
    if (args.deep_effort !== undefined) { next.deepEffort = validateEffort(args.deep_effort); next.deepEffortOrigin = args.effort_origin || "user"; }
    writeJson(configFile(master), next); return next;
  }
  validateId(args.task_id);
  const backend = args.backend || "native"; if (!["native", "orca"].includes(backend)) throw new Error("未知执行后端");
  const r = record(args.task_id, backend); if (r.controllerId !== master) throw new Error("执行记录不属于当前主控");
  if (["evidence", "evidence_status", "background_role"].includes(args.action)) {
    if (args.action === "background_role" && args.role === "released") {
      const saved = r.retainedServices?.[args.background_id];
      if (!saved || saved.requestId !== args.request_id || !args.reason?.trim()) throw new Error("解除保留须提供原请求、后台编号和已停止或已交接的依据");
      delete r.retainedServices[args.background_id]; save(r, backend);
      return { backgroundId: args.background_id, retentionReleased: true, processStopped: false, evidence: redactText(args.reason).slice(0, 500) };
    }
    if (!args.request_id || r.lastInstruction?.requestId !== args.request_id) throw new Error("须提供当前逻辑请求号，不操作旧轮");
    if (args.action === "background_role") {
      const job = Object.entries(r.observation?.background || {}).find(([key, value]) => key === args.background_id || value.taskId === args.background_id);
      if (!job || !["service", "work"].includes(args.role) || !args.reason?.trim()) throw new Error("须选择已登记后台任务、角色及理由");
      r.lastInstruction.backgroundRoles ||= {};
      r.lastInstruction.backgroundRoles[job[0]] = { role: args.role, reason: redactText(args.reason).slice(0, 500) };
      r.retainedServices ||= {};
      if (args.role === "service") r.retainedServices[job[0]] = { requestId: args.request_id, taskId: job[1].taskId, reason: redactText(args.reason).slice(0, 500) };
      else delete r.retainedServices[job[0]];
      save(r, backend);
      return { taskId: r.id, backgroundId: job[0], role: args.role, processStopped: false, message: "只更新阻塞策略，不终止后台进程" };
    }
    const file = path.join(MANAGED_ROOT, "evidence", crypto.createHash("sha256").update(`${backend}:${r.id}:${args.request_id}`).digest("hex") + ".json");
    if (args.action === "evidence_status") return { entries: (readJson(file)?.entries || []).map(({ text, ...item }) => ({ ...item, state: item.acknowledgedAt ? "acknowledged" : item.readAt ? "read" : "saved" })), modelCalls: 0 };
    if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(args.evidence_id || "") || typeof args.text !== "string" || !args.text.trim() || args.text.length > 3000) throw new Error("补充证据须有唯一编号和不超过3000字正文");
    const text = redactText(args.text);
    updateJson(file, old => {
      const entries = old?.entries || [], existing = entries.find(i => i.id === args.evidence_id);
      if (existing) { if (existing.text !== text) throw new Error("同一证据编号内容变化，请使用新编号"); return undefined; }
      if (entries.length >= 100) throw new Error("本轮证据过多，请整理后开启明确的新任务");
      return { entries: [...entries, { id: args.evidence_id, text, at: new Date().toISOString() }] };
    });
    return { id: args.evidence_id, state: "saved", requestId: args.request_id, message: "已存入本轮证据箱；Claude在下一协作检查点读取，不保证立即打断当前工具" };
  }
  if (args.action === "report") {
    if (!/^[a-f0-9]{64}$/.test(args.report_id || "")) throw new Error("回传编号无效");
    const report = readJson(reportPath(MANAGED_ROOT, backend, r.id, args.report_id));
    if (!report || report.taskId !== r.id || report.controllerId !== master || report.backend !== backend || report.sessionId !== r.sessionId) throw new Error("回传不属于此执行会话");
    return { reportId: report.reportId, requestId: report.requestId, at: report.at, ...report.data, acceptance: "not_verified" };
  }
  if (args.action === "profile") { r.coordinationProfile = args.profile === "inherit" ? null : validateProfile(args.profile); save(r, backend); return { taskId: r.id, profile: effectiveProfile(r) }; }
  if (args.action === "prepare") return { taskId: r.id, profile: effectiveProfile(r), ...prepareRecordDocuments(r, args.task_text) };
  if (args.action === "snapshot") return { taskId: r.id, snapshot: workspaceFingerprint(r.cwd) };
  if (args.action === "handoff") {
    const handoff = readHandoff(r), observed = readJson(path.join(MANAGED_ROOT, "observers", `${backend}-${r.id}.json`));
    const ready = Boolean(handoff && !handoff.invalid && observed?.handoffVerified?.revision === handoff.revision && observed.handoffVerified.snapshot === handoff.snapshot);
    return { taskId: r.id, handoff, readyForReview: ready, message: ready ? "已观察到稳定交付" : "交付单不是单独的审查就绪证明" };
  }
  throw new Error("未知协作策略操作");
}
