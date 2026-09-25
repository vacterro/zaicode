# Phase: MARKHUNT

## Purpose and entry

Run an explicit, exhaustive, uncapped audit and record every evidenced
finding. `saipen markhunt` may interrupt any phase under COMMANDS routing.
Unlike bounded HUNT, MARKHUNT continues until its declared surface is
exhausted.

## Scope and prohibitions

**Dry means dry:** MARKHUNT never edits, deletes, moves, renames or fixes
project bytes. It records only. Sweep all five vectors:

1. HUNT's mechanical categories, without HUNT's cap.
2. Cross-file behavior/documentation consistency and orphaned references.
3. Security posture, secret handling and destructive-operation gates.
4. Architectural debt, incomplete patterns and needless duplication.
5. Familiarity blindness: normalized defects maintainers may overlook.

Every finding needs a cited fact (file/line, command output or exact
contradiction). Suspicion without evidence produces no ticket.

## Recording and brake

Append findings as grouped `[MARKHUNT]` tickets under `## BLOCKED`, never
`## TODO`, with `blocker: unvetted audit -- <evidence>`. A grouped ticket names
its finding count, e.g. `cluster x6`. Never reorder or edit prior tickets.
Only later explicit human triage may accept one into TODO or dismiss it.

MARKHUNT never increments `goal_waves` or `goal_tickets` and never chooses the
next work. It exits to DONE. DONE's canonical brake halts goal execution while
any untriaged `[MARKHUNT]` ticket remains BLOCKED; MAINTENANCE owns the broader
goal lifecycle.

## Progress manifest

This pass may span contexts. After each vector or before context exhaustion,
overwrite `.saipen/kitchen/markhunt_progress.md` with:

- `vectors:` completed vector IDs 1-5;
- `surface:` exact paths/globs audited;
- `findings:` running finding count;
- `cursor: partial | done`;
- `head_start:` and `head_end:` from `git rev-parse --short HEAD`.

Use literal `no-git` for both hashes only when git or a repository genuinely
cannot be read. `mode: no-publish` does not qualify. The file is a cursor, not
history. On a partial handoff, LOG partial completion, keep phase MARKHUNT and
`next_action: "saipen markhunt"`; the successor resumes from the manifest.

## Closure and evidence

Before DONE prove:

- `cursor: done`;
- all five vectors are present;
- declared surface was exhausted;
- `head_end` equals current readable HEAD; if it moved, rerun affected scope;
- every counted finding is accounted for by this pass's grouped tickets.

`no-git` **means git cannot be READ, and nothing else.** When git genuinely
cannot provide a snapshot, closure is unproven, not satisfied: LOG
`tree_movement=unverified` and rerun any vector whose paths may have changed.

LOG completion exactly:
`- DATE [E-###] [parent: E-###] RUN: markhunt -> N findings, V/5 vectors,
@head_end tickets=T-###,T-###`. **`tickets=` is the pass's own accounting and
it is required**; use comma-separated ticket IDs or `tickets=none`. `N` equals
the sum of per-ticket finding counts, not ticket count; `V` must be 5.

**The pass identity is that line's own `E-###`.** Triage or dismissal LOGs a
DEC naming both ticket and filing pass event, so accounting survives BOARD
movement. Then transition to DONE; untriaged findings remain untouched.
