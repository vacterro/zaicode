"""Canonical Core convergence verdict (T-1003 Wave 2, items 1/14).

CONVERGE.md owns the E-I sequence (E canonical test gate, F forced HUNT,
G CLEAN, H post-clean test gate, I final forced HUNT). This module owns ONLY
the mechanical proof that those requirements are CURRENT against one source
identity -- the crew planner/gate (SC-7), the terminal ship gate and the
convergence mini-circuit all consume this ONE verdict, and crew.py never
re-implements the sequence.

The verdict is a terminal ordered chain of COMMITTED `convergence_stage`
operation receipts. Every receipt binds the LIVE source identity
(source_head + source_tree_fingerprint) at its execution time; G (CLEAN)
additionally binds the resulting identity after its mutation. The chain is
current iff:

- E and F bind one identity S0;
- G's input is S0 and G's resulting identity is the S1 that H and I bind;
- the CURRENT live source identity equals S1 -- no main-source mutation after
  the final forced HUNT;
- every stage verdict is the closed outcome CONVERGE.md defines for it;
- the working tree is fully attributed: every main-source delta (when a Git
  baseline exists) is claimed by an owner record with matching bytes, and no
  recorded claim is stale.

Receipts may be re-recorded (the F -> E loop CONVERGE.md defines when HUNT
finds work); only the terminal chain walking backwards from the latest I
counts. Earlier aborted attempts stay historical evidence and never certify
the current fixed point.

DONE STATE IS NOT CONVERGENCE PROOF. phase DONE + task none + an empty
workable board proves nothing about E-I; a project can sit at DONE with stale
or missing tests/HUNT/CLEAN evidence. This verdict is what SC-7 requires
instead of an empty-board inference.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

# The closed stage set CONVERGE.md defines. The letters are the document's own
# section labels, so a receipt can name the stage without restating prose.
CONVERGENCE_STAGES = ("E", "F", "G", "H", "I")

# Closed per-stage outcomes. Anything else is not a verdict, it is prose.
STAGE_VERDICTS = {
    "E": ("PASS",),  # canonical test gate PASS
    "F": ("CLEAN",),  # forced HUNT, no findings
    "G": ("COMPLETED", "NOTHING_SAFE_REMAINED"),  # CLEAN outcome
    "H": ("PASS",),  # post-clean test gate PASS
    "I": ("CLEAN",),  # final forced HUNT clean
}

STAGE_NAMES = {
    "E": "canonical test/validate gate",
    "F": "forced HUNT",
    "G": "CLEAN",
    "H": "post-clean test/validate gate",
    "I": "final forced HUNT",
}


@dataclass(frozen=True)
class ConvergenceVerdict:
    ok: bool
    reasons: tuple[str, ...]
    stages: tuple[dict, ...] = ()
    source: dict | None = None
    attribution_problems: tuple[str, ...] = ()

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "reasons": list(self.reasons),
            "stages": [
                {
                    "stage": item.get("stage", ""),
                    "verdict": (item.get("receipt_metadata") or {}).get("verdict", ""),
                    "op_id": item.get("op_id", ""),
                    "created_at": item.get("created_at", ""),
                }
                for item in self.stages
            ],
            "source": self.source,
            "attribution_problems": list(self.attribution_problems),
        }


def _strict_created_at(value: object) -> str:
    """Strict ISO-8601 UTC timestamp (Z or +00:00, utcoffset == 0), or '' when
    invalid. Delegated to the ONE shared strict-UTC parser (hostile-regression,
    P2#1): a non-zero offset stamp is NOT UTC and must refuse, never pass."""
    from .board import strict_iso_utc

    return strict_iso_utc(value)


def _iter_operation_records(root: Path, receipt_snapshot=None):
    """W2-001: Yield every parseable operation.json from both ops and settled.

    Uses the canonical semantic receipt snapshot from journal.py instead
    of scanning a single namespace. This ensures committed receipts that
    have been moved to settled/ remain visible to convergence readers.
    """
    from .journal import semantic_receipt_snapshot

    snapshot = receipt_snapshot or semantic_receipt_snapshot(root)
    if snapshot.errors:
        return
    yield from snapshot.records


def _event_number(record: dict) -> int:
    """The LOG event id a receipt committed under (secondary chronology key).

    The LOG event counter is NOT globally monotonic with real time in every
    supplied tree: a torn/replaced sealed history can carry E-3865 for a
    receipt recorded (2026-08-20) before a fresh E-3547 receipt (2026-08-22).
    Chronology therefore keys on the receipt's own created_at instant, with
    the event id only as an equal-instant tie-break -- the same canonical
    UTC ordering W2-005 established everywhere else.
    """
    meta = record.get("receipt_metadata") or {}
    match = re.match(r"E-(\d+)", str(meta.get("event_id") or ""))
    return int(match.group(1)) if match else -1


def _chrono_key(record: dict):
    """(parsed UTC instant, event id, op_id) -- canonical receipt chronology.
    Real UTC wins; the LOG event id and op_id are deterministic equal-instant
    tie-breaks only."""
    from .board import iso_utc_sort_key

    _earliest = iso_utc_sort_key("0000-01-01T00:00:00Z")
    return (
        iso_utc_sort_key(record.get("created_at", "")) or _earliest,
        _event_number(record),
        record.get("op_id", ""),
    )


def _stage_receipts(root: Path, receipt_snapshot=None) -> list[dict]:
    """Every COMMITTED convergence_stage receipt, oldest first by real UTC."""
    out = []
    for record in _iter_operation_records(root, receipt_snapshot):
        if record.get("operation") != "convergence_stage":
            continue
        if record.get("status") != "COMMITTED":
            continue
        created = _strict_created_at(record.get("created_at"))
        if not created:
            continue
        meta = record.get("receipt_metadata") or {}
        if meta.get("operation") != "convergence_stage" or meta.get("status") != "COMMITTED":
            continue
        if _event_number(record) < 0:
            continue
        out.append(record)
    out.sort(key=_chrono_key)
    return out


def _pick_latest(
    receipts: list[dict], wanted_stage: str, before: dict, reasons: list[str]
) -> dict | None:
    """The latest receipt of `wanted_stage` committed strictly before
    the full canonical chronology key of `before`, or None. Chronology is the
    receipt's REAL UTC instant
    (iso_utc_sort_key); the LOG event id is only an equal-instant tie-break.
    Ordering by the event counter alone breaks when the global LOG is torn
    (an older receipt can carry a higher E-### than a newer one), which lets
    a stale chain supersede a fresh one -- reproduced on the live tree where
    E-3865/3a343e8d (2026-08-20) outranked E-3547/e045ad07 (2026-08-22)."""
    before_key = _chrono_key(before)
    candidates = [
        item
        for item in receipts
        if (item.get("receipt_metadata") or {}).get("stage") == wanted_stage
        and _chrono_key(item) < before_key
    ]
    if not candidates:
        reasons.append(
            f"missing convergence stage {wanted_stage} "
            f"({STAGE_NAMES[wanted_stage]}) before "
            f"{before.get('op_id', '<unknown>')}"
        )
        return None
    return max(candidates, key=_chrono_key)


def _identity_of(record: dict) -> tuple[str, str] | None:
    """The INPUT source identity a stage receipt binds.

    Hostile-regression: the input side is `source_head` +
    `source_tree_fingerprint`, and BOTH must be present. The resulting side
    (`resulting_source_head` / `resulting_source_tree_fingerprint`, carried
    by CLEAN) is NEVER a fallback here -- a receipt that lost its input
    side is a broken chain link, not evidence with a second chance. The
    caller reads CLEAN's resulting side explicitly and only for stage G.
    """
    meta = record.get("receipt_metadata") or {}
    head = meta.get("source_head")
    tree = meta.get("source_tree_fingerprint")
    if not head or not tree:
        return None
    return head, tree


@dataclass(frozen=True)
class AttributionClaim:
    path: str
    state: str
    expected_hash: str | None
    chronology: tuple
    source_kind: str
    ticket_id: str
    op_id: str
    project_identity: str
    project_lineage: str


def _attribution_snapshot(
    root: Path, receipt_snapshot=None
) -> tuple[dict[str, AttributionClaim], list[str]]:
    """Decode and chronologically merge bound, structured owner claims."""
    from .paths import project_identity, project_lineage_identity

    claims: dict[str, AttributionClaim] = {}
    errors: list[str] = []
    scope_dir = root / ".saipen" / "kitchen" / "release_scope"
    # W2-004: convergence must consume only canonical claims, not raw JSON.
    # A claim path that escapes the project, is absolute/drive-qualified, or
    # carries a malformed hash is corrupt/transplanted evidence and is never
    # positive attribution. schema_version/ticket/lineage are not required for
    # attribution because legacy crew_defer receipts predate them; path/hash
    # ownership IS required for every source.
    root_resolved = root.resolve()

    def _canonical_claim(rel, expected):
        if not isinstance(rel, str) or not rel:
            return False
        if rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
            return False
        parts = rel.split("/")
        if any(part in ("", ".", "..") for part in parts):
            return False
        if expected is not None:
            if not isinstance(expected, str) or not re.fullmatch(
                r"(?:[0-9a-f]{16}|[0-9a-f]{64})", expected
            ):
                return False
        try:
            (root / rel).resolve().relative_to(root_resolved)
        except ValueError:
            return False
        return True

    live_identity = project_identity(root)
    live_lineage = project_lineage_identity(root) or ""

    def _binding(record: dict, label: str) -> tuple[str, str] | None:
        record_identity = record.get("project_identity")
        if "project_lineage" in record:
            record_lineage = record.get("project_lineage")
            if not isinstance(record_lineage, str) or not record_lineage:
                errors.append(f"{label} has malformed portable project lineage")
                return None
            if not live_lineage or record_lineage != live_lineage:
                errors.append(f"{label} belongs to a foreign project lineage")
                return None
            return str(record_identity or ""), record_lineage
        if record_identity != live_identity:
            errors.append(f"legacy {label} belongs to a foreign runtime project")
            return None
        return str(record_identity), ""

    def _merge(
        paths: dict,
        *,
        chronology: tuple,
        source_kind: str,
        ticket_id: str,
        op_id: str,
        binding: tuple[str, str],
    ) -> None:
        for rel, expected in paths.items():
            if not _canonical_claim(rel, expected):
                errors.append(f"{source_kind} {op_id} carries malformed claim {rel!r}")
                continue
            claim = AttributionClaim(
                path=rel,
                state="deleted" if expected is None else "present",
                expected_hash=expected,
                chronology=chronology,
                source_kind=source_kind,
                ticket_id=ticket_id,
                op_id=op_id,
                project_identity=binding[0],
                project_lineage=binding[1],
            )
            previous = claims.get(rel)
            if previous is None or claim.chronology > previous.chronology:
                claims[rel] = claim

    if scope_dir.is_dir():
        for scope in sorted(scope_dir.glob("T-*.json")):
            try:
                record = json.loads(scope.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                errors.append(f"release scope {scope.name} is corrupt: {exc}")
                continue
            if record.get("schema_version") not in (1, 2) or not isinstance(
                record.get("ticket"), str
            ):
                errors.append(f"release scope {scope.name} has malformed authority fields")
                continue
            binding = _binding(record, f"release scope {scope.name}")
            if binding is None:
                continue
            created = _strict_created_at(record.get("recorded_at"))
            if not created:
                errors.append(f"release scope {scope.name} has invalid recorded_at")
                continue
            paths = record.get("paths")
            if not isinstance(paths, dict):
                errors.append(f"release scope {scope.name} has malformed paths")
                continue
            chronology = _chrono_key(
                {
                    "created_at": created,
                    "op_id": str(record.get("op_id") or scope.name),
                    "receipt_metadata": {"event_id": record.get("event_id", "")},
                }
            )
            _merge(
                paths,
                chronology=chronology,
                source_kind="release_scope",
                ticket_id=record["ticket"],
                op_id=str(record.get("op_id") or scope.name),
                binding=binding,
            )
    for record in _iter_operation_records(root, receipt_snapshot):
        meta = record.get("receipt_metadata") or {}
        if record.get("operation") != "crew_defer" or record.get("status") != "COMMITTED":
            continue
        binding = _binding(meta, f"crew defer {record.get('op_id', '<unknown>')}")
        if binding is None:
            continue
        paths = meta.get("paths") or {}
        if not isinstance(paths, dict):
            errors.append(f"crew defer {record.get('op_id', '<unknown>')} has malformed paths")
            continue
        _merge(
            paths,
            chronology=_chrono_key(record),
            source_kind="crew_defer",
            ticket_id=str(meta.get("ticket_id") or ""),
            op_id=str(record.get("op_id") or ""),
            binding=binding,
        )
    # ATTRIBUTED_FOREIGN_PATCH (T-1256): a bounded, lineage-bound XPATCH
    # receipt explains WHO changed which bytes, from where and why. A change
    # a receipt accounts for is attributed, never unknown -- and the receipt
    # proves PROVENANCE only, so the target still verifies it independently
    # and its own later claim (release scope, disposition) supersedes this one
    # under the same chronology every other claim source obeys.
    from .xpatch import claim_records as _xpatch_claim_records

    xpatch_records, xpatch_problems = _xpatch_claim_records(root)
    errors.extend(xpatch_problems)
    for record in xpatch_records:
        binding = _binding(record, f"xpatch {record['patch_id']}")
        if binding is None:
            continue
        created = _strict_created_at(record.get("created_at"))
        if not created:
            errors.append(f"xpatch {record['patch_id']} has an invalid claim timestamp")
            continue
        _merge(
            record["paths"],
            chronology=_chrono_key(
                {
                    "created_at": created,
                    "op_id": record["op_id"],
                    "receipt_metadata": {"event_id": ""},
                }
            ),
            source_kind=record["source_kind"],
            ticket_id=record["ticket_id"],
            op_id=record["op_id"],
            binding=binding,
        )
    return claims, errors


def _attribution_claims(root: Path, receipt_snapshot=None) -> dict[str, AttributionClaim]:
    """Latest owning record per path under canonical receipt chronology."""
    return _attribution_snapshot(root, receipt_snapshot)[0]


def source_worktree_deltas(root: Path) -> list[str] | None:
    """ONE Git subprocess: deterministic main-source delta paths vs HEAD.

    Tri-state result: None when no usable Git baseline exists (UNKNOWN),
    [] when the source worktree equals HEAD, otherwise the sorted
    changed-path list covering staged + unstaged + untracked changes.
    The exact `.saipen` runtime boundary is excluded via a single
    pathspec, so `.saipenicious.py` / `.saipen-src/*` remain ordinary
    source. Rename/copy entries contribute their SOURCE path, matching
    the historical `git diff --name-status` identity semantics.
    """
    try:
        status = subprocess.run(
            [
                "git",
                "-C",
                os.fspath(root),
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--",
                ".",
                ":(exclude).saipen",
            ],
            capture_output=True,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if status.returncode != 0:
        return None
    paths: list[str] = []
    fields = status.stdout.decode("utf-8", "replace").split("\0")
    index = 0
    while index < len(fields) and fields[index]:
        record = fields[index]
        if len(record) < 3 or record[2] != " ":
            # Malformed porcelain record -- refuse instead of guessing.
            return None
        xy, path = record[:2], record[3:]
        index += 1
        if xy[0] == "R":
            if index >= len(fields) or not fields[index]:
                return None
            paths.append(path)
            paths.append(fields[index])
            index += 1
        elif xy[0] == "C":
            if index >= len(fields) or not fields[index]:
                return None
            paths.append(path)
            index += 1
        elif path:
            paths.append(path)
    # MAIN-SOURCE attribution only. A delta under ANY `.saipen` component
    # (the root one, or a nested project memory inside a test scenario
    # fixture) is project runtime, never main source. Agent scratch
    # directories (`.workbuddy-ai/`) are tool memory, not project content.
    # The git pathspec above excludes the root `.saipen`; nested `.saipen`
    # trees and scratch dirs need an explicit component filter because the
    # attribution gate must not block convergence on regenerable fixture
    # evidence (reproduced live: tests/scenarios/*/.saipen/recovery receipts
    # and .workbuddy-ai/memory/* blocked SC-7).
    _scratch_prefixes = (".workbuddy-ai/", ".saiwork/", "_tmp_dbg/")

    def _is_main_source(path: str) -> bool:
        parts = path.replace("\\", "/").split("/")
        if ".saipen" in parts:
            return False
        return not any(path.startswith(prefix) for prefix in _scratch_prefixes)

    return sorted({path for path in paths if _is_main_source(path)})


def _main_source_deltas(root: Path) -> list[str] | None:
    """Tracked/untracked main-source delta paths vs HEAD, excluding the
    exact `.saipen/` runtime boundary. None when no Git baseline exists.

    Thin projection over the single shared source-worktree probe so the
    historical name keeps working for attribution checks.
    """
    return source_worktree_deltas(root)


def attribution_problems(root: Path, receipt_snapshot=None) -> list[str]:
    """Attribution problems for the current tree (item 14).

    Every main-source delta (Git baseline present) must be claimed by an
    owner record whose expected bytes still match; a foreign/unknown delta
    is a visible problem, never silently claimed. Without a Git baseline no
    delta enumeration exists, so a project that recorded NO claims cannot
    prove "fully attributed" -- vacuous green is exactly what this check
    exists to refuse.
    """
    claims, problems = _attribution_snapshot(root, receipt_snapshot)
    deltas = _main_source_deltas(root)
    if deltas is not None:
        for rel in deltas:
            claim = claims.get(rel)
            if claim is None:
                problems.append(
                    f"unattributed main-source delta: {rel} -- every "
                    "change must belong to a reviewed scope"
                )
                continue
            fp = root / rel
            if claim.state == "deleted":
                if fp.exists() or fp.is_symlink():
                    problems.append(
                        f"main-source delta {rel} is a reviewed deletion but "
                        "exists again -- stale attribution, refuse"
                    )
                continue
            if not fp.is_file():
                problems.append(f"attributed path {rel} is missing -- reviewed scope stale, refuse")
                continue
            raw = fp.read_bytes()
            if not _claim_matches(raw, claim.expected_hash):
                live = _quick_hash(raw)
                problems.append(
                    f"attributed path {rel} changed after its reviewed "
                    f"scope (expected {claim.expected_hash}, live {live}) -- stale, "
                    "re-review before claiming a fixed point"
                )
        return problems
    if not claims:
        problems.append(
            "no attribution claims recorded and no Git baseline exists -- "
            "a no-git tree cannot prove 'fully attributed' from an empty "
            "board alone"
        )
        return problems
    for rel, claim in claims.items():
        fp = root / rel
        if claim.state == "deleted":
            if fp.exists() or fp.is_symlink():
                problems.append(
                    f"reviewed deletion {rel} exists again -- stale attribution, refuse"
                )
            continue
        if not fp.is_file():
            problems.append(f"attributed path {rel} is missing -- stale")
            continue
        if not _claim_matches(fp.read_bytes(), claim.expected_hash):
            problems.append(
                f"attributed path {rel} changed after its reviewed scope -- stale, refuse"
            )
    return problems


def _quick_hash(raw: bytes) -> str:
    # Scope/defer records store the journal's hash_bytes token (16 hex chars);
    # attribution must compare the SAME token or every claim looks stale.
    import hashlib

    return hashlib.sha256(raw).hexdigest()[:16]


def _claim_matches(raw: bytes, expected_hash: str) -> bool:
    # v2 reviewed scopes carry the full SHA-256; v1 scopes, crew defers and
    # xpatch receipts carry the 16-hex journal token. Compare through the one
    # shared authority so both generations verify without duplicating the rule.
    from .operations import release_scope_matches

    return release_scope_matches(raw, expected_hash)


def convergence_verdict(
    project_root: Path | str, source_id=None, receipt_snapshot=None
) -> ConvergenceVerdict:
    """The ONE mechanical Core convergence verdict (items 1/14).

    Returns ok=False with reasons whenever any of E-I evidence is missing,
    out of order, bound to a different source identity, followed by a later
    main-source mutation, or when the tree is not fully attributed. The
    caller binds the CURRENT source identity: pass `source_id` (as computed
    inside the same coherent snapshot) to avoid a second read.
    """
    root = Path(project_root)
    reasons: list[str] = []
    if receipt_snapshot is None:
        from .journal import semantic_receipt_snapshot

        receipt_snapshot = semantic_receipt_snapshot(root)
    if receipt_snapshot.errors:
        return ConvergenceVerdict(
            False,
            ("operation receipt corruption: " + "; ".join(receipt_snapshot.errors[:3]),),
        )
    if source_id is None:
        try:
            from freshness import compute_source_identity

            source_id = compute_source_identity(root)
        except Exception as exc:
            return ConvergenceVerdict(
                False, ("source identity UNKNOWN: " + str(exc),), source={"error": str(exc)}
            )
    live = (source_id.source_head, source_id.source_tree_fingerprint)

    receipts = _stage_receipts(root, receipt_snapshot)
    if not receipts:
        return ConvergenceVerdict(
            False,
            (
                "no canonical convergence stage evidence -- E-I "
                "(test/HUNT/CLEAN/post-clean test/final HUNT) must be "
                "recorded against the current source identity; DONE + "
                "empty board is not convergence proof",
            ),
            source={"source_head": live[0], "source_tree_fingerprint": live[1]},
        )

    # The terminal chain: walk backwards from the latest I.
    i_receipts = [
        item for item in receipts if (item.get("receipt_metadata") or {}).get("stage") == "I"
    ]
    if not i_receipts:
        reasons.append(
            "missing final forced HUNT (I) -- the closure sweep "
            "must run after CLEAN and post-clean tests"
        )
        return ConvergenceVerdict(
            False,
            tuple(reasons),
            source={"source_head": live[0], "source_tree_fingerprint": live[1]},
        )
    latest_i = i_receipts[-1]
    i_identity = _identity_of(latest_i)
    if i_identity is None:
        reasons.append("final forced HUNT receipt lacks a bound source identity")
        return ConvergenceVerdict(
            False,
            tuple(reasons),
            source={"source_head": live[0], "source_tree_fingerprint": live[1]},
        )
    if i_identity != live:
        reasons.append(
            "final forced HUNT binds source "
            f"{i_identity[0][:12]}/{i_identity[1][:16]} but the CURRENT "
            f"source is {live[0][:12]}/{live[1][:16]} -- a main-source "
            "mutation after the final HUNT invalidates the fixed point"
        )
        return ConvergenceVerdict(
            False,
            tuple(reasons),
            source={"source_head": live[0], "source_tree_fingerprint": live[1]},
        )

    h = _pick_latest(receipts, "H", latest_i, reasons)
    g = _pick_latest(receipts, "G", h or latest_i, reasons)
    f = _pick_latest(receipts, "F", g or latest_i, reasons)
    e = _pick_latest(receipts, "E", f or latest_i, reasons)
    if None in (e, f, g, h):
        return ConvergenceVerdict(
            False,
            tuple(reasons),
            source={"source_head": live[0], "source_tree_fingerprint": live[1]},
        )

    chain = [e, f, g, h, latest_i]
    chronology = [_chrono_key(record) for record in chain]
    if chronology != sorted(chronology) or len(set(chronology)) != len(chronology):
        reasons.append("convergence receipts do not satisfy strict E<F<G<H<I chronology")
        return ConvergenceVerdict(
            False,
            tuple(reasons),
            source={"source_head": live[0], "source_tree_fingerprint": live[1]},
        )
    ef = _identity_of(e)
    gh = _identity_of(g)
    hi = _identity_of(h)
    if ef is None or gh is None or hi is None:
        reasons.append("convergence stage receipt lacks a bound source identity")
        return ConvergenceVerdict(
            False,
            tuple(reasons),
            source={"source_head": live[0], "source_tree_fingerprint": live[1]},
        )
    s0 = ef
    s1 = hi
    if f is not None and _identity_of(f) != s0:
        reasons.append(
            "forced HUNT binds a different source identity than the "
            "canonical test gate -- a main-source mutation between E and F "
            "breaks the chain"
        )
    if gh[0] != s0[0] or gh[1] != s0[1]:
        reasons.append(
            "CLEAN input identity differs from the E/F identity -- CLEAN "
            "must run on the source the test gate and forced HUNT proved"
        )
    g_result = (
        (g.get("receipt_metadata") or {}).get("resulting_source_head", ""),
        (g.get("receipt_metadata") or {}).get("resulting_source_tree_fingerprint", ""),
    )
    if not g_result[0] or not g_result[1]:
        reasons.append("CLEAN receipt lacks its resulting source identity")
    elif g_result != s1:
        reasons.append(
            "CLEAN resulting identity differs from the H/I identity -- "
            "post-clean evidence must bind the post-CLEAN tree"
        )
    if _identity_of(h) != s1:
        reasons.append(
            "post-clean test gate binds a different source identity than "
            "the final forced HUNT -- a mutation between H and I breaks the "
            "chain"
        )

    for record in chain:
        meta = record.get("receipt_metadata") or {}
        stage = meta.get("stage")
        verdict = meta.get("verdict")
        allowed = STAGE_VERDICTS.get(stage, ())
        if verdict not in allowed:
            reasons.append(
                f"stage {stage} verdict {verdict!r} is not a closed "
                f"{STAGE_NAMES.get(stage, stage)} outcome ({', '.join(allowed)})"
            )

    attribution = tuple(attribution_problems(root, receipt_snapshot))
    if attribution:
        reasons.extend(attribution)

    return ConvergenceVerdict(
        not reasons,
        tuple(reasons),
        tuple(chain),
        source={"source_head": live[0], "source_tree_fingerprint": live[1]},
        attribution_problems=attribution,
    )
