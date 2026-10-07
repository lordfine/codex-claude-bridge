import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { taskDir, writeJson } from "./managed-state.mjs";

const HOOK_FILE = fileURLToPath(new URL("../managed-hook.mjs", import.meta.url));

export function prepareClaudeSettings(task) {
  const command = { type: "command", command: process.execPath, args: [HOOK_FILE], timeout: 40 };
  const ordinary = [{ hooks: [command] }];
  const settings = {
    permissions: task.kind === "review" ? { ask: ["*"] } : { ask: ["*"] },
    hooks: {
      UserPromptSubmit: ordinary,
      PermissionRequest: [{ matcher: "*", hooks: [command] }],
      PostToolUse: [{ matcher: "*", hooks: [command] }],
      Stop: ordinary,
      StopFailure: ordinary,
      Notification: [{ matcher: "agent_needs_input|permission_prompt", hooks: [command] }],
      SubagentStart: ordinary,
      SubagentStop: ordinary,
      UserPromptExpansion: [{ matcher: "交还", hooks: [command] }]
    }
  };
  const file = path.join(taskDir(task.id), "claude-settings.json");
  writeJson(file, settings);
  return file;
}

export function prepareHandbackCommand(task) {
  const file = path.join(task.cwd, ".claude", "commands", "交还.md");
  if (fs.existsSync(file)) return { file, owned: false };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "将当前 Claude Code 窗口的控制权交还 Codex。\n", "utf8");
  return { file, owned: true };
}

export function removeHandbackCommand(task, owned) {
  if (!owned) return;
  const file = path.join(task.cwd, ".claude", "commands", "交还.md");
  try {
    if (fs.readFileSync(file, "utf8") === "将当前 Claude Code 窗口的控制权交还 Codex。\n") fs.unlinkSync(file);
  }
  catch { /* 用户可能已经自行移动或删除。 */ }
}
