// 评判 skill-creator 收集的模拟动作；不调用模型，不把决策模拟当业务实跑。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skill = path.join(root, "plugins", "claude-code", "skills", "consult-claude");
const work = process.argv[2] || path.join(root, ".技能评估", "consult-claude", "iteration-1");
const cases = JSON.parse(fs.readFileSync(path.join(skill, "evals", "evals.json"), "utf8")).evals;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8"); };
const rows = [];
for (const e of cases) for (const config of ["with_skill", "old_skill"]) {
  const dir = path.join(work, `eval-${e.id}-${e.name}`, config), outputs = path.join(dir, "outputs");
  const candidate = fs.readdirSync(outputs).find((n) => n.endsWith(".json"));
  if (!candidate) throw new Error(`没有评估输出：${dir}`);
  const data = JSON.parse(fs.readFileSync(path.join(outputs, candidate), "utf8"));
  const actions = data.actions || [], json = JSON.stringify(data), isLow = /low|低频/.test(String(data.profile));
  const checks = e.id === 1 ? [data.profile === "medium", data.loop === false && !actions.some((a) => /sleep/.test(String(a.tool))),
    !actions.some((a) => ["send", "create", "dispatch", "merge"].includes(a.action)), data.next_action === "end_turn"] :
    e.id === 2 ? [isLow, data.ordinary_subtask_wake === false, data.escalation === true, data.claim_stopped === false, data.merge === false] :
    [actions.some((a) => a.tool === "delegate_history"), /8192/.test(json) && /g1/.test(json) && /120/.test(json),
      data.takeover === false && data.send === false, data.screen_cursor_used_as_history === false];
  const expectations = e.expectations.map((text, i) => ({ text, passed: checks[i], evidence: `依据 ${candidate} 的结构化模拟动作：${checks[i] ? "符合" : "缺失或不符合"}` }));
  const passed = checks.filter(Boolean).length, result = { expectations, summary: { passed, failed: checks.length - passed, total: checks.length, pass_rate: passed / checks.length },
    eval_feedback: { claims_analysis: "只验证模拟决策，未以此证明真实业务成功或计费节省", critique: "三例小样本，停止声明等保守规则两版均可满足；主要差异是档位、普通阶段过滤和历史入口" } };
  write(path.join(dir, "grading.json"), result); write(path.join(dir, "run-1", "grading.json"), result);
  write(path.join(dir, "run-1", "timing.json"), { tokens_available: false, timing_available: false });
  write(path.join(path.dirname(dir), "eval_metadata.json"), { eval_id: e.id, eval_name: e.name, prompt: e.prompt, assertions: e.expectations });
  rows.push({ case: e.name, config, passed, total: checks.length });
}
process.stdout.write(JSON.stringify({ results: rows, metricLimit: "没有平台单次模型token统计；不比较token和速度" }) + "\n");
