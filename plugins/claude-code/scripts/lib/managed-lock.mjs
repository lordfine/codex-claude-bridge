import fs from "node:fs";
import path from "node:path";
import { MANAGED_ROOT, readJson, writeJson } from "./managed-state.mjs";

export function withSessionLock(sessionId, operation) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("会话 ID 无效");
  const folder = path.join(MANAGED_ROOT, "session-locks"); fs.mkdirSync(folder, { recursive: true });
  const lock = path.join(folder, `${sessionId.toLowerCase()}.lock`), ownerFile = path.join(lock, "owner.json");
  try { fs.mkdirSync(lock); }
  catch {
    const owner = readJson(ownerFile);
    if (owner?.pid === process.pid) return operation();
    let alive = owner?.pid ? true : Date.now() - fs.statSync(lock).mtimeMs < 5000;
    if (owner?.pid) { try { process.kill(owner.pid, 0); } catch { alive = false; } }
    if (alive) {
      const error = new Error("该 Claude 会话正在创建或恢复，请稍后重试"); error.code = "SESSION_LOCK_BUSY"; throw error;
    }
    if (fs.existsSync(ownerFile)) fs.unlinkSync(ownerFile);
    fs.rmdirSync(lock); fs.mkdirSync(lock);
  }
  try { writeJson(ownerFile, { pid: process.pid }); }
  catch (error) { fs.rmdirSync(lock); throw error; }
  try { return operation(); }
  finally { fs.unlinkSync(ownerFile); fs.rmdirSync(lock); }
}
