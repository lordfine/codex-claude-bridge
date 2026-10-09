import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { updateJson } from "../plugins/claude-code/scripts/lib/原子文件.mjs";
import { writeJson } from "../plugins/claude-code/scripts/lib/managed-state.mjs";
import { emptyPrompt } from "../plugins/claude-code/scripts/lib/Orca会话.mjs";
import { messageOrigin } from "../plugins/claude-code/scripts/lib/会话读取.mjs";

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
