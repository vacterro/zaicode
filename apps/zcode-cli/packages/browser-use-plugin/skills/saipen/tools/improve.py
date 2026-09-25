#!/usr/bin/env python
"""SAIPEN Improve mechanical core (T-551, T-554..T-560, NITRO M6 integrity).

The semantics live in saipen/IMPROVE.md; this module is the mechanical layer
that validates and writes the already-decided representation. It owns:

- deterministic, collision-safe cycle and seat admission;
- PATH-SAFE cycle/seat/report identity (no .., no separators, no absolute
  path, no newline/control injection, canonicalized and proven inside the
  owner root before any filesystem use);
- canonical report path resolution (never under the shared protocol install);
- report and finding schema validation (closed vocabularies);
- the Core-owned SWEEP ledger (dispositions, never written into reports);
- the derived visible status per SEAT, computed from roster + report + sweep.

Every mutation goes through the common lock + journal + roll-forward
machinery (NITRO M6) and PROPAGATES the transaction result: a public Improve
mutation never announces success unless the commit actually COMMITTED.
"""

from __future__ import annotations

from contextlib import nullcontext
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

# Report header fields (no machine-local path; identity is version + fingerprint).
# discovery_model is REQUIRED for strict reports only: the legacy pre-boundary
# reports predate the field, so the strict/legacy boundary lives where history
# needs it and never leaks into strict evidence (A5).
REQUIRED_HEADER = {
    "agent",
    "role",
    "model_or_runtime",
    "project",
    "saipen_version",
    "protocol_fingerprint",
    "source_head",
    "source_tree_fingerprint",
    "discovery_model",
    "context_scope",
    "context_available",
    "report_status",
}
_LEGACY_OPTIONAL_HEADER = frozenset({"discovery_model"})

SEVERITY = {"P0", "P1", "P2", "P3"}
FINDING_CLASS = {
    "PROTOCOL_VIOLATION",
    "PROJECT_VIOLATION",
    "LOGIC_ERROR",
    "ACCIDENTAL_SUCCESS",
    "USERPERSON_MISS",
    "VAGUE",
    "OTHER",
}
CONFIDENCE = {"observed", "reproduced", "proven", "suspected"}
ACTION = {"fix", "ticket", "note", "reject"}
REPORT_STATUS = {"draft", "complete"}
AVAILABILITY = {"expected", "unavailable", "superseded"}
ROLES = {"core", "critic"}

#: T-1434 M4: the closed cycle lifecycle. `active` is the only working state;
#: `complete` finished with every expected seat reported; `superseded` was
#: closed by reconciliation with seats canonically unavailable; `blocked_external`
#: was closed with an externally blocked seat recorded by `retire_reason`;
#: `archived` is the abort/retention state (cycle_aborted marks the abort).
TERMINAL_CYCLE_STATUSES = ("complete", "archived", "superseded", "blocked_external")
CYCLE_STATUS = ("active", *TERMINAL_CYCLE_STATUSES)

#: T-1434 M4: the closed per-seat reconciliation classification. Every roster
#: seat classifies into exactly one of these; each class is either terminal now
#: or names the one canonical action that makes it terminal.
SEAT_RECONCILE_CLASSES = (
    "CURRENT_COMPLETE",
    "SUPERSEDED",
    "CANONICALLY_UNAVAILABLE",
    "BLOCKED_EXTERNAL",
    "EMPTY_DRAFT",
    "STALE_COMPLETE",
    "STILL_ACTIONABLE",
)
_RETIRE_REASON_RE = re.compile(r"^[A-Z][A-Z0-9_-]{0,63}$")
DISPOSITION = {
    "CONFIRMED",
    "DUPLICATE",
    "ALREADY_FIXED",
    "SUPERSEDED",
    "LATER_RULE",
    "NOT_REPRODUCED",
    "INVALID",
    "NEEDS_EXTERNAL_EVIDENCE",
}

_MISSING = object()

_RUN_RE = re.compile(r"^## RUN (\d+)\s*$", re.MULTILINE)
_NO_FINDINGS_RE = re.compile(r"^NO_FINDINGS\b", re.MULTILINE)
# ONE finding reference grammar (DOGFOOD V, T-615): a composite finding is
# RUN-<N>/IMP-<NNN>; a legacy (pre-boundary) record is a bare IMP-<NNN>. The
# parser and the writer share exactly this pattern.

# The SWEEP ledger grammar, exactly as the consumers read it (DOGFOOD V,
# T-615): the finding_ref token carries RUN-N/IMP-NNN (strict schema) or a
# bare IMP-NNN (legacy cycles), and the `report=` identity on the same line
# completes the composite identity (cycle + seat/report + run + IMP id).
_SWEEP_LINE_RE = re.compile(
    r"^- (IMP-\d+|RUN-\d+/IMP-\d+)\s+\[([A-Z_]+)\]\s+(\S+)\s+"
    r"report=([^\s]+)\s+reproduced=(\S+)"
    r"(?:\s+fixed_by=(\S+))?(?:\s+verification=(\S+))?\s*$"
)

_IMP_DIR = ".saipen/improve"


@dataclass(frozen=True)
class Finding:
    """One parsed finding with its exact composite run identity.

    `run` is an int for an explicit `## RUN N` section, or None for a legacy
    (pre-boundary) report with no RUN sections. Two findings with the same
    IMP number in different RUNs are DIFFERENT findings.
    """

    run: int | None
    imp: str
    start: int
    severity: str
    cls: str
    confidence: str
    action: str
    expected: str
    actual: str
    evidence: str

    def ref(self) -> str:
        """Local finding reference: RUN-N/IMP-NNN, or bare IMP-NNN for legacy."""
        if self.run is None:
            return self.imp
        return f"RUN-{self.run}/{self.imp}"


@dataclass(frozen=True)
class ReportRuns:
    """The structural parse of a seat report: header + explicit RUN sections."""

    header: dict[str, str]
    findings: list[Finding]
    has_runs: bool
    runs: tuple[int, ...]
    no_findings_runs: frozenset[int]
    errors: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SweepRecord:
    """ONE structured sweep record shared by writer, parser, validator and
    status (DOGFOOD V, T-615). Never reconstructed from unrelated regexes."""

    finding_ref: str
    disposition: str
    ticket: str
    report: str
    reproduced: str
    fixed_by: str = "-"
    verification: str = "-"

    @property
    def legacy(self) -> bool:
        return "/" not in self.finding_ref

    def run(self) -> int | None:
        m = re.match(r"^RUN-(\d+)/", self.finding_ref)
        return int(m.group(1)) if m else None

    def imp(self) -> str:
        return self.finding_ref.split("/")[-1]

    def render(self) -> str:
        line = (
            f"- {self.finding_ref} [{self.disposition}] {self.ticket} "
            f"report={self.report} reproduced={self.reproduced}"
        )
        if self.fixed_by and self.fixed_by != "-":
            line += f" fixed_by={self.fixed_by}"
        if self.verification and self.verification != "-":
            line += f" verification={self.verification}"
        return line


class ImproveError(ValueError):
    """A rejected Improve mutation; carries the refusal reason.

    A caller that needs a stable machine-readable refusal (SRC-085 M2: an
    append_run body carrying its own RUN heading) may attach one; every other
    refusal keeps the historical message-only shape and the CLI reports it as
    VALIDATION_FAILED.
    """

    def __init__(self, message: str = "", *, code: str | None = None):
        super().__init__(message)
        self.code = code


def _validate_safe_id(value: str, kind: str) -> str:
    """Reject any identity that could escape the owner root or inject a
    field/newline. ONE shared primitive owns this: saipen_engine.safeid.
    (NITRO dogfood II -- no third sanitizer.)"""
    from saipen_engine.safeid import validate_safe_id as _shared

    try:
        return _shared(value or "", kind=kind)
    except ValueError as exc:
        raise ImproveError(str(exc)) from exc


def _validate_report_path(value: str, seat_id: str) -> str:
    """A report path must be a bare safe file name under the seat owner root."""
    return _validate_safe_id(value or "", "report_path")


def _validate_role(value: str) -> str:
    role = _validate_safe_id(value or "", "role")
    if role not in ROLES:
        raise ImproveError(f"role {role!r} outside {'|'.join(sorted(ROLES))}")
    return role


def seat_key(seat_id: str, agent: str = "") -> str:
    """One concrete audit seat, never a model family."""
    return seat_id.strip()


def cycle_id(project_key: str, now: str) -> str:
    """Deterministic unique cycle id: imp-<key>-<date>-<nn>.

    Kept for compatibility with the existing signature; new code MUST use
    allocate_cycle_id() which implements the actual deterministic allocator
    (NITRO dogfood II): the NN counter is derived from the existing cycles on
    disk, never smuggled in by the caller.
    """
    safe = re.sub(r"[^A-Za-z0-9_-]", "-", project_key).lower()
    return f"imp-{safe}-{now}"


def allocate_cycle_id(project_root: Path, project_key: str, now: str | None = None) -> str:
    """The real deterministic cycle-id allocator.

    Returns imp-<safe-project>-<YYYYMMDD>-<NN> where NN is one past the
    highest existing cycle number for this project prefix. Collision-safe by
    construction: two calls on the same tree yield different NN because the
    first committed MANIFEST is visible to the second scan. (NITRO dogfood II
    fixes the old contract that delegated uniqueness to the caller's `now`.)"""
    import datetime

    safe = re.sub(r"[^A-Za-z0-9_-]", "-", project_key).lower()
    if now is None:
        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d")
    prefix = f"imp-{safe}-{now}"
    owner = Path(project_root) / _IMP_DIR
    highest = 0
    if owner.is_dir():
        for entry in owner.iterdir():
            if not entry.is_dir():
                continue
            match = re.match(re.escape(prefix) + r"-(\d+)$", entry.name)
            if match:
                highest = max(highest, int(match.group(1)))
    return f"{prefix}-{highest + 1}"


def resolve_report_path(project_root: Path, cycle_id: str, seat_id: str, project_name: str) -> Path:
    """Canonical report path for a Core seat, proven inside the owner root."""
    seat = _validate_safe_id(seat_id, "seat_id")
    cycle = _validate_safe_id(cycle_id, "cycle_id")
    name = _validate_safe_id(project_name, "project_name")
    path = Path(project_root) / _IMP_DIR / cycle / seat / f"saipen_improve_{name}.md"
    _prove_inside(project_root, path)
    return path


def cycle_dir(project_root: Path, cycle_id: str) -> Path:
    cycle = _validate_safe_id(cycle_id, "cycle_id")
    root = Path(project_root)
    path = root / _IMP_DIR / cycle
    _prove_inside(root, path)
    return path


def _owner_root(project_root: Path) -> Path:
    return (project_root / _IMP_DIR).resolve()


def _prove_inside(project_root: Path, path: Path) -> None:
    """Canonicalize the owned path and prove it stays under the owner root.
    ONE shared primitive (saipen_engine.safeid.prove_inside) owns containment
    proof -- realpath + normcase, an escape raises rather than writes
    (NITRO dogfood II)."""
    from saipen_engine.safeid import prove_inside as _shared

    try:
        _shared(path, _owner_root(project_root), kind="Improve path")
    except ValueError as exc:
        raise ImproveError(str(exc)) from exc


def _read_maybe(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8-sig")


def _base_hash(path: Path) -> str:
    """The content-base hash a caller derived its plan from.

    Passed to _journaled_write so APPLY refuses STALE_STATE when the live
    file no longer matches the base the caller read -- stale content can
    never overwrite an intervening update (NITRO dogfood II)."""
    from saipen_engine.journal import hash_bytes

    try:
        return hash_bytes(path.read_bytes())
    except OSError:
        return ""


def _field(text: str, key: str) -> str:
    match = re.search(rf"(?m)^{key}:[ \t]*(.+)$", text)
    return match.group(1).strip() if match else ""


def _seat_block(text: str, seat_id: str) -> str | None:
    """Extract exactly ONE seat's roster block, structurally.

    Each seat's registration is a `seat_id: X` line followed by its
    role/report_path/availability lines until the next `seat_id:` line. The
    block is located by exact seat identity, never by the first field in the
    whole manifest.
    """
    lines = text.splitlines()
    start = None
    for index, line in enumerate(lines):
        if re.match(rf"^seat_id:\s*{re.escape(seat_id)}\s*$", line):
            start = index
            break
    if start is None:
        return None
    block = [lines[start]]
    for line in lines[start + 1 :]:
        if re.match(r"^seat_id:\s*", line):
            break
        block.append(line)
    return "\n".join(block)


def _block_for_report(
    roster_text: str, report_ident: str, seat_id: str | None = None
) -> str | None:
    """Locate the roster block whose report_path names `report_ident`.

    A seat is found by its registered report path -- never by deriving the
    seat from the report file name, which would break multi-seat rosters.
    """
    for block in _seat_blocks(roster_text):
        if _field(block, "report_path") == report_ident and (
            seat_id is None or _field(block, "seat_id") == seat_id
        ):
            return block
    return None


def _seat_blocks(text: str) -> list[str]:
    lines = text.splitlines()
    blocks: list[str] = []
    current: list[str] = []
    for line in lines:
        if re.match(r"^seat_id:\s*", line):
            if current:
                blocks.append("\n".join(current))
            current = [line]
        elif current:
            current.append(line)
    if current:
        blocks.append("\n".join(current))
    return blocks


def report_fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def composite_finding_ref(
    cycle_id: str, seat_id: str, report_ident: str, run: int | None, imp: str
) -> str:
    """The ONE canonical composite finding reference (DOGFOOD V, T-615):
    <cycle_id>/<seat_id>/<report_ident>#<RUN-N|legacy>/<IMP-NNN>.

    Used identically by the report parser, SWEEP writer/parser, derive_status,
    complete_cycle, the validator and BOARD source_reports resolution. No
    subsystem ever resolves provenance by a bare IMP-### substring."""
    local = f"RUN-{run}/{imp}" if run is not None else imp
    return f"{cycle_id}/{seat_id}/{report_ident}#{local}"


def _parse_finding_ref(ref: str) -> tuple[int | None, str]:
    """Split a finding reference into (run, IMP). Legacy refs yield None run."""
    if "/" in ref:
        m = re.fullmatch(r"RUN-(\d+)/IMP-(\d+)", ref)
        if not m:
            raise ImproveError(
                f"malformed finding reference {ref!r}: expected RUN-N/IMP-NNN or IMP-NNN"
            )
        return int(m.group(1)), f"IMP-{m.group(2)}"
    m = re.fullmatch(r"IMP-(\d+)", ref)
    if not m:
        raise ImproveError(
            f"malformed finding reference {ref!r}: expected RUN-N/IMP-NNN or IMP-NNN"
        )
    return None, f"IMP-{m.group(1)}"


def _finding_brackets(line: str) -> list[str]:
    return re.findall(r"\[([^\]]+)\]", line)


def parse_report(text: str) -> ReportRuns:
    """Structure a report into header + run-scoped findings (DOGFOOD V).

    A `## RUN N` section scopes its findings to that run. A report with no
    RUN sections is legacy: its findings are run-less and may only be swept by
    legacy sweep records. Every finding therefore carries its exact composite
    identity; no IMP-### floats unanchored.
    """
    header: dict[str, str] = {}
    # Header fields come ONLY from the top block (everything before the first
    # `## ` section heading): a finding's prose line that happens to start
    # with `report_status:` is evidence text, never a second header, and a
    # whole-text scan let the LAST occurrence win (T-630).
    _header_block = text.split("\n## ", 1)[0]
    for match in re.finditer(r"(?m)^([A-Za-z_]+):[ \t]*(.*)$", _header_block):
        header[match.group(1)] = match.group(2).strip()

    run_headers = list(re.finditer(_RUN_RE, text))
    has_runs = bool(run_headers)
    runs = tuple(int(m.group(1)) for m in run_headers)
    findings: list[Finding] = []
    no_findings_runs: set[int] = set()

    # Line offsets computed ONCE: text.find(line) returns the FIRST occurrence,
    # which misattributed RUN 2's findings to RUN 1 when both runs carry the
    # same IMP line (DOGFOOD V, T-615 -- reproduced and fixed here).
    _line_offsets: list[tuple[int, int, str]] = []
    _pos = 0
    for _raw in text.splitlines(keepends=True):
        _line_offsets.append((_pos, _pos + len(_raw), _raw))
        _pos += len(_raw)
    _line_offsets.append((_pos, _pos, ""))

    def _scan(segment_start: int, segment_end: int, run: int | None) -> None:
        segment = text[segment_start:segment_end]
        if run is not None and _NO_FINDINGS_RE.search(segment):
            no_findings_runs.add(run)
        current: dict | None = None
        for index, (_start, _end, line) in enumerate(_line_offsets[:-1], 1):
            if not (segment_start <= _start < segment_end):
                continue
            fm = re.match(r"^IMP-(\d+)", line)
            if fm:
                if current is not None:
                    findings.append(_finalize(current))
                current = {
                    "start": index,
                    "run": run,
                    "imp": f"IMP-{fm.group(1)}",
                    "brackets": _finding_brackets(line),
                }
                continue
            if current is not None:
                for fname in ("expected", "actual", "evidence"):
                    if re.match(rf"^[ \t]*{fname}:[ \t]*\S", line):
                        current[fname] = line.split(":", 1)[1].strip()
        if current is not None:
            findings.append(_finalize(current))

    def _finalize(raw: dict) -> Finding:
        brackets = raw.get("brackets", [])
        return Finding(
            run=raw.get("run"),
            imp=raw["imp"],
            start=raw["start"],
            severity=brackets[0] if len(brackets) > 0 else "",
            cls=brackets[1] if len(brackets) > 1 else "",
            confidence=brackets[2] if len(brackets) > 2 else "",
            action=brackets[3] if len(brackets) > 3 else "",
            expected=raw.get("expected", ""),
            actual=raw.get("actual", ""),
            evidence=raw.get("evidence", ""),
        )

    if not has_runs:
        _scan(0, len(text), None)
    else:
        bounds = [m.start() for m in run_headers]
        for idx, start in enumerate(bounds):
            end = bounds[idx + 1] if idx + 1 < len(bounds) else len(text)
            run_number = int(run_headers[idx].group(1))
            _scan(start, end, run_number)
    return ReportRuns(
        header=header,
        findings=findings,
        has_runs=has_runs,
        runs=runs,
        no_findings_runs=frozenset(no_findings_runs),
    )


def _sweep_records(sweep_text: str) -> list[SweepRecord]:
    """Parse every sweep record in the ledger with the ONE structured parser."""
    records = []
    for line in sweep_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = _SWEEP_LINE_RE.match(stripped)
        if not m:
            continue
        finding_ref, disp, ticket, report, reproduced = m.group(1, 2, 3, 4, 5)
        records.append(
            SweepRecord(
                finding_ref=finding_ref,
                disposition=disp,
                ticket=ticket,
                report=report,
                reproduced=reproduced,
                fixed_by=m.group(6) or "-",
                verification=m.group(7) or "-",
            )
        )
    return records


def _disposed_ids(sweep_text: str, report_ident: str | None = None) -> list[str]:
    """Every IMP-### with a disposition in the Core sweep ledger, optionally
    filtered to one report identity.

    FINDING IDENTITY IS COMPOSITE (NITRO dogfood II + DOGFOOD V, T-615): an
    IMP-### is not globally unique across seats OR runs. Coverage for report X
    counts ONLY records whose report identity equals X, and each record's run
    stays bound to its finding_ref -- one RUN's IMP-001 never satisfies
    another RUN's IMP-001."""
    disposed = []
    for record in _sweep_records(sweep_text):
        if report_ident is not None and record.report != report_ident:
            continue
        disposed.append(record.imp())
    return disposed


def derive_status(
    report_ident: str,
    roster_text: str,
    report_text: str,
    sweep_text: str,
    seat_id: str | None = None,
) -> dict:
    """The visible status, DERIVED per seat.

    - roster entry for THIS seat (exact seat_id block) owns availability;
    - the report owns report_status;
    - the sweep ledger owns dispositions, matched by EXACT composite identity.

    `swept` means EVERY finding requiring disposition has a final Core
    disposition FOR THIS REPORT AND THIS RUN -- a disposition against a
    different report's or different RUN's IMP-### is not coverage, and a bare
    appearance of the report identifier is not coverage either (DOGFOOD V,
    T-615: RUN-1/IMP-001 never satisfies RUN-2/IMP-001)."""
    _seat = re.sub(r"^saipen_improve_", "", Path(report_ident).stem)
    availability = "expected"
    if seat_id is None:
        owners = [
            _field(candidate, "seat_id")
            for candidate in _seat_blocks(roster_text)
            if _field(candidate, "report_path") == report_ident
        ]
        if len(owners) > 1:
            raise ImproveError(
                f"derive_status refuses ambiguous report basename "
                f"{report_ident!r}; pass exact seat_id"
            )
        if owners:
            seat_id = owners[0]
    block = _block_for_report(roster_text, report_ident, seat_id)
    if block is not None:
        availability = _field(block, "availability") or "expected"
    status = _field(report_text, "report_status")
    parsed = parse_report(report_text)
    expected = {(f.run, f.imp) for f in parsed.findings}
    ledger_keys = _report_ledger_keys(roster_text, seat_id, report_ident)
    disposed = {(r.run(), r.imp()) for r in _sweep_records(sweep_text) if r.report in ledger_keys}
    missing = sorted(
        f"{'' if f.run is None else f'RUN-{f.run}/'}{f.imp}"
        for f in parsed.findings
        if (f.run, f.imp) not in disposed
    )
    fully_swept = bool(expected) and not missing
    if availability == "unavailable":
        visible = "unavailable"
    elif availability == "superseded":
        visible = "superseded"
    elif not report_text:
        visible = "expected"
    elif status == "draft":
        visible = "draft"
    elif fully_swept:
        visible = "swept"
    else:
        visible = "complete"
    return {
        "availability": availability,
        "report_status": status,
        "visible": visible,
        "swept": fully_swept,
        "disposed": sorted({f"RUN-{r}/{i}" if r is not None else i for r, i in disposed}),
        "missing": missing,
    }


def _project_root_of(path: Path) -> Path:
    """The project root owning a path under .saipen/ (walk up to .saipen)."""
    cursor = path
    while cursor.parent != cursor.parent.parent and cursor.name != ".saipen":
        cursor = cursor.parent
    if cursor.name == ".saipen":
        return cursor.parent
    raise ImproveError(f"cannot resolve a project root for {path}")


def _freshness_errors(
    project_root: Path, report_text: str, strict: bool, cycle_active: bool, *, current_source=None
) -> list[str]:
    """Source-evidence freshness for a report (DOGFOOD V, T-619).

    A strict cycle's report is only fresh when its mechanically captured
    source_head + tree fingerprint match the CURRENT source identity. Same
    HEAD plus a changed/dirty tree is stale. Stale evidence can never
    authorize fresh canonical work without current reproduction.

    When current_source is supplied (a SourceIdentity from the caller's
    single snapshot), it is used directly instead of computing a fresh one.
    This avoids duplicate compute_source_identity calls inside a single
    semantic resume decision. When omitted, a fresh snapshot is computed.
    """
    errors: list[str] = []
    if not strict or not cycle_active:
        return errors
    head = _field(report_text, "source_head")
    tree = _field(report_text, "source_tree_fingerprint")
    if not head or not tree:
        errors.append(
            "report carries no mechanically captured source "
            "identity (source_head/source_tree_fingerprint)"
        )
        return errors
    if not re.match(r"^(git-delta-v1|no-git-tree-v1):", tree):
        errors.append(
            f"source_tree_fingerprint {tree!r} is not a mechanical "
            "fingerprint; a fabricated label cannot authorize fresh "
            "work"
        )
        return errors
    if current_source is not None:
        current = current_source
    else:
        try:
            from freshness import FreshnessError, compute_source_identity

            current = compute_source_identity(project_root)
        except FreshnessError as exc:
            errors.append(f"cannot compute the current source identity: {exc}")
            return errors
    if current.source_head not in (head, head[:7]):
        errors.append(
            f"source_head {head[:12]}... != current HEAD "
            f"{current.source_head[:12]}...; the audit did not "
            "reload the current tree"
        )
    elif current.source_tree_fingerprint != tree:
        errors.append(
            f"source_tree_fingerprint {tree[:24]}... != current "
            f"tree {current.source_tree_fingerprint[:24]}... at the "
            "same HEAD; the audited tree differs from the live one"
        )
    return errors


def _report_fresh(
    project_root: Path, cycle_dir: Path, report_ident: str, report_text: str, strict: bool
) -> list[str]:
    """Freshness errors for the report owning `report_ident` in this cycle."""
    if not strict:
        return []
    manifest = cycle_dir / "MANIFEST.md"
    active = _cycle_status(manifest) == "active"
    return _freshness_errors(project_root, report_text, strict, active)


def _ticket_exists(project_root: Path, ticket: str) -> bool:
    """Does the canonical ticket exist on the board or in any LOG segment?"""
    if not re.fullmatch(r"T-\d+", ticket):
        return False
    root = Path(project_root)
    board = root / ".saipen" / "BOARD.md"
    if board.is_file() and ticket in board.read_text(encoding="utf-8-sig"):
        return True
    logs = root / ".saipen" / "logs"
    log = root / ".saipen" / "LOG.md"
    paths: list[Path] = []
    if log.is_file():
        paths.append(log)
    if logs.is_dir():
        paths.extend(sorted(logs.glob("LOG-*.md")))
    return any(path.is_file() and ticket in path.read_text(encoding="utf-8-sig") for path in paths)


def _cycle_schema(manifest: Path) -> str:
    """The manifest schema: 'strict' when the manifest declares it, else
    'legacy' (the pre-boundary form the three historical cycles use)."""
    text = _read_maybe(manifest)
    if re.search(r"(?m)^manifest_schema:\s*strict\s*$", text):
        return "strict"
    return "legacy"


def _report_roster_block(cycle_dir: Path, report_ident: str) -> str | None:
    """The roster block owning `report_ident`, or None when no seat owns it."""
    manifest = cycle_dir / "MANIFEST.md"
    if not manifest.is_file():
        return None
    return _block_for_report(_read_maybe(manifest), report_ident)


def _report_ledger_keys(roster_text: str, seat_id: str | None, report_ident: str) -> set[str]:
    """Ledger identities resolving to one seat/report without basename bleed."""
    if not seat_id:
        return {report_ident}
    keys = {f"{seat_id}/{report_ident}"}
    owners = [
        _field(block, "seat_id")
        for block in _seat_blocks(roster_text)
        if _field(block, "report_path") == report_ident
    ]
    if owners == [seat_id]:
        keys.add(report_ident)  # Unique-owner compatibility for old ledgers.
    return keys


def _refuse_duplicate_owner_over_bare_sweep(
    cycle_dir: Path, roster_text: str, report_ident: str, new_seat: str
) -> None:
    """Preserve persisted legacy provenance when owner cardinality changes."""
    owners = [
        _field(block, "seat_id")
        for block in _seat_blocks(roster_text)
        if _field(block, "report_path") == report_ident
    ]
    sweep_text = _read_maybe(cycle_dir / "SWEEP.md")
    if owners and any(record.report == report_ident for record in _sweep_records(sweep_text)):
        raise ImproveError(
            f"cannot admit seat {new_seat}: report basename {report_ident!r} "
            "already has an existing bare SWEEP identity; adding a second "
            "owner would reinterpret Core provenance -- start independent "
            "seats before sweep or use a distinct report identity"
        )


def _resolve_report_owner(cycle_dir: Path, report_identity: str) -> tuple[str, str, str]:
    """Resolve `seat/report` exactly; permit basename only when unambiguous."""
    raw = report_identity.strip()
    parts = raw.split("/")
    if len(parts) == 2:
        wanted_seat = _validate_safe_id(parts[0], "seat_id")
        wanted_report = _validate_report_path(parts[1], wanted_seat)
    elif len(parts) == 1:
        wanted_seat = ""
        wanted_report = _validate_report_path(parts[0], "")
    else:
        raise ImproveError(
            f"report identity {raw!r} must be <seat>/<report> or one unambiguous legacy basename"
        )
    matches = []
    manifest_text = _read_maybe(cycle_dir / "MANIFEST.md")
    for block in _seat_blocks(manifest_text):
        seat = _field(block, "seat_id")
        report = _field(block, "report_path")
        if report == wanted_report and (not wanted_seat or seat == wanted_seat):
            matches.append((seat, report))
    if not matches:
        raise ImproveError(
            f"write_sweep_entry refuses: report {raw!r} is not a registered "
            "seat report in this cycle"
        )
    if len(matches) != 1:
        raise ImproveError(
            f"write_sweep_entry refuses: report basename {raw!r} has multiple "
            "seat owners; use exact <seat>/<report> identity"
        )
    seat, report = matches[0]
    # All NEW writes are seat-qualified. Bare report names remain read-only
    # compatibility for persisted pre-T-623 ledgers.
    ledger_key = f"{seat}/{report}"
    return seat, report, ledger_key


def _require_finding(
    cycle_dir: Path, seat_dir: str, report_ident: str, run: int | None, imp: str, strict: bool
) -> None:
    """A Core sweep mutation must name a finding that ACTUALLY exists in the
    named run of the named report (DOGFOOD V, T-615). A nonexistent
    finding/run/report is a refusal, not a ledger append."""
    report = cycle_dir / seat_dir / report_ident
    if not report.is_file():
        raise ImproveError(
            f"write_sweep_entry refuses: report {report_ident!r} does not exist on disk"
        )
    text = _read_maybe(report)
    if _field(text, "report_status") != "complete":
        raise ImproveError(
            f"write_sweep_entry refuses: report {report_ident!r} is not "
            "complete; only a complete report's findings may be disposed"
        )
    # T-638/§3: a sweep may only consume a FULLY VALID strict report -- a
    # malformed-but-parseable report with a real IMP must never authorize a
    # disposition (ZERO sweep writes on malformed evidence).
    if strict:
        _report_errors = validate_bound_report(
            cycle_dir, seat_dir, text, require_runs=True, require_fresh=False, cycle_active=True
        )
        if _report_errors:
            raise ImproveError(
                "write_sweep_entry refuses: report "
                f"{report_ident!r} fails the bound bar: " + "; ".join(_report_errors[:3])
            )
    parsed = parse_report(text)
    if strict:
        if not parsed.has_runs:
            raise ImproveError(
                f"write_sweep_entry refuses: report {report_ident!r} in a "
                "strict cycle carries no explicit ## RUN sections; a sweep "
                "must name the exact RUN"
            )
        if run is None:
            raise ImproveError(
                "write_sweep_entry refuses: a strict cycle sweep must name "
                "the exact RUN (RUN-N/IMP-NNN)"
            )
    matching = [f for f in parsed.findings if f.imp == imp and (run is None or f.run == run)]
    if not matching:
        target = f"RUN-{run}/{imp}" if run is not None else imp
        raise ImproveError(
            f"write_sweep_entry refuses: finding {target} does not exist in report {report_ident!r}"
        )
    if len(matching) > 1:
        target = f"RUN-{run}/{imp}" if run is not None else imp
        raise ImproveError(
            f"write_sweep_entry refuses: report {report_ident!r} carries "
            f"{len(matching)} findings with the ambiguous composite identity "
            f"{target}; one disposition can never satisfy duplicates -- "
            "repair or regenerate the report (A4)"
        )


def write_sweep_entry(cycle_dir: Path, entry: dict) -> dict:
    """Append a disposition to the Core-owned SWEEP ledger (journaled write).

    A Core sweep mutation validates BEFORE write (DOGFOOD V, T-615): the
    named cycle is active, the named seat/report exists, the report is
    complete, the named run exists, the named IMP exists in that exact run,
    the disposition and reproduced values are legal, the disposition/ticket
    relation is legal, and a CONFIRMED disposition names a canonical ticket
    that actually exists. Fictional findings can never COMMIT.

    Returns the transaction result; the caller MUST inspect it. An invalid
    disposition writes zero bytes.
    """
    disposition = entry.get("disposition")
    if disposition not in DISPOSITION:
        raise ImproveError(
            f"disposition {disposition!r} outside the closed set {sorted(DISPOSITION)}"
        )
    report_ident = str(entry.get("report", ""))
    if not report_ident or report_ident in ("-", ""):
        raise ImproveError(
            "write_sweep_entry refuses: report identity is required -- a "
            "sweep disposition must name its exact report"
        )
    strict = _cycle_schema(cycle_dir / "MANIFEST.md") == "strict"
    seat_dir, report_path, report_key = _resolve_report_owner(cycle_dir, report_ident)
    roster_text = _read_maybe(cycle_dir / "MANIFEST.md")
    equivalent_report_keys = _report_ledger_keys(roster_text, seat_dir, report_path)
    # DOGFOOD V (T-619): a CONFIRMED disposition on STALE evidence cannot
    # authorize fresh canonical work. The report's source identity must match
    # the current tree (same HEAD + dirty tree is stale); a stale report
    # demands current reproduction or a non-CONFIRMED disposition.
    if strict and disposition == "CONFIRMED":
        project_root = _project_root_of(cycle_dir)
        _rep = cycle_dir / seat_dir / report_path
        report_text = _read_maybe(_rep)
        fresh_errors = _freshness_errors(project_root, report_text, strict, True)
        if fresh_errors:
            raise ImproveError(
                "write_sweep_entry refuses CONFIRMED on stale evidence: "
                + "; ".join(fresh_errors)
                + " -- re-audit against the current tree (a new RUN carrying current "
                "authority) or dispose the finding historically without stale authority: "
                "SUPERSEDED when a fresh same-scope replacement reproduced it, "
                "NOT_REPRODUCED when it did not, binding the successor with "
                "--verification <cycle>/<seat>/<report>#<RUN-N/IMP-NNN>; stale CONFIRMED "
                "stays forbidden (T-619)"
            )
    run_raw = entry.get("run")
    imp_raw = str(entry.get("imp_id", ""))
    if re.fullmatch(r"\d+", imp_raw):
        imp_num = imp_raw
    elif re.fullmatch(r"IMP-(\d+)", imp_raw):
        imp_num = re.match(r"IMP-(\d+)", imp_raw).group(1)
    else:
        raise ImproveError(f"imp_id {imp_raw!r} is not IMP-###")
    imp_id = f"IMP-{imp_num}"
    run = None
    if run_raw is not None:
        run_m = re.fullmatch(r"(?:RUN-)?(\d+)", str(run_raw).strip())
        if not run_m:
            raise ImproveError(f"run {run_raw!r} is not RUN-<N>")
        run = int(run_m.group(1))
    elif strict:
        # A strict cycle's sweep must always carry the exact run.
        raise ImproveError(
            "write_sweep_entry refuses: a strict cycle sweep must name the exact RUN (run='RUN-1')"
        )
    finding_ref = f"RUN-{run}/{imp_id}" if run is not None else imp_id

    ledger = cycle_dir / "SWEEP.md"
    _prove_inside(_project_root_of(ledger), ledger)
    _require_cycle_active(cycle_dir, "write_sweep_entry")
    _require_finding(cycle_dir, seat_dir, report_path, run, imp_id, strict)

    reproduced = str(entry.get("reproduced", "-"))
    if reproduced not in {"y", "n"}:
        raise ImproveError(
            f"write_sweep_entry refuses: reproduced {reproduced!r} outside the closed set y|n"
        )
    ticket = str(entry.get("ticket", "-") or "-")
    if disposition == "CONFIRMED":
        if ticket == "-":
            raise ImproveError(
                "write_sweep_entry refuses: a CONFIRMED finding must name a "
                "canonical ticket; the ledger may not claim a ticket that "
                "does not exist"
            )
        if not _ticket_exists(_project_root_of(ledger), ticket):
            raise ImproveError(
                f"write_sweep_entry refuses: CONFIRMED names ticket "
                f"{ticket} which does not exist on the board or in any LOG "
                "segment -- a fictional ticket cannot authorize canonical "
                "work"
            )
    elif disposition in ("INVALID", "ALREADY_FIXED", "NOT_REPRODUCED"):
        if ticket != "-":
            raise ImproveError(f"write_sweep_entry refuses: {disposition} may not carry a ticket")
    elif ticket != "-" and not _ticket_exists(_project_root_of(ledger), ticket):
        raise ImproveError(
            f"write_sweep_entry refuses: ticket {ticket} does not exist on "
            "the board or in any LOG segment"
        )

    text = _read_maybe(ledger)
    if not text.startswith("# SWEEP"):
        text = "# SWEEP\n\n" + text
    # T-638/§3: a malformed EXISTING sweep ledger is never extended -- the new
    # disposition would compound the corruption and the post-write verifier
    # would discover predictable invalidity after bytes were written. ZERO
    # writes on a known-invalid base.
    _base_sweep_errors = validate_sweep(text)
    if _base_sweep_errors:
        raise ImproveError(
            "write_sweep_entry refuses to extend a malformed SWEEP ledger: "
            + "; ".join(_base_sweep_errors[:3])
            + " -- a known-INVALID base is never mutated (T-638)"
        )
    if any(
        r.finding_ref == finding_ref and r.report in equivalent_report_keys
        for r in _sweep_records(text)
    ):
        raise ImproveError(
            f"write_sweep_entry refuses: a disposition for "
            f"{finding_ref} in {report_key} already exists in the ledger"
        )

    record = SweepRecord(
        finding_ref=finding_ref,
        disposition=disposition,
        ticket=ticket,
        report=report_key,
        reproduced=reproduced,
        fixed_by=str(entry.get("fixed_by", "-") or "-"),
        verification=str(entry.get("verification", "-") or "-"),
    )
    proposed = text.rstrip() + "\n" + record.render() + "\n"
    # T-638/§2+§3: the PROPOSED sweep ledger must validate before journal.
    _proposed_sweep_errors = validate_sweep(proposed)
    if _proposed_sweep_errors:
        raise ImproveError(
            "write_sweep_entry refuses its own proposed SWEEP ledger: "
            + "; ".join(_proposed_sweep_errors[:3])
            + " -- a known-INVALID proposed state is never written (T-638)"
        )
    result = _journaled_write(ledger, proposed, "sweep", base_hash=_base_hash(ledger))
    if not result.get("ok"):
        raise ImproveError(
            f"sweep entry for {finding_ref} not committed: "
            f"{result.get('code')} {result.get('message', '')}"
        )
    return result


def _journaled_write(path: Path, content: str, kind: str, base_hash: str | None = None) -> dict:
    """Write one file through the common lock + journal + roll-forward
    machinery. Returns the transaction result; callers inspect and propagate.

    The target is a single ATOMIC_FILE transaction: one target, its own
    before/after hashes, staged exact bytes, post-write byte verification.

    CONTENT-BASE BINDING (NITRO dogfood II): the caller derived `content` from
    a specific base read of the file. That base's hash MUST be passed as
    `base_hash`; APPLY refuses STALE_STATE if the live file no longer matches
    it. No helper may silently refresh the before hash while preserving stale
    content -- a stale caller plan must never overwrite an intervening update.

    The journal carries the improve_atomic_file verification policy so
    recovery reruns the Improve semantic postcondition, not a silent None
    (NITRO dogfood III, T-594).
    """
    import uuid
    from saipen_engine import codec
    from saipen_engine.journal import _hash_file, hash_bytes, run_mutation
    from saipen_engine.lock import project_writer_lock

    root = path
    while root.parent != root.parent.parent and root.name != ".saipen":
        root = root.parent
    root = root.parent  # project root (parent of .saipen)
    rel = path.relative_to(root).as_posix()
    op_id = f"{kind}-" + uuid.uuid4().hex
    doc = codec.read_document(path)
    content_bytes = doc.encode(content)
    live = _hash_file(path) if path.is_file() else ""
    before = base_hash if base_hash is not None else live
    # TARGET ROLE (NITRO dogfood IV, T-601): the journal target must name the
    # DOMAIN the file belongs to (manifest/sweep/report), not a generic role,
    # so the target-aware semantic verifier validates the ACTUAL changed file
    # with the correct grammar -- a malformed SWEEP can never hide behind a
    # manifest-only scan, and APPLY + Recovery use one verifier.
    role = {
        "cycle": "manifest",
        "seat": "manifest",
        "sweep": "sweep",
        "run": "report",
        "rebind": "report",
    }.get(kind, "generic")
    with project_writer_lock(root):
        return run_mutation(
            root,
            op_id,
            kind,
            "saipen",
            _identity(root),
            hash_bytes(rel.encode("utf-8")),
            [
                {
                    "path": rel,
                    "role": role,
                    "content": content_bytes,
                    "before_hash": before,
                    "after_hash": hash_bytes(content_bytes),
                }
            ],
            preconditions={rel: before},
            verification_policy="improve_atomic_file",
        )


def _identity(root: Path) -> str:
    from saipen_engine.paths import project_identity

    return project_identity(root)


def _cycle_status(manifest: Path) -> str:
    """The lifecycle status of a cycle manifest, defaulting to active for
    legacy manifests that predate the explicit lifecycle field."""
    text = _read_maybe(manifest)
    match = re.search(r"(?m)^cycle_status:\s*([A-Za-z_]+)", text)
    return match.group(1) if match else "active"


class _ValidManifest:
    """One validated manifest snapshot (T-638/§1): text, its derived status,
    and its derived strictness all come from the SAME bytes that were
    validated -- no mutator may validate one read then decide on another."""

    __slots__ = ("path", "status", "strict", "text")

    def __init__(self, path: Path, text: str, status: str, strict: bool):
        self.path = path
        self.text = text
        self.status = status
        self.strict = strict


def load_valid_manifest(
    cycle_dir: Path, mutator: str, allowed_statuses: tuple[str, ...] = ("active",)
) -> _ValidManifest:
    """Read, validate, and snapshot a cycle manifest in ONE consistent pass
    (T-638/§1). The manifest is read once, validated against the directory
    identity, its status and strictness derived FROM THAT SAME TEXT, and an
    allowed-status gate is enforced. A known-INVALID base (missing, empty,
    wrong identity, broken grammar) is never mutated -- the caller receives a
    snapshot whose bytes it may extend, never a path to re-read."""
    manifest = cycle_dir / "MANIFEST.md"
    _prove_inside(_project_root_of(manifest), manifest)
    text = _read_maybe(manifest)
    if not text.strip():
        raise ImproveError(f"cycle manifest missing: {manifest}")
    _manifest_errors = validate_manifest(text, expected_cycle_id=cycle_dir.name)
    if _manifest_errors:
        raise ImproveError(
            f"{mutator} refuses an invalid active manifest: "
            + "; ".join(_manifest_errors[:3])
            + " -- a known-INVALID base is never mutated (T-638)"
        )
    status = _status_of(text)
    if status not in allowed_statuses:
        raise ImproveError(
            f"{mutator} refuses: cycle {cycle_dir.name} is {status}, not one "
            f"of {', '.join(allowed_statuses)}"
        )
    strict = _schema_of(text) == "strict"
    return _ValidManifest(manifest, text, status, strict)


def _status_of(text: str) -> str:
    """Lifecycle status derived from an already-loaded manifest TEXT."""
    match = re.search(r"(?m)^cycle_status:\s*([A-Za-z_]+)", text)
    return match.group(1) if match else "active"


def _schema_of(text: str) -> str:
    """Schema derived from an already-loaded manifest TEXT."""
    return "strict" if re.search(r"(?m)^manifest_schema:\s*strict\s*$", text) else "legacy"


def _require_cycle_active(cycle_dir: Path, mutator: str) -> Path:
    """Refuse any mutator on a cycle that is not ACTIVE (NITRO dogfood III,
    T-595). A completed/archived cycle is immutable under all normal writers.
    T-638/§7: the manifest consumed by any mutator MUST validate against its
    directory identity first -- a known-INVALID base is never read-and-mutated;
    ZERO writes on a base whose grammar/semantics are broken."""
    snapshot = load_valid_manifest(cycle_dir, mutator, ("active",))
    return snapshot.path


def installed_protocol_fingerprint(protocol_root: Path) -> str:
    """Derive the installed protocol fingerprint from MANIFEST-owned evidence
    (T-624 follow-up, T-992).

    The fingerprint surface is the ONE canonical inventory in
    `saipen/MANIFEST.json`: every `files[]` entry whose `src` lives under
    `saipen/` and is `required:true`, plus every `phase_docs.files[]` member.
    That set owns IMPROVE.md, SAICRITIC.md, CORE.md, MAINTENANCE.md, BOOT.md,
    STYLE.md and INDEX.md, so a change to any of them changes the fingerprint;
    it also means no freehand file list can drift from the manifest. A
    REQUIRED owned document that is missing on the installed host is a broken
    install -- the fingerprint REFUSES rather than hashing "whatever exists".

    Records are FRAMED, never naked-concatenated: each file contributes
    `relative_path` + `byte_length` + `raw_bytes`, emitted in deterministic
    sorted relative-path order. Framing makes the hash robust to a byte moving
    across a file boundary (the concatenated stream could be identical while
    the files changed) and to enumeration-order changes. The hash is
    content-plus-relative-identity only -- no absolute path, so the same
    protocol under two different directories fingerprints identically.

    Naming is deliberate: "installed" -- Python can prove the bytes installed
    on this host, not what an LLM cognitively read during a session.
    """
    import hashlib
    import json as _json

    root = Path(protocol_root)
    proto = next((p for p in (root / "saipen", root) if (p / "CORE.md").is_file()), None)
    if proto is None:
        raise ImproveError(
            f"cannot derive the installed protocol fingerprint: no CORE.md under {root}"
        )
    manifest = proto / "MANIFEST.json"
    if not manifest.is_file():
        raise ImproveError(
            "cannot derive the installed protocol fingerprint: "
            f"{manifest} is missing -- the manifest is the canonical "
            "protocol-evidence inventory"
        )
    try:
        inventory = _json.loads(manifest.read_text(encoding="utf-8-sig"))
    except ValueError as exc:
        raise ImproveError(
            "cannot derive the installed protocol fingerprint: "
            f"{manifest} is not valid JSON ({exc})"
        ) from exc
    rels = []
    for entry in inventory.get("files", []):
        src = entry.get("src", "")
        if (src.startswith("saipen/") or src.startswith("saipen\\")) and entry.get(
            "required", False
        ):
            rels.append(src.replace("\\", "/"))
    for phase in inventory.get("phase_docs", {}).get("files", []):
        rels.append(f"saipen/phases/{phase}")
    if not rels:
        raise ImproveError(
            "cannot derive the installed protocol fingerprint: "
            f"{manifest} declares no required saipen/ owned documents"
        )
    missing = [rel for rel in rels if not (proto / rel[len("saipen/") :]).is_file()]
    if missing:
        raise ImproveError(
            "cannot derive the installed protocol fingerprint: REQUIRED "
            "owned document(s) missing from the install: " + ", ".join(sorted(missing))
        )
    digest = hashlib.sha256()
    for rel in sorted(set(rels)):
        path = proto / rel[len("saipen/") :]
        raw = path.read_bytes()
        digest.update(rel.encode("utf-8"))
        digest.update(b"\n")
        digest.update(str(len(raw)).encode("ascii"))
        digest.update(b"\n")
        digest.update(raw)
    return "sha256:" + digest.hexdigest()


def _saipen_install_version() -> str:
    """The SAIPEN version executing Improve -- the INSTALL, never the target
    project (T-992/§3). The project's own VERSION is a different fact with a
    different owner and must never be written into `saipen_version`.
    """
    candidates = (
        Path(__file__).resolve().parent.parent / "VERSION",
        Path(__file__).resolve().parent.parent / "saipen" / "VERSION",
    )
    for candidate in candidates:
        if candidate.is_file():
            value = candidate.read_text(encoding="utf-8").strip()
            return value.split("\n")[0]
    raise ImproveError(
        "cannot derive the installed SAIPEN version: VERSION is missing from the SAIPEN install"
    )


def validate_strict_provenance(
    text: str,
    *,
    roster: str | None = None,
    manifest_project_identity: str | None = None,
    seat_id: str | None = None,
    installed_saipen_version: str | None = None,
    installed_protocol_fp: str | None = None,
) -> list[str]:
    """Validate a STRICT report's provenance identity (T-992/§2).

    Extends `validate_report(strict=True)` (which checks shape) with value
    semantics: every required identity scalar must be non-empty and free of
    CR/LF/control injection, unknown header fields are rejected, and every
    mechanically knowable identity -- agent vs seat, project vs manifest
    identity, saipen_version vs the INSTALLED version, protocol fingerprint
    vs the installed fingerprint -- must MATCH when the corresponding ground
    truth is supplied. Missing ground truth is an error (UNKNOWN is never
    FRESH), never a silent pass.

    Callers pass ground truth from the roster/manifest and the SAIPEN install;
    fixtures that build hand-crafted evidence pass nothing and get the
    structural checks only.
    """
    errors = []
    parsed = parse_report(text)
    header = parsed.header
    _hblock = text.split("\n## ", 1)[0]
    required = REQUIRED_HEADER
    for key in required:
        value = header.get(key, "")
        if not value or not value.strip():
            errors.append(f"report header field {key} must be non-empty")
        elif any(ch in value for ch in ("\r", "\n", "\x00", "\x1b")):
            errors.append(f"report header field {key} carries CR/LF/control characters")
    _unknown = sorted(set(_field_keys(_hblock)) - required)
    if _unknown:
        errors.append("report header carries unknown field(s): " + ", ".join(_unknown))
    if seat_id is not None:
        agent = header.get("agent", "")
        if agent != seat_id:
            errors.append(f"report agent {agent!r} != roster seat {seat_id!r}")
    if manifest_project_identity is not None:
        project = header.get("project", "")
        if project != manifest_project_identity:
            errors.append(
                f"report project {project!r} != manifest project_identity "
                f"{manifest_project_identity!r}"
            )
    if installed_saipen_version is not None:
        reported = header.get("saipen_version", "")
        if reported != installed_saipen_version:
            errors.append(
                f"report saipen_version {reported!r} != installed SAIPEN "
                f"version {installed_saipen_version!r}"
            )
    if installed_protocol_fp is not None:
        reported = header.get("protocol_fingerprint", "")
        if reported != installed_protocol_fp:
            errors.append(
                f"report protocol_fingerprint {reported!r} != installed "
                f"protocol fingerprint {installed_protocol_fp!r}"
            )
    return errors


def _field_keys(header_block: str) -> list[str]:
    """The distinct header keys present in a report's top block."""
    return sorted(
        {
            ln.split(":", 1)[0].strip()
            for ln in header_block.splitlines()
            if ":" in ln and not ln.startswith("#")
        }
    )


def validate_bound_report(
    cycle_dir: Path,
    seat_id: str,
    report_text: str,
    *,
    require_runs: bool = False,
    require_fresh: bool = False,
    cycle_active: bool = True,
    current_source=None,
) -> list[str]:
    """The ONE shared bound proof bar for a strict seat report (T-638/§6).

    Resolves ground truth itself from the validated cycle manifest (roster
    seat/role/report path, project_identity) and the SAIPEN install (version,
    protocol fingerprint), then requires the report to satisfy ALL of:

      - structural validity (validate_report, strict)
      - bound provenance (validate_strict_provenance with NON-optional truth:
        agent == roster seat, project == manifest identity, saipen_version ==
        installed, protocol_fingerprint == installed)
      - source freshness (when require_fresh, via _freshness_errors)

    NO optional ground truth: a bound validator either receives the real
    roster/install facts or it refuses. Historical COMPLETE/ARCHIVED evidence
    is validated structurally against its OWN stored cycle (require_fresh
    False) -- it is never retroactively compared to today's HEAD/install.

    Consumers: prepare resume, append_run base, complete_report proposed,
    write_sweep_entry, verify_cycle, complete_cycle, Improve status, and
    tools/validate.py's ACTIVE strict scan -- ONE bar, not per-consumer copies.
    """
    errors: list[str] = []
    if not seat_id:
        errors.append("bound report validation requires a roster seat_id")
        return errors
    manifest = cycle_dir / "MANIFEST.md"
    if not manifest.is_file():
        errors.append(f"cycle manifest missing: {manifest}")
        return errors
    roster_text = _read_maybe(manifest)
    _manifest_errors = validate_manifest(roster_text, expected_cycle_id=cycle_dir.name)
    if _manifest_errors:
        errors.append("invalid cycle manifest: " + "; ".join(_manifest_errors[:3]))
        return errors
    strict = _schema_of(roster_text) == "strict"
    block = _seat_block(roster_text, seat_id)
    if block is None:
        errors.append(f"seat {seat_id} is not registered on the roster")
        return errors
    roster_role = _field(block, "role")
    project_identity = _field(roster_text, "project_identity")
    errors += validate_report(report_text, require_runs=require_runs, strict=strict)
    try:
        installed_fp = installed_protocol_fingerprint(_protocol_root_for())
        installed_version = _saipen_install_version()
    except ImproveError as exc:
        errors.append(f"cannot derive installed provenance truth: {exc}")
        installed_fp = None
        installed_version = None
    if installed_fp is not None and installed_version is not None:
        # T-1434 M7.3: installed truth binds ACTIVE evidence only. A sealed
        # cycle (complete/archived/superseded/blocked_external) is historical
        # evidence validated against its OWN captured identity -- the install
        # moving after the cycle closed never retroactively invalidates it
        # (the same rule the validator's sealed scan and
        # _historical_bound_report_errors already apply).
        errors += validate_strict_provenance(
            report_text,
            roster=roster_text,
            manifest_project_identity=project_identity,
            seat_id=seat_id,
            installed_saipen_version=installed_version if cycle_active else None,
            installed_protocol_fp=installed_fp if cycle_active else None,
        )
        # role must match the roster binding, not just be closed.
        _r_role = _field(report_text, "role")
        if roster_role and _r_role != roster_role:
            errors.append(f"report role {_r_role!r} != roster role {roster_role!r}")
    if strict and require_fresh:
        errors += _freshness_errors(
            _project_root_of(cycle_dir),
            report_text,
            True,
            cycle_active,
            current_source=current_source,
        )
    return errors


def _protocol_root_for() -> Path:
    """The SAIPEN install home Improve runs from -- the parent of this tool."""
    return Path(__file__).resolve().parent.parent


def portable_project_key(project_root: Path) -> str:
    """A deterministic PORTABLE project identity (DOGFOOD V, T-618).

    `paths.project_identity()` is an absolute machine-local path and must
    never be persisted inside portable Improve evidence. This key is derived
    from the Git remote origin when present (owner/repo, machine-independent),
    else from the project directory name -- either way a slug safe for
    cycle_id derivation, with no drive letter or local mount leak.

    Scope note (T-1003 carrier-loss wave): this key is a HUMAN-READABLE
    Improve report slug, NOT the authoritative durable project identity. Two
    no-git projects sharing a folder name or two forks sharing a remote can
    collide here, and remotes can change, so it must never be used to bind
    recovery/evidence authority. Recovery and evidence bind to
    `paths.project_lineage_identity()` -- the tracked, random, durable
    `.saipen/IDENTITY.md` lineage that survives moves, clones and forks.
    """
    import subprocess

    root = Path(project_root)
    remote = ""
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "remote", "get-url", "origin"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode == 0:
            remote = result.stdout.decode("utf-8", "replace").strip()
    except (OSError, subprocess.SubprocessError):
        remote = ""
    if remote:
        base = remote.rstrip("/")
        if base.endswith(".git"):
            base = base[:-4]
        parts = [p for p in base.split("/") if p]
        tail = "/".join(parts[-2:]) if len(parts) >= 2 else base
    else:
        tail = root.name or "project"
    safe = re.sub(r"[^A-Za-z0-9_.-]", "-", tail)
    return safe.strip("-.").lower() or "project"


#: Header fields a DRAFT re-bind may re-derive. Assignment context fields
#: (agent, role, model_or_runtime, project, context_scope, context_available)
#: are decisions and are never re-derived -- only mechanically known identity.
_REBINDABLE_HEADER_KEYS = (
    "saipen_version",
    "protocol_fingerprint",
    "source_head",
    "source_tree_fingerprint",
    "discovery_model",
)


def _run_section_count(text: str) -> int:
    """The number of committed RUN sections in a report text."""
    return len(re.findall(r"(?m)^## RUN \d+\s*$", text))


def _un_audited_report(text: str) -> bool:
    """True only for a report that has committed ZERO audit content.

    A report with no `## RUN N` section is an assignment the engine minted,
    not evidence: no observation exists that a re-bind could rewrite. Any
    committed RUN makes the report audit evidence and forbids a re-bind.
    """
    return _run_section_count(text) == 0


def _rebind_un_audited_header(
    report_text: str,
    *,
    saipen_version: str,
    protocol_fp: str,
    source,
) -> str | None:
    """Re-derive the mechanical identity header of an un-audited DRAFT.

    Returns the rewritten report text, or None when nothing changes (the
    draft is already current) or when the header does not carry the full
    mechanical field set (a hand-crafted skeleton is never guessed at).
    Only lines that already exist are rewritten; body bytes and assignment
    context fields are preserved exactly.
    """
    values = {
        "saipen_version": saipen_version,
        "protocol_fingerprint": protocol_fp,
        "source_head": source.source_head,
        "source_tree_fingerprint": source.source_tree_fingerprint,
        "discovery_model": source.discovery_model,
    }
    lines: list[str] = []
    seen: set[str] = set()
    changed = False
    for line in report_text.splitlines(keepends=True):
        stripped = line.rstrip("\r\n")
        ending = line[len(stripped) :]
        key = stripped.split(":", 1)[0].strip() if ":" in stripped else ""
        if key in values and not stripped.startswith("#"):
            seen.add(key)
            replacement = f"{key}: {values[key]}"
            if stripped != replacement:
                changed = True
            lines.append(replacement + ending)
        else:
            lines.append(line)
    if set(values) - seen:
        return None
    if not changed:
        return None
    return "".join(lines)


def prepare_audit_seat(
    project_root: Path,
    *,
    agent_family: str,
    role: str,
    session_id: str | None,
    project_name: str,
    model_or_runtime: str,
    context_scope: str,
    protocol_fingerprint: str | None = None,
    context_available: str = "complete",
    dry_run: bool = False,
) -> dict:
    """Atomically admit or resume one concrete Improve seat.

    Active-cycle selection, seat allocation, roster registration and report
    creation share the existing project writer lock and one journaled
    multi-target mutation. An explicit session id is idempotent; no session id
    allocates a new independent <agent>-NN seat under the lock.

    A6: the public root is normalized ONCE at this entry (resolved absolute),
    so relative and absolute references to the same project behave identically
    everywhere below -- no scattered .resolve() patches in consumers.
    """
    import datetime
    import uuid
    from freshness import FreshnessError, compute_source_identity
    from saipen_engine.journal import (
        _hash_file,
        hash_bytes,
        scan_pending,
        recovery_preflight,
        run_mutation,
    )
    from saipen_engine.lock import project_writer_lock

    def _rv(payload: dict) -> dict:
        # In dry-run mode every returned result must carry the dry_run flag so
        # callers can distinguish a planned result from a committed one.
        if not dry_run:
            return payload
        payload = dict(payload)
        payload["dry_run"] = True
        return payload

    root = Path(project_root).resolve()
    selected_role = _validate_role(role)
    family = re.sub(r"[^A-Za-z0-9_-]", "-", agent_family).strip("-").lower()
    family = _validate_safe_id(family or "agent", "agent_family")
    # T-1013: the shared budget bounds a bare component; a caller that WRAPS
    # an ID into a longer filename enforces its own smaller derived budget so
    # the composed name stays inside every host's path-component limit.
    _name = _validate_safe_id(project_name, "project_name")
    _report_name = f"saipen_improve_{_name}.md"
    if len(_report_name.encode("utf-8")) > 255:
        raise ImproveError(
            f"project_name {_name!r} is too long for the composed report "
            f"filename saipen_improve_<name>.md"
        )
    report_ident = _report_name
    project_key = portable_project_key(root)

    # Dry-run is a plan-only, read-only query: it must not acquire the writer
    # lock (which materializes `.saipen/locks/core.lock`), must not roll a
    # pending recovery forward, and must not write any seat/manifest/report.
    # Use a no-op context so the read-only inspection below stays zero-write.
    _lock_ctx = nullcontext() if dry_run else project_writer_lock(root)
    with _lock_ctx:
        # Recovery runs before ANY decision: with no pending op it is a
        # zero-write no-op, and with a crash-left pending admission it is the
        # GOAL § 13 control-11 repair (roll forward), so a retry after an
        # admission crash resumes instead of being refused as missing
        # evidence. The refusal checks below therefore read the RECOVERED
        # state, and the admit plan is built from the post-recovery manifest,
        # so recovery can never be overwritten by a stale plan. A2: this is
        # documented precisely -- the command is never "zero-write before
        # recovery"; recovery_preflight may FINISH a previously authorized
        # pending operation (roll-forward), and only NEW mutation is refused
        # once a manifest is found invalid.
        if dry_run:
            # Plan-only mode: inspect recovery state READ-ONLY. Never roll a
            # pending operation forward merely to answer a dry-run query -- a
            # pending/conflict op would have to be applied before the real
            # mutation, so report the canonical structured recovery condition
            # with zero writes (T-1006 dry-run contract).
            _rp_pending, _rp_conflicts = scan_pending(root)
            _rp_corrupt = [op for op in _rp_pending if op.get("corrupt")]
            _rp_pending = [op for op in _rp_pending if not op.get("corrupt")]
            if _rp_conflicts:
                return _rv(
                    {
                        "ok": False,
                        "code": "RECOVERY_CONFLICT",
                        "op_ids": [op["op_id"] for op in _rp_conflicts],
                        "recovery_required": True,
                        "detail": f"unresolved conflict "
                        f"{_rp_conflicts[0]['op_id']} blocks admission; "
                        f"resolve it explicitly (saipen recover) before "
                        f"any further canonical write",
                    }
                )
            if _rp_corrupt:
                return _rv(
                    {
                        "ok": False,
                        "code": "CORRUPT_JOURNAL",
                        "op_ids": [op["op_id"] for op in _rp_corrupt],
                        "recovery_required": True,
                        "detail": f"corrupt journal evidence "
                        f"{_rp_corrupt[0]['op_id']} blocks admission: "
                        f"{_rp_corrupt[0].get('detail', '')} -- resolve "
                        f"the corrupt receipt explicitly before any "
                        f"further canonical write",
                    }
                )
            if _rp_pending:
                return _rv(
                    {
                        "ok": False,
                        "code": "RECOVERY_REQUIRED",
                        "op_ids": [op["op_id"] for op in _rp_pending],
                        "recovery_required": True,
                        "detail": "pending recovery operation(s) must be applied "
                        "before admission; dry-run does not roll them "
                        "forward",
                    }
                )
            preflight = {"ok": True}
        else:
            preflight = recovery_preflight(root)
        if not preflight.get("ok"):
            return _rv(preflight)

        owner = _owner_root(root)
        active = []
        if owner.is_dir():
            active = sorted(
                manifest
                for manifest in owner.glob("*/MANIFEST.md")
                if _cycle_status(manifest) == "active"
            )
        if len(active) > 1:
            raise ImproveError("multiple ACTIVE Improve cycles exist; refuse ambiguous admission")

        created_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if active:
            manifest = active[0]
            active_cycle = manifest.parent.name
            manifest_text = _read_maybe(manifest)
        else:
            active_cycle = allocate_cycle_id(root, project_key)
            manifest = cycle_dir(root, active_cycle) / "MANIFEST.md"
            manifest_text = (
                "# IMPROVE CYCLE ROSTER\n\n"
                "manifest_schema: strict\n"
                f"cycle_id: {active_cycle}\n"
                f"created_at: {created_at}\n"
                f"project_identity: {project_key}\n"
                "cycle_status: active\n"
            )

        # A2: before ANY seat allocation, admission, unavailable handling or
        # resume, the active manifest MUST validate against its own directory
        # identity. An invalid active manifest is never consumed or mutated --
        # zero new mutation, evidence byte-identically preserved.
        _manifest_errors = validate_manifest(manifest_text, expected_cycle_id=active_cycle)
        if _manifest_errors:
            return _rv(
                {
                    "ok": False,
                    "code": "INVALID_MANIFEST",
                    "cycle_id": active_cycle,
                    "detail": "active Improve manifest is invalid; refuse "
                    "any admission/admission/resume against it: " + "; ".join(_manifest_errors[:3]),
                }
            )
        _strict_manifest = bool(re.search(r"(?m)^manifest_schema:\s*strict\s*$", manifest_text))

        if session_id is not None:
            seat = _validate_safe_id(session_id, "session_id")
        else:
            highest = 0
            for block in _seat_blocks(manifest_text):
                candidate = _field(block, "seat_id")
                match = re.fullmatch(re.escape(family) + r"-(\d+)", candidate)
                if match:
                    highest = max(highest, int(match.group(1)))
            seat = f"{family}-{highest + 1:02d}"

        block = _seat_block(manifest_text, seat)
        report = resolve_report_path(root, active_cycle, seat, project_name)
        if block is not None:
            roster_role = _field(block, "role")
            roster_report = _field(block, "report_path")
            availability = _field(block, "availability") or "expected"
            # T-630: an existing roster seat's state is a decision, not a
            # blank slate, and every refusal below is decided READ-ONLY,
            # BEFORE any journal recovery or mutation -- zero bytes are
            # written, no pending op is rolled forward to mask the refusal.
            # Unavailable/superseded are roster decisions prepare does not
            # override, whatever the rest of the block says.  A superseded
            # COMPLETE report is immutable history whose replacement is a
            # different concrete seat.
            if availability in {"unavailable", "superseded"}:
                code = "SEAT_UNAVAILABLE" if availability == "unavailable" else "SEAT_SUPERSEDED"
                replacement = _field(block, "replacement_seat")
                return _rv(
                    {
                        "ok": False,
                        "code": code,
                        "cycle_id": active_cycle,
                        "seat_id": seat,
                        "role": selected_role,
                        "report_path": report.relative_to(root).as_posix(),
                        "replacement_seat": replacement,
                        "detail": f"session {seat} is {availability} on the "
                        "roster; prepare does not override that historical decision",
                    }
                )
            if roster_role != selected_role:
                raise ImproveError(
                    f"session {seat} is registered as role {roster_role!r}, not {selected_role!r}"
                )
            if roster_report != report_ident:
                raise ImproveError(
                    f"session {seat} owns report {roster_report!r}, not {report_ident!r}"
                )
            if not report.is_file():
                return _rv(
                    {
                        "ok": False,
                        "code": "SEAT_EVIDENCE_MISSING",
                        "cycle_id": active_cycle,
                        "seat_id": seat,
                        "role": selected_role,
                        "report_path": report.relative_to(root).as_posix(),
                        "detail": f"session {seat} is registered but its "
                        "report is missing; an existing seat's "
                        "evidence cannot be recreated by prepare -- "
                        "recover any pending journaled admission or "
                        "use the abort/discard/recovery lifecycle if "
                        "replacement is intentional",
                    }
                )
            try:
                report_text = _read_maybe(report)
            except (UnicodeDecodeError, OSError) as _rd_exc:
                return {
                    "ok": False,
                    "code": "INVALID_REPORT",
                    "cycle_id": active_cycle,
                    "seat_id": seat,
                    "role": selected_role,
                    "report_path": report.relative_to(root).as_posix(),
                    "detail": f"session {seat} report cannot be decoded "
                    f"({type(_rd_exc).__name__}); cannot resume",
                }
            _header_block = report_text.split("\n## ", 1)[0]
            _status_lines = [
                ln for ln in _header_block.splitlines() if ln.startswith("report_status:")
            ]
            if len(_status_lines) != 1:
                return {
                    "ok": False,
                    "code": "INVALID_REPORT",
                    "cycle_id": active_cycle,
                    "seat_id": seat,
                    "role": selected_role,
                    "report_path": report.relative_to(root).as_posix(),
                    "detail": f"session {seat} report carries "
                    f"{len(_status_lines)} report_status "
                    "fields; cannot resume",
                }
            _report_violations = validate_report(report_text, strict=_strict_manifest)
            if _report_violations:
                return {
                    "ok": False,
                    "code": "INVALID_REPORT",
                    "cycle_id": active_cycle,
                    "seat_id": seat,
                    "role": selected_role,
                    "report_path": report.relative_to(root).as_posix(),
                    "detail": f"session {seat} report is invalid and not "
                    "resumable: " + "; ".join(_report_violations[:3]),
                }
            report_role = _field(report_text, "role")
            if report_role != roster_role:
                raise ImproveError(
                    f"session {seat} roster/report role mismatch: "
                    f"{roster_role!r} != {report_role!r}"
                )
            report_status = _field(report_text, "report_status")
            if report_status == "complete":
                # A complete report is immutable only when it is REALLY
                # complete: the strict schema requires explicit RUN evidence,
                # so a runless skeleton cannot be classified SEAT_COMPLETE.
                _strict_violations = validate_report(
                    report_text, require_runs=True, strict=_strict_manifest
                )
                if _strict_violations:
                    return {
                        "ok": False,
                        "code": "INVALID_REPORT",
                        "cycle_id": active_cycle,
                        "seat_id": seat,
                        "role": selected_role,
                        "report_path": report.relative_to(root).as_posix(),
                        "detail": f"session {seat} report declares "
                        "complete without run evidence: " + "; ".join(_strict_violations[:3]),
                    }
                return _rv(
                    {
                        "ok": False,
                        "code": "SEAT_COMPLETE",
                        "cycle_id": active_cycle,
                        "seat_id": seat,
                        "role": selected_role,
                        "report_path": report.relative_to(root).as_posix(),
                        "resumed": False,
                        "detail": "report is complete and immutable; this audit is not resumable",
                        "next": f"list unswept findings with `saipen improve "
                        f"sweep-queue {active_cycle}`, dispose each "
                        f"with `saipen improve sweep {active_cycle} "
                        f"<RUN-N/IMP-NNN> <DISPOSITION>`, then "
                        f"`saipen improve verify {active_cycle}` and "
                        f"`saipen improve cycle-complete "
                        f"{active_cycle}`; a new audit requires a new "
                        "session",
                    }
                )
            if report_status != "draft":
                return {
                    "ok": False,
                    "code": "INVALID_REPORT",
                    "cycle_id": active_cycle,
                    "seat_id": seat,
                    "role": selected_role,
                    "report_path": report.relative_to(root).as_posix(),
                    "detail": f"session {seat} report carries unexpected "
                    f"report_status {report_status!r}; only a "
                    "single exact `report_status: draft` is "
                    "resumable, and nothing replaces it",
                }
            # A1: a DRAFT seat may resume only while its mechanical source
            # identity still matches the CURRENT source identity. A tracked
            # source change between prepare and retry makes the old report
            # evidence for a tree that no longer exists -- resuming would
            # bind stale evidence to fresh work. Refuse structured, zero
            # writes, no silent rebase and no provenance rewrite; the
            # lifecycle out (a new seat/cycle against the current tree) is
            # made explicit.
            try:
                _current_src = compute_source_identity(root)
            except FreshnessError as exc:
                return {
                    "ok": False,
                    "code": "STALE_REPORT",
                    "cycle_id": active_cycle,
                    "seat_id": seat,
                    "role": selected_role,
                    "report_path": report.relative_to(root).as_posix(),
                    "resumed": False,
                    "detail": f"cannot verify source freshness before "
                    f"resume: {exc}; refuse to bind a DRAFT to "
                    "an unverifiable source",
                }
            # T-1406: a DRAFT with ZERO committed RUN sections is an
            # assignment, not evidence. When its mechanical identity header
            # went stale (an install update or a tracked source change between
            # admission and resume) the canonical exit is an in-place,
            # journaled re-bind of ONLY the mechanically known header fields;
            # assignment context (agent/role/model/scope) is never touched and
            # no RUN byte exists to rewrite. A draft with any committed RUN is
            # evidence and is never re-bound -- it keeps the structured
            # refusals below, and a seat that can never continue is retired
            # through `saipen improve retire`.
            _header_rebound = False
            _previous_fp = ""
            _previous_head = ""
            if _un_audited_report(report_text):
                try:
                    _rebind_fp = installed_protocol_fingerprint(_protocol_root_for())
                    _rebind_version = _saipen_install_version()
                except ImproveError:
                    _rebind_fp = _rebind_version = None
                if _rebind_fp is not None and _rebind_version is not None:
                    _rebound = _rebind_un_audited_header(
                        report_text,
                        saipen_version=_rebind_version,
                        protocol_fp=_rebind_fp,
                        source=_current_src,
                    )
                    if _rebound is not None:
                        _previous_fp = _field(report_text, "protocol_fingerprint")
                        _previous_head = _field(report_text, "source_head")
                        if dry_run:
                            return _rv(
                                {
                                    "ok": True,
                                    "code": "DRY_RUN_PLAN",
                                    "action": "rebind",
                                    "cycle_id": active_cycle,
                                    "seat_id": seat,
                                    "role": selected_role,
                                    "report_path": report.relative_to(root).as_posix(),
                                    "resumed": False,
                                    "targets": [report.relative_to(root).as_posix()],
                                    "detail": "planned un-audited draft header "
                                    "re-bind against the installed protocol "
                                    "and current source; no writes",
                                }
                            )
                        _rebind_rel = report.relative_to(root).as_posix()
                        _rebind_result = run_mutation(
                            root,
                            "improve-rebind-" + uuid.uuid4().hex,
                            "improve_rebind",
                            seat,
                            _identity(root),
                            hash_bytes(f"{active_cycle}:{seat}:rebind".encode("utf-8")),
                            [
                                {
                                    "path": _rebind_rel,
                                    "role": "report",
                                    "content": _rebound,
                                }
                            ],
                            preconditions={_rebind_rel: _hash_file(report)},
                            skip_preflight=True,
                            verification_policy="improve_atomic_file",
                        )
                        if not _rebind_result.get("ok"):
                            return {
                                "ok": False,
                                "code": "REBIND_FAILED",
                                "cycle_id": active_cycle,
                                "seat_id": seat,
                                "role": selected_role,
                                "report_path": report.relative_to(root).as_posix(),
                                "resumed": False,
                                "detail": "un-audited draft header re-bind did "
                                "not commit: "
                                f"{_rebind_result.get('code')} "
                                f"{_rebind_result.get('message', '')}",
                            }
                        report_text = _rebound
                        _header_rebound = True
            _r_model = _field(report_text, "discovery_model")
            _r_head = _field(report_text, "source_head")
            _r_tree = _field(report_text, "source_tree_fingerprint")
            if (
                re.match(r"^(git-delta-v1|no-git-tree-v1):", _r_tree) is None
                or (_r_model and _current_src.discovery_model != _r_model)
                or _current_src.source_head not in (_r_head, _r_head[:7])
                or _current_src.source_tree_fingerprint != _r_tree
            ):
                return {
                    "ok": False,
                    "code": "STALE_REPORT",
                    "cycle_id": active_cycle,
                    "seat_id": seat,
                    "role": selected_role,
                    "report_path": report.relative_to(root).as_posix(),
                    "resumed": False,
                    "detail": "the project source identity changed since "
                    "this DRAFT report was captured; resuming "
                    "under the old identity would bind stale "
                    "evidence to fresh work -- capture a new "
                    "seat/cycle against the current tree (or "
                    "regenerate the draft) instead of resuming. "
                    "An un-audited draft is re-bound automatically; "
                    "this one already carries committed RUN evidence, "
                    "which is never re-bound -- if this seat can never "
                    "continue, retire it with `saipen improve retire "
                    "<cycle> <seat> --reason <CODE>` and complete the "
                    "cycle with the remaining seats",
                    "current_source_head": _current_src.source_head,
                    "current_discovery_model": _current_src.discovery_model,
                }
            # T-638/§5: forged provenance must never round up to a resumable
            # seat -- before ANY ALREADY_ASSIGNED result, the report must
            # satisfy the FULL bound bar: structural + roster-bound provenance
            # (agent == roster seat, project == manifest identity, version and
            # fingerprint == installed) + source freshness. All three or no
            # resume.
            _bound_errors = validate_bound_report(
                manifest.parent,
                seat,
                report_text,
                require_runs=False,
                require_fresh=True,
                cycle_active=True,
                current_source=_current_src,
            )
            if _bound_errors:
                return {
                    "ok": False,
                    "code": "INVALID_REPORT",
                    "cycle_id": active_cycle,
                    "seat_id": seat,
                    "role": selected_role,
                    "report_path": report.relative_to(root).as_posix(),
                    "resumed": False,
                    "detail": f"session {seat} report fails the bound "
                    f"provenance bar: " + "; ".join(_bound_errors[:3])
                    + " -- a draft with committed RUN evidence is never "
                    "re-bound; if this seat can never continue, retire it "
                    "with `saipen improve retire <cycle> <seat> --reason "
                    "<CODE>` and complete the cycle with the remaining "
                    "seats",
                }
            _assigned = {
                "ok": True,
                "code": "ALREADY_ASSIGNED",
                "cycle_id": active_cycle,
                "seat_id": seat,
                "role": selected_role,
                "report_path": report,
                "report_created": False,
                "resumed": True,
                "source_head": _field(report_text, "source_head"),
                "source_tree_fingerprint": _field(report_text, "source_tree_fingerprint"),
                "discovery_model": _field(report_text, "discovery_model"),
            }
            if _header_rebound:
                _assigned["header_rebound"] = True
                _assigned["previous_protocol_fingerprint"] = _previous_fp
                _assigned["previous_source_head"] = _previous_head
            return _rv(_assigned)
        else:
            _refuse_duplicate_owner_over_bare_sweep(
                manifest.parent, manifest_text, report_ident, seat
            )
            seat_line = (
                f"seat_id: {seat}\nrole: {selected_role}\n"
                f"report_path: {report_ident}\n"
                "availability: expected\n"
            )
            new_manifest = manifest_text.rstrip() + "\n" + seat_line

        try:
            source = compute_source_identity(root)
        except FreshnessError as exc:
            raise ImproveError(f"cannot capture mechanical source identity: {exc}") from exc
        saipen_version = _saipen_install_version()
        # T-638/§4: the writer DERIVES the protocol fingerprint from the
        # installed protocol -- a caller-supplied digest is never accepted as
        # truth. If the caller passed one, it must equal the installed value
        # or the admission refuses.
        _installed_fp = installed_protocol_fingerprint(_protocol_root_for())
        if protocol_fingerprint and protocol_fingerprint != _installed_fp:
            raise ImproveError(
                "prepare_audit_seat refuses: the supplied protocol "
                "fingerprint does not match the installed protocol -- "
                "mechanical identity is derived, never caller-supplied "
                "(T-638/§4)"
            )
        protocol_fingerprint = _installed_fp
        report_text = (
            f"agent: {seat}\n"
            f"role: {selected_role}\n"
            f"model_or_runtime: {model_or_runtime}\n"
            f"project: {project_key}\n"
            f"saipen_version: {saipen_version}\n"
            f"protocol_fingerprint: {protocol_fingerprint}\n"
            f"source_head: {source.source_head}\n"
            f"source_tree_fingerprint: {source.source_tree_fingerprint}\n"
            f"discovery_model: {source.discovery_model}\n"
            f"context_scope: {context_scope}\n"
            f"context_available: {context_available}\n"
            "report_status: draft\n"
        )

        # A5: the writer's own output must satisfy the strict report contract
        # before it is committed -- a writer that can emit a report the
        # validator rejects would mint evidence the consumers must then
        # refuse. One canonical field set, parity-tested at write time.
        _writer_violations = validate_report(report_text, strict=True)
        # T-992/§2: provenance identity must match current installed truth --
        # agent/version/fingerprint are mechanically knowable, and the writer
        # proves its own output against them, never trusting the caller.
        _writer_violations += validate_strict_provenance(
            report_text,
            roster=manifest_text,
            manifest_project_identity=project_key,
            seat_id=seat,
            installed_saipen_version=saipen_version,
            installed_protocol_fp=protocol_fingerprint,
        )
        if _writer_violations:
            return _rv(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "cycle_id": active_cycle,
                    "seat_id": seat,
                    "role": selected_role,
                    "report_path": report.relative_to(root).as_posix(),
                    "detail": "prepared report fails its own strict contract: "
                    + "; ".join(_writer_violations[:3]),
                }
            )

        if dry_run:
            # Plan-only: every deterministic validation above already ran;
            # answer what WOULD happen without materializing any path.
            return _rv(
                {
                    "ok": True,
                    "code": "IMPROVE_AUDIT_ASSIGNMENT",
                    "cycle_id": active_cycle,
                    "seat_id": seat,
                    "role": selected_role,
                    "report_path": report,
                    "report_created": False,
                    "resumed": False,
                    "source_head": source.source_head,
                    "source_tree_fingerprint": source.source_tree_fingerprint,
                    "discovery_model": source.discovery_model,
                    "plan": {
                        "cycle": active_cycle,
                        "seat": seat,
                        "role": selected_role,
                        "report_path": report.relative_to(root).as_posix(),
                        "would_create_cycle": block is None and not (owner.is_dir() and active),
                        "would_create_manifest": block is None,
                        "would_create_report": True,
                        "would_resume_existing_seat": False,
                        "source_identity": source.source_head,
                    },
                }
            )
        manifest_rel = manifest.relative_to(root).as_posix()
        report_rel = report.relative_to(root).as_posix()
        targets = []
        preconditions = {}
        if block is None:
            targets.append({"path": manifest_rel, "role": "manifest", "content": new_manifest})
            preconditions[manifest_rel] = _hash_file(manifest)
        targets.append({"path": report_rel, "role": "report", "content": report_text})
        preconditions[report_rel] = _hash_file(report)
        op_id = "improve-admit-" + uuid.uuid4().hex
        committed = run_mutation(
            root,
            op_id,
            "improve_admit",
            seat,
            _identity(root),
            hash_bytes(f"{active_cycle}:{seat}:{selected_role}".encode("utf-8")),
            targets,
            preconditions=preconditions,
            skip_preflight=True,
            verification_policy="improve_atomic_file",
        )
        if not committed.get("ok"):
            return _rv(committed)
        return _rv(
            {
                "ok": True,
                "code": committed.get("code", "COMMITTED"),
                "op_id": committed.get("op_id"),
                "cycle_id": active_cycle,
                "seat_id": seat,
                "role": selected_role,
                "report_path": report,
                "report_created": True,
                "resumed": False,
                "source_head": source.source_head,
                "source_tree_fingerprint": source.source_tree_fingerprint,
                "discovery_model": source.discovery_model,
            }
        )


def create_cycle(
    project_root: Path,
    cycle_id: str,
    *,
    created_at: str | None = None,
    project_identity: str | None = None,
) -> Path:
    """Create a STRICT-schema cycle directory journaled (DOGFOOD V, T-618).

    Python owns the manifest formatting: no caller supplies preformatted
    roster prose. The strict manifest carries exactly one roster header, one
    manifest_schema: strict, one cycle_id, one UTC created_at, one portable
    project_identity and one lifecycle status -- the fields IMPROVE.md § 3
    requires and the three historical cycles lack. Refuses while another
    ACTIVE cycle exists, exactly like register_cycle."""
    import datetime

    if created_at is None:
        created_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if project_identity is None:
        project_identity = portable_project_key(project_root)
    root = Path(project_root)
    cdir = cycle_dir(root, cycle_id)
    _prove_inside(root, cdir)
    owner = _owner_root(root)
    if owner.is_dir():
        for manifest in owner.glob("*/MANIFEST.md"):
            if _cycle_status(manifest) == "active":
                raise ImproveError(
                    f"improve cycle {manifest.parent.name} is ACTIVE -- a "
                    f"project has at most one active Improve cycle; complete "
                    "it first to admit the next"
                )
    if (cdir / "MANIFEST.md").exists():
        raise ImproveError(
            f"improve cycle {cycle_id} already exists -- a project has at "
            f"most one active Improve cycle"
        )
    content = (
        "# IMPROVE CYCLE ROSTER\n\n"
        "manifest_schema: strict\n"
        f"cycle_id: {cycle_id}\n"
        f"created_at: {created_at}\n"
        f"project_identity: {project_identity}\n"
        "cycle_status: active\n"
    )
    # T-638/§2: the PROPOSED manifest must validate before ANY byte is
    # written -- an invalid created_at/project_identity/lifecycle must never
    # leave a cycle directory or manifest behind (ZERO writes on known-invalid
    # proposed state).
    _proposed_errors = validate_manifest(content, expected_cycle_id=cycle_id)
    if _proposed_errors:
        raise ImproveError(
            "create_cycle refuses its own proposed manifest: "
            + "; ".join(_proposed_errors[:3])
            + " -- a known-INVALID proposed state is never written (T-638)"
        )
    result = _journaled_write(cdir / "MANIFEST.md", content, "cycle")
    if not result.get("ok"):
        raise ImproveError(
            f"cycle {cycle_id} not committed: {result.get('code')} {result.get('message', '')}"
        )
    return cdir


def register_cycle(project_root: Path, cycle_id: str, roster_lines: str) -> Path:
    """LEGACY roster-cycle writer, kept for pre-boundary callers and tests.

    Creates a cycle whose manifest carries no `manifest_schema: strict`, so it
    validates under the legacy rules -- exactly the schema the three
    historical archived cycles carry. New cycles MUST use create_cycle() so
    the strict manifest contract (cycle_id/created_at/project_identity once,
    no duplicate header) applies. Refuses while another ACTIVE cycle exists
    (one active Improve cycle per project)."""
    root = Path(project_root)
    cdir = cycle_dir(root, cycle_id)
    _prove_inside(root, cdir)
    owner = _owner_root(root)
    if owner.is_dir():
        for manifest in owner.glob("*/MANIFEST.md"):
            if _cycle_status(manifest) == "active":
                raise ImproveError(
                    f"improve cycle {manifest.parent.name} is ACTIVE -- a "
                    f"project has at most one active Improve cycle; complete "
                    "it first to admit the next"
                )
    if (cdir / "MANIFEST.md").exists():
        raise ImproveError(
            f"improve cycle {cycle_id} already exists -- a project has at "
            f"most one active Improve cycle"
        )
    content = "# IMPROVE CYCLE ROSTER\n\ncycle_status: active\n\n" + roster_lines
    if re.search(r"(?m)^cycle_status:\s*active\s*$", roster_lines):
        content = "# IMPROVE CYCLE ROSTER\n\n" + roster_lines
    result = _journaled_write(cdir / "MANIFEST.md", content, "cycle")
    if not result.get("ok"):
        raise ImproveError(
            f"cycle {cycle_id} not committed: {result.get('code')} {result.get('message', '')}"
        )
    return cdir


def _historical_bound_report_errors(
    cycle_dir: Path,
    seat_id: str,
    report_text: str,
    roster_text: str,
    *,
    require_runs: bool,
) -> list[str]:
    """Validate sealed report evidence without rewriting history as current.

    A superseded COMPLETE report still has to be structurally valid and bound
    to its original roster/project identity.  Its captured install/source
    identity is historical truth, however, so this bar deliberately does not
    compare those values with today's install or tree.
    """
    strict = _schema_of(roster_text) == "strict"
    errors = validate_report(report_text, require_runs=require_runs, strict=strict)
    block = _seat_block(roster_text, seat_id)
    if block is None:
        errors.append(f"seat {seat_id} is not registered on the roster")
        return errors
    errors += validate_strict_provenance(
        report_text,
        roster=roster_text,
        manifest_project_identity=_field(roster_text, "project_identity"),
        seat_id=seat_id,
    )
    report_role = _field(report_text, "role")
    roster_role = _field(block, "role")
    if report_role != roster_role:
        errors.append(f"report role {report_role!r} != roster role {roster_role!r}")
    if strict:
        tree = _field(report_text, "source_tree_fingerprint")
        if not re.match(r"^(git-delta-v1|no-git-tree-v1):", tree):
            errors.append(
                f"source_tree_fingerprint {tree!r} is not a mechanical fingerprint"
            )
        protocol_fp = _field(report_text, "protocol_fingerprint")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", protocol_fp):
            errors.append(
                f"protocol_fingerprint {protocol_fp!r} is not canonical sha256 evidence"
            )
    return errors


def stale_complete_route_hint(
    cycle_name: str,
    seat_id: str,
    report_path: str,
    missing: list[str],
    *,
    replacement: str | None = None,
    replacement_report: str | None = None,
) -> str:
    """The finite executable Core route for unswept stale-COMPLETE findings.

    T-1411: a locally-correct refusal must never compose into a global dead
    end. A stale report's historical findings are disposed with a non-CONFIRMED
    disposition only (T-619): SUPERSEDED when the fresh replacement reproduced
    the defect, NOT_REPRODUCED when it no longer does. Current ticket authority
    always flows through the replacement's OWN CONFIRMED disposition on fresh
    evidence; the historical record binds the successor with `verification=`.
    """
    report_ident = f"{seat_id}/{report_path}"
    finding = missing[0]
    successor = ""
    if replacement and replacement_report:
        successor = f" --verification {cycle_name}/{replacement}/{replacement_report}#{finding}"
    remainder = "" if len(missing) == 1 else f" (repeat for {', '.join(missing[1:])})"
    return (
        f"stale COMPLETE {seat_id} has unswept finding(s) {', '.join(missing)}: "
        f"run `saipen improve sweep-queue {cycle_name}`, then dispose each -- "
        f"`saipen improve sweep {cycle_name} {finding} SUPERSEDED --report "
        f"{report_ident} --reproduced y{successor}` when the current replacement "
        "reproduced it, or `saipen improve sweep "
        f"{cycle_name} {finding} NOT_REPRODUCED --report {report_ident} "
        f"--reproduced n{successor}` when it did not{remainder}; then "
        f"`saipen improve retire {cycle_name} {seat_id} --reason "
        "STALE_COMPLETE --replacement <fresh-seat>`"
    )


def validate_superseded_seat(
    cycle_dir: Path,
    seat_id: str,
    *,
    roster_text: str | None = None,
    sweep_text: str | None = None,
) -> list[str]:
    """Validate the ONE stale-COMPLETE resolution representation.

    The manifest is only an index.  Authority remains the exact immutable old
    report, its hash, the Core SWEEP ledger, and the named replacement seat.
    This function is shared by resolution, verify/cycle-complete, status and
    the repository validator so no consumer can implement a private "skip".
    """
    errors: list[str] = []
    roster = roster_text if roster_text is not None else _read_maybe(cycle_dir / "MANIFEST.md")
    sweep = sweep_text if sweep_text is not None else _read_maybe(cycle_dir / "SWEEP.md")
    block = _seat_block(roster, seat_id)
    if block is None:
        return [f"seat {seat_id}: supersession owner is missing from the roster"]
    if _field(block, "availability") != "superseded":
        return [f"seat {seat_id}: availability is not superseded"]

    report_path = _field(block, "report_path")
    report = cycle_dir / seat_id / report_path
    try:
        report_bytes = report.read_bytes()
        report_text = report_bytes.decode("utf-8-sig")
    except (OSError, UnicodeError) as exc:
        return [f"seat {seat_id}: preserved report cannot be read ({type(exc).__name__})"]
    expected_hash = _field(block, "preserved_report_sha256")
    actual_hash = hashlib.sha256(report_bytes).hexdigest()
    if expected_hash != actual_hash:
        errors.append(
            f"seat {seat_id}: preserved report sha256 {actual_hash} != recorded "
            f"{expected_hash}; superseded evidence was tampered"
        )
    if _field(report_text, "report_status") != "complete":
        errors.append(f"seat {seat_id}: preserved report is not COMPLETE")
    for error in _historical_bound_report_errors(
        cycle_dir,
        seat_id,
        report_text,
        roster,
        require_runs=_schema_of(roster) == "strict",
    ):
        errors.append(f"seat {seat_id} preserved report: {error}")

    sweep_errors = validate_sweep(sweep) if sweep else []
    for error in sweep_errors:
        errors.append(f"seat {seat_id}: malformed SWEEP evidence: {error}")
    if not sweep_errors:
        derived = derive_status(report_path, roster, report_text, sweep, seat_id=seat_id)
        missing = derived.get("missing", [])
        if missing:
            replacement_seat = _field(block, "replacement_seat")
            replacement_block = _seat_block(roster, replacement_seat) or ""
            errors.append(
                stale_complete_route_hint(
                    cycle_dir.name,
                    seat_id,
                    report_path,
                    missing,
                    replacement=replacement_seat,
                    replacement_report=_field(replacement_block, "report_path"),
                )
            )

    replacement = _field(block, "replacement_seat")
    replacement_block = _seat_block(roster, replacement)
    if replacement_block is None:
        errors.append(f"seat {seat_id}: replacement seat {replacement!r} is missing")
        return errors
    replacement_report_path = _field(replacement_block, "report_path")
    replacement_report = cycle_dir / replacement / replacement_report_path
    try:
        replacement_text = _read_maybe(replacement_report)
    except (OSError, UnicodeError) as exc:
        errors.append(
            f"seat {seat_id}: replacement report cannot be read ({type(exc).__name__})"
        )
        return errors
    if not replacement_text:
        errors.append(f"seat {seat_id}: replacement seat {replacement} has no report")
        return errors
    if _field(replacement_text, "report_status") != "complete":
        errors.append(f"seat {seat_id}: replacement seat {replacement} is not COMPLETE")
    if _field(block, "role") != _field(replacement_block, "role"):
        errors.append(
            f"seat {seat_id}: replacement seat {replacement} has a different role"
        )
    if _field(report_text, "context_scope") != _field(replacement_text, "context_scope"):
        errors.append(
            f"seat {seat_id}: replacement seat {replacement} has a different context_scope"
        )
    return errors


def resolve_stale_complete_seat(
    cycle_dir: Path, seat_id: str, replacement_seat: str
) -> dict:
    """Supersede one stale immutable COMPLETE report with a fresh seat.

    The old report and SWEEP ledger are read-only evidence.  The sole write is
    a journaled manifest decision binding their exact bytes to a distinct,
    fresh, same-scope COMPLETE replacement.  Findings must already have Core
    dispositions; no resolution can hide unswept evidence.
    """
    seat = _validate_safe_id(seat_id, "seat_id")
    replacement = _validate_safe_id(replacement_seat, "replacement_seat")
    if seat == replacement:
        raise ImproveError("stale-COMPLETE supersession needs a distinct replacement seat")
    snapshot = load_valid_manifest(cycle_dir, "stale-COMPLETE supersession", ("active",))
    roster = snapshot.text
    manifest = snapshot.path
    block = _seat_block(roster, seat)
    if block is None:
        raise ImproveError(f"supersession refuses: seat {seat} is not registered on the roster")
    availability = _field(block, "availability") or "expected"
    if availability == "superseded":
        existing = _field(block, "replacement_seat")
        integrity_errors = validate_superseded_seat(
            cycle_dir, seat, roster_text=roster, sweep_text=_read_maybe(cycle_dir / "SWEEP.md")
        )
        if integrity_errors:
            raise ImproveError(
                "supersession integrity failure: " + "; ".join(integrity_errors[:5])
            )
        if existing == replacement:
            return {
                "ok": True,
                "code": "ALREADY_APPLIED",
                "cycle_id": cycle_dir.name,
                "seat_id": seat,
                "replacement_seat": replacement,
            }
        raise ImproveError(
            f"supersession refuses: seat {seat} already resolves to {existing}, not {replacement}"
        )
    if availability != "expected":
        raise ImproveError(
            f"supersession refuses: seat {seat} availability is {availability}, not expected"
        )

    report_path = _field(block, "report_path")
    report = cycle_dir / seat / report_path
    if not report.is_file():
        raise ImproveError(f"supersession refuses: seat {seat} report is missing")
    try:
        report_bytes = report.read_bytes()
        report_text = report_bytes.decode("utf-8-sig")
    except (OSError, UnicodeError) as exc:
        raise ImproveError(
            f"supersession refuses: seat {seat} report cannot be read ({type(exc).__name__})"
        ) from exc
    if _field(report_text, "report_status") != "complete":
        raise ImproveError(
            f"supersession refuses: seat {seat} report is not COMPLETE; use the existing "
            "draft re-bind or retire route"
        )
    historical_errors = _historical_bound_report_errors(
        cycle_dir,
        seat,
        report_text,
        roster,
        require_runs=snapshot.strict,
    )
    if historical_errors:
        raise ImproveError(
            "supersession refuses malformed historical evidence: "
            + "; ".join(historical_errors[:5])
        )
    current_errors = validate_bound_report(
        cycle_dir,
        seat,
        report_text,
        require_runs=snapshot.strict,
        require_fresh=snapshot.strict,
        cycle_active=True,
    )
    if not current_errors:
        raise ImproveError(
            f"supersession refuses: seat {seat} COMPLETE report is fresh, not stale; "
            "normal sweep/cycle-complete semantics remain authoritative"
        )

    replacement_block = _seat_block(roster, replacement)
    if replacement_block is None:
        raise ImproveError(
            f"supersession refuses: replacement seat {replacement} is not registered; "
            f"create it with `saipen improve --new-seat --role {_field(block, 'role')}`"
        )
    if (_field(replacement_block, "availability") or "expected") != "expected":
        raise ImproveError(
            f"supersession refuses: replacement seat {replacement} is not expected/current"
        )
    replacement_path = _field(replacement_block, "report_path")
    replacement_report = cycle_dir / replacement / replacement_path
    replacement_text = _read_maybe(replacement_report)
    if not replacement_text or _field(replacement_text, "report_status") != "complete":
        raise ImproveError(
            f"supersession refuses: replacement seat {replacement} must carry a COMPLETE report"
        )
    if _field(block, "role") != _field(replacement_block, "role"):
        raise ImproveError(
            f"supersession refuses: replacement seat {replacement} has a different role"
        )
    if _field(report_text, "context_scope") != _field(replacement_text, "context_scope"):
        raise ImproveError(
            f"supersession refuses: replacement seat {replacement} has a different "
            "context_scope; re-audit the same bounded scope"
        )

    replacement_errors = validate_bound_report(
        cycle_dir,
        replacement,
        replacement_text,
        require_runs=snapshot.strict,
        require_fresh=snapshot.strict,
        cycle_active=True,
    )
    if replacement_errors:
        raise ImproveError(
            f"supersession refuses: replacement seat {replacement} is not current and "
            "fully valid: " + "; ".join(replacement_errors[:5])
        )

    sweep = _read_maybe(cycle_dir / "SWEEP.md")
    sweep_errors = validate_sweep(sweep) if sweep else []
    if sweep_errors:
        raise ImproveError(
            "supersession refuses malformed SWEEP evidence: " + "; ".join(sweep_errors[:3])
        )
    missing = derive_status(report_path, roster, report_text, sweep, seat_id=seat).get(
        "missing", []
    )
    if missing:
        raise ImproveError(
            "supersession refuses: "
            + stale_complete_route_hint(
                cycle_dir.name,
                seat,
                report_path,
                missing,
                replacement=replacement,
                replacement_report=replacement_path,
            )
        )

    preserved_hash = hashlib.sha256(report_bytes).hexdigest()
    lines: list[str] = []
    in_seat = False
    replaced = False
    for raw in roster.rstrip("\n").split("\n"):
        if raw.startswith("seat_id:"):
            in_seat = raw.split(":", 1)[1].strip() == seat
        if in_seat and raw.startswith("availability:"):
            lines.extend(
                [
                    "availability: superseded",
                    "resolution: stale-complete",
                    f"replacement_seat: {replacement}",
                    f"preserved_report_sha256: {preserved_hash}",
                ]
            )
            replaced = True
            in_seat = False
            continue
        lines.append(raw)
    if not replaced:
        raise ImproveError(f"supersession refuses: seat {seat} carries no availability line")
    proposed = "\n".join(lines) + "\n"
    proposed_errors = validate_manifest(proposed, expected_cycle_id=cycle_dir.name)
    if proposed_errors:
        raise ImproveError(
            "supersession refuses its own proposed manifest: "
            + "; ".join(proposed_errors[:5])
        )
    result = _journaled_write(manifest, proposed, "seat", base_hash=_base_hash(manifest))
    if not result.get("ok"):
        raise ImproveError(
            f"seat {seat} not superseded: {result.get('code')} {result.get('message', '')}"
        )
    return {
        "ok": True,
        "code": "SEAT_SUPERSEDED",
        "cycle_id": cycle_dir.name,
        "seat_id": seat,
        "availability": "superseded",
        "replacement_seat": replacement,
        "preserved_report_sha256": preserved_hash,
        "report_preserved": True,
        "sweep_preserved": True,
    }


def verify_cycle(cycle_dir: Path) -> list[str]:
    """Validate the COMPLETE cycle output (DOGFOOD V, T-615/T-616/T-618).

    The shared full-cycle bar used by `saipen improve verify`, complete_cycle
    and the validator: strict manifest schema, every expected seat resolved,
    every report full-valid (RUN evidence for strict cycles), exact composite
    sweep coverage, mechanically valid source identity fields. An artifact
    that merely resembles a writable target can never pass this."""
    errors = []
    manifest = cycle_dir / "MANIFEST.md"
    text = _read_maybe(manifest)
    if not text.strip():
        errors.append(f"cycle manifest missing: {manifest}")
        return errors
    manifest_errors = validate_manifest(text, expected_cycle_id=cycle_dir.name)
    errors.extend(manifest_errors)
    strict = bool(re.search(r"(?m)^manifest_schema:\s*strict\s*$", text))
    sweep_text = _read_maybe(cycle_dir / "SWEEP.md")
    cycle_active = _status_of(text) == "active"
    for seat in _seat_blocks(text):
        availability = _field(seat, "availability") or "expected"
        seat_id = _field(seat, "seat_id") or "?"
        if availability == "unavailable":
            continue
        if availability == "superseded":
            errors.extend(
                validate_superseded_seat(
                    cycle_dir,
                    seat_id,
                    roster_text=text,
                    sweep_text=sweep_text,
                )
            )
            continue
        report_path = _field(seat, "report_path")
        if not report_path:
            errors.append(f"seat {seat_id}: missing report_path in roster")
            continue
        report = cycle_dir / seat_id / report_path
        if not report.is_file():
            errors.append(f"seat {seat_id}: expected report {report_path} does not exist")
            continue
        report_text = _read_maybe(report)
        roster_role = _field(seat, "role")
        report_role = _field(report_text, "role")
        if report_role != roster_role:
            errors.append(
                f"seat {seat_id}: roster/report role mismatch: {roster_role!r} != {report_role!r}"
            )
            continue
        if _field(report_text, "report_status") != "complete":
            errors.append(f"seat {seat_id}: report {report_path} is not complete")
            continue
        report_errors = validate_bound_report(
            cycle_dir,
            seat_id,
            report_text,
            require_runs=strict,
            require_fresh=strict and cycle_active,
            cycle_active=cycle_active,
        )
        for err in report_errors:
            errors.append(f"seat {seat_id} report: {err}")
        if cycle_active and report_errors and _field(report_text, "report_status") == "complete":
            stale = _freshness_errors(
                _project_root_of(cycle_dir), report_text, strict, cycle_active
            )
            if stale:
                errors.append(
                    f"seat {seat_id}: stale COMPLETE recovery route: create a current "
                    f"replacement with `saipen improve --new-seat --role {roster_role}`, "
                    "complete it against the current tree, then dispose every historical "
                    "finding with a non-CONFIRMED disposition (`saipen improve sweep "
                    f"{cycle_dir.name} <RUN-N/IMP-NNN> SUPERSEDED|NOT_REPRODUCED --report "
                    f"{seat_id}/{report_path} --reproduced y|n --verification "
                    "<replacement>/<report>#<RUN-N/IMP-NNN>`; SUPERSEDED when the "
                    "replacement reproduced it, NOT_REPRODUCED when it did not, and "
                    "stale CONFIRMED stays forbidden (T-619)), then "
                    f"`saipen improve retire {cycle_dir.name} {seat_id} --reason "
                    "STALE_COMPLETE --replacement <fresh-seat>`"
                )
        derived = derive_status(report_path, text, report_text, sweep_text, seat_id=seat_id)
        for missing_ref in derived.get("missing", []):
            errors.append(
                f"seat {seat_id}: finding {missing_ref} has no "
                "final Core disposition for its exact composite "
                "identity"
            )
    return errors


def abort_cycle(cycle_dir: Path) -> dict:
    """Mechanical abort for a STUCK DRAFT cycle (DOGFOOD V, T-621).

    An active cycle whose report fails the completion bar (a committed RUN
    missing a required field, an interrupted audit) can never complete and can
    never archive -- the only old escape was a raw filesystem delete, the
    exact raw-writer bypass the protocol bans.

    Abort is the sanctioned exit: it refuses once ANY disposition exists (a
    cycle whose sweep started is not abortable), flips the manifest to
    archived with a journaled `cycle_aborted` marker, and byte-preserves the
    never-completed draft reports AT THEIR SAME PATH. No report byte is ever
    renamed, moved or deleted (P0, T-632): a raw Path.rename outside the
    journal was the crash hole -- a forced journal write failure left the
    report already renamed while the manifest stayed active. The report
    staying in place is not a split state: the manifest's archived +
    cycle_aborted markers are the single source of truth that the cycle and
    its drafts are non-authoritative, and every lifecycle consumer refuses an
    archived cycle. The next cycle can then be admitted without destroying
    the trace."""
    manifest = cycle_dir / "MANIFEST.md"
    _prove_inside(_project_root_of(manifest), manifest)
    text = _read_maybe(manifest)
    if not text.strip():
        raise ImproveError(f"cycle manifest missing: {manifest}")
    snapshot = load_valid_manifest(cycle_dir, "abort", ("active",))
    text = snapshot.text
    manifest = snapshot.path
    sweep = _read_maybe(cycle_dir / "SWEEP.md")
    if _sweep_records(sweep):
        raise ImproveError(
            "abort refuses: the sweep ledger already carries dispositions; a "
            "cycle whose Core sweep started is not abortable -- finish it. A "
            "seat that can never complete is retired through `saipen improve "
            "retire <cycle> <seat> --reason <CODE>`, and a seat whose draft "
            "carries no committed RUN can resume and re-bind its header; "
            "aborting would discard the dispositions the sweep already made"
        )
    # The manifest write is the ONLY filesystem effect, and it is the single
    # journaled transaction. A crash at any stage leaves either the active
    # manifest unchanged (retry re-aborts idempotently) or an archived +
    # cycle_aborted manifest whose draft reports stay byte-identical -- there
    # is no intermediate state where a report moved but the manifest did not.
    new_text = re.sub(r"(?m)^cycle_status:\s*[A-Za-z_]+", "cycle_status: archived", text, count=1)
    new_text = new_text.rstrip() + "\ncycle_aborted: draft-preserved\n"
    # T-638/§2: the PROPOSED manifest (archived + cycle_aborted) must validate
    # before it is written -- a known-invalid proposed state never enters
    # PREPARED/APPLY.
    _proposed_errors = validate_manifest(new_text, expected_cycle_id=cycle_dir.name)
    if _proposed_errors:
        raise ImproveError(
            "abort refuses its own proposed manifest: "
            + "; ".join(_proposed_errors[:3])
            + " -- a known-INVALID proposed state is never written (T-638)"
        )
    result = _journaled_write(manifest, new_text, "cycle", base_hash=_base_hash(manifest))
    if not result.get("ok"):
        raise ImproveError(
            f"cycle {cycle_dir.name} not aborted: {result.get('code')} {result.get('message', '')}"
        )
    preserved = []
    for block in _seat_blocks(text):
        seat_id = _field(block, "seat_id")
        report_path = _field(block, "report_path")
        if not seat_id or not report_path:
            continue
        report = cycle_dir / seat_id / report_path
        if report.is_file():
            preserved.append(f"{seat_id}/{report_path}")
    result["preserved_reports"] = sorted(preserved)
    return result


def retire_seat(cycle_dir: Path, seat_id: str, reason: str) -> dict:
    """Canonical bounded exit for a seat that can never complete (T-1406).

    A cycle can be stuck after its Core sweep started: one expected seat's
    report never reached `complete` (a stale install identity, an interrupted
    audit) and no draft re-bind applies, so `verify_cycle` can never pass and
    `abort` is (correctly) forbidden once dispositions exist. Retiring marks
    that ONE seat `availability: unavailable` through the journaled roster
    write: the never-completed report stays byte-identical at its path, every
    existing SWEEP disposition is untouched, `verify_cycle` already skips
    unavailable seats, and the next cycle can be admitted once this one
    completes. Retirement is refused for a seat whose report IS complete (a
    completed report is resolved through sweep/cycle-complete, never hidden)
    and when it would leave the roster with no expected seat -- a cycle is
    never completed into evidence-free history.
    """
    seat = _validate_safe_id(seat_id, "seat_id")
    if not isinstance(reason, str) or not _RETIRE_REASON_RE.fullmatch(reason):
        raise ImproveError("retire reason must match [A-Z][A-Z0-9_-]{0,63}")
    snapshot = load_valid_manifest(cycle_dir, "retire", ("active",))
    text = snapshot.text
    manifest = snapshot.path
    block = _seat_block(text, seat)
    if block is None:
        raise ImproveError(f"retire refuses: seat {seat} is not registered on the roster")
    if (_field(block, "availability") or "expected") == "unavailable":
        raise ImproveError(f"retire refuses: seat {seat} is already unavailable")
    report_path = _field(block, "report_path")
    report = cycle_dir / seat / report_path if report_path else None
    if report is not None and report.is_file():
        report_text = _read_maybe(report)
        if _field(report_text, "report_status") == "complete":
            raise ImproveError(
                f"retire refuses: seat {seat} report is complete -- a "
                "completed report is resolved through sweep and "
                "cycle-complete, never retired; if it is stale, preserve it "
                f"through `saipen improve retire {cycle_dir.name} {seat} "
                "--reason STALE_COMPLETE --replacement <fresh-seat>`"
            )
    remaining_expected = [
        other
        for other in _seat_blocks(text)
        if (_field(other, "availability") or "expected") != "unavailable"
        and _field(other, "seat_id") != seat
    ]
    if not remaining_expected:
        raise ImproveError(
            "retire refuses: no expected seat would remain on the roster -- "
            "a cycle is never completed without audit evidence (retire a "
            "stray seat only while another expected seat can still report)"
        )
    lines: list[str] = []
    in_seat = False
    replaced = False
    for raw in text.rstrip("\n").split("\n"):
        if raw.startswith("seat_id:"):
            in_seat = raw.split(":", 1)[1].strip() == seat
        if in_seat and raw.startswith("availability:"):
            lines.append("availability: unavailable")
            lines.append(f"retire_reason: {reason}")
            replaced = True
            in_seat = False
            continue
        lines.append(raw)
    if not replaced:
        raise ImproveError(f"retire refuses: seat {seat} carries no availability line")
    new_text = "\n".join(lines) + "\n"
    _proposed_errors = validate_manifest(new_text, expected_cycle_id=cycle_dir.name)
    if _proposed_errors:
        raise ImproveError(
            "retire refuses its own proposed manifest: "
            + "; ".join(_proposed_errors[:3])
            + " -- a known-INVALID proposed state is never written (T-638)"
        )
    result = _journaled_write(manifest, new_text, "seat", base_hash=_base_hash(manifest))
    if not result.get("ok"):
        raise ImproveError(
            f"seat {seat} not retired: {result.get('code')} {result.get('message', '')}"
        )
    return {
        "ok": True,
        "code": "SEAT_RETIRED",
        "cycle_id": cycle_dir.name,
        "seat_id": seat,
        "role": _field(block, "role"),
        "availability": "unavailable",
        "reason": reason,
        "report_path": report_path,
        "report_preserved": bool(report is not None and report.is_file()),
    }


def _seat_report(cycle_dir: Path, block: str) -> tuple[str, str]:
    """(report_path, report_text) for one roster block; empty text when absent."""
    seat_id = _field(block, "seat_id") or "?"
    report_path = _field(block, "report_path") or ""
    if not report_path:
        return "", ""
    report = cycle_dir / seat_id / report_path
    if not report.is_file():
        return report_path, ""
    return report_path, _read_maybe(report)


def classify_cycle_seat(cycle_dir: Path, block: str, sweep_text: str, roster_text: str) -> dict:
    """Classify ONE roster seat for strict-cycle reconciliation (T-1434 M4).

    The classification is derived from the roster, the report bytes and the
    Core SWEEP ledger only -- never from prose or from a caller's claim. It is
    the single truth shared by `reconcile_cycle`, the `improve status`
    projection and the reconciliation regression suite.
    """
    seat_id = _field(block, "seat_id") or "?"
    role = _field(block, "role") or ""
    report_path, report_text = _seat_report(cycle_dir, block)
    availability = _field(block, "availability") or "expected"
    record = {
        "seat_id": seat_id,
        "role": role,
        "report_path": report_path,
        "availability": availability,
        "report_status": _field(report_text, "report_status"),
        "class": "STILL_ACTIONABLE",
        "terminal": False,
        "retire_reason": _field(block, "retire_reason") or "",
        "detail": "",
        "routes": [],
    }
    if availability == "unavailable":
        reason = record["retire_reason"]
        record["class"] = (
            "BLOCKED_EXTERNAL" if reason == "BLOCKED_EXTERNAL" else "CANONICALLY_UNAVAILABLE"
        )
        record["terminal"] = True
        record["detail"] = f"seat retired unavailable ({reason or 'no reason recorded'})"
        return record
    if availability == "superseded":
        errors = validate_superseded_seat(
            cycle_dir, seat_id, roster_text=roster_text, sweep_text=sweep_text
        )
        if errors:
            record["detail"] = "supersession integrity failure: " + "; ".join(errors[:3])
            record["routes"] = [f"repair supersession of seat {seat_id}: " + "; ".join(errors[:1])]
            return record
        record["class"] = "SUPERSEDED"
        record["terminal"] = True
        record["detail"] = f"superseded by {_field(block, 'replacement_seat')!r}"
        return record
    if not report_text:
        record["detail"] = "expected seat carries no readable report"
        record["routes"] = [f"saipen improve --session {seat_id} (resume the assignment)"]
        return record
    status = record["report_status"]
    if status != "complete":
        if _un_audited_report(report_text):
            record["class"] = "EMPTY_DRAFT"
            record["detail"] = "zero committed RUNs; the assignment produced no evidence"
            record["routes"] = [
                f"saipen improve retire {cycle_dir.name} {seat_id} --reason EMPTY_DRAFT"
            ]
            return record
        record["detail"] = f"report_status {status!r} with committed audit content"
        record["routes"] = [
            f"saipen improve submit {cycle_dir.name} {seat_id} <project> <findings.json>",
            f"saipen improve complete {cycle_dir.name} {seat_id} <project>",
        ]
        return record
    # COMPLETE: structural identity first, then current-tree/install staleness.
    historical = _historical_bound_report_errors(
        cycle_dir, seat_id, report_text, roster_text, require_runs=True
    )
    if historical:
        record["detail"] = "malformed historical evidence: " + "; ".join(historical[:3])
        record["routes"] = [f"repair seat {seat_id} report: " + "; ".join(historical[:1])]
        return record
    derived = derive_status(report_path, roster_text, report_text, sweep_text, seat_id=seat_id)
    missing = derived.get("missing", [])
    record["missing_findings"] = missing
    bound_errors = validate_bound_report(
        cycle_dir,
        seat_id,
        report_text,
        require_runs=True,
        require_fresh=True,
        cycle_active=True,
    )
    if not bound_errors:
        record["class"] = "CURRENT_COMPLETE"
        record["terminal"] = True
        return record
    if missing:
        record["detail"] = (
            "complete but stale COMPLETE with unswept finding(s): " + ", ".join(missing)
        )
        record["routes"] = [
            stale_complete_route_hint(cycle_dir.name, seat_id, report_path, missing)
        ]
        return record
    record["class"] = "STALE_COMPLETE"
    record["detail"] = "complete but not current: " + "; ".join(bound_errors[:3])
    record["routes"] = [
        f"saipen improve retire {cycle_dir.name} {seat_id} --reason STALE_COMPLETE "
        "--replacement <fresh-seat>"
    ]
    return record


def _replacement_for(cycle_dir: Path, records: list[dict], stale: dict) -> str | None:
    """The first CURRENT_COMPLETE same-role same-scope replacement seat, or None.

    A supersession may only bind to evidence that is current against TODAY's
    install and tree, so a stale COMPLETE (or another stale seat) is never a
    replacement.
    """
    source_path, source_text = "", ""
    for record in records:
        if record["seat_id"] == stale["seat_id"]:
            source_path = record["report_path"]
            break
    if source_path:
        source_text = _read_maybe(cycle_dir / stale["seat_id"] / source_path)
    source_scope = _field(source_text, "context_scope")
    for record in records:
        if record["class"] != "CURRENT_COMPLETE":
            continue
        if record["seat_id"] == stale["seat_id"] or record["role"] != stale["role"]:
            continue
        candidate_text = _read_maybe(cycle_dir / record["seat_id"] / record["report_path"])
        if _field(candidate_text, "context_scope") == source_scope:
            return record["seat_id"]
    return None


def _outcome_for_status(status: str) -> str:
    return {
        "complete": "COMPLETE",
        "archived": "ABORTED",
        "superseded": "SUPERSEDED",
        "blocked_external": "BLOCKED_EXTERNAL",
    }.get(status, status.upper())


def reconcile_cycle(cycle_dir: Path, *, dry_run: bool = False) -> dict:
    """ONE canonical finite exit for a strict Improve cycle (T-1434 M4).

    The operation inspects every roster seat, executes the deterministic
    lossless transitions the current evidence already authorizes (retire an
    un-started EMPTY_DRAFT, supersede a STALE_COMPLETE seat onto a current
    same-scope replacement), refuses while genuine actionable work remains,
    and terminalizes the cycle with the lifecycle class that records WHY it
    ended (COMPLETE / SUPERSEDED / BLOCKED_EXTERNAL). It is idempotent: a
    terminal cycle returns ALREADY_TERMINAL with zero writes.
    """
    snapshot = load_valid_manifest(cycle_dir, "reconcile", CYCLE_STATUS)
    if not snapshot.strict:
        raise ImproveError(
            "reconcile refuses: reconciliation is a STRICT-cycle operation; "
            f"cycle {cycle_dir.name} is legacy sealed history and stays "
            "read-only (retire/abort are its only historical exits)"
        )
    roster = snapshot.text
    manifest = snapshot.path
    status = snapshot.status
    sweep = _read_maybe(cycle_dir / "SWEEP.md")
    records = [
        classify_cycle_seat(cycle_dir, block, sweep, roster) for block in _seat_blocks(roster)
    ]
    base = {
        "cycle_id": cycle_dir.name,
        "seats": records,
        "seat_classes": {record["seat_id"]: record["class"] for record in records},
    }
    if status in TERMINAL_CYCLE_STATUSES:
        return {
            "ok": True,
            "code": "ALREADY_TERMINAL",
            "outcome": _outcome_for_status(status),
            **base,
            "retired": [],
            "superseded": [],
        }
    actionable = [record for record in records if record["class"] == "STILL_ACTIONABLE"]
    if actionable:
        raise ImproveError(
            "reconcile refuses: genuine actionable work remains: "
            + "; ".join(
                f"seat {record['seat_id']} ({record['detail']})"
                for record in actionable[:5]
            )
            + " -- resolve each named route first"
        )
    empty = [record for record in records if record["class"] == "EMPTY_DRAFT"]
    stale = [record for record in records if record["class"] == "STALE_COMPLETE"]
    replacements: dict[str, str] = {}
    for record in stale:
        replacement = _replacement_for(cycle_dir, records, record)
        if replacement is None:
            raise ImproveError(
                "reconcile refuses: stale COMPLETE seat "
                f"{record['seat_id']} has no current same-scope replacement seat; "
                f"create one with `saipen improve --new-seat --role {record['role']}`, "
                "complete its audit against the current tree, then run reconcile again"
            )
        replacements[record["seat_id"]] = replacement
    if dry_run:
        return {
            "ok": True,
            "code": "RECONCILE_PLAN",
            **base,
            "planned_retire": [
                {"seat_id": record["seat_id"], "reason": "EMPTY_DRAFT"} for record in empty
            ],
            "planned_supersede": [
                {
                    "seat_id": record["seat_id"],
                    "replacement_seat": replacements[record["seat_id"]],
                }
                for record in stale
            ],
            "planned_outcome": "COMPLETE" if not (empty or stale) else "RECONCILED",
        }
    retired: list[dict] = []
    superseded: list[dict] = []
    for record in empty:
        result = retire_seat(cycle_dir, record["seat_id"], "EMPTY_DRAFT")
        retired.append(
            {"seat_id": record["seat_id"], "reason": "EMPTY_DRAFT", "result": result["code"]}
        )
    for record in stale:
        result = resolve_stale_complete_seat(
            cycle_dir, record["seat_id"], replacements[record["seat_id"]]
        )
        superseded.append(
            {
                "seat_id": record["seat_id"],
                "replacement_seat": replacements[record["seat_id"]],
                "result": result["code"],
            }
        )
    # Re-derive from the bytes on disk: reconcile never trusts its own plan.
    roster_now = _read_maybe(manifest)
    refreshed = [
        classify_cycle_seat(cycle_dir, block, sweep, roster_now)
        for block in _seat_blocks(roster_now)
    ]
    still_open = [record for record in refreshed if not record["terminal"]]
    if still_open:
        raise ImproveError(
            "reconcile refuses: after resolution these seats are still open: "
            + ", ".join(f"{record['seat_id']} ({record['class']})" for record in still_open[:5])
        )
    errors = verify_cycle(cycle_dir)
    if errors:
        raise ImproveError(
            "reconcile refuses: the cycle bar is unmet after resolution: "
            + "; ".join(errors[:5])
        )
    banned = any(
        record["class"] == "BLOCKED_EXTERNAL" for record in refreshed
    )
    has_unavailable = any(
        record["class"] in ("CANONICALLY_UNAVAILABLE", "BLOCKED_EXTERNAL") for record in refreshed
    )
    if banned:
        outcome = "BLOCKED_EXTERNAL"
    elif has_unavailable:
        outcome = "SUPERSEDED"
    else:
        outcome = "COMPLETE"
    if outcome == "COMPLETE":
        completed = complete_cycle(cycle_dir)
        terminal_code = completed.get("code")
    else:
        new_status = "blocked_external" if outcome == "BLOCKED_EXTERNAL" else "superseded"
        new_text = re.sub(
            r"(?m)^cycle_status:\s*[A-Za-z_]+", f"cycle_status: {new_status}", roster_now, count=1
        )
        if new_text == roster_now:
            raise ImproveError(
                f"reconcile refuses: cycle {cycle_dir.name} carries no cycle_status line"
            )
        proposed_errors = validate_manifest(new_text, expected_cycle_id=cycle_dir.name)
        if proposed_errors:
            raise ImproveError(
                "reconcile refuses its own proposed manifest: "
                + "; ".join(proposed_errors[:3])
            )
        written = _journaled_write(manifest, new_text, "cycle", base_hash=_base_hash(manifest))
        if not written.get("ok"):
            raise ImproveError(
                f"cycle {cycle_dir.name} not terminalized: {written.get('code')} "
                f"{written.get('message', '')}"
            )
        terminal_code = "CYCLE_TERMINALIZED"
    return {
        "ok": True,
        "code": "CYCLE_RECONCILED",
        "outcome": outcome,
        "terminal_code": terminal_code,
        **base,
        "retired": retired,
        "superseded": superseded,
    }


def sweep_ticket_linkage(project_root: Path | str, ticket_id: str) -> dict:
    """Strict-cycle CONFIRMED PROTOCOL_VIOLATION dispositions naming `ticket_id`.

    T-1434 M4: the reasoning-gate fields (`recurrence:`, `weak_model:`) are
    required on a ticket a strict Core sweep produced. The canonical writer for
    those fields exists only where that link is real, so this resolver is the
    ONE proof of the link: it walks every STRICT cycle's SWEEP ledger, resolves
    each CONFIRMED disposition naming the ticket to its exact report finding,
    and returns the composite references whose class is PROTOCOL_VIOLATION. A
    ticket with no such reference is never given reasoning text.
    """
    matches: list[dict] = []
    imp_root = Path(project_root) / _IMP_DIR
    if imp_root.is_dir():
        for sweep in sorted(imp_root.rglob("SWEEP.md")):
            cycle = sweep.parent
            roster = _read_maybe(cycle / "MANIFEST.md")
            if _schema_of(roster) != "strict":
                continue
            for record in _sweep_records(_read_maybe(sweep)):
                if record.disposition != "CONFIRMED" or record.ticket != ticket_id:
                    continue
                try:
                    seat, report_name, _key = _resolve_report_owner(cycle, record.report)
                except ImproveError:
                    continue
                report_text = _read_maybe(cycle / seat / report_name)
                for finding in parse_report(report_text).findings:
                    if finding.run != record.run() or finding.imp != record.imp():
                        continue
                    if finding.cls != "PROTOCOL_VIOLATION":
                        continue
                    matches.append(
                        {
                            "cycle_id": cycle.name,
                            "seat_id": seat,
                            "report": report_name,
                            "run": finding.run,
                            "imp": finding.imp,
                            "ref": composite_finding_ref(
                                cycle.name, seat, report_name, finding.run, finding.imp
                            ),
                        }
                    )
    return {"ok": True, "ticket": ticket_id, "links": matches, "linked": bool(matches)}


def complete_cycle(cycle_dir: Path) -> dict:
    """Mark a cycle COMPLETE: no longer active, so the next cycle can start.
    The cycle's evidence stays in place (never deleted to admit the next
    cycle); only the lifecycle status changes, journaled (NITRO dogfood II).

    "Complete" must mean something (NITRO dogfood III, T-595 + IV, T-601 +
    DOGFOOD V, T-615/T-616): before marking complete, verify_cycle must pass
    -- strict manifest, every expected seat's report present and FULL-valid
    (a report containing only `report_status: complete` refuses), every
    finding carrying a final Core SWEEP disposition for its EXACT composite
    identity. complete_cycle is never a glorified report_status counter."""
    snapshot = load_valid_manifest(cycle_dir, "complete_cycle", ("active", "complete"))
    text = snapshot.text
    manifest = snapshot.path
    if snapshot.status == "complete":
        raise ImproveError(f"cycle {cycle_dir.name} is already complete")
    errors = verify_cycle(cycle_dir)
    if errors:
        raise ImproveError(
            "complete_cycle refused -- the cycle bar is unmet:\n- " + "\n- ".join(errors[:20])
        )
    new_text = re.sub(r"(?m)^cycle_status:\s*[A-Za-z_]+", "cycle_status: complete", text, count=1)
    if new_text == text:
        new_text = text.rstrip() + "\ncycle_status: complete\n"
    # T-638/§2: the PROPOSED manifest must validate before it is written.
    _proposed_errors = validate_manifest(new_text, expected_cycle_id=cycle_dir.name)
    if _proposed_errors:
        raise ImproveError(
            "complete_cycle refuses its own proposed manifest: "
            + "; ".join(_proposed_errors[:3])
            + " -- a known-INVALID proposed state is never written (T-638)"
        )
    result = _journaled_write(manifest, new_text, "cycle", base_hash=_base_hash(manifest))
    if not result.get("ok"):
        raise ImproveError(
            f"cycle {cycle_dir.name} not completed: {result.get('code')} "
            f"{result.get('message', '')}"
        )
    return result


def create_report(
    project_root: Path,
    cycle_id: str,
    seat_id: str,
    project_name: str,
    *,
    agent: str,
    role: str,
    model_or_runtime: str,
    context_scope: str,
    context_available: str = "complete",
) -> Path:
    """Create a DRAFT seat report mechanically and journaled (DOGFOOD V,
    T-616/T-618). No raw report construction by Core/agent after the
    migration boundary.

    The header is rendered by Python. Source identity is captured MECHANICALLY
    via freshness.compute_source_identity() -- source_head + the real tree
    fingerprint + discovery model, never a hand-typed hash or a friendly
    label pretending to be one. `saipen_version` comes ONLY from the SAIPEN
    install executing Improve, never from the target project's VERSION, and
    `protocol_fingerprint` is DERIVED from the installed protocol -- a caller
    never supplies a digest Python can derive itself (T-992/§3, T-638/§4)."""
    from freshness import FreshnessError, compute_source_identity

    root = Path(project_root)
    cdir = cycle_dir(root, cycle_id)
    _prove_inside(root, cdir)
    _require_cycle_active(cdir, "create_report")
    seat = _validate_safe_id(seat_id, "seat_id")
    selected_role = _validate_role(role)
    roster_text = _read_maybe(cdir / "MANIFEST.md")
    # A2: create_report makes a decision from the roster (which report path a
    # seat owns, which role), so the manifest it consumes must validate first
    # -- an invalid active manifest is never interpreted for a write.
    _manifest_errors = validate_manifest(roster_text, expected_cycle_id=cdir.name)
    if _manifest_errors:
        raise ImproveError(
            "create_report refuses an invalid active manifest: " + "; ".join(_manifest_errors[:3])
        )
    roster_block = _seat_block(roster_text, seat)
    if (
        roster_block is None
        or _field(roster_block, "report_path") != f"saipen_improve_{project_name}.md"
    ):
        raise ImproveError(
            f"create_report refuses: seat {seat} has no roster entry owning "
            f"saipen_improve_{project_name}.md -- register the seat first"
        )
    if _field(roster_block, "role") != selected_role:
        raise ImproveError(
            f"create_report refuses: seat {seat} roster role "
            f"{_field(roster_block, 'role')!r} does not match report role "
            f"{selected_role!r}"
        )
    try:
        ident = compute_source_identity(root)
    except FreshnessError as exc:
        raise ImproveError(
            f"create_report refuses: cannot capture mechanical source identity: {exc}"
        ) from exc
    # T-992/§4: the report's agent IS the seat -- the seat identity is the
    # mechanically knowable fact, a caller may not attach a conflicting label.
    if agent != seat:
        raise ImproveError(
            f"create_report refuses: agent {agent!r} conflicts with seat "
            f"{seat!r}; the report agent is derived from the seat identity, "
            "a caller cannot choose a different identity label"
        )
    saipen_version = _saipen_install_version()
    protocol_fingerprint = installed_protocol_fingerprint(_protocol_root_for())
    # T-992/§4: project identity comes from the OWNING MANIFEST's
    # project_identity -- the report and the cycle it belongs to must agree on
    # one project identity, and the caller cannot recompute a divergent one.
    _manifest_project = _field(roster_text, "project_identity")
    if not _manifest_project:
        raise ImproveError(
            f"create_report refuses: cycle {cdir.name} manifest carries no project_identity"
        )
    header = (
        f"agent: {seat}\n"
        f"role: {selected_role}\n"
        f"model_or_runtime: {model_or_runtime}\n"
        f"project: {_manifest_project}\n"
        f"saipen_version: {saipen_version}\n"
        f"protocol_fingerprint: {protocol_fingerprint}\n"
        f"source_head: {ident.source_head}\n"
        f"source_tree_fingerprint: {ident.source_tree_fingerprint}\n"
        f"discovery_model: {ident.discovery_model}\n"
        f"context_scope: {context_scope}\n"
        f"context_available: {context_available}\n"
        "report_status: draft\n"
    )
    # T-992/§4: the writer never mints evidence its own consumer would
    # refuse -- every required scalar non-empty, no control injection, no
    # unknown header fields. The agent==seat conflict was already refused
    # above; this catches blank/control/unknown identity on the way out.
    _writer_provenance = validate_strict_provenance(header)
    if _writer_provenance:
        raise ImproveError(
            "create_report refuses its own output: " + "; ".join(_writer_provenance[:3])
        )
    report = resolve_report_path(root, cycle_id, seat, project_name)
    if report.is_file():
        raise ImproveError(f"create_report refuses: report already exists at {report}")
    report.parent.mkdir(parents=True, exist_ok=True)
    result = _journaled_write(report, header, "report", base_hash=_base_hash(report))
    if not result.get("ok"):
        raise ImproveError(
            f"report for seat {seat} not committed: {result.get('code')} "
            f"{result.get('message', '')}"
        )
    return report


def complete_report(report_path: Path) -> dict:
    """Mark a DRAFT report COMPLETE, journaled and immutable thereafter
    (DOGFOOD V, T-616). The FULL report validation must pass first -- a report
    with only `report_status: complete` and nothing else REFUSES."""
    if not report_path.is_file():
        raise ImproveError(f"complete_report refuses: no report at {report_path}")
    text = _read_maybe(report_path)
    if _field(text, "report_status") == "complete":
        raise ImproveError("complete_report refuses: report is already complete and immutable")
    cycle_dir_of_report = report_path.parent.parent
    _require_cycle_active(cycle_dir_of_report, "complete_report")
    strict = _cycle_schema(cycle_dir_of_report / "MANIFEST.md") == "strict"
    # Validate against the completion bar as if the report WERE complete: a
    # draft whose stored status is still draft must not dodge the completion
    # schema, and a report with only report_status: complete refuses.
    completion_text = re.sub(
        r"(?m)^report_status:[ \t]*[A-Za-z]+", "report_status: complete", text, count=1
    )
    # T-638/§6: complete_report applies the ONE bound bar to the PROPOSED
    # completion -- structural + roster-bound provenance + source freshness
    # for strict active cycles. A fabricated provenance report can never be
    # completed into sealed evidence.
    errors = validate_bound_report(
        cycle_dir_of_report,
        report_path.parent.name,
        completion_text,
        require_runs=strict,
        require_fresh=strict,
        cycle_active=True,
    )
    if errors:
        raise ImproveError(
            "complete_report refused -- the bound completion bar is unmet:\n- "
            + "\n- ".join(errors[:12])
        )
    new_text = re.sub(r"(?m)^report_status:\s*[A-Za-z]+", "report_status: complete", text, count=1)
    if new_text == text:
        new_text = text.rstrip() + "\nreport_status: complete\n"
    result = _journaled_write(report_path, new_text, "report", base_hash=_base_hash(report_path))
    if not result.get("ok"):
        raise ImproveError(
            f"report not completed: {result.get('code')} {result.get('message', '')}"
        )
    return result


def archive_cycle(cycle_dir: Path) -> dict:
    """ARCHIVE a completed cycle: retention state only (T-559, T-606).

    `saipen improve clean` is archive-with-provenance and nothing else. It
    refuses while the cycle is not COMPLETE (an active cycle is still
    mutation-producing; a complete cycle with unswept findings cannot exist
    because complete_cycle requires full sweep coverage). T-1434 M4: a
    reconciled terminal cycle (`superseded` / `blocked_external`) is sealed
    evidence too and archives the same way. It preserves the
    original findings and the sweep ledger verbatim -- archived evidence keeps
    resolving through the [sweep-ticket-link] check. The mutation is the same
    journaled manifest write complete_cycle uses, changing only the lifecycle
    status to `archived`."""
    snapshot = load_valid_manifest(
        cycle_dir, "archive", ("complete", "superseded", "blocked_external")
    )
    text = snapshot.text
    manifest = snapshot.path
    # T-638/§10: a corrupted COMPLETE cycle must not become accepted ARCHIVED
    # history -- validate the sealed cycle structurally before freezing it.
    _sealed_errors = verify_cycle(cycle_dir)
    if _sealed_errors:
        raise ImproveError(
            "archive refused: the completed cycle no longer passes its own "
            "verification bar:\n- "
            + "\n- ".join(_sealed_errors[:20])
            + " -- corrupted history is never accepted as archived (T-638)"
        )
    new_text = re.sub(r"(?m)^cycle_status:\s*[A-Za-z_]+", "cycle_status: archived", text, count=1)
    if new_text == text:
        new_text = text.rstrip() + "\ncycle_status: archived\n"
    # T-638/§2: the PROPOSED manifest must validate before it is written.
    _proposed_errors = validate_manifest(new_text, expected_cycle_id=cycle_dir.name)
    if _proposed_errors:
        raise ImproveError(
            "archive refuses its own proposed manifest: "
            + "; ".join(_proposed_errors[:3])
            + " -- a known-INVALID proposed state is never written (T-638)"
        )
    result = _journaled_write(manifest, new_text, "cycle", base_hash=_base_hash(manifest))
    if not result.get("ok"):
        raise ImproveError(
            f"cycle {cycle_dir.name} not archived: {result.get('code')} {result.get('message', '')}"
        )
    return result


def register_seat(
    cycle_dir: Path, seat_id: str, role: str, report_path: str, availability: str = "expected"
) -> dict:
    """Add a seat to the roster; a duplicate seat_id registration fails.

    seat_id is one concrete audit seat/session, never a model family. Inputs
    are validated BEFORE any planning mutation. The roster owns stable
    routing/identity only.
    """
    seat = _validate_safe_id(seat_id, "seat_id")
    selected_role = _validate_role(role)
    _validate_report_path(report_path, seat)
    if availability not in {"expected", "unavailable"}:
        raise ImproveError(
            f"availability {availability!r} outside expected|unavailable; "
            "superseded is emitted only by stale-COMPLETE resolution"
        )
    manifest = _require_cycle_active(cycle_dir, "register_seat")
    text = _read_maybe(manifest)
    if not text.startswith("# IMPROVE CYCLE ROSTER"):
        text = "# IMPROVE CYCLE ROSTER\n\n" + text
    # A2: a manifest that fails its own grammar is never mutated -- seat
    # registration on a corrupt roster would commit a decision the validator
    # would then reject as INVALID_MANIFEST.
    _manifest_errors = validate_manifest(text, expected_cycle_id=cycle_dir.name)
    if _manifest_errors:
        raise ImproveError(
            "register_seat refuses an invalid active manifest: " + "; ".join(_manifest_errors[:3])
        )
    if _seat_block(text, seat) is not None:
        raise ImproveError(f"duplicate seat registration: {seat}")
    _refuse_duplicate_owner_over_bare_sweep(cycle_dir, text, report_path, seat)
    line = (
        f"seat_id: {seat}\nrole: {selected_role}\nreport_path: {report_path}\n"
        f"availability: {availability}\n"
    )
    result = _journaled_write(
        manifest, text.rstrip() + "\n" + line, "seat", base_hash=_base_hash(manifest)
    )
    if not result.get("ok"):
        raise ImproveError(
            f"seat {seat} not committed: {result.get('code')} {result.get('message', '')}"
        )
    return result


def append_run(report_path: Path, run_text: str) -> dict:
    """Append an immutable RUN section to a seat report (T-551, migrated to
    the journal in NITRO M6; DOGFOOD V, T-616).

    A second run from the same seat in the same cycle APPENDS; an earlier RUN
    is never overwritten. Immutability is PARSER-derived (DOGFOOD V, T-616):
    once the parsed header says `report_status: complete` the report is
    immutable and further RUNs are refused -- a substring search that a
    mention of `report_status: complete` in evidence text could trip is never
    the lifecycle gate. Returns the transaction result.
    """
    text = _read_maybe(report_path)
    if _RUN_RE.search(run_text):
        # SRC-085 M2 / AUDAPACK: append_run RECEIVES a RUN BODY and owns the
        # `## RUN N` heading it writes. A body that smuggles its own heading
        # commits two headings for one RUN, which the RUN-identity bar reads
        # as duplicate evidence; the report's completion bar then refuses and
        # its immutability makes `abort` the only exit. Refuse BEFORE any
        # write -- never repair committed immutable bytes.
        raise ImproveError(
            "append_run receives a RUN BODY, not a complete RUN section: "
            "run_text carries its own '## RUN N' heading, which append_run "
            "owns; remove the heading and submit the body alone",
            code="RUN_BODY_REQUIRED",
        )
    if _field(text, "report_status") == "complete":
        raise ImproveError(
            "seat report is complete and immutable; no further RUN sections may be appended"
        )
    # The report lives under .saipen/improve/<cycle>/<seat>/; the cycle must
    # still be ACTIVE for its report to be appended (completed-cycle
    # immutability, NITRO dogfood III, T-595).
    try:
        cycle_dir_of_report = report_path.parent.parent
        _require_cycle_active(cycle_dir_of_report, "append_run")
    except (ImproveError, ValueError):
        raise
    strict = _cycle_schema(cycle_dir_of_report / "MANIFEST.md") == "strict"
    if strict and not _field(text, "report_status"):
        raise ImproveError(
            "append_run refuses: a strict-cycle report must be created "
            "through create_report (it needs the mechanical header) before "
            "any RUN is appended"
        )
    # T-638/§7: appending to a report whose EXISTING structure is invalid
    # would compound malformed evidence -- validate the base before extending
    # it (ZERO writes on a known-INVALID base). The bound bar also catches
    # forged provenance in the base draft.
    if strict:
        _base_errors = validate_bound_report(
            cycle_dir_of_report,
            report_path.parent.name,
            text,
            require_runs=False,
            require_fresh=False,
            cycle_active=True,
        )
        if _base_errors:
            raise ImproveError(
                "append_run refuses to extend a malformed strict report: "
                + "; ".join(_base_errors[:3])
                + " -- a known-INVALID base is never mutated (T-638)"
            )
    run_count = len(re.findall(r"(?m)^## RUN \d+\s*$", text))
    run = f"## RUN {run_count + 1}\n\n{run_text.rstrip()}\n"
    proposed = text.rstrip() + "\n\n" + run
    # SRC-085 M2: the PROPOSED report is constructed in memory and must pass
    # the RUN-identity bar (unique / ascending / contiguous) before anything is
    # written, for legacy and strict cycles alike -- an append is never allowed
    # to compound an identity the completion bar will later refuse.
    _proposed_identity = _run_identity_problems(list(parse_report(proposed).runs))
    if _proposed_identity:
        raise ImproveError(
            "append_run refuses its own proposed report: "
            + "; ".join(f"proposed report {problem}" for problem in _proposed_identity)
            + " -- one RUN section per number",
            code="RUN_IDENTITY_INVALID",
        )
    # T-638/§2: the PROPOSED report (with the new RUN) must validate before
    # it is journaled.
    if strict:
        _proposed_errors = validate_bound_report(
            cycle_dir_of_report,
            report_path.parent.name,
            proposed,
            require_runs=False,
            require_fresh=False,
            cycle_active=True,
        )
        if _proposed_errors:
            raise ImproveError(
                "append_run refuses its own proposed report: "
                + "; ".join(_proposed_errors[:3])
                + " -- a known-INVALID proposed state is never written "
                "(T-638)"
            )
    result = _journaled_write(report_path, proposed, "run", base_hash=_base_hash(report_path))
    if not result.get("ok"):
        raise ImproveError(f"RUN not committed: {result.get('code')} {result.get('message', '')}")
    return result


def _run_identity_problems(runs: "tuple[int, ...] | list[int]") -> list[str]:
    """The RUN-identity bar (A4) as reusable problem strings, no prefixes.

    One owner for "RUN identity is injective": numbers unique, ascending and
    contiguous 1..N. `validate_report` applies it to a report that claims
    completion; `append_run` applies it to the PROPOSED report before writing
    (SRC-085 M2), because a report carrying two headings for one RUN is
    uncompletable and immutable -- abort was the only escape.
    """
    problems: list[str] = []
    if len(runs) != len(set(runs)):
        dup = sorted({n for n in runs if runs.count(n) > 1})
        problems.append(
            "repeats RUN section number(s): " + ", ".join(f"RUN {n}" for n in dup)
        )
    if list(runs) != sorted(runs):
        problems.append(
            "RUN numbers are not ascending: " + ", ".join(f"RUN {n}" for n in runs)
        )
    if runs and sorted(runs) != list(range(1, max(runs) + 1)):
        problems.append(
            "RUN numbers are not contiguous 1..N: "
            + ", ".join(f"RUN {n}" for n in sorted(runs))
        )
    return problems


def validate_report(text: str, require_runs: bool = False, strict: bool = False) -> list[str]:
    """Return every report violation; empty means valid.

    `require_runs=True` applies the DOGFOOD V strict completion schema: a
    report declared `report_status: complete` MUST carry at least one explicit
    `## RUN N` section (or an explicit `NO_FINDINGS` run) -- an empty skeleton
    that merely says complete is never a completed audit. `strict=True` applies
    the STRICT-cycle header contract (discovery_model required exactly once)
    and the STRICT finding-identity contract (A4): RUN numbers unique /
    ascending / contiguous 1..N with canonical IMP-NNN grammar and injective
    composite <RUN>/<IMP> identities. `validate_report` alone keeps the legacy
    report rules so the three historical archived cycles remain valid legacy
    evidence.
    """
    errors = []
    parsed = parse_report(text)
    header = parsed.header
    required = REQUIRED_HEADER if strict else REQUIRED_HEADER - _LEGACY_OPTIONAL_HEADER
    missing = sorted(required - set(header))
    if missing:
        errors.append("report header missing required fields: " + ", ".join(sorted(missing)))
    # Header fields are unique, and they come only from the top block: a
    # repeated required header is corruption every consumer must refuse, not
    # just the admission path -- `_field` reads the first while the strict
    # RUN check would read the last (T-630).
    _hblock = text.split("\n## ", 1)[0]
    _dup_header = sorted(
        k for k in required if sum(1 for ln in _hblock.splitlines() if ln.startswith(k + ":")) > 1
    )
    if _dup_header:
        errors.append("report repeats required header field(s): " + ", ".join(_dup_header))

    if header.get("report_status") and header["report_status"] not in REPORT_STATUS:
        errors.append(f"report_status {header['report_status']!r} outside draft|complete")
    if header.get("role") and header["role"] not in ROLES:
        errors.append(f"role {header['role']!r} outside {'|'.join(sorted(ROLES))}")
    avail = header.get("context_available")
    if avail and avail not in ("complete", "partial", "none"):
        errors.append(f"context_available {avail!r} outside complete|partial|none")

    scope = header.get("context_scope") or ""
    if avail == "complete" and not scope:
        errors.append("context_available: complete refused over an empty context_scope")
    if avail == "complete" and "partial" in scope.lower():
        errors.append(
            "context_available: complete refused over a partial "
            "context_scope -- a partial scope can never claim a "
            "full-context result (red control 3, T-555)"
        )
    if header.get("report_status") == "complete" and not scope:
        errors.append(
            "report_status: complete without a context_scope -- the completion bar is unmet (T-555)"
        )

    if require_runs and header.get("report_status") == "complete":
        if not parsed.has_runs:
            errors.append(
                "report_status: complete with no explicit ## RUN "
                "section -- a completed audit needs intentional RUN "
                "evidence (DOGFOOD V, T-616)"
            )
        else:
            # A4: RUN identity is INJECTIVE -- numbers unique, ascending and
            # contiguous 1..N. A duplicate or out-of-order RUN section is
            # false evidence (RUN 1 duplicated, RUN 1 then RUN 3, a gap, a
            # descending renumber): every finding's composite <RUN>/<IMP>
            # identity must resolve to exactly one section.
            runs = list(parsed.runs)
            for problem in _run_identity_problems(runs):
                errors.append(f"strict report {problem}")
            # A run with NO_FINDINGS must actually have zero findings.
            for run_number in sorted(parsed.no_findings_runs):
                if any(f.run == run_number for f in parsed.findings):
                    errors.append(
                        f"RUN {run_number} declares NO_FINDINGS but carries "
                        f"findings -- an intentional empty run must stay "
                        f"empty (DOGFOOD V, T-616)"
                    )
            # Every run must carry findings OR an explicit NO_FINDINGS marker:
            # an empty run without the marker is indistinguishable from an
            # interrupted audit (DOGFOOD V, T-616).
            run_numbers = {f.run for f in parsed.findings if f.run is not None}
            for run_number in parsed.runs:
                if run_number not in run_numbers and run_number not in parsed.no_findings_runs:
                    errors.append(
                        f"RUN {run_number} carries no findings and no "
                        "NO_FINDINGS marker -- an empty audit run is not "
                        "intentional evidence (DOGFOOD V, T-616)"
                    )

    if strict:
        # A4: strict finding identity is INJECTIVE. Canonical IMP-NNN grammar
        # (three-digit id); composite <RUN>/<IMP> identities unique across the
        # whole report. These checks run BEFORE any set/map conversion of the
        # findings, so a duplicate composite identity can never be silently
        # deduplicated into a "covered" verdict (the duplicate would already
        # have failed the report).
        seen_identities: set[tuple[int | None, str]] = set()
        for finding in parsed.findings:
            if not re.fullmatch(r"IMP-\d{3}", finding.imp):
                errors.append(
                    f"finding at line {finding.start}: IMP id "
                    f"{finding.imp!r} is not canonical IMP-NNN "
                    "(three-digit); strict reports use the "
                    "mechanical finding grammar"
                )
            identity = (finding.run, finding.imp)
            if identity in seen_identities:
                errors.append(
                    f"strict report repeats composite finding identity "
                    f"{finding.ref()} -- one sweep disposition can never "
                    "satisfy two findings with the same identity"
                )
            seen_identities.add(identity)

    for finding in parsed.findings:
        for fname in ("expected", "actual", "evidence"):
            if not getattr(finding, fname):
                errors.append(
                    f"finding {finding.ref()} at line "
                    f"{finding.start} lacks required {fname} -- a "
                    "finding without an observable "
                    "expected/actual/evidence triple is rejected, "
                    "not softened"
                )
        if finding.severity not in SEVERITY:
            errors.append(
                f"finding {finding.ref()} at line {finding.start}: "
                f"severity {finding.severity!r} outside the closed "
                "set"
            )
        if finding.cls not in FINDING_CLASS:
            errors.append(
                f"finding {finding.ref()} at line {finding.start}: "
                f"class {finding.cls!r} outside the closed set"
            )
        if finding.confidence not in CONFIDENCE:
            errors.append(
                f"finding {finding.ref()} at line {finding.start}: "
                f"confidence {finding.confidence!r} outside the "
                "closed set"
            )
        if finding.action not in ACTION:
            errors.append(
                f"finding {finding.ref()} at line {finding.start}: "
                f"action {finding.action!r} outside the closed set"
            )
    return errors


def validate_manifest(text: str, expected_cycle_id: str | None = None) -> list[str]:
    """Roster manifest grammar (NITRO dogfood IV, T-601 + DOGFOOD V, T-618).

    Parsed with the SAME primitives the manifest's consumers read
    (_seat_blocks / _field / _cycle_status), so the semantic verifier and the
    writer can never disagree about what the file means.

    Schema is DECLARED by the manifest itself: a `manifest_schema: strict`
    line switches on the DOGFOOD V strict rules (exactly one roster header,
    exactly one cycle_id matching the directory identity, exactly one valid
    UTC created_at, exactly one portable project_identity, exactly one
    lifecycle status, no duplicate top-level fields). Its absence keeps the
    legacy pre-boundary rules, so the three historical cycles stay valid
    legacy evidence byte-identically."""
    errors = []
    strict = bool(re.search(r"(?m)^manifest_schema:\s*strict\s*$", text))
    if strict:
        # Exactly one roster header.
        header_count = len(re.findall(r"(?m)^# IMPROVE CYCLE ROSTER\s*$", text))
        if header_count != 1:
            errors.append(
                f"strict manifest must carry exactly one "
                f"'# IMPROVE CYCLE ROSTER' header, found "
                f"{header_count}"
            )
        # Exactly one manifest_schema field.
        if len(re.findall(r"(?m)^manifest_schema:\s*strict\s*$", text)) != 1:
            errors.append("strict manifest must carry manifest_schema: strict exactly once")
        # Exactly one cycle_id, matching the directory identity when known.
        cycle_ids = re.findall(r"(?m)^cycle_id:\s*(\S+)\s*$", text)
        if len(cycle_ids) != 1:
            errors.append(
                f"strict manifest must carry exactly one cycle_id, found {len(cycle_ids)}"
            )
        elif expected_cycle_id is not None and cycle_ids[0] != expected_cycle_id:
            errors.append(
                f"strict manifest cycle_id {cycle_ids[0]!r} does "
                f"not match the directory identity "
                f"{expected_cycle_id!r}"
            )
        # Exactly one created_at, valid UTC.
        created = re.findall(r"(?m)^created_at:\s*(\S+)\s*$", text)
        if len(created) != 1:
            errors.append(
                f"strict manifest must carry exactly one created_at, found {len(created)}"
            )
        else:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", created[0]):
                errors.append(
                    f"strict manifest created_at {created[0]!r} is "
                    "not a valid UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)"
                )
        # Exactly one portable project identity.
        if len(re.findall(r"(?m)^project_identity:\s*(\S+)\s*$", text)) != 1:
            errors.append("strict manifest must carry exactly one project_identity")
        # No machine-local absolute path may leak into portable identity.
        if re.search(
            r"^project_identity:\s*[A-Za-z]:[\\/]|"
            r"^project_identity:\s*/",
            text,
            re.MULTILINE,
        ):
            errors.append(
                "strict manifest project_identity must be portable "
                "-- an absolute machine-local path leaks into "
                "portable evidence (DOGFOOD V, T-618)"
            )
        # Exactly one lifecycle status.
        if len(re.findall(r"(?m)^cycle_status:\s*[A-Za-z_]+\s*$", text)) != 1:
            errors.append("strict manifest must carry exactly one cycle_status")
    if not text.startswith("# IMPROVE CYCLE ROSTER"):
        errors.append("manifest must open with '# IMPROVE CYCLE ROSTER'")
    status = re.search(r"(?m)^cycle_status:\s*([A-Za-z_]+)", text)
    if status and status.group(1) not in CYCLE_STATUS:
        errors.append(
            f"cycle_status {status.group(1)!r} outside {'|'.join(CYCLE_STATUS)}"
        )
    # T-638/§7: `cycle_aborted` is ONE legal lifecycle meaning -- it marks an
    # ARCHIVED cycle whose drafts are non-authoritative. ACTIVE or COMPLETE
    # with the marker is a contradictory state; a duplicate or non-canonical
    # value is corruption. An aborted manifest can never pose as a normal
    # archived completed cycle.
    abort_markers = re.findall(r"(?m)^cycle_aborted:\s*(.*)$", text)
    if abort_markers:
        if status is None or status.group(1) != "archived":
            errors.append("cycle_aborted is legal ONLY with cycle_status: archived")
        if len(abort_markers) != 1:
            errors.append("cycle_aborted must appear exactly once")
        elif abort_markers[0].strip() != "draft-preserved":
            errors.append(
                f"cycle_aborted value {abort_markers[0].strip()!r} "
                "is not the canonical 'draft-preserved'"
            )
    seen: set[str] = set()
    for block in _seat_blocks(text):
        seat_id = _field(block, "seat_id")
        if not seat_id:
            errors.append("roster has a seat block without seat_id")
            continue
        if seat_id in seen:
            errors.append(f"duplicate seat_id: {seat_id}")
        seen.add(seat_id)
        # A3: STRICT seat field cardinality -- seat_id/role/report_path/
        # availability each exactly once inside one seat block. `_field`
        # reads the FIRST occurrence, so a duplicated field would silently
        # pick one value and the other is dead corruption; reject the block
        # instead of resolving first-vs-last ambiguity.
        if strict:
            for key in ("seat_id", "role", "report_path", "availability"):
                count = len(re.findall(rf"(?m)^{key}:[ \t]*\S", block))
                if count != 1:
                    errors.append(
                        f"seat {seat_id}: strict field {key} must appear "
                        f"exactly once, found {count}"
                    )
        role = _field(block, "role")
        if not role:
            errors.append(f"seat {seat_id}: missing role")
        elif role not in ROLES:
            errors.append(f"seat {seat_id}: role {role!r} outside {'|'.join(sorted(ROLES))}")
        report_path = _field(block, "report_path")
        if not report_path:
            errors.append(f"seat {seat_id}: missing report_path")
        else:
            try:
                _validate_report_path(report_path, seat_id)
            except ImproveError as exc:
                errors.append(f"seat {seat_id}: {exc}")
        availability = _field(block, "availability")
        if availability and availability not in AVAILABILITY:
            errors.append(
                f"seat {seat_id}: availability {availability!r} outside "
                "expected|unavailable|superseded"
            )
        # T-1434 M4: a retired seat records WHY it is unavailable. The field is
        # optional for historical retirements written before this grammar and
        # legal ONLY beside availability: unavailable -- an expected or
        # superseded seat carrying it is corruption, not a second meaning.
        retire_reasons = re.findall(r"(?m)^retire_reason:[ \t]*\S", block)
        if availability == "unavailable":
            if len(retire_reasons) > 1:
                errors.append(
                    f"seat {seat_id}: retire_reason must appear at most once, "
                    f"found {len(retire_reasons)}"
                )
            reason_value = _field(block, "retire_reason")
            if reason_value and not _RETIRE_REASON_RE.fullmatch(reason_value):
                errors.append(
                    f"seat {seat_id}: retire_reason {reason_value!r} is not "
                    "[A-Z][A-Z0-9_-]{0,63}"
                )
        elif retire_reasons:
            errors.append(
                f"seat {seat_id}: retire_reason requires availability: unavailable"
            )
        resolution_fields = (
            "resolution",
            "replacement_seat",
            "preserved_report_sha256",
        )
        if availability == "superseded":
            for key in resolution_fields:
                count = len(re.findall(rf"(?m)^{key}:[ \t]*\S", block))
                if count != 1:
                    errors.append(
                        f"seat {seat_id}: superseded field {key} must appear "
                        f"exactly once, found {count}"
                    )
            if _field(block, "resolution") != "stale-complete":
                errors.append(
                    f"seat {seat_id}: superseded resolution must be stale-complete"
                )
            replacement = _field(block, "replacement_seat")
            try:
                _validate_safe_id(replacement, "replacement_seat")
            except ImproveError as exc:
                errors.append(f"seat {seat_id}: {exc}")
            if replacement == seat_id:
                errors.append(f"seat {seat_id}: replacement_seat must be distinct")
            preserved_hash = _field(block, "preserved_report_sha256")
            if not re.fullmatch(r"[0-9a-f]{64}", preserved_hash):
                errors.append(
                    f"seat {seat_id}: preserved_report_sha256 must be 64 lowercase hex"
                )
        else:
            present = [key for key in resolution_fields if _field(block, key)]
            if present:
                errors.append(
                    f"seat {seat_id}: resolution field(s) {', '.join(present)} require "
                    "availability: superseded"
                )

    # The roster relation is a finite chain ending at one current expected
    # seat.  A forged dangling/cyclic marker can never make evidence vanish.
    blocks = {_field(block, "seat_id"): block for block in _seat_blocks(text)}
    for seat_id, block in blocks.items():
        if _field(block, "availability") != "superseded":
            continue
        replacement = _field(block, "replacement_seat")
        replacement_block = blocks.get(replacement)
        if replacement_block is None:
            errors.append(
                f"seat {seat_id}: replacement_seat {replacement!r} is not registered"
            )
            continue
        if _field(block, "role") != _field(replacement_block, "role"):
            errors.append(
                f"seat {seat_id}: replacement_seat {replacement} has a different role"
            )
        seen_chain: set[str] = set()
        cursor = seat_id
        while cursor in blocks and _field(blocks[cursor], "availability") == "superseded":
            if cursor in seen_chain:
                errors.append(f"seat {seat_id}: supersession chain is cyclic at {cursor}")
                break
            seen_chain.add(cursor)
            cursor = _field(blocks[cursor], "replacement_seat")
        terminal = blocks.get(cursor)
        if terminal is not None and (_field(terminal, "availability") or "expected") != "expected":
            errors.append(
                f"seat {seat_id}: supersession chain terminates at non-expected seat {cursor}"
            )
    return errors


# The SWEEP ledger grammar lives ONCE at module top (_SWEEP_LINE_RE): the
# finding_ref (RUN-N/IMP-NNN strict, bare IMP-NNN legacy) + disposition token
# and the `report=` identity on the same line for the COMPOSITE finding
# identity (cycle + seat/report + run + IMP id). The validator below consumes
# exactly that parser.


def validate_sweep(text: str) -> list[str]:
    """SWEEP ledger grammar (NITRO dogfood IV, T-601 + DOGFOOD V, T-615).

    Validates the ACTUAL ledger grammar with the parser the consumers use:
    disposition enum, the composite `report=` identity, the exact finding_ref
    (RUN-N/IMP-NNN or legacy IMP-NNN), and the required ticket/reproduced
    fields. Arbitrary malformed garbage in SWEEP.md is a semantic violation --
    an otherwise-valid MANIFEST cannot excuse it."""
    errors = []
    if not text.strip():
        return errors
    if not text.startswith("# SWEEP"):
        errors.append("SWEEP ledger must open with '# SWEEP'")
    for index, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = _SWEEP_LINE_RE.match(stripped)
        if not match:
            errors.append(
                f"SWEEP.md line {index}: {stripped!r} does not match the "
                "ledger grammar '- RUN-N/IMP-NNN [DISPOSITION] <ticket> "
                "report=<report_ident> reproduced=<y|n> [fixed_by=<ref>] "
                "[verification=<ref>]'"
            )
            continue
        finding_ref, disposition, ticket, report, reproduced = match.group(1, 2, 3, 4, 5)
        if disposition not in DISPOSITION:
            errors.append(
                f"SWEEP.md line {index}: disposition "
                f"{disposition!r} outside the closed set "
                f"{sorted(DISPOSITION)}"
            )
        if not report:
            errors.append(
                f"SWEEP.md line {index}: missing report identity -- "
                "the composite finding identity is cycle + "
                "seat/report + run + IMP id"
            )
        if not ticket:
            errors.append(f"SWEEP.md line {index}: missing canonical ticket reference")
        if not reproduced:
            errors.append(f"SWEEP.md line {index}: missing reproduced value")
        if finding_ref.count("/") > 1:
            errors.append(f"SWEEP.md line {index}: malformed finding reference {finding_ref!r}")
    # A4 ledger side: one composite identity, one disposition. A duplicated
    # ledger line for the same <finding_ref, report> pair is ambiguous
    # evidence -- a set/map consumer would silently deduplicate it, so the
    # ledger itself must reject the duplicate.
    seen_composite: set[tuple[str, str]] = set()
    for record in _sweep_records(text):
        identity = (record.finding_ref, record.report)
        if identity in seen_composite:
            errors.append(
                f"SWEEP.md repeats composite identity {record.finding_ref} "
                f"report={record.report}; one disposition per composite "
                "finding identity"
            )
        seen_composite.add(identity)
    return errors


def validate_report_target(text: str) -> list[str]:
    """Report/run target invariants available at the WRITE stage (NITRO
    dogfood IV, T-601). A report is constructed incrementally, so the full
    validate_report completion bar is checked at complete_cycle time; what is
    checkable the moment a report/run target commits is its closed-field
    vocabulary and the full-context claim."""
    errors = []
    status = _field(text, "report_status")
    if status and status not in REPORT_STATUS:
        errors.append(f"report_status {status!r} outside draft|complete")
    avail = _field(text, "context_available")
    if avail and avail not in ("complete", "partial", "none"):
        errors.append(f"context_available {avail!r} outside complete|partial|none")
    if avail == "complete" and not _field(text, "context_scope"):
        errors.append("context_available: complete refused over an empty context_scope")
    return errors
