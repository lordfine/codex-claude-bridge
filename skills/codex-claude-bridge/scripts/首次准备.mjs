import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCE = "https://github.com/lordfine/codex-claude-bridge.git";
const PLUGIN = "claude-code@codex-claude-bridge";
function execute(program, args) {
  // 所有程序和参数来自固定调用，不拼接用户任务、凭据或网络返回的命令。
  const windows = process.platform === "win32";
  return spawnSync(windows ? "cmd.exe" : program, windows ? ["/d", "/c", program, ...args] : args,
    { encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 2_000_000 });
}
function readPlugin(run) {
  const response = run("codex", ["plugin", "list", "--marketplace", "codex-claude-bridge", "--json"]);
  if (response.status !== 0) return { error: "Codex CLI 的插件查询不可用，请检查版本与插件能力" };
  try {
    const data = JSON.parse(response.stdout);
    return { plugin: (data.installed || []).find(p => p.pluginId === PLUGIN) || null };
  } catch { return { error: "插件查询未返回可解析 JSON，没有修改配置" }; }
}
export function prepareBridge({ install = false, markSupport = false, home = os.homedir(), run = execute } = {}) {
  const marker = path.join(home, ".cache", "codex-claude-bridge", "首次使用.json");
  const shown = () => { try { return JSON.parse(fs.readFileSync(marker, "utf8")).supportPromptShown === true; } catch { return false; } };
  const result = { source: SOURCE, pluginId: PLUGIN, modelCalls: 0, installed: false, enabled: false, supportPromptShown: shown(),
    environmentReady: false, mcpReady: "not_checked", changes: [], missing: [] };
  if (Number(process.versions.node.split(".")[0]) < 20) result.missing.push("Node.js 20+");
  for (const program of ["git", "claude", "codex"]) {
    const response = run(program, ["--version"]);
    if (response.status !== 0) result.missing.push(program);
  }
  if (result.missing.length) return { ...result, state: "dependencies_missing", message: "先安装缺失工具并确认Claude可用；没有安装插件或更改供应商配置" };
  let found = readPlugin(run);
  if (found.error) return { ...result, state: "plugin_query_failed", message: found.error };
  if (install && (!found.plugin?.installed || !found.plugin?.enabled)) {
    for (const [stage, args] of [
      ["marketplace", ["plugin", "marketplace", "add", SOURCE, "--json"]],
      ["plugin", ["plugin", "add", PLUGIN, "--json"]]
    ]) {
      const response = run("codex", args);
      if (response.status !== 0) return { ...result, state: "installation_failed", failedStage: stage, message: "官方安装命令失败，保留已完成步骤；核对后再继续，不修改其他配置" };
      result.changes.push(stage);
    }
    found = readPlugin(run);
    if (found.error) return { ...result, state: "verification_failed", message: found.error };
  }
  result.installed = found.plugin?.installed === true; result.enabled = found.plugin?.enabled === true;
  result.version = found.plugin?.version || null;
  if (!result.installed || !result.enabled) return { ...result, state: "installation_available", message: "可用--安装准备桥接插件；当前没有更改配置" };
  if (markSupport) {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, JSON.stringify({ supportPromptShown: true, at: new Date().toISOString() }) + "\n", "utf8");
    result.supportPromptShown = true;
  }
  const skill = found.plugin.source?.path && path.join(found.plugin.source.path, "skills", "consult-claude", "SKILL.md");
  if (skill && fs.existsSync(skill)) result.runtimeSkillPath = skill;
  return { ...result, state: result.changes.length ? "reload_required" : "installed_in_cli", message: "CLI确认插件已安装并启用；还需核对聊天工具并运行setup，不能据此声称模型或MCP已经可用" };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !["--安装", "--已提示"].includes(arg))) {
    console.error("仅支持默认只读检查、--安装、--已提示"); process.exitCode = 1;
  } else {
    const result = prepareBridge({ install: args.includes("--安装"), markSupport: args.includes("--已提示") });
    console.log(JSON.stringify(result));
    if (["dependencies_missing", "plugin_query_failed", "installation_failed", "verification_failed"].includes(result.state)) process.exitCode = 1;
  }
}
