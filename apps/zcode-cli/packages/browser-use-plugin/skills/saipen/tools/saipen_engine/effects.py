"""Effect-based authorization (T-1160): control the effect, not the button.

INC-PERMISSION-EFFECT-BYPASS-001: a host permitted the shell tool while file
edits were set to manual approval; the agent ran Python through the shell and
Python wrote project files. Nothing was malicious -- and the boundary still
failed, because authorization was attached to the TOOL NAME instead of to the
EFFECT produced. This module gives SAIPEN the vocabulary and the deterministic
evaluator so authorization can follow what an operation actually exercises.

The three concepts this module keeps separate (never conflate them):

POLICY      what the protocol/project says is authorized for an effect;
ENFORCEMENT what the HOST runtime actually prevents -- SAIPEN cannot observe a
            sandbox it was never told about, so enforcement is UNAVAILABLE
            unless the host declares it through ``SAIPEN_HOST_ENFORCEMENT``;
AUDIT       what SAIPEN can detect around an operation -- cheap, read-only
            Git worktree deltas (:func:`tree_delta`) and structured records.

A tool name is NOT evidence of an effect. ``Edit`` guarantees fs.write by
contract; a universal interpreter or shell is always POTENTIALLY mutating;
what actually happened is known only from observation. Indirect mutation is
still mutation: compiler, generator, formatter, package manager, nested
subprocess -- if project state changed, mutation semantics apply.

Epistemic discipline is inherited from the protocol: provenance and
enforcement fields are KNOWN / UNKNOWN / UNAVAILABLE and are NEVER filled
with inference. No module here labels intent: a policy mismatch is a
mechanical fact, not an accusation.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

# ── The closed effect vocabulary ────────────────────────────────────────
# Deliberately small. Effects describe what an operation EXERCISES, never
# which button produced it. Extending this set is a protocol change.

FS_READ = "fs.read"
FS_WRITE = "fs.write"
FS_DELETE = "fs.delete"
REPO_READ = "repo.read"
REPO_MUTATE = "repo.mutate"
PROCESS_EXECUTE = "process.execute"
NETWORK_READ = "network.read"
NETWORK_WRITE = "network.write"
EXTERNAL_MUTATE = "external.mutate"

EFFECTS = (
    FS_READ,
    FS_WRITE,
    FS_DELETE,
    REPO_READ,
    REPO_MUTATE,
    PROCESS_EXECUTE,
    NETWORK_READ,
    NETWORK_WRITE,
    EXTERNAL_MUTATE,
)

# Effects that change project/user state and therefore need coverage.
MUTATING_EFFECTS = frozenset(
    {FS_WRITE, FS_DELETE, REPO_MUTATE, NETWORK_WRITE, EXTERNAL_MUTATE}
)

# Project-mutation effects: the first-class case (P0). Network/cloud effects
# share the law but are not yet observable by SAIPEN's audit layer.
PROJECT_MUTATION_EFFECTS = frozenset({FS_WRITE, FS_DELETE, REPO_MUTATE})

# A path-level mutation approval implies the repository-level view of the same
# change: approving ``fs.write`` on a path set IS approval for the resulting
# ``repo.mutate`` of exactly those paths -- never a promotion from a DIFFERENT
# capability such as process execution.
IMPLIED_EFFECTS = {FS_WRITE: (REPO_MUTATE,), FS_DELETE: (REPO_MUTATE,)}

POLICY_LEVELS = ("ALLOW", "MANUAL", "DENY")

# ── Tool/adapter contracts: POSSIBLE != REQUESTED != OBSERVED ──────────
# Guaranteed effects are contractual (a dedicated edit tool exists to write).
# Possible effects describe CAPABILITY, never what actually occurred. A shell
# or interpreter is a universal execution capability: treating it as
# "read-only because the command looked harmless" is exactly the failure this
# module exists to prevent.

TOOL_GUARANTEED_EFFECTS: dict[str, tuple[str, ...]] = {
    "edit": (FS_WRITE,),
    "write": (FS_WRITE,),
    "read": (FS_READ,),
}

TOOL_POSSIBLE_EFFECTS: dict[str, tuple[str, ...]] = {
    "shell": (
        PROCESS_EXECUTE,
        FS_READ,
        FS_WRITE,
        FS_DELETE,
        NETWORK_READ,
        NETWORK_WRITE,
    ),
}
# Universal interpreters share the shell's possibility space by nature.
TOOL_POSSIBLE_EFFECTS["python"] = TOOL_POSSIBLE_EFFECTS["shell"]
TOOL_POSSIBLE_EFFECTS["powershell"] = TOOL_POSSIBLE_EFFECTS["shell"]

# ── Host enforcement honesty ─────────────────────────────────────────────
# SAIPEN cannot see a sandbox the host never declares. Absent a declaration
# the ONLY truthful value is UNAVAILABLE, and any policy stricter than the
# enforced reality must surface as a gap rather than fake compliance.

ENFORCEMENT_DECLARED_VALUES = {
    # declared -> (strength, truthful note)
    "unavailable": ("UNAVAILABLE", "host declared nothing; no guarantee exists"),
    "none": ("NONE", "host enforces nothing beyond ordinary process rights"),
    "tool-conventions": (
        "PARTIAL",
        "only tool-level prompts/conventions; indirect execution paths exist",
    ),
    "sandbox-readonly": (
        "STRONG",
        "host declares the session filesystem effectively read-only",
    ),
}
ENV_HOST_ENFORCEMENT = "SAIPEN_HOST_ENFORCEMENT"

# Coverage verdicts (mechanical facts about authorization, never about intent).
AUTHORIZED = "AUTHORIZED"
AUTHORIZATION_MISSING = "AUTHORIZATION_MISSING"
SCOPE_MISMATCH = "SCOPE_MISMATCH"
EFFECT_DRIFT = "EFFECT_DRIFT"

POLICY_SOURCE_DERIVED = "derived-from-capability"
POLICY_SOURCE_PROJECT = "project-policy.json"


def host_enforcement(env: dict | None = None) -> dict:
    """Assess what the host ACTUALLY enforces, truthfully.

    Reads the optional ``SAIPEN_HOST_ENFORCEMENT`` declaration; anything
    unrecognized degrades to UNAVAILABLE (fail closed on ambiguity). The
    result never claims more than the declaration supports.
    """
    source = os.environ if env is None else env
    declared = str(source.get(ENV_HOST_ENFORCEMENT, "") or "").strip().lower()
    strength, note = ENFORCEMENT_DECLARED_VALUES.get(
        declared, ("UNAVAILABLE", "no recognizable host enforcement declaration")
    )
    return {"declared": declared or "unavailable", "strength": strength, "note": note}


def default_policy(capability: str | None) -> dict[str, str]:
    """Policy DERIVED from the negotiated session capability.

    Backward compatible by construction: a writable session keeps the
    protocol's standing authorization for its own gated operations (the
    SAIOPS/destructive gates remain authoritative); a read-only session
    denies mutation outright, matching ``capability.may_mutate``. Projects
    may tighten this through ``.saipen/policy.json`` (see :func:`load_policy`)
    -- tightening never loosens.
    """
    from .capability import CAPABILITIES

    if capability not in CAPABILITIES:
        # Unknown capability: fail closed -- mutation denied, reads allowed.
        mutating = "DENY"
    elif capability == "read-only":
        mutating = "DENY"
    else:
        mutating = "ALLOW"
    policy = {effect: "ALLOW" for effect in EFFECTS if effect not in MUTATING_EFFECTS}
    for effect in sorted(MUTATING_EFFECTS):
        policy[effect] = mutating
    return policy


def load_policy(
    project_root: Path | str | None = None, *, capability: str | None = None
) -> dict:
    """Load the effective effect policy for a project.

    Returns ``{"policy": {effect: level}, "source": ..., "overrides": [...]}``.
    ``.saipen/policy.json`` (optional, bounded, human-readable) maps effect
    names to ALLOW/MANUAL/DENY; unknown effects or levels fail CLOSED by
    dropping the override (recorded in ``overrides``) instead of guessing.
    MANUAL means: every mutation of that effect needs an explicit scoped
    approval -- exactly the incident's host configuration.
    """
    policy = default_policy(capability)
    source = POLICY_SOURCE_DERIVED
    overrides: list[str] = []
    if project_root is not None:
        path = Path(project_root) / ".saipen" / "policy.json"
        try:
            raw = path.read_text(encoding="utf-8-sig")
            doc = json.loads(raw)
        except (OSError, ValueError):
            doc = None
        if isinstance(doc, dict):
            source = POLICY_SOURCE_PROJECT
            for key, value in doc.items():
                if key in EFFECTS and value in POLICY_LEVELS:
                    policy[key] = value
                    overrides.append(f"{key}={value}")
                else:
                    overrides.append(f"dropped:{key}={value!r}")
    return {"policy": policy, "source": source, "overrides": overrides}


@dataclass(frozen=True)
class Approval:
    """One explicit, SCOPE-BOUND grant of mutation authority.

    ``Bash approved`` is not an approval of anything: an approval names the
    EFFECT it covers, optionally the exact path set, and optionally the
    Work/Attempt it belongs to. A one-shot approval is consumed by one
    matching mutation. Vague forever-approvals are exactly how shell
    execution silently becomes file-write authority; do not create them.
    """

    effect: str
    paths: tuple[str, ...] = ()  # () == unbounded path set
    work_id: str | None = None
    attempt_id: str | None = None
    reusable: bool = False
    granted_by: str = "user"


@dataclass(frozen=True)
class MutationRecord:
    """Structured provenance for one observed project mutation.

    Every unknowable field stays literally UNKNOWN/None -- provenance is
    recorded, never invented. ``verdict`` is a mechanical authorization fact
    (AUTHORIZED / AUTHORIZATION_MISSING / SCOPE_MISMATCH / EFFECT_DRIFT);
    it deliberately says nothing about WHY a mismatch happened.
    """

    paths: tuple[str, ...]
    effects: tuple[str, ...]
    requested_effects: tuple[str, ...] = ()
    work_id: str | None = None
    attempt_id: str | None = None
    origin_tool: str | None = None
    origin_child: str | None = None
    authorization_required: str | None = None
    authorization_observed: tuple[str, ...] = ()
    verdict: str = AUTHORIZATION_MISSING
    evidence_status: str = "KNOWN"
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "paths": list(self.paths),
            "effects": list(self.effects),
            "requested_effects": list(self.requested_effects),
            "work_id": self.work_id,
            "attempt_id": self.attempt_id,
            "origin_tool": self.origin_tool,
            "origin_child": self.origin_child,
            "authorization": {
                "required": self.authorization_required,
                "observed": list(self.authorization_observed),
            },
            "verdict": self.verdict,
            "evidence_status": self.evidence_status,
            "detail": self.detail,
        }


def _project_effects(paths: tuple[str, ...]) -> tuple[str, ...]:
    """Effects exercised by changing files inside the project worktree."""
    if not paths:
        return ()
    return (FS_WRITE, REPO_MUTATE)


def _path_covered(path: str, allowed_paths: tuple[str, ...]) -> bool:
    """True when ``path`` falls inside the approval's explicit path set.

    Path-set comparison is exact-prefix on normalized separators; an empty
    approval path set means unbounded within the effect. This is SCOPE
    checking for approvals the user actually wrote -- never a substitute for
    observation.
    """
    normalized = path.replace("\\", "/")
    for allowed in allowed_paths:
        base = allowed.replace("\\", "/").rstrip("/")
        if not base:
            continue
        if normalized == base or normalized.startswith(base + "/"):
            return True
    return False


def evaluate_coverage(
    *,
    observed_effects: tuple[str, ...],
    policy: dict[str, str],
    approvals: tuple[Approval, ...] = (),
    paths: tuple[str, ...] = (),
    requested_effects: tuple[str, ...] = (),
    work_id: str | None = None,
    attempt_id: str | None = None,
) -> MutationRecord:
    """Answer ONE question mechanically: WHAT AUTHORIZATION COVERS THIS?

    Order of judgment (fail closed at each step):

    1. An observed effect the policy DENYs outright -> AUTHORIZATION_MISSING
       (the strictest reading wins; DENY is never promotable by approval).
    2. Observed mutation effects with level MANUAL need an Approval whose
       effect matches, whose path set covers every mutated path, and whose
       Work/Attempt binding (when present) matches this operation. Shell or
       interpreter approvals cover ONLY their own named effects: an approval
       of ``process.execute`` never promotes to ``fs.write``.
    3. Declared expectations that did NOT happen, or observed effects absent
       from the declaration, are EFFECT_DRIFT -- surfaced for review, never
       silently absorbed.

    The returned record's ``authorization_observed`` lists the effects the
    supplied approvals actually covered, so ``OBSERVED > REQUESTED`` gaps are
    visible in the record itself.
    """
    unknown = tuple(e for e in observed_effects if e not in EFFECTS)
    # Drift needs a DECLARED expectation to diverge from; an operation that
    # declared nothing yields no drift claim (AUTH-12: no false mutation).
    drift = (
        tuple(sorted(set(requested_effects) ^ set(observed_effects)))
        if requested_effects
        else ()
    )
    mutating = tuple(
        e for e in observed_effects if e in PROJECT_MUTATION_EFFECTS
    )
    covered: list[str] = []
    verdict = AUTHORIZED
    detail = ""
    for effect in mutating:
        level = policy.get(effect, "DENY")
        if level == "DENY":
            verdict = AUTHORIZATION_MISSING
            detail = f"{effect} is DENYed by policy"
            break
        if level == "ALLOW":
            covered.append(effect)
            continue
        # MANUAL: a scoped approval must cover THIS effect and EVERY path.
        matched = False
        for approval in approvals:
            implied = approval.effect == effect or effect in IMPLIED_EFFECTS.get(
                approval.effect, ()
            )
            if not implied:
                continue  # tool identity is irrelevant; the EFFECT must match
            if approval.work_id is not None and approval.work_id != work_id:
                continue
            # Attempt binding: a non-reusable approval is valid ONLY inside
            # the exact Attempt it names; a reusable one may serve later
            # attempts of the same Work (explicitly declared reuse only).
            if (
                approval.attempt_id is not None
                and not approval.reusable
                and approval.attempt_id != attempt_id
            ):
                continue
            if approval.paths and paths and not all(
                _path_covered(path, approval.paths) for path in paths
            ):
                continue
            matched = True
            if effect not in covered:
                covered.append(effect)
            break
        if not matched:
            verdict = AUTHORIZATION_MISSING
            detail = f"{effect} is MANUAL and no scoped approval covers it"
            break
    if drift and verdict == AUTHORIZED:
        verdict = EFFECT_DRIFT
        detail = "expected and observed effects diverge: " + ", ".join(drift)
    if unknown and verdict == AUTHORIZED:
        verdict = EFFECT_DRIFT
        detail = f"unknown observed effects: {', '.join(unknown)}"
    return MutationRecord(
        paths=tuple(paths),
        effects=tuple(observed_effects),
        requested_effects=tuple(requested_effects),
        work_id=work_id,
        attempt_id=attempt_id,
        authorization_required=(
            "; ".join(f"{e}:{policy.get(e, 'UNSET')}" for e in mutating) or None
        ),
        authorization_observed=tuple(covered),
        verdict=verdict,
        detail=detail,
    )


# ── Audit: cheap, read-only project tree delta ──────────────────────────


def tree_snapshot(project_root: Path | str) -> dict:
    """Capture the CURRENT worktree change set. Read-only; never touches
    index/stash/HEAD. Git present -> ``{"status": "KNOWN", "paths": [...]}``;
    no git -> ``{"status": "UNAVAILABLE", "paths": []}`` (honest absence, not
    a fabricated clean bill). Gitignored artifacts are invisible to the
    default listing, which matches the protocol's distinction between
    generated temporary output and project mutation."""
    root = Path(project_root)
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain=v1", "-z"],
            cwd=str(root),
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "UNAVAILABLE", "paths": ()}
    if proc.returncode != 0:
        return {"status": "UNAVAILABLE", "paths": []}
    entries = [entry for entry in proc.stdout.decode("utf-8", "replace").split("\0") if entry]
    paths: list[str] = []
    for entry in entries:
        # Porcelain -z: "XY <path>" per NUL-separated entry (renames carry an
        # embedded NUL + new path, which lands as its own bare entry here and
        # is still a changed path worth listing).
        paths.append(entry[3:] if len(entry) > 3 and entry[2] == " " else entry)
    return {"status": "KNOWN", "paths": tuple(sorted(set(paths)))}


def tree_delta(
    project_root: Path | str, before: dict | None = None
) -> dict:
    """What changed SINCE ``before`` (an earlier :func:`tree_snapshot`).

    With no baseline, returns the current dirty set with attribution status
    UNKNOWN -- pre-existing dirt must never be attributed to a fresh
    operation (AUTH-13). With a baseline, newly-changed paths are the
    operation's mutation surface (KNOWN); paths already dirty before stay
    attributed to nobody here.
    """
    after = tree_snapshot(project_root)
    if after["status"] != "KNOWN":
        return {"status": "UNAVAILABLE", "paths": (), "prior_paths": ()}
    prior = set(before.get("paths", ())) if before else set()
    fresh = tuple(p for p in after["paths"] if p not in prior)
    return {
        "status": "KNOWN",
        "paths": tuple(fresh),
        "prior_paths": tuple(p for p in after["paths"] if p in prior),
    }


def assess_enforcement_gap(policy: dict[str, str], env: dict | None = None) -> dict:
    """Where POLICY promises more than the HOST can enforce, say so.

    MANUAL/DENY mutation policies under a host whose enforcement is not
    STRONG leave an honest gap: indirect execution paths may still mutate.
    Surfacing the gap IS the deliverable -- pretending the policy is
    enforced is the one thing this module must never do.
    """
    host = host_enforcement(env)
    strict = sorted(e for e in MUTATING_EFFECTS if policy.get(e) in ("MANUAL", "DENY"))
    gap = bool(strict) and host["strength"] != "STRONG"
    return {
        "policy_strict_effects": strict,
        "host": host,
        "gap": gap,
        "verdict": "ENFORCEMENT_GAP" if gap else "ENFORCED_OR_UNRESTRICTED",
    }
