import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { findSession } from "./会话读取.mjs";
export function logActivity(sessionId, cwd, { now = Date.now(), quietMs = 15 * 60 * 1000 } = {}) {
  const file = findSession(sessionId, cwd), main = fs.statSync(file), values = [["main", main.size, main.mtimeMs]];
  const folder = path.join(path.dirname(file), sessionId, "subagents");
  let files = []; try { files = fs.readdirSync(folder, { withFileTypes: true }); } catch {}
  for (const entry of files.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).slice(0, 200)) {
    try { const s = fs.statSync(path.join(folder, entry.name)); values.push([entry.name, s.size, s.mtimeMs]); } catch {}
  }
  const lastActivityMs = Math.max(...values.map((v) => v[2]));
  return { revision: crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex"), lastActivityAt: new Date(lastActivityMs).toISOString(),
    quietForMs: Math.max(0, now - lastActivityMs), quietThresholdMs: quietMs, subagentLogs: values.length - 1,
    suspectedStall: now - lastActivityMs >= quietMs, evidence: "main_and_subagent_jsonl", terminalOutputUsed: false };
}
