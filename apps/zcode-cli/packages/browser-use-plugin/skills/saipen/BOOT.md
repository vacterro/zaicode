# saipen BOOT -- cold-start router

BOOT defines no protocol rule. It decides what evidence and which single owner
must be loaded next. Rule IDs and machine facts live in `REGISTRY.json`; the
human ownership map lives in `INDEX.md`.

## Entry -- which command runs first

    NEW ACTIONABLE USER INPUT         ->  saipen start '<the task, one line>'
    NO NEW USER INPUT                 ->  saipen continue
    STATUS REQUEST / DIAGNOSTIC NEED  ->  saipen status --json

**NEW TASK -> START FIRST.** For a new task, do NOT run `status`, `continue`,
`source`, `recover` or any seat/role/auth negotiation first. START performs
the capture, the recovery preflight, the seat and the claim itself, and
returns the phase and the action to execute now. Run one of those commands
only when START's own answer names it.

START answers in one of three ways, and each one names what to do next:

- `STARTED` -- read `load_path`, execute `action` now. Nothing else first.
- `next: <command>` -- run it, then `saipen start --receipt SRC-###`.
- `next: saipen start --hex <hex>` -- run exactly that; the shell could not
  carry the task text, so the guard computed the transport that does.
- `next: saipen start --file <path>` -- write the task text VERBATIM to a
  UTF-8 file with your write tool (no shell, no quoting), then run it.

Never reword the user's task to get past a refusal.

## Cold route

1. **Load `STYLE.md` beside this BOOT.md before user-visible output, and
   `EXECUTION.md` with it.** STYLE's `reply_language:` and style contract govern
   the first token; EXECUTION's `EXEC-RESPONSE-01` governs output structure
   (control block first). No response token before both resolve; unreadable
   authority is a bootstrap failure, never permission to guess.

2. **Bind the project and installation.** Explicit target wins; then a verified
   host/session project-root carrier (`SAIPEN_PROJECT_ROOT` validated against
   optional `SAIPEN_PROJECT_LINEAGE` and `.saipen/IDENTITY.md`); then the Git
   worktree root, then the nearest ancestor containing `.saipen/`. Project memory
   is exactly `<project_root>/.saipen/`. Bind `saipen_home` from the loaded
   skill/STATE anchor, then resolve `protocol_dir` as either `<saipen_home>/saipen`
   or `<saipen_home>`. Do not scan for another install. A deterministic locator
   is preferred over any search: `saipen status --json` reports a `cold_route`
   block naming the bound root, `protocol_dir`, `boot`, `style`,
   `phase_module` and the `.saipen/` memory files, with
   `search_required: false`. Resolve the cold route from it; never use the
   host's grep/glob/search tool to find protocol documents, and never treat a
   host search fault (for example a ripgrep error) as a SAIPEN binding failure.
   When a search IS genuinely needed and the host's own search tool fails with a
   transport error (not zero matches), use `saipen search --hex
   <hex-encoded-utf8>` — the canonical, read-only, bounded search transport,
   which the guard admits even while protocol state is invalid. Zero matches is
   a normal result and must never be retried as a failure.
   If neither layout contains this file, route to BLOCKED. When a recognized local SAIHANDOFF transport is
   present, inspect the transport binding before concluding that a staging cwd is
   not a SAIPEN project; never ask the user for the root when a valid host/session
   root binding is available. A root without `.saipen/` routes to INIT.

   Actor binding is separate from project binding. `SAIPEN_AGENT`, when present,
   is an optional explicit actor/provenance carrier and is ownership-checked; it
   is not authentication. When absent inside a valid SAIPEN project, the single
   canonical protocol snapshot inherits `STATE.agent` and still applies normal
   ownership, recovery, protected-path and operation-safety checks. A host
   session id and host metadata are diagnostic context, never actors, and a host
   identity is never a seat: the optional explicit launcher refuses a seat that
   names the host it is launching. Invalid
   or contradictory canonical ownership fails closed. See `KNOWLEDGE/ADR-0003`
   § 8.

3. **Read and validate `.saipen/STATE.md`.** Check the registry-owned STATE
   shape, phase and `last_event`/style bindings. Corrupt or contradictory state
   routes to recovery before any ordinary work (`RECOVERY-01`, `OPS.md`). A
   legacy readable schema is upgraded only through the next canonical
   checkpoint. Files outrank model memory. For zero-context orientation use
   `saipen context orient --json` (optionally `--handoff <JSON>`). It reads a
   bounded STATE/current-ticket/LOG-tail projection, reports measured bytes,
   and classifies handoff freshness by identity, lineage and `based_on_event`.
   It never uses mtime or handoff prose as authority.

4. **Activate only applicable context.**

   - Skill injection present: load its SPEC and the smallest matching skill.
   - Active Work names a receipt: load the exact source, current Contract and
     coverage (`SOURCE-AUTHORITY-01`, `SOURCES.md`).
   - Current objective matches project knowledge: use `.saipen/KNOWLEDGE/INDEX.md`
     when fresh, then load only the smallest relevant active card/file set;
     missing/stale INDEX falls back to targeted discovery and is never authority.
   - USERPERSON is advertised by the effective context: load that effective
     profile before discretionary choices; otherwise create and warn nothing.
   - Runtime identity/capabilities are needed: query the runtime projection and
     load `RUNTIME.md`.

5. **Read the current BOARD record, then the active `LOG.md` tail.** The bounded
   orientation projection is sufficient for the first route; open the complete
   current BOARD/source record only when the selected Work requires it. Sealed log
   segments stay cold unless a parent-chain check needs them. Apply a pending
   `human_note` once through the canonical operation. If another actor wrote a
   newer checkpoint, discard remembered state and use the files.

6. **Resolve current input before persisted continuation.**

   The Entry table above decides the FIRST command; this step decides what
   the input means once it is not a new actionable task. Current input wins:
   the user's own message outranks the file. A persisted
   `next_action` is the
   previous checkpoint's pre-computed pick; where the mechanical router cannot
   re-derive it, confirm it against BOARD. Immediate means without asking, never without looking.

   - **Compound input first:** delegate lexical ordering and chain disposition
     to the mechanical resolver and `COMMANDS.md` before interpreting a segment.
   - A recognized command/shortcut resolves mechanically from `REGISTRY.json`.
     Human semantics come from `COMMANDS.md` (`CMD-ROUTING-01`,
     `CMD-COMPOUND-01`), never from CORE command prose.
     For bare `saipen` / `saipen continue` / `cc` / `сс`, invoke
     `saipen continue --json`, open `load_path` when supplied, and execute
     the returned action in this turn (`CMD-CONTINUE-01`). Skill loading and
     routing output alone do not execute the work. "State not checked" means
     perform the missing read, never an exit or a question about the command.
   - A substantial audit, mission, specification, review handoff or correction
     is captured before interpretation; route details to `SOURCES.md`.
   - An actionable objective routes to goal execution in `MAINTENANCE.md`
     (`GOAL-01`). Read-only or plan-only requests retain that scope.
   - With no new instruction, ask the deterministic router for the current
     action. If the engine is unavailable, apply the registry/CORE Pick and
     routing invariants (`PICK-01`). A persisted `WAIT:` is returned verbatim.
   - `SAIPEN_AUTO_RECALL` kick decision: run `saipen continue --json` before
     any chat; consumed earlier input (old `cc`) is evidence, never a question.

7. **Load one owner, not the library.** Use `INDEX.md` to select the exact rule
   owner. For a command, load `COMMANDS.md`; for mechanics/recovery, `OPS.md`;
   for source authority, `SOURCES.md`; for execution/output policy,
   `EXECUTION.md`; for goal/autonomous behavior, `MAINTENANCE.md`; for a global
   state invariant only, `CORE.md`. `CONFORMANCE.md` and `CHANGELOG.md` are
   excluded from routine execution.

8. **Load exactly one phase delta.** Use the phase returned by the current
   route and open `phases/<phase>.md`. Replace it when the phase changes. Never
   infer a phase from stale remembered state.

9. **Checkpoint canonically.** Mutations use the mechanical operation layer.
   The checkpoint owner is `CHECKPOINT-01`: LOG, then BOARD, then STATE; read
   all three back and run the validator at ticket/phase boundaries. Never edit
   a dead `saipen_home` pointer by guesswork; route rebind through the command
   and operation owners.

## Routing failures

- Missing/unreadable owner or installation: BLOCKED with the exact path.
- Source integrity/coverage failure: `SOURCES.md` decides; never continue from
  a summary or memory.
- Recovery or pending operation: `OPS.md` decides before normal routing.
- Unknown command: resolve registered extensions, then show the mechanical
  command list; never invent a meaning.
- `CONFORMANCE.md` remains excluded unless the current task explicitly owns a
  conformance-corpus/validator change.

`CHANGELOG.md` is never part of cold start. `CONFORMANCE.md` is never routine
context. `STYLE.md` governs every chat response; artifacts remain professional.
