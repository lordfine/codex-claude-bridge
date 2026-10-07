import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { MANAGED_ROOT, configuredModels, readJson, resolveModel, writeJson } from "./managed-state.mjs";

export function projectIdentity(cwd) {
  if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("目标仓库必须是已存在的绝对目录");
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { root = cwd; }
  const real = fs.realpathSync.native(root);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

function profile(cwd) {
  const project = projectIdentity(cwd);
  const file = path.join(MANAGED_ROOT, "projects", `${crypto.createHash("sha256").update(project).digest("hex")}.json`);
  return { project, file, value: readJson(file) || { implementation: null, review: null } };
}

export function projectModels(cwd, changes) {
  const data = profile(cwd);
  if (changes && Object.keys(changes).length) {
    for (const role of ["implementation", "review"]) {
      if (!Object.hasOwn(changes, role)) continue;
      const choice = changes[role];
      if (choice !== null && typeof choice !== "string") throw new Error("模型偏好须为名称、槽位或 null");
      resolveModel(choice);
      data.value[role] = choice === "inherit" || choice === "" ? null : choice;
    }
    writeJson(data.file, data.value);
  }
  return { project: data.project, defaults: data.value, available: configuredModels() };
}

export function roleModel(cwd, role, explicit) {
  const choice = explicit !== undefined ? explicit : profile(cwd).value[role];
  return resolveModel(choice);
}
