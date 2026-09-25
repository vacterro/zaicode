"""Conformance Debt Ledger + Work Delta Gate (AUDAPACK T-172 / SAIPEN T-1301).

THE PROBLEM THIS SOLVES: the protocol had one binary project-wide rule --
strict Core validator RED means new Work can never complete. That is correct
for RELEASE and too coarse for ordinary convergence: honest, immutable
historical debt (pre-claim closure-evidence gaps, operator-only receipts,
credential-gated archives) otherwise permanently traps every future Work.

THE DISTINCTION, WITHOUT WEAKENING ANYTHING:

* STRICT project conformance (`validate --gate core`) is untouched. A
  finding is still a finding; nothing is downgraded, hidden or waived.
* A DEBT SNAPSHOT is an immutable, journaled, project+lineage+ruleset-bound
  record of the exact structured finding set at one checkpoint. Creating one
  closes nothing and turns nothing green (F4).
* The WORK DELTA GATE compares current structured findings against a trusted
  pre-work snapshot (CARRIED / RESOLVED / NEW / WORSENED / unsafe CHANGED).
  It PASSes only with zero NEW/WORSENED/unsafe-CHANGED problems, zero
  problems attributed to the Work or its source receipts, zero unattributed
  problems that cannot be proven carried, terminal source coverage for the
  Work, and green targeted verification.
* RELEASE stays stricter than Work convergence: any carried Core problem
  keeps release BLOCKED. `release_ready` is false whenever strict Core is
  red; a Work delta PASS report says so explicitly (G3/H).
* LEGACY BOOTSTRAP (J) adjudicates Work that predates the mechanism: a
  finding is carried only when canonical provenance proves its subject is
  unrelated to the target Work and predates the claim boundary. Target-Work,
  target-source, post-claim, global/unattributed and unprovable subjects all
  fail closed.

CREDENTIAL SAFETY: structured findings and debt snapshots never carry secret
values (findings.py drops message content for credential families; this
module stores only the classifier output).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import findings as findings_mod
from .journal import hash_bytes, run_mutation
from .paths import project_identity as _project_identity
from .paths import project_lineage_identity

DEBT_SCHEMA_VERSION = 1
DEBT_DIR = ".saipen/recovery/conformance/debt"
DEBT_ID_RE = re.compile(r"\ADEBT-(\d{6})\Z")
_VALIDATOR = Path(__file__).resolve().parent.parent / "validate.py"
REVERIFY_SCHEMA_VERSION = 1
REVERIFY_DIR = ".saipen/recovery/conformance/reverify"
REVERIFY_ID_RE = re.compile(r"\ARV-(\d{6})\Z")
VALIDATOR_CAPTURE_TIMEOUT = 1800
_SRC_RE = re.compile(r"\ASRC-\d+\Z")
_WORK_RE = re.compile(r"\AT-\d+\Z")
_EVENT_RE = re.compile(r"\AE-(\d+)\Z")


class DebtRefusal(Exception):
    """A structured, fail-closed refusal carrying its protocol code."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _sha_file(path: Path) -> str | None:
    try:
        return hash_bytes(path.read_bytes())
    except OSError:
        return None


# -- structured capture -------------------------------------------------


def _run_validator_capture(root: Path, gate: str, *, receipt: bool) -> dict:
    """Run the canonical validator ONCE and return its structured findings.

    ``receipt=True`` is the ordinary conformant capture: the validator emits
    its normal conformance receipt on exit (PASS or FAIL), exactly like any
    explicit validator execution.

    ``receipt=False`` is the explicit READ-ONLY capture used for dry-run
    planning (SRC-026:R004): the validator is launched with ``--no-receipt``
    and therefore performs ZERO project writes -- no conformance receipt, no
    index update, no recovery/journal artifact. The only extra output is the
    findings JSON side artifact, written OUTSIDE the project in a temp
    directory.

    Either way the validator stays read-only on project state and exit codes
    pass through unchanged: this capture can never turn a FAIL into a PASS.
    A capture failure returns ``ok: False`` -- never an empty finding set.
    """
    import tempfile

    with tempfile.TemporaryDirectory(prefix="saipen-debt-capture-") as tmp:
        out_path = Path(tmp) / "findings.json"
        command = [
            sys.executable,
            str(_VALIDATOR),
            "--project-root",
            str(root),
            "--gate",
            gate,
            "--findings-json",
            str(out_path),
        ]
        if not receipt:
            command.append("--no-receipt")
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=VALIDATOR_CAPTURE_TIMEOUT,
        )
        if not out_path.is_file():
            return {
                "ok": False,
                "code": "FINDINGS_CAPTURE_FAILED",
                "exit_code": completed.returncode,
                "detail": (completed.stderr or completed.stdout or "")[-500:],
            }
        try:
            doc = json.loads(out_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            return {
                "ok": False,
                "code": "FINDINGS_CAPTURE_MALFORMED",
                "detail": str(exc),
            }
    if doc.get("schema_version") != findings_mod.RULESET_VERSION:
        return {
            "ok": False,
            "code": "BASELINE_RULESET_CHANGED",
            "detail": f"validator emitted ruleset {doc.get('schema_version')!r}, "
            f"engine expects {findings_mod.RULESET_VERSION}",
        }
    if doc.get("ruleset_fingerprint") != findings_mod.ruleset_fingerprint():
        return {
            "ok": False,
            "code": "BASELINE_RULESET_CHANGED",
            "detail": "validator ruleset fingerprint does not match the engine classifier",
        }
    doc["ok"] = True
    doc["exit_code"] = completed.returncode
    return doc


def capture_findings(root: Path | str, *, gate: str = "core") -> dict:
    """Run the canonical validator once and return its structured findings.

    ORDINARY conformant capture: the validator emits its standard conformance
    receipt on every exit (PASS or FAIL), preserving the normal receipt
    contract for every explicit validator execution. This is the path used by
    real snapshot creation, the Work delta gate and re-verification.
    """
    return _run_validator_capture(Path(root), gate, receipt=True)


def _capture_findings_read_only(root: Path | str, *, gate: str = "core") -> dict:
    """Explicit internal READ-ONLY finding capture for dry-run planning.

    Launches the validator with ``--no-receipt``: zero project writes. The
    structured finding classification is IDENTICAL to an ordinary capture --
    same classifier, same ruleset fingerprint, same exit-code passthrough --
    so a dry-run preview reports the REAL finding set, never a fabricated
    empty one, and never emits a conformance receipt (PASS or FAIL).
    """
    return _run_validator_capture(Path(root), gate, receipt=False)


# -- snapshot -------------------------------------------------------------


def _debt_dir(root: Path) -> Path:
    return root / DEBT_DIR


def _existing_snapshots(root: Path) -> list[Path]:
    directory = _debt_dir(root)
    if not directory.is_dir():
        return []
    out = []
    for path in sorted(directory.glob("DEBT-*.json")):
        if path.is_file() and DEBT_ID_RE.match(path.stem):
            out.append(path)
    return out


def _next_snapshot_id(root: Path) -> str:
    numbers = [
        int(DEBT_ID_RE.match(path.stem).group(1)) for path in _existing_snapshots(root)
    ]
    return f"DEBT-{(max(numbers) + 1) if numbers else 1:06d}"


def _project_state_fingerprints(root: Path) -> dict:
    board = _sha_file(root / ".saipen/BOARD.md") or ""
    state = _sha_file(root / ".saipen/STATE.md") or ""
    log_digest = ""
    try:
        from .log import read_history_snapshot

        snapshot = read_history_snapshot(root, lean=True)
        log_digest = snapshot.hash
    except Exception:
        log_digest = _sha_file(root / ".saipen/LOG.md") or ""
    return {"board_sha256": board, "state_sha256": state, "log_fingerprint": log_digest}


def _source_identity(root: Path) -> dict:
    try:
        from freshness import compute_source_identity

        identity = compute_source_identity(root)
        return {
            "source_head": identity.source_head,
            "source_tree_fingerprint": identity.source_tree_fingerprint,
        }
    except Exception:
        return {"source_head": None, "source_tree_fingerprint": None}


def create_snapshot(
    root: Path | str,
    agent: str,
    reason: str,
    *,
    bound_work: str | None = None,
    dry_run: bool = False,
) -> dict:
    """Capture the current structured finding set as ONE immutable snapshot.

    With ``bound_work`` the snapshot additionally binds the Work as its
    pre-BUILD baseline: this is only accepted while the Work is the ACTIVE
    claim owned by ``agent`` and its phase is SCOUT -- the narrowest existing
    lifecycle point that guarantees the baseline predates BUILD mutations
    (Phase I). I1: when a baseline for the same Work already exists at the
    exact same source checkpoint and ruleset, it is REUSED, never rewritten.

    Creating a snapshot is NOT a pass: it closes no Work, turns no gate green
    and authorizes no release (F4).

    DRY-RUN PURITY (SRC-026:R004): with ``dry_run=True`` this function is a
    READ-ONLY PREVIEW and writes ZERO project bytes -- no lineage, no
    IDENTITY.md, no conformance receipt, no index, no settled journal, no
    lock. It reports the REAL structured finding set through the explicit
    internal ``--no-receipt`` validator capture, and fails closed (structured
    refusal) when that capture cannot determine the finding set.
    """
    root = Path(root)

    def _regulated_snapshot(
        capture: dict, reason: str, bound_work: str | None = None
    ) -> tuple[dict | None, str]:
        if not capture.get("ok"):
            return capture, "upstream"
        problems = capture.get("problems", [])
        warnings = capture.get("warnings", [])
        digest = findings_mod.findings_digest(problems, warnings)
        identity = _source_identity(root)
        existing = None
        for path in _existing_snapshots(root):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if record.get("bound_work") == (bound_work or None):
                if (
                    record.get("ruleset_version") == findings_mod.RULESET_VERSION
                    and record.get("findings_digest") == digest
                    and record.get("source_tree_fingerprint")
                    == identity["source_tree_fingerprint"]
                    and record.get("reason") == reason
                ):
                    existing = record
                    break
        if existing is not None:
            return (
                {
                    "ok": True,
                    "code": "DEBT_SNAPSHOT_REUSED",
                    "snapshot_id": existing.get("snapshot_id"),
                    "reuse": True,
                },
                "dedup",
            )
        return None, digest

    if dry_run:
        # =================================================================
        # READ-ONLY PREVIEW (SRC-026:R004): PLAN / DRY-RUN WRITES ZERO BYTES.
        #
        # Nothing in this branch may create lineage, write IDENTITY.md, emit
        # a conformance receipt, update a conformance index, create a settled
        # journal/index, run a mutation, acquire a project writer lock,
        # create a recovery directory or mutate STATE/BOARD/LOG/intake.
        # Finding capture runs the validator in the explicit --no-receipt
        # read-only mode; a capture failure returns the structured failed
        # capture (never zero findings, never a fall-through into APPLY).
        # =================================================================
        capture = _capture_findings_read_only(root)
        regulated, tagged = _regulated_snapshot(capture, reason, bound_work)
        if regulated is not None:
            preview = dict(regulated)
            preview.setdefault("writes", 0)
            preview["preview"] = True
            return preview
        problems = capture.get("problems", [])
        warnings = capture.get("warnings", [])
        digest = tagged
        if bound_work:
            guard = _bound_work_guard(root, bound_work, agent)
            if guard is not None:
                return {**guard, "preview": True}
        snapshot_id = _next_snapshot_id(root)
        return {
            "ok": True,
            "code": "DEBT_SNAPSHOT_PLAN",
            "snapshot_id": snapshot_id,
            "bound_work": bound_work,
            "problem_count": len(problems),
            "warning_count": len(warnings),
            "problems": problems,
            "warnings": warnings,
            "findings_digest": digest,
            "preview": True,
            "writes": 1,
        }

    # =====================================================================
    # MUTATING APPLY (SRC-026:R004): the ordinary journaled snapshot path.
    # Lineage stays authoritative, structured findings stay real, the
    # immutable debt snapshot is journaled, dedup stays intact and no release
    # gate is weakened.
    # =====================================================================
    from .journal import ensure_project_lineage

    # The lineage carrier must exist BEFORE the record is built, or the
    # snapshot would bind a phantom lineage (None) that no later load can
    # match (T-1003 fail-closed bootstrap).
    lineage = ensure_project_lineage(root)
    capture = capture_findings(root)
    regulated, tagged = _regulated_snapshot(capture, reason, bound_work)
    if regulated is not None:
        return regulated
    problems = capture.get("problems", [])
    warnings = capture.get("warnings", [])
    digest = tagged
    identity = _source_identity(root)

    snapshot_id = _next_snapshot_id(root)
    record = {
        "schema_version": DEBT_SCHEMA_VERSION,
        "snapshot_id": snapshot_id,
        "project_identity": _project_identity(root),
        "project_lineage": lineage,
        "created_at": _utc(),
        "validator_protocol_version": "1",
        "ruleset_version": findings_mod.RULESET_VERSION,
        "ruleset_fingerprint": findings_mod.ruleset_fingerprint(),
        "gate": capture.get("gate", "core"),
        "source_head": identity["source_head"],
        "source_tree_fingerprint": identity["source_tree_fingerprint"],
        **_project_state_fingerprints(root),
        "problem_count": len(problems),
        "warning_count": len(warnings),
        "problems": problems,
        "warnings": warnings,
        "findings_digest": digest,
        "reason": reason,
        "bound_work": bound_work,
        "bound_work_phase": None,
        "journal_op_id": None,
    }
    if bound_work:
        guard = _bound_work_guard(root, bound_work, agent)
        if guard is not None:
            return guard
        from .state import parse_state

        state = parse_state((root / ".saipen/STATE.md").read_text(encoding="utf-8"))
        record["bound_work_phase"] = state.get("phase")

    content = json.dumps(record, indent=2, sort_keys=True).encode("utf-8")
    rel = f"{DEBT_DIR}/{snapshot_id}.json"
    op_id = (
        "debt.snapshot-"
        + hash_bytes(
            f"{record['project_lineage']}|{snapshot_id}|{digest}".encode("utf-8")
        )[:12]
    )
    record["journal_op_id"] = op_id
    content = json.dumps(record, indent=2, sort_keys=True).encode("utf-8")
    committed = run_mutation(
        root,
        op_id=op_id,
        operation="debt.snapshot",
        agent=agent,
        project_identity=record["project_identity"],
        semantic_payload_hash=hash_bytes(
            json.dumps({"snapshot": snapshot_id, "digest": digest}, sort_keys=True).encode()
        ),
        targets=[
            {
                "path": rel,
                "role": "report",
                "action": "write",
                "content": content,
                "before_hash": "",
                "after_hash": hash_bytes(content),
            }
        ],
        preconditions={rel: ""},
        verification_policy="none",
    )
    if not committed.get("ok"):
        return {
            "ok": False,
            "code": committed.get("code", "VALIDATION_FAILED"),
            "detail": committed.get("detail", committed.get("message", "plan apply failed")),
        }
    return {
        "ok": True,
        "code": "DEBT_SNAPSHOT_CREATED",
        "snapshot_id": snapshot_id,
        "problem_count": len(problems),
        "warning_count": len(warnings),
        "problems": problems,
        "warnings": warnings,
        "bound_work": bound_work,
    }


def ensure_debt_baseline(root: Path | str, work: str, agent: str, utc: str) -> dict:
    """I1/I2: bind a fresh pre-BUILD structured receipt for future Work.

    Called at the SCOUT -> BUILD boundary, the narrowest lifecycle point that
    guarantees the baseline predates every BUILD mutation (Phase I). A fresh
    structured Core receipt for the exact same project checkpoint and ruleset
    is REUSED, never re-minted (I1). When the tree has already moved past the
    captured checkpoint, a fresh snapshot is created BEFORE this Work's first
    mutation, never pretended to be pre-work evidence (I2).
    """
    root = Path(root)
    existing = None
    for path in reversed(_existing_snapshots(root)):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if record.get("bound_work") != work:
            continue
        if record.get("ruleset_version") != findings_mod.RULESET_VERSION:
            continue
        if record.get("ruleset_fingerprint") != findings_mod.ruleset_fingerprint():
            continue
        existing = record
        break
    if existing is not None:
        return {
            "ok": True,
            "code": "DEBT_SNAPSHOT_REUSED",
            "snapshot_id": existing.get("snapshot_id"),
            "reuse": True,
        }
    return create_snapshot(
        root,
        agent,
        f"pre-BUILD debt baseline for {work}",
        bound_work=work,
    )


def _bound_work_guard(root: Path, bound_work: str, agent: str) -> dict | None:
    from .board import claim_status, parse_board
    from .state import parse_state

    if not _WORK_RE.match(bound_work or ""):
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": f"invalid Work {bound_work!r}"}
    try:
        board = parse_board((root / ".saipen/BOARD.md").read_text(encoding="utf-8-sig"))
        state = parse_state((root / ".saipen/STATE.md").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}
    ticket = board.get("tickets", {}).get(bound_work)
    if state.get("task") != bound_work or ticket is None or ticket.get("section") != "## DOING":
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"debt baseline for {bound_work} requires the Work to be the ACTIVE claim",
        }
    if claim_status(ticket, agent) != "SELF":
        return {
            "ok": False,
            "code": "TICKET_NOT_WORKABLE",
            "detail": f"{bound_work} is not claimed by {agent}; the baseline binds the "
            "implementing seat",
        }
    if state.get("phase") != "SCOUT":
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"debt baseline must be captured pre-BUILD (phase {state.get('phase')!r}); "
            "a baseline after mutations would grandfather post-change defects",
        }
    return None


def load_snapshot(root: Path | str, ref: str) -> dict:
    """Decode ONE debt snapshot fail-closed (F1/F2/F3 + K29)."""
    root = Path(root)
    if not DEBT_ID_RE.match(ref or ""):
        raise DebtRefusal("VALIDATION_FAILED", f"invalid snapshot id {ref!r}")
    path = _debt_dir(root) / f"{ref}.json"
    try:
        raw = path.read_bytes()
    except FileNotFoundError as exc:
        raise DebtRefusal("DEBT_SNAPSHOT_MISSING", f"{ref} does not exist") from exc
    except OSError as exc:
        raise DebtRefusal("DEBT_SNAPSHOT_CORRUPT", f"{ref} unreadable: {exc}") from exc
    try:
        record = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise DebtRefusal("DEBT_SNAPSHOT_CORRUPT", f"{ref} is not valid JSON: {exc}") from exc
    if not isinstance(record, dict) or record.get("schema_version") != DEBT_SCHEMA_VERSION:
        raise DebtRefusal("DEBT_SNAPSHOT_CORRUPT", f"{ref} has an unsupported schema")
    if record.get("snapshot_id") != ref:
        raise DebtRefusal("DEBT_SNAPSHOT_CORRUPT", f"{ref} names a different snapshot id")
    live_identity = _project_identity(root)
    if record.get("project_identity") != live_identity:
        raise DebtRefusal(
            "DEBT_SNAPSHOT_FOREIGN_PROJECT",
            f"{ref} was captured for {record.get('project_identity')!r}, not this project",
        )
    live_lineage = project_lineage_identity(root)
    if record.get("project_lineage") != live_lineage:
        raise DebtRefusal(
            "DEBT_SNAPSHOT_FOREIGN_LINEAGE",
            f"{ref} binds lineage {record.get('project_lineage')!r}; a copied .saipen "
            "directory never makes a baseline portable",
        )
    if record.get("ruleset_version") != findings_mod.RULESET_VERSION or record.get(
        "ruleset_fingerprint"
    ) != findings_mod.ruleset_fingerprint():
        raise DebtRefusal(
            "BASELINE_RULESET_CHANGED",
            f"{ref} was captured under ruleset {record.get('ruleset_version')!r} "
            f"({str(record.get('ruleset_fingerprint'))[:12]}); finding identity semantics "
            "changed, comparison would be silent guesswork",
        )
    try:
        digest = findings_mod.findings_digest(
            record.get("problems") or [], record.get("warnings") or []
        )
    except (TypeError, ValueError) as exc:
        raise DebtRefusal("DEBT_SNAPSHOT_CORRUPT", f"{ref} findings malformed: {exc}") from exc
    if digest != record.get("findings_digest"):
        raise DebtRefusal(
            "DEBT_SNAPSHOT_CORRUPT",
            f"{ref} findings fail their integrity digest (hand-edited or damaged)",
        )
    return record


# -- Work delta gate ------------------------------------------------------


def _safe_identity(finding: dict) -> dict:
    """Presentation-safe identity for reports: never any message content."""
    identity = {
        "severity": finding.get("severity"),
        "rule_id": finding.get("rule_id"),
        "subject_kind": finding.get("subject_kind"),
        "subject_id": finding.get("subject_id"),
        "finding_key": finding.get("finding_key"),
        "detail_hash": finding.get("detail_hash"),
    }
    # Attribution is DERIVED metadata, never identity: it is reported next to
    # a finding whose rule/subject/key were never rewritten (T-1315 / T-183 G).
    if finding.get("attributed_work"):
        identity["attributed_work"] = finding["attributed_work"]
    if finding.get("recovery_class"):
        identity["recovery_class"] = finding["recovery_class"]
    return identity


def _work_source_receipts(root: Path, work: str) -> set[str]:
    try:
        from .board import parse_board

        board = parse_board((root / ".saipen/BOARD.md").read_text(encoding="utf-8-sig"))
        ticket = board.get("tickets", {}).get(work)
        receipts = set()
        if ticket:
            raw_field = str(ticket.get("fields", {}).get("source_receipts") or "")
            for raw_token in raw_field.split(","):
                token = raw_token.strip()
                if token and _SRC_RE.match(token):
                    receipts.add(token)
        from . import intake

        index = intake._read_index(root)
        for receipt_id, meta in index.get("active", {}).items():
            meta_obj = intake._read_meta(root, receipt_id)
            if meta_obj and intake.is_linked_to(meta_obj, work):
                receipts.add(receipt_id)
        for receipt_id, tomb in index.get("tombstones", {}).items():
            if isinstance(tomb, dict) and work in (
                tomb.get("linked_works") or [tomb.get("linked_work")]
            ):
                receipts.add(receipt_id)
        return receipts
    except (OSError, ValueError):
        return set()


def _parse_log_stamp(stamp: str | None) -> str | None:
    """DD.MM.YY HH:MM -> ISO-8601 UTC (order-comparable)."""
    if not stamp:
        return None
    found = re.match(r"\A(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})", str(stamp).strip())
    if not found:
        return None
    day, month, year, hour, minute = found.groups()
    try:
        parsed = datetime(2000 + int(year), int(month), int(day), int(hour), int(minute))
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _claim_boundary(root: Path, boundary_event: str) -> dict:
    """Resolve an E-### claim boundary from live protocol history (J)."""
    found = _EVENT_RE.match(boundary_event or "")
    if not found:
        raise DebtRefusal("VALIDATION_FAILED", f"invalid claim boundary {boundary_event!r}")
    boundary_number = int(found.group(1))
    from .log import read_history_snapshot

    snapshot = read_history_snapshot(root, lean=True)
    events = {event["event"]: event for event in snapshot.events}
    boundary = events.get(boundary_number)
    if boundary is None:
        raise DebtRefusal(
            "VALIDATION_FAILED", f"claim boundary {boundary_event} is not in the canonical history"
        )
    return {
        "event": boundary_number,
        "stamp_iso": _parse_log_stamp(boundary.get("date")),
        "ticket": boundary.get("ticket"),
        "agent": boundary.get("agent"),
        "first_event": min(events),
    }


def _first_ticket_event(root: Path, work: str) -> int | None:
    from .log import read_history_snapshot

    snapshot = read_history_snapshot(root, lean=True)
    for event in snapshot.events:
        if event.get("ticket") == work:
            return event["event"]
    return None


def _receipt_timestamp(root: Path, receipt_id: str) -> str | None:
    """Best durable creation/closure timestamp for one source receipt."""
    from . import intake

    index = intake._read_index(root)
    if receipt_id in index.get("active", {}):
        meta = intake._read_meta(root, receipt_id)
        if meta:
            return meta.get("received_at")
    tomb = index.get("tombstones", {}).get(receipt_id)
    if isinstance(tomb, dict):
        if tomb.get("closed_at"):
            return tomb.get("closed_at")
        archive_meta = root / f".saipen/archive/source/{receipt_id}.meta.json"
        try:
            meta = json.loads(archive_meta.read_text(encoding="utf-8-sig"))
            return meta.get("received_at")
        except (OSError, ValueError):
            return None
    return None


def _iso_or_none(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def _legacy_eligibility(
    root: Path,
    finding: dict,
    boundary: dict,
    *,
    target_work: str,
    target_source: str | None,
) -> tuple[bool, str]:
    """J1/J2 provenance adjudication for one finding. Fail-closed."""
    rule_id = finding.get("rule_id")
    subject_kind = finding.get("subject_kind")
    subject_id = finding.get("subject_id")
    if rule_id in (None, "unclassified") or subject_kind in (None, "global") or not subject_id:
        return False, "unattributed/global problems are never carried without a measured baseline"
    if finding.get("credential"):
        # Credential families carry only safe identity; the SOURCE subject is
        # still adjudicated strictly below.
        pass
    if subject_kind == "work":
        if subject_id == target_work:
            return False, "subject is the target Work"
        if not _WORK_RE.match(subject_id):
            return False, f"non-canonical Work subject {subject_id!r}"
        first = _first_ticket_event(root, subject_id)
        if first is None:
            return False, f"Work {subject_id} has no canonical history appearance"
        if first >= boundary["event"]:
            # T-158 Stage 2 (D3/D6): a post-claim DONE Work that carries a
            # valid CURRENT-TREE PASS re-verification receipt is no longer an
            # "unverified DONE blocker". The receipt is machine-owned,
            # bound to this project/lineage/ruleset/tree checkpoint, and a
            # newer FAIL or any stale binding never counts (fail-closed).
            if rule_id == "work_closure_evidence":
                receipt = current_tree_reverify(root, subject_id)
                if receipt is not None:
                    return True, (
                        f"Work {subject_id} post-claim closure gap satisfied by "
                        f"{receipt['receipt_id']} ({receipt['verdict']}, current tree)"
                    )
            return False, (
                f"Work {subject_id} first appears at E-{first}, after claim boundary "
                f"E-{boundary['event']}"
            )
        return True, f"Work {subject_id} predates E-{boundary['event']} (first seen E-{first})"
    if subject_kind == "source":
        if not _SRC_RE.match(subject_id):
            return False, f"non-canonical source subject {subject_id!r}"
        if target_source and subject_id == target_source:
            return False, "subject is the target Work's source receipt"
        linked = _linked_work_of(root, subject_id)
        if linked == target_work:
            return False, "source receipt is linked to the target Work"
        # Recovered-terminal-source attribution (SAIPEN T-1315 / AUDAPACK
        # T-183): a TOMBSTONE_AUTHORITATIVE recovery leaves an intentionally
        # preserved invalid original Contract as permanent residue. Strict
        # Core keeps reporting it; the chronology below can never carry it
        # because the tombstone was journaled. The residue is attributable to
        # its PROVEN terminal linked Work only when the full fail-closed
        # proof holds -- this is attribution, never a waiver, and every
        # failed condition stays blocking.
        if rule_id == "source_receipt_closed_archive_invalid":
            from . import intake

            proof = intake.evaluate_terminal_recovered_source_attribution(
                root, subject_id
            )
            if proof.get("attributable"):
                proof_work = proof.get("linked_work")
                if proof_work == target_work:
                    return False, (
                        f"recovered source {subject_id} links to the target Work; "
                        "its residue remains blocking for the target"
                    )
                finding["attributed_work"] = proof_work
                finding["recovery_class"] = proof.get("recovery_class")
                return True, (
                    f"terminal recovered-source residue of {subject_id} attributed to "
                    f"its linked Work {proof_work} "
                    f"({proof.get('recovery_method')}, {proof.get('terminal')}/"
                    f"{proof.get('requirements')} terminal)"
                )
            return False, (
                f"recovered-source attribution refused: {proof.get('reason')} "
                f"{proof.get('detail', '')}".rstrip()
            )
        stamp = _iso_or_none(_receipt_timestamp(root, subject_id))
        if stamp is None:
            return False, f"source receipt {subject_id} has no comparable durable timestamp"
        if boundary["stamp_iso"] is None:
            return False, "claim boundary carries no comparable timestamp"
        if stamp >= boundary["stamp_iso"]:
            return False, (
                f"source receipt {subject_id} ({stamp}) was received at or after "
                "the claim boundary"
            )
        return True, f"source receipt {subject_id} received {stamp}, before E-{boundary['event']}"
    if subject_kind == "event":
        found = _EVENT_RE.match(subject_id)
        if not found:
            return False, f"non-canonical event subject {subject_id!r}"
        number = int(found.group(1))
        if number >= boundary["event"]:
            return False, (
                f"event {subject_id} is at or after the claim boundary "
                f"E-{boundary['event']}"
            )
        return True, f"event {subject_id} predates E-{boundary['event']}"
    return False, f"subject kind {subject_kind!r} cannot be proven pre-claim"


def _linked_work_of(root: Path, receipt_id: str) -> str | None:
    from . import intake

    index = intake._read_index(root)
    if receipt_id in index.get("active", {}):
        meta = intake._read_meta(root, receipt_id)
        if meta:
            return meta.get("linked_work")
    tomb = index.get("tombstones", {}).get(receipt_id)
    if isinstance(tomb, dict):
        return tomb.get("linked_work")
    try:
        meta = json.loads(
            (root / f".saipen/archive/source/{receipt_id}.meta.json").read_text(
                encoding="utf-8-sig"
            )
        )
        return meta.get("linked_work")
    except (OSError, ValueError):
        return None


def work_delta(
    root: Path | str,
    work: str,
    *,
    agent: str,
    baseline_ref: str | None = None,
    claim_boundary: str | None = None,
    verification: list[dict] | None = None,
    target_source: str | None = None,
    dry_run: bool = False,
) -> dict:
    """The Work convergence gate: no-new-regressions against trusted debt.

    Modes:
      * baseline: compare against a bound/typed debt snapshot (F/G);
      * legacy: retroactive adjudication against a claim boundary event (J) --
        every carried finding must be PROVEN pre-claim and unrelated, or the
        gate fails closed.

    A PASS never implies release readiness: the report carries strict_core,
    carried counts and release_ready explicitly (G3/H).
    """
    root = Path(root)
    if not _WORK_RE.match(work or ""):
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": f"invalid Work {work!r}"}
    try:
        current = capture_findings(root)
        if not current.get("ok"):
            return current
        baseline = None
        mode = None
        boundary = None
        if baseline_ref:
            baseline = load_snapshot(root, baseline_ref)
            if baseline.get("bound_work") not in (None, work):
                raise DebtRefusal(
                    "DEBT_SNAPSHOT_FOREIGN_WORK",
                    f"{baseline_ref} is bound to {baseline.get('bound_work')!r}, not {work}",
                )
            mode = "baseline"
        elif claim_boundary:
            boundary = _claim_boundary(root, claim_boundary)
            mode = "legacy"
        else:
            for path in reversed(_existing_snapshots(root)):
                try:
                    record = load_snapshot(root, path.stem)
                except DebtRefusal:
                    # A foreign/corrupt snapshot is that Work's problem, not
                    # this gate's: it must never silently become a baseline.
                    continue
                if record.get("bound_work") == work:
                    baseline = record
                    baseline_ref = record["snapshot_id"]
                    mode = "baseline"
                    break
            if baseline is None:
                raise DebtRefusal(
                    "DEBT_BASELINE_MISSING",
                    # T-1357: this used to name `saipen debt snapshot <T-###>`,
                    # which no CLI verb implements -- an instruction whose route
                    # does not exist is the same dead end as one the guard
                    # refuses. The baseline is captured automatically by
                    # `ensure_debt_baseline` on the SCOUT -> BUILD edge, so the
                    # two real routes are re-entering through SCOUT and the
                    # adjudication flag this message already named.
                    f"no debt baseline exists for {work}; it is captured "
                    "automatically when the Work enters BUILD from SCOUT, so "
                    "re-enter through SCOUT, or adjudicate legacy debt with "
                    "--claim-boundary",
                )

        current_problems = current.get("problems", [])
        current_warnings = current.get("warnings", [])
        carried, resolved, new, worsened, changed_unsafe = [], [], [], [], []
        blocking: list[dict] = []
        blocking_extra: list[dict] = []

        if mode == "baseline":
            base_problems = {f["finding_key"]: f for f in baseline.get("problems", [])}
            base_warning_keys = {f["finding_key"] for f in baseline.get("warnings", [])}
            for finding in current_problems:
                key = finding["finding_key"]
                if key not in base_problems:
                    if key in base_warning_keys:
                        # Same rule+subject existed as a warning pre-work and
                        # now FAILs: severity escalated. WORSENED, blocking.
                        worsened.append(finding)
                    else:
                        new.append(finding)
                    continue
                verdict = findings_mod.compare_finding(finding, base_problems[key])
                (carried if verdict == "CARRIED" else changed_unsafe).append(finding)
            for key, base_finding in base_problems.items():
                if key not in {f["finding_key"] for f in current_problems}:
                    resolved.append(base_finding)
            carried_warnings = [
                f for f in current_warnings if f["finding_key"] in base_warning_keys
            ]
            new_warnings = [
                f for f in current_warnings if f["finding_key"] not in base_warning_keys
            ]
        else:
            blocking_extra = []
            carried_warnings = []
            new_warnings = list(current_warnings)
            for finding in current_problems:
                eligible, reason = _legacy_eligibility(
                    root,
                    finding,
                    boundary,
                    target_work=work,
                    target_source=target_source,
                )
                if eligible:
                    carried.append(finding)
                else:
                    blocking_extra.append({**_safe_identity(finding), "reason": reason})

        # G2 attribution gates over CURRENT problems. D2 is absolute for
        # problems: an unattributed/global problem is NEVER automatically
        # harmless legacy debt for a Work gate -- it blocks in both modes
        # (a measured baseline keeps it visible as carried debt, never
        # harmless), and it keeps blocking release either way.
        work_receipts = _work_source_receipts(root, work)
        base_problem_values = (
            list(base_problems.values()) if mode == "baseline" else []
        )
        for finding in current_problems:
            subject = finding.get("subject_id")
            if finding.get("rule_id") in (None, "unclassified") or finding.get(
                "subject_kind"
            ) in (None, "global"):
                if finding in base_problem_values:
                    carried.append(finding)
                blocking_extra.append(
                    {
                        **_safe_identity(finding),
                        "reason": "unattributed/global problem remains blocking "
                        "(never carried as harmless)",
                    }
                )
            elif finding.get("subject_kind") == "work" and subject == work:
                blocking_extra.append(
                    {**_safe_identity(finding), "reason": f"problem attributed to Work {work}"}
                )
            elif finding.get("subject_kind") == "source" and subject in work_receipts:
                blocking_extra.append(
                    {
                        **_safe_identity(finding),
                        "reason": f"problem attributed to source receipt {subject} of {work}",
                    }
                )
        blocking += [
            {**_safe_identity(f), "reason": "NEW problem"}
            for f in new
        ] + [
            {**_safe_identity(f), "reason": "WORSENED: same subject/rule, semantic defect changed"}
            for f in worsened
        ] + [
            {**_safe_identity(f), "reason": "unsafe CHANGED problem"}
            for f in changed_unsafe
        ] + blocking_extra
        deduped: list[dict] = []
        seen: set[tuple[str | None, str]] = set()
        for entry in blocking:
            token = (entry.get("finding_key"), entry.get("reason"))
            if token in seen:
                continue
            seen.add(token)
            deduped.append(entry)
        blocking = deduped

        source_gate = None
        try:
            from . import intake

            source_gate = intake.work_closure_gate(root, work)
        except (OSError, ValueError) as exc:
            source_gate = {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}

        verification_problems = []
        for entry in verification or []:
            if entry.get("result") != "PASS":
                verification_problems.append(
                    {
                        "rule_id": "work_delta_verification",
                        "subject_kind": "work",
                        "subject_id": work,
                        "reason": f"targeted verification not PASS: {entry.get('command')}",
                    }
                )
        if not verification:
            verification_problems.append(
                {
                    "rule_id": "work_delta_verification",
                    "subject_kind": "work",
                    "subject_id": work,
                    "reason": "no targeted verification evidence supplied",
                }
            )

        blocking = verification_problems + blocking
        passed = (
            not new
            and not worsened
            and not changed_unsafe
            and not blocking
            and bool(source_gate and source_gate.get("ok"))
        )
        strict_problems = len(current_problems)
        strict_warnings = len(current_warnings)
        carried_problem_count = len(carried)
        carried_warning_count = len(carried_warnings)
        report = {
            "ok": True,
            "code": "WORK_DELTA_PASS" if passed else "WORK_DELTA_BLOCKED",
            "work": work,
            "mode": mode,
            "baseline": (
                {"snapshot_id": baseline["snapshot_id"], "captured_at": baseline.get("created_at")}
                if baseline
                else {
                    "mode": "legacy_bootstrap",
                    "claim_boundary": claim_boundary,
                    "boundary_event": f"E-{boundary['event']}" if boundary else None,
                }
            ),
            "strict_core": {
                "ok": current.get("exit_code") == 0,
                "problems": strict_problems,
                "warnings": strict_warnings,
            },
            "work_delta": "PASS" if passed else "FAIL",
            "release_ready": bool(current.get("exit_code") == 0 and strict_problems == 0),
            "carried_problems": carried_problem_count,
            "carried_warnings": carried_warning_count,
            "carried": [_safe_identity(f) for f in carried],
            "resolved": [_safe_identity(f) for f in resolved],
            "new": [_safe_identity(f) for f in new],
            "worsened": [_safe_identity(f) for f in worsened],
            "changed_unsafe": [_safe_identity(f) for f in changed_unsafe],
            "new_warnings": [_safe_identity(f) for f in new_warnings],
            "source_gate": {
                "ok": bool(source_gate and source_gate.get("ok")),
                "code": source_gate.get("code") if source_gate else None,
                "receipt": source_gate.get("receipt") if source_gate else None,
            },
            "verification": list(verification or []),
            "blocking": blocking,
        }
        return report
    except DebtRefusal as refusal:
        return {
            "ok": False,
            "code": refusal.code,
            "detail": refusal.detail,
            "work": work,
        }
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc), "work": work}


# Appended to tools/saipen_engine/debt.py: official DONE-Work re-verification.
# T-158 Stage 2 (AUDAPACK carrier T-176).

# ---------------------------------------------------------------------------
# T-158 Stage 2: official DONE-Work re-verification.
#
# A re-verification receipt is a first-class machine-owned record that says
# exactly one thing: "this already-DONE Work was checked again against this
# current tree." It never mutates the lifecycle (DONE stays DONE), never
# fabricates a VERIFY transition, never erases what happened at original
# completion, and never becomes closure evidence when its verdict is FAIL or
# its tree/lineage/project binding is stale.
# ---------------------------------------------------------------------------


def _reverify_dir(root):
    return Path(root) / REVERIFY_DIR


def _existing_reverify_receipts(root):
    directory = _reverify_dir(root)
    if not directory.is_dir():
        return []
    out = []
    for path in sorted(directory.glob("RV-*.json")):
        if path.is_file() and REVERIFY_ID_RE.match(path.stem):
            out.append(path)
    return out


def _next_reverify_id(root):
    numbers = [
        int(REVERIFY_ID_RE.match(path.stem).group(1))
        for path in _existing_reverify_receipts(root)
    ]
    return f"RV-{(max(numbers) + 1) if numbers else 1:06d}"


def load_reverify_receipt(root, receipt_id):
    """Decode ONE re-verification receipt fail-closed (binding + integrity)."""
    root = Path(root)
    if not REVERIFY_ID_RE.match(receipt_id or ""):
        raise DebtRefusal("VALIDATION_FAILED", f"invalid receipt id {receipt_id!r}")
    path = _reverify_dir(root) / f"{receipt_id}.json"
    try:
        raw = path.read_bytes()
    except FileNotFoundError as exc:
        raise DebtRefusal("REVERIFY_RECEIPT_MISSING", f"{receipt_id} does not exist") from exc
    except OSError as exc:
        raise DebtRefusal("REVERIFY_RECEIPT_CORRUPT", f"{receipt_id} unreadable: {exc}") from exc
    try:
        record = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise DebtRefusal(
            "REVERIFY_RECEIPT_CORRUPT", f"{receipt_id} is not valid JSON: {exc}"
        ) from exc
    if not isinstance(record, dict) or record.get("schema_version") != REVERIFY_SCHEMA_VERSION:
        raise DebtRefusal("REVERIFY_RECEIPT_CORRUPT", f"{receipt_id} has an unsupported schema")
    if record.get("receipt_id") != receipt_id:
        raise DebtRefusal("REVERIFY_RECEIPT_CORRUPT", f"{receipt_id} names a different receipt id")
    if record.get("project_identity") != _project_identity(root):
        raise DebtRefusal(
            "REVERIFY_RECEIPT_FOREIGN_PROJECT",
            f"{receipt_id} was captured for {record.get('project_identity')!r}, not this project",
        )
    if record.get("project_lineage") != project_lineage_identity(root):
        raise DebtRefusal(
            "REVERIFY_RECEIPT_FOREIGN_LINEAGE",
            f"{receipt_id} binds a foreign lineage; a copied .saipen directory never "
            "makes a receipt portable",
        )
    if record.get("ruleset_fingerprint") != findings_mod.ruleset_fingerprint():
        raise DebtRefusal(
            "BASELINE_RULESET_CHANGED",
            f"{receipt_id} was captured under a different ruleset; stale",
        )
    body = {k: v for k, v in record.items() if k != "integrity_digest"}
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if hash_bytes(canonical) != record.get("integrity_digest"):
        raise DebtRefusal("REVERIFY_RECEIPT_CORRUPT", f"{receipt_id} integrity digest mismatch")
    return record


def _last_ticket_event_id(root, work):
    """Highest `[E-###]` in the ACTIVE LOG bearing this exact ticket slot.

    The reverify receipt binds ORIGINAL implementation provenance: the receipt
    says "this already-DONE Work was checked again", so it has to name what
    closed it. The last ticket-bearing event is the bounded answer the active
    LOG can give without replaying sealed history.
    """
    try:
        text = (Path(root) / ".saipen/LOG.md").read_text(encoding="utf-8-sig")
    except OSError:
        return None
    pattern = re.compile(r"\[(E-(\d+))\][^\n]*\[" + re.escape(work) + r"\]")
    matches = [(int(match.group(2)), match.group(1)) for match in pattern.finditer(text)]
    return max(matches)[1] if matches else None


def _original_closure(ticket, root, work):
    """The preserved implementation/closure provenance of the DONE record."""
    fields = ticket.get("fields") or {}
    closure = {
        key: fields[key]
        for key in (
            "owner",
            "claim_time",
            "closure_mode",
            "source_receipts",
            "implementation_source",
            "implementation_delta",
            "superseded_by",
        )
        if fields.get(key)
    }
    event = _last_ticket_event_id(root, work)
    if event:
        closure["last_ticket_event"] = event
    return closure


def _run_verification_command(root, command, timeout):
    """Execute ONE verification command against the CURRENT tree.

    The receipt records an executed check with its real outcome and a digest
    of its bounded output -- never the output bytes themselves (findings, and
    therefore receipts, never carry captured content). A timeout or launch
    failure is an honest FAIL, never an absent check.
    """
    started = datetime.now(timezone.utc)
    if not str(command or "").strip():
        return {
            "command": str(command or ""),
            "result": "FAIL",
            "exit_code": None,
            "executed": True,
            "launch_error": "EMPTY_COMMAND",
            "duration_ms": 0,
            "output_digest": hash_bytes(b""),
            "output_bytes": 0,
        }
    try:
        completed = subprocess.run(
            command,
            shell=True,
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = (completed.stdout or "") + (completed.stderr or "")
        entry = {
            "command": command,
            "result": "PASS" if completed.returncode == 0 else "FAIL",
            "exit_code": completed.returncode,
            "executed": True,
        }
    except subprocess.TimeoutExpired:
        output = ""
        entry = {
            "command": command,
            "result": "FAIL",
            "exit_code": None,
            "executed": True,
            "timed_out": True,
        }
    except OSError as exc:
        output = str(exc)
        entry = {
            "command": command,
            "result": "FAIL",
            "exit_code": None,
            "executed": True,
            "launch_error": type(exc).__name__,
        }
    entry["duration_ms"] = int(
        (datetime.now(timezone.utc) - started).total_seconds() * 1000
    )
    entry["output_digest"] = hash_bytes(output.encode("utf-8", "replace"))
    entry["output_bytes"] = len(output)
    return entry


def _verification_contract_digest(entries, gate):
    """Identity of the CHECKS, not of their outcome.

    Same Work + same tree + same contract must be idempotent even though the
    recorded result is part of the receipt; a later run under the same
    contract on a different tree is a NEW receipt because the tree identity
    moved, never because the outcome string did.
    """
    material = [
        {
            "command": str(entry.get("command") or ""),
            "kind": "executed" if entry.get("executed") else "attested",
        }
        for entry in entries
    ]
    return hash_bytes(
        json.dumps({"gate": gate, "checks": material}, sort_keys=True).encode("utf-8")
    )


#: T-1434 M5.3: the evidence classes a reverify contract can carry. The class
#: is DERIVED from the entries, never accepted from a caller:
#:   executed  -- every check was really run by the engine (real exit codes);
#:   mixed     -- at least one check was executed, some are attested;
#:   attested  -- nothing was executed; the receipt records the caller's word.
#: Current-tree CLOSURE authority requires executable evidence: an attested-only
#: contract is honest recorded evidence and can never cure a closure gap
#: (`current_tree_reverify` refuses it), so typing PASS manufactures nothing.
EVIDENCE_CLASSES = ("executed", "mixed", "attested")


def evidence_class_of(record):
    """The evidence class of a receipt (or its entries), fail-closed.

    Receipts written before the field existed are DERIVED from their entries:
    any executed entry means executable evidence; no entries at all reads as
    attested because nothing proves an execution happened.
    """
    explicit = str(record.get("evidence_class") or "").strip()
    if explicit in EVIDENCE_CLASSES:
        return explicit
    entries = record.get("verification")
    if not isinstance(entries, list):
        return "attested"
    executed = sum(1 for entry in entries if isinstance(entry, dict) and entry.get("executed"))
    if executed and executed == len(entries):
        return "executed"
    if executed:
        return "mixed"
    return "attested"


def reverify_work(
    root,
    work,
    agent,
    *,
    verification=None,
    runs=None,
    timeout=300,
    derive_default=False,
    dry_run=False,
):
    """Official DONE-Work re-verification (T-158 Stage 2, T-1434 M1).

    Accepts ONLY Work currently under ## DONE -- other states own their normal
    lifecycle paths. Runs the strict validator, derives the structured
    findings for THIS tree, and writes an immutable journaled RV-NNNNNN
    receipt bound to project_identity + project_lineage + ruleset fingerprint
    + source checkpoint. DONE stays DONE before, during and after: no
    lifecycle edge, no synthetic VERIFY transition, no history rewrite.

    Evidence trust: the caller supplies targeted verification entries (each
    must be result=PASS) and/or ``runs`` -- commands the ENGINE executes
    against the current tree, recording real exit codes. ``derive_default``
    records the project's canonical strict gate itself as the executed
    contract, so the validator's own remediation is one command with no
    arguments. The receipt records the checks plus the findings digest so a
    later consumer can re-derive the same verdict. A FAIL verdict is recorded
    honestly and never becomes accepted closure evidence.

    Idempotency: a second identical invocation (same Work + same findings
    digest + same ruleset + same verification contract) returns the existing
    PASS receipt -- never a duplicate. A newer FAIL is never hidden behind an
    older PASS, and a new attempt after a FAIL writes a new receipt.
    """
    root = Path(root)
    verification = list(verification or [])
    runs = list(runs or [])
    # T-1434 M5.3: attested entries are TYPED in the receipt the same way the
    # CLI types them, whatever caller shape arrives -- a check is executable
    # evidence only when the engine ran it.
    for entry in verification:
        if not isinstance(entry, dict):
            return {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "verification entries must be objects",
            }
        entry.setdefault("executed", False)
        entry.setdefault("kind", "executed" if entry.get("executed") else "attested")
    if not _WORK_RE.match(work or ""):
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": f"invalid Work {work!r}"}
    try:
        from .board import parse_board

        board = parse_board((root / ".saipen/BOARD.md").read_text(encoding="utf-8-sig"))
        ticket = board.get("tickets", {}).get(work)
        if ticket is None:
            return {
                "ok": False,
                "code": "TICKET_NOT_FOUND",
                "detail": f"{work} is not on the board",
            }
        if ticket.get("section") != "## DONE":
            return {
                "ok": False,
                "code": "REVERIFY_REFUSED",
                "detail": f"{work} is under {ticket.get('section')}; only ## DONE Work "
                "accepts re-verification (other states own their lifecycle paths)",
            }
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}
    for entry in verification:
        if entry.get("result") != "PASS":
            return {
                "ok": False,
                "code": "REVERIFY_REFUSED",
                "detail": f"targeted verification not PASS: {entry.get('command')}",
            }
    if not verification and not runs and not derive_default:
        return {
            "ok": False,
            "code": "REVERIFY_REFUSED",
            "detail": "no targeted verification evidence supplied",
        }
    from .journal import ensure_project_lineage

    lineage = ensure_project_lineage(root)
    capture = capture_findings(root)
    if not capture.get("ok"):
        return capture
    problems = capture.get("problems", [])
    warnings = capture.get("warnings", [])
    findings_digest = findings_mod.findings_digest(problems, warnings)
    identity = _source_identity(root)
    gate = capture.get("gate", "core")
    own_problems = [
        f for f in problems if f.get("subject_kind") == "work" and f.get("subject_id") == work
    ]
    # The receipt is the CURE for the Work's own work_closure_evidence gap:
    # that one problem is exactly "DONE without current-cycle verification
    # evidence", and a valid reverify receipt satisfies it (D3). Excluding it
    # from the FAIL criterion is not a relaxation of strict Core (the problem
    # stays counted in problem_count and the digest, and stays visible until
    # this receipt exists); any OTHER problem attributed to the Work still
    # FAILs the receipt. Unfinished Work never reaches this code path.
    cured_own = [
        f
        for f in own_problems
        if f.get("rule_id") != "work_closure_evidence"
    ]
    executed = [_run_verification_command(root, command, timeout) for command in runs]
    entries = verification + executed
    verification_failed = any(entry.get("result") != "PASS" for entry in executed)
    if verification_failed:
        verdict = "FAIL"
    elif capture.get("exit_code") == 0:
        verdict = "PASS"
    elif not cured_own:
        verdict = "PASS_WITH_CARRIED_DEBT"
    else:
        verdict = "FAIL"
    if derive_default:
        entries = [
            *entries,
            {
                "command": f"strict_gate:{gate}",
                "result": (
                    verdict if verdict in ("PASS", "PASS_WITH_CARRIED_DEBT") else "FAIL"
                ),
                "executed": True,
                "default_contract": True,
            },
        ]
    evidence_class = evidence_class_of({"verification": entries})
    contract_digest = _verification_contract_digest(entries, gate)

    # Idempotency: newest matching receipt decides. The KEY is the current
    # TREE + the verification CONTRACT + the ruleset, never the findings
    # digest: the receipt itself is the cure for the Work's own
    # closure-evidence gap, so a successful reverify necessarily CHANGES the
    # next finding set -- keying on the digest would make a repaired tree look
    # like a new tree and mint duplicates forever. A FAIL is never reused (a
    # re-run after repair must mint new evidence), the CURRENT run's own
    # failure is never hidden behind an older PASS, and an older PASS is never
    # resurrected through a newer FAIL.
    if not verification_failed and verdict in ("PASS", "PASS_WITH_CARRIED_DEBT"):
        for path in reversed(_existing_reverify_receipts(root)):
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if existing.get("work") != work:
                continue
            if existing.get("ruleset_fingerprint") != findings_mod.ruleset_fingerprint():
                continue
            if existing.get("verification_contract_digest") != contract_digest:
                continue
            if (
                existing.get("source_head") != identity["source_head"]
                or existing.get("source_tree_fingerprint")
                != identity["source_tree_fingerprint"]
            ):
                continue
            if existing.get("verdict") in ("PASS", "PASS_WITH_CARRIED_DEBT"):
                return {
                    "ok": True,
                    "code": "REVERIFY_REUSED",
                    "receipt_id": existing.get("receipt_id"),
                    "verdict": existing.get("verdict"),
                    "evidence_class": evidence_class_of(existing),
                    "reuse": True,
                }
            break

    receipt_id = _next_reverify_id(root)
    now = _utc()
    record = {
        "schema_version": REVERIFY_SCHEMA_VERSION,
        "receipt_id": receipt_id,
        "work": work,
        "project_identity": _project_identity(root),
        "project_lineage": lineage,
        "ruleset_version": findings_mod.RULESET_VERSION,
        "ruleset_fingerprint": findings_mod.ruleset_fingerprint(),
        "source_head": identity["source_head"],
        "source_tree_fingerprint": identity["source_tree_fingerprint"],
        "created_at": now,
        "agent": agent,
        "verifier": agent,
        "verification": entries,
        "evidence_class": evidence_class,
        "verification_contract_digest": contract_digest,
        "verification_contract": {
            "gate": gate,
            "findings_digest": findings_digest,
            "commands": [str(entry.get("command") or "") for entry in entries],
        },
        "original_closure": _original_closure(ticket, root, work),
        "problem_count": len(problems),
        "warning_count": len(warnings),
        "findings_digest": findings_digest,
        "own_problem_keys": sorted(f["finding_key"] for f in own_problems),
        "verdict": verdict,
        "gate": gate,
    }
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")
    record["integrity_digest"] = hash_bytes(canonical)
    content = json.dumps(record, indent=2, sort_keys=True).encode("utf-8")
    rel = f"{REVERIFY_DIR}/{receipt_id}.json"
    if dry_run:
        return {
            "ok": True,
            "code": "REVERIFY_PLAN",
            "receipt_id": receipt_id,
            "work": work,
            "verdict": verdict,
            "evidence_class": evidence_class,
            "verification_contract_digest": contract_digest,
            "problem_count": len(problems),
            "warning_count": len(warnings),
        }
    op_id = "reverify." + hash_bytes(
        f"{lineage}|{work}|{findings_digest}|{contract_digest}".encode("utf-8")
    )[:12]
    record["journal_op_id"] = op_id
    content = json.dumps(record, indent=2, sort_keys=True).encode("utf-8")
    committed = run_mutation(
        root,
        op_id=op_id,
        operation="reverify.work",
        agent=agent,
        project_identity=record["project_identity"],
        semantic_payload_hash=hash_bytes(
            json.dumps(
                {
                    "receipt": receipt_id,
                    "work": work,
                    "digest": findings_digest,
                    "contract": contract_digest,
                },
                sort_keys=True,
            ).encode()
        ),
        targets=[
            {
                "path": rel,
                "role": "report",
                "action": "write",
                "content": content,
                "before_hash": "",
                "after_hash": hash_bytes(content),
            }
        ],
        preconditions={rel: ""},
        verification_policy="none",
    )
    if not committed.get("ok"):
        return {
            "ok": False,
            "code": committed.get("code", "VALIDATION_FAILED"),
            "detail": committed.get("detail", committed.get("message", "plan apply failed")),
        }
    return {
        "ok": True,
        "code": "WORK_REVERIFIED",
        "receipt_id": receipt_id,
        "work": work,
        "verdict": verdict,
        "evidence_class": evidence_class,
        "verification_contract_digest": contract_digest,
        "problem_count": len(problems),
        "warning_count": len(warnings),
    }


def latest_pass_reverify(root, work):
    """Newest PASS verdict receipt for ``work`` on THIS tree, or None.

    Receipts are scanned newest-first; the first one carrying a PASS or
    PASS_WITH_CARRIED_DEBT verdict whose project/lineage/ruleset bindings all
    match the live project wins. A newer FAIL for the same tree is NOT hidden
    behind an older PASS: the newest receipt is inspected first and a FAIL
    simply returns None (the caller treats the Work as unverified).
    """
    root = Path(root)
    for path in reversed(_existing_reverify_receipts(root)):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if record.get("work") != work:
            continue
        if record.get("project_identity") != _project_identity(root):
            continue
        if record.get("project_lineage") != project_lineage_identity(root):
            continue
        if record.get("ruleset_fingerprint") != findings_mod.ruleset_fingerprint():
            continue
        if record.get("verdict") in ("PASS", "PASS_WITH_CARRIED_DEBT"):
            return record
        return None  # newest receipt is a FAIL: never hide it behind an old PASS
    return None


def current_tree_reverify(root: Path | str, work: str) -> dict | None:
    """Closure-evidence view of ``latest_pass_reverify`` with a current-tree
    checkpoint check (T-158 Stage 2, D3).

    A PASS receipt counts as closure evidence ONLY when it was captured
    against THIS tree: project identity, lineage, ruleset and the current
    source fingerprint (HEAD + working-tree delta) must all match the live
    project. A receipt from an older checkpoint is stale evidence, never
    closure proof.

    T-1434 M5.3: the receipt must also carry EXECUTABLE evidence. An
    attested-only contract (``--verification cmd:PASS`` and no ``--run``)
    records the caller's word; it is honest evidence and stays visible in the
    receipt, but it never cures a current-tree closure gap, so typing PASS
    cannot manufacture conformance authority the evidence class does not
    prove.
    """
    root = Path(root)
    receipt = latest_pass_reverify(root, work)
    if receipt is None:
        return None
    if evidence_class_of(receipt) == "attested":
        return None
    identity = _source_identity(root)
    if (
        receipt.get("source_head") != identity["source_head"]
        or receipt.get("source_tree_fingerprint")
        != identity["source_tree_fingerprint"]
    ):
        return None
    return receipt
