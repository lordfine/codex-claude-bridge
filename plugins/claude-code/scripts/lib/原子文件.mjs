import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function locked(file, work) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.写锁`, ownerFile = path.join(lock, "持有者.json"), deadline = Date.now() + 3000;
  while (true) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (["EPERM", "EACCES", "EBUSY"].includes(error.code) && Date.now() < deadline) { sleep(10); continue; }
      if (error.code !== "EEXIST") throw error;
      let owner; try { owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")); } catch {}
      let alive = true; if (owner?.pid) { try { process.kill(owner.pid, 0); } catch (e) { alive = e.code !== "ESRCH"; } }
      let age; try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      if (!alive || !owner && age > 5000) {
        try { fs.unlinkSync(ownerFile); } catch {}
        try { fs.rmdirSync(lock); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw Object.assign(new Error("状态文件正被其他写入器占用，保留原快照并稍后重试"), { code: "EBUSY" });
      sleep(10);
    }
  }
  try { fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid }), "utf8"); return work(); }
  finally { try { fs.unlinkSync(ownerFile); fs.rmdirSync(lock); } catch {} }
}
// 始终替换原文件，绝不先删除目的文件；短暂共享锁不应丢失有效快照。
export function atomicJson(file, value, options = {}) { return locked(file, () => replace(file, value, options)); }
export function updateJson(file, change) {
  return locked(file, () => {
    let current; try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const next = change(current);
    return next === undefined ? current : replace(file, next);
  });
}
function replace(file, value, { rename = fs.renameSync, delays = [10, 20, 40, 80, 160, 250] } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    for (let attempt = 0; ; attempt++) {
      try { rename(temporary, file); return value; }
      catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= delays.length) throw error;
        sleep(delays[attempt]);
      }
    }
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
