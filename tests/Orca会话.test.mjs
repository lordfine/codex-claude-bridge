import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createOrcaAdapter, emptyPrompt, statusIdentity, readTurn } from "../plugins/claude-code/scripts/lib/Orca会话.mjs";
process.env.PATH = path.resolve("tests/fixtures/bin") + path.delimiter + process.env.PATH;

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
      if (args.includes("--wait-submit") && state.sendError) throw Object.assign(new Error("输入发送后回执丢失"), { code:"TRANSPORT_FAILED" });
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

test("指令可持久排队，未发送时不声称开工；派发后不重复发送", async () => {
  const f = fixture(), record = await f.attach();
  const args = { action: "enqueue", id: record.id, controller_id: "主控一", request_id: "排队一", prompt: "只回复排队验证", process_docs: false };
  const before = f.calls.length, queued = await f.api(args);
  assert.equal(queued.submission.state, "queued"); assert.equal(queued.submission.started, false);
  assert.equal(f.calls.length, before);
  assert.equal((await f.api(args)).duplicate, true);
  await f.api({ action: "dispatch_queue", id: record.id, controller_id: "主控一", request_id: "推进一" });
  assert.equal(f.calls.filter((c) => c[1] === "send" && c.includes("--wait-submit")).length, 1);
  await f.api({ action: "dispatch_queue", id: record.id, controller_id: "主控一", request_id: "推进二" });
  assert.equal(f.calls.filter((c) => c[1] === "send" && c.includes("--wait-submit")).length, 1);
  const view = await f.api({ action: "queue", id: record.id, controller_id: "主控一" }); assert.equal(view.queue[0].state, "submitted");
});
test("排队发送前失败保留同一队列项，尚忙时不发送", async () => {
  const f=fixture(), r=await f.attach(); await f.api({action:"enqueue",id:r.id,controller_id:"主控一",request_id:"不明排队",prompt:"普通任务",process_docs:false});
  f.state.idle=false;
  await assert.rejects(f.api({action:"dispatch_queue",id:r.id,controller_id:"主控一",request_id:"尚忙推进"}),/尚未空闲/);
  const view=await f.api({action:"queue",id:r.id,controller_id:"主控一"}); assert.equal(view.queue[0].state,"queued");
  assert.equal(f.calls.some(c=>c.includes("--wait-submit")),false);
});
test("排队输入发送后回执不明，后续推进也禁止重发", async () => {
  const f=fixture(),r=await f.attach();await f.api({action:"enqueue",id:r.id,controller_id:"主控一",request_id:"不明回执队列",prompt:"普通任务",process_docs:false});
  f.state.sendError=true;await assert.rejects(f.api({action:"dispatch_queue",id:r.id,controller_id:"主控一",request_id:"不明回执推进"}),/回执丢失/);
  const next=await f.api({action:"dispatch_queue",id:r.id,controller_id:"主控一",request_id:"不明回执再核对"});
  assert.equal(next.needsAttention,true);assert.equal(f.calls.filter(c=>c.includes("--wait-submit")).length,1);
});
test("仅取消尚未发送的精确队列项，不发送终端输入", async () => {
  const f=fixture(),r=await f.attach();await f.api({action:"enqueue",id:r.id,controller_id:"主控一",request_id:"待取消队列",prompt:"普通任务",process_docs:false});
  const cancelled=await f.api({action:"cancel_queued",id:r.id,controller_id:"主控一",request_id:"取消待发一",queued_request_id:"待取消队列"});
  assert.equal(cancelled.inputMayHaveBeenSent,false);assert.equal(cancelled.state,"cancelled");
  const next=await f.api({action:"dispatch_queue",id:r.id,controller_id:"主控一",request_id:"取消后核对"});assert.equal(next.queueEmpty,true);
  assert.equal(f.calls.some(c=>c.includes("--wait-submit")),false);
});

test("Orca重启后显式重绑定保留接入记录与原指令，既不重开也不重发", async () => {
  const f = fixture(), first = await f.attach();
  f.t.handle = "term_重启后"; f.t.incarnationId = "实例二"; f.state.runtime = "运行时二";
  const rebound = await f.api({ action: "rebind", id: first.id, terminal_id: f.t.handle, controller_id: "主控一", request_id: "重绑定一", idle_confirmed: true });
  assert.equal(rebound.id, first.id); assert.equal(rebound.terminalId, "term_重启后"); assert.equal(rebound.binding.state, "verified"); assert.equal(f.state.launches, 0);
  assert.equal(f.calls.some((c) => c[1] === "close"), false);
});
test("重接同一UUID保留记录编号，状态发现失效时返回恢复指引", async () => {
  const f = fixture(), first = await f.attach(); f.t.handle = "term_新句柄"; f.t.incarnationId = "新实例"; f.state.runtime = "新运行时";
  const before = f.calls.length, stale = await f.api({ action: "status", id: first.id, controller_id: "主控一" });
  assert.equal(stale.binding.state, "stale"); assert.equal(f.calls.slice(before).some((c) => c[1] === "send"), false);
  const next = await f.attach({ request_id: "重新接入一" }); assert.equal(next.id, first.id); assert.equal(next.binding.rebound, true);
});
test("重绑定拒绝不同UUID；PTY未提交文字不被覆盖", async () => {
  for (const mode of ["wrong", "draft"]) {
    const f = fixture(), first = await f.attach(); f.t.handle = "term_替代"; f.t.incarnationId = "新实例"; f.state.runtime = "新运行时";
    if (mode === "wrong") f.state.session = crypto.randomUUID();
    else { f.state.screen = ["❯ 尚未提交的终端文字"]; }
    const before = f.calls.length;
    await assert.rejects(f.api({ action: "rebind", id: first.id, terminal_id: f.t.handle, controller_id: "主控一", request_id: "重绑定一", idle_confirmed: true }), mode === "wrong" ? /身份不匹配/ : /终端输入区/);
    if (mode === "draft") assert.equal(f.calls.slice(before).some((c) => c[1] === "send"), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, "会话", `${first.id}.json`))).terminalId, first.terminalId);
  }
});

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

test("终端有未提交文字或正在工作时不注入任何文字", async () => {
  for (const mode of ["draft", "busy"]) {
    const f = fixture(); if (mode === "draft") f.state.screen = ["❯ 人类草稿"]; else if (mode === "hidden-draft") f.state.draft = "隐藏草稿"; else f.state.idle = false;
    await assert.rejects(f.attach(), /没有找到/); assert.equal(f.calls.filter((c) => c[1] === "send").length, 0);
  }
});
test("UI composer不等于PTY输入，保留UI文字但不阻身份握手", async () => {
  const f = fixture(); f.state.draft = "UI里尚未发出的草稿"; const r = await f.attach(); assert.equal(r.sessionId, f.session); assert.equal(f.state.draft, "UI里尚未发出的草稿");
  assert.ok(f.calls.filter(c=>c[1]==="send").every(c=>["/status", "\u001b"].includes(c[c.indexOf("--text")+1])));
});
test("UI草稿按完整正文提交一次，副本请求不会再派发", async () => {
  const f = fixture(), r = await f.attach(); f.state.draft = "确认过的完整草稿";
  const hash = crypto.createHash("sha256").update(f.state.draft).digest("hex");
  const args = { action: "submit_draft", id: r.id, controller_id: "主控一", request_id: "草稿提交一", prompt: f.state.draft, draft_hash: hash, draft_confirmed: true, idle_confirmed: true, process_docs: false };
  const first = await f.api(args); assert.equal(first.submission.started, false); assert.equal(first.uiComposerRetained, true);
  const second = await f.api({ ...args, request_id: "草稿提交二" }); assert.equal(second.duplicateDraft, true);
  assert.equal(f.calls.filter(c=>c[1]==="send"&&c.some(v=>v.startsWith("确认过的完整草稿"))).length, 1);
});
test("查询可按精确会话或请求映射，修改仍要求接入记录ID", async () => {
  const f = fixture(), r = await f.attach(); const bySession = await f.api({ action: "status", controller_id: "主控一", session_id: f.session, cwd: f.cwd }); assert.equal(bySession.id, r.id);
  await assert.rejects(f.api({ action: "send", id: f.session, controller_id: "主控一", request_id: "不可用会话id代替记录", prompt: "不发送" }), /修改操作须用/);
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

test("新建可见原生终端，模型默认继承，重复创建只有一个实例", async () => {
  const f = fixture(), args = { action: "create", cwd: f.cwd, controller_id: "主控一", request_id: "新建一" };
  const r = await f.api(args), duplicate = await f.api(args);
  assert.equal(f.state.launches, 1); assert.equal(r.createdByPlugin, true); assert.equal(r.model, null); assert.equal(duplicate.id, r.id);
  const command = f.calls.find((c) => c[1] === "create");
  assert.ok(command.includes(process.platform === "win32" ? "pwsh.exe" : "/bin/zsh")); assert.ok(command.some((part) => part.includes(`--session-id '${r.sessionId}'`)));
});

test("创建回执不明时重复请求只返回不明状态", async () => {
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
