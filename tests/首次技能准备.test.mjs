import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareBridge } from "../skills/codex-claude-bridge/scripts/首次准备.mjs";

function fixture(installed = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "桥接首次准备-")), calls = [];
  const run = (program, args) => {
    calls.push({ program, args });
    if (args[0] === "--version") return { status: 0, stdout: "工具版本" };
    if (args[1] === "list") return { status: 0, stdout: JSON.stringify({ installed: installed ? [{ pluginId: "claude-code@codex-claude-bridge", installed: true, enabled: true, version: "0.24.0" }] : [] }) };
    if (args[1] === "add") installed = true;
    return { status: 0, stdout: "{}" };
  };
  return { home, calls, run };
}
test("首次检查不安装；明确安装只调用官方桥接入口并区分CLI与MCP", () => {
  const f = fixture(); try {
    assert.equal(prepareBridge(f).state, "installation_available");
    assert.equal(f.calls.some(c => c.args.includes("add")), false);
    const result = prepareBridge({ ...f, install: true });
    assert.equal(result.installed, true); assert.equal(result.mcpReady, "not_checked"); assert.equal(result.state, "reload_required");
    assert.deepEqual(result.changes, ["marketplace", "plugin"]);
    assert.ok(f.calls.every(c => ["git", "claude", "codex"].includes(c.program)));
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
test("已有插件不重复安装，可选支持提示一次记录且不调用点赞接口", () => {
  const f = fixture(true); try {
    assert.equal(prepareBridge({ ...f, install: true }).changes.length, 0);
    assert.equal(prepareBridge({ ...f, markSupport: true }).supportPromptShown, true);
    assert.equal(prepareBridge(f).supportPromptShown, true);
    assert.ok(f.calls.every(c => c.args[0] === "--version" || c.args[1] === "list"));
    assert.equal(fs.readFileSync(path.join(f.home, ".cache", "codex-claude-bridge", "首次使用.json"))[0], 123);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
test("安装失败保留阶段，不继续执行插件添加或标记首次准备成功", () => {
  const f = fixture(); try {
    const run = (program, args) => args[1] === "marketplace" ? { status: 1, stderr: "不应泄漏的错误正文" } : f.run(program, args);
    const result = prepareBridge({ ...f, run, install: true });
    assert.equal(result.state, "installation_failed"); assert.equal(result.failedStage, "marketplace");
    assert.ok(!JSON.stringify(result).includes("不应泄漏")); assert.ok(!f.calls.some(c => c.args[1] === "add"));
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
