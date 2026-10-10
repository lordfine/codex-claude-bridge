import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareReporter, submitReport, reportReceipt } from "../plugins/claude-code/scripts/lib/主动回传.mjs";
import { writeJson } from "../plugins/claude-code/scripts/lib/managed-state.mjs";
import { wakeDir, pendingWakeEvents, acknowledgeWakeEvents } from "../plugins/claude-code/scripts/lib/事件队列.mjs";
import { readHandoff } from "../plugins/claude-code/scripts/lib/协作策略.mjs";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "主动回传验证-"));
  const r = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), controllerId: "隔离主控", cwd: path.join(root, "工作区"), state: "attached", lastInstruction: { requestId: "委派甲" } };
  fs.mkdirSync(r.cwd); const file = path.join(root, "orca", "会话", r.id + ".json"); writeJson(file, r);
  const folder = wakeDir(root, r.controllerId); writeJson(path.join(folder, "config.json"), { enabled: true });
  return { root, r, file, folder, reporter: prepareReporter(r, { root }) };
}
test("回传绑定请求，重复回传只通知一次，消费回执不等于验收", () => {
  const f = fixture(); try {
    const data = { report_key: "阻塞甲", status: "blocked", summary: "需要决定", unresolved: ["方案选择"] };
    const first = submitReport(f.reporter.context, data), second = submitReport(f.reporter.context, data);
    assert.equal(second.reportId, first.reportId); assert.equal(second.duplicate, true); assert.equal(pendingWakeEvents(f.folder).length, 1);
    assert.equal(first.delivery, "queued"); assert.equal(first.acceptance, "not_verified");
    acknowledgeWakeEvents(f.folder, pendingWakeEvents(f.folder));
    assert.equal(reportReceipt(f.reporter.context, first.reportId).delivery, "processed");
    assert.throws(() => submitReport(f.reporter.context, { ...data, summary: "不同内容" }), /内容变化/);
    writeJson(f.file, { ...f.r, lastInstruction: { requestId: "委派乙" } });
    assert.throws(() => submitReport(f.reporter.context, data), /请求已切换/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("完成回传等待观察，旧请求交付不能冒充新请求", () => {
  const f = fixture(); try {
    const receipt = submitReport(f.reporter.context, { report_key: "完成甲", status: "completed", summary: "完成", checks: ["定向检查通过"] });
    assert.equal(receipt.delivery, "pending_observation"); assert.equal(pendingWakeEvents(f.folder).length, 0);
    const handoff = readHandoff(f.r); assert.equal(handoff.reportId, receipt.reportId); assert.equal(handoff.requestId, "委派甲");
    assert.match(readHandoff({ ...f.r, lastInstruction: { requestId: "委派乙" } }).invalid, /旧请求/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("MCP 与 CLI 实际进程共用同一份收据", () => {
  const f = fixture(); try {
    const entry = fileURLToPath(new URL("../plugins/claude-code/scripts/执行回传.mjs", import.meta.url));
    const data = { report_key: "协议甲", status: "blocked", summary: "验证回执" }, input = path.join(f.root, "回传.json"); writeJson(input, data);
    const cli = spawnSync(process.execPath, [entry, "--context", f.reporter.context, "--input", input], { encoding: "utf8", windowsHide: true });
    assert.equal(cli.status, 0, cli.stderr); const receipt = JSON.parse(cli.stdout);
    const mcp = spawnSync(process.execPath, [entry, "--context", f.reporter.context, "--mcp"], { encoding: "utf8", windowsHide: true,
      input: [ { jsonrpc: "2.0", id: 1, method: "initialize" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "report", arguments: data } } ].map(JSON.stringify).join("\n") + "\n" });
    assert.equal(mcp.status, 0, mcp.stderr); const messages = mcp.stdout.trim().split("\n").map(JSON.parse);
    assert.equal(messages[1].result.tools.length, 4);
    assert.equal(JSON.parse(messages[2].result.content[0].text).reportId, receipt.reportId);
    assert.equal(pendingWakeEvents(f.folder).length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("补充证据精确绑定当前轮，保存读取采用分离且重试幂等", () => {
  const f = fixture(); try {
    const source = `
      import assert from 'node:assert/strict';
      import { coordinationControl } from './plugins/claude-code/scripts/lib/协作策略.mjs';
      import { executorInbox } from './plugins/claude-code/scripts/lib/主动回传.mjs';
      const args = ${JSON.stringify({ task_id: f.r.id, controller_id: f.r.controllerId, backend: "orca", request_id: "委派甲", evidence_id: "证据甲", text: "现有反例需要覆盖" })};
      const context = ${JSON.stringify(f.reporter.context)};
      assert.equal(coordinationControl({...args, action:'evidence'}).state, 'saved');
      coordinationControl({...args, action:'evidence'});
      assert.throws(()=>executorInbox(context,'证据甲'), /尚未读取/);
      assert.equal(executorInbox(context).entries.length,1);
      assert.equal(coordinationControl({...args,action:'evidence_status'}).entries[0].state,'read');
      assert.equal(executorInbox(context,'证据甲').state,'acknowledged');
      assert.equal(executorInbox(context).entries.length,0);
      assert.throws(()=>coordinationControl({...args,action:'evidence',request_id:'旧轮'}), /当前逻辑请求/);
      assert.throws(()=>coordinationControl({...args,action:'evidence',text:'改变内容'}), /内容变化/);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", windowsHide: true, env: { ...process.env, CC_PLUGIN_CODEX_MANAGED_DIR: f.root } });
    assert.equal(child.status, 0, child.stderr);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
