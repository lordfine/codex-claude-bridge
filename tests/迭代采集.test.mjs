import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { collectIteration } from "../plugins/claude-code/scripts/lib/迭代采集.mjs";
import { writeJson } from "../plugins/claude-code/scripts/lib/managed-state.mjs";

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
