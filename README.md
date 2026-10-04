# ZAICODE

<div align="center">
  <img src="packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.1-c9a227" alt="version 0.0.1" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="README.zcode.md">ZCode (简体中文)</a> · <a href="README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="2026-09-25_184446" src="https://github.com/user-attachments/assets/981106cd-8671-4c39-9329-c66d6621bb73" />


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
Autotroubleshoot: `install\Doctor.cmd`. Details: [docs/ZAICODE_INSTALL.md](https://github.com/vacterro/zaicode/blob/master/docs/ZAICODE_INSTALL.md).

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

<img width="1440" height="860" alt="2026-09-25_182339" src="https://github.com/user-attachments/assets/7c9b723e-9610-4f5e-9463-7cc412621348" />

### SAI Accounts is optional

ZAICODE configures and uses its own accounts on its own. If the **SAI Accounts**
control plane happens to be installed on this machine, ZAICODE asks it for shared
accounts belonging to the providers ZAICODE actually implements, and adds the
ones it recognises — no setting, no import step. If the plane is absent,
stopped, broken or uninstalled, nothing here changes. **Nothing in this README
requires anything else to be installed.**

Four rules govern the optional federation:

- **Your accounts stay yours.** A shared account is added alongside your own; it
  never replaces one, and its canonical id lives in a namespace that cannot
  collide with a ZAICODE provider id.
- **Merge only on proven identity.** Two records collapse into one only when a
  stable identity locator proves they are the same account. A matching display
  name is never evidence; where identity cannot be proven, both records are
  shown separately.
- **Unavailable with a reason, never silently re-read.** A shared account is
  read *through* the plane, which owns that identity. If the plane cannot
  answer, the account reports `offline`, `auth_required` or `unavailable` — it
  is never quietly re-read through a local path that belongs to a different
  account.
- **Local settings stay local.** Which providers an account is bound to, and
  whether it is enabled here, are ZAICODE's own settings. Hiding or disabling an
  account in the shared registry is a *global* action and a separate concept.

The integration is read-only: the plane is asked for account metadata and
nothing else, and no token, session cookie or credential blob is ever read,
copied, exported or written. Today the plane publishes no accounts for
ZAICODE's own providers, so the honest answer is an empty list — and the code
that adds them the day it does is already there and already tested.



## Build

Requirements: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](mise.toml) is the source of truth).

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

<img width="1920" height="1080" alt="2026-09-25_182355" src="https://github.com/user-attachments/assets/12b19b5a-9ba5-4546-8f87-2012f22458ca" />


## Repository layout

| Branch      | Contents                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | the root workspace: launcher, installer (`install/`), product docs (`UI.md`, `docs/`), SAIPEN memory, CHANGELOG |
| `zaicode`   | the app: upstream ZCode history plus the ZAICODE layer (what the installer and the updates follow) |
| `main`      | the same app history as `zaicode`, kept in step |

ZAICODE-owned code lives mostly in `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` and
`packages/desktop/src/main/zaicode*.ts`; the list of upstream files it touches is
kept in `docs/ZAICODE_UPSTREAM_DELTA.md` on the `master` branch.

## Upstream and license

ZAICODE is derived from ZCode by Z.ai and is distributed under the same
[Apache License 2.0](LICENSE); upstream notices are kept in
[NOTICE.md](NOTICE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
Files were modified by the ZAICODE author. ZAICODE is an independent project,
not affiliated with or endorsed by Z.ai. The original ZCode README is kept as
[README.zcode.md](README.zcode.md) and [README.en.md](README.en.md).

<img width="1440" height="860" alt="2026-09-25_182240" src="https://github.com/user-attachments/assets/9eed5305-6168-4b3c-a875-ffec2598b71f" />
<img width="1920" height="1080" alt="2026-09-25_182433" src="https://github.com/user-attachments/assets/4a20927b-577d-4c77-a078-163e932096d2" />
<img width="1920" height="1080" alt="2026-09-25_184548" src="https://github.com/user-attachments/assets/fe01f639-7ef7-4a45-94b9-ddf735d9e93a" />

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
