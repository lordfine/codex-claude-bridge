// 从已提交的 Git 引用打包，运行数据和依赖不进入发布包。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)), ref = process.argv[2] || "HEAD";
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
if (git(["status", "--porcelain"])) throw new Error("工作树必须干净，请先提交变更");
const manifest = JSON.parse(git(["show", `${ref}:plugins/claude-code/.codex-plugin/plugin.json`]));
const names = git(["ls-tree", "-r", "--name-only", ref]).split("\n");
if (names.some((name) => /(^|\/)(node_modules|\.claude)(\/|$)|(^|\/)\.env($|\.)|\/(task|runtime)\.json$/.test(name))) throw new Error("引用包含运行文件，不可发布");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-claude-bridge-release-"));
// GitHub 附件名采用兼容标识，发布页面使用中文显示标签。
const archiveName = `codex-claude-bridge-v${manifest.version}.zip`, archive = path.join(dir, archiveName);
git(["archive", "--format=zip", "--prefix=codex-claude-bridge/", "-o", archive, ref]);
const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
fs.writeFileSync(path.join(dir, "SHA256SUMS.txt"), `${digest}  ${archiveName}\n`, "utf8");
process.stdout.write(JSON.stringify({ version: manifest.version, commit: git(["rev-parse", `${ref}^{commit}`]),
  directory: dir, archive, checksum: path.join(dir, "SHA256SUMS.txt"), sha256: digest }) + "\n");
