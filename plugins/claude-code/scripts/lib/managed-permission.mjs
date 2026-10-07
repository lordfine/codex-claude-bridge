import path from "node:path";
import fs from "node:fs";

const CREDENTIAL_NAME = /(?:^|[\s'"=:\\/])(?:\.env(?:\.[^\s'"\\/]*)?|\.ssh|id_(?:rsa|ed25519)|credentials?(?:\.[^\s'"\\/]*)?|secrets?(?:\.[^\s'"\\/]*)?|\.aws|\.kube)(?=$|[\s'"\\/])/i;
const DANGEROUS_COMMAND = /(?:\brm\s+-[a-z]*r|\bRemove-Item\b[^\n]*(?:-Recurse|-Force)|\bdel\s+\/s|\bgit\s+(?:push|reset\s+--hard|rebase|filter-repo)|\b(?:ssh|scp|rsync)\b|\b(?:kubectl|terraform|ansible|pg_dump|psql)\b|\bdocker\s+compose\b[^\n]*\b(?:up|down|run|exec)\b|\b(?:curl|wget|Invoke-WebRequest)\b[^\n]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|-Method\s*(?:Post|Put|Patch|Delete)))/i;
const SAFE_COMMAND = /^(?:pwd|Get-Location|ls|git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|ls-tree)(?:\s+[^;&|]*)?|rg(?:\s+[^;&|]*)?|npm\s+(?:run\s+(?:build|lint|typecheck)|test)(?:\s+[^;&|]*)?|node\s+--check\s+[^;&|]+|python(?:3)?\s+-m\s+(?:pytest|compileall)(?:\s+[^;&|]*)?)$/i;
const SAFE_SEPARATOR = /^echo\s+['"]-{2,8}['"]$/i;
function normalizeSafeCommand(command, cwd) {
  const parts = command.split(/\s*&&\s*/).map((part) => part.trim());
  const quotedPath = '"([^"]+)"|\'([^\']+)\'|([^\s;&|]+)';
  const cd = new RegExp(`^cd\\s+(?:${quotedPath})$`, "i").exec(parts[0] || "");
  if (cd) {
    if (path.resolve(cd[1] || cd[2] || cd[3]) !== cwd) return null;
    parts.shift();
  }
  if (!parts.length) return null;
  return parts.map((part) => {
    const gitC = new RegExp(`^git\\s+-C\\s+(?:${quotedPath})\\s+(.+)$`, "i").exec(part);
    if (!gitC) return part;
    if (path.resolve(gitC[1] || gitC[2] || gitC[3]) !== cwd) return null;
    return `git ${gitC[4]}`;
  });
}
function isSafeCommand(command, cwd) {
  if (/\b(?:rg|git)\b[^\n]*(?:--pre(?:=|\b)|--ext-diff\b|--output(?:=|\b)|--hidden\b|--no-ignore\b|\s-uu\b)/i.test(command)) return false;
  const parts = normalizeSafeCommand(command, cwd);
  return Boolean(parts && parts.every((part) => part && (SAFE_COMMAND.test(part) || SAFE_SEPARATOR.test(part))));
}

function isReviewReadOnlyCommand(command, cwd) {
  // 审查在独立快照工作树中运行；构建和定向检查可写入该隔离副本。
  return isSafeCommand(command, cwd);
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function classifyPermission(request, task) {
  const tool = String(request.tool_name || "");
  const input = request.tool_input || {};
  const file = String(input.file_path || input.path || input.notebook_path || "");
  const command = String(input.command || "").trim();
  const cwd = path.resolve(task.cwd);

  if (task.kind === "review") {
    if (["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"].includes(tool)) {
      return { kind: "deny", reason: "审查会话只读" };
    }
    if (["Bash", "PowerShell"].includes(tool)) {
      if (!isReviewReadOnlyCommand(command, cwd)) return { kind: "deny", reason: "审查会话仅允许明确只读命令" };
    }
  }

  if (file && CREDENTIAL_NAME.test(file)) return { kind: "user", reason: "凭据路径" };
  if (file.startsWith("~")) return { kind: "codex", reason: "主目录路径" };
  const absolute = file ? path.resolve(cwd, file) : "";
  if (file && !inside(cwd, absolute)) {
    return { kind: "codex", reason: "任务目录外的文件" };
  }
  if (file) {
    try {
      const rootReal = fs.realpathSync(cwd);
      let existing = absolute;
      while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
      const targetReal = fs.realpathSync(existing);
      if (!inside(rootReal, targetReal)) return { kind: "codex", reason: "路径通过符号链接指向任务目录外" };
    } catch { return { kind: "codex", reason: "无法确认文件的真实路径" }; }
  }
  if (["ToolSearch", "Glob", "Grep", "LS", "LSP", "TodoWrite", "TaskList", "TaskGet"].includes(tool)) {
    return { kind: "allow", reason: "本地普通操作" };
  }
  if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    if (!file) return { kind: "codex", reason: "文件路径未明确" };
    if (tool === "MultiEdit" && Array.isArray(input.edits) && input.edits.length > 10) {
      return { kind: "codex", reason: "单次批量修改较多" };
    }
    if (tool === "Write" && String(input.content || "").length > 200_000) {
      return { kind: "codex", reason: "单次覆盖内容较大" };
    }
    return { kind: "allow", reason: "任务目录内的文件操作" };
  }
  if (["Agent", "Task"].includes(tool)) return { kind: "allow", reason: "子代理继承当前门禁" };
  if (["Bash", "PowerShell"].includes(tool)) {
    if (CREDENTIAL_NAME.test(command)) return { kind: "user", reason: "命令可能读取凭据" };
    if (DANGEROUS_COMMAND.test(command)) return { kind: "codex", reason: "敏感系统或远端命令" };
    if (isSafeCommand(command, cwd)) return { kind: "allow", reason: "常见本地检查或构建" };
    return { kind: "codex", reason: "未归类的命令" };
  }
  return { kind: "codex", reason: "未归类的工具" };
}
