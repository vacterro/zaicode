# ZAICODE SAIPEN 云端传输

本结账流程与 Claude Code Cloud 会话如何以不同的执行器位置运行同一个 SAIPEN 工作区，
以及两者之间的边界在哪里。

## 结构

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

一个分支承载协议状态。没有合并步骤、没有变基步骤，
也没有第二个本地分支需要保持同步：哪个执行器拿到已验证的
检查点，就提交并推送，另一侧以
快进方式获取。

`master` 是传输前的历史记录，也是已发布的默认分支。传输过程
不会强制更新它。

## 传输的内容与不传输的内容

本仓库中的检查点包含 SAIPEN 协议状态、根
启动器、安装器、文档以及这些传输脚本。这就是
整个工作区层。

它**不包含任何产品字节**。`zcode/` 是一个独立的 Git 仓库，列在
`.saipen/source-nested-repos.json` 中，并在此根目录下被 gitignore
（`/zcode/`）。产品工作需要自行克隆 `vacterro/zaicode`，使用分支
`zaicode`，该克隆是第二个独立对象，拥有自己的历史记录。

后果很容易搞错：此根目录下干净的 `git status` 说明不了任何
未提交的产品工作，而 `saipen-live` 的快进也说明不了产品代码的情况。请显式检查
`git -C zcode status`。

## 本地部分

两个脚本，都由仓库管理，这样新机器可以从仓库获取它们，
而不必靠记忆：

| 文件 | 作用 |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | 校验、协调分支、安装并启动监听器、写入自启动项、证明本地 == 远端 |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | 主循环：拉取、比对、快进或推送、记录日志、暂停；随后是产品流程与自更新 |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | 由独立执行器完成的往返验证，外加冷恢复证明 |
| `tools/saipen-cloud/Test-ProductSync.ps1` | 针对一次性 Git 仓库的产品流程与自更新（无网络、无真实远端） |


安装与修复：

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

幂等。机器本地状态存放于 `%APPDATA%\SAIPEN`：
`ZaicodeSaipenLiveWatcher.ps1`（副本）、`ZAICODE_cloud-sync.log`（在
2 MB 处轮转到 `.log.1`）、`ZAICODE_cloud-sync.lock`（单实例）、
`ZAICODE_cloud-sync.pid`，以及启动文件夹条目
`SAIPEN-ZAICODE-Cloud-Sync.cmd`。

安装器拒绝脏工作树，且绝不清理它。若所有脏路径都是 `.saipen/` 下的
标准 SAIPEN 状态，它会明确说明并打印确切的
checkpoint 命令；那是未做 checkpoint 的协议状态，不是传输
故障，安装器不会背着协议擅自提交。

## 监听器行为

| 情况 | 处理 |
|-----------|------|
| 干净，本地是远端的祖先 | `git merge --ff-only` |
| 干净，远端是本地的祖先 | `git push` |
| 脏 | 暂停，连 fetch 都不做 |
| 处于其他分支 | 暂停 |
| 双方均前进且无共同祖先 | 暂停，记录两个提交 id，不做任何合并 |
| fetch 或网络失败 | 记录降级，下个周期重试 |
| merge/rebase/cherry-pick 进行中 | 暂停 |


绝不：强制推送、硬重置、stash、clean、检出外部分支、
提交，或按进程名停止。安装器只依据自己 pid 文件中记录的
pid 来停止监听器。

脏工作树零成本，因为监听器在 fetch 之前先检查脏状态。
因此空闲检出完全不会发起任何网络调用。

### 产品流程（T-90）

`zcode/` 是独立的仓库，所以上表绝不会移动产品
代码。之后同一周期还会处理产品检出（`-ProductRepo`，
默认 `<repo>\zcode`；分支 `-ProductBranch`，默认 `zaicode`）。
无论外层工作树是否脏，产品流程都会运行。它只会拉取。

| 情况 | 动作 |
|-----------|------|
| 远端领先，此处无传入文件为脏 | `git merge --ff-only`；未提交的产品改动原样保留 |
| 远端领先，某个传入文件在此处为脏 | HELD：记录文件，不合并任何内容 |
| 本地领先 | 记录；**绝不推送**（产品由 SAIPEN SHIP 发布） |
| 分叉 | 暂停，记录两个 id，不合并任何内容 |
| 其他分支、有 git 操作进行中、fetch 失败 | 暂停 |
| 无 `zcode/` 检出，或 `-NoProduct` | 跳过 |

git 本身就会拒绝覆盖本地改动的 fast-forward，因此 HELD 检查是更早、更清晰的守卫，而非唯一守卫。产品 fast-forward 不重建任何内容：要测试，运行 `pnpm bundle:zaicode`（或开发预览）。

### 自更新（T-90）

watcher 以副本形式在 `%APPDATA%\SAIPEN` 下运行，所以仓库里更新的 watcher 不重装就不会生效。循环模式下，它现在每轮都把自己的文件与仓库中已提交的副本比较。仅当以下条件全部成立时，它才用该副本覆盖自身，并以相同参数重启恰好一次：

- 两个文件不同；
- 仓库副本没有未提交改动；
- 仓库副本解析无错。

无法解析的副本会被拒绝并记入日志，正在运行的 watcher 继续运行。

T-90 之前安装的 watcher 既没有产品更新，也没有自更新。在这类机器上重跑一次 `Install-SaipenLiveSync.ps1`；之后 watcher 会自我更新。

## 云端部分

根目录的 `CLAUDE.md` 是入口规则，`.claude/skills/saipen/SKILL.md` 是执行流程。该 skill 从 `github.com/vacterro/saipen` 拉取 SAIPEN 内核，并通过声明的引擎接口 `tools/saipen.py` 运行它。内核按 commit（`3088eff`）锁定，绝不按 tag。Tag `v8.0.1` 是同一 `VERSION` 的旧内核；其 `validate` 会改动状态，且其校验器拒绝本板。

`STATE.saipen_home` 记录最近一次做检查点的执行器的内核路径。在云端，针对内核 `3088eff` 的首次 `saipen continue` 会把它收敛到正在运行的内核，作为一条已入账的 `DEC`（E-1410）。在操作员机器上，该指针同样一上来就是失效的。具备自动收敛的内核会在 `continue` 时修复它；否则运行 `saipen rebind-home --auto`。

**返程已观察到。** E-1562（云端）将指针收敛到
`/home/user/zaicode/.claude/saipen-protocol`；E-1571（运维机）
又自动收敛回 `V:/.../_SAIPEN`，无需手动
`rebind-home`。两个方向是同一种自动收敛，因此每次切换本地副本都预期
出现一次 `saipen_home` `DEC`，应视为正常噪音
而非缺陷。在 P1-2
（`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`）把指针移出版本化
状态之前，它一直只是噪音；不要因为发现它就把 P1-2 作为副作用实现。绝不手工编辑
该指针。

`STATE.saipen_home` 可能指向一个领先于 pin 的内核**开发检出**，而不是干净的 `3088eff` 克隆——在运维机上它是
带有未提交改动的 `accepted-debt-rebind` 分支。未处于 pinned commit 的内核并不
自动算错，但它也不是洁净室（clean-room）源，因此下面关于语音
契约的规则对它完全适用。绝不在这类检出中执行 commit、stash、reset、check out 或 clean；
仅允许的例外是对 `saipen/STYLE.md` 做定向单文件恢复，
且仅在运维人员要求时。

### STYLE.md 不是本地设置

`saipen/STYLE.md` 必须与 pinned 内核的文件**逐字节一致**，
在每台机器、每个副本中都如此，无例外、无本地修改。运维机上存在
多于一个副本：

- `STATE.saipen_home` 处的内核检出（一个 Git 克隆，在运维机上
  是开发检出）；
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`，由 `saipen-inject` 计划任务（`bootstrap/schedule-run.ps1`）填充。它**不是
  Git 仓库**，因此 `git checkout` 永远无法修复它——只能通过注入器重新同步，
  或直接写入已发布内容。

`.saipen/STATE.md` 中的 `style_contract` token 是该文件文本的哈希
（`tools/validate.py`、`style_contract_token`：CRLF 归一化，排除
`style_contract:` 行）。在一处副本中编辑 `reply_language` 会使该 token 改变；
另一副本以及拉取已发布内核的云端仍保持已发布的 token，
而在不匹配的一侧，每次 CLI 写入都会被 `style_contract ... does not match the installed STYLE.md marker` 拒绝。
这就是整个故障：本地侧写入了云端无法写入的状态。

**更改回复语言是一次内核提交加一次 repin**，绝不是本地
编辑。在内核仓库中修改、发布、在 SKILL.md 中重新 pin 该 commit，
并通过 `saipen recover` 更新 `STATE.style_contract`。对 `STYLE.md` 的本地
编辑会让除本机之外的所有机器失步。

值得点明的一个陷阱：已发布的 `bin/saipen` 是一个与机器绑定的 shim，
硬编码了某一位运维人员的绝对解释器路径与检出路径。它只能在
恰好一台机器上运行。云端必须使用 `python3 tools/saipen.py`。

快捷指令：`cc` 继续当前 Work；`cc all <text>` 将整条
消息作为 source/appends 摄入，并继续所有符合条件的 Work。两者都
不要求例行确认。

## 能力分类

**AVAILABLE_IN_CLOUD** — 协议状态与工作区层。读取和
写入 `.saipen/`、启动器（`tools/launcher/ZaicodeLauncher.cs`）、
`install/` 下的安装器、`docs/`、`CLAUDE.md`、`.claude/skills/`，以及
传输脚本。对 `saipen-live` 执行 Git 读取、提交、推送和拉取。任
何属于文件断言、diff 审查或文本检查的门禁。

**LOCAL_WINDOWS_ONLY** — 需要本机的门禁。

| 门禁 | 原因 |
|------|-----|
| `tools\launcher\build.cmd` | 用 .NET Framework `csc` 编译 `ZaicodeLauncher.cs`；云镜像上没有 Windows SDK |
| 打包 Electron E2E（`zcode` desktop，Solo → queue → dispatch） | 需要桌面会话和预置的 provider 配置 |
| 本机运行的 9router | 本机上的 Windows 服务 |
| 交互式桌面点按 | 需要人和屏幕 |
| watcher 自身的运行时用例 | watcher 只在持有 checkout 的那台机器上运行 |

这些被记录为仅限本地的验收边界。绝不
会因为 diff 看起来正确就报告为通过。

**SAFE_TO_DEFER** — 产品层。云端会话可以克隆
`vacterro/zaicode` 分支 `zaicode` 并在其中工作。工作区层的工作
不依赖产品层，但依赖克隆：
`.saipen/source-nested-repos.json` 声明了 `zcode/`，缺失时校验器会失败并报
`source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`。`pnpm` 门禁需要固定的 pnpm 10.33.2
和已准备好的工作区。在全新云镜像上，
`pnpm bootstrap` 是文档记载的进入方式，且产品的 `package.json` 已声明它。

云端只能校验位于 `origin/zaicode` 上的产品字节。只
存在于操作员 `zcode/` checkout 中的产品改动
在这里不可见，因此无论门禁是哪一种，它的所有产品门禁在云端都是 NOT RUN。T-84 是首个案例（E-1411）：其修复仅在本地，
而 `origin/zaicode` 仍带着修复前的代码。

**UNSAFE_TO_EMULATE** — 任何会让仅限本地的门禁显示为绿色的做法。
不要用桩替代启动器构建，不要伪造打包应用运行，不要把录好的
`pnpm verify:pre-push` 结果当作刚跑完那样重放，也不要在 `.saipen/LOG.md` 中把「代码
看起来正确」转写成一行 PASS。

**KNOWN_CLOUD_DIVERGENCE** — 取决于 checkout 所在位置的
一致性。在 kernel `3088eff` 上，云端校验器报告的 `closure-evidence`
失败（T-47、T-62、T-76、T-78 截至撰写时）在操作员
机器上不会出现。

kernel 会把任何超过 1024 字节的 LOG 事件移到
`.saipen/recovery/log-detail/` sidecar 中。读取时，只有当 checkout 的绝对路径
等于其写入时的路径，才会恢复该 sidecar。因此在 Windows 上
写入的长 VERIFY 判定在云端无法读取，反
之亦然。

该缺陷在 kernel 中，已在
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md` 中登记为 P1-1。在其合入之前：

- 引用云端裁定结果，逐张工单归类到该边界
  （检查见 `SKILL.md` § 6）；
- 绝不改写 sidecar、只为变绿而重新验证、或修补内核
  副本；
- 两侧 LOG 事件均控制在 1024 字节以内。

同一机器路径绑定同样会阻塞工作。BUILD 前的债务基线
在工单首次进入 BUILD 时采集，之后每次进入都重新校验。
因此，首次在运维机器上进入 BUILD 的工单无法在云端进入
BUILD：该转换被 `DEBT_SNAPSHOT_FOREIGN_PROJECT` 拒绝。T-84 即在案：DEBT-000079
采集于 E-1377，转换被拒于 E-1446。此类工单交回采集其基线的
那台机器处理。

## 分歧

本地与远端不再共享祖先时，watcher 停止。它不合并、不 rebase、不强推。
两个 commit id 都写入日志，修复由人工 `git log --left-right --cherry-pick <branch>...origin/<branch>`，
结果与其他改动一样做 checkpoint。

## 云端的确切操作

### 环境设置脚本（一次性，在云端环境的设置中）

会话标题栏的云端环境菜单 -> 编辑 -> 设置脚本。
它在每个新会话前运行，因此每个会话开始时产品工具链已就绪：

```bash
#!/usr/bin/env bash
# ZAICODE cloud toolchain: Node 24 + pnpm 10.33.2 (product gates),
# 9router 0.5.91 (real-router tests), mono mcs (launcher compile check).
set -u
NODE=v24.14.0
if ! command -v node >/dev/null || ! node -v | grep -q '^v24\.'; then
  curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar -xJ -C /opt
  ln -sf /opt/node-$NODE-linux-x64/bin/node /opt/node-$NODE-linux-x64/bin/npm /opt/node-$NODE-linux-x64/bin/npx /usr/local/bin/
fi
npm install -g pnpm@10.33.2 && ln -sf "$(npm prefix -g)/bin/pnpm" /usr/local/bin/pnpm
mkdir -p /opt/9router && cd /opt/9router && npm pack 9router@0.5.91 >/dev/null && tar -xzf 9router-0.5.91.tgz
(apt-get update -qq && apt-get install -y -qq mono-mcs) || echo "no mono-mcs: the launcher compile check is NOT RUN"
exit 0
```

### 每个新会话的提示词

在仓库 `vacterro/zaicode`、分支 `saipen-live` 上开始会话，
并确保运维机器上的 agent 未在同时写入。
交出新增工作时，将最后一行替换为 `cc all <new list>`。

```
Read CLAUDE.md and .claude/skills/saipen/SKILL.md, then cold-recover SAIPEN
state from .saipen/ on branch saipen-live (STATE.md, BOARD.md, tail of LOG.md).
Chat memory is not state; docs/ZAICODE_SAIPEN_CLOUD.md is the transport contract.

Setup (skip what already exists):
- saipen = python3 .claude/saipen-protocol/tools/saipen.py --project-root <repo root>
  (fetch the kernel per SKILL.md if it is missing); run `saipen rebind-home --auto`
  when saipen_home points at another machine.
- Product clone: git clone -b zaicode https://github.com/vacterro/zaicode zcode
  (gitignored here), then `pnpm install` inside zcode (Node 24, pnpm 10.33.2).
- Real-router tests: export ZAICODE_ROUTER_PACKAGE=/opt/9router/package if it exists.

Rules:
- Fetch origin/saipen-live and origin/zaicode before every commit and every push.
  If the other side moved, merge; never rebase, reset or force. If .saipen/
  histories diverged: keep ours on saipen-live-cloud-<sha>, write both ids to
  .saipen/LOG.md, stop and ask me.
- Product gates in zcode: pnpm typecheck, pnpm lint (0 errors),
  pnpm run architecture:check -- --changed, pnpm test. A gate that cannot run
  here is NOT RUN with the reason; a failure blamed on the environment must be
  shown to fail the same without the change.
- I authorize publishing verified product commits to origin/zaicode and SAIPEN
  checkpoints to origin/saipen-live.
- Nothing is PASS until I test on Windows and say PASS. A finished ticket waits
  in VERIFY with .saipen/evidence/T-###-*.md: its commits and the exact manual
  test steps.
- One writer at a time: if LOG shows the local agent mid-work, stop and ask.

cc
```

在运维机器上，watcher 将 `zcode` 从 `origin/zaicode` 快进；
`REBUILD.cmd`（或 `REBUILD_fast.lnk`）构建它，ZAICODE 下次启动时
换上新的构建。

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
