// MCP 协议检查的隔离客户端；测试状态不写入用户真实目录。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const PLUGIN_ROOT = path.join(REPO_ROOT, "plugins", "claude-code");
export const SERVER_PATH = path.join(PLUGIN_ROOT, "scripts", "claude-mcp-server.mjs");
const FIXTURES_BIN = path.join(REPO_ROOT, "tests", "fixtures", "bin");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function makeTempHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-bridge-test-")); }
export function fakeClaudeEnv(tmpHome, extra = {}) {
  const env = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, PATH: FIXTURES_BIN + path.delimiter + process.env.PATH,
    CC_PLUGIN_CODEX_SETTINGS: path.join(tmpHome, "settings.json"), ...extra };
  delete env.ANTHROPIC_API_KEY; return env;
}
export function startServer(env = process.env) {
  const child = spawn(process.execPath, [SERVER_PATH], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p(msg);
        }
      } catch {
      }
    }
  });
  let stderrBuf = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderrBuf += c));

  let nextId = 1;
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const rpcWithId = (method, params, timeoutMs = 30000) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id})`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
    send({ jsonrpc: "2.0", id, method, params });
    return { id, promise };
  };
  const rpc = (method, params, timeoutMs) => rpcWithId(method, params, timeoutMs).promise;
  const rpcRawId = (id, method, params, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id})`));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  const raw = (s) => child.stdin.write(s);
  const stop = () => {
    try {
      child.kill("SIGKILL");
    } catch {}
  };
  return { child, rpc, rpcWithId, rpcRawId, notify, raw, stop, stderr: () => stderrBuf };
}

export async function initialized(server) {
  const init = await server.rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-suite", version: "0" }
  });
  server.notify("notifications/initialized", {});
  return init;
}

export const text = (resp) => resp?.result?.content?.map((c) => c.text).join("\n") ?? "";
