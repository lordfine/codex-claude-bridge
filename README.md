<div align="center">

# Codex × Claude Bridge

**Codex 负责规划、决策与验收，Claude Code 负责执行。**

[![版本](https://img.shields.io/github/v/release/lordfine/codex-claude-bridge?label=版本)](https://github.com/lordfine/codex-claude-bridge/releases/latest)
[![检查](https://github.com/lordfine/codex-claude-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/lordfine/codex-claude-bridge/actions/workflows/test.yml)
[![许可](https://img.shields.io/github/license/lordfine/codex-claude-bridge?label=许可)](./LICENSE)

[快速开始](./docs/快速开始.md) · [功能与限制](./docs/功能与限制.md) · [开发指南](./docs/开发指南.md)

</div>

## 用途

让 Codex 在本机指挥 Claude Code：派发实现任务、读取进度、安排独立审查、返工和验收。Codex 也可以接手修改代码。

- **原生托管**：独立工作树、可见窗口、持久指令队列、审查合并与事件自动续接。
- **Orca 接入**：按工作区与精确 Claude UUID 接入已运行的空闲会话，无须退出原进程。
- **Orca 新建**：在已注册工作区新建原生 Claude 终端，发送任务并读取结果。
- **当前模型配置**：继承 Claude Code／CCswitch 配置，可指定已有模型槽位或实际模型名。

这是独立维护的项目，采用全新提交历史，保留所使用源码的 MIT 版权声明。[项目来源](./docs/项目来源.md)

## 安装

准备 Node.js 20+、Git、Claude Code CLI 与 Codex。Windows 原生窗口需要 Windows Terminal、PowerShell 7；Orca 路径还需正在运行的 Orca和已注册工作区。

```powershell
git clone https://github.com/lordfine/codex-claude-bridge.git
cd codex-claude-bridge
codex plugin marketplace add .
codex plugin add claude-code@codex-claude-bridge
```

安装后重新加载插件／MCP 实例。首次准备托管终端需要本机 npm 下载 `node-pty`。从旧项目迁移的用户须停用旧插件，避免加载两套同名工具；Claude 会话和本地状态保持原路径，不自动重置。

## 直接这样说

> 让 Claude 在独立工作树实现这个需求，安排独立审查，你验收后合并。

> 接手 Orca 中的 Claude 会话。工作区是〈绝对目录〉，会话编号是〈UUID〉，人类队列已清空。

> 在 Orca 的〈工作区〉新建 Claude 会话，执行〈任务〉，完成后核对结果。

> 后台执行，Claude 完成后自动继续。（原生托管路径）

## 当前范围

| 能力 | 原生托管 | Orca |
| --- | --- | --- |
| 新建、发送、进度与结果读取 | 支持 | 支持 |
| 接入既有会话 | 原进程退出后续接 | 空闲时直接接入 |
| 独立工作树、审查、验收合并 | 支持 | 尚未接入 |
| 并发与运行预算 | 支持 | 尚未接入统一配额 |
| 关键事件自动续接 Codex CLI | 支持 | 尚未接入 |
| 权限与人工交接 | 插件门禁与 `/交还` | 保持原会话权限与 Orca 钩子 |

Windows 为优先实机验证平台；自动检查通过不等同于各平台终端实机验收。原 Codex 桌面打开窗口的即时刷新、长期并发与远程 Orca 仍需验证。[详细限制](./docs/功能与限制.md)

## 开发与反馈

```powershell
npm ci
npm test
```

当前检查覆盖 22 个公开 MCP 工具及其模块行为；清理后保留原有 91 项检查。问题和建议通过 [Issues](https://github.com/lordfine/codex-claude-bridge/issues) 提交，附版本与脱敏复现步骤。

遵循 [MIT 许可](./LICENSE)。
