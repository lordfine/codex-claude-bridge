import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createOrcaAdapter, emptyPrompt, statusIdentity, readTurn } from "../plugins/claude-code/scripts/lib/Orca会话.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-orca-test-")), cwd = root;
  const session = crypto.randomUUID(), calls = [], t = { handle: "term_验证", incarnationId: "实例一", worktreePath: cwd, agentIdentity: "claude", connected: true, writable: true };
  const state = { screen: ["❯"], session, idle: true, runtime: "运行时一", logged: false, completed: false, text: "", launches: 0 };
  const call = async (args) => {
    calls.push(args);
    let result;
    const key = args.slice(0, 2).join(" "), value = (flag) => args[args.indexOf(flag) + 1];
    if (key === "terminal list") result = { terminals: [t], truncated: false };
    else if (key === "terminal show") result = { terminal: t };
    else if (key === "terminal read") result = { terminal: { tail: state.screen, draft: state.draft, source: "screen", nextCursor: "1" } };
    else if (key === "terminal wait") result = { wait: { satisfied: state.idle } };
    else if (key === "terminal create") { state.launches++; result = { terminal: t }; }
    else if (key === "terminal close") result = {};
    else if (key === "terminal send") {
      const text = value("--text");
      if (text === "/status") state.screen = [`Session ID: ${state.session}`, `cwd: ${cwd}`];
      else if (text === "\u001b") state.screen = ["❯"];
      result = { send: { accepted: true, prompt: { requestId: "回执一", stages: ["input_accepted"] } } };
    } else throw new Error(`未预期调用：${key}`);
    return { ok: true, result, _meta: { runtimeId: state.runtime } };
  };
  const api = createOrcaAdapter({ call, root, observe: () => ({ logged: state.logged, completed: state.completed, text: state.text }) });
  const attach = (extra = {}) => api({ action: "attach", cwd, session_id: session, idle_confirmed: true, controller_id: "主控一", request_id: "接入一", ...extra });
  return { root, cwd, session, calls, t, state, api, attach };
}

test("状态身份只提取 UUID 与目录，忽略连接配置", () => {
  assert.deepEqual(statusIdentity(["Session ID: 18ae835b-fcbb-4a6d-b6de-f73f075adc73", "cwd: D:\\项目", "Auth token: 私密内容"]),
    { sessionId: "18ae835b-fcbb-4a6d-b6de-f73f075adc73", cwd: "D:\\项目" });
  assert.equal(statusIdentity(["Session ID: 非法编号"]), null);
});

test("空白输入框不把草稿和信任弹窗当成就绪", () => {
  assert.equal(emptyPrompt(["❯ 上一条任务", "❯"]), true);
  assert.equal(emptyPrompt(['❯ Try "how does file work?"']), true);
  assert.equal(emptyPrompt(["❯ 尚未发送的内容"]), false);
  assert.equal(emptyPrompt(["❯ Yes, I trust this folder"]), false);
});

test("既有会话身份接入不创建、不重启，稳定请求去重", async () => {
  const f = fixture(), first = await f.attach(), second = await f.attach();
  assert.equal(first.sessionId, f.session); assert.equal(second.id, first.id); assert.equal(second.duplicate, true);
  assert.equal(f.state.launches, 0); assert.equal(f.calls.filter((c) => c[0] === "terminal" && c[1] === "close").length, 0);
});

test("错误 UUID 不接入且不派发任务", async () => {
  const f = fixture(); await assert.rejects(f.attach({ session_id: crypto.randomUUID() }), /没有找到/);
  assert.ok(f.calls.filter((c) => c[1] === "send").every((c) => ["/status", "\u001b"].includes(c[c.indexOf("--text") + 1])));
});

test("有草稿或正在工作时不注入任何文字", async () => {
  for (const mode of ["draft", "hidden-draft", "busy"]) {
    const f = fixture(); if (mode === "draft") f.state.screen = ["❯ 人类草稿"]; else if (mode === "hidden-draft") f.state.draft = "隐藏草稿"; else f.state.idle = false;
    await assert.rejects(f.attach(), /没有找到/); assert.equal(f.calls.filter((c) => c[1] === "send").length, 0);
  }
});

test("输入接收不冒充完成；正文确认后可读交付，重复请求不重复发送", async () => {
  const f = fixture(), r = await f.attach();
  const args = { action: "send", id: r.id, controller_id: "主控一", request_id: "任务一", prompt: "请完成验证" };
  const sent = await f.api(args); assert.equal(sent.lastInstruction.state, "accepted");
  const duplicate = await f.api(args); assert.equal(duplicate.duplicate, true);
  assert.equal(f.calls.filter((c) => c.some((s) => s.startsWith("请完成验证"))).length, 1);
  f.state.logged = true; f.state.completed = true; f.state.text = "验证完成";
  const status = await f.api({ action: "status", id: r.id, controller_id: "主控一", include_text: true });
  assert.equal(status.lastInstruction.state, "completed"); assert.equal(status.turn.text, "验证完成");
});

test("运行时或实例变化后不双发，不自动重开", async () => {
  const f = fixture(), r = await f.attach(); f.state.runtime = "运行时二";
  await assert.rejects(f.api({ action: "send", id: r.id, controller_id: "主控一", request_id: "任务一", prompt: "执行" }), /须重新列出/);
  assert.equal(f.calls.filter((c) => c.includes("执行")).length, 0);
});

test("原终端切到新 UUID 后停止发送", async () => {
  const f = fixture(), r = await f.attach(); f.state.session = crypto.randomUUID();
  await assert.rejects(f.api({ action: "send", id: r.id, controller_id: "主控一", request_id: "任务一", prompt: "执行" }), /实际会话 ID 已变化/);
  assert.equal(f.calls.filter((c) => c.includes("执行")).length, 0);
});

test("跨主控不能使用接入记录", async () => {
  const f = fixture(), r = await f.attach();
  await assert.rejects(f.api({ action: "status", id: r.id, controller_id: "主控二" }), /不属于/);
});

test("释放保留原终端；关闭已有终端须明确确认", async () => {
  const f = fixture(), r = await f.attach();
  await assert.rejects(f.api({ action: "close", id: r.id, controller_id: "主控一", request_id: "关闭一" }), /明确确认/);
  const released = await f.api({ action: "release", id: r.id, controller_id: "主控一", request_id: "释放一" });
  assert.equal(released.terminalKeptAlive, true); assert.equal(f.calls.filter((c) => c[1] === "close").length, 0);
});

test("新建可见原生终端，模型默认继承，重复创建只有一个实例", { skip: process.platform !== "win32" }, async () => {
  const f = fixture(), args = { action: "create", cwd: f.cwd, controller_id: "主控一", request_id: "新建一" };
  const r = await f.api(args), duplicate = await f.api(args);
  assert.equal(f.state.launches, 1); assert.equal(r.createdByPlugin, true); assert.equal(r.model, null); assert.equal(duplicate.id, r.id);
  const command = f.calls.find((c) => c[1] === "create");
  assert.ok(command.includes("pwsh.exe")); assert.ok(command.some((part) => part.includes(`claude --session-id '${r.sessionId}'`)));
});

test("创建回执不明时重复请求只返回不明状态", { skip: process.platform !== "win32" }, async () => {
  const f = fixture(); delete f.t.incarnationId;
  const args = { action: "create", cwd: f.cwd, controller_id: "主控一", request_id: "新建一" };
  await assert.rejects(f.api(args), /完整终端身份/);
  const retried = await f.api(args); assert.equal(retried.uncertain, true); assert.equal(f.state.launches, 1);
});

test("同请求 ID 不允许改变正文", async () => {
  const f = fixture(); await f.attach(); await assert.rejects(f.attach({ session_id: crypto.randomUUID() }), /用于不同/);
});

test("会话记录核对准确正文、目录与人类插入边界", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccpc-orca-transcript-")), prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const id = crypto.randomUUID(), folder = path.join(root, "projects", "验证"), file = path.join(folder, `${id}.jsonl`);
    fs.mkdirSync(folder, { recursive: true });
    const lines = [{ type: "user", sessionId: id, cwd: root, message: { content: "验证任务" } },
      { type: "assistant", sessionId: id, cwd: root, message: { content: [{ type: "text", text: "完成" }], stop_reason: "end_turn" } }];
    fs.writeFileSync(file, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.equal(readTurn(id, root, { prompt: "验证任务" }).completed, true);
    assert.equal(readTurn(id, root, { prompt: "其他任务" }).logged, false);
    fs.appendFileSync(file, JSON.stringify({ type: "user", sessionId: id, cwd: root, message: { content: "用户追加" } }) + "\n");
    assert.equal(readTurn(id, root, { prompt: "验证任务" }).ambiguous, false);
    assert.equal(readTurn(id, root, { prompt: "验证任务" }).completed, true);
    lines[0].message.content = [{ type: "text", text: "验证任务" }];
    lines[1].message.stop_reason = "tool_use";
    fs.writeFileSync(file, lines.map((e) => JSON.stringify(e)).join("\n") + "\n" + JSON.stringify({ type: "user", sessionId: id, cwd: root, message: { content: "用户插入" } }) + "\n");
    assert.equal(readTurn(id, root, { prompt: "验证任务" }).logged, true);
    assert.equal(readTurn(id, root, { prompt: "验证任务" }).ambiguous, true);
  } finally { if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prior; }
});
