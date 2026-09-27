# CLAUDE.md

ZAICODE runs SAIPEN. This file is the entry rule, not the protocol.

## The one rule

**Canonical state is `.saipen/` in this repository. Chat memory is not state.**

Read `.saipen/STATE.md`, `.saipen/BOARD.md` and the tail of `.saipen/LOG.md`
before deciding anything. If this file and `.saipen/` disagree, `.saipen/` is
right. If your recollection of an earlier conversation disagrees with
`.saipen/`, `.saipen/` is right. A fresh session with no memory is the normal
case, not a degraded one.

## Entry point

The execution procedure is `.claude/skills/saipen/SKILL.md`. Read it before
touching the protocol. It tells you how to obtain the SAIPEN kernel
(`BOOT.md` → `INDEX.md` → `CORE.md`) and how to run the CLI when the
environment allows it. Do not reimplement the protocol from this file.

## Shortcuts

| You receive | It means |
|-------------|----------|
| `cc` | Continue the current SAIPEN Work. No new goal, no new ticket from a shortcut. |
| `cc all <text>` | Ingest the entire message as new source/appends, then continue every eligible Work. |

Other SAIPEN shortcuts (`gg`, `hh`, `ff`, `xx`, `vv`, `zz`, `st`, `dd`, `aa`,
`qq`, `ee`, `pp`, `tt`, `sc` and their Cyrillic twins) resolve through the
protocol's own shortcut table. Resolve them there, never from memory.

Routine continuation confirmations are not required. Ask only at a real STOP
gate, a destructive ambiguity, or a missing credential.

## Git transport

This checkout exchanges verified checkpoints with the operator's machine over
`origin/saipen-live`. See `docs/ZAICODE_SAIPEN_CLOUD.md` for the full contract.

- Commit verified checkpoints on `saipen-live` and push them.
- Never force push, never `reset --hard`, never discard a working tree.
- Never claim a gate passed that you did not run. A gate you cannot run in
  this environment is recorded as not run, with the reason.
- If local and remote histories diverge: preserve both, write both commit ids
  into `.saipen/LOG.md`, and stop. Do not resolve it by force.

## Two repositories, one product

`zcode/` is a separate Git repository and is gitignored here. A checkpoint in
this repo carries the SAIPEN protocol state, the launcher, the installer and
the docs — never a product byte. Product work needs its own clone of
`https://github.com/vacterro/zaicode` on branch `zaicode`. `pnpm` gates run
inside `zcode/`; the workspace layer's gate is `tools\launcher\build.cmd`.
