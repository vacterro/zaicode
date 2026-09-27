---
name: saipen
description: Run the ZAICODE project under its SAIPEN protocol. Use this when a session opens in this repository, when the operator sends "cc" or "cc all", or when any task touches .saipen/ state, a board ticket, a source receipt, a checkpoint, or the origin/saipen-live transport. It is the execution entry point for SAIPEN in this repository.
---

# SAIPEN execution adapter (ZAICODE)

This is an adapter, not a copy of the protocol. The protocol lives in the
SAIPEN kernel; the project state lives in `.saipen/`. Both are authoritative.
This file only tells you how to get to them and what this repository adds.

## 1. Cold recovery — do this first, every session

You have no memory of previous sessions and you are not supposed to. Rebuild
from the repository.

1. Read `CLAUDE.md` at the repository root.
2. Read `.saipen/STATE.md` (phase, task, next action, blocker), then
   `.saipen/BOARD.md` (the top workable ticket and what blocks it), then the
   last ~40 lines of `.saipen/LOG.md` (what actually happened).
3. Read `.saipen/intake/index.json` for source receipts that are still open,
   and `.saipen/intake/appends/` for deferred requests.
4. State the active Work — the ticket id, the phase, and the next exact
   action — before you do anything else. If the repository does not answer
   that question cleanly, say so instead of guessing.

## 2. Obtain the SAIPEN kernel

The kernel is not vendored in this repository. Fetch it, pinned:

```
git clone --depth 1 --branch v8.0.1 https://github.com/vacterro/saipen .claude/saipen-protocol
```

Read `.claude/saipen-protocol/saipen/BOOT.md` first (cold-start kernel), then
`saipen/INDEX.md`, and `saipen/CORE.md` when a rule question comes up. If the
clone fails, read `saipen/BOOT.md` through
`https://raw.githubusercontent.com/vacterro/saipen/3088efffb61de1c4cea9cde2e15daf641654c4dc/saipen/BOOT.md`
and continue. Record which route worked.

`.claude/saipen-protocol/` is gitignored. Never commit it.

## 3. Run the protocol, or follow it by hand

Preferred, when the environment allows it:

```
python3 .claude/saipen-protocol/tools/saipen.py --project-root . <command>
```

`tools/saipen.py` is the kernel's declared engine surface
(`saipen/SAIPEN_ENTRY.json` → `engine_surface`). Use it.

Do **not** use `bin/saipen` from a fresh clone: the published copy is a
machine-bound shim that hardcodes one operator's absolute interpreter and
checkout paths, so it runs on exactly one machine and nowhere else. Do not use
`python -m saipen` or a hand-built interpreter path either — the entry
contract lists both as non-transports.

If the CLI cannot run here — no Python, no network, a read-only checkout — you
still execute the protocol by reading `phases/<phase>.md` for the current phase
and following it with the editor tools. That is a real execution, not a
degraded one. Say plainly which route you took.

## 4. Shortcut semantics

| Input | Action |
|-------|--------|
| `cc` | Continue the current Work. Resolve the phase from `.saipen/STATE.md`, read that phase's `phases/<phase>.md`, do the work, checkpoint. Do not open a new goal or invent a ticket because someone typed two letters. |
| `cc all <text>` | Treat the whole message as new source/appends, run the project's intake so it becomes a source receipt and lands on the board, then continue every eligible Work. |
| Anything else | Ordinary request. If it changes project state, it is a source receipt first, then a ticket — unless the operator said otherwise. |

## 5. What this repository adds on top of the kernel

- **Transport.** Work lands on `saipen-live` and is pushed to `origin`. See
  `docs/ZAICODE_SAIPEN_CLOUD.md`. Never force push, never hard reset.
- **Two repositories.** `zcode/` is a separate Git repository, gitignored
  here. This repository's checkpoints carry the protocol state, the launcher,
  the installer and the docs — never a product byte.
- **Gates.** Workspace layer: `tools\launcher\build.cmd` (Windows). Product
  layer: `pnpm run verify:pre-push` inside `zcode/`, plus the package test
  entries recorded in `.saipen/KNOWLEDGE/commands.md`.

## 6. Honesty rules this repository enforces

- A gate you did not run is `NOT RUN`, never `PASS`. Name the command and the
  reason.
- A local-only gate (Windows-only build, interactive desktop, the 9router) is
  recorded as a local-only acceptance boundary, never silently reinterpreted
  as passed because the code looks right.
- An environment limitation is not an engineering failure. Which one you hit
  changes what you do next, so classify it explicitly.
- Never fabricate a validation result. `saipen validate` output is quoted, not
  summarized into a conclusion.
- Never delete SAIPEN evidence. Untracked is not disposable.

## 7. Before you finish

1. `saipen validate` (or the hand-run equivalent) and record the real result.
2. Checkpoint through the protocol so `.saipen/STATE.md` carries the true
   phase and the next exact action.
3. If you committed, push to `origin/saipen-live`. If you could not, say so
   and name the commit id that is sitting local.
