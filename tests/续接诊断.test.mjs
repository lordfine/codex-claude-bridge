import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "桥接诊断-"));
process.env.CC_PLUGIN_CODEX_MANAGED_DIR = path.join(root, "状态");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "配置");
process.env.CC_PLUGIN_CODEX_DISABLE_NOTIFICATIONS = "1";
const state = await import("../plugins/claude-code/scripts/lib/managed-state.mjs");
const queue = await import("../plugins/claude-code/scripts/lib/事件队列.mjs");
const wake = await import("../plugins/claude-code/scripts/lib/事件续接.mjs");
const reader = await import("../plugins/claude-code/scripts/lib/会话读取.mjs");
const diag = await import("../plugins/claude-code/scripts/lib/续接诊断.mjs");
const notice = await import("../plugins/claude-code/scripts/lib/本地提醒.mjs");
const watcher = await import("../plugins/claude-code/scripts/lib/本地观察.mjs");
const orca = await import("../plugins/claude-code/scripts/lib/Orca会话.mjs");
const cli = await import("../plugins/claude-code/scripts/lib/Codex调用.mjs");
test.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const controller = crypto.randomUUID(), id = crypto.randomUUID(), session = crypto.randomUUID(), cwd = path.join(root, id);
  fs.mkdirSync(cwd); const directory = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", id); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${session}.jsonl`);
  const row = (type, text, extra = {}) => ({ type, sessionId: session, cwd, uuid: crypto.randomUUID(), message: { role: type, content: [{ type: "text", text }], stop_reason: type === "assistant" ? "end_turn" : null }, ...extra });
  const append = (...rows) => fs.appendFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");
  append(row("user", "历史"), row("assistant", "历史完成"));
  const baseline = fs.statSync(file).size, folder = queue.wakeDir(state.MANAGED_ROOT, controller);
  queue.writeWakeJson(path.join(folder, "config.json"), { enabled: true, controllerId: controller });
  const r = { id, controllerId: controller, sessionId: session, cwd, terminalId: "终端", incarnationId: "实例", runtimeId: "运行时", state: "attached", owner: "codex", controlRevision: 1, managementCursor: { offset: baseline }, lastInstruction: { requestId: "任务一", prompt: "桥接任务", baseline } };
  state.writeJson(path.join(state.MANAGED_ROOT, "orca", "会话", `${id}.json`), r);
  const record = () => state.readJson(path.join(state.MANAGED_ROOT, "orca", "会话", `${id}.json`));
  return { id, controller, session, cwd, file, row, append, baseline, folder, r, record };
}
test("调度故障记录真实阶段和脱敏堆栈，新提醒不冒用旧CLI故障", async () => {
  const f = fixture(), old = crypto.randomUUID(); notice.attentionNotice(f.folder, { id: old, summary: "旧CLI退出" });
  const e = new TypeError("扫描失败 token=测试密钥 https://example.com/a?key=测试密钥"); e.code = "SCAN_FAILED";
  const fault = diag.recordSchedulerFault(f.folder, e, { stage: "observe_records" }, { fatal: true, notify: notice.attentionNotice });
  const again = diag.recordSchedulerFault(f.folder, e, { stage: "observe_records" }, { fatal: true, notify: notice.attentionNotice });
  assert.equal(fault.id, again.id); assert.equal(again.occurrences, 2); assert.equal(fault.diagnostic.frames.length > 0, true);
  assert.doesNotMatch(JSON.stringify(fault), /测试密钥/);
  const status = await wake.wakeControl({ action: "diagnose", controller_id: f.controller });
  assert.equal(status.currentFault.id, fault.id); assert.equal(status.attention.faultId, fault.id); assert.equal(status.attention.runId, null);
  assert.equal(status.attention.notification.state, "disabled"); assert.equal(status.modelCalls, 0);
  await assert.rejects(wake.wakeControl({ action: "resolve", controller_id: f.controller, run_id: old, decision: "acknowledge" }), /独立调度故障/);
});
test("单条记录失败保留游标且不阻断其他会话，恢复后新故障重新提醒", async () => {
  const bad = fixture(), good = fixture(); good.r.controllerId = bad.controller; state.writeJson(path.join(state.MANAGED_ROOT, "orca", "会话", `${good.id}.json`), good.r);
  const file = path.join(state.MANAGED_ROOT, "observers", `orca-${bad.id}.json`); state.writeJson(file, { observation: { cursor: { offset: 123 } }, handoffSignature: "原交付" });
  const options = { now: 10000, observe: (session) => { if (session === bad.session) throw new Error("单条异常"); return { logged: true, completed: true }; }, probe: async () => ({ busy: false }) };
  const result = await watcher.observeLocalRecords(bad.controller, options);
  assert.equal(result.errors, 1); assert.equal(good.record().lastInstruction.state, "completed");
  const saved = state.readJson(file); assert.equal(saved.observation.cursor.offset, 123); assert.equal(saved.handoffSignature, "原交付");
  const recovered = { ...options, now: 16000, observe: () => ({ logged: true, completed: true }) }; await watcher.observeLocalRecords(bad.controller, recovered);
  assert.equal(diag.schedulerFaults(bad.folder, saved.faultId).state, "observation_recovered");
  await watcher.observeLocalRecords(bad.controller, { ...options, now: 22000 }); assert.notEqual(state.readJson(file).faultId, saved.faultId);
});
test("Windows中文通知脚本有BOM且PS5可解析，JSON无BOM", { skip: process.platform !== "win32" }, () => {
  const f = fixture(), script = notice.writeWindowsNoticeScript(f.folder);
  assert.equal(fs.readFileSync(script).subarray(0, 3).toString("hex"), "efbbbf");
  assert.notEqual(fs.readFileSync(path.join(f.folder, "config.json")).subarray(0, 3).toString("hex"), "efbbbf");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", "$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($env:BRIDGE_NOTICE_FILE,[ref]$t,[ref]$e)>$null;$e.Count"], { encoding: "utf8", windowsHide: true, env: { ...process.env, BRIDGE_NOTICE_FILE: script } });
  assert.equal(output.trim(), "0");
});
test("通知进程失败有回执，旧通知关闭不能覆盖新故障", { skip: !["win32", "darwin"].includes(process.platform) }, () => {
  const f = fixture(), children = []; const spawn = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {}; children.push(child); return child; };
  delete process.env.CC_PLUGIN_CODEX_DISABLE_NOTIFICATIONS;
  try {
    const old = crypto.randomUUID(), fresh = crypto.randomUUID(); notice.attentionNotice(f.folder, { id: old }, { spawn }); notice.attentionNotice(f.folder, { id: fresh, faultId: fresh, source: "scheduler" }, { spawn });
    children[0].emit("close", 1, null); assert.equal(queue.readWakeJson(path.join(f.folder, "attention.json")).faultId, fresh);
    children[1].emit("error", Object.assign(new Error("通知无法启动"), { code: "ENOENT" })); children[1].emit("close", 1, null);
    const record = queue.readWakeJson(path.join(f.folder, "attention.json")); assert.equal(record.notification.state, "failed"); assert.equal(record.notification.userSeenConfirmed, false);
  } finally { process.env.CC_PLUGIN_CODEX_DISABLE_NOTIFICATIONS = "1"; }
});
test("CLI退出保留中文错误摘要且隐藏令牌，不落原始标准错误", async () => {
  const f = fixture(), script = path.join(f.cwd, "模拟命令.mjs");
  fs.writeFileSync(script, 'process.stderr.write("连接异常 token=测试密钥\\n");process.exitCode=1;');
  const result = await cli.runCodex([], "", { cwd: f.cwd, cli: { command: process.execPath, prefix: [script] } });
  assert.equal(result.code, 1); assert.match(result.diagnostic.stderrExcerpt, /连接异常/); assert.doesNotMatch(result.diagnostic.stderrExcerpt, /测试密钥/);
});
test("人类两条输入和后台任务完成后才产生完成证据，游标可增量读取意图", () => {
  const f = fixture(); f.append(f.row("user", "第一条人类指令"), f.row("assistant", "第一条完成"), f.row("user", "第二条人类指令"));
  const first = reader.observeHumanActivity(f.session, f.cwd, { cursor: { offset: f.baseline } }); assert.equal(first.userCount, 2); assert.equal(first.completed, false);
  f.append(f.row("assistant", "", { message: { content: [{ type: "tool_use", id: "工具一", input: { run_in_background: true } }] } }), f.row("user", "", { toolUseResult: { backgroundTaskId: "后台一" }, message: { content: [{ type: "tool_result", tool_use_id: "工具一", content: "运行中" }] } }), f.row("assistant", "主轮结束"));
  const busy = reader.observeHumanActivity(f.session, f.cwd, first); assert.equal(busy.completed, false);
  f.append(f.row("user", "", { isMeta: true, attachment: { type: "task_notification", taskId: "后台一", status: "completed" } }));
  const end = reader.observeHumanActivity(f.session, f.cwd, busy); assert.equal(end.completed, true); assert.equal(end.userCount, 2);
  const history = reader.readHistory({ session_id: f.session, cwd: f.cwd, cursor: end.firstUserCursor, roles: ["user"] }); assert.match(history.messages[0].text, /第一条人类/);
});
test("人类临时操作保留绑定，完成事件可唤醒；接管后旧输入不再拦住下一任务", async () => {
  const f = fixture(); f.append(f.row("user", "桥接任务"), f.row("assistant", "工具执行", { message: { content: [{ type: "tool_use", id: "工具", input: {} }] } }), f.row("user", "改用另一种方案"), f.row("assistant", "人类指令完成"));
  const options = { probe: async () => ({ busy: false }) }; await watcher.observeLocalRecords(f.controller, options);
  assert.equal(f.record().owner, "human"); assert.equal(f.record().state, "attached");
  const pending = queue.pendingWakeEvents(f.folder); assert.equal(pending.some((e) => e.type === "human_prompt_completed"), true);
  assert.equal(wake.currentWakeEvents(f.folder, pending, f.controller).some((e) => e.type === "human_prompt_completed"), true);
  let screen = ["❯"], sent = [];
  const call = async (args) => {
    const key = args.slice(0, 2).join(" "); let result;
    if (key === "terminal show") result = { terminal: { handle: "终端", incarnationId: "实例", worktreePath: f.cwd, agentIdentity: "claude", connected: true, writable: true } };
    else if (key === "terminal wait") result = { wait: { satisfied: true } };
    else if (key === "terminal read") result = { terminal: { tail: screen } };
    else if (key === "terminal send") { const text = args[args.indexOf("--text") + 1]; sent.push(text); screen = text === "/status" ? [`Session ID: ${f.session}`, `cwd: ${f.cwd}`] : ["❯"]; result = { send: { accepted: true } }; }
    else throw new Error("未预期操作"); return { result, _meta: { runtimeId: "运行时" } };
  };
  const api = orca.createOrcaAdapter({ call });
  const takeover = await api({ action: "takeover", id: f.id, controller_id: f.controller, request_id: "接续一", idle_confirmed: true });
  assert.equal(takeover.owner, "codex"); assert.equal(takeover.management, "retained"); assert.equal(takeover.lastInstruction.state, "interrupted_by_human");
  await watcher.observeLocalRecords(f.controller, options); assert.equal(f.record().owner, "codex");
  const next = await api({ action: "send", id: f.id, controller_id: f.controller, request_id: "任务二", prompt: "继续新方案", process_docs: false });
  assert.equal(next.lastInstruction.state, "accepted"); assert.equal(sent.filter((t) => t.startsWith("继续新方案")).length, 1);
  assert.match(wake.wakePrompt(f.controller, pending), /不要因 owner=human 释放/);
});
test("人类未完成或草稿未清空保留观察，重复完成不制造额外协调轮", async () => {
  const f = fixture(); f.append(f.row("user", "桥接任务"), f.row("assistant", "完成"), f.row("user", "人类正在追加"));
  await watcher.observeLocalRecords(f.controller, { probe: async () => ({ busy: false }) });
  assert.equal(f.record().state, "attached"); assert.equal(queue.pendingWakeEvents(f.folder).some((e) => e.type === "human_prompt_completed"), false);
  f.append(f.row("assistant", "人类工作完成")); await watcher.observeLocalRecords(f.controller, { probe: async () => ({ busy: false, draft: true }) });
  assert.equal(queue.pendingWakeEvents(f.folder).some((e) => e.type === "human_prompt_completed"), false);
  const options = { probe: async () => ({ busy: false }) }; await watcher.observeLocalRecords(f.controller, options); await watcher.observeLocalRecords(f.controller, options);
  assert.equal(queue.pendingWakeEvents(f.folder).filter((e) => e.type === "human_prompt_completed").length, 1);
  f.append(f.row("user", "新一轮还没结束")); await watcher.observeLocalRecords(f.controller, options);
  assert.equal(wake.currentWakeEvents(f.folder, queue.pendingWakeEvents(f.folder), f.controller).some((e) => e.type === "human_prompt_completed"), false);
});
test("原生人类队列结束才可处理完成事件，Codex待发箱不冒充人类队列", () => {
  const controller = crypto.randomUUID(), id = crypto.randomUUID(), folder = queue.wakeDir(state.MANAGED_ROOT, controller);
  state.writeTask({ id, controllerId: controller, state: "running" }); queue.writeWakeJson(path.join(folder, "config.json"), { enabled: true });
  state.appendEvent(id, { type: "human_prompt_completed", humanCursor: { offset: 10 } }); const events = queue.pendingWakeEvents(folder);
  state.writeRuntime(id, { busy: true, humanQueued: 1 }); assert.equal(wake.currentWakeEvents(folder, events, controller).length, 0);
  state.writeRuntime(id, { busy: false, humanQueued: 0, queue: [{ id: "Codex待发" }] }); assert.equal(wake.currentWakeEvents(folder, events, controller).length, 1);
  assert.equal(events[0].humanCursor.offset, 10);
});
test("真实系统任务通知字段不改变控制权并清除已知后台任务", () => {
  const f = fixture(), text = '<task-notification>\n<task-id>后台一</task-id>\n<tool-use-id>工具一</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>';
  const notification = f.row("user", text, { origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system", turnOrigin: "task_notification", userType: "external" });
  f.append(f.row("user", "桥接任务"), f.row("assistant", "", { message: { content: [{ type: "tool_use", id: "工具一", input: { run_in_background: true } }] } }), f.row("assistant", "主轮完成"), notification, f.row("assistant", "最终交付"));
  assert.equal(reader.messageOrigin(notification), "task_notification");
  const turn = reader.observeInstruction(f.session, f.cwd, f.r.lastInstruction); assert.equal(turn.completed, true); assert.equal(turn.backgroundOutstanding, false); assert.equal(Boolean(turn.nextUserObserved), false);
  assert.equal(reader.messageOrigin(f.row("user", text)), "human_input");
  assert.equal(reader.observeHumanActivity(f.session, f.cwd, { cursor: { offset: f.baseline }, userCount: 0 }).userCount, 1);
});
test("独立故障经原编号核对后可恢复，关闭配置与待办不变且不调用模型", async () => {
  const f = fixture(); queue.writeWakeJson(path.join(f.folder, "config.json"), { enabled: false, controllerId: f.controller });
  const fault = diag.recordSchedulerFault(f.folder, new Error("已修复的调度错误"), { stage: "observe_records" }, { fatal: true });
  const result = await wake.wakeControl({ action: "resolve_fault", controller_id: f.controller, fault_id: fault.id, resolution: "补丁已安装，状态已核对", decision: "retry" });
  assert.equal(result.paused, false); assert.equal(result.enabled, false); assert.equal(result.modelCalls, 0); assert.equal(diag.schedulerFaults(f.folder, fault.id).state, "resolved");
});
test("草稿来源未知时生成一次明确待办，不冒充人类输入或完成派发", async () => {
  const f = fixture(); f.append(f.row("user", "桥接任务"), f.row("assistant", "完成"));
  const options = { probe: async () => ({ busy: false, draft: true, draftEvidence: { present: true, source: "unknown", fingerprint: "固定指纹", length: 20 } }) };
  await watcher.observeLocalRecords(f.controller, options); await watcher.observeLocalRecords(f.controller, options);
  assert.equal(f.record().owner, "codex"); assert.equal(f.record().terminalBlocker.source, "unknown");
  const events = queue.pendingWakeEvents(f.folder); assert.equal(events.filter((e) => e.type === "draft_blocked").length, 1); assert.equal(events.some((e) => e.type === "instruction_completed"), false);
});
test("故障恢复保持事件，错误编号不解锁，确认和重复恢复可核对", async () => {
  const f = fixture(); const pending = queue.pendingWakeEvents(f.folder);
  queue.writeWakeJson(path.join(f.folder, "config.json"), { enabled: false, controllerId: f.controller });
  const fault = diag.recordSchedulerFault(f.folder, new Error("待修复"), { stage: "observe_records" }, { fatal: true });
  const args = { action: "resolve_fault", controller_id: f.controller, fault_id: fault.id, resolution: "接口与读取器已修复", decision: "acknowledge" };
  await assert.rejects(wake.wakeControl({ ...args, fault_id: crypto.randomUUID() }), /精确故障编号/);
  assert.equal((await wake.wakeControl(args)).paused, true);
  assert.equal((await wake.wakeControl({ ...args, decision: "retry" })).paused, false);
  assert.equal((await wake.wakeControl({ ...args, decision: "retry" })).duplicate, true);
  assert.deepEqual(queue.pendingWakeEvents(f.folder), pending);
});
test("CLI与调度故障独立处理；未核对CLI时不能解除调度暂停", async () => {
  const f = fixture(); queue.writeWakeJson(path.join(f.folder, "config.json"), { enabled: false, controllerId: f.controller });
  const run = crypto.randomUUID(); queue.writeWakeJson(path.join(f.folder, "runs", `${run}.json`), { id: run, state: "uncertain", cliPid: null, events: [] });
  queue.writeWakeJson(path.join(f.folder, "runtime.json"), { activeRunId: run, paused: true });
  const fault = diag.recordSchedulerFault(f.folder, new Error("调度异常"), {}, { fatal: true });
  const args = { action: "resolve_fault", controller_id: f.controller, fault_id: fault.id, resolution: "修复已核对", decision: "retry" };
  await assert.rejects(wake.wakeControl(args), /CLI运行待核对/);
  const handled = await wake.wakeControl({ action: "resolve", controller_id: f.controller, run_id: run, decision: "acknowledge" }); assert.equal(handled.paused, true); assert.equal(handled.currentFault.id, fault.id);
  assert.equal((await wake.wakeControl(args)).paused, false);
});
test("失联与草稿异常绕过临时操作权过滤，草稿清空会再次提示协调", async () => {
  const f = fixture(); f.r.owner = "human"; f.r.lastInstruction = null; state.writeJson(path.join(state.MANAGED_ROOT, "orca", "会话", `${f.id}.json`), f.r);
  await watcher.observeLocalRecords(f.controller, { now: 10000, probe: async () => ({ stale: true, code: "terminal_handle_stale" }) });
  const pending = queue.pendingWakeEvents(f.folder); assert.equal(pending.some((e) => e.type === "binding_stale"), true); assert.equal(wake.currentWakeEvents(f.folder, pending, f.controller).length, 1);
  await watcher.observeLocalRecords(f.controller, { now: 16000, probe: async () => ({ draft: true, draftEvidence: { source: "unknown", fingerprint: "草稿" } }) });
  await watcher.observeLocalRecords(f.controller, { now: 22000, probe: async () => ({ draft: false }) });
  assert.equal(queue.pendingWakeEvents(f.folder).some((e) => e.type === "draft_cleared"), true);
});
test("旧缓存系统通知边界重分类，不重复累计假人类指令", async () => {
  const f = fixture(), entry = f.row("user", '<task-notification><task-id>后台</task-id><status>completed</status></task-notification>', { origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system", turnOrigin: "task_notification" });
  f.append(f.row("user", "桥接任务"), f.row("assistant", "主轮完成")); const offset = fs.statSync(f.file).size; f.append(entry, f.row("assistant", "最终交付"));
  f.r.owner = "human"; f.r.observation = { logged: true, completed: false, ambiguous: true, nextUserObserved: true, cursor: { offset }, humanBoundary: { offset }, humanInputEvidence: { uuid: entry.uuid } };
  f.r.humanActivity = { userCount: 1, mainTurnEnded: true, cursor: { offset: fs.statSync(f.file).size }, firstUserCursor: { offset } };
  state.writeJson(path.join(state.MANAGED_ROOT, "orca", "会话", `${f.id}.json`), f.r);
  await watcher.observeLocalRecords(f.controller, { probe: async () => ({ busy: false, draft: true, draftEvidence: { source: "unknown" } }) });
  const r = f.record(); assert.equal(r.observation.nextUserObserved, false); assert.equal(r.observation.ambiguous, false); assert.equal(r.humanActivity.userCount, 0); assert.equal(r.owner, "human");
});
test("已配对的本地命令回执不冒充第二条人类任务，也不等不存在的模型轮", () => {
  const f = fixture(), command = f.row("user", '<command-name>/model</command-name><command-message>model</command-message><command-args></command-args>', { userType: "external", entrypoint: "cli" });
  f.append(command, f.row("user", '<local-command-stdout>Set model</local-command-stdout>', { parentUuid: command.uuid, userType: "external", entrypoint: "cli" }));
  const result = reader.observeHumanActivity(f.session, f.cwd, { cursor: { offset: f.baseline } }); assert.equal(result.userCount, 1); assert.equal(result.completed, true);
  const quoted = fixture(); quoted.append(quoted.row("user", '<local-command-stdout>这是引用</local-command-stdout>'));
  assert.equal(reader.observeHumanActivity(quoted.session, quoted.cwd, { cursor: { offset: quoted.baseline } }).completed, false);
});
