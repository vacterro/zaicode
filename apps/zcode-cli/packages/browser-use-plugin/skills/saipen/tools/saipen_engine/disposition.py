"""Decision ownership dispositions (T-1161, INC-MUSE-SHIP-INTERNAL-CHOICE-001).

Core law: IF THE PROTOCOL CAN DECIDE IT, THE HUMAN MUST NOT BE ASKED TO
DECIDE IT. A human question is justified ONLY when the answer depends on
information or authority that genuinely belongs to the human -- product
intent, destructive authorization, secrets, external irreversible effects.

This module does NOT invent a second result system. It classifies the
structured fields SAIPEN carriers ALREADY carry (``execute_in_current_agent``,
``requires_human``, ``terminal``, ``crew_complete``, ``next_action``) into one
closed disposition vocabulary, and enforces the PROOF OBLIGATION that gates
every WAIT_USER: naming what human-owned information is missing, why
repository/protocol evidence cannot resolve it, and what consequence depends
on the answer.

MULTIPLE POSSIBLE INTERNAL ACTIONS DO NOT CREATE A HUMAN DECISION.
Operational sequencing (collect before replan, normalize before validate,
refresh a stale producer) is agent work. Product/policy choices (should this
feature exist, accept incompatibility, delete user data) may belong to the
human -- and only those justify WAIT_USER.
"""

from __future__ import annotations

from typing import Any

# The closed disposition set (P0 decision ownership model).
EXECUTE_SELF = "EXECUTE_SELF"
RECONCILE_SELF = "RECONCILE_SELF"
WAIT_USER = "WAIT_USER"
WAIT_EXTERNAL = "WAIT_EXTERNAL"
BLOCKED = "BLOCKED"
COMPLETE = "COMPLETE"
INVALID = "INVALID"

DISPOSITIONS = (
    EXECUTE_SELF,
    RECONCILE_SELF,
    WAIT_USER,
    WAIT_EXTERNAL,
    BLOCKED,
    COMPLETE,
    INVALID,
)

# Carrier codes that mean the engine already executed its mechanical step or
# the circuit reached its target -- never a reason to stop for a human.
_COMPLETE_CODES = frozenset({"CREW_DONE", "CREW_COMPLETE"})
_RECONCILE_CODES = frozenset(
    {"RECOVERY_REQUIRED", "RECOVERY_CONFLICT", "STALE_STATE", "NEEDS_REPAIR"}
)
_INVALID_CODES = frozenset(
    {"VALIDATION_FAILED", "NOT_SAIPEN_PROJECT", "CORRUPT_JOURNAL", "HOME_REQUIRED"}
)

# Known external-wait carriers: a non-user actor must complete first.
_WAIT_EXTERNAL_CODES = frozenset({"FIRST_PUBLISH_WAIT"})


def classify_carrier(carrier: dict[str, Any]) -> dict[str, Any]:
    """Classify ONE structured command result into a disposition.

    Deterministic over the fields SAIPEN already emits. The classifier NEVER
    derives WAIT_USER from mere optionality: an actionable carrier with
    ``execute_in_current_agent: true`` / ``requires_human: false`` /
    ``terminal: false`` is EXECUTE_SELF no matter how many alternative next
    steps also exist (INC-MUSE-SHIP-INTERNAL-CHOICE-001). Only an explicit
    ``requires_human: true`` or a ``WAIT: <category> -- ...`` next_action the
    grammar reserves for human boundaries yields WAIT_USER.
    """
    if not isinstance(carrier, dict):
        return {
            "disposition": INVALID,
            "action": None,
            "requires_human": False,
            "reason": "carrier is not structured state",
        }
    code = str(carrier.get("code") or "")
    action = carrier.get("action")
    requires_human = bool(carrier.get("requires_human"))
    terminal = bool(carrier.get("terminal"))
    next_action = carrier.get("next_action")

    if carrier.get("crew_complete") or code in _COMPLETE_CODES:
        return {
            "disposition": COMPLETE,
            "action": action,
            "requires_human": False,
            "reason": "objective satisfied",
        }
    if code in _INVALID_CODES:
        return {
            "disposition": INVALID,
            "action": action,
            "requires_human": False,
            "reason": f"state/protocol cannot be safely interpreted ({code})",
        }
    if code in _RECONCILE_CODES:
        return {
            "disposition": RECONCILE_SELF,
            "action": next_action or "recover",
            "requires_human": False,
            "reason": (
                "durable state and evidence disagree; mechanical recovery "
                "path exists and is owned by the current agent"
            ),
        }
    if code in _WAIT_EXTERNAL_CODES:
        return {
            "disposition": WAIT_EXTERNAL,
            "action": action,
            "requires_human": False,
            "reason": f"a non-user external boundary owns progress ({code})",
        }
    if requires_human:
        return {
            "disposition": WAIT_USER,
            "action": action,
            "requires_human": True,
            "reason": str(carrier.get("reason") or "explicit human boundary"),
        }
    wait_text = ""
    if isinstance(next_action, str) and next_action.startswith("WAIT:"):
        wait_text = next_action
    elif isinstance(action, str) and action.startswith("WAIT:"):
        wait_text = action
    if wait_text:
        # The closed WAIT grammar names its category; `user brake`,
        # `manual-verify`, `destructive-op`, `first-publish` are genuine
        # human boundaries. `blocked`/`safety valve` are NOT user questions.
        user_owned = (
            "user brake" in wait_text
            or "manual-verify" in wait_text
            or "destructive-op" in wait_text
            or "first-publish" in wait_text
        )
        return {
            "disposition": WAIT_USER if user_owned else BLOCKED,
            "action": wait_text,
            "requires_human": user_owned,
            "reason": "canonical WAIT boundary",
        }
    executable = bool(
        carrier.get("execute_in_current_agent")
        or (not terminal and not requires_human)
    )
    if executable:
        return {
            "disposition": EXECUTE_SELF,
            "action": next_action or action,
            "requires_human": False,
            "reason": (
                "executable next action; internal alternatives do not create "
                "a human decision"
            ),
        }
    return {
        "disposition": BLOCKED,
        "action": action,
        "requires_human": False,
        "reason": str(carrier.get("reason") or "no executable recovery path"),
    }


# ── P0 user-wait proof obligation ────────────────────────────────────────

REQUIRED_WAIT_USER_PROOF = (
    "missing_authority",  # WHAT exact information/authority is missing
    "evidence_insufficient",  # WHY repository/protocol evidence cannot decide
    "consequence",  # WHAT outcome depends on the human's answer
)


def user_wait_proof(**claims: Any) -> dict[str, Any]:
    """Gate every WAIT_USER behind a complete proof.

    A vague "need user decision" fails mechanically: every required claim
    must be present and substantive (>= 16 chars -- a real sentence fragment,
    not a placeholder word). Returns ``{"valid": bool, "gaps": [...]}``; gaps
    name exactly which proof elements are missing so the agent can either
    supply them or discover it must execute itself instead. Completeness is
    mechanical; whether the stated authority genuinely belongs to the human
    remains the agent's lawful judgment under CORE's ownership rules.
    """
    gaps: list[str] = []
    for field_name in REQUIRED_WAIT_USER_PROOF:
        value = claims.get(field_name)
        if not isinstance(value, str) or len(value.strip()) < 16:
            gaps.append(field_name)
    return {"valid": not gaps, "gaps": gaps}


# ── P0 traceability reconstruction ───────────────────────────────────────


def reconstruct_traceability(
    findings: list[dict[str, Any]], summary_ticket: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Umbrella tickets PASS only with per-finding durable mapping.

    INC-TRACEABILITY-UMBRELLA-LAUNDERING-001: one DONE ticket saying
    "N audit findings fixed" is laundering unless EVERY source finding keeps
    its own identity, disposition, evidence, and verification basis. A parent
    Work/ticket MAY summarize a wave; it may never replace the mapping.
    """
    problems: list[str] = []
    identities: list[str] = []
    for index, finding in enumerate(findings):
        label = finding.get("id") or f"finding[{index}]"
        identities.append(str(label))
        for field_name in ("disposition", "evidence"):
            value = finding.get(field_name)
            if not isinstance(value, str) or not value.strip():
                problems.append(f"{label}: missing {field_name}")
        verification = finding.get("verification")
        if verification not in ("verified", "rejected-with-evidence", "duplicate-of"):
            problems.append(f"{label}: verification must be explicit, got {verification!r}")
    if summary_ticket is not None:
        mapped = summary_ticket.get("finding_ids") or []
        missing = [i for i in identities if i not in mapped]
        if missing:
            problems.append(
                "summary ticket does not durably reference findings: "
                + ", ".join(missing)
            )
    return {
        "ok": not problems,
        "problems": problems,
        "finding_ids": identities,
    }
