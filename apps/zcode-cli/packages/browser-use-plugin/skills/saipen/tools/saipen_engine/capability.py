"""The CURRENT-SESSION capability -- negotiated, never remembered (CORE § 1.3).

`STATE.mode` records the LAST handshake outcome. It is history: the session that
wrote it is over, and a value on disk can neither grant nor revoke the authority
of the session reading it. Authorization, routing, release and crew therefore
consume the capability THIS session negotiated, which every public command
boundary obtains from `negotiate_capability()` and injects downstream
(hostile-regression, P0#4).

Two failure modes this closes:

  * a stale `mode: full` letting a read-only session route mutation, plan a
    release or close a crew epoch;
  * a stale `mode: read-only` freezing a session that really is writable.

The negotiation is deliberately explicit and machine-readable: the host declares
the session's capability through `SAIPEN_CAPABILITY`, and absent a declaration
the session is a normal writable one (`full`). Nothing here reads `STATE.md`.
"""

from __future__ import annotations

import os
from pathlib import Path

# The closed capability set (identical to the STATE `mode` enum, because the
# handshake outcome and the live capability describe the same four policies --
# only their AUTHORITY over the current session differs).
CAPABILITIES = ("full", "read-only", "no-publish", "manual-verify")

DEFAULT_CAPABILITY = "full"

ENV_VAR = "SAIPEN_CAPABILITY"

# V7 Producer Parallelism Hardening -- the producer capability boundary.
#
# A PRODUCER session (saitranslate / saiwiki) may read canonical source, write
# its OWN namespace, and create its OWN package evidence. It may NEVER touch
# Core STATE/BOARD/LOG, integrate its own output, collect/disposition, or
# commit/tag/push/ship. Those remain Core-owned.
CAPABILITY_DENIED = "CAPABILITY_DENIED"

PRODUCER_ALLOWED_ACTIONS = frozenset(
    {
        "read_source",
        "write_namespace",
        "write_package_evidence",
        "prepare",
        "stage",
        "publish_readonly_namespace",
    }
)

PRODUCER_FORBIDDEN_ACTIONS = frozenset(
    {
        "mutate_core_state",
        "mutate_core_board",
        "mutate_core_log",
        "mutate_core_knowledge",
        "integrate",
        "collect",
        "disposition",
        "commit",
        "tag",
        "push",
        "ship",
        "release",
        "close_crew_epoch",
    }
)


def negotiate_capability(env: dict | None = None) -> str:
    """The capability of the RUNNING session.

    Honors `SAIPEN_CAPABILITY` (one of `CAPABILITIES`). An ABSENT declaration
    negotiates the default writable session, which is the documented
    behaviour a host that never heard of this variable relies on.

    A declaration that is PRESENT BUT INVALID is returned VERBATIM, so it fails
    every downstream `capability_error` / `may_mutate` / `may_publish` check.
    It used to be mapped to `full` alongside the absent case (CORE-004), which
    meant a typo, a corrupted value, an unsupported spelling or a broken host
    integration silently granted the STRONGEST capability -- and the closed-set
    validation two functions below could never fire, because negotiation had
    already laundered the input. The likely typos are the damning part:
    `readonly`, `read only` and `no_publish` are all attempts to RESTRICT the
    session, and every one of them used to publish.

    So the result is a member of `CAPABILITIES` only when the host declared one
    or declared nothing; callers must not assume it, which is exactly what
    `capability_error` is for.
    """
    source = os.environ if env is None else env
    raw = source.get(ENV_VAR)
    if raw is None:
        return DEFAULT_CAPABILITY
    declared = str(raw or "").strip().lower()
    if not declared:
        # An empty or whitespace-only value is an absent declaration: a shell
        # that exports the variable unset is not a host asking for anything.
        return DEFAULT_CAPABILITY
    return declared


def capability_error(capability: object) -> str | None:
    """Why `capability` is not a usable current-session capability, or None.

    Authorization sites use this so an unknown capability fails CLOSED instead
    of silently behaving like `full`.
    """
    if capability is None:
        return (
            "no current-session capability was negotiated; the public "
            "command boundary must inject one (CORE § 1.3)"
        )
    if not isinstance(capability, str) or capability not in CAPABILITIES:
        return (
            f"current-session capability {capability!r} is outside the "
            f"closed set {'/'.join(CAPABILITIES)}"
        )
    return None


def may_mutate(capability: object) -> bool:
    """True when the CURRENT session may perform local canonical writes."""
    return capability_error(capability) is None and capability != "read-only"


def may_publish(capability: object) -> bool:
    """True when the CURRENT session may publish (git push/tag)."""
    return capability_error(capability) is None and capability == "full"


def assert_producer_capability(
    action: str, *, producer: str | None = None
) -> tuple[bool, str, str]:
    """The hard producer capability boundary (spec §7).

    Returns ``(allowed, code, detail)``. A forbidden action returns
    ``(False, CAPABILITY_DENIED, <why>)`` and MUST cause ZERO canonical writes.
    An allowed producer action returns ``(True, "OK", "")``.

    This is a STRUCTURAL denial: it is independent of the host capability and of
    disk state. A producer session cannot grant itself Core authority by
    declaring a different capability -- the action namespace is what matters.
    """
    if action in PRODUCER_FORBIDDEN_ACTIONS:
        return (
            False,
            CAPABILITY_DENIED,
            f"producer {producer or '<unknown>'} may not perform {action!r}; "
            "that action is Core-owned and remains serialized through Core",
        )
    if action not in PRODUCER_ALLOWED_ACTIONS:
        return (
            False,
            CAPABILITY_DENIED,
            f"producer {producer or '<unknown>'} attempted unrecognized action "
            f"{action!r}; deny by default (fail closed)",
        )
    return True, "OK", ""


def guard_core_mutation(path: str | Path) -> tuple[bool, str]:
    """Refuse any producer write that would touch Core canonical truth.

    CORE-007: uses RESOLVED path comparison instead of fragile substring
    matching. Core truth lives in ``.saipen/STATE.md``, ``.saipen/BOARD.md``,
    ``.saipen/LOG.md`` and the ``.saipen/knowledge/`` tree. A producer
    namespace write must never resolve to those, regardless of path spelling.

    Returns ``(blocked, reason)``.
    """
    p = Path(path)
    # Resolve to canonical form so `.saipen/STATE.md`,
    # `./.saipen/STATE.md`, `/abs/path/.saipen/STATE.md` are all detected.
    try:
        resolved = p.resolve()
    except OSError:
        # If we cannot resolve, conservatively block -- the path is
        # untrustworthy and must not be written by a producer.
        return True, f"path {str(p)!r} cannot be resolved; blocked conservatively"
    # Core canonical markers (lowercased for case-insensitive comparison).
    # Match against the RESOLVED path components, not substring.
    try:
        parts = [part.lower() for part in resolved.parts]
    except Exception:
        return True, f"path {str(p)!r} cannot be decomposed; blocked conservatively"
    # Check for .saipen/<core-file> patterns
    for i, part in enumerate(parts):
        if part == ".saipen" and i + 1 < len(parts):
            next_part = parts[i + 1]
            if next_part in ("state.md", "board.md", "log.md"):
                return True, (
                    f"path {str(p)!r} resolves to Core canonical truth "
                    f"(.saipen/{next_part}); producers may not mutate it"
                )
            if next_part == "knowledge":
                return True, (
                    f"path {str(p)!r} resolves to Core KNOWLEDGE tree; producers may not mutate it"
                )
    return False, ""
