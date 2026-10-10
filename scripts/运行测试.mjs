import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const supported = new Set(["managed.test.mjs", "protocol.test.mjs", "协作流程.test.mjs", "会话管理.test.mjs", "终端边界.test.mjs", "事件续接.test.mjs", "Orca会话.test.mjs", "协作策略.test.mjs", "跨平台协同.test.mjs", "续接诊断.test.mjs"]);
const selected = fs.readdirSync(path.join(root, "tests"))
  .filter((name) => supported.has(name) || ["复盘回归.test.mjs", "主动回传.test.mjs"].includes(name))
  .map((name) => path.join(root, "tests", name));
process.stdout.write("运行当前桥接器与 MCP 协议检查。\n");
const result = spawnSync(process.execPath, ["--test", ...selected], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
