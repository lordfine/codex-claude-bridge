import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const brokerRequire = createRequire(new URL("../managed-broker.mjs", import.meta.url));

function prepareDarwinHelper() {
  if (process.platform !== "darwin") return;
  const root = fs.realpathSync(path.dirname(brokerRequire.resolve("node-pty/package.json")));
  // node-pty 1.1.0 部分 npm 包缺少 spawn-helper 执行位，上游 #850/#919。
  for (const dir of ["build/Release", "build/Debug", `prebuilds/darwin-${process.arch}`]) {
    const file = path.join(root, dir, "spawn-helper");
    if (!fs.existsSync(file)) continue;
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || !fs.realpathSync(file).startsWith(root + path.sep)) throw new Error("终端启动辅助文件边界异常");
    const mode = fs.statSync(file).mode;
    if (!(mode & 0o100)) fs.chmodSync(file, mode | 0o100);
    fs.accessSync(file, fs.constants.X_OK);
  }
}

export function ensurePtyRuntime() {
  try {
    prepareDarwinHelper();
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
    prepareDarwinHelper(); brokerRequire("node-pty");
  } catch (error) {
    throw new Error(`原生终端依赖安装失败（退出码 ${error.status ?? "未知"}）。请在插件目录 ${PLUGIN_ROOT} 运行 npm install。`);
  }
  return { ready: true, installed: true };
}
