"""SAIPEN protocol intent handlers.

Protocol shortcuts (qq, ee, qqq, eee) are semantic operations, not CLI
aliases that cease to exist when one CLI dispatcher lacks a handler.

qq = ENSURE saiWiki READY
ee = ENSURE saiTranslate READY
qqq = consume one saiWiki READY package through its own Core ticket + ship
eee = consume one saiTranslate READY package through its own Core ticket + ship

Every public entry point resolves the CURRENT-SESSION capability ONCE at the
command boundary (CORE-001) and fails closed before any mutation. The
autonomous convergence loop never fabricates role evidence (CORE-003), never
destroys pending worker tickets (CORE-004), and under ``--dry-run`` executes
ZERO writers (CORE-002). Every crew planner action maps to exactly one
canonical operation or an intentional structured refusal -- never UNKNOWN_ACTION
(CORE-007).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def _negotiate_capability(project_root: Path) -> str:  # pragma: no cover - removed
    """Deprecated hard-coded resolver. Use capability.negotiate_capability."""
    raise RuntimeError(
        "intent._negotiate_capability is removed; resolve capability at the CLI "
        "boundary via saipen_engine.capability.negotiate_capability and thread it "
        "through every intent entry point (CORE-001)."
    )


def _agent_for(project_root: Path) -> str:
    from .state import parse_state

    state_path = project_root / ".saipen" / "STATE.md"
    try:
        state_text = state_path.read_text(encoding="utf-8-sig")
        state = parse_state(state_text)
        return state.get("agent", "saipen-autonomous")
    except Exception:
        return "saipen-autonomous"


def _resolve_saipen_home(root: Path) -> str:
    """Resolve the canonical saipen_home from STATE, falling back to root."""
    from .state import parse_state

    state_path = root / ".saipen" / "STATE.md"
    try:
        state = parse_state(state_path.read_text(encoding="utf-8-sig"))
        home = state.get("saipen_home", "")
        if home:
            return home
    except Exception:
        pass
    return str(root)


def _validated_prepare_context(root: Path) -> tuple[dict | None, dict | None]:
    """Resolve actor/home from one valid Core checkpoint before any write.

    Producer bootstrap is an ordinary mutation path, not project
    initialization.  Missing, non-canonical or semantically invalid persisted
    authority must therefore fail before spawn/sync can create partial state.
    """
    from . import codec
    from .fast_check import validate_project
    from .paths import parse_identity_content
    from .state import is_absolute_home, parse_state_or_error, persisted_home_error

    problem = codec.checkpoint_preflight(root)
    if problem is not None:
        return None, {"ok": False, "code": "VALIDATION_FAILED", "message": problem}
    try:
        state_doc = codec.read_checkpoint_doc(root, "STATE.md")
    except (OSError, codec.CheckpointLoadError) as exc:
        return None, {"ok": False, "code": "VALIDATION_FAILED", "message": str(exc)}
    state, state_error = parse_state_or_error(state_doc.text_norm)
    if state_error or state is None:
        return None, {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "message": f"state-malformed: {state_error or 'STATE is unavailable'}",
        }
    agent = state.get("agent")
    if not isinstance(agent, str) or not agent.strip():
        return None, {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "message": "STATE.agent must be a non-empty string before producer preparation",
        }
    home = state.get("saipen_home")
    if not isinstance(home, str) or not home.strip():
        return None, {
            "ok": False,
            "code": "HOME_REQUIRED",
            "message": "STATE.saipen_home is missing; producer preparation has no sync source",
        }
    if not is_absolute_home(home):
        return None, {
            "ok": False,
            "code": "HOME_REQUIRED",
            "message": f"STATE.saipen_home must be absolute, got {home!r}",
        }
    home_problem = persisted_home_error(home)
    if home_problem is not None:
        return None, {"ok": False, "code": "HOME_REQUIRED", "message": home_problem}
    identity_path = root / ".saipen/IDENTITY.md"
    if identity_path.exists():
        try:
            identity_text = identity_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            return None, {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "message": f"IDENTITY.md is unreadable: {exc}",
            }
        _lineage, identity_error = parse_identity_content(identity_text)
        if identity_error is not None:
            return None, {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "message": f"IDENTITY.md is malformed: {identity_error}",
            }
    validation_errors = validate_project(root, current_agent=agent)
    if validation_errors:
        return None, {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "message": "; ".join(validation_errors[:5]),
        }
    return {"state": state, "agent": agent, "saipen_home": home}, None


def _role_dir(root: Path, role: str) -> Path:
    """CORE-006: resolve a role's storage through the canonical registry.

    Producers (saitranslate / saiwiki) use ``producer_namespace``; generic subs
    use ``SUBS_REL``. No role-type-specific path guessing.
    """
    from . import producer as P
    from . import subs

    if role in P.PRODUCERS:
        return P.producer_namespace(root, role)
    return root / subs.SUBS_REL / role


def _norm(result) -> tuple[bool, str]:
    """Normalize a Result object or dict to (ok, code)."""
    if hasattr(result, "ok"):
        ok = bool(result.ok)
        code = getattr(result, "code", "") or ""
        return ok, (code if isinstance(code, str) else "")
    if isinstance(result, dict):
        return bool(result.get("ok", False)), result.get("code", "")
    return False, ""


def ensure_producer_ready(
    project_root: Path,
    role: str,
    dry_run: bool = False,
    as_json: bool = False,
    current_capability: object = None,
    current_agent: str | None = None,
) -> dict:
    """Force a fresh named-producer preparation.

    Existing READY packages are collectable handoff evidence, not authority to
    skip an explicit prepare. A no-op belongs here only after a deterministic
    cache contract proves equivalent regeneration against source head, source
    tree and role revision *and* freshly reruns producer verification. No such
    cache contract exists in the embedded engine today.

    CORE-001: the capability is negotiated at the CLI boundary and threaded in;
    a read-only session refuses any mutation. CORE-006: role storage is resolved
    through the canonical registry and ``sub_spawn`` receives the full contract.
    """
    from .capability import capability_error, may_mutate, negotiate_capability
    from . import subs

    root = Path(project_root)
    capability = negotiate_capability() if current_capability is None else current_capability
    err = capability_error(capability)
    if err is not None:
        return {"ok": False, "code": "CAPABILITY_INVALID", "message": err}
    if not dry_run and not may_mutate(capability):
        return {
            "ok": False,
            "code": "CAPABILITY_READ_ONLY",
            "message": f"read-only session cannot prepare {role}",
        }

    context, context_error = _validated_prepare_context(root)
    if context_error is not None:
        return context_error
    assert context is not None
    # CORE-007: the CURRENT-SESSION agent is the CLI-resolved actor, not the
    # persisted STATE.agent. Thread it through every mutating operation so the
    # operations-layer folded handover can atomically record A->B.
    agent = current_agent if current_agent is not None else context["agent"]
    saipen_home = context["saipen_home"]

    role_dir = _role_dir(root, role)

    # 1. Instance exists?
    if not role_dir.is_dir():
        if dry_run:
            return {
                "ok": True,
                "code": "PRODUCER_SPAWN_PLAN",
                "message": f"would spawn {role} instance",
            }
        if not may_mutate(capability):
            return {
                "ok": False,
                "code": "CAPABILITY_READ_ONLY",
                "message": f"read-only session cannot spawn {role}",
            }
        result = subs.sub_spawn(root, role, saipen_home, agent=agent, dry_run=False)
        ok, code = _norm(result)
        if not ok:
            return {
                "ok": False,
                "code": "PRODUCER_SPAWN_FAILED",
                "message": f"failed to spawn {role} instance",
                "detail": code,
            }

    # 2. Sync shared contract (only when actually mutating).
    if not dry_run and may_mutate(capability):
        sync_result = subs.sub_sync(root, saipen_home, agent=agent, dry_run=False)
        ok, code = _norm(sync_result)
        if not ok:
            return {
                "ok": False,
                "code": "PRODUCER_SYNC_FAILED",
                "message": f"failed to sync {role}",
                "detail": code,
            }

    # 3. Explicit named preparation is FORCE-FRESH. Merely finding READY --
    # even with a matching source_head/tree/role tuple -- proves neither
    # equivalent regeneration nor a fresh verification run. READY validation
    # remains the collect path's job; prepare always reaches the real runner.
    if dry_run:
        return {"ok": True, "code": "PREPARE_PLAN", "message": f"would prepare {role}"}
    if not may_mutate(capability):
        return {
            "ok": False,
            "code": "CAPABILITY_READ_ONLY",
            "message": f"read-only session cannot prepare {role}",
        }
    return _prepare_role(root, role, capability)


def _prepare_producer_role(root: Path, role: str) -> dict:
    """Refuse unless a canonical role runner has actually executed.

    This engine has no embedded translation/wiki model runner.  Treating an
    existing OUTBOX as a fresh run would be evidence fabrication, so the only
    truthful autonomous result is ROLE_NOT_RUN. External runners publish via
    StagingGeneration; collect may consume that READY evidence, while another
    explicit prepare still requests a fresh run.

    AUTO-001/AUTO-004: the carrier is a ROUTING instruction, not a terminal
    refusal. ``terminal=False`` + ``execute_in_current_agent=True`` tells the
    agent it IS the runner and must adopt the role NOW.
    """
    return {
        "ok": False,
        "code": "ROLE_NOT_RUN",
        "terminal": False,
        "requires_human": False,
        "execute_in_current_agent": True,
        "next_action": "RUN_ROLE",
        "role": role,
        "resume_after": f"ensure_producer_ready:{role}",
        "message": (
            f"AGENT-EXECUTED ROLE: no dedicated code runner exists for {role}. "
            "The CURRENT AGENT must adopt the role and execute its "
            "role instructions now. This is NOT a human task and does "
            "NOT require another agent."
        ),
    }


def _prepare_role(root: Path, role: str, current_capability: object = None) -> dict:
    """Prepare a role for the autonomous loop.

    CORE-003: this MUST NOT fabricate a ``verified: PASS`` OUTBOX block. Producer
    roles run the REAL producer pipeline; every other role consumes only the
    evidence its runner actually emitted, or refuses cleanly.
    """
    from . import producer as P

    if role in P.PRODUCERS:
        return _prepare_producer_role(root, role)

    return {
        "ok": False,
        "code": "ROLE_NOT_RUN",
        "terminal": False,
        "requires_human": False,
        "execute_in_current_agent": True,
        "next_action": "RUN_ROLE",
        "role": role,
        "resume_after": f"ensure_producer_ready:{role}",
        "message": (
            f"AGENT-EXECUTED ROLE: {role} has not emitted preparation evidence. "
            "The CURRENT AGENT must adopt the role and execute its "
            "role instructions now. Autonomous intent refuses to "
            "synthesize a package."
        ),
    }


def _active_crew_epoch_id(root: Path) -> str:
    """Return the active durable epoch, or empty only when no carrier exists.

    A present malformed carrier raises: callers must convert that into a
    zero-write refusal, never erase the authority edge by integrating with an
    empty epoch string.
    """
    from .crew import read_durable_crew_epoch

    epoch_data = read_durable_crew_epoch(root)
    return "" if epoch_data is None else epoch_data["op_id"]


def _integrate_producer(root: Path, producer_role: str, agent: str = "saipen-core") -> dict:
    """Serialize Core integration of a producer's READY packages.

    Delegates to the canonical producer integration path. Without a Core
    apply_write callback the pipeline returns a structured REFUSED (never a
    fabricated success) -- Core integration is a deliberate Core-owned mutation.
    """
    from . import producer as P

    ns = P.producer_namespace(root, producer_role)
    pkgs, errors = P.StagingGeneration.scan_ready(ns)
    if errors:
        return {
            "ok": False,
            "code": "INVALID_READY",
            "message": f"corrupt READY evidence for {producer_role}",
            "errors": errors,
        }
    if not pkgs:
        return {
            "ok": False,
            "code": "NO_READY_PACKAGE",
            "message": f"no READY {producer_role} package to integrate",
        }
    try:
        crew_epoch = _active_crew_epoch_id(root)
    except ValueError as exc:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "message": f"durable crew epoch is corrupt: {exc}",
        }
    result = P.integrate_packages_core(
        pkgs,
        root,
        dry_run=False,
        agent=agent,
        crew_epoch=crew_epoch,
    )
    integrated = [item for item in result.get("results", []) if item.get("result") == "INTEGRATED"]
    if not integrated:
        first = (result.get("results") or [{}])[0]
        return {
            "ok": False,
            "code": first.get("code", "INTEGRATION_FAILED"),
            "message": first.get("reason", "producer integration failed"),
            "results": result.get("results", []),
        }
    return {"ok": True, "code": "PRODUCER_INTEGRATED", **result}


def collect_and_ship_producer(
    project_root: Path,
    role: str,
    *,
    dry_run: bool = False,
    current_capability: object = None,
    current_agent: str | None = None,
) -> dict:
    """Targeted qqq/eee flow: READY -> Core ticket gates -> ticket ship.

    It never enters the general crew loop and therefore cannot run, collect or
    mutate an unrelated role. Absence is the protocol's intentional no-op.

    The first call consumes READY into a freshly claimed Core ticket and stops
    at VERIFY: semantic verification and independent review cannot be
    fabricated by automation. Once that same ticket reaches SHIP, a resumed
    shortcut uses its reviewed scope directly, even if a crew convergence
    intent is persisted around it.
    """
    from . import producer as P
    from . import subs
    from .capability import capability_error, may_mutate, negotiate_capability

    root = Path(project_root)
    capability = negotiate_capability() if current_capability is None else current_capability
    err = capability_error(capability)
    if err is not None:
        return {"ok": False, "code": "CAPABILITY_INVALID", "message": err}
    if role not in P.PRODUCERS:
        return {"ok": False, "code": "INVALID_ROLE", "message": role}

    try:
        continuation = _targeted_producer_release_context(root, role)
    except Exception as exc:
        # CORE-004: surface semantic corruption as fail-closed refusal, not
        # negative evidence (empty continuation)
        from .journal import SemanticReceiptCorruptionError

        if isinstance(exc, SemanticReceiptCorruptionError):
            return {
                "ok": False,
                "code": "CORRUPT_JOURNAL",
                "recovery_required": True,
                "message": f"semantic receipt snapshot is corrupt: {'; '.join(exc.errors[:2])}",
                "role": role,
            }
        raise
    if continuation is not None:
        if dry_run:
            return {
                "ok": True,
                "code": "PRODUCER_COLLECT_SHIP_PLAN",
                "message": f"would ship reviewed {role} ticket scope",
                "role": role,
                **continuation,
                "actions": ["SHIP_REVIEWED_TICKET"],
            }
        if not may_mutate(capability):
            return {
                "ok": False,
                "code": "CAPABILITY_READ_ONLY",
                "message": f"read-only session cannot ship {role}",
            }
        return _ship_targeted_producer(root, role, continuation, capability)

    # PERF-002: metadata-only scan; the single winner is materialized below.
    packages, errors = P.StagingGeneration.scan_ready(
        P.producer_namespace(root, role), materialize_payloads=False
    )
    if errors:
        prepare = "qq" if role == "saiwiki" else "ee"
        # AUTO-006: NOT_READY is a ROUTING carrier, not a terminal failure.
        # The current agent must follow the dependency chain: run the prepare
        # command NOW, then resume this collect-and-ship flow -- never report
        # and stop, never bounce the work to a human or another agent.
        return {
            "ok": True,
            "code": "NOT_READY",
            "terminal": False,
            "requires_human": False,
            "execute_in_current_agent": True,
            "next_action": prepare,
            "role": role,
            "resume_after": f"collect_and_ship_producer:{role}",
            "message": f"Not ready: run {prepare} first.",
            "errors": errors,
        }
    try:
        from freshness import compute_source_identity

        source_id = compute_source_identity(root)
        role_revision = subs.current_local_role_revision(root, role)
    except Exception as exc:
        return {"ok": False, "code": "SOURCE_IDENTITY_UNKNOWN", "message": str(exc)}
    current = [
        package
        for package in packages
        if package.base_source_head == source_id.source_head
        and package.base_source_tree_fingerprint == source_id.source_tree_fingerprint
        and package.role_revision == role_revision
    ]
    if not current:
        prepare = "qq" if role == "saiwiki" else "ee"
        return {
            "ok": True,
            "code": "NOT_READY",
            "terminal": False,
            "requires_human": False,
            "execute_in_current_agent": True,
            "next_action": prepare,
            "role": role,
            "resume_after": f"collect_and_ship_producer:{role}",
            "message": f"Not ready: run {prepare} first.",
        }
    package = max(current, key=lambda item: (item.epoch, item.package_identity))
    # PERF-002: re-open only the winner; retain decoded bytes for this one.
    if not package.materialize_payload():
        return {
            "ok": False,
            "code": "INVALID_READY",
            "message": (
                f"READY payload for {role} package {package.package_identity} "
                "could not be re-materialized; refusing integration"
            ),
            "role": role,
            "package_identity": package.package_identity,
        }
    try:
        crew_epoch = _active_crew_epoch_id(root)
    except ValueError as exc:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "message": f"durable crew epoch is corrupt: {exc}",
            "role": role,
            "package_identity": package.package_identity,
        }
    active_ticket = _active_core_ticket(root)
    # W2-003 / CORE-005: an active ticket that is OUR OWN interrupted targeted carrier
    # resumes instead of colliding with generic ALREADY_CLAIMED. Also handle the
    # TODO/SCOUT boundary where STATE has no active ticket yet but BOARD holds the
    # durably created TODO carrier.
    if active_ticket is not None:
        interrupted = _targeted_producer_active_ticket(root, role, package.package_identity)
        if interrupted is not None:
            if interrupted.get("invalid"):
                return {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "recovery_required": True,
                    "message": interrupted.get("detail", "invalid checkpoint authority"),
                    "role": role,
                    "package_identity": package.package_identity,
                }
            if interrupted.get("ambiguous"):
                return {
                    "ok": False,
                    "code": "CORRUPT_JOURNAL",
                    "recovery_required": True,
                    "message": (
                        f"ambiguous targeted carrier for {role} "
                        f"{package.package_identity}: multiple matching tickets -- fail closed"
                    ),
                    "role": role,
                    "package_identity": package.package_identity,
                }
            if dry_run:
                return {
                    "ok": True,
                    "code": "PRODUCER_RESUME_PLAN",
                    "message": (
                        f"would resume interrupted {role} targeted flow for {interrupted['ticket']}"
                    ),
                    "role": role,
                    "ticket": interrupted["ticket"],
                    "package_identity": package.package_identity,
                    "actions": ["RESUME_TARGETED_PRODUCER"],
                }
            if not may_mutate(capability):
                return {
                    "ok": False,
                    "code": "CAPABILITY_READ_ONLY",
                    "message": f"read-only session cannot resume {role} targeted integration",
                    "role": role,
                    "ticket": interrupted["ticket"],
                }
            return _resume_targeted_producer(
                root, role, interrupted, capability, current_agent=current_agent
            )
        return {
            "ok": False,
            "code": "ALREADY_CLAIMED",
            "terminal": False,
            "requires_human": False,
            "execute_in_current_agent": True,
            "next_action": "CONTINUE_CORE",
            "role": role,
            "ticket": active_ticket,
            "resume_after": f"collect_and_ship_producer:{role}",
            "message": (f"active Core ticket {active_ticket} must finish before collecting {role}"),
            "package_identity": package.package_identity,
        }
    # No active ticket: check for an existing TODO/SCOUT carrier left by a crash
    # after ticket_add or apply_claim. This makes the flow restart-idempotent
    # across the first two durable boundaries.
    existing = _targeted_producer_active_ticket(root, role, package.package_identity)
    if existing is not None:
        if existing.get("invalid"):
            return {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "recovery_required": True,
                "message": existing.get("detail", "invalid checkpoint authority"),
                "role": role,
                "package_identity": package.package_identity,
            }
        if existing.get("ambiguous"):
            return {
                "ok": False,
                "code": "CORRUPT_JOURNAL",
                "recovery_required": True,
                "message": (
                    f"ambiguous targeted carrier for {role} "
                    f"{package.package_identity}: multiple matching tickets -- fail closed"
                ),
                "role": role,
                "package_identity": package.package_identity,
            }
        if dry_run:
            return {
                "ok": True,
                "code": "PRODUCER_RESUME_PLAN",
                "message": (
                    f"would resume interrupted {role} targeted flow for {existing['ticket']}"
                ),
                "role": role,
                "ticket": existing["ticket"],
                "package_identity": package.package_identity,
                "actions": ["RESUME_TARGETED_PRODUCER"],
            }
        if not may_mutate(capability):
            return {
                "ok": False,
                "code": "CAPABILITY_READ_ONLY",
                "message": f"read-only session cannot resume {role} targeted integration",
                "role": role,
                "ticket": existing["ticket"],
            }
        return _resume_targeted_producer(
            root, role, existing, capability, current_agent=current_agent
        )
    if dry_run:
        return {
            "ok": True,
            "code": "PRODUCER_COLLECT_SHIP_PLAN",
            "message": f"would integrate and ship current {role} package",
            "role": role,
            "package_identity": package.package_identity,
            "actions": [
                "CREATE_CORE_TICKET",
                "INTEGRATE_PRODUCER",
                "VERIFY",
                "REVIEW",
                "SHIP_REVIEWED_TICKET",
            ],
        }
    if not may_mutate(capability):
        return {
            "ok": False,
            "code": "CAPABILITY_READ_ONLY",
            "message": f"read-only session cannot integrate/ship {role}",
        }

    from .operations import apply_claim, ticket_add, transition_phase

    agent = current_agent if current_agent is not None else _agent_for(root)
    added = ticket_add(
        root,
        agent,
        "P1",
        f"Integrate and release {role} package {package.package_identity}",
        [],
        (
            "Authenticated payload hashes and producer collect gate pass; "
            "reviewed scope contains the package targets; targeted ship uses "
            "this ticket instead of a general crew carrier"
        ),
    )
    added_ok, added_code = _norm(added)
    if not added_ok:
        return {
            "ok": False,
            "code": added_code or "VALIDATION_FAILED",
            "message": added.get("message", "could not create producer Core ticket"),
        }
    ticket_id = added.get("ticket", "")
    claimed = apply_claim(root, ticket_id, agent)
    claimed_ok, claimed_code = _norm(claimed)
    if not claimed_ok:
        return {
            "ok": False,
            "code": claimed_code or "VALIDATION_FAILED",
            "message": claimed.get("message", "could not claim producer Core ticket"),
            "ticket": ticket_id,
        }
    built = transition_phase(
        root,
        "BUILD",
        agent,
        ticket_id,
        f"Apply authenticated {role} package {package.package_identity}",
    )
    built_ok, built_code = _norm(built)
    if not built_ok:
        return {
            "ok": False,
            "code": built_code or "VALIDATION_FAILED",
            "message": built.get("message", "could not enter BUILD"),
            "ticket": ticket_id,
        }

    try:
        current_crew_epoch = _active_crew_epoch_id(root)
    except ValueError as exc:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "message": f"durable crew epoch became corrupt before integration: {exc}",
            "ticket": ticket_id,
        }
    if current_crew_epoch != crew_epoch:
        return {
            "ok": False,
            "code": "STALE_STATE",
            "message": "durable crew epoch changed before producer integration",
            "ticket": ticket_id,
        }

    integrated = P.integrate_packages_core(
        [package],
        root,
        dry_run=False,
        agent=agent,
        crew_epoch=crew_epoch,
        ticket_id=ticket_id,
    )
    item = (integrated.get("results") or [{}])[0]
    if item.get("result") != "INTEGRATED":
        return {
            "ok": False,
            "code": item.get("code", "INTEGRATION_FAILED"),
            "message": item.get("reason", "producer integration failed"),
            "integration": integrated,
            "ticket": ticket_id,
        }
    verifying = transition_phase(
        root,
        "VERIFY",
        agent,
        ticket_id,
        f"Verify {role} package payload and exact release scope",
    )
    verifying_ok, verifying_code = _norm(verifying)
    if not verifying_ok:
        return {
            "ok": False,
            "code": verifying_code or "VALIDATION_FAILED",
            "message": verifying.get("message", "could not enter VERIFY"),
            "integration": integrated,
            "ticket": ticket_id,
        }
    return {
        "ok": True,
        "code": "PRODUCER_REVIEW_REQUIRED",
        "message": f"{role} integrated; verify and review {ticket_id}, then resume shortcut",
        "role": role,
        "ticket": ticket_id,
        "package_identity": package.package_identity,
        "integration": integrated,
    }


def _targeted_producer_release_context(root: Path, role: str) -> dict | None:
    """Return the active SHIP ticket bound to a committed role integration."""
    from .journal import SemanticReceiptCorruptionError, semantic_receipts_for_operation
    from .state import parse_state

    try:
        state = parse_state((root / ".saipen" / "STATE.md").read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, ValueError):
        return None
    ticket_id = state.get("task", "")
    if state.get("phase") != "SHIP" or not str(ticket_id).startswith("T-"):
        return None
    matches = []
    try:
        receipts = semantic_receipts_for_operation(root, "producer_integration")
    except SemanticReceiptCorruptionError:
        # CORE-004: corruption is not negative evidence; surface as refusal
        # via sentinel that collect_and_ship will translate to CORRUPT_JOURNAL
        raise
    for receipt in receipts:
        metadata = receipt.get("receipt_metadata") or {}
        if receipt.get("status") != "COMMITTED":
            continue
        if metadata.get("producer") != role or metadata.get("ticket_id") != ticket_id:
            continue
        matches.append((receipt.get("created_at", ""), receipt.get("op_id", ""), metadata))
    if not matches:
        return None
    # W2-005: canonical UTC ordering with op_id tie-break. Raw-string max
    # misorders `...00Z` above `...00.900000Z`.
    from .board import iso_utc_sort_key

    _earliest = iso_utc_sort_key("0000-01-01T00:00:00Z")
    _created, op_id, metadata = max(
        matches, key=lambda m: (iso_utc_sort_key(m[0]) or _earliest, m[1])
    )
    return {
        "ticket": ticket_id,
        "package_identity": metadata.get("package_identity", ""),
        "integration_op_id": op_id,
    }


def _active_core_ticket(root: Path) -> str | None:
    """Return a ticket-bearing STATE task without interpreting prose."""
    from . import phases
    from .state import parse_state

    try:
        state = parse_state((root / ".saipen" / "STATE.md").read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, ValueError):
        return None
    ticket_id = state.get("task", "")
    if state.get("phase") in phases.TICKET_BEARING_PHASES and str(ticket_id).startswith("T-"):
        return str(ticket_id)
    return None


def _find_targeted_carriers(root: Path, role: str, package_identity: str) -> list[dict]:
    """CORE-005: scan BOARD for all tickets matching the targeted producer marker.

    Returns list of carrier dicts with ticket, section, description. Used to
    detect exactly one interrupted carrier across TODO/SCOUT/BUILD/VERIFY and
    to fail closed on ambiguity (more than one matching carrier).
    """
    from .board import parse_board

    board_path = root / ".saipen" / "BOARD.md"
    try:
        board = parse_board(board_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise ValueError(f"BOARD authority is unreadable: {exc}") from exc
    if board["errors"]:
        raise ValueError("BOARD parse error(s): " + "; ".join(board["errors"][:3]))
    marker = f"Integrate and release {role} package {package_identity}"
    out = []
    for tid, ticket in board["tickets"].items():
        desc = str(ticket.get("description") or "")
        if marker not in desc:
            continue
        out.append(
            {
                "ticket": tid,
                "section": ticket.get("section"),
                "raw": ticket.get("raw"),
                "description": desc,
            }
        )
    return out


def _targeted_producer_active_ticket(root: Path, role: str, package_identity: str) -> dict | None:
    """W2-003 / CORE-005: recognize our own interrupted targeted carrier across
    TODO, SCOUT, BUILD, VERIFY.

    The targeted qqq/eee flow is three durable steps: ticket_add (TODO),
    apply_claim (SCOUT), transition BUILD. A crash after any step must be
    recognized on retry and the same T-ID reused. If more than one matching
    carrier exists, return an ambiguous sentinel that the caller converts to
    a fail-closed refusal.
    """
    from .state import parse_state_or_error

    state_path = root / ".saipen" / "STATE.md"
    board_path = root / ".saipen" / "BOARD.md"
    if not state_path.exists() and not board_path.exists():
        return None

    try:
        carriers = _find_targeted_carriers(root, role, package_identity)
    except ValueError as exc:
        return {
            "invalid": True,
            "detail": str(exc),
            "role": role,
            "package_identity": package_identity,
        }
    if len(carriers) > 1:
        # Ambiguous: more than one matching carrier
        return {
            "ticket": carriers[0]["ticket"],
            "ambiguous": True,
            "carriers": carriers,
            "role": role,
            "package_identity": package_identity,
        }
    # STATE is required even for the TODO crash window. A malformed checkpoint
    # is never permission to promote BOARD prose into mutation authority.
    try:
        state_text = state_path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        return {
            "invalid": True,
            "detail": f"STATE authority is unreadable: {exc}",
            "role": role,
            "package_identity": package_identity,
        }
    state, state_error = parse_state_or_error(state_text)
    if state_error is not None or state is None:
        return {
            "invalid": True,
            "detail": f"STATE authority is malformed: {state_error}",
            "role": role,
            "package_identity": package_identity,
        }
    if not carriers:
        return None
    carrier = carriers[0]
    ticket_id = carrier["ticket"]
    phase = state.get("phase")
    task = state.get("task")
    section = carrier.get("section")
    if section == "## TODO":
        if task not in (None, "", "none"):
            return {
                "invalid": True,
                "detail": f"TODO carrier {ticket_id} conflicts with STATE.task={task}",
                "role": role,
                "package_identity": package_identity,
            }
        phase = None
    elif section == "## DOING":
        if task != ticket_id or phase not in ("SCOUT", "BUILD", "VERIFY"):
            return {
                "invalid": True,
                "detail": (
                    f"DOING carrier {ticket_id} is incoherent with "
                    f"STATE.task={task!r}/phase={phase!r}"
                ),
                "role": role,
                "package_identity": package_identity,
            }
    else:
        return {
            "invalid": True,
            "detail": f"targeted carrier {ticket_id} is in illegal section {section!r}",
            "role": role,
            "package_identity": package_identity,
        }
    return {
        "ticket": ticket_id,
        "phase": phase,
        "section": section,
        "package_identity": package_identity,
        "role": role,
    }


def _resume_targeted_producer(
    root: Path, role: str, context: dict, capability: object, current_agent: str | None = None
) -> dict:
    """W2-003: resume an interrupted targeted producer flow at its next safe boundary.

    A committed producer-integration receipt is the idempotence authority: if
    one exists for this ticket/package, advance toward release without
    reapplying bytes. Otherwise revalidate package authenticity, source
    identity and the current crew epoch, then resume from BUILD/VERIFY.
    """
    from . import producer as P
    from . import subs
    from .capability import may_mutate

    ticket_id = context["ticket"]
    phase = context["phase"]
    package_identity = context["package_identity"]
    live_context = _targeted_producer_active_ticket(root, role, package_identity)
    if (
        live_context is None
        or live_context.get("invalid")
        or live_context.get("ambiguous")
        or live_context.get("ticket") != ticket_id
    ):
        detail = (
            live_context.get("detail", "targeted carrier is absent or ambiguous")
            if live_context
            else "targeted carrier is absent"
        )
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "recovery_required": True,
            "message": f"targeted checkpoint authority refused: {detail}",
            "role": role,
            "ticket": ticket_id,
        }
    phase = live_context.get("phase")
    context = live_context

    # 1. Committed integration receipt for this ticket -> idempotence authority.
    from .journal import SemanticReceiptCorruptionError, semantic_receipts_for_operation

    bound = None
    try:
        receipts = semantic_receipts_for_operation(root, "producer_integration")
    except SemanticReceiptCorruptionError as exc:
        return {
            "ok": False,
            "code": "CORRUPT_JOURNAL",
            "recovery_required": True,
            "message": f"semantic receipt snapshot is corrupt: {'; '.join(exc.errors[:2])}",
            "role": role,
            "ticket": ticket_id,
        }
    for receipt in receipts:
        metadata = receipt.get("receipt_metadata") or {}
        if receipt.get("status") != "COMMITTED":
            continue
        if metadata.get("producer") == role and metadata.get("ticket_id") == ticket_id:
            bound = receipt
            break
    if bound is not None:
        # Already integrated: resume the shortcut through VERIFY/REVIEW/SHIP.
        metadata = bound.get("receipt_metadata") or {}
        from .operations import apply_claim, transition_phase

        agent = current_agent if current_agent is not None else _agent_for(root)
        section = context.get("section")
        if section == "## TODO":
            claimed = apply_claim(root, ticket_id, agent)
            if not claimed.ok:
                return {
                    "ok": False,
                    "code": claimed.code,
                    "message": claimed.message,
                    "role": role,
                    "ticket": ticket_id,
                    "package_identity": package_identity,
                }
            phase = "SCOUT"
            section = "## DOING"
        if phase == "SCOUT":
            built = transition_phase(
                root,
                "BUILD",
                agent,
                ticket_id,
                f"Apply authenticated {role} package {package_identity}",
            )
            if not built.ok:
                return {
                    "ok": False,
                    "code": built.code,
                    "message": built.message,
                    "role": role,
                    "ticket": ticket_id,
                    "package_identity": package_identity,
                }
            phase = "BUILD"
        if phase == "BUILD":
            verifying = transition_phase(
                root,
                "VERIFY",
                agent,
                ticket_id,
                f"Verify {role} package payload and exact release scope",
            )
            if not verifying.ok:
                return {
                    "ok": False,
                    "code": verifying.code,
                    "message": verifying.message,
                    "role": role,
                    "ticket": ticket_id,
                    "package_identity": package_identity,
                }
            phase = "VERIFY"
        if phase in ("VERIFY", "REVIEW"):
            # Resume through the normal ticket chain; the caller continues.
            return {
                "ok": True,
                "code": "PRODUCER_REVIEW_REQUIRED",
                "message": (
                    f"{role} integrated (resumed); verify and review "
                    f"{ticket_id}, then resume shortcut"
                ),
                "role": role,
                "ticket": ticket_id,
                "package_identity": package_identity,
                "resume_after": f"collect_and_ship_producer:{role}",
            }
        return {
            "ok": True,
            "code": "PRODUCER_RESUMED",
            "message": f"{role} targeted flow resumed at {phase} for {ticket_id}",
            "role": role,
            "ticket": ticket_id,
            "package_identity": package_identity,
        }

    # 2. No committed receipt -> the interrupted window was before integration.
    if not may_mutate(capability):
        return {
            "ok": False,
            "code": "CAPABILITY_READ_ONLY",
            "message": f"read-only session cannot resume {role} targeted integration",
            "role": role,
            "ticket": ticket_id,
        }
    # Revalidate the package is still READY and current.
    try:
        from freshness import compute_source_identity

        source_id = compute_source_identity(root)
        role_revision = subs.current_local_role_revision(root, role)
    except Exception as exc:
        return {
            "ok": False,
            "code": "SOURCE_IDENTITY_UNKNOWN",
            "message": str(exc),
            "role": role,
            "ticket": ticket_id,
        }
    # PERF-002: metadata-only scan; the matched package is materialized below.
    packages, errors = P.StagingGeneration.scan_ready(
        P.producer_namespace(root, role), materialize_payloads=False
    )
    if errors:
        return {
            "ok": False,
            "code": "INVALID_READY",
            "message": f"corrupt READY evidence for {role}; cannot resume",
            "errors": errors,
            "role": role,
            "ticket": ticket_id,
        }
    match = [p for p in packages if p.package_identity == package_identity]
    if not match:
        return {
            "ok": False,
            "code": "STALE_PACKAGE",
            "terminal": False,
            "requires_human": False,
            "execute_in_current_agent": True,
            "next_action": "RUN_ROLE",
            "role": role,
            "ticket": ticket_id,
            "resume_after": f"collect_and_ship_producer:{role}",
            "message": (
                f"{role} package {package_identity} is no longer READY; the "
                "producer must regenerate it. The CURRENT AGENT adopts the "
                "role and regenerates it now."
            ),
        }
    pkg = match[0]
    current = (
        pkg.base_source_head == source_id.source_head
        and pkg.base_source_tree_fingerprint == source_id.source_tree_fingerprint
        and pkg.role_revision == role_revision
    )
    if not current:
        return {
            "ok": False,
            "code": "STALE_PACKAGE",
            "terminal": False,
            "requires_human": False,
            "execute_in_current_agent": True,
            "next_action": "RUN_ROLE",
            "role": role,
            "ticket": ticket_id,
            "resume_after": f"collect_and_ship_producer:{role}",
            "message": (
                f"{role} package {package_identity} is stale against the "
                "current source; the producer must regenerate it. The CURRENT "
                "AGENT adopts the role and regenerates it now."
            ),
        }
    # PERF-002: re-open only the matched winner; retain decoded bytes for it.
    if not pkg.materialize_payload():
        return {
            "ok": False,
            "code": "INVALID_READY",
            "message": (
                f"READY payload for {role} package {pkg.package_identity} "
                "could not be re-materialized; refusing resume integration"
            ),
            "role": role,
            "ticket": ticket_id,
            "package_identity": pkg.package_identity,
        }
    try:
        crew_epoch = _active_crew_epoch_id(root)
    except ValueError as exc:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "message": f"durable crew epoch is corrupt: {exc}",
            "role": role,
            "ticket": ticket_id,
        }
    from .operations import apply_claim, transition_phase

    agent = current_agent if current_agent is not None else _agent_for(root)
    # CORE-005: bring TODO/SCOUT carriers to BUILD before integration
    section = context.get("section")
    # If still TODO, claim it
    if section == "## TODO":
        claimed = apply_claim(root, ticket_id, agent)
        if not claimed.ok:
            return {
                "ok": False,
                "code": claimed.code,
                "message": claimed.message,
                "role": role,
                "ticket": ticket_id,
            }
        phase = "SCOUT"
        section = "## DOING"
    if phase == "SCOUT" or (section == "## TODO" and phase is None):
        # Also handle SCOUT -> BUILD
        if phase == "SCOUT" or section == "## DOING":
            built = transition_phase(
                root,
                "BUILD",
                agent,
                ticket_id,
                f"Apply authenticated {role} package {package_identity}",
            )
            if not built.ok:
                return {
                    "ok": False,
                    "code": built.code,
                    "message": built.message,
                    "role": role,
                    "ticket": ticket_id,
                }
            phase = "BUILD"
    # Resume the integration window from BUILD (the interrupted ticket's phase).
    integrated = P.integrate_packages_core(
        [pkg],
        root,
        dry_run=False,
        agent=agent,
        crew_epoch=crew_epoch,
        ticket_id=ticket_id,
    )
    item = (integrated.get("results") or [{}])[0]
    if item.get("result") != "INTEGRATED":
        return {
            "ok": False,
            "code": item.get("code", "INTEGRATION_FAILED"),
            "message": item.get("reason", "producer integration failed"),
            "integration": integrated,
            "role": role,
            "ticket": ticket_id,
        }
    verifying = transition_phase(
        root, "VERIFY", agent, ticket_id, f"Verify {role} package payload and exact release scope"
    )
    if not verifying.ok:
        return {
            "ok": False,
            "code": verifying.code,
            "message": verifying.message,
            "integration": integrated,
            "role": role,
            "ticket": ticket_id,
        }
    return {
        "ok": True,
        "code": "PRODUCER_REVIEW_REQUIRED",
        "message": (
            f"{role} integrated (resumed); verify and review {ticket_id}, then resume shortcut"
        ),
        "role": role,
        "ticket": ticket_id,
        "package_identity": package_identity,
        "integration": integrated,
    }


def _ship_targeted_producer(root: Path, role: str, context: dict, capability: object) -> dict:
    """Publish one reviewed producer ticket without adopting a crew carrier."""
    from .release import ReleaseRefusal, execute_release, plan_release

    try:
        release_plan = plan_release(
            root,
            f"ship-{role}",
            targeted_ticket=True,
            current_capability=capability,
            current_agent=_agent_for(root),
        )
    except (ReleaseRefusal, ValueError) as exc:
        return {
            "ok": False,
            "code": getattr(exc, "code", "VALIDATION_FAILED"),
            "message": getattr(exc, "detail", str(exc)),
            "role": role,
            **context,
        }
    released = execute_release(root, release_plan)
    return {
        "ok": bool(released.get("ok")),
        "code": released.get("code", "RELEASE_FAILED"),
        "message": released.get("detail", "targeted producer flow complete"),
        "role": role,
        **context,
        "release": released,
    }


def _execute_crew_action(
    root: Path,
    action_type: str,
    action_role: str | None,
    capability: str,
    agent: str,
    saipen_home: str,
    dry_run: bool = False,
    action_inputs: tuple[str, ...] = (),
    planning_snapshot=None,
) -> object:
    """CORE-007: the single authoritative autonomous action executor.

    Every crew planner action maps to exactly one canonical operation (or an
    intentional structured terminal refusal). There is no UNKNOWN_ACTION branch:
    an unhandled action is a programming error surfaced as a structured refusal
    so the loop fails loudly instead of stalling.
    """
    from . import subs
    from .crew import _finalize_crew_from_snapshot, finalize_crew

    if action_type == "RUN_ROLE":
        return _prepare_role(root, action_role or "", capability)
    if action_type == "COLLECT_ROLE":
        return subs.sub_collect(root, action_role or "", agent=agent, dry_run=dry_run)
    if action_type == "CONVERGE_CORE":
        return _try_satisfy_convergence(root, dry_run=dry_run)
    if action_type in ("PREPARE_TRANSLATE", "PREPARE_TRANSLATE_FINAL"):
        return _prepare_role(root, "saitranslate", capability)
    if action_type in ("PREPARE_WIKI", "PREPARE_WIKI_FINAL"):
        return _prepare_role(root, "saiwiki", capability)
    if action_type in ("INTEGRATE_TRANSLATE", "INTEGRATE_WIKI"):
        prod = "saitranslate" if "TRANSLATE" in action_type else "saiwiki"
        return _integrate_producer(root, prod, agent)
    if action_type == "SYNC_SHARED":
        return subs.sub_sync(root, saipen_home, agent=agent, dry_run=dry_run)
    if action_type == "SPAWN_ROLE":
        return subs.sub_spawn(root, action_role or "", saipen_home, agent=agent, dry_run=dry_run)
    if action_type == "ADOPT_ROLE":
        return subs.sub_adopt(root, action_role or "", saipen_home, agent=agent, dry_run=dry_run)
    if action_type == "FINALIZE":
        if planning_snapshot is not None:
            return _finalize_crew_from_snapshot(planning_snapshot, current_agent=agent)
        return finalize_crew(root, current_agent=agent)
    if action_type == "DEFER_FOR_CREW":
        from .crew import crew_snapshot
        from .operations import defer_for_crew

        ticket = action_inputs[-1] if action_inputs else ""
        snapshot = planning_snapshot or crew_snapshot(root, current_capability=capability)
        if not ticket.startswith("T-") or snapshot.epoch is None:
            return {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "message": "DEFER_FOR_CREW lacks ticket/active crew epoch",
            }
        return defer_for_crew(root, ticket, agent, snapshot.epoch.op_id, dry_run=dry_run)
    if action_type == "CLEAR_WAIT_ROLE":
        from .operations import clear_wait_role

        ticket = action_inputs[-1] if action_inputs else ""
        if not ticket.startswith("T-"):
            return {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "message": "CLEAR_WAIT_ROLE carries no ticket",
            }
        return clear_wait_role(root, ticket, agent, dry_run=dry_run)
    if action_type == "RECOVER":
        from .journal import pending_ops, recover

        pending = pending_ops(root)
        if not pending:
            return {"ok": True, "code": "RECOVERY_CURRENT", "message": "no pending op"}
        return recover(root, pending[0]["op_id"])
    if action_type == "DISPOSE_REVIEW":
        return subs.sub_disposition(
            root, action_role or "", package_id=None, agent=agent, dry_run=dry_run
        )
    if action_type == "REVIEW_CORE":
        return {
            "ok": False,
            "code": "ACTION_REQUIRES_REVIEW",
            "message": "independent Core review cannot be fabricated by automation",
        }
    if action_type == "REVERIFY_FIXED_POINT":
        return _try_satisfy_convergence(root, dry_run=dry_run)
    if action_type == "SHIP":
        from .release import ReleaseRefusal, execute_release, plan_release

        try:
            release_plan = plan_release(
                root,
                "ship",
                dry_run=dry_run,
                current_capability=capability,
                current_agent=agent,
            )
        except ReleaseRefusal as exc:
            return {"ok": False, "code": exc.code, "message": exc.detail}
        return execute_release(root, release_plan)
    if action_type == "CONTINUE_CORE":
        return {
            "ok": False,
            "code": "ACTION_REQUIRES_CORE",
            "message": "Core implementation work has no synthetic executor",
        }
    # Enumerated vocabulary exhausted: programming error -> structured refusal.
    return {
        "ok": False,
        "code": "UNHANDLED_ACTION",
        "message": f"no executor for crew action {action_type!r}",
    }


def autonomous_crew_loop(
    project_root: Path,
    dry_run: bool = False,
    as_json: bool = False,
    current_capability: object = None,
) -> dict:
    """Legacy autonomous crew-only loop (``sc`` semantics).

    ENSURE FULL CREW CONVERGENCE/CLOSURE.

    This compatibility entry point owns only the crew circuit. It does not
    own canonical continue/converge routing or targeted producer execution;
    the CLI dispatches those through their dedicated ``cc`` and ``qqq``/
    ``eee`` handlers before this function can be called.

    CORE-001: capability resolved once at the boundary; read-only refuses all
    mutations. CORE-002: under ``dry_run`` the loop derives the planned action
    sequence and executes ZERO writers (byte-identical filesystem). CORE-007:
    every action dispatches through ``_execute_crew_action`` to exactly one
    canonical operation or a structured refusal.
    """
    from .autonomy import ProgressTracker
    from .capability import capability_error, may_mutate, negotiate_capability
    from .crew import _capture_crew_plan

    root = Path(project_root)
    capability = negotiate_capability() if current_capability is None else current_capability
    err = capability_error(capability)
    if err is not None:
        return {"ok": False, "code": "CAPABILITY_INVALID", "message": err}

    agent = _agent_for(root)
    saipen_home = _resolve_saipen_home(root)
    tracker = ProgressTracker(max_iterations=60)

    while True:
        # Read-only crew plan.
        try:
            planning_snapshot, plan = _capture_crew_plan(
                root, current_capability=capability, current_agent=agent
            )
        except Exception as exc:
            return {
                "ok": False,
                "code": "FATAL_CORRUPTION",
                "message": f"crew plan failed: {exc}",
                "terminal_state": "fatal_corruption",
            }

        # Terminal: crew complete / finalized.
        if plan.get("crew_complete"):
            return {
                "ok": True,
                "code": "CREW_COMPLETE" if not dry_run else "CREW_DRY_PLAN",
                "message": "crew convergence complete",
                "terminal_state": "crew_complete",
                "iterations": tracker.iterations,
                "dry_run": dry_run,
            }
        if plan.get("finalized"):
            return {
                "ok": True,
                "code": "CREW_FINALIZED" if not dry_run else "CREW_DRY_PLAN",
                "message": "crew finalized",
                "terminal_state": "done",
                "iterations": tracker.iterations,
                "dry_run": dry_run,
            }

        first_unsat = plan.get("first_unsatisfied", "")
        roles = plan.get("roles", {})
        action_info = plan.get("action")
        action_type = (action_info or {}).get("action", "")
        action_role = (action_info or {}).get("role")

        # CORE-002: dry-run is a ZERO-WRITE plan. Record the next action and the
        # full plan, then return without executing any writer.
        if dry_run:
            return {
                "ok": True,
                "code": "CREW_DRY_PLAN",
                "message": "crew plan (dry-run, zero-write)",
                "planned_action": action_type or None,
                "planned_role": action_role,
                "terminal_state": "planned",
                "iterations": tracker.iterations,
                "plan": plan,
            }

        # CORE-001: a read-only session may not execute any mutating crew action.
        if not may_mutate(capability):
            return {
                "ok": False,
                "code": "CAPABILITY_READ_ONLY",
                "message": (
                    "read-only session cannot execute crew actions; the "
                    "negotiated capability is read-only (CORE-001)"
                ),
                "terminal_state": "done",
                "iterations": tracker.iterations,
            }

        # No action means the planner refuses to act on this stage.
        if not action_info and first_unsat:
            repaired = _autonomous_repair_stage(root, first_unsat, plan)
            if repaired:
                if not tracker.record(
                    json.dumps(plan, sort_keys=True, default=str),
                    f"{first_unsat}:REPAIR_STAGE",
                    "mechanical repair dispatched",
                    "REPAIRED",
                ):
                    return {
                        "ok": False,
                        "code": "LOOP_STALLED",
                        "message": tracker.stalled_reason(),
                        "terminal_state": "loop_stalled",
                        "iterations": tracker.iterations,
                        "plan": plan,
                    }
                continue
            return {
                "ok": False,
                "code": "STAGE_UNREPAIRABLE",
                "message": (
                    f"{first_unsat}: {plan.get('stages', [{}])[0].get('reason', 'unknown')} "
                    "-- no mechanical repair available"
                ),
                "terminal_state": "done",
                "iterations": tracker.iterations,
            }
        if not first_unsat and not plan.get("crew_complete"):
            return {
                "ok": True,
                "code": "CREW_IDLE",
                "message": "no action available and not crew_complete",
                "terminal_state": "done",
                "iterations": tracker.iterations,
            }

        # Progress detection.
        plan_signature = json.dumps(
            {
                "first_unsat": first_unsat,
                "roles": roles,
                "action_type": action_type,
                "action_role": action_role,
            },
            sort_keys=True,
        )
        result = _execute_crew_action(
            root,
            action_type,
            action_role,
            capability,
            agent,
            saipen_home,
            dry_run=False,
            action_inputs=tuple((action_info or {}).get("inputs") or ()),
            planning_snapshot=planning_snapshot,
        )
        ok, code = _norm(result)
        if not tracker.record(
            plan_signature,
            f"{first_unsat}:{action_type}:{action_role or ''}",
            "action dispatched",
            code,
        ):
            return {
                "ok": False,
                "code": "LOOP_STALLED",
                "message": tracker.stalled_reason(),
                "terminal_state": "loop_stalled",
                "iterations": tracker.iterations,
                "plan": plan,
                "detail": result if isinstance(result, dict) else {"code": code},
            }

        if not ok:
            # A blocked stage can sometimes be repaired by clearing pending work
            # WITHOUT destroying it (CORE-004).
            if action_type == "RUN_ROLE":
                _auto_repair_role(root, action_role or "")
            return {
                "ok": False,
                "code": code or "CREW_ACTION_FAILED",
                "message": f"action {action_type} for {first_unsat} failed",
                "terminal_state": "done",
                "iterations": tracker.iterations,
                "detail": result if isinstance(result, dict) else {"code": code},
            }

        # Success: continue to the next iteration -- the plan should change.
        continue


def _autonomous_repair_stage(root: Path, stage: str, plan: dict) -> bool:
    """Repair a crew stage that the planner refuses to act on.

    Returns True if a repair was made and the loop should retry.
    """
    stages = plan.get("stages", [])
    for s in stages:
        if s["stage"] != stage:
            continue
        reason = s.get("reason", "")
        break
    else:
        return False

    # SC-1 instances: invalid role -> fix malformed OUTBOX entries
    if stage == "SC-1" and "invalid" in reason.lower():
        roles = plan.get("roles", {})
        for role_name, health in roles.items():
            if health == "INVALID":
                return _fix_invalid_outbox(root, role_name)

    return False


def _fix_invalid_outbox(root: Path, role: str) -> bool:
    """Fail closed on malformed OUTBOX evidence.

    Unparsed bytes have no proof of disposability.  Autonomous repair must not
    rewrite or delete them; a human/role-specific recovery can quarantine them
    through the journal once it knows their meaning.  ``False`` leaves the
    stage blocked and every original byte intact.
    """
    from . import subs

    outbox_path = root / subs.SUBS_REL / role / "kitchen" / "OUTBOX.md"
    if not outbox_path.is_file():
        return False

    try:
        subs.parse_outbox(outbox_path.read_text(encoding="utf-8"), role)
    except (OSError, UnicodeError):
        return False
    return False


def _auto_repair_role(root: Path, role: str) -> bool:
    """CORE-004: attempt auto-repair for a role WITHOUT destroying pending work.

    The previous implementation regex-deleted the worker's ``## TODO`` section
    (including its unchecked tickets) and rewrote them as a generic deferred
    marker -- silent project-state data loss. Pending worker tickets must
    survive failures. This routine therefore performs NO destructive mutation:
    it returns False so the loop reports a deterministic blocker and preserves
    every pending ticket. Deferral, when legitimate, must go through a journaled
    canonical board/ticket operation, not a regex rewrite.
    """
    board_path = root / ".saipen" / "extensions" / "subs" / role / "BOARD.md"
    if not board_path.is_file():
        return False
    # Intentionally does not modify the board. Pending tickets are preserved.
    return False


def _try_satisfy_convergence(root: Path, dry_run: bool = False) -> dict:
    """Try to satisfy convergence requirements."""
    try:
        from .convergence import convergence_verdict

        verdict = convergence_verdict(root)
        if verdict.ok:
            return {"ok": True, "message": "convergence already satisfied"}
    except Exception:
        pass

    import subprocess

    try:
        validate_path = root / "tools" / "validate.py"
        if validate_path.is_file():
            result = subprocess.run(
                [sys.executable, str(validate_path)],
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(root / "tools"),
            )
            if result.returncode == 0:
                return {
                    "ok": False,
                    "code": "CONVERGENCE_EVIDENCE_MISSING",
                    "message": (
                        "validator passed, but canonical convergence receipts "
                        "are still missing; validation alone is not proof"
                    ),
                }
            else:
                fail_count = result.stdout.count("FAIL:")
                return {
                    "ok": False,
                    "message": f"validator has {fail_count} failures",
                }
    except Exception as exc:
        return {
            "ok": False,
            "message": f"validator execution failed: {exc}",
        }

    return {
        "ok": False,
        "message": "convergence cannot be satisfied automatically",
    }
