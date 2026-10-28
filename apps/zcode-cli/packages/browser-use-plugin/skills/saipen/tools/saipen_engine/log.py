"""LOG event parsing -- the shared primitive."""

from __future__ import annotations

import re

import hashlib
import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

LOG_RE = re.compile(
    r"^- (\d{2}[./]\d{2}[./]\d{2} \d{2}:\d{2} )?"
    r"\[E-(\d+)\]"
    r"(?: \[parent: E-(\d+)\])?"
    r"(?: \[(T-[^\]]*)\])?"
    r"(?: \[agent: ([^\]]+)\])?"
    r"(?: \[op: ([^\]]+)\])?"
    r" ([A-Z]+): (.*)$"
)


#: An id a line CLAIMS, even when the line is otherwise illegal.
#:
#: The history is append-only, so an id that appears anywhere in it is spent --
#: the same rule this module already applies to ticket ids ("its ID reserved
#: forever"). A malformed line does not give its id back. Measured on _SAITULS,
#: 17.09.26: three checkpoint lines had lost their leading `- `, so the parser
#: filed them as illegal and the tail was computed from the parsable events
#: alone. The next allocation therefore handed out E-1300 a SECOND time, and
#: `recover`'s own repair proposal was refused FLOOR duplicate event id -- the
#: repair could name itself but could never apply. Reserving what a damaged
#: line claims costs a gap in the numbering; reusing it costs the ledger.
_DECLARED_EVENT_RE = re.compile(r"\[E-(\d+)\]")


def declared_event_id(line: str) -> int | None:
    match = _DECLARED_EVENT_RE.search(line)
    return int(match.group(1)) if match else None


def parse_log_line(line: str) -> dict | None:
    """Parse one LOG line into {date, event, parent, ticket, agent, op_id,
    taxonomy, text} or None. The optional RFC § 1.2 date is captured (not
    discarded) so consumers can report the event's own timestamp."""
    m = LOG_RE.match(line)
    if not m:
        return None
    return {
        "date": m.group(1).rstrip() if m.group(1) else None,
        "event": int(m.group(2)),
        "parent": int(m.group(3)) if m.group(3) else None,
        "ticket": m.group(4),
        "agent": m.group(5),
        "op_id": m.group(6),
        "taxonomy": m.group(7),
        "text": m.group(8),
    }


def _segment_number(path: Path | str) -> int:
    name = Path(path).name
    m = re.match(r"^LOG-(\d+)\.md$", name)
    return int(m.group(1)) if m else -1


def _is_reparse(info) -> bool:
    """Windows reparse point (junction/symlink/symlinked-dir) probe."""
    return bool(getattr(info, "st_file_attributes", 0) & 0x400)


class HistoryOwnershipError(ValueError):
    """A canonical history node is a symlink/junction/reparse or a non-regular
    file, or its container is (second-wave P1).

    History identity is ownership-safe: `is_dir()/is_file()/read_bytes()` all
    FOLLOW symlink/reparse nodes, which would let a history consume evidence
    outside the project. Refusing before reading keeps external bytes out of
    the digest and the ledger."""

    pass


def history_paths(project_root: Path | str) -> list[Path]:
    """All canonical LOG paths in strict numeric order: sealed LOG-N + active LOG.md."""
    root = Path(project_root)
    logs_dir = root / ".saipen" / "logs"
    sealed = []
    if logs_dir.is_dir():
        for p in logs_dir.iterdir():
            if p.is_file() and _segment_number(p) >= 0:
                sealed.append(p)
        sealed.sort(key=_segment_number)
    active = root / ".saipen" / "LOG.md"
    return [*sealed, active]


def _validate_history_ownership(root: Path, logs_dir: Path) -> list[Path]:
    """lstat every canonical history node and reject symlink/junction/reparse
    or non-regular files BEFORE any bytes are read (second-wave P1).

    Returns the validated immutable list of paths in numeric order to avoid
    duplicate stat/enumeration.
    """
    try:
        logs_info = logs_dir.lstat()
    except FileNotFoundError:
        logs_info = None  # genuinely absent logs dir -> no sealed container
    except OSError as exc:
        raise HistoryOwnershipError(
            f"logs container .saipen/logs unreadable ({type(exc).__name__}): {exc}"
        )
    if logs_info is not None:
        if os.path.islink(logs_dir) or _is_reparse(logs_info):
            raise HistoryOwnershipError(
                "logs container .saipen/logs is a symlink/junction/reparse "
                "point; refusing to read history from outside the project"
            )
        if not stat.S_ISDIR(logs_info.st_mode):
            raise HistoryOwnershipError(
                ".saipen/logs exists but is not a directory; refusing to read history through it"
            )

    sealed = []
    if logs_info is not None:
        for p in logs_dir.iterdir():
            if _segment_number(p) >= 0:
                sealed.append(p)
        sealed.sort(key=_segment_number)

    active = root / ".saipen" / "LOG.md"
    paths = [*sealed, active]

    for p in paths:
        try:
            info = p.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise HistoryOwnershipError(
                f"history node {p.name} unreadable ({type(exc).__name__}): {exc}"
            )
        if os.path.islink(p) or _is_reparse(info) or not stat.S_ISREG(info.st_mode):
            raise HistoryOwnershipError(
                f"history node {p.name} is a symlink/junction/reparse or "
                f"non-regular file; refusing to read external bytes"
            )
    return paths


def _require_canonical_active_log(path: Path, raw: bytes) -> None:
    """Apply checkpoint encoding law only to the active LOG segment."""
    if path.name != "LOG.md":
        return
    from . import codec

    if not codec.is_canonical_encoding(raw):
        raise HistoryOwnershipError("active LOG.md is not canonical UTF-8 without a BOM")


@dataclass(frozen=True)
class HistorySnapshot:
    """ONE non-persistent pass over the complete LOG history.

    Holds the exact raw-byte hash, the combined LF-normalised text, the
    global max E-ID, the parsed events and the `file:line` of every line that
    is NEITHER blank, a heading, nor a legal event -- all derived from a single
    read of every numeric sealed segment + active LOG. Consumers request
    one snapshot per command and reuse it; nothing is cached across
    commands, so append/seal changes are immediately visible.

    `illegal_lines` exists because a snapshot that only collects what PARSES
    cannot tell "no events here" from "a forged line the parser refused": the
    immutable-ledger contract (P0#2) needs both halves out of the same pass.
    """

    hash: str
    text: str
    tail: int | None
    events: tuple[dict, ...]
    illegal_lines: tuple[str, ...] = ()
    # The EXACT raw event lines, retained from the SAME single parse pass
    # (T-1014): every line `parse_log_line` accepted, in file order. Context
    # projections reuse these verbatim instead of re-parsing `text` a second
    # time, so the complete history is parsed exactly once per capture.
    event_lines: tuple[str, ...] = ()
    # PERF-004: the highest ticket ID referenced anywhere in the complete
    # history (sealed + active), computed during the same single parse pass.
    # Ticket IDs that exist ONLY in sealed history remain permanently
    # reserved, so allocation must never consult only the active LOG/BOARD.
    max_ticket_id: int = 0


def _normalised_doc_text(raw: bytes) -> str:
    """Decode exactly as `codec.read_doc` would (LF-normalised text)."""
    from . import codec

    text, _encoding, _bom = codec._decode(raw)
    return text.replace("\r\n", "\n").replace("\r", "\n")


ACTIVE_TICKET_BLOCK_MARKER = "ticket block via SAIOPS (active)"
STRUCTURAL_DETAIL_TAG = "structural_event: ticket-block-active"


@dataclass(frozen=True)
class ActiveTicketBlockStructure:
    """Machine-owned identity for the narrow active-ticket block exception."""

    dependency_ticket: str | None = None


def active_ticket_block_structure(
    dependency_ticket: str | None = None,
) -> ActiveTicketBlockStructure:
    """Build active-block structure without accepting caller prose."""
    if dependency_ticket is not None and re.fullmatch(r"T-\d+", dependency_ticket) is None:
        raise ValueError(
            "active ticket block dependency must be a canonical T-### identity"
        )
    return ActiveTicketBlockStructure(dependency_ticket)


def structural_event_prefix(structure: ActiveTicketBlockStructure) -> str:
    """Render the canonical semantic marker preserved by compaction."""
    structure = active_ticket_block_structure(structure.dependency_ticket)
    prefix = ACTIVE_TICKET_BLOCK_MARKER
    if structure.dependency_ticket is not None:
        prefix += f" -- dependency {structure.dependency_ticket}"
    return prefix


def structural_event_record(structure: ActiveTicketBlockStructure) -> dict:
    """Metadata binding for one machine-owned compact event structure."""
    structure = active_ticket_block_structure(structure.dependency_ticket)
    return {
        "kind": "ticket_block",
        "active": True,
        "dependency_ticket": structure.dependency_ticket,
    }


def _structure_from_record(record) -> ActiveTicketBlockStructure | None:
    if not isinstance(record, dict):
        return None
    if set(record) != {"kind", "active", "dependency_ticket"}:
        return None
    if record.get("kind") != "ticket_block" or record.get("active") is not True:
        return None
    try:
        return active_ticket_block_structure(record.get("dependency_ticket"))
    except ValueError:
        return None


_STRUCTURAL_DETAIL_MESSAGE = re.compile(
    rf"^(?P<prefix>{re.escape(ACTIVE_TICKET_BLOCK_MARKER)}"
    rf"(?: -- dependency (?P<dependency>T-\d+))?) -- "
    rf"{re.escape(STRUCTURAL_DETAIL_TAG)} -- detail_ref:\s*(?P<reference>\S+)$"
)
_PLAIN_DETAIL_MESSAGE = re.compile(r"^detail_ref:\s*(?P<reference>\S+)$")


def compact_detail_reference(
    text: str,
) -> tuple[str, ActiveTicketBlockStructure | None] | None:
    """Parse only canonical compact-detail messages, never arbitrary prose."""
    structural = _STRUCTURAL_DETAIL_MESSAGE.fullmatch((text or "").strip())
    if structural is not None:
        structure = active_ticket_block_structure(structural.group("dependency"))
        if structural.group("prefix") != structural_event_prefix(structure):
            return None
        return structural.group("reference"), structure
    plain = _PLAIN_DETAIL_MESSAGE.fullmatch((text or "").strip())
    if plain is None:
        return None
    return plain.group("reference"), None


#: Where `log_compaction` is allowed to have put those bytes, and nowhere else.
_DETAIL_ROOT = ".saipen/recovery/log-detail/"
#: Last resolution telemetry kept for compatibility with existing diagnostics.
#: Entries are never reused as authority: every validation pass re-reads bytes,
#: so same-process tampering cannot hide behind a previously valid resolution.
_DETAIL_CACHE: dict[str, str | None] = {}


def _restored_detail_text(root: Path, parsed: dict) -> tuple[str | None, str | None]:
    """Return ``(reference, original message)`` for a proved compact event.

    `log_compaction` replaces any event over `MAX_NEW_EVENT_BYTES` with one
    bounded detail-reference line and calls that lossless -- which it is on
    disk, and was not for any reader. `verification_evidence`,
    `regression_evidence` and `structural_marker_events` all classify on event
    TEXT, so a verdict long enough to be compacted carried no PASS token, no
    `conf: high` and no evidence marker, and the ticket read as unproven. The
    more a pass recorded, the less it counted.

    Decoding is proof, not trust: the reference must sit inside the compaction
    directory, the bytes must hash to the digest the metadata recorded, and the
    restored line must be the SAME event id. Anything else leaves the compacted
    text standing, so a missing or tampered detail file can never invent a
    verdict -- it only fails the way it already failed.
    """
    compact = compact_detail_reference(str(parsed.get("text") or ""))
    if compact is None:
        return None, None
    reference, structure = compact
    # The key is the RESOLVED root: two projects reached by the same spelling
    # -- `read_history_events(".")` from two working directories in one process
    # -- would otherwise share entries, and the digest is checked when the file
    # is read, not when the cache is hit, so a collision would serve another
    # project's verdict rather than refuse it.
    try:
        identity = root.resolve().as_posix()
    except OSError:
        return reference, None
    cache_key = f"{identity}|{reference}|{parsed.get('event')}"
    restored = _read_detail_text(root, reference, parsed, structure)
    _DETAIL_CACHE[cache_key] = restored
    return reference, restored


def _owned_detail_bytes(root: Path, reference: str) -> bytes | None:
    """One detail node's bytes, under the rule every history node already obeys.

    Containment and the digest bound what the path may SAY and what it must
    CONTAIN; neither says where the node resolves to. `_validate_history_ownership`
    lstats each LOG segment and refuses a symlink, junction, reparse point or
    non-regular file before reading a byte, exactly so history cannot consume
    evidence from outside the project, and a detail file is history.
    """
    normalized = reference.replace("\\", "/").lstrip("/")
    if ".." in normalized.split("/") or not normalized.startswith(_DETAIL_ROOT):
        return None
    node = root / normalized
    try:
        info = node.lstat()
        if os.path.islink(node) or _is_reparse(info) or not stat.S_ISREG(info.st_mode):
            return None
        return node.read_bytes()
    except OSError:
        return None


def _read_detail_text(
    root: Path,
    reference: str,
    parsed: dict,
    structure: ActiveTicketBlockStructure | None,
) -> str | None:
    metadata_raw = _owned_detail_bytes(root, reference)
    if metadata_raw is None:
        return None
    try:
        metadata = json.loads(metadata_raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(metadata, dict):
        return None
    from .paths import project_identity, project_lineage_identity

    expected = {
        "schema_version": 1,
        "operation": "log_event_externalization",
        "status": "COMMITTED",
        "event_id": f"E-{parsed.get('event')}",
        "ticket_id": parsed.get("ticket"),
        "project_identity": project_identity(root),
        "project_lineage": project_lineage_identity(root),
        "source": ".saipen/LOG.md",
        "metadata_path": reference,
        "lossless": True,
    }
    if not set(expected).issubset(metadata) or any(
        metadata.get(key) != value for key, value in expected.items()
    ):
        return None
    externalization = metadata.get("externalization_event")
    if not isinstance(externalization, dict) or externalization.get(
        "operation_id"
    ) != parsed.get("op_id"):
        return None
    if structure is None:
        if "structural_event" in metadata:
            return None
    else:
        recorded_structure = _structure_from_record(metadata.get("structural_event"))
        if recorded_structure != structure:
            return None
    raw = _owned_detail_bytes(root, str(metadata.get("original_event_path") or ""))
    if raw is None:
        return None
    if metadata.get("original_event_bytes") != len(raw):
        return None
    if hashlib.sha256(raw).hexdigest() != metadata.get("original_event_sha256"):
        return None
    lines = _normalised_doc_text(raw).splitlines()
    if len(lines) != 1:
        return None
    line = lines[0]
    full = parse_log_line(line)
    if full is None:
        return None
    for key in ("date", "event", "parent", "ticket", "agent", "op_id", "taxonomy"):
        if full.get(key) != parsed.get(key):
            return None
    if structure is not None and not str(full.get("text") or "").startswith(
        structural_event_prefix(structure) + " -- "
    ):
        return None
    return full.get("text")


def read_history_snapshot(
    project_root: Path | str, *, lean: bool = False
) -> HistorySnapshot:
    """One pass over the complete LOG history (sealed + active).

    Each segment file is opened exactly once; the exact raw bytes feed the
    hash and the decoded text feeds parsing and the combined text. Event
    ordering and parser semantics are identical to the historical
    per-consumer readers.

    Second-wave P1 ownership: every canonical history node is lstat-checked
    first and symlink/junction/reparse/non-regular nodes are refused before
    any bytes are read (HistoryOwnershipError), so history can never consume
    evidence from outside the project. The digest is FRAMED per node --
    canonical relative path + raw length + raw bytes -- so different segment
    layouts with identical concatenation, a resegment, or an added empty
    numeric segment all change the hash.

    PERF-005: `lean=True` omits the O(history-text) `text` and `event_lines`
    renderings that read-only routing commands never consume, while keeping
    hash, tail, parsed events, illegal-line diagnostics and max_ticket_id.
    The hash framing, read count and parse pass are byte-identical either way.
    """
    root = Path(project_root)
    logs_dir = root / ".saipen" / "logs"
    valid_paths = _validate_history_ownership(root, logs_dir)
    h = hashlib.sha256()
    chunks: list[str] = []
    events: list[dict] = []
    event_lines: list[str] = []
    illegal: list[str] = []
    max_ticket_id = 0
    for p in valid_paths:
        try:
            raw = p.read_bytes()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise HistoryOwnershipError(
                f"history node {p.name} unreadable ({type(exc).__name__}): {exc}"
            )
        _require_canonical_active_log(p, raw)
        rel = p.relative_to(root).as_posix()
        # FRAMED digest identity (second-wave P1): canonical relative path,
        # then raw length, then raw bytes -- so resegmenting, renaming, or
        # adding an empty numeric segment all change the hash, and two
        # different segment layouts cannot collide on concatenation alone.
        h.update(rel.encode("utf-8"))
        h.update(str(len(raw)).encode("ascii"))
        h.update(raw)
        text = _normalised_doc_text(raw)
        if not lean:
            chunks.append(text)
        for idx, line in enumerate(text.splitlines()):
            parsed = parse_log_line(line)
            if parsed is not None:
                reference, restored = _restored_detail_text(root, parsed)
                if reference is not None:
                    parsed["detail_ref"] = reference
                    parsed["detail_integrity"] = (
                        "valid" if restored is not None else "invalid"
                    )
                if restored is not None:
                    parsed["text"] = restored
                events.append(parsed)
                # Retain the ORIGINAL legal raw line in the same pass (T-1014)
                # so context projections reuse it verbatim -- no second parse.
                if not lean:
                    event_lines.append(line)
                # PERF-004: derive the history-wide max ticket ID during the
                # authoritative parse. A ticket ref in old sealed history keeps
                # its ID reserved forever.
                t = parsed.get("ticket")
                if t:
                    m = re.match(r"T-(\d+)$", t)
                    if m:
                        tid = int(m.group(1))
                        if tid > max_ticket_id:
                            max_ticket_id = tid
                continue
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            illegal.append(f"{p.name}:{idx + 1}: not a legal LOG event: {stripped[:80]!r}")
    tail = None
    for ev in events:
        if tail is None or ev["event"] > tail:
            tail = ev["event"]
    for problem in illegal:
        claimed = declared_event_id(problem)
        if claimed is not None and (tail is None or claimed > tail):
            tail = claimed
    return HistorySnapshot(
        hash=h.hexdigest()[:16],
        text="" if lean else "\n".join(chunks),
        tail=tail,
        events=tuple(events),
        illegal_lines=tuple(illegal),
        event_lines=() if lean else tuple(event_lines),
        max_ticket_id=max_ticket_id,
    )


def read_history_snapshot_and_logs_digest(
    project_root: Path | str,
    retain_text: bool = True,
) -> tuple[HistorySnapshot, str]:
    """ONE pass over the complete LOG history (sealed + active) that ALSO computes
    the sealed-LOG dependency digest -- the two reads a mutation PLAN used to do
    separately (``read_history_snapshot`` + ``hash_tree_dependency``) collapsed into
    a single content read of every segment (PERF-003).

    Each segment file is opened exactly ONCE. Its raw bytes feed BOTH:
      * the framed history hash (identical framing to ``read_history_snapshot``), and
      * the framed ``saipen-delete-tree-v1`` digest over ``.saipen/logs`` (identical
        framing and sentinels to ``hash_tree_dependency``), via a ``read_file``
        resolver so no second content read happens.

    Returns ``(snapshot, logs_digest)`` where ``logs_digest`` is byte-for-byte what
    ``hash_tree_dependency(root / ".saipen" / "logs")`` returns -- so APPLY's
    under-lock STALE_STATE recheck still compares the same value, it is simply
    computed once. Second-wave P1 ownership is enforced first
    (``HistoryOwnershipError``) and the digest contract is unchanged, so no
    Core/Second-Wave invariant weakens.

    The framed history hash and the ``event_lines`` are identical to
    ``read_history_snapshot``, so context/status projections that reuse the snapshot
    are unaffected.
    """
    root = Path(project_root)
    logs_dir = root / ".saipen" / "logs"
    valid_paths = _validate_history_ownership(root, logs_dir)
    h = hashlib.sha256()
    chunks: list[str] = []
    events: list[dict] = []
    event_lines: list[str] = []
    illegal: list[str] = []
    max_ticket_id = 0
    # PERF-001: cache raw bytes ONLY for paths inside `logs_dir` so the
    # subsequent `hash_tree_dependency(logs_dir, ...)` call -- which walks
    # exactly that directory -- is fed from memory instead of re-reading
    # every sealed segment a second time. The active LOG.md lives outside
    # `logs_dir` and is never visited by the delete-tree walker, so it is
    # deliberately not cached (it is consumed only by the snapshot above).
    sealed_cache: dict[Path, bytes] = {}
    for p in valid_paths:
        try:
            raw = p.read_bytes()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise HistoryOwnershipError(
                f"history node {p.name} unreadable ({type(exc).__name__}): {exc}"
            ) from exc
        _require_canonical_active_log(p, raw)
        rel = p.relative_to(root).as_posix()
        h.update(rel.encode("utf-8"))
        h.update(str(len(raw)).encode("ascii"))
        h.update(raw)
        text = _normalised_doc_text(raw)
        if retain_text:
            chunks.append(text)
        for idx, line in enumerate(text.splitlines()):
            parsed = parse_log_line(line)
            if parsed is not None:
                reference, restored = _restored_detail_text(root, parsed)
                if reference is not None:
                    parsed["detail_ref"] = reference
                    parsed["detail_integrity"] = (
                        "valid" if restored is not None else "invalid"
                    )
                if restored is not None:
                    parsed["text"] = restored
                events.append(parsed)
                for candidate in re.findall(r"\[T-(\d+)\]", line):
                    tid = int(candidate)
                    if tid > max_ticket_id:
                        max_ticket_id = tid
                event_lines.append(line)
                continue
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            illegal.append(f"{p.name}:{idx + 1}: not a legal LOG event: {stripped[:80]!r}")
        if p.is_relative_to(logs_dir):
            sealed_cache[p] = raw
        del raw
    tail = None
    for ev in events:
        if tail is None or ev["event"] > tail:
            tail = ev["event"]
    for problem in illegal:
        claimed = declared_event_id(problem)
        if claimed is not None and (tail is None or claimed > tail):
            tail = claimed
    snapshot = HistorySnapshot(
        hash=h.hexdigest()[:16],
        text="\n".join(chunks) if retain_text else "",
        tail=tail,
        events=tuple(events),
        illegal_lines=tuple(illegal),
        event_lines=tuple(event_lines),
        max_ticket_id=max_ticket_id,
    )
    from .journal import hash_tree_dependency

    def _read_sealed(candidate: Path) -> bytes:
        cached = sealed_cache.get(Path(candidate))
        if cached is not None:
            return cached
        return Path(candidate).read_bytes()

    logs_digest = hash_tree_dependency(logs_dir, read_file=_read_sealed)
    return snapshot, logs_digest


def read_history(project_root: Path | str) -> str:
    """The complete combined LOG text across sealed segments and active LOG.md."""
    return read_history_snapshot(project_root).text


def read_history_events(project_root: Path | str) -> list[dict]:
    """All parsed events across the complete LOG history."""
    return list(read_history_snapshot(project_root).events)


def snapshot_contract_errors(snapshot: "HistorySnapshot") -> list[str]:
    """The immutable-ledger contract, proved from an EXISTING snapshot.

    THE immutable-ledger contract (P0#2). A planner takes ONE snapshot and
    derives the ledger verdict, the syntax report and the E-ID tail from it, so
    the evidence a mutation is planned against and the evidence it was validated
    against are literally the same bytes -- never a second, possibly different
    read.

    Proves, over the complete sealed + active history:
      * legal syntax -- no forged/broken line masquerading as an event;
      * uniqueness -- each E-ID appears exactly once in the whole ledger;
      * order -- E-IDs strictly increase (a replayed event is caught);
      * parentage -- every parent E-ID exists and is strictly older.
    """
    errors: list[str] = list(snapshot.illegal_lines[:4])
    seen: dict[int, int] = {}
    for ev in snapshot.events:
        seen[ev["event"]] = seen.get(ev["event"], 0) + 1
    dupes = sorted(e for e, count in seen.items() if count > 1)
    if dupes:
        errors.append(
            "duplicate E-ID(s) in complete history: " + ", ".join(f"E-{e}" for e in dupes[:10])
        )
    # An id a DAMAGED line claims still exists in this ledger: the line is
    # broken, the slot is taken. Parentage is an EXISTENCE question, so it is
    # answered from what the history contains rather than from what this parser
    # could decode. Without this, the repair's own DEC -- whose parent is the
    # newest event, damaged or not -- was rejected as a fabricated parent edge,
    # so the only write that could fix the malformed lines was refused BY the
    # malformed lines (_SAITULS, 17.09.26). The line itself stays reported as
    # illegal; nothing here legitimizes it.
    claimed = {
        cid
        for cid in (declared_event_id(problem) for problem in snapshot.illegal_lines)
        if cid is not None
    }
    prev: int | None = None
    for ev in snapshot.events:
        eid = ev["event"]
        parent = ev["parent"]
        if parent is not None:
            if parent not in seen and parent not in claimed:
                errors.append(f"E-{eid} parent E-{parent} does not exist in the ledger")
            elif parent >= eid:
                errors.append(f"E-{eid} parent E-{parent} is not older than E-{eid}")
        if prev is not None and eid <= prev:
            errors.append(f"E-{eid} is not greater than preceding E-{prev} (out of order)")
        prev = eid
    return errors


def history_contract_errors(project_root: Path | str) -> list[str]:
    """Validate the COMPLETE LOG history as one immutable ledger, before any
    planning (hostile-regression, P0#2).

    Every event across the sealed segments + active LOG.md is checked for:
      * legal syntax -- it parses under the shared LOG_RE (no forged/broken
        line masquerading as an event);
      * uniqueness -- each E-ID appears exactly once across the whole ledger;
      * order -- the ledger is strictly monotonically increasing (a replayed
        or mis-ordered event is caught);
      * parent existence + ordering -- every parent E-ID resolves inside the
        ledger and is strictly older than its child (a broken or fabricated
        parent edge is caught).

    A void ledger would otherwise let a mutation PLAN against a trusted record
    that does not exist, so the planner must refuse before any canonical
    write. Syntax errors are reported with their file:line so the corruption is
    exactly located.

    ONE implementation: this is `snapshot_contract_errors` over a fresh
    snapshot, which is the same call the planner makes -- the validator and the
    planner can never disagree about what a valid ledger is."""
    return snapshot_contract_errors(read_history_snapshot(project_root))


def read_history_snapshot_strict(project_root: Path | str) -> tuple[HistorySnapshot, list[str]]:
    """One snapshot pass plus the full ledger contract, from that ONE pass.

    Consumers that PLAN call this once and reuse the snapshot for tail/evidence
    instead of re-reading the history piecemeal (hostile-regression, P0#2)."""
    snapshot = read_history_snapshot(project_root)
    return snapshot, snapshot_contract_errors(snapshot)


def history_hash(project_root: Path | str) -> str:
    """Deterministic hash over all history files (sealed + active)."""
    return read_history_snapshot(project_root).hash


def history_log_tail(project_root: Path | str) -> int | None:
    """The global max E-ID across all sealed segments and active LOG.md."""
    return read_history_snapshot(project_root).tail


def log_tail_event(text: str) -> int | None:
    """The actual maximum E-### across the LOG text (sealed + active as one).

    Order-independent by contract: allocation correctness never depends on
    line or file ordering, so E-100 followed by E-9 is still 100 (red control).
    """
    highest = None
    for line in text.splitlines():
        parsed = parse_log_line(line)
        if parsed is not None:
            event = parsed["event"]
            if highest is None or event > highest:
                highest = event
    return highest


VALID_TAXONOMIES = frozenset(
    {
        "DEC",
        "RUN",
        "WAIT",
        "REVERT",
        "NOTE",
        "OPS",
    }
)

# Applies to events created after this contract.  Historical oversized events
# remain readable and append-only.  Detail must move to a durable evidence
# artifact; the writer refuses rather than silently cutting proof.
MAX_NEW_EVENT_BYTES = 1024


def build_event(
    tail: int | None,
    taxonomy: str,
    message: str,
    ticket: str | None = None,
    agent: str | None = None,
    now: str | None = None,
    op_id: str | None = None,
) -> tuple[int, str]:
    """The ONE mechanical LOG event builder (NITRO integrity).

    Given the current LOG tail E-N, allocates E-(N+1) with parent E-N, renders
    the full line skeleton (date, E-ID, parent, optional ticket/agent/op_id,
    taxonomy, payload), and returns (event_id, line) WITHOUT the trailing
    newline. Every operation uses this; no caller hand-concatenates LOG
    structure.

    `op_id` is the SAIOPS operation provenance marker: structural mutations
    carry `[op: <op_id>]` so post-migration validator/audit can detect a
    manual structural edit that bypassed the engine.

    `now` is a "dd.MM.yy HH:mm" timestamp; the caller supplies it so PLAN and
    APPLY of one operation share one frozen clock.
    """
    line = render_event(
        tail,
        taxonomy,
        message,
        ticket=ticket,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    size = len(line.encode("utf-8"))
    if size > MAX_NEW_EVENT_BYTES:
        raise ValueError(
            f"LOG_EVENT_OVERSIZE: new event is {size} bytes, cap is "
            f"{MAX_NEW_EVENT_BYTES}; retain full detail as a durable evidence "
            "artifact and write a compact summary with detail_ref -- no bytes "
            "were truncated"
        )
    return (tail or 0) + 1, line


def prepare_bounded_event(
    root: Path | str,
    tail: int | None,
    taxonomy: str,
    message: str,
    *,
    ticket: str | None = None,
    agent: str | None = None,
    now: str | None = None,
    op_id: str | None = None,
    structure: ActiveTicketBlockStructure | None = None,
) -> tuple[int, str, tuple]:
    """The ONE bounded LOG producer every canonical writer uses.

    T-1326 P0: lossless construction is a property of the checkpoint writer, NOT
    an opt-in caller convention. Redaction and the byte cap are both applied
    here, and an event above `MAX_NEW_EVENT_BYTES` is preserved byte-for-byte as
    journaled detail artifacts instead of raising `LOG_EVENT_OVERSIZE` -- which
    used to make a lawful verb crash on the very DEC it exists to write.

    Returns `(event, line, targets)`; the caller MUST include `targets` in the
    SAME journaled commit as LOG/STATE/BOARD. A provably bounded message (a
    literal or an integer interpolation) still yields no targets at all.
    """
    from . import codec
    from .log_compaction import prepare_event

    prepared = prepare_event(
        Path(root).resolve(),
        tail,
        taxonomy,
        codec.redact_credentials(message),
        ticket=ticket,
        agent=agent,
        now=now,
        op_id=op_id,
        structure=structure,
    )
    return prepared.event, prepared.line, prepared.targets


def render_event(
    tail: int | None,
    taxonomy: str,
    message: str,
    ticket: str | None = None,
    agent: str | None = None,
    now: str | None = None,
    op_id: str | None = None,
) -> str:
    """Render one complete event without applying the new-event byte cap."""
    if taxonomy not in VALID_TAXONOMIES:
        raise ValueError(f"taxonomy {taxonomy!r} outside {sorted(VALID_TAXONOMIES)}")
    if now is None:
        import datetime

        now = datetime.datetime.now(datetime.timezone.utc).strftime("%d.%m.%y %H:%M")
    event = (tail or 0) + 1
    parts = [f"- {now} [E-{event}]"]
    if tail:
        parts.append(f"[parent: E-{tail}]")
    if ticket:
        parts.append(f"[{ticket}]")
    if agent:
        parts.append(f"[agent: {agent}]")
    if op_id:
        parts.append(f"[op: {op_id}]")
    parts.append(f"{taxonomy}: {message}")
    return " ".join(parts)


_VERIFY_BOUNDARY_RE = re.compile(r"^transition to VERIFY(?: -- .*)?$")
_VERIFY_BOUNDARY_PREFIX = "transition to VERIFY -- "
#: The evidence verdict for a ticket that never entered its VERIFY cycle. A
#: named value, because it asks for a different move than a cycle that ran and
#: proved nothing: no checkpoint can count before the boundary exists, so a
#: refusal routes this one to the phase edge instead (T-1380).
NO_VERIFY_BOUNDARY = "no current-cycle VERIFY boundary"
_NEGATION_RE = re.compile(r"\bNOT\s+(?:PASS|MANUAL-VERIFY)\b", re.IGNORECASE)
_PASS_TOKEN_RE = re.compile(r"\bPASS\b")

# CORE-003: a manual verification RESULT, not the appearance of the words.
#
# This used to be `\bMANUAL-VERIFY\b` searched anywhere in the body, so the
# procedural instruction `phases/verify.md` REQUIRES an agent to record --
# "MANUAL-VERIFY STEPS + EXPECTED", written precisely because a human has not
# verified anything yet -- satisfied the gate. So did any sentence that merely
# mentioned the token: `some prose that merely mentions MANUAL-VERIFY in
# passing` classified as successful verification. Human confirmation had become
# a magic substring.
#
# `structural_marker_events` in this same module already names that class --
# Narrative Authority Leakage -- and already prescribes the cure: authority
# belongs to a marker that BEGINS the event text, not one contained in it. The
# rule existed; the verification grammar had simply never been held to it.
#
# So the marker is anchored and it carries an explicit verdict. Steps, requests
# and prose are none of these and classify as nothing at all.
_MANUAL_RESULT_RE = re.compile(r"^MANUAL-VERIFY RESULT:\s*(PASS|FAIL)\b")
MANUAL_RESULT_PREFIX = "MANUAL-VERIFY RESULT: "

# T-1241: a FAILURE CLAIM, not the mere appearance of the letters. The old
# test was `"FAIL" in txt`, so the canonical zero-failure summary every gate in
# this repository prints -- `validate.py --gate core 0 FAIL` -- read as
# negative evidence, and VERIFY could not reach REVIEW until someone wrote a
# second, weaker event that avoided the word. The grammar must keep
# negative-evidence-wins (a real failure can never be talked past) while
# recognising that a count of zero in front of the token is the OPPOSITE of a
# failure. Anything not provably zero stays a failure.
#: T-1445: a token that is itself a field's KEY (`failed=0`, `failed: 3`) owns
#: the number after it, never the one before it -- that one belongs to the
#: previous field. Read as a count, `passed=0 failed=3` was a zero failure and
#: a real failure was talked past, while `passed=52 failed=0` vetoed a green
#: line. The field itself is read by `_FAIL_FIELD_RE`/`_ZERO_FIELD_RE`.
_NOT_A_FIELD_KEY = r"(?!\s*[=:]\s*\d)"
_ZERO_FAIL_RE = re.compile(
    r"\b(?:0|no|zero)\s+FAIL(?:S|ED|URE|URES)?\b" + _NOT_A_FIELD_KEY, re.IGNORECASE
)
_FAIL_TOKEN_RE = re.compile(r"\bFAIL(?:S|ED|URE|URES)?\b", re.IGNORECASE)

#: The VERDICT SEGMENT: an event's text up to its first ` -- `. Everything
#: after that separator is the detail an author writes for a human -- what ran,
#: what it repaired, why a control moved -- and that is where ordinary English
#: lives. The verdict itself is in front of it, which is exactly how every
#: canonical line in this repository is already written:
#:
#:     PASS -- 1078 tests green; the pre-fix FAIL is re-established -- conf: high
#:     ^^^^    ^ verdict                    ^ narrative
_VERDICT_SEPARATOR = " -- "

#: Unambiguous MACHINE shapes, honoured anywhere in the text because no prose
#: produces them by accident: a nonzero count before the token (`2 FAIL`,
#: `3 failures`) and a nonzero field of the FAIL family (`failures=2`, the shape
#: unittest prints; `failed=3` and `failed: 3`, the shapes other runners print).
_FAIL_COUNTED_RE = re.compile(
    r"\b(?!0+\b)\d+\s+FAIL(?:S|ED|URE|URES)?\b" + _NOT_A_FIELD_KEY, re.IGNORECASE
)
_FAIL_FIELD_RE = re.compile(r"\bFAIL(?:S|ED|URE|URES)?\s*[=:]\s*(?!0+\b)\d+", re.IGNORECASE)
#: Their zero twins, which exempt a token instead of claiming one.
_ZERO_FIELD_RE = re.compile(r"\bFAIL(?:S|ED|URE|URES)?\s*[=:]\s*0+\b", re.IGNORECASE)

# T-1444: a count ATTRIBUTED to a foreign scope is not this ticket's claim.
#
# The classifier had no scope. Measured live on SAIMAIL T-99: verify
# checkpoints honestly reported the SAIPEN core gate's INHERITED failures
# ("SAIPEN core 4 FAIL / 22 WARN (inherited)") next to the ticket's own green
# suite; the foreign count vetoed the ticket's PASS, VERIFY -> REVIEW refused,
# and the session misread the echoed text as a requirement to reproduce the
# previous experiment's evidence vocabulary -- a scope leak with no vocabulary
# requirement anywhere in the engine. The claim belongs to the ACTIVE ticket's
# own acceptance surface. The marker vocabulary is CLOSED and the attribution
# must be adjacent to the count, so an unattributed `2 FAIL` still claims from
# anywhere and a real failure cannot be talked past.
_FOREIGN_SCOPE = r"(?:inherited|unrelated|pre-existing|carried|foreign)"
_FOREIGN_FAIL_RE = re.compile(
    r"\b" + _FOREIGN_SCOPE + r"\s+\d+\s+FAIL(?:S|ED|URE|URES)?\b"
    r"|\b\d+\s+" + _FOREIGN_SCOPE + r"\s+FAIL(?:S|ED|URE|URES)?\b"
    r"|\b\d+\s+FAIL(?:S|ED|URE|URES)?\b"
    r"(?:\s*/?\s*\d*\s*WARN(?:ING|INGS)?\b)?\s*"
    r"(?:\(\s*" + _FOREIGN_SCOPE + r"\s*\)|\b" + _FOREIGN_SCOPE + r"\b)",
    re.IGNORECASE,
)


def _claims_failure(text: str) -> bool:
    """Does this event text CLAIM a failure? (T-1241, narrowed by T-1281)

    Guessing toward failure is deliberate and stays: a real failure can never
    be talked past. What changed is SCOPE. The rule used to count every
    `FAIL`-family token anywhere in the body and veto unless each one carried
    an adjacent zero, so ordinary English vetoed a green cycle -- reproduced
    four times in one session on this repository alone:

        PASS -- the pre-fix FAIL is re-established
        PASS -- a failed atomic write leaves no orphan
        PASS -- zero anchored failures        (the zero is not adjacent)
        PASS -- CORE-004 was a fail-open condition   (the hyphen is a boundary)

    Same tree, same commit, same measurements; only prose moved. And the cost
    was not merely a blocked close: the release path had already created and
    PUSHED its closure commit before the refusal, so the veto published commits
    whose subject says DONE over a board that says DOING (T-1278).

    `structural_marker_events` in this module already names the class --
    Narrative Authority Leakage, a validator searching free text for a magic
    phrase -- and already prescribes the cure. This is that same defect at the
    opposite polarity, and the same cure: authority belongs to a VERDICT SHAPE,
    not to a word a sentence happens to contain.

    T-1241's counting rule is kept EXACTLY -- every token accounted for, a
    count rather than "contains a zero form somewhere", so `0 FAIL on core,
    3 FAIL on ship` is still a failure. It is only SCOPED to the verdict
    segment. And the two machine shapes that no prose produces by accident, a
    nonzero count and a nonzero `failures=` field, still claim from anywhere,
    so a narrative that names a real count cannot hide behind the separator.

    What this gives up, deliberately: a bare lowercase `failed` in the detail
    of a line whose verdict says PASS. That is the trade the four
    reproductions above are worth, and a real failure still has three ways to
    say so.

    T-1444 scopes the machine shapes: a count explicitly attributed to a
    foreign scope (`inherited 4 FAIL`, `4 FAIL / 22 WARN (inherited)`,
    `4 FAIL 22 WARN inherited`) reports ANOTHER acceptance surface and is
    removed before the scan. An unattributed count is untouched.
    """
    if _NEGATION_RE.search(text):
        return True
    body = text or ""
    # T-1444: counts explicitly attributed to a foreign/inherited scope are
    # narrative about another acceptance surface, never this ticket's claim.
    scoped = _FOREIGN_FAIL_RE.sub(" ", body)
    # Machine shapes: unambiguous wherever they appear.
    if _FAIL_COUNTED_RE.search(scoped) or _FAIL_FIELD_RE.search(scoped):
        return True
    verdict = scoped.split(_VERDICT_SEPARATOR, 1)[0]
    total = len(_FAIL_TOKEN_RE.findall(verdict))
    if not total:
        return False
    exempt = len(_ZERO_FAIL_RE.findall(verdict)) + len(_ZERO_FIELD_RE.findall(verdict))
    return total > exempt


# CORE-001: the regression channel is NOT the ordinary verification channel.
# A `REGRESSION-EVIDENCE FAIL ...` record is the REQUIRED red half of a pair --
# an agent recording it is complying, not reporting that the cycle failed --
# but `_claims_failure` sees the word and vetoes. The two classifiers answer
# different questions over the same LOG, so the ordinary one steps over the
# other one's records rather than guessing about them. `regression_evidence`
# reads exactly these, and nothing else reads them at all.
def _is_regression_evidence(text: str) -> bool:
    from .oracle import parse_evidence

    return parse_evidence(text) is not None


def _is_verify_boundary(ev: dict) -> bool:
    """True iff `ev` is the EXACT machine-owned VERIFY entry marker.

    The boundary text is owned by the engine (`_plan_transition` always
    writes `transition to VERIFY`, optionally followed by ` -- <reason>`).
    A transition whose marker was replaced by caller-supplied prose is NOT
    a boundary: the engine can no longer tell where verification started,
    so the ticket is unproven (hostile-regression, machine-owned grammar).
    """
    txt = ev.get("text", "")
    return txt == "transition to VERIFY" or txt.startswith(_VERIFY_BOUNDARY_PREFIX)


def regression_evidence(ticket_id: str, events: list[dict]) -> tuple[bool, str]:
    """`(admissible, reason)` for a ticket that owes a regression PAIR.

    CORE-001. `verification_evidence` above answers "did something green happen
    in this cycle" and cannot answer "did the IMPLEMENTATION cause it" -- it
    reads free-form text and never compares an oracle to a subject. A ticket
    declaring `regression: required` needs both answers, so this is the second
    half, scoped exactly the same way: the current VERIFY cycle only, bounded
    by the latest machine-owned boundary, taxonomy RUN, ticket-scoped.

    Reuses `oracle.regression_pair_verdict` rather than re-deciding: one
    arithmetic, one place, so the gate and the module cannot drift.
    """
    from .oracle import parse_evidence, regression_evidence_verdict

    if not ticket_id:
        return False, "no ticket id provided"
    boundary = None
    for i in range(len(events) - 1, -1, -1):
        ev = events[i]
        if (
            ev.get("ticket") == ticket_id
            and ev.get("taxonomy") == "RUN"
            and _is_verify_boundary(ev)
        ):
            boundary = i
            break
    if boundary is None:
        return False, NO_VERIFY_BOUNDARY

    records = []
    for ev in events[boundary:]:
        if ev.get("ticket") != ticket_id or ev.get("taxonomy") != "RUN":
            continue
        record = parse_evidence(ev.get("text", ""))
        if record is not None:
            records.append(record)
    verdict = regression_evidence_verdict(records)
    return bool(verdict.get("admissible")), f"{verdict['code']}: {verdict['reason']}"


def structural_marker_events(
    events,
    marker: str,
    taxonomies=("RUN",),
    *,
    after_event: int = 0,
) -> list[int]:
    """Event ids where `marker` is ACTUAL AUTHORITY, not prose that mentions it.

    Narrative Authority Leakage is this repository's most expensive recurring
    defect: a validator searches free text for a magic phrase, and any line that
    merely DISCUSSES the phrase silently acquires the power the phrase carries.
    Two instances have cost real work.

    The timestamp-inversion amnesty was one boolean over the whole corpus --
    "does any segment anywhere contain this sentence" -- so three sealed DEC
    lines from July 2026 disarmed the inversion check for every line written
    afterwards, and it reported nothing for five weeks. Repairing it, the SCOUT
    checkpoint that quoted the marker while diagnosing it disarmed the check
    again, one level up.

    The clean-HUNT marker was the same shape and still live when this was
    written: 28 LOG lines contain `hunt -> clean @` and only 24 are the
    canonical record. The other four are prose -- a note and two checkpoints
    discussing it -- and each of them alone activated the converge prohibition
    without a HUNT having run.

    Three conditions, and dropping any one reopens the class:

    * TAXONOMY -- authority belongs to the record type that carries it. A `RUN`
      reporting an action is not a `DEC` deciding one, and prose about either
      is neither.
    * ANCHORING -- the marker must BEGIN the event text. A sentence containing
      it is describing it. This is the same rule `_is_verify_boundary` already
      applies to the VERIFY boundary, generalized rather than re-invented.
    * BOUNDING -- `after_event` scopes the authority to events at or after a
      named point, so an exception cannot cover work that had not happened when
      it was granted. A suppressor whose scope is "the file" cannot expire.

    Returns the event ids, so a caller can bound its own decision against them
    rather than collapsing the answer to a boolean it cannot scope.
    """
    if not marker:
        return []
    allowed = tuple(taxonomies)
    found: list[int] = []
    for ev in events:
        if ev.get("taxonomy") not in allowed:
            continue
        event_id = ev.get("event")
        if not isinstance(event_id, int) or event_id < after_event:
            continue
        if (ev.get("text") or "").startswith(marker):
            found.append(event_id)
    return found


def verification_evidence(ticket_id: str, events: list[dict]) -> tuple[bool, str]:
    """Classify verification evidence for a ticket (hostile-regression).

    Machine-owned grammar. Searches backwards from the end of the history:

    - the boundary is the LATEST exact VERIFY entry marker
      (`transition to VERIFY` or `transition to VERIFY -- <reason>`) for
      this ticket; a replaced/forged marker is not a boundary;
    - only RUN events for the ticket AFTER that boundary count (the
      current verification cycle);
    - negative evidence wins: a FAILURE CLAIM (`_claims_failure`), `NOT PASS`
      or `NOT MANUAL-VERIFY` fails immediately. A zero count in front of the
      token (`0 FAIL`, `no failures`) is not a claim (T-1241);
    - PASS evidence is the exact `PASS` token (word-boundary, so e.g.
      COMPASS never matches) with the exact `conf: high` marker; an
      explicit `conf: low`/`conf: med` disqualifies;
    - MANUAL-VERIFY evidence is the exact `MANUAL-VERIFY` token not
      negated;
    - no boundary or no evidence after it -> unproven/failed.
    """
    if not ticket_id:
        return False, "no ticket id provided"

    verify_start_idx = None
    for i in range(len(events) - 1, -1, -1):
        ev = events[i]
        if ev.get("ticket") == ticket_id and ev.get("taxonomy") == "RUN":
            if _is_verify_boundary(ev):
                verify_start_idx = i
                break
    if verify_start_idx is None:
        return False, NO_VERIFY_BOUNDARY

    for i in range(len(events) - 1, verify_start_idx - 1, -1):
        ev = events[i]
        if ev.get("ticket") != ticket_id or ev.get("taxonomy") != "RUN":
            continue
        txt = ev.get("text", "")
        if _is_regression_evidence(txt):
            continue
        if _claims_failure(txt):
            return False, txt
        manual = _MANUAL_RESULT_RE.match(txt.strip())
        if manual is not None:
            # An explicit human verdict, either way. A recorded FAIL is
            # negative evidence, not "keep looking for something greener".
            return manual.group(1) == "PASS", txt
        if _PASS_TOKEN_RE.search(txt):
            if "conf: low" in txt or "conf: med" in txt:
                return False, txt
            if "conf: high" in txt:
                return True, txt

    return False, "unproven/failed"


def bulk_verification_evidence(
    events: list[dict], ticket_ids: Iterable[str]
) -> dict[str, tuple[bool, str]]:
    """ONE backward pass computing the verdict for EVERY requested ticket
    (perf wave T-1021).

    `verification_evidence` reverse-scans the full shared history once per
    ticket, so a status with many DONE tickets costs O(tickets * events).
    This helper walks the SAME event list backward exactly once and applies
    the IDENTICAL grammar per ticket:

    - the boundary for a ticket is its latest exact VERIFY marker; events
      older than it are out of the current cycle;
    - while walking newest-first, the first decisive RUN event after the
      boundary decides (negative evidence wins, then MANUAL-VERIFY, then
      PASS with exact `conf: high`);
    - the boundary event itself is scanned for decisive tokens exactly as
      the single-ticket helper does (its scan is inclusive of the boundary);
    - no boundary or no decisive evidence after it -> unproven/failed with
      the same reason strings.

    Returns {ticket_id: (ok, reason)} for every requested id, byte-for-byte
    the same (ok, reason) the single-ticket helper would return.

    The pass is single-sweep: while walking newest-first, the first decisive
    RUN event per ticket is tentatively stored as pending evidence; the
    verdict is finalized when the ticket's NEWEST VERIFY boundary is reached
    (evidence older than the boundary is out of cycle, and a ticket with no
    boundary is unproven regardless of pending evidence -- exactly the
    single-ticket early return).
    """
    wanted = set(ticket_ids)
    verdicts: dict[str, tuple[bool, str]] = {}
    boundary_seen: set[str] = set()
    pending: dict[str, tuple[bool, str]] = {}
    for ev in reversed(events):
        if ev.get("taxonomy") != "RUN":
            continue
        tid = ev.get("ticket")
        if tid not in wanted or tid in verdicts:
            continue
        if tid in boundary_seen:
            continue  # older than the newest VERIFY boundary: out of cycle
        txt = ev.get("text", "")
        if _is_regression_evidence(txt):
            continue
        decisive = None
        if _claims_failure(txt):
            decisive = (False, txt)
        elif _MANUAL_RESULT_RE.match(txt.strip()):
            decisive = (_MANUAL_RESULT_RE.match(txt.strip()).group(1) == "PASS", txt)
        elif _PASS_TOKEN_RE.search(txt):
            if "conf: low" in txt or "conf: med" in txt:
                decisive = (False, txt)
            elif "conf: high" in txt:
                decisive = (True, txt)
        if _is_verify_boundary(ev):
            # The NEWEST boundary closes the cycle; the boundary event itself
            # is inside the scan (single-ticket scans it inclusively), so it
            # may still be the decisive evidence when nothing newer is.
            boundary_seen.add(tid)
            if decisive is not None and tid not in pending:
                pending[tid] = decisive
            verdicts[tid] = pending.get(tid) or (False, "unproven/failed")
            continue
        if decisive is not None and tid not in pending:
            pending[tid] = decisive
    for tid in wanted:
        if tid not in verdicts:
            verdicts[tid] = (
                False,
                NO_VERIFY_BOUNDARY
                if tid not in boundary_seen
                else "unproven/failed",
            )
    return verdicts


# ---------------------------------------------------------------------------
# Pre-closure-contract (LEGACY generation) completion evidence.
#
# `bulk_verification_evidence` above encodes the MODERN closure contract: a
# ticket is proven only by a VERIFY boundary event plus a decisive `conf: high`
# PASS after it. That grammar is younger than the projects it is now asked to
# judge. A record completed before the VERIFY-boundary/confidence grammar
# existed carries real execution evidence in a shape that predates it -- a
# ticket-scoped `RUN: BUILD ...` / `RUN: SHIP ...` narrating the work and its
# proof -- and reading its absence of a FUTURE field as proof of fabrication is
# how a recovery engine proposes to destroy valid history.
#
# This classifier answers a DIFFERENT question from the modern one, and is used
# ONLY for records the caller has already classified as legacy-generation:
# "did this ticket ever execute, under the grammar that existed then?"
# ---------------------------------------------------------------------------

#: The execution markers the pre-closure-contract generation actually wrote.
#: Deliberately narrow: an allocation/claim `DEC` is bookkeeping, never
#: execution, and only `RUN` taxonomy is consulted at all.
_LEGACY_EXECUTION_RE = re.compile(r"\b(BUILD|SHIP|VERIFY|PASS)\b")

#: An explicit operator attestation of a legacy completion (`saipen recover
#: --attest-legacy-done`). It fabricates no historical closure_mode and
#: rewrites no historical LOG; it records a NOW-dated decision that the
#: historical completion stands.
LEGACY_DONE_ATTESTATION = "legacy completion attested"


def legacy_done_attestation_text(ticket_id: str) -> str:
    """The exact DEC text one legacy-completion attestation writes."""
    return (
        f"{LEGACY_DONE_ATTESTATION} for {ticket_id} -- operator decision; the "
        "historical completion stands as recorded. No closure_mode is "
        "fabricated for a generation that had none and no historical LOG line "
        "is rewritten."
    )


def bulk_legacy_completion_evidence(
    events: list[dict], ticket_ids: Iterable[str]
) -> dict[str, tuple[bool, str]]:
    """ONE backward pass: did each legacy-generation ticket actually execute?

    Grammar, newest-first, first decisive event per ticket wins:

    - an explicit operator attestation (`LEGACY_DONE_ATTESTATION`) proves it;
    - a FAILURE CLAIM (`_claims_failure`) is negative evidence and wins over an
      older success exactly as in the modern classifier;
    - a ticket-scoped `RUN` carrying a legacy execution marker
      (`BUILD`/`SHIP`/`VERIFY`/`PASS`) proves it;
    - regression-describing prose is skipped, not read as a verdict.

    No VERIFY boundary is required and no `conf:` token is required: neither
    existed when these records were written. Absence of decisive evidence is
    reported as ambiguity for an operator, never as proof of fabrication.
    """
    wanted = set(ticket_ids)
    verdicts: dict[str, tuple[bool, str]] = {}
    for ev in reversed(events or ()):
        tid = ev.get("ticket")
        if tid not in wanted or tid in verdicts:
            continue
        txt = ev.get("text", "")
        if LEGACY_DONE_ATTESTATION in txt:
            verdicts[tid] = (True, txt)
            continue
        if ev.get("taxonomy") != "RUN":
            continue
        if _is_regression_evidence(txt):
            continue
        if _claims_failure(txt):
            verdicts[tid] = (False, txt)
        elif _LEGACY_EXECUTION_RE.search(txt):
            verdicts[tid] = (True, txt)
    for tid in wanted:
        verdicts.setdefault(
            tid,
            (
                False,
                "no historical execution evidence in the complete history",
            ),
        )
    return verdicts
