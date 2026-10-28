# Phase: INIT

## Entry

Run only when the bound project root genuinely lacks `.saipen/`. Resolve the
explicit/Git/nearest-ancestor root through BOOT first; never create relative
memory in an unbound cwd or borrow a sibling project's state.

## Bootstrap

Copy `extensions/templates/STATE.md`, `BOARD.md`, and `LOG.md` from the bound
SAIPEN home; do not freehand schemas. If templates are unavailable, create the
same shapes exactly:

- STATE: `phase: PLAN`, `task: none`,
  `next_action: "WAIT: init -- provide the first project goal or raw backlog"`,
  empty blocker, current protocol/schema versions, `style_contract`, absolute
  `saipen_home`, negotiated `mode`, `execution_intent: normal`, and UTC
  `updated`. INIT is run by a real seat, so `agent:` is **never `none`**.
  **Where the value comes from is not a choice**: derive it from the agent home
  that loaded the protocol—strip a leading dot and lowercase (`.codex` ->
  `codex`, `.claude` -> `claude`, `.config/opencode` -> `opencode`). If the
  platform exposes no agent home, use its canonical platform name and LOG that
  the identity was self-reported. A model name is never a seat.
- BOARD: exactly `## DOING`, `## TODO`, `## DONE`, `## BLOCKED`, no tickets.
- LOG: empty. Do not write examples/placeholders. The first real Work event
  uses the CORE skeleton; only its following checkpoint introduces
  `last_event`.
- KNOWLEDGE: create on first need, not during empty bootstrap.

Fill template placeholders before the first checkpoint. After durable writes,
set `transition_from: INIT` and enter PLAN. Generic field authority,
checkpoint order, identity comparison, and recovery remain in CORE/STYLE/OPS.
