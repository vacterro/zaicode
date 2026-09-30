# ZAICODE

<div align="center">
  <img src="https://raw.githubusercontent.com/vacterro/zaicode/zaicode/packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.1-c9a227" alt="version 0.0.1" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md">ZCode (简体中文)</a> · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="docs/screenshots/01-do-your-best.png" />

ZAICODE is an operator workbench for running many AI coding agents at once over
many projects, without babysitting them. It is a modified build of
[ZCode](https://github.com/zai-org/ZCode) (desktop app, browser UI and agent
CLI) with a product layer on top: every project is driven by the
[SAIPEN](https://github.com/vacterro/saipen) protocol, work is started, continued
and scheduled from one window, and the subscription CLIs you already pay for
(Claude Code, Codex, Antigravity) run as docked workers next to the in-app
agents.

**0.0.1** is the first tagged snapshot: a personal, Windows-first build that is
used daily.

## Install in one click

1. Download **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Double-click it and press **INSTALL**.

That is all. Setup brings what the machine lacks (Git, Node.js, Python, as private
copies: no administrator rights), fetches ZAICODE, SAIPEN and SAIMAIL from GitHub,
builds the app on the machine and puts a ZAICODE shortcut on the desktop. The first
run takes 15-30 minutes; the window shows every step.

Free models work at once: ZAICODE starts its own router and fills the **SAIFREN**
pool from keyless free tiers, so a task typed into New task gets an answer with no
key, no account and no setting. Claude Code, Codex and Antigravity subscriptions are
optional and can be signed in any time.

**One whole, four parts.** The workspace (launcher, installer), the app, SAIPEN and
SAIMAIL are four repositories. Each updates on its own: *Settings -> ZAICODE ->
Updates* shows every part, updates it by hand or by itself (checked a few minutes
after the start and every six hours). A new app build is prepared while ZAICODE runs
and starts with the next start; your own edits in a clone are never overwritten.
From a terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autotroubleshoot: `install\Doctor.cmd`. Details: [docs/ZAICODE_INSTALL.md](docs/ZAICODE_INSTALL.md).

## Interface tour

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>SAIHOME</strong><br />
      The operator dashboard: quotas, health, projects, streaks, activity, and the live clock in one place.<br /><br />
      <img src="docs/screenshots/02-saihome-dashboard.png" alt="SAIHOME dashboard" />
    </td>
    <td width="50%" valign="top">
      <strong>Agents &amp; tasks</strong><br />
      Create roles, inspect queues, and see what is idle, running, finished, or waiting for you.<br /><br />
      <img src="docs/screenshots/03-agents-and-tasks.png" alt="Agents and tasks" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Scheduler</strong><br />
      Arm quota-aware autonomous runs and recurring prompts across one project or a whole sidebar section.<br /><br />
      <img src="docs/screenshots/04-scheduler.png" alt="Scheduler" />
    </td>
    <td width="50%" valign="top">
      <strong>Audits</strong><br />
      Run Quick 3 Waves audits, watch progress live, and jump straight to reports when something stops.<br /><br />
      <img src="docs/screenshots/05-audits.png" alt="Audits" />
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <strong>Active session</strong><br />
      The full working view: transcript, branch, prompt composer, state inspector, board, and backlog at the same time.<br /><br />
      <img src="docs/screenshots/06-active-session.png" alt="Active session" />
    </td>
  </tr>
</table>

## What it adds to ZCode

- **Projects with a MAIN session.** Each project has one MAIN session (START,
  `/goal cc all`) and helper sessions (subSaipens: WIKI, TEST, AUDIT, …). The
  default sidebar view shows the project row as its MAIN; ▶ continues MAIN
  instead of opening another session. CONTINUE ALL, DONE and CLEAR ALL DONE
  sweep every project; a session cut off mid-turn shows INTERRUPTED, never DONE.
- **Crash safety.** Sessions a dead process cut off and goals still active
  continue by themselves after a restart; running workers start again. Agents
  inside ZAICODE cannot kill ZAICODE by process name.
- **Workers.** Subscription CLIs run in terminals docked to any edge of the
  window (or in their own snapping windows). First-run "Trust this folder?"
  questions are answered; a worker that hits its usage limit is reported and,
  by setting, closed or restarted after the reset.
- **Limits and resets.** Quota meters per account and pool, a title-bar timer
  for the nearest reset with the full list of coming resets on hover.
- **SCHEDULER.** Prompts that start by themselves: at a time, daily, every N
  minutes or when a quota window refills; in one project or a whole sidebar
  section, worst projects (most blocked / open SAIPEN tickets) first. Conditions
  can stop stopgap work (free-pool sessions, weaker workers) first, run only on
  idle projects, or continue only marked sessions. Prompts have no practical
  length limit.
- **Routing.** A bundled 9router (MIT) gives zero-setup pools: SAIFREN
  (keyless free tiers) and SAIOPP (your subscriptions).
- **SAIHOME, timers, sounds, highlights.** An operator home with statistics,
  FastPrompter-style timers and alarms, per-action sounds and a Win95 dark
  golden, pixel-crisp interface.

## Build

Requirements: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) is the source of truth).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

The packaged app always starts in ZAICODE mode. While an older ZAICODE runs,
the bundler stages the new build in `packages/desktop/dist-next`; the root
launcher (branch `master`, `tools/launcher`) swaps it in on the next start.
The crisp bitmap Verdana variant used by the UI is not part of this repository;
without it the interface falls back to the system Verdana.

Checks: `pnpm typecheck`, `pnpm lint`, and the ZAICODE tests, for example
`node --import tsx --test test/zaicode*.test.ts` from `packages/ui`.

## Repository layout

| Branch      | Contents                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | the canonical workspace: launcher, installer (`install/`), product docs (`UI.md`, `docs/`), SAIPEN state and CHANGELOG |
| `zaicode`   | the canonical app source: upstream ZCode history plus the ZAICODE product layer used for builds and updates |

Legacy or automation-created refs may still appear temporarily, but they are not
canonical product branches. New workspace work belongs on `master`; app-source
work belongs on `zaicode`.

ZAICODE-owned app code lives mostly in `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` and
`packages/desktop/src/main/zaicode*.ts` on the `zaicode` branch. The workspace
documentation and launcher/update tooling live on `master`.

## Upstream and license

ZAICODE is derived from ZCode by Z.ai and is distributed under the same
[Apache License 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); upstream notices are kept in
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) and [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Files were modified by the ZAICODE author. ZAICODE is an independent project,
not affiliated with or endorsed by Z.ai. The original ZCode README is kept as
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) and [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Project network

This repository is part of the broader **SAIPEN / vacterro** project ecosystem.

[**Author hub**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**SAIPEN Community**](https://discord.gg/SEYaYkuVgN)

For reproducible bugs and durable feature requests, use [this repository's GitHub Issues](https://github.com/vacterro/zaicode/issues). Use Discord for quick discussion, screenshots, and cross-project feedback.

<!-- VACTERRO_PROJECT_BRIDGE:END -->
