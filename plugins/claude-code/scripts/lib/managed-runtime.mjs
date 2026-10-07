import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const brokerRequire = createRequire(new URL("../managed-broker.mjs", import.meta.url));

export function ensurePtyRuntime() {
  try {
    brokerRequire("node-pty");
    return { ready: true, installed: false };
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_DLOPEN_FAILED") {
      throw new Error(`终端依赖无法加载：${error.message}`);
    }
  }
  if (!fs.existsSync(path.join(PLUGIN_ROOT, "package.json"))) {
    throw new Error("插件安装包缺少 package.json，无法准备原生终端依赖");
  }
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm.cmd", "install", "--omit=dev", "--no-audit", "--no-fund"]
    : ["install", "--omit=dev", "--no-audit", "--no-fund"];
  try {
    execFileSync(command, args, { cwd: PLUGIN_ROOT, timeout: 180_000,
      windowsHide: true, stdio: "pipe" });
    brokerRequire("node-pty");
  } catch (error) {
    throw new Error(`原生终端依赖安装失败（退出码 ${error.status ?? "未知"}）。请在插件目录 ${PLUGIN_ROOT} 运行 npm install。`);
  }
  return { ready: true, installed: true };
}
