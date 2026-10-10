import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { MANAGED_ROOT, readJson, writeJson } from "./managed-state.mjs";
import { wakeDir } from "./事件队列.mjs";
import { findSession } from "./会话读取.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const names = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const jsonFiles = dir => names(dir).filter(n => n.endsWith(".json")).map(n => readJson(path.join(dir, n))).filter(Boolean);
const finite = n => Number.isFinite(n) && n >= 0;
const usageKeys = ["input_tokens", "cached_input_tokens", "output_tokens"];
const emptyUsage = () => Object.fromEntries(usageKeys.map(k => [k, 0]));
const add = (target, source) => { for (const key of Object.keys(target)) target[key] += finite(source?.[key]) ? source[key] : 0; };

function findRollout(home, controller) {
  const matches = [];
  const walk = (dir, depth = 0) => {
    if (depth > 5) return;
    for (const name of names(dir)) {
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (name.endsWith(`${controller}.jsonl`)) matches.push(file);
    }
  };
  walk(path.join(home, "sessions")); walk(path.join(home, "archived_sessions"));
  return matches.length === 1 ? matches[0] : null;
}

// 原文只在本地逐行解析；证据包不保存聊天、工具参数、命令、回复或原始错误文本。
async function scan(file, visit, sources, warnings, kind, maxBytes) {
  const source = { id: `来源${sources.length + 1}`, kind, lines: 0, malformed: 0, bytes: 0, complete: false };
  sources.push(source);
  if (!file) { warnings.push(`${source.id}：记录不可访问或定位不唯一`); return source; }
  let stream, reader;
  const digest = crypto.createHash("sha256");
  try {
    const size = fs.statSync(file).size;
    stream = fs.createReadStream(file, { start: 0, end: Math.max(0, Math.min(size, maxBytes) - 1) });
    reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) {
      source.lines++; source.bytes += Buffer.byteLength(line) + 1; digest.update(line + "\n");
      if (line.length > 2_000_000) { source.malformed++; continue; }
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { source.malformed++; continue; }
      visit(row, { source: source.id, line: source.lines });
    }
    source.complete = size <= maxBytes && source.malformed === 0;
    source.contentDigest = digest.digest("hex");
    if (!source.complete) warnings.push(`${source.id}：存在截断或不可解析行，统计仅覆盖可读取部分`);
  } catch { warnings.push(`${source.id}：读取失败，未复制原始错误`); }
  finally { reader?.close(); stream?.destroy(); }
  return source;
}

export async function collectIteration(options = {}) {
  const root = options.root || MANAGED_ROOT, controller = options.controller || process.env.CODEX_THREAD_ID;
  if (!uuid.test(controller || "")) throw new Error("需要当前 Codex 主控的精确 UUID；不能猜选最近会话");
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const since = options.since ? Date.parse(options.since) : -Infinity, until = options.until ? Date.parse(options.until) : Date.now();
  if (Number.isNaN(since) || Number.isNaN(until) || since > until) throw new Error("采集时间范围无效");
  const inRange = value => { const at = Date.parse(value); return Number.isFinite(at) && at >= since && at <= until; };
  const folder = wakeDir(root, controller), config = readJson(path.join(folder, "config.json"));
  const native = names(path.join(root, "tasks")).filter(n => uuid.test(n)).map(n => readJson(path.join(root, "tasks", n, "task.json")));
  const orca = jsonFiles(path.join(root, "orca", "会话"));
  const records = [...native.map(r => r && { ...r, backend: "native" }), ...orca.map(r => ({ ...r, backend: "orca" }))].filter(r => r?.controllerId === controller);
  const warnings = [], sources = [], evidence = [];
  const maxBytes = options.maxBytes || 512 * 1024 * 1024;
  const rollout = options.rollout || config?.rolloutPath || findRollout(codexHome, controller);
  const codex = { usage: emptyUsage(), usageAvailable: false, cumulativeResets: 0, turns: 0, toolCalls: 0, toolArgumentBytes: 0, toolResultBytes: 0, tools: {}, observationCandidates: 0, candidateUsage: emptyUsage() };
  let totals = null, turn = null, identity = false;
  const finish = () => {
    if (!turn) return;
    // 工具白名单只产生候选，不把未知命令、无工具推理或真实判断冒充空转。
    if (turn.tools.length && turn.tools.every(n => /(?:delegate_(?:status|overview|wait|wait_many)|wait_threads|clock__sleep)$/.test(n))) {
      codex.observationCandidates++; add(codex.candidateUsage, turn.usage);
      if (evidence.length < 30) evidence.push({ kind: "仅观察候选", ...turn.pointer, toolCalls: turn.tools.length, usage: turn.usage });
    }
    turn = null;
  };
  await scan(rollout, (row, pointer) => {
    if (row.type === "session_meta") { if (row.payload?.id !== controller) throw new Error("主控记录身份不匹配"); identity = true; }
    if (!identity) return;
    const p = row.payload || {}, included = inRange(row.timestamp);
    if (row.type === "event_msg" && p.type === "token_count" && p.info?.total_token_usage) {
      const next = p.info.total_token_usage;
      if (!usageKeys.every(k => finite(next[k]))) return;
      const delta = Object.fromEntries(usageKeys.map(k => [k, next[k] - (totals?.[k] || 0)]));
      if (included && (totals || since === -Infinity)) {
        if (Object.values(delta).every(finite)) { add(codex.usage, delta); if (turn) add(turn.usage, delta); codex.usageAvailable = true; }
        else codex.cumulativeResets++;
      }
      totals = next;
    }
    if (!included) return;
    if (row.type === "event_msg" && p.type === "task_started") { finish(); codex.turns++; turn = { pointer, tools: [], usage: emptyUsage() }; }
    if (row.type === "response_item" && ["function_call", "custom_tool_call"].includes(p.type)) {
      const name = /^[\w.-]{1,150}$/.test(p.name || "") ? p.name : "未知工具";
      codex.tools[name] = (codex.tools[name] || 0) + 1; codex.toolCalls++;
      codex.toolArgumentBytes += Buffer.byteLength(typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : "");
      turn?.tools.push(name);
    }
    if (row.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(p.type)) codex.toolResultBytes += Buffer.byteLength(JSON.stringify(p.output || ""));
    if (row.type === "event_msg" && ["task_complete", "turn_aborted"].includes(p.type)) finish();
  }, sources, warnings, "Codex主控", maxBytes);
  finish();
  if (!identity) warnings.push("Codex：未核验主控日志身份，用量不可用");
  if (codex.cumulativeResets) warnings.push("Codex：累计用量出现回退，对应区段未计入");
  if (!codex.usageAvailable) codex.usage = null;
  const claudeUsage = () => ({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
  const claude = { sessions: 0, subagents: 0, messages: 0, toolCalls: 0, usage: claudeUsage(), mainUsage: claudeUsage(), subagentUsage: claudeUsage(), usageAvailable: false };
  const seenSessions = new Set();
  for (const r of records) {
    if (!uuid.test(r.sessionId || "") || seenSessions.has(r.sessionId)) continue;
    seenSessions.add(r.sessionId);
    let file; try { file = (options.findClaude || findSession)(r.sessionId, r.cwd, { allowMissingDirectory: true }); } catch {}
    const entries = [{ file, kind: "Claude主会话" }];
    if (file) {
      const dir = path.join(path.dirname(file), r.sessionId, "subagents");
      for (const name of names(dir).filter(n => n.endsWith(".jsonl"))) entries.push({ file: path.join(dir, name), kind: "Claude子代理" });
    }
    for (const entry of entries) {
      const messages = new Map(), tools = new Set();
      const source = await scan(entry.file, row => {
        if (!inRange(row.timestamp) || row.type !== "assistant") return;
        const m = row.message;
        if (!m?.id || !finite(m.usage?.input_tokens) || !finite(m.usage?.output_tokens)) return;
        const key = String(m.id), previous = messages.get(key) || {};
        for (const k of Object.keys(claude.usage)) if (finite(m.usage[k])) previous[k] = Math.max(previous[k] || 0, m.usage[k]);
        messages.set(key, previous);
        for (const block of m.content || []) if (block.type === "tool_use" && block.id) tools.add(block.id);
      }, sources, warnings, entry.kind, maxBytes);
      source.sessionId = r.sessionId;
      source.recordId = r.id;
      source.agentFile = entry.kind === "Claude子代理" && /^agent-[\w-]+\.jsonl$/.test(path.basename(entry.file)) ? path.basename(entry.file) : null;
      if (entry.file) { if (entry.kind === "Claude主会话") claude.sessions++; else claude.subagents++; }
      for (const m of messages.values()) { add(claude.usage, m); add(entry.kind === "Claude主会话" ? claude.mainUsage : claude.subagentUsage, m); claude.usageAvailable = true; }
      claude.messages += messages.size; claude.toolCalls += tools.size;
    }
  }
  if (!claude.usageAvailable) { claude.usage = null; claude.mainUsage = null; claude.subagentUsage = null; }
  if (!claude.subagents) claude.subagentUsage = null;
  const runs = jsonFiles(path.join(folder, "runs")).filter(r => inRange(r.createdAt));
  const faults = jsonFiles(path.join(folder, "faults")).filter(f => inRange(f.createdAt));
  const acknowledgements = jsonFiles(path.join(folder, "ack"));
  const reports = [...jsonFiles(path.join(root, "reports")), ...records.flatMap(r => jsonFiles(path.join(root, "reports", "by-task", `${r.backend}-${r.id}`)))]
    .filter(r => r.controllerId === controller && r.reportId && inRange(r.at));
  const reportMap = new Map(reports.map(r => [r.reportId, r]));
  const latency = [];
  for (const r of reportMap.values()) {
    const ack = acknowledgements.find(a => a.id === hash(`${r.taskId}:${r.eventId}`));
    const ms = ack && Date.parse(ack.at) <= until ? Date.parse(ack.at) - Date.parse(r.at) : NaN;
    if (finite(ms)) latency.push(ms);
  }
  const counts = items => items.reduce((all, key) => ({ ...all, [key]: (all[key] || 0) + 1 }), {});
  const accepted = records.filter(r => readJson(path.join(root, "acceptance", `${r.backend}-${r.id}.json`))?.at && inRange(readJson(path.join(root, "acceptance", `${r.backend}-${r.id}.json`)).at)).length;
  const workflows = jsonFiles(path.join(root, "workflows")).filter(w => w.controllerId === controller);
  const report = { schemaVersion: 1, collectedAt: new Date().toISOString(), controllerId: controller,
    range: { since: Number.isFinite(since) ? new Date(since).toISOString() : null, until: new Date(until).toISOString(), scope: "当前Codex主控及关联Claude会话；既有Claude会话可包含接入前用量" },
    tasks: records.map(r => ({ taskId: r.id, sessionId: r.sessionId, backend: r.backend, archived: Boolean(r.archivedAt) })),
    codex, claude, collaboration: { wakeRuns: runs.length, runStates: counts(runs.map(r => r.state || "unknown")),
      wakeReasons: counts(runs.flatMap(r => (r.events || []).map(e => e.type || "unknown"))), reports: reportMap.size,
      processedReports: latency.length, pendingReports: [...reportMap.values()].filter(r => r.data?.status !== "progress").length - latency.length,
      reportToProcessedMs: { samples: latency.length, median: latency.length ? [...latency].sort((a,b) => a-b)[Math.floor(latency.length / 2)] : null, max: latency.length ? Math.max(...latency) : null },
      recordedAcceptances: accepted, faults: faults.length, resolvedFaults: faults.filter(f => ["resolved", "observation_recovered"].includes(f.state)).length,
      rework: null, humanInterventions: null,
      recordedWorkflowRepairs: workflows.length ? workflows.reduce((sum, w) => sum + (w.items || []).reduce((s, i) => s + (finite(i.repairs) ? i.repairs : 0), 0), 0) : null,
      workflowRepairScope: "流程累计记录，不等于选定时间段或Orca全部返工",
      reportEvents: [...reportMap.values()].slice(-100).map(r => {
        const ack = acknowledgements.find(a => a.id === hash(`${r.taskId}:${r.eventId}`) && Date.parse(a.at) <= until);
        return { reportId: r.reportId, taskId: r.taskId, requestDigest: hash(r.requestId || ""), at: r.at, status: r.data?.status, level: r.data?.level, processedAt: ack?.at || null, acceptance: "not_verified" };
      }),
      faultEvents: faults.slice(-100).map(f => ({ id: f.id, at: f.createdAt, resolvedAt: f.resolvedAt || f.recoveredAt || null,
        category: /^[A-Z_]{1,80}$/.test(f.diagnostic?.category || "") ? f.diagnostic.category : "UNKNOWN", fatal: Boolean(f.fatal) })),
      runs: runs.slice(-100).map(r => ({ id: r.id, state: r.state, at: r.createdAt, completedAt: r.completedAt || null, usageDelta: r.usageDelta || null, tools: r.tools?.length || 0,
        processedEvents: r.results?.filter(i => i.outcome === "processed").length ?? null, unprocessedEvents: r.unprocessedEventIds?.length ?? null })) },
    costs: { codex: null, claude: null, total: null, perAcceptedTask: null, reason: "缺少可靠账单和单工单费用归属，不以公开单价推算CCswitch或订阅账单" },
    evidence, sources, warnings: [...warnings, "仅观察候选不是已证实浪费；工具调用字节不是token。", "范围边界可能横跨轮次；轮次只数范围内的开始事件，零次不表示没有活动。", "缺失或截断时计数只代表已读取部分，零不是完整零活动证明。", "返工、人工介入和业务验收缺少完整可归因事件，标为未知。", "Claude用量按消息ID去重；缓存读与缓存写分开，不与Codex字段直接比较。"], modelCalls: 0 };
  const outputRoot = options.output || path.join(os.homedir(), ".cache", "cc-plugin-codex", "迭代复盘");
  const output = path.join(path.resolve(outputRoot), `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${controller.slice(0,8)}-${crypto.randomUUID().slice(0,8)}`);
  fs.mkdirSync(output, { recursive: true });
  writeJson(path.join(output, "证据包.json"), report);
  const shown = value => value === null ? "未知" : JSON.stringify(value);
  fs.writeFileSync(path.join(output, "复盘报告.md"), `# Claude 桥接协作复盘\n\n主控：${controller}\n\n## 已测得\n\n- Codex 轮次：${codex.turns}；工具调用：${codex.toolCalls}；仅观察候选：${codex.observationCandidates}。\n- Codex 用量：${shown(codex.usage)}。\n- Claude 用量：${shown(claude.usage)}；子代理记录：${claude.subagents}。\n- 桥接续接：${runs.length} 次；报告：${reportMap.size} 份；已处理回执：${latency.length} 份。\n- 回传到处理：${latency.length} 个样本，中位数 ${shown(report.collaboration.reportToProcessedMs.median)} 毫秒。\n- 故障：${faults.length}；记录中的验收：${accepted}。\n\n## 待判断\n\n- 费用及每工单成本：未知。\n- 返工与人工介入次数：未知。\n- 仅观察轮先核对是否有必要判断，不能直接算作节省。\n\n## 覆盖与限制\n\n${report.warnings.map(w => `- ${w}`).join("\n")}\n- 原始聊天、命令、凭据、完整路径和错误正文均未复制。证据指针使用来源编号及行号。\n- 完整结构统计见同目录的 证据包.json。此次采集调用模型 ${report.modelCalls} 次。\n`, "utf8");
  return { report: path.join(output, "复盘报告.md"), evidence: path.join(output, "证据包.json"), sources: sources.length, warnings: warnings.length, modelCalls: 0 };
}
