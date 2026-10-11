import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "桥接思考验证-"));
process.env.CC_PLUGIN_CODEX_MANAGED_DIR = path.join(root, "状态");
const state = await import("../plugins/claude-code/scripts/lib/managed-state.mjs");
const policy = await import("../plugins/claude-code/scripts/lib/协作策略.mjs");
const effort = await import("../plugins/claude-code/scripts/lib/思考控制.mjs");
const platform = await import("../plugins/claude-code/scripts/lib/平台适配.mjs");
test.after(async () => { await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
function fixture() {
  const r = { id: crypto.randomUUID(), controllerId: crypto.randomUUID(), lastInstruction: { requestId: "本轮" }, state: "attached", cwd: path.join(root, crypto.randomUUID()) };
  fs.mkdirSync(r.cwd); fs.writeFileSync(path.join(r.cwd, "源码.md"), "初始源码");
  state.writeJson(path.join(state.MANAGED_ROOT, "orca", "会话", `${r.id}.json`), r);
  return { r, call: args => policy.coordinationControl({ ...args, backend: "orca", controller_id: r.controllerId, task_id: r.id }) };
}
test("九种组合独立生效，新默认中中且保留明确的旧Codex等级", () => {
  const f = fixture(); assert.equal(policy.coordinationConfig(f.r.controllerId).thinkingLevel, "medium");
  for (const profile of ["low", "medium", "high"]) for (const thinking of ["low", "medium", "high"]) {
    f.call({ action: "configure", profile, thinking });
    assert.equal(policy.effectiveProfile(f.r), profile); assert.equal(policy.effectiveThinking(f.r).level, thinking);
    assert.equal(policy.eventEffort(policy.coordinationConfig(f.r.controllerId), [{ taskId: f.r.id, backend: "orca", type: "stage_delivered" }]), thinking);
    assert.equal(policy.eventEffort(policy.coordinationConfig(f.r.controllerId), [{ type: "context_sync" }]), "low");
  }
  f.call({ action: "configure", deep_effort: "xhigh" });
  assert.equal(policy.eventEffort(policy.coordinationConfig(f.r.controllerId), [{ taskId: f.r.id, backend: "orca" }]), "xhigh");
  f.call({ action: "thinking", thinking: "low" });
  assert.equal(policy.eventEffort(policy.coordinationConfig(f.r.controllerId), [{ taskId: f.r.id, backend: "orca" }]), "low");
});
test("单任务覆盖、当前请求局部升档和恢复，旧轮升档不污染新轮", () => {
  const f = fixture(); f.call({ action: "thinking", thinking: "low" });
  const one = f.call({ action: "escalate", request_id: "本轮", reason: "相同失败已重复，需进一步定位" });
  assert.equal(one.thinking.level, "medium"); assert.equal(one.application.actual, null);
  const two = f.call({ action: "escalate", request_id: "本轮", reason: "复杂边界决策" }); assert.equal(two.thinking.level, "high");
  assert.throws(() => f.call({ action: "escalate", request_id: "旧轮", reason: "旧请求" }));
  f.call({ action: "restore_thinking" });
  const current = state.readJson(path.join(state.MANAGED_ROOT, "orca", "会话", `${f.r.id}.json`));
  assert.equal(policy.effectiveThinking(current).level, "low");
  current.thinkingEscalation = { level: "high", requestId: "旧轮" };
  assert.equal(policy.effectiveThinking(current).level, "low");
});
test("代理配置无BOM且各档独立，Windows与Mac启动引用不会丢失中文或引号", () => {
  const f = fixture(), file = path.join(f.r.cwd, "代理'配置.json");
  const args = effort.claudeThinkingArgs({ level: "low" }, file);
  assert.equal(args[1], "low"); assert.equal(args[2], "--plugin-dir");
  assert.equal(fs.readFileSync(path.join(args[3], ".claude-plugin", "plugin.json"))[0], 123);
  for (const [name, level] of [["低投入", "low"], ["中投入", "medium"], ["高投入", "high"]]) assert.ok(fs.readFileSync(path.join(args[3], "agents", `${name}.md`), "utf8").includes(`effort: ${level}`));
  for (const system of ["win32", "darwin"]) {
    const launched = platform.orcaLaunch(crypto.randomUUID(), null, system, null, args);
    assert.ok(launched.command.includes("--effort")); assert.ok(launched.command.includes("--plugin-dir"));
    assert.ok(!launched.command.includes("--model"));
  }
});
test("检查证据按源码环境范围命令核对；修改源码或环境后不能复用", () => {
  const f = fixture(), query = { check_id: "定向检查", scope: "登录逻辑", environment: "节点24_数据集甲", command: "node 检查.mjs" };
  f.call({ action: "record_check", ...query, result: "passed", evidence: "验证记录.md：三项通过", uncovered: "未做生产检查" });
  assert.equal(f.call({ action: "reuse_check", ...query }).entries[0].reusable, true);
  assert.equal(f.call({ action: "reuse_check", ...query, environment: "数据集乙" }).entries[0].reusable, false);
  assert.equal(f.call({ action: "reuse_check", ...query, scope: "全量" }).entries[0].reusable, false);
  fs.writeFileSync(path.join(f.r.cwd, "源码.md"), "变化源码");
  assert.equal(f.call({ action: "reuse_check", ...query }).entries[0].reusable, false);
  assert.equal(f.call({ action: "checks" }).entries[0].acceptance, "not_verified");
});
test("失败检查、缺证据及跨主控操作不能被当成可复用通过", () => {
  const f = fixture(), query = { check_id: "失败", scope: "逻辑", environment: "环境", command: "命令" };
  assert.throws(() => f.call({ action: "record_check", ...query, result: "passed" }));
  f.call({ action: "record_check", ...query, result: "failed", evidence: "记录.md" });
  assert.equal(f.call({ action: "reuse_check", ...query }).entries[0].reusable, false);
  assert.throws(() => policy.coordinationControl({ action: "thinking", thinking: "low", task_id: f.r.id, backend: "orca", controller_id: crypto.randomUUID() }));
});
