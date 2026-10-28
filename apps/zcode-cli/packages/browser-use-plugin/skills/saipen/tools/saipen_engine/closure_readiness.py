"""ONE closure-readiness decision, shared by the router and the finish gate.

T-1403. The measured defect: `saipen continue` returned a `PHASE finish` action
for a DOING ticket whose linked receipt carried non-terminal actionable
clauses, and when the agent obeyed it, `saipen ticket done` refused
`SOURCE_UNRESOLVED` with NO canonical route. The router emitted an action its
own closure gate could already prove would refuse, and the refusal named no way
forward.

The repair is one decision both consumers read:

* the router must not EMIT a finish route a not-ready closure gate will refuse;
* the finish gate must not REFUSE with a route-less sentence when a finite
  executable remediation exists.

Only the second half needs the filesystem, so this module is deliberately not
part of the pure router: a gate that needs the project reads it here, exactly
as `conformance_crew_gate` reads the conformance receipt. ONE classifier, TWO
consumers (`router.closure_finish_gate` for the route, `operations.finish_ticket`
for the refusal), so a route one surface refuses can never be handed out by
the other.

The remediation is chosen from CURRENT SOURCE-CLAUSE TRUTH, never a hardcoded
`SOURCE_UNRESOLVED -> block`:

* the request's own clause (or an empty contract) is discharged by the Work's
  own verification evidence -- the route is the evidence checkpoint;
* a derived actionable clause that is not terminal is dispositioned by its own
  receipt's `source disp` command, naming the exact receipt and clause;
* a linkage/integrity problem is repaired from the receipt's own status;
* anything else the classifier cannot turn into a finite executable route falls
  back to an honest ticket block, which is itself a canonical, reachable move.

`ready: False` always carries a canonical, non-prose `canonical_next_command`.
"""

from __future__ import annotations

from pathlib import Path

RULE_ID = "T-1403"

#: Refusal code the router attaches when closure is not ready.
NOT_READY = "CLOSURE_NOT_READY"


def closure_readiness(root: Path | str, ticket_id: str) -> dict:
    """Is this Work ready to close, and if not, what is the finite route out?

    Returns a mapping:

    * ``ready`` -- True when the closure gate passes (or when the finish
      operation's own discharge step would make it pass); False with a
      remediation otherwise.
    * ``code`` -- the SOURCE_* code from the gate when not ready.
    * ``ticket`` / ``receipt`` / ``unresolved`` -- the exact truth the decision
      was made from.
    * ``canonical_next_command`` -- the ONE finite executable route out. Never
      prose, never empty when ``ready`` is False.

    READ-ONLY. It must not discharge anything -- that write belongs to the
    finish operation. It PREDICTS the discharge exactly as `finish_ticket`
    performs it, so the router never emits a finish the gate would refuse and
    never suppresses a finish that would in fact succeed.
    """
    from .intake import is_request_clause, work_closure_gate

    root = Path(root)
    gate = work_closure_gate(root, ticket_id)
    if gate.get("ok"):
        return _ready(ticket_id, gate.get("code", "SOURCE_COVERAGE_COMPLETE"), gate.get("receipt"))
    code = str(gate.get("code") or "SOURCE_UNRESOLVED")
    receipt = gate.get("receipt")
    unresolved = list((gate.get("coverage") or {}).get("unresolved") or [])
    # Mirror the finish operation's own discharge: a SOURCE_UNRESOLVED whose
    # only unresolved clauses are the request's own (or an empty contract) is
    # settled by the Work's verification evidence, which finish writes. If that
    # evidence already exists, the finish WILL succeed -- so this decision is
    # ready and the router must emit it.
    if code == "SOURCE_UNRESOLVED" and receipt:
        non_request = [
            rid for rid in unresolved if not is_request_clause(root, receipt, rid)
        ]
        request_only = not non_request
        if request_only:
            from .log import verification_evidence

            proven, _reason = verification_evidence(ticket_id, _events(root))
            if proven:
                return _ready(ticket_id, "SOURCE_UNRESOLVED_SETTLED_BY_EVIDENCE", receipt)
            return _not_ready(
                ticket_id,
                receipt,
                unresolved,
                "INCOMPLETE_TICKET",
                _evidence_route(ticket_id),
            )
        # A derived actionable clause is settled by its own receipt's dispense
        # command -- name the FIRST such clause, the exact one that will still
        # be unresolved after the request clause discharges.
        return _not_ready(
            ticket_id,
            receipt,
            unresolved,
            code,
            f"saipen source disp {receipt} {non_request[0]} <STATUS> --evidence <REF>",
        )
    return _not_ready(
        ticket_id, receipt, unresolved, code, _remediation(root, ticket_id, gate, unresolved)
    )


def _events(root: Path) -> list:
    from .log import read_history_snapshot

    return list(read_history_snapshot(root, lean=True).events)


def _evidence_route(ticket_id: str) -> str:
    from .operations import _evidence_route as route

    return route(ticket_id, "", None)


def _ready(ticket_id: str, code: str, receipt: object) -> dict:
    return {
        "ready": True,
        "code": code,
        "ticket": ticket_id,
        "receipt": receipt,
        "unresolved": [],
        "canonical_next_command": None,
    }


def _not_ready(ticket_id: str, receipt, unresolved: list, code: str, route: str) -> dict:
    return {
        "ready": False,
        "code": code,
        "ticket": ticket_id,
        "receipt": receipt,
        "unresolved": unresolved,
        "canonical_next_command": route or _block_route(ticket_id, code),
    }


def _remediation(root: Path, ticket_id: str, gate: dict, unresolved: list) -> str:
    """The ONE finite executable route out of this exact not-ready state."""
    from .intake import ensure_request_clause, is_request_clause

    receipt = gate.get("receipt")
    code = str(gate.get("code") or "")
    # A linkage/integrity gap is repaired from the receipt's own status, not by
    # touching the ledger: the receipt still owns what its bytes are.
    if code in ("SOURCE_LINKAGE_MISSING", "SOURCE_LINKAGE_DRIFT"):
        return f"saipen source status {receipt}"
    if code in ("SOURCE_RECEIPT_MISSING", "SOURCE_CORRUPTION", "INVALID"):
        from .intake import recover_reports

        # T-1476: the read-only diagnostic is a route only when it reports this
        # receipt; otherwise it changes nothing and the route repeats forever.
        if recover_reports(root, receipt):
            return "saipen source recover"
        return _block_route(ticket_id, code)
    if code == "SOURCE_UNRESOLVED" and receipt:
        # The request's own clause (or an empty contract) is discharged by the
        # Work's own verification evidence -- the same reconcile T-1379 landed.
        only_request = not unresolved or all(
            is_request_clause(root, receipt, rid) for rid in unresolved
        )
        if only_request and ensure_request_clause(root, receipt).get("ok"):
            from .operations import _evidence_route

            return _evidence_route(ticket_id, "", None) or _block_route(ticket_id)
        if unresolved:
            # A derived actionable clause is settled by its own receipt's
            # dispense command, naming the exact receipt and clause. The
            # disposition is the agent's semantic decision; the ROUTE is exact.
            clause = unresolved[0]
            return (
                f"saipen source disp {receipt} {clause} <STATUS> --evidence <REF>"
            )
    # Nothing above could name a source-side repair: the honest, finite move is
    # to block the Work with the exact reason, which is itself canonical.
    return _block_route(ticket_id, gate.get("code"))


def _block_route(ticket_id: str, reason: object = None) -> str:
    text = f"source closure not ready ({reason})" if reason else "source closure not ready"
    return f'saipen ticket block {ticket_id} "{text}"'
