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

The kernel is not vendored in this repository. Fetch it, pinned by commit:

```
git init -q .claude/saipen-protocol
git -C .claude/saipen-protocol fetch --depth 1 https://github.com/vacterro/saipen 3088efffb61de1c4cea9cde2e15daf641654c4dc
git -C .claude/saipen-protocol checkout -q --detach FETCH_HEAD
git -C .claude/saipen-protocol rev-parse HEAD   # must print 3088efffb61de1c4cea9cde2e15daf641654c4dc
```

Pin by commit, never by tag or version. Tag `v8.0.1` points at `7145548`,
and `main` at `3088eff` reports the same `VERSION` 8.0.1 while differing in 967
files. The old kernel is not a smaller copy of the new one:

- its `saipen validate` is a phase verb that transitions to VALIDATE, which is
  a state mutation;
- its validator reports 40 false FAILs on this board.

When the operator's installed kernel moves, update this commit and the raw URL
below together.

Clone the product repository before the first CLI call:

```
git clone -q -b zaicode https://github.com/vacterro/zaicode zcode
```

`.saipen/source-nested-repos.json` declares `zcode/`, and the kernel binds it
into the project's source identity. Without the clone, `saipen continue`
refuses with `VALIDATION_FAILED cannot capture mechanical source identity:
declared nested repository is missing: 'zcode'`, and the validator adds one
more, intentional FAIL. The clone is gitignored here. It does not make you a
product worker (§ 5).

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

Run CLI calls one at a time, with absolute paths. Parallel shell calls that
`cd` can race over one working directory. In one session this landed a
`git clone` inside the kernel checkout instead of the project root.

### What the first CLI call does in the cloud

`STATE.saipen_home` holds the kernel path of the executor that checkpointed
last. On a Windows checkpoint that path is dead here. The first
`saipen continue` converges the pointer to the running kernel on its own, as
a journaled operation. The event reads `DEC: saipen_home automatically
converged to the proven canonical runtime ...` (E-1410), and it is expected
on every switch between the operator machine and the cloud. On the way back,
the operator's kernel converges it on `continue` if it has automatic
convergence; otherwise the operator runs `saipen rebind-home --auto`. That
return trip has not been observed yet.

Never hand-edit the pointer in STATE, and never try to undo the rebind. The
kernel owns it. The upstream fix, which moves the pointer out of versioned
state, is P1-2 in `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`.

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

### Known cloud conformance boundary

On kernel `3088eff` in the cloud, the validator reports four `closure-evidence`
FAILs: T-47, T-62, T-76 and T-78. On the operator machine the same state is
`CURRENT_PASS`.

Cause: those tickets' VERIFY verdicts were longer than 1024 bytes, so the
kernel moved them into `.saipen/recovery/log-detail/` sidecars. On read, the
kernel restores a sidecar only when the checkout's absolute path matches the
path the sidecar was written from.

The project is not broken. The defect is in the kernel and is filed upstream
as P1-1 in `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Until it lands:

- `saipen validate` answers `REFUSE [CONFORMANCE_UNHEALTHY]` here. Quote it.
  For the per-problem list, run
  `python3 .claude/saipen-protocol/tools/validate.py --project-root <root>`.
  That run also writes a conformance receipt under
  `.saipen/recovery/conformance/`. Commit it, as the operator does.
- Record the result as the known cloud boundary. It is not a PASS and not a
  regression. A `closure-evidence` FAIL belongs to this boundary only when
  the ticket's decisive VERIFY event is a `detail_ref:` line whose sidecar
  metadata names a different `project_identity`. Any other FAIL is real.
  Check each ticket before you classify it:
  `grep -h "\[T-###\]" .saipen/logs/*.md .saipen/LOG.md | grep detail_ref`,
  then read that `.json`'s `project_identity`. The list can grow when the
  operator machine closes more tickets with long verdicts.
- Do not rewrite the sidecars, re-verify those tickets to get green, or
  patch the local kernel copy. Each of those would make a gate look green
  without fixing anything.
- Keep every LOG event you write under 1024 bytes. A longer event becomes a
  sidecar bound to the cloud path, and the operator machine then cannot read
  it either.

## 7. Before you finish

1. `saipen validate` (or the hand-run equivalent) and record the real result.
2. Checkpoint through the protocol so `.saipen/STATE.md` carries the true
   phase and the next exact action.
3. If you committed, push to `origin/saipen-live`. If you could not, say so
   and name the commit id that is sitting local.

When you publish by hand, keep the kernel's SHIP order (`phases/ship.md`):

1. Commit and push the reviewed scope.
2. Record the SHIP checkpoint and run `saipen ticket done`.
3. Commit and push the finish right away, before you touch another ticket.

A pushed state left at `phase: SHIP` gets finished again by the next cold
executor, as its own event under the same E-### number. That is a divergence
waiting to happen. It happened once on a scratch clone of `6db4182`, which was
pushed and then left behind while T-87 started.
