# SAIPEN Execution Policy

Owns output/narration policy: what text exists, in what order. Not lifecycle,
routing, safety, or chat voice (STYLE owns voice).

<!-- RULE-OWNER: EXEC-HUSH-01 -->
<!-- RULE-OWNER: EXEC-RESPONSE-01 -->

## Precedence

`user/safety/CORE > execution policy > STYLE`

A higher layer wins. HUSH cannot suppress a safety refusal, a required human
decision, an error needed to act, or the final evidence report. STYLE selects
language/voice only after this policy decides whether text exists.

## Default response surface — EXEC-RESPONSE-01

Every ordinary user-facing operational boundary renders vertically, in this
order, with NO prose before it:

    STATUS
    RESULT
    BLOCKER
    OPERATOR ACTION
    NEXT EXACT ACTION
    VALIDATION
    DETAILS            (optional, LAST, omitted by default)

STATUS = compact ticket/phase/WAIT/BLOCKED/terminal. RESULT = what happened,
1-3 short lines. BLOCKER = always present: `NONE` or the exact canonical blocker
code + one bounded reason. OPERATOR ACTION = always present: `NONE` or the exact
HUMAN action required now (never an agent-executable command). NEXT EXACT ACTION
= always present: one canonical command, one exact manual action, or `NONE` --
never "continue as appropriate". VALIDATION = bounded proof, <= 5 compact lines.

Invariants: CONTROL SURFACE PRECEDES EXPLANATION; NO REQUIRED HUMAN ACTION MAY
EXIST ONLY IN FREE-FORM PROSE; THE HUMAN MUST NEVER HAVE TO READ AN ESSAY TO
DISCOVER WHETHER ACTION IS REQUIRED; WAIT without OPERATOR ACTION is invalid.

AUTONOMY (preserves T-1416): if OPERATOR ACTION is NONE, a canonically
executable action remains, and no true response boundary exists, DO NOT return
to the user -- continue execution. Do not emit a status card after every phase.

Long `FINAL REPORT`/`ROOT CAUSE`/`IMPLEMENTATION`/`TESTS`/`NOTES` templates
remain for explicit report requests, audit evidence and handoffs; they are NOT
the default interactive response.

## Default execution

Prefer action and evidence over narrating each tool call; the control surface
(or none) replaces per-step commentary. Report failures when they occur;
continue autonomously when the repair is authorized and deterministic.

## HUSH

`hush <task>` applies to that task and its authorized continuation chain.
Runtime `tools/saipen_engine/hush.py`; `saipen hush <task>` is its projection.
Modifier is stripped, `<task>` reaches the normal resolver UNCHANGED, and only
that route's output is suppressed. `hush cc` routes where `cc` routes. Only a
LEADING token is the modifier; a bare `hush` modifies nothing and is reported.
The policy is TASK-LOCAL, never written to `STATE.md`.

- Tool-first; silence lock: omit progress narration, plans, success chatter.
- Structured results and machine evidence are data, not narration.
- HUSH parity: HUSH may suppress chatter, progress prose and DETAILS. It may
  NOT suppress STATUS, BLOCKER, OPERATOR ACTION, NEXT EXACT ACTION, or required
  VALIDATION -- ONE response schema only.
- Mandatory exceptions: safety/destructive confirmation, missing human
  authority, terminal failure, protocol corruption, externally visible side
  effects, and the final evidence report (<= 20 lines).

Audits remain lossless: HUSH suppresses chat noise, never source capture,
coverage, LOG evidence, findings, gate test output, or failure diagnostics.
HUSH ends at a terminal result or explicit cancel.
