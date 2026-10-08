# Mac 安装与验收

支持目标：macOS 的 Apple Silicon（arm64）与 Intel（x64），同一份源码包。普通托管与 Orca 接入／新建均有平台适配；Mac GUI、自动化首次授权和用户供应商模型仍需你的设备验收。

## 准备

需要 Node.js 22 或 24、Git、已能正常回复的 Claude Code，以及支持插件命令的 Codex CLI。普通可见窗口使用系统 Terminal，无需 Orca。Orca 路径才需要安装并启动 Orca、注册工作区。

在 Terminal 检查：

```bash
node --version
git --version
claude --version
codex --version
codex plugin --help
command -v claude
command -v codex
```

官方入口：[Node.js](https://nodejs.org/en/download)、[Codex CLI](https://developers.openai.com/codex/cli/)、[Claude Code](https://code.claude.com/docs/en/overview)、[Orca](https://www.onorca.dev/)。先保证 Claude 使用当前配置独立工作，插件不改供应商或 CCswitch。

## 安装

```bash
git clone https://github.com/lordfine/codex-claude-bridge.git
cd codex-claude-bridge
codex plugin marketplace add .
codex plugin add claude-code@codex-claude-bridge
```

也可下载 [源码发布包](https://github.com/lordfine/codex-claude-bridge/releases/latest)，解压进入市场根目录后执行后两条。重新加载 Codex 插件／MCP，运行环境准备检查。

原生终端依赖为 node-pty。上游有 darwin-arm64／darwin-x64 预编译流程；缺少合适预编译包时回退源码构建，需要 Xcode 命令行工具。出现明确编译依赖错误时再运行 `xcode-select --install` 并完成系统安装。[依赖说明](https://github.com/microsoft/node-pty#dependencies)

## 可见窗口与 PATH

node-pty 1.1.0 的部分npm包有启动辅助文件缺少执行位的问题，环境准备会在确认依赖目录与文件边界后补齐该文件的用户执行位，不修改二进制内容。[上游问题](https://github.com/microsoft/node-pty/issues/919)

原生托管由后台进程持有 Claude，Terminal 客户端只连接它；关闭客户端不会自动取消后台任务。Node、Claude 和 Codex 路径先解析，不能假定桌面应用与交互 shell 的 PATH 完全一致。

首次需要系统允许相关应用控制 Terminal；拒绝时保留任务并返回打开窗口失败，可以处理授权后重新打开。[Apple 自动化权限说明](https://support.apple.com/guide/mac-help/allow-apps-to-control-other-apps-mchl07817563/mac)

如果依赖缺失或窗口没连接，让 Codex先查看 `setup` 和 `delegate_status`。不要因此改模型配置或新建同一 UUID 的另一个执行进程。

## 验收分两层

**无模型组件检查：**

```bash
npm ci
npm test
node scripts/验证平台终端.mjs
```

真实 PTY 探针检查中文读写、缩放、进程退出、短 Unix socket 通信及进程检测，不调用 Claude 模型。CI 对 macos-15（arm64）与 macos-15-intel（x64）分别运行，Node 22／24 都覆盖。

**你设备上的真实回复和窗口连接：**

```bash
node scripts/实机验收.mjs --确认运行
```

它在临时中文／空格路径创建自己的仓库和可见 Claude 会话，只要求一条“平台实机确认”回复，会使用少量当前模型用量。结束后仅停止自己的任务，保存验收结果绝对路径；不操作既有会话。

请同时确认中文字形、对齐、窗口实时更新和首次授权。脚本确认回复与客户端连接，不能替代对 GUI 外观的人工确认。将生成的 `实机验收结果.json` 和现象反馈给维护者。

## Orca 使用

接入：给 Codex 原绝对工作区、精确 Claude UUID，确认人类当前轮与队列已结束。新建：给已注册工作区，插件使用 macOS shell 和已解析 Claude 路径启动；首次信任／MCP 弹窗在 Orca 处理。

Orca 的自动合并与统一预算仍未接入。需要完整独立工作树、审查与合并时，使用普通托管路径。[功能与限制](./功能与限制.md)
