#!/usr/bin/env node
import net from "node:net";
import { readRuntime } from "./lib/managed-state.mjs";

const id = process.argv[2];
const runtime = id && readRuntime(id);
if (!runtime?.terminalPipe || !runtime?.controlPipe) {
  process.stderr.write("未找到正在运行的托管 Claude 会话。\n");
  process.exit(1);
}

function resize(first = false) {
  const cols = process.stdout.columns, rows = process.stdout.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
  const control = net.createConnection(runtime.controlPipe);
  control.on("connect", () => control.end(JSON.stringify({ type: "resize", cols, rows, first }) + "\n"));
  control.on("error", () => {});
}

const socket = net.createConnection(runtime.terminalPipe);
const raw = Boolean(process.stdin.isTTY && process.stdin.setRawMode);
if (raw) process.stdin.setRawMode(true);
process.stdin.resume();
const close = (code = 0) => {
  if (raw) process.stdin.setRawMode(false);
  socket.destroy();
  process.exit(code);
};
process.stdin.on("data", (bytes) => {
  // Ctrl+D 只关闭窗口客户端；后台桥接器继续持有 Claude 会话。
  if (bytes.includes(4)) return close();
  socket.write(bytes);
});
socket.on("connect", () => resize(true));
socket.on("data", (bytes) => process.stdout.write(bytes));
socket.on("close", () => close());
socket.on("error", (error) => {
  process.stderr.write(`终端连接失败：${error.message}\n`);
  close(1);
});
process.stdout.on("resize", () => resize());
