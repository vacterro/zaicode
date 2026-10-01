# 安装 ZAICODE

ZAICODE 由三个协同工作的项目组成：ZAICODE 应用、SAIPEN（让 agent 工作不跑偏的协议）、SAIMAIL（agent 互相通信用的邮件）。手动安装意味着三个仓库克隆、一套 Node.js 工具链、一个 Python 环境加一次构建。安装程序包办全部：
运行它、等待，桌面上就有 ZAICODE 快捷方式。

## 一键安装

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**：
  下载、双击、按 **INSTALL**。窗口（深色底金色，SAIPEN 横幅）会实时显示每个步骤、已用时间，并可按需查看日志；结束时按 **START ZAICODE**，若某步未完成则按 **TRY AGAIN** / **Autotroubleshoot**
  / **Open log**。指向已有的 ZAICODE 文件夹时按钮显示 **UPDATE**：同样的流程完成更新与修复。该
  exe 自带安装脚本，旁无其他文件即可运行；由 `install\setup\build.cmd` 构建（Windows 10/11
  自带的 .NET Framework 编译器）。
- `install\Setup-ZAICODE.cmd`（双击）：在控制台里执行同样的安装。
- 从零开始，用 PowerShell：

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

安装选项：`ZAICODE-Setup.exe -InstallDir D:\ZAICODE`（预置文件夹）、
`/auto`（立即启动）、`/quiet`（无窗口：控制台安装器，退出码
= 结果）。首次运行会在本机构建应用，耗时较长；
之后的运行只做更新与修复。

## 免费模型，无需任何配置

应用自带 9router。在没有它的机器上，ZAICODE 会私下运行它（隔离模式、端口 20138），用免密钥的免费额度填充 **SAIFREN**，并把 `SAIRoute / SAIFREN` 设为新任务的模型，因此在「新建任务」里输入的第一个任务就能得到回答：无需密钥、无需账号、无需设置。
Claude Code、Codex 和 Antigravity 登录是可选的；机器上从未设置过的登录显示为“可选，随时登录”，而不是“需要你处理”的条目。
验证：`node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
在空配置下启动打包好的应用（独立的 HOME、APPDATA 和 LOCALAPPDATA），仅当路由器处于隔离状态、SAIFREN 通过其首 token 探测、且「新建任务」中的任务得到回答时才通过。

## 更新：四部分，一个 ZAICODE

工作区（启动器、安装器）、应用、SAIPEN 和 SAIMAIL 是四个克隆。各自独立更新：**设置 -> ZAICODE -> 更新** 列出它们的版本与提交，可手动更新单个或全部，并为每部分提供“自行更新”开关（已安装的 ZAICODE 默认开启，开发者检出时默认关闭）。ZAICODE 在启动几分钟后检查一次，之后每六小时一次。更新后各部分拿到自己需要的：应用拿到依赖（当 `pnpm-lock.yaml` 变动时）和新构建（ZAICODE运行时暂存，下次启动生效），SAIPEN 拿到其启动器，SAIMAIL 拿到其 `.venv` 安装，工作区拿到新的根启动器。处于其他分支、有本地提交、或有会被更新覆盖的改动的克隆会被报告，并原样保留。

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## 它做什么

安装器就是按此顺序在空文件夹上以“repair”运行的 Autotroubleshoot 检查。每一步都是幂等的，因此再次运行会更新安装并修复损坏的部分。

| 检查项 | 修复方式 |
| ---- | ---- |
| Git、Node.js 24、Python 3.11+ | 版本合适时使用机器上的副本；否则在 `.tools\` 中使用私有副本（来自 Git for Windows 的 MinGit、来自 nodejs.org 的 Node.js 24.14.0、来自其 NuGet 包的 Python）。无需管理员权限。 |
| pnpm | `.tools\pnpm10` 中固定版本的 pnpm 10.33.2 |
| ZAICODE 工作区 | `vacterro/zaicode` 分支 `master` 的克隆（启动器源码、安装器、文档；不含开发者的 `.saipen/` 记忆；分支 `workspace` 持续到 2026-09-27） |
| ZAICODE 应用源码 | 分支 `zaicode` 克隆到 `zcode\` |
| SAIPEN | 克隆 `vacterro/saipen` 到 `saipen\`；其 `bin\saipen.cmd` 专为此克隆和此 Python 编写 |
| SAIMAIL | 克隆 `vacterro/saimail` 到 `saimail\`，安装到 `.venv\` |
| saimail-local | SAIMAIL 的命令行客户端，ZAICODE 的 SAIMAIL 面板使用它（自 SAIMAIL `0.0.2a3` 起随附；`saimail-cli` 检查报告 OK） |
| 9router 包 | 从 npm 安装 `9router` 到 `.tools\router`，已打包，SAIFREN 零配置即可用（npm 无法访问时给出 WARN） |
| 应用依赖 | `pnpm install --frozen-lockfile`（`pnpm-lock.yaml` 变化时重新安装） |
| 应用构建 | `pnpm bundle:zaicode`；ZAICODE 运行期间新构建暂存，下次启动时切换 |
| 暂存构建切换 | 清除长路径切换失败留下的 `win-unpacked.previous`，并在 ZAICODE 关闭时切换等待中的构建 |
| 根启动器 | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| 快捷方式 | 桌面与开始菜单 `ZAICODE` -> `ZAICODE.exe` |
| Claude / Codex 登录 | 仅报告：每个 `~\.claude*` / `~\.codex*` 登录在 ZAICODE 中都是独立引擎（A1、A2、C1 等）；需要你在浏览器中登录的项会被标出 |

根启动器把 ZAICODE 指向已安装的 SAIPEN（`saipen\`），并把 `.tools\` 和 `.venv\Scripts` 放到应用 PATH 最前面，使应用及其代理和 worker 使用已安装的副本。

## 多个订阅

每个 Claude Code 或 Codex 登录账号都有自己的 home：`~\.claude`、
`~\.claude-account2`……以及 `~\.codex`、`~\.codex-account2`……ZAICODE 全部能找到。
在安装时准备更多：

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

安装程序创建这些 home，并为每个打印确切的登录命令（`$env:CODEX_HOME = '...'; codex login`）。
ZAICODE 里同理：Settings ->
Engines & limits -> 再加一个登录。

## 自动排障

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

每项检查的状态：OK、FIXED（原本损坏，已修复）、WARN（可用，但缺少某些可选
组件）、INFO（需要你操作：登录）、FAIL。日志在
`install\logs\`；上次安装的摘要在 `install\install-report.json`。
在应用内，Router -> 自动排障 可修复正在运行的 router 和各资源池。

## 选项

| 参数 | 默认值 | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | 所有内容的存放位置 |
| `-ShortcutDir` | Desktop | ZAICODE 快捷方式放置位置 |
| `-NoStartMenu`、`-NoShortcut` | | 跳过这些快捷方式 |
| `-PortableTools` | | 即使本机已有 Git / Node.js / Python 也使用自带版本 |
| `-Launch` | | 完成后启动 ZAICODE |
| `-ZaicodeRepo`、`-SaipenRepo`、`-SaimailRepo` | GitHub 仓库地址 | 改用其他来源（fork、本地克隆路径） |

## 验证

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
检查全新安装，注入故障（快捷方式和启动器被删除、SAIPEN
启动器指向缺失的 Python、SAIMAIL 的 venv 被删除、node_modules 记录属于
另一个 lockfile、残留的构建目录层级超过 MAX_PATH），
断言 doctor 报告并修复每一处，然后用隔离的 profile 启动快捷方式的目标，
并且只终止它自己启动的那棵进程树。

`install\tests\Test-ZaicodeUpdate.ps1` 在磁盘上构建四个一次性
仓库及其克隆的安装，然后证明：某项检查不改动任何内容；单个部件会连同其
后续步骤（SAIPEN 启动器、根启动器）单独更新；重叠的本地修改和本地提交被保留；
未知部件名被拒绝。全程无网络。

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
