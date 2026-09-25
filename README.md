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

ZAICODE is an operator workbench for running many AI coding agents at once over
many projects, without babysitting them. It is a modified build of
[ZCode](https://github.com/zai-org/ZCode) (desktop app, browser UI and agent
CLI) with a product layer on top: every project is driven by the
[SAIPEN](https://github.com/vacterro/saipen) protocol, work is started, continued
and scheduled from one window, and the subscription CLIs you already pay for
(Claude Code, Codex, Antigravity) run as docked workers next to the in-app
agents.

**0.0.1** is the first tagged snapshot: a personal, Windows-first build that is
used daily. There is no installer; build it from source.

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
([mise.toml](mise.toml) is the source of truth).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

The packaged app always starts in ZAICODE mode. While an older ZAICODE runs,
the bundler stages the new build in `packages/desktop/dist-next`; the root
launcher (branch `workspace`, `tools/launcher`) swaps it in on the next start.
The crisp bitmap Verdana variant used by the UI is not part of this repository;
without it the interface falls back to the system Verdana.

Checks: `pnpm typecheck`, `pnpm lint`, and the ZAICODE tests, for example
`node --import tsx --test test/zaicode*.test.ts` from `packages/ui`.

## Repository layout

| Branch      | Contents                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `main`      | this tree: upstream ZCode history plus the ZAICODE layer                 |
| `workspace` | the root workspace: launcher, product docs (`UI.md`, `docs/`), SAIPEN memory, CHANGELOG |

ZAICODE-owned code lives mostly in `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` and
`packages/desktop/src/main/zaicode*.ts`; the list of upstream files it touches is
kept in `docs/ZAICODE_UPSTREAM_DELTA.md` on the `workspace` branch.

## Upstream and license

ZAICODE is derived from ZCode by Z.ai and is distributed under the same
[Apache License 2.0](LICENSE); upstream notices are kept in
[NOTICE.md](NOTICE.md) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
Files were modified by the ZAICODE author. ZAICODE is an independent project,
not affiliated with or endorsed by Z.ai. The original ZCode README is kept as
[README.zcode.md](README.zcode.md) and [README.en.md](README.en.md).
