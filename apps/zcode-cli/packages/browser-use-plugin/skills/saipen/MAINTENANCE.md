## Part 2: MAINTENANCE (Autonomous Evolution)

### 2.1 Autonomous Transitions

When the Core state machine halts, the Maintenance layer MAY take over.

**Halt** means no *workable* `## TODO` ticket AND no `## DOING` ticket, used
identically everywhere in this section. *Workable* is CORE.md § 1.6's Pick
Rule. `## DONE` and `## BLOCKED` never count against the halt; neither does a
permanently unpickable `## TODO`, because a cyclic or dangling `needs:` moves
that ticket to `## BLOCKED` with the reason (CORE.md § 1.2) rather than sitting
in `## TODO` as ballast that blocks the halt forever.

FINISH outranks MAINTAIN: any `## DOING` ticket is finished, blocked, demoted
or adopted before maintenance begins.

- **DEFAULT BEHAVIOR**: bare `saipen` aliases `saipen continue`. An unhalted
  board MUST resume work; CORE.md § 1.11's action priority decides which.
- **ZERO-PROMPT AUTO-TRANSITION**: a halted board enters HUNT without asking.
  Clean HUNT routes to ADD on normal/goal intent. Under converge it routes by
  CONVERGE stages F/I and MUST NOT enter ADD.
  **Two exceptions, and this list is the complete one:** BLOCKED never
  auto-leaves; `mode: read-only` runs HUNT report-only and
  **MUST NOT enter `ADD` at all**.
- **HUNT**: Transition to `HUNT` occurs at the autonomous halt or on explicit
  command. **The halt requirement governs the AUTONOMOUS transition only**;
  explicit `saipen hunt` uses CORE/COMMANDS from-any-phase routing, while
  FINISH priority and the canonical checkpoint still apply.
- **An explicit `hh` that files at least one ticket does not stop at the
  filing.** It sets `execution_intent: goal` with the sweep as the objective,
  writes the `DEC: goal_waves 0->1` line § 2.4 requires, and enters `SCOUT` on
  the top new ticket without pausing; § 2.4's caps and Exit conditions then
  govern the run exactly as they do for `saipen goal <text>`. Filing and then
  halting made the press mean "find it" when the operator meant "find it and
  fix it", and left the findings to be re-picked by hand. This reuses the goal
  valve rather than inventing a second autonomy path, so caps, counters and
  exits stay in one place. A clean `hh` still routes by the rule above, and
  `mode: read-only` still MUST NOT enter `ADD` or set goal intent.
- Explicit CLEAN, MARKHUNT and TRANSLATE command routing belongs to
  CORE/COMMANDS; their local actions, isolation and exits live only in their
  phase documents.

### 2.2 Evolutionary ADD

MAINTENANCE owns only entry into ADD after a clean HUNT on normal/goal intent
and the goal-wave lifecycle in § 2.4. `phases/add.md` owns selection priority,
minimal versus planned routing, mature-product exit, decision evidence and
ADD-specific accounting. CORE owns ticket claims and the downstream execution
pipeline. ADD never runs on a fixed cadence or under converge.

### 2.3 The Industrial Completion Rule

When the user requests one step of a well-known user workflow, the agent SHOULD
evaluate whether the remaining steps are expected by modern software
conventions -- a judgment call, not mechanical. If that evaluation concludes
yes, the agent MUST implement the minimal coherent set rather than the isolated
feature; once triggered this is a discipline requirement, not optional.

- **Evaluate over blindly adding**: asked for "Apply", evaluate "Save",
  "Cancel" and "OK"; reject irrelevant additions such as "Save As".
- **The smallest complete solution wins**: complete the minimal coherent set,
  never expand into a related epic ("Export" justifies "Import", not "Cloud
  Sync").
- **Complete before you extend**: finish the requested workflow to its logical
  end before proposing another ("Login" implies "Logout" and wrong-password
  handling, not OAuth or SSO).

### 2.4 Goal-Driven Execution (Default)
<!-- RULE-OWNER: GOAL-01 -->

Goal-driven execution is the DEFAULT behavior for any actionable user objective
(CORE.md § 1.12). `saipen goal <text>` (and `/goal`) is an explicit alias that
sets a new high-level objective, supersedes whatever was queued, and runs it to
completion with minimal interruption through the Maintenance layer, not just
the current ticket wave. It is run-scoped, not session-scoped: the persisted
counters carry a run across a crash or a fresh session, and only this section's
Exit conditions end it.

**Entry (the pivot).** An actionable natural-language request, or explicit
`saipen goal <text>`, sets a new objective. A `DOING` ticket in flight is
checkpointed cleanly and left `TODO` with a `DEC` line naming the pivot, never
abandoned mid-edit. Existing `TODO` tickets are demoted below the new
objective's tickets, never deleted (board order = priority = law, CORE.md
§ 1.6). `PLAN` runs for the new objective and inserts its tickets at the top.
Set `execution_intent: goal`, `goal_waves: 0`, `goal_tickets: 0`, then enter
`SCOUT` for the first new ticket without pausing.

**The Entry `PLAN` is wave 1, not wave 0.** It is a `PLAN` for a genuinely new
wave, which is what the counter counts: on its completion write
`DEC: goal_waves 0->1` and checkpoint before entering `SCOUT`. Reading the `0`
initialization as the first wave's final value spends a third of the wave
budget invisibly and counts three waves as two.

**Entry versus resume.** Bare `cc` / `saipen continue` / "continue" resuming a
paused run proceeds immediately to the next workable ticket via `SCOUT`,
without re-planning or demoting anything. **A bare invocation standing in the
same message immediately after a plan command is not that case**: CORE.md
§ 1.10's pair carve-out makes it an Entry, with `execution_intent: goal` and
both counters at `0`, because the plan just written IS the stated objective.
That `PLAN` is the run's wave 1 and carries the same `DEC: goal_waves 0->1`
line -- counted once, at the plan, never again at the goal command.

**Whether a resume also resets the counters depends on the valve, not on the
command.** The resume command resets `goal_waves: 0`, `goal_tickets: 0` only
when they are at or over this section's caps -- the tripped condition the
resume exists to clear. With the valve untripped there is nothing to
re-authorize: the counters carry over exactly as `saipen continue` would leave
them and no re-authorization line is written. **A reset that does happen MUST
leave its own countable line** -- this exact text after the taxonomy, with the
real pre-reset counts substituted:
`DEC: goal reauthorized -- goal_waves N->0, goal_tickets M->0`.
Without it the drop is invisible: the bumps it cancels remain in LOG, so
CORE.md § 1.5's rebuild counts a budget the human already
re-authorized away and re-trips the valve, while this section forbids tidying
the counters back down.

**A resume landing on no workable ticket** is not a dead end and asks the user
nothing: fall through to § 2.1 under the still-set goal intent -- `HUNT`, then
`ADD` if clean. It is the same situation as a wave finishing on an empty board.

**Continuation.** While `execution_intent: goal`, advance
`SCOUT → BUILD → VERIFY → REVIEW → SHIP → DONE` across successive tickets
without stopping between them, subject to the caps below. `DONE` MUST
transition to `SCOUT` for the next ticket, or re-run `PLAN` automatically for
the next wave if the board defines one.

**Board-empty is not exit.** When `BOARD.md` empties, the agent MUST NOT stop
or wait for a human -- it falls straight through into § 2.1 exactly as under
bare `saipen`: `HUNT`, then `ADD` if clean, then `HUNT` again, indefinitely.
The goal intent remains set across the whole loop; a clean `HUNT` or one
completed `ADD` ticket is a *waypoint*, never a stopping point.

**SHIP exception.** The `saipen ship` gate is satisfied by an active
`execution_intent: goal` for subsequent ships to an existing `origin`; the
agent MUST auto-push without re-confirming per ship. **First publish of a
brand-new repository still MUST confirm name and public/private with the
user** -- a new public artifact is a one-way door goal-driven execution does
not waive. Brand-new means no `origin` yet, OR an `origin` that exists but has
never actually received a commit or tag (`phases/ship.md` § 7).

**Counters MUST persist, not just live in context** -- a long run spans
crashes, restarts and other agents, so an in-context count is lost on exactly
the runs the valve protects. `STATE.md` MUST carry:

- `goal_waves` -- +1 each time `PLAN` runs for a genuinely new wave, and +1
  each time a `HUNT`→`ADD` cycle completes. "Completes" is the moment ADD's own
  § 2.2 evaluation reaches a `RETURN`, whether that tickets-and-claims a
  `BUILD`, tickets a `PLAN_or_SCOUT`, or concludes `DONE` outright -- counted
  there, never deferred until the ticket ADD just created finishes its own
  `BUILD → VERIFY → REVIEW → SHIP` run, which `goal_tickets` tracks separately.
  A `PLAN` entered directly from ADD's `RETURN PLAN` is NOT a new wave: that
  cycle was already counted at ADD's RETURN, so `phases/plan.md` skips the
  increment in exactly that case. Without the carve-out one `HUNT`→`ADD`→`PLAN`
  chain counts one wave twice and trips the valve early.
- `goal_tickets` -- +1 each time a ticket passes `VERIFY`.

Both are bumped and checkpointed (CORE.md § 1.5) at the moment they change, so
a resuming agent reads the true count from `STATE.md` rather than re-deriving
it from `LOG.md` scrollback. **Each bump MUST also leave an identifiable LOG
line** -- `DEC: goal_waves N->M` or `DEC: goal_tickets N->M`, this exact text
after the taxonomy -- because CORE.md § 1.5's Recovery rebuilds these counters
by counting wave/ticket-completion events since the pivot line, which is only
executable if those events are distinguishable rather than inferred from prose.

**Safety valve.** One `saipen goal` invocation MUST NOT process more than
3 waves (`goal_waves`, planned tickets and HUNT/ADD cycles counted together) or
20 tickets (`goal_tickets` counts VERIFY-passes, so a ticket that bounces
`REVIEW` -> `BUILD` -> `VERIFY` and re-passes consumes budget more than once --
deliberate and conservative: the valve trips slightly early, never late),
whichever comes first. On hitting the ceiling the agent MUST stop, write a full
BOARD/STATE checkpoint, and report progress; the user re-invokes `cc` to
re-authorize and continue.

**A tripped valve is a pause awaiting re-authorization, NOT an exit, and the
goal intent stays set through it** (see Exit below, which deliberately does not
list the valve). The alternative deadlocks: CORE.md § 1.10 recognizes the goal
resume ONLY while `execution_intent: goal`, so clearing the intent here would
make the very command this line tells the user to run illegal in exactly the
state it just created, leaving only `saipen goal <text>` -- a substitution, not
a continuation.

**The tripped state has one exact shape, and every field of it is
load-bearing.** On tripping, checkpoint (CORE.md § 1.5) with:

- `execution_intent: goal` -- unchanged; the valve is a pause, not an exit.
- `goal_waves` / `goal_tickets` -- unchanged, left at or over the cap. These
  ARE the tripped condition; "tidying" them lets a restart walk straight past
  the valve.
- `next_action` -- the CORE.md § 1.2 safety-valve wording, verbatim, with the
  real counts substituted:
  `WAIT: safety valve reached (N waves / M tickets) -- run 'cc' to continue`.
  **The resume key is uniform**: `cc` reauthorizes a
  tripped valve and resumes the run for BOTH `execution_intent: goal` and
  `execution_intent: converge`. `saipen goal` is never a resume key -- it is
  the create/pivot command, so a pause naming it would substitute the objective
  instead of continuing it.
- `phase` -- **left exactly as it is. Do NOT set `phase: BLOCKED`.** This is
  the one field an agent is most tempted to "fix" here, and setting it is a
  self-inflicted deadlock: § 2.4's Exit list makes `STATE.phase: BLOCKED` an
  exit condition, so writing it clears the goal intent and makes the resume the
  `WAIT:` line prescribes illegal under CORE.md § 1.10 -- the valve destroying
  its own continuation path.
- `blocker` -- the tripped valve is not a session-level block, so
  `blocker: none` stays correct. A budget pause and a blocked project are
  different states and `saipen status` reports them differently.

**The counters are what stops a restart, not the phase.**
`execution_intent: goal` with `goal_waves >= 3` or `goal_tickets >= 20` *is*
the tripped condition -- no new field. An agent resuming into that state MUST
NOT continue the run: it re-states the stop with `next_action` in CORE.md
§ 1.2's safety-valve `WAIT:` form, and waits. `cc` is the human's
re-authorization: it resets both counters to `0` (via `reauthorize_valve`, only
when the valve has tripped), which clears the tripped condition and grants the
next budget. Counters at or over the cap are load-bearing, not historical --
never "tidy them up" without an actual re-authorization.

**Unchanged under Goal-Driven Execution.** All existing caps still apply
verbatim (3 dead hypotheses / 2 fix cycles per ticket in VERIFY; 2 review
passes per finding in REVIEW). Goal-driven execution MUST NOT skip `VERIFY` or
`REVIEW` -- autonomy applies to *continuation between steps*, never to the
correctness gates themselves. Destructive ops outside the ship/publish path
still require explicit confirmation unless the ticket itself pre-authorizes
them.

**Exit.** The goal intent MUST be cleared in `STATE.md` (back to
`execution_intent: normal`) ONLY when `ADD` itself gracefully concludes because
the product is mature and logically complete (`phases/add.md`), or the agent
reaches `STATE.phase: BLOCKED` (not just a single ticket moving to
`## BLOCKED`). **A tripped safety valve is NOT on this list** -- it is a budget
pause, the same shape as `saipen stop`, which is likewise not on this list; the
two real exits are the objective ending, which a valve trip is not. What stops
a restart from silently continuing is the counters, not the flag. A momentarily
empty `BOARD.md` is never, by itself, an exit condition. On exit,
`goal_waves`/`goal_tickets` MUST be cleared -- they describe the run that just
ended, not a running lifetime total.

**Final report.** Tickets done/verified/shipped, any blocked, next action --
distinguishing tickets that came from the user's original ask from ones picked
up along the way (pre-existing backlog demoted below it, or `HUNT`/`ADD`
findings), so the user can tell what actually happened without re-deriving it
from `LOG.md`. Board order at Entry already carries that distinction; no new
persisted field is needed, it only has to reach the report.
