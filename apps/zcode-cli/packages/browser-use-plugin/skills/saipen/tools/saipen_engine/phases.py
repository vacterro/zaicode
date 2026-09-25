"""The phase DFA and the `next_action` grammar, in one place.

All closed facts are derived from REGISTRY.json. CORE explains the state model;
runtime and validators never reconstruct the DFA from prose.
"""

from __future__ import annotations

import re

from .registry import load_registry, require_mapping, require_string_list

_PHASES = require_mapping(load_registry(), "phases")
_TRANSITIONS = require_mapping(_PHASES, "valid_transitions")
VALID_TRANSITIONS: dict[str, list[str]] = {
    str(source): list(require_string_list(_TRANSITIONS, str(source)))
    for source in require_string_list(_PHASES, "all")
}

# The COMPLETE canonical phase enum: every source node of the DFA (T-1008).
# The Nitro frontmatter probe and every other phase-whitelist consumer derive
# accepted phases from THIS set -- never a hand-kept local tuple that drifts
# when the DFA grows (MARKHUNT/VALIDATE/HUNT/CLEAN/TRANSLATE/PREPARE were
# once excluded by exactly such a copy).
ALL_PHASES = frozenset(VALID_TRANSITIONS)


# These seven phases are entered by explicit user command from ANY phase
# (CORE section 1.6/1.10) -- the transition table's FROM row doesn't restrict
# them. PLAN joined in v7.92.0: section 2.4's goal-mode Entry mandates a PLAN
# for the new objective from wherever the pivot happens, so `saipen goal` out of
# REVIEW (whose row allows only SHIP/BUILD/SCOUT/BLOCKED) was an invalid state
# produced by following the protocol exactly. Caught on a live pivot.
# NOTE: SHIP is deliberately absent. `saipen ship` is recognized from any phase
# as a COMMAND (CORE section 1.10), but `phase: SHIP` is reachable only from
# REVIEW -- section 1.10 says so in as many words while this set said otherwise
# from v7.83.0 to v7.94.0. A command is not a transition.
ANY_FROM = frozenset(require_string_list(_PHASES, "any_from"))

# The five phases whose `next_action` MUST name a ticket.
TICKET_BEARING_PHASES = frozenset(require_string_list(_PHASES, "ticket_bearing"))

_NEXT_ACTION = require_mapping(load_registry(), "next_action_forms")
PHASE_NA_RE = re.compile(str(_NEXT_ACTION["grammar"]))


def phase_next_action_error(value: str) -> str | None:
    """CORE section 1.2's `PHASE` pairing rule, or None when the value obeys it.

    Shared by Core and subSaipen states on purpose: the protocol has twice
    shipped a rule enforced on only one of the two, in both directions.
    """
    m = PHASE_NA_RE.match(value.strip())
    if not m:
        return (
            f"{value!r} is not a legal `PHASE <phase-enum> [T-###]` -- "
            f"the argument is one uppercase phase plus at most a ticket "
            f"ref, and nothing but the optional [...] progress tag may "
            f"follow it"
        )
    ph, ref = m.group(1), m.group(2)
    if ph != ph.upper():
        return (
            f"{value!r} writes the phase in lower case -- RFC § 1.2 takes "
            f"the uppercase § 1.6 enum value, and the phase doc is loaded "
            f"from its lowercased name, not from what the state says"
        )
    _five = "/".join(sorted(TICKET_BEARING_PHASES))
    if ph in TICKET_BEARING_PHASES and not ref:
        return (
            f"{value!r} enters ticket-bearing phase {ph} with no T-### -- "
            f"RFC § 1.2 REQUIRES the ref for {_five}, and a cold agent "
            f"cannot act on a phase with no subject"
        )
    if ph not in TICKET_BEARING_PHASES and ref:
        return (
            f"{value!r} attaches {ref} to {ph}, which is not one of the "
            f"five ticket-bearing phases ({_five}) -- RFC § 1.2 omits the "
            f"ref for every other phase; name the ticket in `task:`"
        )
    return None


def transition_legal(source: str, destination: str) -> bool:
    """Is `source -> destination` an edge of the DFA?

    A phase in `ANY_FROM` is reachable from anywhere by explicit command, so it
    is legal regardless of the source row. A self-transition is legal for any
    known phase — re-entering BUILD after a failed VERIFY is ordinary work, not
    a state machine violation.
    """
    if destination in ANY_FROM:
        return True
    if source == destination:
        return source in VALID_TRANSITIONS or source in ANY_FROM
    return destination in VALID_TRANSITIONS.get(source, [])


#: The one move that turns "no Work here" into Work. The guard's own
#: NO_ACTIVE_WORK answer prints it, and so does every CLI refusal that would
#: otherwise name a transition for a ticket that does not exist.
ENTRY_COMMAND = "saipen start '<the task, one line>'"

_TICKET_REF = re.compile(r"T-\d+")


def forward_route(phase: str | None, ticket: str | None) -> str | None:
    """The command that moves `ticket`'s Work out of `phase` along the DFA.

    The first destination of every row is that phase's forward edge (SCOUT ->
    BUILD -> VERIFY -> REVIEW -> SHIP), which is what a refusal owes a session
    that tried to skip ahead. Measured (T-1380): a route computed any other way
    was typed from the state that printed it and refused there -- finishing
    from BUILD printed `transition REVIEW`, and a project with no Work printed
    its STATE.task literal `none` as the ticket.

    `ticket` must be the ACTIVE Work, never an operand the caller typed. With
    none there is no transition to make, and the route is the entry command.
    """
    subject = (ticket or "").strip()
    if not _TICKET_REF.fullmatch(subject):
        return ENTRY_COMMAND
    legal = VALID_TRANSITIONS.get(phase or "") or []
    if not legal:
        return None
    return f"saipen transition {legal[0]} {subject} '<why>'"


def phase_document(phase: str) -> str:
    """The phase doc a given phase requires, relative to `protocol_dir`.

    The document is named from the LOWERCASED enum value, never from whatever
    casing the state happens to carry — which is why `phase_next_action_error`
    rejects a lowercase phase rather than helpfully accepting it.
    """
    return f"phases/{phase.lower()}.md"
