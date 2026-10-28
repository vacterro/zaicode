"""The default SAIPEN response surface -- EXEC-RESPONSE-01 (T-1419).

One schema for every ordinary user-facing operational boundary: a control
block that renders vertically in a fixed semantic order, with no prose before
it. The rule is prose in ``saipen/EXECUTION.md``; this module is its
behavioural projection so the contract can be decided without re-reading the
document, exactly as the guard shares one classifier with the router.

Two questions the surface answers mechanically:

* Is a rendered control block well-formed -- mandatory fields present, in
  canonical order, ``DETAILS`` optional and last, and a ``WAIT`` that actually
  tells the human what to do?
* Should the agent return to the user at all, or continue executing? A control
  block with no required human action and a canonically executable next step is
  NOT a response boundary (preserves T-1416).
"""

from __future__ import annotations

RULE_ID = "EXEC-RESPONSE-01"

#: The mandatory control surface, in canonical order. Every field is present on
#: every ordinary response.
MANDATORY_FIELDS = (
    "STATUS",
    "RESULT",
    "BLOCKER",
    "OPERATOR ACTION",
    "NEXT EXACT ACTION",
    "VALIDATION",
)

#: Optional fields, rendered only AFTER the mandatory surface.
OPTIONAL_FIELDS = ("DETAILS",)

FIELD_ORDER = MANDATORY_FIELDS + OPTIONAL_FIELDS

#: The values that mean "no action" for the two always-present action fields.
NONE_VALUES = frozenset({"", "NONE"})


def _is_none(value: object) -> bool:
    return str(value if value is not None else "").strip().upper() in NONE_VALUES


def surface_errors(fields: dict, *, status: str = "") -> list[str]:
    """Why a control block does not satisfy EXEC-RESPONSE-01, or []."""
    if not isinstance(fields, dict):
        return ["control surface must be a field mapping"]
    keys = [key for key in fields if key in FIELD_ORDER]
    errors: list[str] = []
    missing = [key for key in MANDATORY_FIELDS if key not in fields]
    if missing:
        errors.append("missing mandatory field(s): " + ", ".join(missing))
    positions = [FIELD_ORDER.index(key) for key in keys]
    if positions != sorted(positions):
        errors.append("fields render outside the canonical order")
    if "DETAILS" in fields and keys and keys[-1] != "DETAILS":
        errors.append("DETAILS must render last")
    # A WAIT that names no human action is the exact ambiguity the surface
    # exists to remove: the human cannot discover whether they must act.
    if str(status).strip().upper().startswith("WAIT") and _is_none(
        fields.get("OPERATOR ACTION")
    ):
        errors.append("WAIT without OPERATOR ACTION is invalid")
    return errors


def should_continue(
    *,
    operator_action: object,
    executable_action_remains: bool,
    response_boundary: bool,
) -> bool:
    """May the agent continue internally instead of returning to the user?

    True only when NO human action is required, a canonically executable action
    remains, and the moment is not a true response boundary. A required human
    action, an exhausted route, or a genuine boundary all return the control
    surface instead.
    """
    if response_boundary:
        return False
    if not _is_none(operator_action):
        return False
    return bool(executable_action_remains)
