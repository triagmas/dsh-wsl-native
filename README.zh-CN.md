# DSH for WSL (`dsh-wsl-native`)

[English](README.md) · [Русский](README.ru.md) · **简体中文**

**目标：官方 Windows DeepSeek Harness Desktop 只作为用户界面，普通新对话与代理/工具执行默认由现有 WSL2 中的原生 Linux Harness 负责。** 这目前是**待实现并验收的要求**；已有的 Windows/WSL 双宿主选择不等于自动转发。详见 [WSL-first contract](docs/wsl-first.md)。

这是基于 [Han-1413141/dsh-wsl-native](https://github.com/Han-1413141/dsh-wsl-native)（MIT）的独立社区分支。目标是保留原有 Windows ↔ WSL2 集成能力，把 JavaScript/JSX 迁移到 **严格 TypeScript/TSX**，并完善多语言界面和权限管理，而不是重新开发 Desktop。

- **插件版本：** `dsh-wsl-native 0.8.0` 候选包。
- **目标 Desktop：** `0.2.1-rc.5`。
- **当前状态：** 源码测试与跨平台 CI 已通过，但本候选版**尚未在真实官方 Desktop 中完成端到端验收**。
- **开发分支：** [Draft PR #1](https://github.com/triagmas/dsh-wsl-native/pull/1)，尚未合并或正式发布。
- **插件界面语言：** 英文、俄文、简体中文。

## 功能

在同一个官方 Windows Desktop 中使用两种原生运行环境：

- **Windows Harness：** 保留 Windows 项目、PowerShell、工具与对话。
- **WSL2 Linux Harness：** 在现有 Ubuntu/WSL2 中运行真正的 Linux Harness、Bash、文件系统、项目、工具与会话。

插件支持选择 WSL 发行版、Linux 用户与项目目录，按需准备/启动并复用 Linux 运行时，在桌面窗口中切换 Windows 与 WSL 对话，恢复连接、管理工作区，并通过现有 `wsl_native_*` 工具执行跨系统操作。

**这不是新的 Desktop 应用，也不需要另建 VM、Hyper-V、Windows 用户或 WSL 发行版。**

## 要求与安装

需要官方 DeepSeek Harness Desktop、现有的 WSL2 Linux 发行版，以及支持的 Linux Node.js（22.x 系列不低于 22.19 或 24+）和 npm。

获批准安装时，使用官方 Desktop 随附的 CLI：

~~~text
<Desktop 安装目录>\resources\runtime\cli\bin\dsh.cmd
~~~

命令形式：

~~~powershell
& $dshDesktop plugin --profile desktop add $packagePath
~~~

必须先核实 `DSH_HOME`，关闭 Desktop，并确认目标确实是指定测试配置。**未经所有者单独许可，不得将候选包安装到日常使用的 Desktop 配置。** 参见 [R04 测试计划](docs/r04-isolated-test.md)；该计划不代表测试已经执行。

## 使用

安装并加载插件后：

1. 打开 **Windows & WSL** 面板。
2. 选择已有的 WSL 发行版、Linux 用户和工作目录。
3. 启动或重连原生 Linux Harness。
4. 在现有 Desktop 内切换 Windows 与 WSL 对话。
5. 按需配置 **Protected / Trusted / Full Access** 与授权期限。

插件权限**不是操作系统级沙箱**。WSL interop 和 Windows 挂载磁盘仍可能绕过插件的应用级限制；不要对真实项目执行破坏性测试。

## 开发

~~~bash
npm ci
npm run verify
npm pack
~~~

`npm run verify` 涵盖 TypeScript、ESLint、i18n、回归测试、构建与打包检查。CI 覆盖 Windows/Ubuntu × Node 22/24；客户端模块上限为 262144 字节。最近一次文档更新前的测试报告为 **175 项：173 通过，2 跳过，0 失败**；真实 Desktop 验收仍未完成。

## 项目文档

- [项目目的与范围](docs/project-context.md)
- [产品规格](docs/product-spec.md)
- [系统架构](docs/architecture.md)
- [路线图](docs/roadmap.md)
- [当前状态](docs/status.md)
- [已确认的决策](docs/decisions.md)
- [文档与语言规则](docs/documentation-policy.md)
- [Desktop 安装说明](docs/desktop.md) 与 [R04 测试计划](docs/r04-isolated-test.md)

仓库以英文文档为准；本文件是中文读者版本。部分历史中文文档仍需在合并前翻译成英文。

**许可证：** MIT。原始项目：[Han-1413141/dsh-wsl-native](https://github.com/Han-1413141/dsh-wsl-native)。本分支不是 DeepSeek 或 Microsoft 官方产品。
