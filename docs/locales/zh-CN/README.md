# ZAICODE 智能编码助手

**v0.0.2**

<div align="center">
  <img src="https://raw.githubusercontent.com/vacterro/zaicode/zaicode/packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.2-c9a227" alt="version 0.0.2" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md">ZCode (简体中文)</a> · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="../../screenshots/01-do-your-best.png" />

ZAICODE 是操作员工作台：可同时在多个项目上运行大量 AI 编码代理，无需时刻盯着。它是
[ZCode](https://github.com/zai-org/ZCode)（桌面应用、浏览器界面和代理
CLI）的改造版，在其上叠加了一层产品能力：每个项目都由
[SAIPEN](https://github.com/vacterro/saipen) 协议驱动，任务的启动、续跑和调度都在同一个窗口内完成，
你已付费的订阅 CLI（Claude Code、Codex、Antigravity）作为停靠的
工作者与应用内代理并行运行。

**0.0.1** 是第一个标记快照：面向个人的、以 Windows 优先的版本，
每天都在用。

## 一键安装

1. 下载 **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**。
2. 双击它并按 **INSTALL**。

仅此而已。安装程序会补齐本机缺少的部分（Git、Node.js、Python，以私有副本形式安装：不需要管理员权限），从 GitHub 拉取 ZAICODE、SAIPEN 和 SAIMAIL，在本机构建应用，并在桌面放置 ZAICODE 快捷方式。首次
运行需 15-30 分钟；窗口中会显示每个步骤。

免费模型开箱即用：ZAICODE 会启动自带路由器，用免密钥的免费额度填满 **SAIFREN**
池，因此在「New task」中输入的任务无需密钥、无需账号、无需任何设置即可得到
回复。Claude Code、Codex 和 Antigravity 订阅是可选的，随时都可以登录。

**四部分，一体。** 工作台（启动器、安装程序）、应用、SAIPEN 和
SAIMAIL 共四个仓库，各自独立更新：*Settings -> ZAICODE ->
Updates* 会列出每个部分，可手动更新，也可自动更新（启动后几分钟检查一次，此后每六小时一次）。新版本应用会在 ZAICODE 运行时准备就绪，并在下次启动时生效；你在克隆中的自行修改永不会被覆盖。
在终端中执行：`install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`。
自动排障：`install\Doctor.cmd`。详见：[docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md)。

## 界面导览

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>SAIHOME</strong><br />
      The operator dashboard: quotas, health, projects, streaks, activity, and the live clock in one place.<br /><br />
      <img src="../../screenshots/02-saihome-dashboard.png" alt="SAIHOME dashboard" />
    </td>
    <td width="50%" valign="top">
      <strong>Agents &amp; tasks</strong><br />
      Create roles, inspect queues, and see what is idle, running, finished, or waiting for you.<br /><br />
      <img src="../../screenshots/03-agents-and-tasks.png" alt="Agents and tasks" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Scheduler</strong><br />
      Arm quota-aware autonomous runs and recurring prompts across one project or a whole sidebar section.<br /><br />
      <img src="../../screenshots/04-scheduler.png" alt="Scheduler" />
    </td>
    <td width="50%" valign="top">
      <strong>Audits</strong><br />
      Run Quick 3 Waves audits, watch progress live, and jump straight to reports when something stops.<br /><br />
      <img src="../../screenshots/05-audits.png" alt="Audits" />
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <strong>Active session</strong><br />
      The full working view: transcript, branch, prompt composer, state inspector, board, and backlog at the same time.<br /><br />
      <img src="../../screenshots/06-active-session.png" alt="Active session" />
    </td>
  </tr>
</table>

## 它为 ZCode 增加了什么

- **带 MAIN 会话的项目。** 每个项目有一个 MAIN 会话（START,
  `/goal cc all`）和辅助会话（subSaipens：WIKI、TEST、AUDIT……）。默认侧栏视图把项目行显示为它的 MAIN；▶ 继续 MAIN，不另开会话。CONTINUE ALL、DONE 和 CLEAR ALL DONE 扫描所有项目；回合中途被中断的会话显示 INTERRUPTED，绝不显示 DONE。
- **崩溃安全。** 被死进程中断的会话和仍激活的目标在重启后自行继续；运行中的 worker 会重新启动。ZAICODE 内的 Agent 无法按进程名杀死 ZAICODE。
- **Workers。** 订阅制 CLI 在停靠到窗口任一边缘的终端中运行（或在自己的吸附窗口中）。首次运行的“Trust this folder?”提示会被自动回答；触及用量上限的 worker 会被上报，并按设置关闭或在重置后重启。
- **限额与重置。** 按账号和资源池的配额计量，标题栏计时器显示最近一次重置，悬停可看完整重置列表。
- **SCHEDULER。** 自动启动的提示词：定时、每日、每 N 分钟，或配额窗口回补时；可作用于单个项目或整个侧栏分区，最难的项目（阻塞最多／SAIPEN 工单最多）优先。条件可优先停止临时工作（免费池会话、较弱的 worker）、仅在空闲项目上运行，或仅继续被标记的会话。提示词实际上没有长度限制。
- **路由。** 内置 9router（MIT）提供零配置资源池：SAIFREN（免密钥免费层）和 SAIOPP（你的订阅）。
- **SAIHOME、计时器、声音、高亮。** 运维主页含统计、FastPrompter 式计时器与闹铃、按动作的声音，以及 Win95 深金色、像素清晰的界面。

## 构建

环境要求：Windows 10/11、Git、Node.js **24.14.0**、pnpm **10.33.2**
（[mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) 为准）。

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

打包应用始终以 ZAICODE 模式启动。当旧版 ZAICODE 正在运行时，打包器会把新构建暂存到 `packages/desktop/dist-next`；根启动器（分支 `master`、`tools/launcher`）在下次启动时替换。UI 使用的清晰位图 Verdana 变体不在本仓库中；缺少它时界面回退到系统 Verdana。

检查项：`pnpm typecheck`、`pnpm lint`，以及 ZAICODE 测试，例如
从 `packages/ui` 运行 `node --import tsx --test test/zaicode*.test.ts`。

## 仓库结构

| 分支 | 内容 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | 规范工作区：启动器、安装器（`install/`）、产品文档（`UI.md`、`docs/`）、SAIPEN 状态与 CHANGELOG |
| `zaicode`   | 规范应用源码：上游 ZCode 历史加上用于构建与更新的 ZAICODE 产品层 |

遗留或自动化创建的 ref 可能仍会临时出现，但不是规范产品分支。新的工作区工作放在 `master`；应用源码工作放在 `zaicode`。

ZAICODE 自主的应用代码大多位于 `zaicode` 分支上的 `packages/ui/src/zaicode/`、
`packages/shared/src/zaicode-*.ts`、`packages/services/src/zaicode/` 和
`packages/desktop/src/main/zaicode*.ts`。工作区
文档与启动器/update工具位于 `master`。

## 上游与许可

ZAICODE 源自 Z.ai 的 ZCode，采用相同的
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE) 发布；上游声明保留在
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) 和 [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md) 中。
文件由 ZAICODE 作者修改。ZAICODE 是独立项目，
与 Z.ai 无隶属关系，也未获其背书。原始 ZCode README 保留为
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) 和 [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md)。

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## 项目网络

本仓库属于更大的 **SAIPEN / vacterro** 项目生态。

[**作者主页**](https://github.com/vacterro) · [**SAIPEN 总部**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN 社区**](https://discord.gg/SEYaYkuVgN)

可复现的 bug、长期有效的功能需求，请使用[本仓库的 GitHub Issues](https://github.com/vacterro/zaicode/issues)。快速讨论、截图、跨项目反馈请用 Discord。

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
