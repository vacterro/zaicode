# Phase: DONE

Current ticket is closed only by atomic `saipen ticket done`, which proves the
SHIP boundary and commits LOG/BOARD/STATE through OPS. A checkbox alone is not
closure.

Closure provenance is mandatory at DONE (orchestration repair, T-1302):

- `own_patch` (default) — the ticket owns and publishes an isolatable
  implementation delta.
- `inherited_verified` — verification evidence only; the implementation
  already existed and its durable authority is named by
  `--implementation-source <T-###|SRC-###|release:<id>>` (required). Zero
  Git publication for this ticket.
- `cohort` — part of a shared verified batch; `--closure-cohort C-###` +
  `--paths <shared paths>` bind the member into the durable cohort
  registry. Publication is the cohort's obligation (`saipen cohort ship
  C-###`), never an imaginary per-ticket diff.
- `superseded_verified` — legitimate old Work was implemented and verified
  through explicit DONE successor Work. Only `saipen ticket supersede` writes
  this mode with successor, old-target PASS evidence and operator authority.
  It is terminal locally and asserts no publication.

A DONE ticket may carry zero Git commits in `inherited_verified`/`cohort`
modes; that is state evidence, not publication.

## Route

1. Workable TODO exists: enter SCOUT for the top pick, or PLAN only when the
   board explicitly requires a new wave.
2. TODO exists but none is workable: enter BLOCKED.
3. No TODO exists: enter HUNT immediately. Do not synthesize a user brake;
   CORE's MAINTAIN priority and MAINTENANCE §2.1 own this zero-prompt route.
4. Exception: any `[MARKHUNT]` ticket remaining in BLOCKED halts with exactly
   `WAIT: blocked -- untriaged MARKHUNT findings in ## BLOCKED; triage into ## TODO or dismiss`.
   Normal routing resumes only after every such finding is triaged or dismissed.

Explicit current input still outranks this persisted route. A new goal,
feature, or bug report enters GOAL/PLAN through COMMANDS and MAINTENANCE §2.4;
there is no invented `fix` or `add` command. ADD is reached only after a clean
HUNT on normal/goal intent.

Under `execution_intent: converge`, DONE is not automatic closure. CONVERGE
owns the stage order and closure bar.
