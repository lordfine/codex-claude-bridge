import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { redactText } from "./会话读取.mjs";

const levels = ["low", "medium", "high"];
export function validateThinking(value) {
  if (!levels.includes(value)) throw new Error("思考档位须为 low、medium 或 high");
  return value;
}
export function thinkingPlan(task, config) {
  const base = task?.thinkingLevel || config.thinkingLevel || "medium";
  const escalation = task?.thinkingEscalation;
  const currentRequest = task?.lastInstruction?.requestId;
  const active = escalation && escalation.requestId === currentRequest;
  const level = active ? escalation.level : base;
  return { level, base, source: task?.thinkingLevel ? "task" : "controller", escalation: active ? escalation : null,
    codexEffort: level, claudeEffort: level, subagentEffort: level,
    delegation: level === "low" ? "明确子任务主动委派，小改动直接完成" : "按任务独立性委派，避免重复探索",
    desktopControl: "current_turn_not_controlled", providerVerification: "unverified" };
}
export function claudeThinkingArgs(plan, agentsFile = null) {
  // 使用会话参数与自定义代理定义；全局 effort 环境变量会覆盖子代理独立设置。
  const agents = Object.fromEntries(levels.map(level => [`ccb-${level}`, {
    description: `${level} 投入的明确边界实现、定位或只读检查`,
    prompt: "只完成委派范围，优先定位读取，避免重复全量检查。回传短结论、文件位置、实际检查和未覆盖项。正式批次交付由主会话汇总。",
    model: "inherit", effort: level
  }]));
  if (agentsFile) {
    // 交互CLI的 --agents 文件参数仅在 -p 可用；会话专用插件目录避免命令行JSON转义与全局安装。
    const dir = agentsFile.replace(/\.json$/, ""), manifest = path.join(dir, ".claude-plugin");
    fs.mkdirSync(manifest, { recursive: true }); fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    fs.writeFileSync(path.join(manifest, "plugin.json"), JSON.stringify({ name: "codex-claude-execution", version: "1.0.0", description: "会话专用分档执行代理" }), "utf8");
    for (const level of levels) {
      const agent = agents[`ccb-${level}`], name = level === "low" ? "低投入" : level === "medium" ? "中投入" : "高投入";
      fs.writeFileSync(path.join(dir, "agents", `${name}.md`), `---\nname: ccb-${level}\ndescription: ${agent.description}\nmodel: inherit\neffort: ${level}\n---\n\n${agent.prompt}\n`, "utf8");
    }
    return ["--effort", validateThinking(plan.level), "--plugin-dir", dir];
  }
  return ["--effort", validateThinking(plan.level), "--agents", JSON.stringify(agents)];
}
export function thinkingInstruction(plan) {
  const name = `桥接${plan.level === "low" ? "低" : plan.level === "medium" ? "中" : "高"}投入`;
  return `\n\n## 执行\n思考档位=${plan.level}。${plan.delegation}；委派时优先用${name}代理，类型codex-claude-execution:ccb-${plan.level}（未加载时沿用可用代理并报告限制），只提供该子任务必要上下文。主会话汇总交付，子代理不抢发正式完成。困难或重复失败时回传需升档的原因；不重复读全文或循环查状态。`;
}
export function environmentFingerprint(cwd, declared = "") {
  // 不读取环境变量或凭据；调用方须声明数据库、数据集等外部环境身份。
  let head = "";
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim(); } catch {}
  return crypto.createHash("sha256").update(JSON.stringify([process.platform, process.version, head, declared])).digest("hex");
}
export function cleanCheck(args) {
  if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(args.check_id || "") || !args.scope?.trim() || !args.environment?.trim() || !args.command?.trim() || !["passed", "failed"].includes(args.result)) throw new Error("检查记录须提供编号、范围、环境身份、命令和结果");
  if ([args.scope, args.environment, args.command, args.evidence || "", args.uncovered || ""].some(s => typeof s !== "string" || s.length > 3000)) throw new Error("检查字段须为不超过3000字的文本");
  if (!args.evidence?.trim()) throw new Error("检查结果须有可核验的证据位置或摘要");
  return Object.fromEntries(["scope", "environment", "command", "result", "evidence", "uncovered"].map(k => [k, redactText(args[k] || "")]));
}
