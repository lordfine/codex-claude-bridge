import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-policy-test-"));
process.env.CC_PLUGIN_CODEX_MANAGED_DIR = path.join(root, "状态");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "Claude");
const state = await import("../plugins/claude-code/scripts/lib/managed-state.mjs");
const reader = await import("../plugins/claude-code/scripts/lib/会话读取.mjs");
const policy = await import("../plugins/claude-code/scripts/lib/协作策略.mjs");
const queue = await import("../plugins/claude-code/scripts/lib/事件队列.mjs");
const wake = await import("../plugins/claude-code/scripts/lib/事件续接.mjs");
const watcher = await import("../plugins/claude-code/scripts/lib/本地观察.mjs");
const orcaModule = await import("../plugins/claude-code/scripts/lib/Orca会话.mjs");
function fixture() {
  const id = crypto.randomUUID(), controllerId = crypto.randomUUID(), sessionId = crypto.randomUUID(), cwd = path.join(root, id);
  fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, "实现.md"), "初始内容");
  const project = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", id); fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${sessionId}.jsonl`);
  const entry = (type, content, extra = {}) => ({ type, sessionId, cwd, uuid: crypto.randomUUID(), message: { role: type, content }, ...extra });
  const append = (entries) => fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  append([entry("attachment", [])]);
  const r = { id, controllerId, sessionId, cwd, state: "attached", terminalId: "测试终端", incarnationId: "测试实例", runtimeId: "测试运行时",
    lastInstruction: { requestId: "指令一", prompt: "执行", marker: "<bridge-instruction:test>", baseline: fs.statSync(file).size, state: "accepted" } };
  state.writeJson(path.join(state.MANAGED_ROOT, "orca", "会话", `${id}.json`), r);
  const folder = queue.wakeDir(state.MANAGED_ROOT, controllerId);
  queue.writeWakeJson(path.join(folder, "config.json"), { enabled: true, enabledAt: "2020-01-01", controllerId });
  return { r, id, controllerId, sessionId, cwd, file, entry, append, folder };
}

test("4KB中文指令加图片附件与超过旧窗口的工具日志，能够识别完成", () => {
  const f = fixture(), prompt = "修复界面".repeat(400);
  f.r.lastInstruction.prompt = prompt;
  f.append([f.entry("user", [{ type: "text", text: prompt + "\n<bridge-instruction:test>" }, { type: "image", source: { type: "base64", data: "测试图片" } }]),
    f.entry("user", [{ type: "tool_result", content: "日志".repeat(350000) }]),
    f.entry("assistant", [{ type: "text", text: "交付完成" }], { message: { content: [{ type: "text", text: "交付完成" }], stop_reason: "end_turn" } })]);
  const observed = reader.observeInstruction(f.sessionId, f.cwd, f.r.lastInstruction);
  assert.equal(observed.logged, true); assert.equal(observed.completed, true); assert.equal(observed.truncated, false);
});

test("增量扫描越过大日志，不把新正文反复追加", () => {
  const f = fixture(); f.append([f.entry("user", "执行 <bridge-instruction:test>"),
    ...Array.from({ length: 22 }, () => f.entry("progress", "日志".repeat(110000))),
    f.entry("assistant", [{ type: "text", text: "最终正文" }], { message: { content: [{ type: "text", text: "最终正文" }], stop_reason: "end_turn" } })]);
  let saved = {}; for (let i = 0; i < 8 && !saved.completed; i++) saved = reader.observeInstruction(f.sessionId, f.cwd, f.r.lastInstruction, saved);
  assert.equal(saved.completed, true); const final = reader.observeInstruction(f.sessionId, f.cwd, f.r.lastInstruction, saved);
  assert.equal(final.text, "最终正文"); assert.equal(final.cursor.offset, fs.statSync(f.file).size);
});

test("同文不同指令标识不误关联，文件截断不假完成", () => {
  const f = fixture(); f.append([f.entry("user", "执行 <bridge-instruction:other>"), f.entry("assistant", "旧正文")]);
  assert.equal(reader.observeInstruction(f.sessionId, f.cwd, f.r.lastInstruction).logged, false);
  fs.truncateSync(f.file, 0);
  const result = reader.observeInstruction(f.sessionId, f.cwd, f.r.lastInstruction, { logged: true, completed: true, cursor: { offset: 10000 } });
  assert.equal(result.completed, false); assert.equal(result.changed, true);
});

test("历史按字节和字符分页，完整恢复中文且不接管", () => {
  const f = fixture(), body = "这是一段中文交付。".repeat(100);
  f.append([f.entry("assistant", body)]);
  let cursor = {}, text = "";
  for (let i = 0; i < 30; i++) { const page = reader.readHistory({ session_id: f.sessionId, cwd: f.cwd, cursor, max_chars: 61 }); text += page.messages.map((m) => m.text).join(""); cursor = page.nextCursor; assert.equal(page.readOnly, true); if (!page.hasMore) break; }
  assert.equal(text, body); assert.throws(() => reader.readHistory({ session_id: f.sessionId, cwd: root }), /原目录/);
});

test("半行等待完整 JSON 后才读取，常见凭据模式隐藏", () => {
  const f = fixture(), e = JSON.stringify(f.entry("assistant", "password=虚构测试值 Bearer 虚构测试值"));
  fs.appendFileSync(f.file, e.slice(0, 70));
  const first = reader.readHistory({ session_id: f.sessionId, cwd: f.cwd }); assert.equal(first.messages.length, 0);
  fs.appendFileSync(f.file, e.slice(70) + "\n");
  const second = reader.readHistory({ session_id: f.sessionId, cwd: f.cwd, cursor: first.nextCursor });
  assert.ok(second.messages[0].text.includes("[已隐藏]")); assert.ok(!second.messages[0].text.includes("虚构测试值"));
});

test("主轮结束不冒充后台结束，有明确任务通知才清除", () => {
  const f = fixture(); f.append([f.entry("user", "执行 <bridge-instruction:test>"), f.entry("assistant", [{ type: "tool_use", id: "后台一", name: "Bash", input: { run_in_background: true } }]),
    f.entry("assistant", [{ type: "text", text: "主轮完成" }], { message: { content: [{ type: "text", text: "主轮完成" }], stop_reason: "end_turn" } })]);
  const first = reader.observeInstruction(f.sessionId, f.cwd, f.r.lastInstruction); assert.equal(first.completed, true); assert.equal(first.backgroundOutstanding, true);
  f.append([f.entry("attachment", [], { attachment: { type: "task_notification", taskId: "后台一", status: "completed" } })]);
  assert.equal(reader.observeInstruction(f.sessionId, f.cwd, f.r.lastInstruction, first).backgroundOutstanding, false);
});

test("默认中频，逐任务覆盖，异常和必须决定的交付不受低频过滤", () => {
  const f = fixture(); assert.equal(policy.coordinationConfig(f.controllerId).profile, "medium");
  policy.coordinationControl({ action: "configure", controller_id: f.controllerId, profile: "low" });
  assert.equal(policy.shouldWake(f.r, { type: "stage_delivered", level: "subtask" }), false);
  assert.equal(policy.shouldWake(f.r, { type: "stage_delivered", level: "batch" }), true);
  assert.equal(policy.shouldWake(f.r, { type: "stage_delivered", level: "subtask", requiresDecision: true }), true);
  assert.equal(policy.shouldWake(f.r, { type: "needs_input" }), true);
  policy.coordinationControl({ action: "profile", controller_id: f.controllerId, backend: "orca", task_id: f.id, profile: "high" });
  const updated = state.readJson(path.join(state.MANAGED_ROOT, "orca", "会话", `${f.id}.json`));
  assert.equal(policy.effectiveProfile(updated), "high");
});

test("同一事件回放三档介入递减，普通无变化事件全部不唤醒", () => {
  const events = ["subtask", "subtask", "milestone", "subtask", "milestone", "batch", "review", "final"].map((level) => ({ type: "stage_delivered", level }));
  const counts = ["high", "medium", "low"].map((coordinationProfile) => events.filter((e) => policy.shouldWake({ coordinationProfile }, e)).length);
  assert.deepEqual(counts, [8, 5, 3]);
  for (const coordinationProfile of ["high", "medium", "low"]) assert.equal(policy.shouldWake({ coordinationProfile }, { type: "progress" }), false);
});

test("过程目录排除 Git，交付身份与快照核验，变化使旧快照失效", () => {
  const f = fixture(), docs = policy.prepareRecordDocuments(f.r, "目标");
  assert.ok(fs.readFileSync(path.join(f.cwd, ".gitignore"), "utf8").includes(".协作记录/"));
  const snapshot = policy.workspaceFingerprint(f.cwd), data = { task_id: f.id, phase_id: "阶段一", level: "milestone", summary: "交付", checks: ["定向检查通过"], unresolved: [], snapshot };
  fs.writeFileSync(docs.handoff, "```json\n" + JSON.stringify(data) + "\n```\n");
  assert.equal(policy.readHandoff(f.r).snapshot, snapshot);
  fs.writeFileSync(path.join(f.cwd, "实现.md"), "已变化"); assert.ok(policy.readHandoff(f.r).invalid);
});

test("无模型观察器完成一次事件，重复观察不重复队列和正文", async () => {
  const f = fixture(); const observe = () => ({ logged: true, completed: true, text: "交付" });
  const probe = async () => ({ busy: false });
  const one = await watcher.observeLocalRecords(f.controllerId, { observe, probe });
  const two = await watcher.observeLocalRecords(f.controllerId, { observe, probe });
  assert.equal(one.modelCalls, 0); assert.equal(two.changes, 0); assert.equal(queue.pendingWakeEvents(f.folder).length, 1);
  assert.ok(!JSON.stringify(queue.pendingWakeEvents(f.folder)).includes("交付"));
});

test("忙碌和未知草稿不算可靠交付，草稿待办不冒充人类接管", async () => {
  const f = fixture(); await watcher.observeLocalRecords(f.controllerId, { observe: () => ({ logged: true, completed: true, text: "交付" }), probe: async () => ({ busy: true, draft: true }) });
  assert.equal(queue.pendingWakeEvents(f.folder).some((e) => e.type === "instruction_completed"), false);
  assert.equal(queue.pendingWakeEvents(f.folder).some((e) => e.type === "draft_blocked"), true);
  const updated = state.readJson(path.join(state.MANAGED_ROOT, "orca", "会话", `${f.id}.json`)); assert.notEqual(updated.owner, "human"); assert.equal(updated.terminalBlocker.source, "unknown");
});

test("轻量轮真实 low 参数，深度轮恢复显式等级", () => {
  const f = fixture(); policy.coordinationControl({ action: "configure", controller_id: f.controllerId, deep_effort: "xhigh" });
  const config = { controllerId: f.controllerId, cwd: f.cwd, targetThreadId: crypto.randomUUID() };
  const low = wake.wakeCliArgs(config, "输出.json", [{ type: "context_sync" }]);
  const deep = wake.wakeCliArgs(config, "输出.json", [{ type: "instruction_completed" }]);
  assert.ok(low.includes('model_reasoning_effort="low"')); assert.ok(deep.includes('model_reasoning_effort="xhigh"'));
  assert.ok(low.includes('mcp_servers.claude-code.enabled=false')); assert.ok(deep.includes('mcp_servers.claude-code.enabled=true'));
  assert.match(wake.wakePrompt(f.controllerId, [{ type: "context_sync", taskId: f.id, backend: "orca" }]), /不调用工具、不读取技能/);
});

test("已确认取消的指令不被本地观察改回完成", async () => {
  const f = fixture(); f.r.lastInstruction.terminalState = "cancelled"; f.r.lastInstruction.state = "cancelled";
  const file = path.join(state.MANAGED_ROOT, "orca", "会话", `${f.id}.json`); state.writeJson(file, f.r);
  await watcher.observeLocalRecords(f.controllerId, { observe: () => { throw new Error("取消后不应读取旧轮"); }, probe: async () => ({ busy: false }) });
  assert.equal(state.readJson(file).lastInstruction.state, "cancelled");
  assert.equal(queue.pendingWakeEvents(f.folder).length, 0);
});

test("等待超时为普通结果，传输退出和解析错误可分类且不泄露原输出", () => {
  assert.equal(orcaModule.parseOrcaResponse(JSON.stringify({ ok: false, error: { code: "wait_timeout" } }), ["terminal", "wait"], { code: 1 }).result.wait.timedOut, true);
  assert.throws(() => orcaModule.parseOrcaResponse("虚构私密输出", ["terminal", "send"], { code: 1 }), (e) => e.details.uncertain && e.details.cliExitCode === 1 && !e.message.includes("私密"));
  assert.throws(() => orcaModule.parseOrcaResponse("无法解析", ["terminal", "read"]), (e) => e.code === "INVALID_JSON");
});

test("只有需决定交付完成且快照连续稳定才允许审查", async () => {
  const f = fixture(), docs = policy.prepareRecordDocuments(f.r, "目标");
  fs.writeFileSync(docs.handoff, '```json\n' + JSON.stringify({ task_id: f.id, phase_id: "验收一", level: "batch", requires_decision: true, summary: "实现完成", checks: [], unresolved: [], snapshot: "capture" }) + '\n```');
  const options = { observe: () => ({ logged: true, completed: true, text: "交付" }), probe: async () => ({ busy: false }) };
  await watcher.observeLocalRecords(f.controllerId, options);
  assert.equal(policy.coordinationControl({ action: "handoff", controller_id: f.controllerId, task_id: f.id, backend: "orca" }).readyForReview, false);
  await watcher.observeLocalRecords(f.controllerId, options);
  assert.equal(policy.coordinationControl({ action: "handoff", controller_id: f.controllerId, task_id: f.id, backend: "orca" }).readyForReview, true);
  fs.writeFileSync(path.join(f.cwd, "实现.md"), "后来变化");
  assert.equal(policy.coordinationControl({ action: "handoff", controller_id: f.controllerId, task_id: f.id, backend: "orca" }).readyForReview, false);
});
