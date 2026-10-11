import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { collectIteration, classifyIterationTool } from "../plugins/claude-code/scripts/lib/迭代采集.mjs";
import { writeJson } from "../plugins/claude-code/scripts/lib/managed-state.mjs";
import { wakeDir } from "../plugins/claude-code/scripts/lib/事件队列.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "桥接复盘验证-")), controller = crypto.randomUUID(), id = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const rollout = path.join(root, "主控.jsonl"), claude = path.join(root, "执行.jsonl");
  writeJson(path.join(root, "orca", "会话", `${id}.json`), { id, controllerId: controller, sessionId, cwd: root, state: "attached" });
  const row = (type, payload, second = 0) => ({ type, payload, timestamp: `2026-10-10T01:00:${String(second).padStart(2,"0")}Z` });
  const usage = n => ({ type: "token_count", info: { total_token_usage: { input_tokens: n, cached_input_tokens: n / 2, output_tokens: n / 10 } } });
  fs.writeFileSync(rollout, [row("session_meta", { id: controller }), row("event_msg", { type: "task_started" }), row("response_item", { type: "function_call", name: "delegate_status", arguments: '{"secret":"sk-不能泄漏"}' }), row("event_msg", usage(100), 1), row("event_msg", usage(100), 2), row("event_msg", { type: "task_complete" }, 3)].map(JSON.stringify).join("\n"));
  const message = { type: "assistant", timestamp: "2026-10-10T01:00:01Z", message: { id: "同一消息", content: [{ type: "text", text: "私密业务正文" }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } };
  fs.writeFileSync(claude, [message, message].map(JSON.stringify).join("\n"));
  return { root, controller, rollout, claude, row, usage, options: { root, controller, rollout, output: root, until: "2026-10-11T00:00:00Z", findClaude: () => claude } };
}
test("包装观察工具可识别，混合修改和未知等待不会冒充纯观察", () => {
  assert.equal(classifyIterationTool({ name: "exec", input: 'text(await tools.mcp__claude_code__delegate_status({task_id:"编号"}));' }).kind, "observation");
  assert.equal(classifyIterationTool({ name: "exec", input: 'await tools.exec_command({cmd:"查看工具delegate_status"});' }).kind, "work");
  assert.equal(classifyIterationTool({ name: "exec", input: 'text("tools.delegate_status()");' }).kind, "unknown");
  assert.equal(classifyIterationTool({ name: "exec", input: 'fs.rmSync("目标"); await tools.delegate_status({});' }).kind, "unknown");
  assert.equal(classifyIterationTool({ name: "wait", arguments: '{}' }).kind, "unknown");
  assert.equal(classifyIterationTool({ name: "sleep" }).kind, "observation");
  assert.equal(classifyIterationTool({ name: "exec", input: 'await tools.delegate_status({}); await tools.delegate_send({});' }).kind, "work");
});
test("递归工作流子日志和跨文件流式消息去重，缓存与输出不重复相加", async () => {
  const f = fixture(); try {
    const record = JSON.parse(fs.readFileSync(path.join(f.root,"orca","会话",fs.readdirSync(path.join(f.root,"orca","会话"))[0])));
    const dir = path.join(f.root, record.sessionId, "workflows", "工作流", "subagents"); fs.mkdirSync(dir, { recursive: true });
    const message = JSON.parse(fs.readFileSync(f.claude,"utf8").split("\n")[0]);
    const child = { ...message, message: { ...message.message, id: "真实子代理", usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 } } };
    fs.writeFileSync(path.join(dir,"agent-甲.jsonl"), [message, child].map(JSON.stringify).join("\n"));
    child.message.usage.output_tokens = 4; fs.writeFileSync(path.join(dir,"agent-乙.jsonl"), JSON.stringify(child));
    const result = await collectIteration(f.options), data = JSON.parse(fs.readFileSync(result.evidence));
    assert.equal(data.claude.subagents, 2); assert.equal(data.claude.messages, 2);
    assert.equal(data.claude.usage.input_tokens, 15); assert.equal(data.claude.usage.output_tokens, 6);
    assert.equal(data.claude.mainUsage.input_tokens, 10); assert.equal(data.claude.subagentUsage.output_tokens, 4);
  } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
});
test("重试事件只算一个原因，deferred_busy和人工确认不冒称模型执行", async () => {
  const f = fixture(); try {
    const folder = wakeDir(f.root, f.controller), event = { id: "同一事件", type: "needs_input" };
    for (let i=0;i<3;i++) writeJson(path.join(folder,"runs",`${i}.json`), { id:String(i), createdAt:"2026-10-10T01:00:04Z", state:i===2 ? "acknowledged" : "deferred_busy", events:[event] });
    const result = await collectIteration(f.options), data=JSON.parse(fs.readFileSync(result.evidence));
    assert.equal(data.schemaVersion,2); assert.equal(data.collaboration.wakeRuns,3);
    assert.equal(data.collaboration.wakeReasons.needs_input,1); assert.equal(data.collaboration.eventOccurrences.needs_input,3);
    assert.equal(data.collaboration.executionsNotStarted,2); assert.equal(data.collaboration.executionsUnknown,1);
    assert.equal(data.collaboration.modelExecutionsProved,0);
  } finally { fs.rmSync(f.root,{recursive:true,force:true}); }
});
test("采集去重累计用量与Claude消息，证据不复制原文", async () => {
  const f = fixture(); try {
    const result = await collectIteration(f.options), raw = fs.readFileSync(result.evidence, "utf8"), data = JSON.parse(raw);
    assert.equal(data.codex.usage.input_tokens, 100); assert.equal(data.codex.observationCandidates, 1);
    assert.equal(data.claude.usage.input_tokens, 10); assert.equal(data.claude.usage.cache_creation_input_tokens, 3);
    assert.equal(data.claude.messages, 1); assert.equal(data.costs.total, null); assert.equal(data.modelCalls, 0);
    assert.ok(!raw.includes("不能泄漏")); assert.ok(!raw.includes("私密业务正文")); assert.ok(!raw.includes(f.root));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("缺失日志仍产出未知报告，不找无关会话", async () => {
  const f = fixture(); try {
    const result = await collectIteration({ ...f.options, rollout: path.join(f.root, "不存在"), findClaude: () => { throw Error("含凭据的错误"); } });
    const data = JSON.parse(fs.readFileSync(result.evidence, "utf8"));
    assert.equal(data.codex.usage, null); assert.equal(data.claude.usage, null); assert.ok(data.warnings.length > 3);
    assert.ok(!JSON.stringify(data).includes("含凭据的错误"));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("指定范围取增量，身份不符和截断不可伪装完整", async () => {
  const f = fixture(); try {
    fs.appendFileSync(f.rollout, "\n" + JSON.stringify(f.row("event_msg", f.usage(150), 5)));
    const result = await collectIteration({ ...f.options, since: "2026-10-10T01:00:04Z" });
    assert.equal(JSON.parse(fs.readFileSync(result.evidence)).codex.usage.input_tokens, 50);
    const wrong = await collectIteration({ ...f.options, controller: crypto.randomUUID() });
    assert.equal(JSON.parse(fs.readFileSync(wrong.evidence)).codex.usage, null);
    const clipped = await collectIteration({ ...f.options, maxBytes: 30 });
    assert.equal(JSON.parse(fs.readFileSync(clipped.evidence)).sources[0].complete, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("归档目录删除后仍可只读统计精确历史会话", async () => {
  const f = fixture(), previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(f.root, "Claude配置");
    const file = path.join(f.root, "orca", "会话", fs.readdirSync(path.join(f.root, "orca", "会话"))[0]);
    const record = JSON.parse(fs.readFileSync(file)); record.cwd = path.join(f.root, "已经清理的工作树"); writeJson(file, record);
    const dest = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", "项目", `${record.sessionId}.jsonl`); fs.mkdirSync(path.dirname(dest), { recursive: true });
    const rows = fs.readFileSync(f.claude, "utf8").split("\n").map(line => ({ ...JSON.parse(line), cwd: record.cwd, sessionId: record.sessionId }));
    fs.writeFileSync(dest, rows.map(JSON.stringify).join("\n"));
    const result = await collectIteration({ ...f.options, findClaude: undefined });
    assert.equal(JSON.parse(fs.readFileSync(result.evidence)).claude.usage.input_tokens, 10);
    assert.equal(fs.existsSync(record.cwd), false);
  } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; fs.rmSync(f.root, { recursive: true, force: true }); }
});
