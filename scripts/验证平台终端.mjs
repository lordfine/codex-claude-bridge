// 无模型的真实 PTY 与通信探针，适用于 Windows、macOS 和 Linux。
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { ipcEndpoints, sessionProcessRunning } from "../plugins/claude-code/scripts/lib/平台适配.mjs";
const require = createRequire(import.meta.url), pty = require("node-pty");
const endpoints = ipcEndpoints(crypto.randomUUID());
const server = net.createServer((s) => s.end("通信确认"));
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoints.control, resolve); });
  const received = await new Promise((resolve, reject) => { const socket = net.createConnection(endpoints.control); let s = ""; socket.setTimeout(10000, () => socket.destroy(new Error("通信超时"))); socket.on("data", (b) => s += b); socket.once("error", reject); socket.once("end", () => { socket.destroy(); resolve(s); }); });
  if (received !== "通信确认") throw new Error("通信回执错误");
  const child = pty.spawn(process.execPath, ["-e", 'process.stdout.write("READY\\n");process.stdin.once("data",b=>{process.stdout.write("ACK:"+b.toString().trim()+"\\n");process.exit(0);});'], { cwd: process.cwd(), cols: 80, rows: 24, name: "xterm-256color", env: process.env });
  let output = "", sent = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("真实PTY探针超时")); }, 20000);
    child.onData((s) => { output += s; if (!sent && output.includes("READY")) { sent = true; child.resize(100, 30); child.write("平台探针\r"); } });
    child.onExit(({ exitCode }) => { clearTimeout(timer); if (exitCode !== 0 || !output.includes("ACK:平台探针")) reject(new Error("真实PTY中文读写或退出失败")); else resolve(); });
  });
  const unused = crypto.randomUUID();
  if (sessionProcessRunning(unused)) throw new Error("无法确认不存在的会话进程；需排查平台进程查询");
  process.stdout.write(JSON.stringify({ 平台: process.platform, 架构: process.arch, Node: process.version, 真实PTY: true, 中文读写: true, 缩放: true, 通信: true, 进程检测: true, 模型调用: 0 }) + "\n");
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (endpoints.directory) { for (const p of [endpoints.control, endpoints.terminal]) { try { fs.unlinkSync(p); } catch {} } fs.rmdirSync(endpoints.directory); }
}
process.exit(0);
