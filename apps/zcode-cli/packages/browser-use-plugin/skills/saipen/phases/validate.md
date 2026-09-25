# Phase: VALIDATE

## Purpose and entry

Check and, where authorized, repair only SAIPEN structural conformance.
Terminal execution is required. Without it, LOG
`RUN: validate -> FAIL, no terminal` and enter BLOCKED.

## Action

Run the canonical stdlib validator:

- bound project: `python <saipen-home>/tools/validate.py`;
- explicit target: add `--project-root <path>`.

It owns STATE/schema, BOARD dependency, LOG graph, phase/capability, and root
binding checks. With no Python, run the portable subset from the already bound
root: `tests\validate.ps1` on Windows or `tests/validate.sh` on Unix. State
that degraded evidence is a subset.

PASS: LOG the command and result in the canonical record form --

```
RUN: validate.py -> PASS conf: high -- 0 FAIL, 21 WARN, <evidence>
```

`-> PASS` or `-> FAIL` immediately after the arrow is the result token, and
`saipen status` reads exactly that to project the conformance gate. Evidence
belongs AFTER the token, never before it and never instead of it: a record that
buries the result mid-sentence leaves the gate UNKNOWN, and a record that
claims a pass while also naming a failure is read as UNKNOWN rather than as a
pass. FAIL under `mode: read-only`: report the exact error and change nothing. Otherwise repair only structural corruption,
rerun, and preserve historical meaning. VALIDATE may fix malformed shape,
missing required fields/headings, and structural references; it **must not
rewrite LOG history or product content to make a gate green**.

## Exit

Passed/repaired: SCOUT for workable tickets, PLAN for unrefined work, DONE for
an empty TODO, or BLOCKED when no ticket is workable. The canonical checkpoint
and DONE->maintenance route remain in CORE/MAINTENANCE.
