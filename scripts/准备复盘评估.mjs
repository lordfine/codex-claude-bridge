import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { wakeDir } from "../plugins/claude-code/scripts/lib/事件队列.mjs";
import { writeJson } from "../plugins/claude-code/scripts/lib/managed-state.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const base = path.join(root, ".技能评估", "桥接复盘", "iteration-1");
const cases = [];
for (const [index, title] of ["完整记录", "日志缺失", "重复与范围"].entries()) {
  const id = index + 1, dir = path.join(base, `eval-${id}-${title}`), input = path.join(dir, "输入"), controller = crypto.randomUUID(), task = crypto.randomUUID(), session = crypto.randomUUID();
  fs.mkdirSync(input, { recursive: true });
  const rollout = path.join(input, "主控.jsonl"), root = path.join(input, "状态"), claudeConfig = path.join(input, "Claude配置");
  const row = (type, payload, second = 0) => ({ type, payload, timestamp: `2026-10-10T00:00:${String(second).padStart(2,"0")}Z` });
  const usage = n => ({ type: "token_count", info: { total_token_usage: { input_tokens: n, cached_input_tokens: n / 2, output_tokens: n / 10 } } });
  if (id !== 2) fs.writeFileSync(rollout, [row("session_meta", { id: controller }), row("event_msg", { type: "task_started" }), row("response_item", { type: "function_call", name: "delegate_status", arguments: '{"token":"测试私密令牌"}' }), row("event_msg", usage(100), 1), row("event_msg", usage(100), 2), row("event_msg", usage(150), 5), row("event_msg", { type: "task_complete" }, 6)].map(JSON.stringify).join("\n"));
  writeJson(path.join(root, "orca", "会话", `${task}.json`), { id: task, controllerId: controller, sessionId: session, cwd: input, state: "attached" });
  writeJson(path.join(wakeDir(root, controller), "config.json"), { controllerId: controller, rolloutPath: rollout, enabled: false });
  const claudeDir = path.join(claudeConfig, "projects", "评估项目"); fs.mkdirSync(claudeDir, { recursive: true });
  const m = { type: "assistant", sessionId: session, cwd: input, timestamp: "2026-10-10T00:00:05Z", message: { id: "固定消息", content: [{ type: "text", text: "不要复制的业务正文" }], usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } };
  if (id !== 2) fs.writeFileSync(path.join(claudeDir, `${session}.jsonl`), [m,m].map(JSON.stringify).join("\n"));
  const prompt = `复盘这项Codex与Claude协作，生成脱敏中文报告及结构化证据包，评估是否有无效等待，费用证据不够时明确未知。${id === 3 ? "只采集2026-10-10T00:00:04Z至2026-10-10T00:01:00Z。" : ""}不要操作业务会话。`;
  const env = { CODEX_THREAD_ID: controller, CC_PLUGIN_CODEX_MANAGED_DIR: root, CLAUDE_CONFIG_DIR: claudeConfig };
  writeJson(path.join(dir, "输入说明.json"), { prompt, env, input, controller });
  writeJson(path.join(dir, "eval_metadata.json"), { eval_id: id, eval_name: title, prompt, assertions: ["生成中文报告和结构化证据包", "不复制凭据与业务正文", "费用缺失保持未知", id === 1 ? "累计Codex输入150且Claude消息去重后输入10" : id === 2 ? "日志缺失时用量未知" : "时间范围内Codex输入50且Claude输入10"] });
  cases.push({ id, prompt, expected_output: "中文报告、证据包与覆盖限制", files: ["由scripts/准备复盘评估.mjs生成隔离输入"] });
}
writeJson(path.join(root, "plugins", "claude-code", "skills", "桥接复盘", "evals", "evals.json"), { skill_name: "bridge-retrospective", evals: cases });
console.log(JSON.stringify({ directory: base, cases: cases.length }));
