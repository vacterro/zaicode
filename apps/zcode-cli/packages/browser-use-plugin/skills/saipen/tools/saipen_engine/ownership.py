"""ONE active-execution-ownership authority (CORE-001/CORE-002, SRC-026:R001/R002).

The incident this module exists to make impossible was persisted twice: an
operation by actor B that had nothing to do with the active ticket rewrote
``STATE.agent`` to B while ``BOARD``'s active ticket kept owner A. The
transactional gate accepted the split; the canonical validator refused it
later, at the release boundary. Two facts caused it:

1. execution ownership was inferred per call site (``"agent": agent`` in every
   owned STATE patch), so "who wrote last" and "who owns the seat" were the
   same field with two meanings; and
2. the fast gate had no owner-vs-``STATE.agent`` invariant at all, so the
   contradiction could commit.

Everything here is pure. The classifier binds the exact snapshot inputs the
decision depends on -- active ticket, ``STATE.task``, ``STATE.agent``, BOARD
owner, BOARD ``claim_time``, the current actor and a FIXED evaluation instant
-- and returns a structured record, never a diagnostic string other code
re-parses. Claim expiry is NOT reimplemented here: ``board.claim_status`` is
the single expiry rule and this module consumes it.

Consumers (all of them, no private half-checks):
  * ``operations`` -- what STATE.agent a non-transferring mutation may persist,
    and the atomic three-field handover projection;
  * ``fast_check`` -- the transactional invariant;
  * ``validate.py`` -- the canonical invariant (same predicate, same words);
  * ``router`` -- which continuation an actor is authorized to be told to run.
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field

from .board import claim_status, parse_board

#: No active ## DOING ticket exists: there is no execution seat to own.
NO_ACTIVE = "NO_ACTIVE"
SELF = "SELF"
UNCLAIMED = "UNCLAIMED"
FOREIGN_STALE = "FOREIGN_STALE"
FOREIGN_LIVE = "FOREIGN_LIVE"
INVALID = "INVALID"

#: The closed classification vocabulary. A consumer that receives anything
#: outside this tuple is reading a corrupted result, not a new case.
ACTIVE_OWNERSHIP_STATUSES = (
    NO_ACTIVE,
    SELF,
    UNCLAIMED,
    FOREIGN_STALE,
    FOREIGN_LIVE,
    INVALID,
)

#: Statuses an actor may take over through the EXPLICIT claim/adoption action.
#: A live foreign claim is deliberately absent: adoption is not takeover.
ADOPTABLE = frozenset({UNCLAIMED, FOREIGN_STALE})

#: Statuses under which the current actor may run an ordinary mutating
#: continuation on the already-bound active ticket.
MUTABLE = frozenset({NO_ACTIVE, SELF})


@dataclass(frozen=True)
class ActiveOwnership:
    """The complete active-seat decision for ONE snapshot and ONE actor.

    A structured value on purpose: every earlier consumer parsed a refusal
    sentence or recomputed half the rule, which is exactly how the router and
    the authorization gate came to disagree about the same snapshot.
    """

    status: str
    active_ticket: str | None
    state_task: str | None
    state_agent: str | None
    board_owner: str | None
    claim_time: str | None
    actor: str | None
    evaluated_at: datetime.datetime
    #: STATE.task names the active BOARD ticket (the seat is BOUND).
    bound: bool = False
    #: STATE.task names some OTHER ticket than the active one -- a split that
    #: is a binding failure, never an ownership question.
    misbound: bool = field(default=False)

    @property
    def has_active(self) -> bool:
        return self.active_ticket is not None

    @property
    def may_mutate_active(self) -> bool:
        """May ``actor`` run an ordinary mutating continuation right now?"""
        return self.status in MUTABLE

    @property
    def requires_adoption(self) -> bool:
        """Must ``actor`` run the explicit claim/adoption action first?"""
        return self.status in ADOPTABLE

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "active_ticket": self.active_ticket,
            "state_task": self.state_task,
            "state_agent": self.state_agent,
            "board_owner": self.board_owner,
            "claim_time": self.claim_time,
            "actor": self.actor,
            "evaluated_at": self.evaluated_at.isoformat().replace("+00:00", "Z"),
            "bound": self.bound,
            "misbound": self.misbound,
        }


def _tickets(board) -> dict:
    """Accept a BOARD text, a parsed board, or an already-extracted map."""
    if board is None:
        return {}
    if isinstance(board, str):
        return parse_board(board).get("tickets", {})
    if isinstance(board, dict) and "tickets" in board:
        return board.get("tickets") or {}
    return board or {}


def classify_active_ownership(
    state: dict,
    board,
    actor: str | None = None,
    now: datetime.datetime | None = None,
    root=None,
) -> ActiveOwnership:
    """Classify the active execution seat at a FIXED instant.

    ``now`` is threaded end to end so a matrix test evaluates the router and
    the authorization gate against the very same instant; two calls that read
    ``datetime.now()`` independently are not the same snapshot.

    ``root`` opts this call into the T-1384 session check. Ownership is
    otherwise decided on `owner`, a NAME, which an arriving window reads out
    of the same ledger and inherits -- so the seat question "is this me?"
    answers itself. With a root, a LIVE claim bound to a session this process
    cannot present reads FOREIGN_LIVE whatever the name says. It is optional
    because only the seat-TAKING paths need it; every other caller keeps the
    exact behaviour it had, and a claim carrying no binding is unaffected
    either way.
    """
    if now is None:
        now = datetime.datetime.now(datetime.timezone.utc)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    tickets = _tickets(board)
    state = state or {}
    state_task = state.get("task")
    if state_task in ("none", ""):
        state_task = None
    state_agent = (state.get("agent") or "").strip() or None
    doing = [t for t in tickets.values() if t.get("section") == "## DOING"]
    if not doing:
        return ActiveOwnership(
            status=NO_ACTIVE,
            active_ticket=None,
            state_task=state_task,
            state_agent=state_agent,
            board_owner=None,
            claim_time=None,
            actor=actor,
            evaluated_at=now,
            bound=False,
            misbound=bool(state_task),
        )
    ticket = doing[0]
    fields = ticket.get("fields") or {}
    active = ticket.get("id")
    status = claim_status(ticket, actor, now)
    if root is not None and status == SELF:
        from .board import session_locked_out

        if session_locked_out(ticket, root, now):
            status = FOREIGN_LIVE
    return ActiveOwnership(
        status=status,
        active_ticket=active,
        state_task=state_task,
        state_agent=state_agent,
        board_owner=(fields.get("owner") or "").strip() or None,
        claim_time=(fields.get("claim_time") or "").strip() or None,
        actor=actor,
        evaluated_at=now,
        bound=state_task == active,
        misbound=bool(state_task) and state_task != active,
    )


def preexisting_split_error(own: ActiveOwnership, seated: str | None) -> str | None:
    """Why this BEFORE ownership snapshot may not be PRESERVED, or None.

    Audit/17 CORE-002 (SRC-026:R001 REVIEW repair). A non-transferring
    mutation must PRESERVE ``STATE.agent``, so a corrupt BEFORE ownership
    state cannot be carried forward -- and must never be silently healed by
    an unrelated future-work mutation either. Two cases:

      * ``INVALID`` -- half owner/claim_time pair or a non-UTC stamp: the
        active claim is unreadable, so "preserve the seat" has no truthful
        answer;
      * a claimed active ticket whose BOARD owner disagrees with
        ``STATE.agent`` -- the committed STATE/BOARD split this module exists
        to make impossible. Only explicit handover, explicit claim/adoption
        or canonical reconcile/repair may change execution authority through
        that state; an unrelated mutation REFUSES with zero mutation.

    A FOREIGN_LIVE/UNCLAIMED active claim is NOT a split to refuse here: it
    is ordinary multi-agent truth the seat rule simply preserves. A claimed
    ticket whose owner disagrees with the persisted seat is the corruption
    case -- canonical claim/handover transactions always move both, so a
    committed mismatch can only come from the old actor-fallback defect or
    out-of-band bytes.
    """
    if own.status == INVALID:
        return (
            "pre-existing INVALID active ownership (half owner/claim_time "
            "pair or non-UTC stamp) -- execution ownership is unreadable; "
            "repair before any non-transferring mutation"
        )
    if own.has_active and own.board_owner and seated and seated != own.board_owner:
        return (
            f"pre-existing owner/STATE split: STATE.agent={seated!r} but the "
            f"active ticket {own.active_ticket} is claimed by "
            f"{own.board_owner!r} -- a corrupt ownership state must be "
            f"exposed or refused, never silently healed by an unrelated "
            f"mutation"
        )
    return None


def ownership_invariant_errors(
    state: dict,
    board,
    actor: str | None = None,
    now: datetime.datetime | None = None,
) -> list[str]:
    """THE shared committed-state ownership invariant (fast + canonical).

    No COMMITTED canonical state may hold ``STATE.task = T-A`` while T-A is the
    claimed active ticket and ``STATE.agent`` disagrees with T-A's BOARD owner.
    A transitional value may exist INSIDE an uncommitted transaction (the
    handover projection builds STATE and BOARD before either is written); by
    the time either validator sees bytes, the pair must agree.

    Deliberately narrow: binding failures (``STATE.task`` naming a different
    ticket, a DOING ticket with no bound task) belong to the binding rules and
    are reported there, so a single defect is not reported twice in two
    vocabularies.
    """
    own = classify_active_ownership(state, board, actor, now=now)
    if not own.has_active or not own.bound:
        return []
    if own.status == INVALID:
        return [
            f"## DOING {own.active_ticket} carries an INVALID claim (half "
            f"owner/claim_time pair or non-UTC stamp) while STATE.task names "
            f"it -- execution ownership is unreadable; repair the claim"
        ]
    if not own.board_owner or not own.state_agent:
        return []
    if own.board_owner != own.state_agent:
        return [
            f"STATE.agent {own.state_agent!r} is not the owner of the active "
            f"ticket {own.active_ticket}, which BOARD claims for "
            f"{own.board_owner!r} -- a committed STATE/BOARD execution-owner "
            f"split is the concurrency collision CORE § 1.4 exists to prevent"
        ]
    return []


def adoption_action(ticket_id: str) -> str:
    """THE canonical explicit adoption command for a bound-but-unowned seat.

    One string, one place: the router advertises exactly the command the
    authorization gate demands (``explicit 'claim T-###' adoption is required
    before any active-ticket mutation``), so an advertised action can never be
    one the executor refuses.
    """
    return f"saipen claim {ticket_id}"


def handover_refusal_detail(own: ActiveOwnership, target: str) -> str | None:
    """Why ``actor`` may not transfer this seat to ``target``, or None.

    FOREIGN_LIVE is the hard case the audit named: an unauthorized transfer
    must refuse with zero STATE change, zero BOARD change and zero committed
    event tail, so the refusal is computed BEFORE any plan is built.
    """
    if not own.has_active:
        return None
    if own.status == FOREIGN_LIVE:
        return (
            f"{own.active_ticket} is actively claimed by {own.board_owner!r}; a "
            f"live foreign claim cannot be handed to {target!r} by session "
            f"{own.actor!r} -- the owner must release or the claim must lapse"
        )
    if own.status == INVALID:
        return (
            f"{own.active_ticket} carries an INVALID claim (half owner/claim_time "
            f"pair or non-UTC stamp); repair before transferring execution "
            f"ownership"
        )
    return None
