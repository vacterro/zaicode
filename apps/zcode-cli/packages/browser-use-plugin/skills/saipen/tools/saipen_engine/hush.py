"""Real HUSH runtime -- EXEC-HUSH-01 (T-1236).

`hush <task>` is an EXECUTION-POLICY MODIFIER, not a phase and not a command.
The lifecycle it wraps is the lifecycle it would have had without it: same
resolver, same Work, same phases, same tools, same source intake, same audit
inbox, same evidence, same recovery, same safety gates. Only narration
changes. That equivalence is the whole contract -- a HUSH that quietly picked
a different route would be a second execution model wearing a formatting flag.

Shape of one activation:

    hush cc
      -> strip the modifier            (this module)
      -> resolve `cc` normally         (commands.py / the router)
      -> run the normal route          (unchanged)
      -> suppress DISCRETIONARY output (this module's classifier)
      -> emit the bounded final report
      -> eject                         (task-local; never persisted)

Two invariants carry the risk.

**Mandatory output is not suppressible.** Safety and destructive
authorization, a missing human decision, terminal failure, protocol
corruption, an externally visible side effect needing acknowledgement, and the
final evidence report always print. A policy that could silence a
confirmation prompt would turn a formatting preference into a safety defect,
so the classifier answers from a CLOSED mandatory set and every unknown kind
is treated as mandatory rather than optional.

**It does not leak.** The policy lives in the resolution that created it and
is never written to `STATE.md`. A next task that did not ask for HUSH gets the
default policy, because there is nowhere for the old one to have been stored.
"""

from __future__ import annotations

from dataclasses import dataclass

RULE_ID = "EXEC-HUSH-01"
MODIFIER = "hush"

# Output kinds HUSH may drop. Everything here is a convenience for a human
# watching the run; nothing here is evidence.
DISCRETIONARY = frozenset(
    {
        "preamble",
        "progress",
        "plan",
        "tool_narration",
        "success_chatter",
        # T-1419 EXEC-RESPONSE-01: the optional DETAILS block is renderable
        # chatter, not control surface. HUSH may drop it and may NOT drop any
        # mandatory field (STATUS/RESULT/BLOCKER/OPERATOR ACTION/NEXT EXACT
        # ACTION/VALIDATION), so the control surface has one schema under both
        # policies.
        "details",
    }
)

# Output kinds HUSH may NEVER drop. This set is closed on purpose and the
# classifier fails toward it: an unrecognized kind prints.
MANDATORY = frozenset(
    {
        "safety_refusal",
        "destructive_confirmation",
        "missing_authority",
        "terminal_failure",
        "protocol_corruption",
        "side_effect_acknowledgement",
        "final_report",
        "evidence",
    }
)

FINAL_REPORT_MAX_LINES = 20


@dataclass(frozen=True)
class Policy:
    """One task-local execution policy. Immutable; created per resolution."""

    hushed: bool = False

    def suppresses(self, kind: str) -> bool:
        """May this output kind be dropped under the current policy?

        Fails toward speech: not hushed, unknown kind, or a mandatory kind all
        return False. Only a kind explicitly listed as discretionary is
        droppable, and only while HUSH is active.
        """
        if not self.hushed:
            return False
        if kind in MANDATORY:
            return False
        return kind in DISCRETIONARY

    def describe(self) -> dict:
        return {
            "rule_id": RULE_ID,
            "execution_policy": "hush" if self.hushed else "default",
            "suppressed": sorted(DISCRETIONARY) if self.hushed else [],
            "mandatory": sorted(MANDATORY),
            "final_report_max_lines": FINAL_REPORT_MAX_LINES if self.hushed else None,
        }


DEFAULT = Policy(hushed=False)
HUSHED = Policy(hushed=True)


def strip_modifier(message: str) -> tuple[Policy, str]:
    """Split a leading `hush` modifier off a task. Returns (policy, task).

    Only a LEADING whole token counts. `hush` inside a task ("ship the hush
    docs") is ordinary text: a modifier that could be triggered from the middle
    of a payload would let arbitrary prose change execution policy.

    A bare `hush` with no task is NOT an activation -- there is nothing to
    modify -- and comes back as the default policy with an empty task, which
    the caller reports rather than guessing an objective.
    """
    if not isinstance(message, str):
        return DEFAULT, ""
    text = message.strip()
    if not text:
        return DEFAULT, ""
    head, _, rest = text.partition(" ")
    if head.lower() != MODIFIER:
        return DEFAULT, text
    task = rest.strip()
    if not task:
        return DEFAULT, ""
    return HUSHED, task


def activate(message: str) -> dict:
    """Mechanical projection of one `hush <task>` resolution.

    Returns the policy plus the EXACT task text to hand to the normal
    resolver. This function decides nothing about routing on purpose -- that
    is what makes `hush cc` and `cc` provably the same route.
    """
    policy, task = strip_modifier(message)
    return {
        "ok": bool(task) or not message.strip().lower().startswith(MODIFIER),
        "code": "HUSH_ACTIVATED" if policy.hushed else "HUSH_NOT_ACTIVE",
        "policy": policy,
        "task": task,
        **policy.describe(),
    }
