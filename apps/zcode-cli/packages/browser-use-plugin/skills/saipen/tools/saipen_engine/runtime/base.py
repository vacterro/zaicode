"""Wave-1 adaptive-runtime identity and capability model.

This module deliberately knows nothing about SAIPEN ownership, Work, routing,
or provider strategy.  ``--agent`` is supplied by the caller as the acting
seat; optional runtime metadata describes the harness/model operating that
seat.  Missing capability evidence is represented by ``None`` (UNKNOWN),
never promoted to ``False`` or guessed from an executable/model name.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any, Mapping

from ..paths import read_bound_regular_bytes

RUNTIME_INFO_SCHEMA_VERSION = 1
ENV_RUNTIME_INFO = "SAIPEN_RUNTIME_INFO"
MAX_RUNTIME_INFO_BYTES = 64 * 1024
MAX_IDENTITY_CHARS = 128

# Bounded operational facts, not personality traits.  A missing member is
# emitted as JSON null so UNKNOWN cannot silently become FALSE.
CAPABILITY_NAMES = (
    "shell",
    "filesystem",
    "patch",
    "browser",
    "web",
    "subagents",
    "parallel_subagents",
    "skills",
    "mcp",
    "structured_output",
    "persistent_session",
    "context_compaction",
    "reasoning_effort",
    "tool_search",
    "programmatic_tool_calling",
)

_IDENTITY_FIELDS = ("harness", "provider", "model", "variant")
_TOP_LEVEL_FIELDS = frozenset({"schema_version", *_IDENTITY_FIELDS, "capabilities"})
_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class RuntimeInfoError(ValueError):
    """Controlled refusal for untrusted runtime metadata."""


def _safe_identity(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise RuntimeInfoError(f"runtime-info field {field!r} must be a string or null")
    clean = value.strip()
    if not clean:
        raise RuntimeInfoError(f"runtime-info field {field!r} must not be empty")
    if len(clean) > MAX_IDENTITY_CHARS:
        raise RuntimeInfoError(
            f"runtime-info field {field!r} exceeds {MAX_IDENTITY_CHARS} characters"
        )
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in clean):
        raise RuntimeInfoError(f"runtime-info field {field!r} contains control characters")
    return clean


def _read_runtime_info(path: Path) -> dict[str, Any]:
    try:
        info = path.lstat()
    except OSError as exc:
        raise RuntimeInfoError(f"runtime-info is not readable: {path}: {exc}") from None
    attributes = getattr(info, "st_file_attributes", 0)
    if path.is_symlink() or attributes & _REPARSE_POINT or not stat.S_ISREG(info.st_mode):
        raise RuntimeInfoError(
            f"runtime-info must be a regular non-symlink/non-reparse file: {path}"
        )
    try:
        raw = read_bound_regular_bytes(path, info, max_bytes=MAX_RUNTIME_INFO_BYTES)
    except (OSError, ValueError) as exc:
        raise RuntimeInfoError(f"runtime-info cannot be read safely: {path}: {exc}") from None
    try:
        text = raw.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as exc:
        raise RuntimeInfoError(f"runtime-info is not valid UTF-8: {exc}") from None
    def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise RuntimeInfoError(f"runtime-info repeats JSON field {key!r}")
            result[key] = value
        return result

    def reject_constant(token: str) -> None:
        raise RuntimeInfoError(f"runtime-info contains non-JSON numeric constant {token!r}")

    try:
        document = json.loads(
            text, object_pairs_hook=unique_object, parse_constant=reject_constant
        )
    except json.JSONDecodeError as exc:
        raise RuntimeInfoError(
            f"runtime-info is malformed JSON at line {exc.lineno}, column {exc.colno}"
        ) from None
    if not isinstance(document, dict):
        raise RuntimeInfoError("runtime-info root must be a JSON object")
    return document


def _validate_document(document: Mapping[str, Any]) -> dict[str, Any]:
    unknown_fields = sorted(set(document) - _TOP_LEVEL_FIELDS)
    if unknown_fields:
        if "agent" in unknown_fields:
            raise RuntimeInfoError(
                "runtime-info must not define 'agent'; --agent/STATE owns the acting seat"
            )
        raise RuntimeInfoError(
            "runtime-info has unsupported field(s): " + ", ".join(unknown_fields)
        )

    schema = document.get("schema_version", RUNTIME_INFO_SCHEMA_VERSION)
    if type(schema) is not int or schema != RUNTIME_INFO_SCHEMA_VERSION:
        raise RuntimeInfoError(
            f"runtime-info schema_version must be {RUNTIME_INFO_SCHEMA_VERSION}, got {schema!r}"
        )

    capabilities_raw = document.get("capabilities", {})
    if not isinstance(capabilities_raw, dict):
        raise RuntimeInfoError("runtime-info 'capabilities' must be a JSON object")
    unknown_capabilities = sorted(set(capabilities_raw) - set(CAPABILITY_NAMES))
    if unknown_capabilities:
        raise RuntimeInfoError(
            "runtime-info has unsupported capability field(s): "
            + ", ".join(unknown_capabilities)
        )
    capabilities: dict[str, bool | None] = {}
    for name in CAPABILITY_NAMES:
        value = capabilities_raw.get(name)
        if value is not None and not isinstance(value, bool):
            raise RuntimeInfoError(f"runtime capability {name!r} must be true, false, or null")
        capabilities[name] = value

    result: dict[str, Any] = {
        "schema_version": RUNTIME_INFO_SCHEMA_VERSION,
        **{field: _safe_identity(document.get(field), field) for field in _IDENTITY_FIELDS},
        "capabilities": capabilities,
    }
    return result


def load_runtime_info(
    explicit_path: str | Path | None = None, *, env: Mapping[str, str] | None = None
) -> dict[str, Any]:
    """Load one runtime snapshot by explicit-first precedence.

    Precedence is ``explicit_path`` > ``SAIPEN_RUNTIME_INFO`` > UNKNOWN.  The
    environment value is a JSON file path, not inline JSON, which keeps shell
    quoting and size behavior deterministic.  No directory or file is created.
    """

    source_env = os.environ if env is None else env
    selected: str | Path | None = explicit_path
    source = "explicit_cli" if explicit_path is not None else "unknown"
    if selected is None:
        declared = str(source_env.get(ENV_RUNTIME_INFO, "") or "").strip()
        if declared:
            selected = declared
            source = "environment"
    if selected is None:
        empty = _validate_document({})
        return {**empty, "source": source, "present": False}
    raw_path = str(selected).strip()
    if not raw_path:
        raise RuntimeInfoError("runtime-info path must not be empty")
    parsed = _validate_document(_read_runtime_info(Path(raw_path)))
    return {**parsed, "source": source, "present": True}


def runtime_projection(
    agent: str,
    explicit_path: str | Path | None = None,
    *,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Return the portable read-only Wave-1 runtime projection.

    ``agent`` is copied from the ownership layer and is never derived from the
    runtime-info document.  Runtime metadata is telemetry only and is not
    persisted by this function.
    """

    seat = _safe_identity(agent, "agent")
    if seat is None:  # defensive: callers always have a seat
        raise RuntimeInfoError("acting agent seat is required")
    info = load_runtime_info(explicit_path, env=env)
    return {
        "agent": seat,
        "runtime_info_source": info["source"],
        "runtime_info_present": info["present"],
        "schema_version": info["schema_version"],
        "harness": info["harness"],
        "provider": info["provider"],
        "model": info["model"],
        "variant": info["variant"],
        "capabilities": info["capabilities"],
    }


# =========================================================== Wave 2 ========
#
# Wave 1 answered "WHAT is running" -- runtime identity and capabilities.
# Wave 2 answers "HOW should this piece of work be executed", and it answers it
# as an EXECUTABLE, deterministic decision rather than as prose.  The inputs are
# the WORK CLASS (which describes the work, never a vendor or a model) and the
# observed helper justification.  The output is one bounded decision: the
# selected strategy, WHY, the helper ceiling, the context-budget class, the
# capability facts the decision depends on, and every fact the harness could not
# establish -- reported UNKNOWN, never guessed.
#
# Nothing here is persisted.  The decision is a read-only projection over
# session telemetry, so canonical Work can never become provider-specific
# (saipen/RUNTIME.md).

#: Bounded WORK classes (Wave 2 § 1.1).  These describe the WORK, never a
#: vendor, a provider, a model, or a seat.
TASK_CLASSES = (
    "IMPLEMENT",
    "REPAIR",
    "VERIFY",
    "RESEARCH",
    "AUDIT",
    "MAINTENANCE",
)

#: Bounded execution strategies (Wave 2 § 1.2).  LONG_BUILD is the ordinary
#: default; the other three are reached only from a declared work class.
STRATEGIES = ("LONG_BUILD", "BOUNDED_RESEARCH", "VERIFY_ONLY", "RECOVERY")

DEFAULT_TASK_CLASS = "IMPLEMENT"
DEFAULT_STRATEGY = "LONG_BUILD"

#: A helper NEEDS a concrete, bounded reason, and the reason carries its own
#: ceiling.  "More agents might be faster" is deliberately ABSENT: it is not a
#: reason, so a caller who cannot name one of these gets ZERO helpers.  The
#: ceiling is a maximum, never a target.
HELPER_JUSTIFICATIONS = {
    "isolated-research": 1,
    "independent-verification": 1,
    "noisy-investigation": 1,
    "genuinely-parallel": 2,
}

#: Policy: a child never creates children (Wave 2 § 2.1).
MAX_SUBAGENT_DEPTH = 1

#: Honest enforcement fact.  The Wave-1 capability vocabulary exposes no
#: depth-control capability, so SAIPEN states the POLICY and reports the
#: ENFORCEMENT as UNKNOWN rather than claiming control it cannot exercise
#: (Wave 2 § 2.1 / § 10).
DEPTH_ENFORCEMENT = "UNKNOWN"

#: Context-budget classes as bounded byte ceilings.  The names mirror the
#: load-profile budgets in saipen/REGISTRY.json; this is the strategy view of
#: the SAME economy, not a second competing policy.
CONTEXT_BUDGET_CLASSES = {
    "MINIMAL": 20480,
    "BOUNDED": 30720,
    "ORDINARY": 40960,
    "RECOVERY": 56320,
}

#: A child packet is a bounded fraction of the parent budget; a helper never
#: inherits the accumulated parent transcript (Wave 2 § 2.3).
CHILD_PACKET_CEILINGS = {
    "MINIMAL": 8192,
    "BOUNDED": 12288,
    "ORDINARY": 16384,
    "RECOVERY": 8192,
}

#: The capability facts a strategy decision actually depends on.
STRATEGY_CAPABILITIES = (
    "subagents",
    "parallel_subagents",
    "skills",
    "structured_output",
    "context_compaction",
    "persistent_session",
)

#: Error text is diagnostic, so the caller's own input is echoed BOUNDED.
_MAX_ECHO = 80


class StrategyError(RuntimeInfoError):
    """Controlled refusal for an out-of-vocabulary work class or reason."""


def _bounded_echo(value: Any) -> str:
    text = value if isinstance(value, str) else repr(value)
    text = text.replace("\n", " ").replace("\r", " ")
    return text[:_MAX_ECHO]


def _clean_token(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise StrategyError(f"{field} must be a non-empty string")
    return value.strip().upper()


def select_strategy(
    task_class: str = DEFAULT_TASK_CLASS,
    *,
    helper_reason: str | None = None,
    control_plane: bool = False,
) -> dict[str, Any]:
    """The ONE deterministic strategy decision (Wave 2 § 1.2, § 1.3).

    ``task_class`` is bounded vocabulary; anything outside :data:`TASK_CLASSES`
    is REFUSED rather than coerced into the default, because a silently
    misclassified work class is how an implementation task acquires research
    helpers.  ``helper_reason`` is either ``None`` or one of
    :data:`HELPER_JUSTIFICATIONS`; an unnamed reason is refused, never ignored.
    ``control_plane`` marks a protocol/control-plane repair, which is RECOVERY
    and is never inferred from an ordinary repair (Wave 2 § 1.2).
    """
    work = _clean_token(task_class, "task_class")
    if work not in TASK_CLASSES:
        raise StrategyError(
            "task_class "
            + repr(_bounded_echo(task_class))
            + " is outside "
            + "|".join(TASK_CLASSES)
        )

    reason: str | None = None
    if helper_reason is not None:
        reason = _clean_token(helper_reason, "helper_reason").lower()
        if reason not in HELPER_JUSTIFICATIONS:
            raise StrategyError(
                "helper_reason "
                + repr(_bounded_echo(helper_reason))
                + " is not a declared justification; "
                "an unnamed reason buys no helper"
            )
    requested = HELPER_JUSTIFICATIONS.get(reason or "", 0)

    if work == "REPAIR" and control_plane:
        strategy = "RECOVERY"
        ceiling = 0
        budget = "RECOVERY"
        why = (
            "control-plane/protocol repair is RECOVERY, never ordinary feature "
            "implementation; the primary worker performs it directly"
        )
    elif work == "RESEARCH":
        strategy = "BOUNDED_RESEARCH"
        ceiling = 1
        budget = "MINIMAL"
        why = (
            "a narrow independent research question runs in one ephemeral scout "
            "with an isolated, bounded context packet"
        )
    elif work in ("VERIFY", "AUDIT"):
        strategy = "VERIFY_ONLY"
        ceiling = requested if reason == "independent-verification" else 0
        budget = "BOUNDED"
        why = (
            "verification/audit runs without implementation authority"
            + (
                "; one independent verifier is justified"
                if ceiling
                else "; no independent-verification reason was supplied"
            )
        )
    else:
        strategy = DEFAULT_STRATEGY
        ceiling = requested
        budget = "ORDINARY"
        why = (
            "ordinary implementation is LONG_BUILD: one primary worker, no "
            "reflexive subagents"
            + (
                "; a bounded helper is justified: " + str(reason)
                if reason
                else "; no helper justification was supplied, so helpers are 0"
            )
        )

    return {
        "task_class": work,
        "strategy": strategy,
        "why": why,
        "helper_justification": reason,
        "helper_ceiling": ceiling,
        "max_subagent_depth": MAX_SUBAGENT_DEPTH,
        "recursive_helpers": "DENIED_BY_POLICY",
        "depth_enforcement": DEPTH_ENFORCEMENT,
        "context_budget_class": budget,
        "context_budget_bytes": CONTEXT_BUDGET_CLASSES[budget],
        "child_packet_ceiling_bytes": CHILD_PACKET_CEILINGS[budget],
    }


def strategy_projection(
    *,
    task_class: str = DEFAULT_TASK_CLASS,
    helper_reason: str | None = None,
    control_plane: bool = False,
    capabilities: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The read-only Wave-2 decision together with the capability facts it
    depends on.

    A capability the harness does not report stays UNKNOWN rather than being
    read as FALSE.  The one place a capability changes the DECISION is
    ``subagents=false``: an explicit statement that no helper can run collapses
    the ceiling to zero, which is a fact, not a guess.  Nothing returned here is
    written to STATE, BOARD, LOG, a cache, or a handover.
    """
    decision = select_strategy(
        task_class, helper_reason=helper_reason, control_plane=control_plane
    )
    facts = {} if capabilities is None else dict(capabilities)
    relevant = {name: facts.get(name) for name in STRATEGY_CAPABILITIES}
    decision["capabilities"] = relevant
    decision["unknown_capabilities"] = [
        name for name, value in relevant.items() if value is None
    ]
    if relevant.get("subagents") is False and decision["helper_ceiling"]:
        decision["helper_ceiling"] = 0
        decision["why"] += (
            "; helper ceiling is 0 because the harness reports subagents=false"
        )
    return decision
