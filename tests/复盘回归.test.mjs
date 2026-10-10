import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { updateJson } from "../plugins/claude-code/scripts/lib/原子文件.mjs";
import { writeJson } from "../plugins/claude-code/scripts/lib/managed-state.mjs";
import { emptyPrompt, classifyTerminal } from "../plugins/claude-code/scripts/lib/Orca会话.mjs";
import { messageOrigin, redactText } from "../plugins/claude-code/scripts/lib/会话读取.mjs";
import { statusResponse, validateStatusCursor } from "../plugins/claude-code/scripts/lib/状态响应.mjs";

test("权限、计费说明、分类器故障与输入草稿分别报告且不自动批准", () => {
  const menu = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];
  assert.equal(classifyTerminal(menu).kind, "permission_requested");
  assert.equal(classifyTerminal(["Auto mode API usage billing", ...menu]).kind, "system_notice");
  assert.equal(classifyTerminal(["Stage 2 classifier error", ...menu]).kind, "classifier_unavailable");
  assert.equal(classifyTerminal(["❯ 尚未发送的真实草稿"]).kind, "draft_present");
  assert.equal(classifyTerminal(menu).actionable, false);
});
test("状态游标拒绝跨目标、跨类型及跨终端实例", () => {
  const cursor = statusResponse({ id: "甲", incarnationId: "实例甲" }).statusCursor;
  assert.equal(typeof validateStatusCursor(cursor, "甲", "task_status", "实例甲"), "string");
  assert.throws(() => validateStatusCursor(cursor, "乙", "task_status", "实例甲"), /invalid_cursor/);
  assert.throws(() => validateStatusCursor(cursor, "甲", "controller_overview", "实例甲"), /invalid_cursor/);
  assert.throws(() => validateStatusCursor(cursor, "甲", "task_status", "实例乙"), /invalid_cursor/);
});
test("URL身份和Basic凭据先脱敏，保留诊断路径", () => {
  const result = redactText("https://用户:合成令牌@example.test/path Basic c2VjcmV0");
  assert.ok(!result.includes("合成令牌") && !result.includes("用户") && !result.includes("c2VjcmV0")); assert.match(result, /example.test\/path/);
});

test("新版通知与尾随说明可识别，普通引用不能冒充队友", () => {
  const message = { content: '<task-notification><task-id>任务甲</task-id><status>completed</status><note>说明</note><result>正文</result></task-notification>' };
  assert.equal(messageOrigin({ type: "user", origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system", message }), "task_notification");
  assert.equal(messageOrigin({ type: "user", message }), "human_input");
  const teammate = { content: 'Another Claude session sent a message:\n<teammate-message teammate_id="审查员">结果</teammate-message>\n尾随系统说明' };
  assert.equal(messageOrigin({ type: "user", userType: "external", entrypoint: "cli", message: teammate }), "agent_notification");
  assert.equal(messageOrigin({ type: "user", message: teammate }), "human_input");
});

test("短暂 EPERM 重试原子替换，永久失败保留旧文件并清理自己的临时文件", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "桥接写入回归-")), file = path.join(root, "状态.json");
  try {
    writeJson(file, { revision: 1 }); let count = 0;
    writeJson(file, { revision: 2 }, { delays: [1, 1], rename: (from, to) => {
      if (count++ < 2) throw Object.assign(new Error("短暂文件占用"), { code: "EPERM" });
      fs.renameSync(from, to);
    } });
    assert.equal(count, 3); assert.equal(JSON.parse(fs.readFileSync(file)).revision, 2);
    assert.throws(() => writeJson(file, { revision: 3 }, { delays: [1], rename: () => { throw Object.assign(new Error("持续占用"), { code: "EPERM" }); } }), /持续占用/);
    assert.equal(JSON.parse(fs.readFileSync(file)).revision, 2);
    assert.deepEqual(fs.readdirSync(root), ["状态.json"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("中文建议占位不被当成输入，真实正文仍拦截", () => {
  assert.equal(emptyPrompt(['❯ 试试 "修复这个问题"']), true);
  assert.equal(emptyPrompt(['❯ 尝试“解释此代码”']), true);
  assert.equal(emptyPrompt(['❯ 请修复这个问题']), false);
});
test("官方本地命令输出不被历史读取当成真人输入", () => {
  const e = { type: "user", userType: "external", entrypoint: "cli", message: { content: "<local-command-stdout>Compacted <note>完成</note></local-command-stdout>" } };
  assert.equal(messageOrigin(e), "local_command_result");
  assert.equal(messageOrigin({ ...e, userType: "human" }), "human_input");
});
test("多个进程串行更新同一状态，不丢计数且不留下临时文件", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "桥接并发写入-")), file = path.join(root, "状态.json");
  try {
    writeJson(file, { count: 0 });
    const moduleUrl = new URL("../plugins/claude-code/scripts/lib/原子文件.mjs", import.meta.url).href;
    const results = await Promise.allSettled(Array.from({length:3}, () => new Promise((resolve,reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-"], { windowsHide:true, stdio:["pipe","ignore","pipe"] }); let error="";
      child.stderr.on("data",s=>error+=s);child.on("error",reject);child.on("exit",c=>c===0?resolve():reject(Error(error)));
      child.stdin.end(`import {updateJson} from ${JSON.stringify(moduleUrl)};for(let i=0;i<50;i++)updateJson(${JSON.stringify(file)},r=>({count:r.count+1}));`);
    })));
    for(const result of results) assert.equal(result.status,"fulfilled",result.reason?.message);
    assert.equal(JSON.parse(fs.readFileSync(file)).count,150);assert.deepEqual(fs.readdirSync(root),["状态.json"]);
    const unchanged=updateJson(file,()=>undefined);assert.equal(unchanged.count,150);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
