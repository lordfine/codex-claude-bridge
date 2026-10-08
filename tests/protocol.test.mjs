import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { PLUGIN_ROOT, startServer, initialized, text, makeTempHome, fakeClaudeEnv, sleep } from "./helpers.mjs";

const HOME = makeTempHome();
const server = startServer(fakeClaudeEnv(HOME));

test.after(() => server.stop());

test("initialize: clamps unknown protocolVersion to the latest supported", async () => {
  const init = await server.rpc("initialize", { protocolVersion: "2099-12-31", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  server.notify("notifications/initialized", {});
});

test("initialize: serverInfo version matches the plugin manifest", async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
  const init = await server.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.serverInfo.name, "claude-code");
  assert.equal(init.result.serverInfo.version, manifest.version);
});

test("initialize: echoes a supported older protocolVersion", async () => {
  const init = await server.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(init.result.protocolVersion, "2024-11-05");
});

test("tools/list 只公开准备检查与托管会话工具", async () => {
  const tl = await server.rpc("tools/list", {});
  assert.deepEqual(
    tl.result.tools.map((t) => t.name).sort(),
    ["delegate_cancel", "delegate_coordination", "delegate_create", "delegate_diff", "delegate_history", "delegate_limit", "delegate_list", "delegate_manage", "delegate_models", "delegate_orca", "delegate_sessions",
      "delegate_merge", "delegate_open", "delegate_permissions", "delegate_review",
      "delegate_send", "delegate_status", "delegate_takeover", "delegate_transcript", "delegate_wait", "delegate_wait_many", "delegate_wake", "delegate_workflow",
      "delegate_overview", "setup"].sort()
  );
});

test("ping replies with an empty object, including for id 0", async () => {
  const p = await server.rpc("ping", {});
  assert.deepEqual(p.result, {});
  const p0 = await server.rpcRawId(0, "ping", {});
  assert.deepEqual(p0.result, {});
});

test("malformed JSON lines are tolerated", async () => {
  server.raw("this is not json\n");
  await sleep(100);
  const p = await server.rpc("ping", {});
  assert.deepEqual(p.result, {});
});

test("unknown method → -32601, unknown tool → -32602", async () => {
  const um = await server.rpc("no/such", {});
  assert.equal(um.error.code, -32601);
  const ut = await server.rpc("tools/call", { name: "nope", arguments: {} });
  assert.equal(ut.error.code, -32602);
  const old = await server.rpc("tools/call", { name: "consult", arguments: {} });
  assert.equal(old.error.code, -32602);
});

test("setup 报告当前托管环境，不沿用旧的 Windows 不支持提示", async () => {
  const result = await server.rpc("tools/call", { name: "setup", arguments: {} });
  const status = JSON.parse(text(result));
  assert.equal(status.platform, process.platform);
  assert.equal(status.terminal.ready, true);
  assert.equal(status.login.verified, false);
  assert.ok(status.models && typeof status.models === "object");
});
