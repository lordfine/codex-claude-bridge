// 当前公开 MCP 工具定义；历史短咨询接口不属于本项目。
const SETUP_TOOL = {
  name: "setup",
  description:
    "检查 Node.js、Claude Code、当前模型配置和原生终端依赖；依赖缺失时在插件缓存目录安装。deep=true 会额外执行一次小型 Claude 登录验证。",
  inputSchema: {
    type: "object",
    properties: {
      deep: {
        type: "boolean",
        description: "通过一次简短真实 Claude 回复验证当前配置，消耗少量模型用量；默认 false。"
      }
    },
    additionalProperties: false
  }
};

const MANAGED_TOOLS = [
  { name: "delegate_overview", description: "一次读取主控的原生与Orca短进度，包含执行线、会话、工作区、交付快照和暂停待办。无变化结束模型轮；force仅用于用户主动查询。", inputSchema: { type: "object", properties: { controller_id: { type: "string" }, after_revision: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
  {
    name: "delegate_coordination", description: "读取或设置主控的低/中/高协作档位，默认 medium；可逐任务覆盖。prepare 创建忽略 Git 的过程记录；snapshot 核对实际工作目录；handoff 只返回已核验短交付单。普通进度不调用模型，重大异常和需要决定的交付即时处理。",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["status", "configure", "profile", "prepare", "snapshot", "handoff"] },
      controller_id: { type: "string" }, task_id: { type: "string" }, backend: { type: "string", enum: ["native", "orca"] },
      profile: { type: "string", enum: ["low", "medium", "high", "inherit"] }, deep_effort: { type: "string", enum: ["inherit", "low", "medium", "high", "xhigh", "max", "ultra"] }, task_text: { type: "string" }
    }, required: ["action"], additionalProperties: false }
  },
  {
    name: "delegate_history", description: "按原绝对目录与精确 Claude UUID 只读历史或实时 JSONL 正文，无须接管或停止原进程。默认分页、2400字符与常见凭据模式隐藏；使用返回的字节/字符游标续读。不同于屏幕游标。",
    inputSchema: { type: "object", properties: { session_id: { type: "string" }, cwd: { type: "string" },
      cursor: { type: "object" }, max_chars: { type: "integer", minimum: 1, maximum: 16000 },
      roles: { type: "array", items: { type: "string", enum: ["user", "assistant"] } }, include_tools: { type: "boolean" }
    }, required: ["session_id", "cwd"], additionalProperties: false }
  },
  {
    name: "delegate_orca", description: "管理 Orca 原生 Claude 会话。status 默认短状态，用 after_revision 去重；transcript/history 按正文游标分页，read 的 screen_revision 独立去重屏幕。取消返回请求状态，不能据此声称后台全部停止。通过 delegate_wake 可接入本地事件续接；仍不提供 Orca 自动合并和统一执行预算。",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "create", "attach", "send", "status", "read", "wait", "release", "close", "takeover", "cancel", "transcript", "history", "diagnose", "repair_cursor", "human_activity", "rebind", "submit_draft", "confirm_submission"] },
      controller_id: { type: "string" }, cwd: { type: "string" }, id: { type: "string", description: "桥接接入记录UUID，即create/attach/rebind返回的id；绝不能传Claude session_id或terminal_id。status/read/wait/send均用此id。" },
      session_id: { type: "string" }, terminal_id: { type: "string" }, idle_confirmed: { type: "boolean" },
      request_id: { type: "string" }, title: { type: "string" }, model: { type: "string" }, prompt: { type: "string" },
      draft_hash: { type: "string" }, draft_confirmed: { type: "boolean" }, delivery_level: { type: "string", enum: ["subtask", "milestone", "batch", "review", "final"] },
      profile: { type: "string", enum: ["low", "medium", "high"] }, process_docs: { type: "boolean" }, include_text: { type: "boolean" }, stop_confirmed: { type: "boolean" },
      force: { type: "boolean" }, after_revision: { type: "string" }, screen_revision: { type: "string" }, max_chars: { type: "integer" },
      timeout_ms: { type: "integer", minimum: 1, maximum: 60000 }, cursor: { type: ["string", "object"] },
      limit: { type: "integer", minimum: 1, maximum: 300 }, close_attached_confirmed: { type: "boolean" }
    }, required: ["action"], additionalProperties: false }
  },
  {
    name: "delegate_create",
    description: "创建托管 Claude Code 会话。新实现任务自动创建独立 Git 工作树；传入精确 session_id 时在原 cwd 续接既有会话。默认打开原生可见窗口，并复用当前 Claude Code/CCswitch 配置。",
    inputSchema: { type: "object", properties: {
      cwd: { type: "string", description: "绝对工作目录" },
      session_id: { type: "string", description: "仅接入既有会话时填写精确 UUID" },
      existing_idle_confirmed: { type: "boolean", description: "既有会话原进程已退出时才设 true；活动中的外部窗口不能被本桥接器直接接管" },
      model: { type: "string", description: "当前配置中的模型槽或实际模型名；省略则继承" },
      prompt: { type: "string", description: "可选的首条任务指令，待会话就绪后发送" },
      profile: { type: "string", enum: ["low", "medium", "high"] }, process_docs: { type: "boolean" },
      permission_wait_seconds: { type: "integer", minimum: 1, maximum: 900, description: "敏感审批等待Codex秒数，默认300；超时转人工并保留记录" }, max_minutes: { type: "integer", minimum: 0, maximum: 1440, description: "单个会话最大累计执行分钟数，审批与人类挂起暂停计时；默认 0 不限时，仅用户指定时设置正整数" }, max_turns: { type: "integer" }, subagent_limit: { type: "integer" },
      controller_id: { type: "string", description: "主控 Codex 任务 ID；通常从环境自动获取" },
      visible: { type: "boolean", description: "是否自动打开可见窗口，默认 true" }
    }, required: ["cwd"], additionalProperties: false }
  },
  {
    name: "delegate_list", description: "列出当前主控任务的托管 Claude 会话、并发名额和排队状态。",
    inputSchema: { type: "object", properties: { controller_id: { type: "string" }, include_archived: { type: "boolean" } }, additionalProperties: false }
  },
  {
    name: "delegate_status", description: "读取托管任务状态和增量事件。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, force: { type: "boolean" }, cursor: { type: "integer" }, limit: { type: "integer" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_transcript", description: "按需读取指定 Claude 会话近期的助手正文，用于查看实现交付或只读审查短报告。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, max_chars: { type: "integer" }, controller_id: { type: "string" },
      cursor: { type: "object", properties: { message: { type: "integer" }, offset: { type: "integer" } }, required: ["message", "offset"], additionalProperties: false }
    }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_wait", description: "等待托管任务的关键事件；最长 60 秒，返回增量游标。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, cursor: { type: "integer" }, seconds: { type: "number" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_send", description: "向指定托管 Claude 会话排入一条指令，返回唯一指令 ID；状态须继续以事件确认。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, prompt: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id", "prompt"], additionalProperties: false }
  },
  {
    name: "delegate_takeover", description: "Codex 接管指定会话；默认等待当前轮结束，immediate=true 才中断。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, immediate: { type: "boolean" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_permissions", description: "读取或决定 Claude 敏感操作。只传decision_id可查看原记录；仅actionable=true可决定，超时转人工后不能补写批准。未知操作由 Codex 决定；凭据等 user 类仅可拒绝，允许须用户在 Claude 窗口亲自操作。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, decision_id: { type: "string" }, decision: { type: "string", enum: ["allow", "deny"] }, reason: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_open", description: "打开或重新打开原生可见 Claude Code 窗口；Ctrl+D 只关闭窗口。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_limit", description: "设置当前 Codex 主控任务的顶层 Claude 并发上限（1 至 10；默认 3）。",
    inputSchema: { type: "object", properties: { limit: { type: "integer" }, controller_id: { type: "string" } }, required: ["limit"], additionalProperties: false }
  },
  {
    name: "delegate_cancel", description: "取消指定托管 Claude 会话。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_review", description: "为已空闲的实现任务创建独立只读 Claude 审查会话，输出短报告，Codex 负责最终验收。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, focus: { type: "string" }, model: { type: "string" }, permission_wait_seconds: { type: "integer", minimum: 1, maximum: 900, description: "敏感审批等待Codex秒数，默认300；超时转人工并保留记录" }, max_minutes: { type: "integer", minimum: 0, maximum: 1440, description: "单个会话最大累计执行分钟数，审批与人类挂起暂停计时；默认 0 不限时，仅用户指定时设置正整数" }, controller_id: { type: "string" }, visible: { type: "boolean" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_diff", description: "列出实现任务相对基准提交的改动范围，供 Codex 验收；临时 /交还 命令文件须排除。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id"], additionalProperties: false }
  },
  {
    name: "delegate_merge", description: "Codex 完成审查和定向检查后，把独立工作树合并进创建时的目标分支；要求对应只读审查任务和验收结论，冲突留给 Codex 处理。",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, review_id: { type: "string" }, verification: { type: "string" }, controller_id: { type: "string" } }, required: ["task_id", "review_id", "verification"], additionalProperties: false }
  },
  {
    name: "delegate_wait_many", description: "一次等待 1 至 10 个任务，只返回关键事件和短状态；自动读完事件页面，游标按任务分别保存。",
    inputSchema: { type: "object", properties: {
      targets: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", properties: {
        task_id: { type: "string" }, cursor: { type: "integer" } }, required: ["task_id"], additionalProperties: false } },
      seconds: { type: "number" }, controller_id: { type: "string" }
    }, required: ["targets"], additionalProperties: false }
  },
  {
    name: "delegate_models", description: "读取或保存当前仓库的实现、审查默认模型。省略字段保持原值；null 表示继承当前配置。所有工作树共享仓库偏好，不能切换 CCswitch。",
    inputSchema: { type: "object", properties: { cwd: { type: "string" },
      implementation: { type: ["string", "null"] }, review: { type: ["string", "null"] }
    }, required: ["cwd"], additionalProperties: false }
  },
  {
    name: "delegate_workflow", description: "管理一句话委派到交付的可恢复流程。create 记录目标；dispatch 派发独立实现；review 建审查；revise 最多返工两轮；accept 在 Codex 验收后合并。list/status/resume 供续接，checkpoint 保存游标。改变流程须使用稳定 request_id，超时重试不得换 ID。pause 仅暂停协调，cancel 才取消执行。",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["create", "list", "status", "dispatch", "review", "revise", "accept", "checkpoint", "pause", "resume", "cancel"] },
      workflow_id: { type: "string" }, controller_id: { type: "string" }, request_id: { type: "string" },
      profile: { type: "string", enum: ["low", "medium", "high"] }, process_docs: { type: "boolean" },
      cwd: { type: "string" }, goal: { type: "string" }, acceptance: { type: "string" }, detail: { type: "boolean" },
      item_id: { type: "string" }, model: { type: "string" }, feedback: { type: "string" },
      verification: { type: "string" }, summary: { type: "string" }, visible: { type: "boolean" },
      permission_wait_seconds: { type: "integer", minimum: 1, maximum: 900, description: "敏感审批等待Codex秒数，默认300；超时转人工并保留记录" }, max_minutes: { type: "integer", minimum: 0, maximum: 1440, description: "单个会话最大累计执行分钟数，审批与人类挂起暂停计时；默认 0 不限时，仅用户指定时设置正整数" }, max_turns: { type: "integer" }, subagent_limit: { type: "integer" },
      items: { type: "array", minItems: 1, maxItems: 10, items: { type: "object", properties: {
        label: { type: "string" }, prompt: { type: "string" }, model: { type: "string" }
      }, required: ["prompt"], additionalProperties: false } },
      cursors: { type: "array", items: { type: "object", properties: {
        task_id: { type: "string" }, event_cursor: { type: "integer" },
        transcript_cursor: { type: "object", properties: { message: { type: "integer" }, offset: { type: "integer" } }, required: ["message", "offset"], additionalProperties: false }
      }, required: ["task_id"], additionalProperties: false } }
    }, required: ["action"], additionalProperties: false }
  },
  {
    name: "delegate_manage", description: "按精确任务 ID 或唯一别名批量管理会话：查看、命名、追加、接管、取消、挂起、恢复、开窗和归档。send 用稳定 request_id 存入待发箱，排队任务也可接受追加。归档保留结果与关联记录，只清理已保留且干净的插件工作树；已有原目录保留。已合并会话的新工作用 delegate_sessions(reuse)。",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "label", "send", "takeover", "cancel", "suspend", "resume", "restore", "open", "archive"] },
      controller_id: { type: "string" }, task_ids: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
      workflow_id: { type: "string" }, completed: { type: "boolean" }, include_archived: { type: "boolean" },
      query: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" },
      alias: { type: "string" }, prompt: { type: "string" }, request_id: { type: "string" },
      immediate: { type: "boolean" }, reconnect: { type: "boolean" }, cleanup: { type: "boolean" }, summary: { type: "string" }
    }, required: ["action"], additionalProperties: false }
  },
  {
    name: "delegate_sessions", description: "按目录、摘要与时间选择已保存 Claude 会话，只返回元数据。attach 须精确会话 ID、原目录和原进程退出确认；reuse 用当前主控的原任务 ID 或别名，必要时恢复归档工作树，保留 Claude 会话 ID并创建本次新执行记录。接入用稳定 request_id；不会自动选择最近会话或重发旧任务。",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "attach", "reuse"] }, controller_id: { type: "string" },
      cwd: { type: "string" }, query: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" },
      session_id: { type: "string" }, source_task_id: { type: "string" }, existing_idle_confirmed: { type: "boolean" },
      request_id: { type: "string" }, alias: { type: "string" }, prompt: { type: "string" }, model: { type: "string" },
      visible: { type: "boolean" }, permission_wait_seconds: { type: "integer", minimum: 1, maximum: 900, description: "敏感审批等待Codex秒数，默认300；超时转人工并保留记录" }, max_minutes: { type: "integer", minimum: 0, maximum: 1440, description: "单个会话最大累计执行分钟数，审批与人类挂起暂停计时；默认 0 不限时，仅用户指定时设置正整数" }, max_turns: { type: "integer" }, subagent_limit: { type: "integer" }
    }, required: ["action"], additionalProperties: false }
  },
  {
    name: "delegate_wake", description: "diagnose 查看当前故障、心跳与通知回执；inspect/resolve 处理CLI运行，resolve_fault按故障编号和修复依据独立恢复调度。enable不解除故障，effectiveState区分启用与暂停。恢复不清空事件、不改变原启用配置。",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["configure", "enable", "disable", "status", "resolve", "sync", "inspect", "diagnose", "resolve_fault"] },
      task_id: { type: "string" }, backend: { type: "string", enum: ["native", "orca"] }, request_id: { type: "string" },
      controller_id: { type: "string" }, target_thread_id: { type: "string" }, cwd: { type: "string" },
      quiet_seconds: { type: "integer", minimum: 1, maximum: 30 }, run_id: { type: "string" }, fault_id: { type: "string" },
      decision: { type: "string", enum: ["acknowledge", "retry"] }, resolution: { type: "string", description: "独立故障恢复时提供已核对的修复依据，不自动重放或确认旧CLI运行" }
    }, required: ["action"], additionalProperties: false }
  }
];
export const TOOLS = [SETUP_TOOL, ...MANAGED_TOOLS];
