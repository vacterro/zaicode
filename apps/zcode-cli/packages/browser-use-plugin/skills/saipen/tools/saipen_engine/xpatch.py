"""XPATCH -- Cross-Repo Patch Receipt (T-1256 proposal mode).

DEFECT CLASS THIS KILLS: a SAIPEN project changes a bounded file set in
ANOTHER SAIPEN project, and the target can only see `working tree changed`.
A deliberate, fully explainable foreign mutation is then indistinguishable
from unexplained dirt, so the honest outcome is a generic stop or a human
escalation for something no human needs to decide.

THE ONE RULE: a foreign change MUST NOT count as an unknown change when a
verifiable receipt states who changed it, from where, why, which exact bytes,
and under which Work. `ATTRIBUTED_FOREIGN_PATCH` is a new ATTRIBUTION CLASS,
never a new verdict.

RECEIPT MEANS PROVENANCE, NEVER CORRECTNESS. The target is not obliged to
believe the patch is good; it is obliged to stop treating it as a mystery.
The target keeps full authority to VERIFY, REPAIR, SUPERSEDE or REVERT, and
its own disposition record is what enters its canonical history.

NAMESPACE BOUNDARY (fail-closed): a foreign actor may write exactly
`.saipen/exchange/xpatch/XP-NNNNNN/` plus the declared target source paths.
Every declared path that starts with `.saipen/` is refused, so target STATE /
BOARD / LOG / milestones / release metadata / ticket lifecycle can never be
written by a foreign agent wearing the receipt as a hat.

CRASH SEMANTICS: `intent.json` is durable BEFORE any target-source byte
moves and already declares the intended after-hashes, so a crash between
intent and `applied.json` leaves bytes that are either still the before-state
(no delta at all) or the declared after-state (claimed by the intent). There
is no window in which a mutation exists with no receipt explaining it.

PAYLOAD IS EXACT BYTES, NOT A DIFF. `payload.json` carries base64 file
contents keyed by relative path, plus the ORIGINAL bytes it displaces. A
fuzzy patch application would reintroduce exactly the ambiguity the hashes
exist to remove: apply writes the declared bytes and proves the resulting
sha256, or it refuses.

DIRECT MODE IS GATED. Writing into a foreign worktree is a compare-and-swap
on a file another agent may hold -- that is T-473 (concurrent whole-file
clobber guard), HELD behind T-442. Without that guard the target can write a
stale in-memory copy over a landed XPATCH and the receipt becomes a lie, so
`apply_direct` refuses with DIRECT_MODE_UNAVAILABLE instead of pretending.
Reading a direct receipt stays supported; producing one locally does not.

Full design: `.saipen/KNOWLEDGE/XPATCH.md`.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .errors import EngineError

SCHEMA_VERSION = 1
EXCHANGE_REL = ".saipen/exchange/xpatch"
PATCH_ID_RE = re.compile(r"\AXP-\d{6}\Z")
SHA256_RE = re.compile(r"\A[0-9a-f]{64}\Z")
MAX_PATCH_ID = 999999

INTENT_NAME = "intent.json"
PAYLOAD_NAME = "payload.json"
APPLIED_NAME = "applied.json"
DISPOSITION_NAME = "disposition.json"

MODES = ("proposal", "direct")
VERIFICATION_RESULTS = ("PASS", "FAIL", "UNKNOWN")
DISPOSITIONS = ("VERIFIED", "REPAIRED", "SUPERSEDED", "REVERTED")

STATE_PENDING = "PENDING"
STATE_APPLIED = "APPLIED"

# Closed outcome vocabulary. These are XPATCH outcomes, not engine error
# codes: the protocol's stable code set stays untouched by this module.
OUTCOME_RECORDED = "RECORDED"
OUTCOME_APPLIED = "APPLIED"
OUTCOME_TARGET_DRIFT = "TARGET_DRIFT"
OUTCOME_DIRECT_MODE_UNAVAILABLE = "DIRECT_MODE_UNAVAILABLE"
OUTCOMES = (
    OUTCOME_RECORDED,
    OUTCOME_APPLIED,
    OUTCOME_TARGET_DRIFT,
    OUTCOME_DIRECT_MODE_UNAVAILABLE,
)


class XPatchError(EngineError):
    """A receipt operation refused BEFORE touching target source bytes."""

    code = "MALFORMED_PACKAGE"


# -- hashing -----------------------------------------------------------


def sha256_hex(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def claim_hash(sha256: str | None) -> str | None:
    """The 16-hex attribution token convergence compares against.

    Both sides hash the SAME bytes with the SAME algorithm, so the receipt's
    full sha256 truncates to exactly the journal token attribution already
    uses. Storing a second digest kind would guarantee eventual drift.
    """
    return None if sha256 is None else sha256[:16]


def _file_sha256(path: Path) -> str | None:
    """sha256 of a REGULAR file, or None when it does not exist.

    A symlink/reparse/directory at a declared path is not "a file that
    differs": it is unsafe topology, and every caller treats it as drift.
    """
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:
        return None
    if os.path.islink(path) or bool(getattr(info, "st_file_attributes", 0) & 0x400):
        return None
    if not path.is_file():
        return None
    try:
        return sha256_hex(path.read_bytes())
    except OSError:
        return None


# -- path discipline ---------------------------------------------------


def canonical_target_path(root: Path, rel: object) -> str:
    """Validate ONE declared target-source path, or raise.

    Refuses: non-strings, absolute and drive-qualified paths, backslash
    separators, empty/dot/dotdot segments, anything resolving outside the
    project, and the ENTIRE `.saipen/` runtime namespace. The last one is the
    namespace boundary: a foreign actor never writes target protocol state.
    """
    if not isinstance(rel, str) or not rel:
        raise XPatchError(f"declared path {rel!r} is not a non-empty string")
    if "\\" in rel:
        raise XPatchError(f"declared path {rel!r} uses non-canonical separators")
    if rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
        raise XPatchError(f"declared path {rel!r} is absolute", code="PATH_ESCAPE")
    parts = rel.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise XPatchError(f"declared path {rel!r} has a non-canonical segment", code="PATH_ESCAPE")
    if parts[0] == ".saipen":
        raise XPatchError(
            f"declared path {rel!r} is inside the target runtime namespace -- "
            "a foreign actor never writes target STATE/BOARD/LOG or any other "
            ".saipen state",
            code="PATH_ESCAPE",
        )
    root_resolved = Path(root).resolve()
    try:
        (Path(root) / rel).resolve().relative_to(root_resolved)
    except ValueError:
        raise XPatchError(
            f"declared path {rel!r} escapes the project root", code="PATH_ESCAPE"
        ) from None
    return rel


def exchange_dir(root: Path | str) -> Path:
    return Path(root) / EXCHANGE_REL


def receipt_dir(root: Path | str, patch_id: str) -> Path:
    if not PATCH_ID_RE.match(patch_id or ""):
        raise XPatchError(f"patch id {patch_id!r} fails the XP-NNNNNN grammar", code="INVALID_ID")
    return exchange_dir(root) / patch_id


# -- receipt model -----------------------------------------------------


@dataclass(frozen=True)
class Receipt:
    """One decoded, lineage-bound receipt and everything derived from it."""

    patch_id: str
    mode: str
    state: str
    source: dict
    target: dict
    reason: str
    paths: dict  # rel -> {"before_sha256": str|None, "after_sha256": str|None}
    verification: tuple
    created_at: str
    applied_at: str = ""
    disposition: str = ""
    disposition_at: str = ""
    disposition_paths: dict = field(default_factory=dict)
    note: str = ""

    @property
    def work_id(self) -> str:
        return str(self.source.get("work_id") or "")

    @property
    def agent(self) -> str:
        return str(self.source.get("agent") or "")

    def claims(self, root: Path) -> dict:
        """rel -> 16-hex expected token (None == declared deletion).

        The LATEST authority wins per receipt: a target disposition supersedes
        the foreign after-state, because a REPAIR is the target's own bytes
        and must not read as "the receipt went stale".

        A PENDING receipt claims ONLY the paths whose live bytes already equal
        its declared after-state. That is the whole attribution rule and it is
        not circular: the hash it must match was declared in advance, in a
        receipt bound to this lineage. It closes both windows at once -- a
        crash after a direct write leaves bytes the intent still explains, and
        an unapplied proposal claims nothing, because claiming an after-state
        nobody wrote would report every waiting proposal as a stale claim over
        bytes that never moved.
        """
        if self.disposition_paths:
            return {rel: claim_hash(value) for rel, value in self.disposition_paths.items()}
        declared = {rel: claim_hash(spec.get("after_sha256")) for rel, spec in self.paths.items()}
        if self.state != STATE_PENDING:
            return declared
        return {
            rel: expected
            for rel, expected in declared.items()
            if claim_hash(_file_sha256(Path(root) / rel)) == expected
        }

    def claim_kind(self) -> str:
        if self.disposition_paths:
            return "xpatch_disposition"
        if self.state == STATE_APPLIED:
            return "xpatch_applied"
        return "xpatch_intent"

    def claim_time(self) -> str:
        return self.disposition_at or self.applied_at or self.created_at


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise XPatchError(message)


def _decode_paths(root: Path, raw: object) -> dict:
    _require(isinstance(raw, dict) and bool(raw), "receipt declares no paths")
    out: dict[str, dict] = {}
    for declared, spec in raw.items():
        rel = canonical_target_path(root, declared)
        _require(isinstance(spec, dict), f"path {rel!r} carries a malformed spec")
        before = spec.get("before_sha256")
        after = spec.get("after_sha256")
        for label, value in (("before_sha256", before), ("after_sha256", after)):
            _require(
                value is None or (isinstance(value, str) and bool(SHA256_RE.match(value))),
                f"path {rel!r} has a malformed {label}",
            )
        _require(
            before is not None or after is not None,
            f"path {rel!r} declares neither a before nor an after state",
        )
        _require(before != after, f"path {rel!r} declares a no-op mutation")
        out[rel] = {"before_sha256": before, "after_sha256": after}
    return out


def _decode_verification(raw: object) -> tuple:
    if raw is None:
        return ()
    _require(isinstance(raw, list), "verification is not a list")
    out = []
    for item in raw:
        _require(isinstance(item, dict), "verification entry is not an object")
        command = item.get("command")
        result = item.get("result")
        _require(isinstance(command, str) and bool(command), "verification entry has no command")
        _require(
            result in VERIFICATION_RESULTS,
            f"verification result {result!r} is not one of {VERIFICATION_RESULTS}",
        )
        out.append({"command": command, "result": result})
    return tuple(out)


def _strict_utc(value: object, label: str) -> str:
    from .board import strict_iso_utc

    parsed = strict_iso_utc(value)
    _require(bool(parsed), f"{label} is not a strict UTC timestamp")
    return parsed


def _read_json(path: Path) -> dict | None:
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError, OSError):
        return None
    if os.path.islink(path) or bool(getattr(info, "st_file_attributes", 0) & 0x400):
        raise XPatchError(f"{path.name} is not a regular file")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise XPatchError(f"{path.name} is unreadable: {exc}") from None


def load_receipt(root: Path | str, patch_id: str) -> Receipt:
    """Decode ONE receipt and bind it to the LIVE target lineage, or raise.

    A receipt whose target lineage is absent, malformed, or belongs to another
    project is never positive attribution here. Fail-closed is the whole
    point: an unbindable receipt must read as unattributed dirt, not as a
    permission slip.
    """
    from .paths import project_lineage_identity

    root = Path(root)
    directory = receipt_dir(root, patch_id)
    intent = _read_json(directory / INTENT_NAME)
    _require(intent is not None, f"{patch_id} has no {INTENT_NAME}")
    _require(isinstance(intent, dict), f"{patch_id} intent is not an object")

    _require(intent.get("schema") == SCHEMA_VERSION, f"{patch_id} has an unsupported schema")
    _require(intent.get("patch_id") == patch_id, f"{patch_id} intent names a different patch id")
    mode = intent.get("mode")
    _require(mode in MODES, f"{patch_id} declares mode {mode!r}, not one of {MODES}")

    source = intent.get("source")
    _require(isinstance(source, dict), f"{patch_id} has no source block")
    for key in ("project_lineage", "work_id", "agent"):
        value = source.get(key)
        _require(
            isinstance(value, str) and bool(value),
            f"{patch_id} source.{key} is missing or empty",
        )

    target = intent.get("target")
    _require(isinstance(target, dict), f"{patch_id} has no target block")
    target_lineage = target.get("project_lineage")
    _require(
        isinstance(target_lineage, str) and bool(target_lineage),
        f"{patch_id} target.project_lineage is missing or empty",
    )
    live_lineage = project_lineage_identity(root)
    _require(
        bool(live_lineage),
        f"{patch_id} cannot bind: this project has no readable durable lineage",
    )
    _require(target_lineage == live_lineage, f"{patch_id} targets a foreign project lineage")

    reason = intent.get("reason")
    _require(isinstance(reason, str) and bool(reason.strip()), f"{patch_id} states no reason")
    paths = _decode_paths(root, intent.get("paths"))
    created_at = _strict_utc(intent.get("created_at"), f"{patch_id} created_at")
    verification = _decode_verification(intent.get("verification"))

    applied = _read_json(directory / APPLIED_NAME)
    applied_at = ""
    state = STATE_PENDING
    if applied is not None:
        _require(isinstance(applied, dict), f"{patch_id} applied record is not an object")
        _require(
            applied.get("patch_id") == patch_id,
            f"{patch_id} applied record names a different id",
        )
        applied_paths = _decode_paths(root, applied.get("paths"))
        _require(
            applied_paths == paths,
            f"{patch_id} applied record contradicts the intent it claims to complete",
        )
        applied_at = _strict_utc(applied.get("applied_at"), f"{patch_id} applied_at")
        _require(
            applied_at >= created_at, f"{patch_id} claims to be applied before it was intended"
        )
        verification = _decode_verification(applied.get("verification")) or verification
        state = STATE_APPLIED

    disposition = ""
    disposition_at = ""
    disposition_paths: dict = {}
    note = ""
    record = _read_json(directory / DISPOSITION_NAME)
    if record is not None:
        _require(isinstance(record, dict), f"{patch_id} disposition is not an object")
        _require(record.get("patch_id") == patch_id, f"{patch_id} disposition names a different id")
        verdict = record.get("verdict")
        _require(
            verdict in DISPOSITIONS,
            f"{patch_id} disposition {verdict!r} is not one of {DISPOSITIONS}",
        )
        _require(
            state == STATE_APPLIED,
            f"{patch_id} carries a disposition for a patch that was never applied",
        )
        disposition = verdict
        disposition_at = _strict_utc(record.get("recorded_at"), f"{patch_id} disposition time")
        raw_paths = record.get("paths")
        _require(isinstance(raw_paths, dict), f"{patch_id} disposition has malformed paths")
        for declared, value in raw_paths.items():
            rel = canonical_target_path(root, declared)
            _require(
                rel in paths, f"{patch_id} disposition claims {rel!r}, outside the receipt scope"
            )
            _require(
                value is None or (isinstance(value, str) and bool(SHA256_RE.match(value))),
                f"{patch_id} disposition carries a malformed hash for {rel!r}",
            )
            disposition_paths[rel] = value
        _require(
            set(disposition_paths) == set(paths),
            f"{patch_id} disposition covers {sorted(disposition_paths)}, not the whole "
            f"receipt scope {sorted(paths)} -- a partial verdict would leave half the "
            "patch claimed by the foreign after-state and half by the target",
        )
        note = str(record.get("note") or "")
        state = verdict

    return Receipt(
        patch_id=patch_id,
        mode=mode,
        state=state,
        source=dict(source),
        target=dict(target),
        reason=reason,
        paths=paths,
        verification=verification,
        created_at=created_at,
        applied_at=applied_at,
        disposition=disposition,
        disposition_at=disposition_at,
        disposition_paths=disposition_paths,
        note=note,
    )


def load_receipts(root: Path | str) -> tuple[list[Receipt], list[str]]:
    """Every receipt in the exchange namespace, plus one problem line each
    for the ones that could not bind.

    Problems are VISIBLE, never dropped: a receipt that failed to decode is
    exactly the case that must not turn into silent attribution.
    """
    root = Path(root)
    base = exchange_dir(root)
    receipts: list[Receipt] = []
    problems: list[str] = []
    if not base.is_dir() or os.path.islink(base):
        return receipts, problems
    for entry in sorted(base.iterdir()):
        if not entry.is_dir() or os.path.islink(entry):
            problems.append(f"xpatch namespace holds a non-directory entry {entry.name}")
            continue
        if not PATCH_ID_RE.match(entry.name):
            problems.append(f"xpatch namespace holds {entry.name}, not an XP-NNNNNN receipt")
            continue
        try:
            receipts.append(load_receipt(root, entry.name))
        except EngineError as exc:
            problems.append(f"xpatch {entry.name} does not bind: {exc.message}")
        except (OSError, ValueError) as exc:
            problems.append(f"xpatch {entry.name} is unreadable: {exc}")
    return receipts, problems


# -- attribution surface (consumed by convergence) ---------------------


def claim_records(root: Path | str) -> tuple[list[dict], list[str]]:
    """Merge-ready attribution records for every bound receipt.

    Shape matches what `convergence._merge` already consumes, so XPATCH adds
    a claim SOURCE and never a second attribution engine.
    """
    root = Path(root)
    receipts, problems = load_receipts(root)
    records = []
    for receipt in receipts:
        claims = receipt.claims(root)
        if not claims:
            continue
        records.append(
            {
                "patch_id": receipt.patch_id,
                "created_at": receipt.claim_time(),
                "op_id": receipt.patch_id,
                "ticket_id": receipt.work_id,
                "project_lineage": str(receipt.target.get("project_lineage") or ""),
                "source_kind": receipt.claim_kind(),
                "paths": claims,
            }
        )
    return records, problems


def summary(root: Path | str) -> dict:
    """The one-line cold-context surface. No dashboard.

    unreviewed  a bound receipt the target has not dispositioned yet
                (a pending proposal is unreviewed by definition)
    verified    the target itself recorded VERIFIED
    conflicting a receipt that does not bind, or whose live bytes match
                NEITHER the state it claims nor its declared before-state
    """
    root = Path(root)
    receipts, problems = load_receipts(root)
    unreviewed = 0
    verified = 0
    conflicting = len(problems)
    for receipt in receipts:
        recorded = receipt.disposition_paths or None
        drifted = False
        for rel, spec in receipt.paths.items():
            live = claim_hash(_file_sha256(root / rel))
            if recorded is not None:
                if live != claim_hash(recorded.get(rel)):
                    drifted = True
                continue
            after = claim_hash(spec.get("after_sha256"))
            if receipt.state != STATE_PENDING:
                if live != after:
                    drifted = True
                continue
            # A pending receipt is fine at either declared end. A THIRD state
            # is a real conflict: those bytes are somebody else's, and the
            # patch can no longer be applied over them.
            if live not in (after, claim_hash(spec.get("before_sha256"))):
                drifted = True
        if drifted:
            conflicting += 1
        elif receipt.disposition == "VERIFIED":
            verified += 1
        elif receipt.disposition in ("REPAIRED", "SUPERSEDED", "REVERTED"):
            continue  # closed by the target's own Work; no longer foreign news
        else:
            unreviewed += 1
    return {
        "unreviewed": unreviewed,
        "verified": verified,
        "conflicting": conflicting,
        "problems": problems,
        "line": (
            f"FOREIGN PATCHES: {unreviewed} unreviewed, "
            f"{verified} verified, {conflicting} conflicting"
        ),
    }


# -- producing a receipt -----------------------------------------------


def allocate_patch_id(root: Path | str) -> str:
    """Claim the next free XP id by EXCLUSIVE directory creation.

    `mkdir` is the compare-and-swap: two producers racing on the same id
    cannot both win, so no lock is invented for a problem the filesystem
    already decides.
    """
    base = exchange_dir(root)
    base.mkdir(parents=True, exist_ok=True)
    existing = [int(p.name[3:]) for p in base.iterdir() if PATCH_ID_RE.match(p.name)]
    candidate = (max(existing) + 1) if existing else 1
    while candidate <= MAX_PATCH_ID:
        patch_id = f"XP-{candidate:06d}"
        try:
            (base / patch_id).mkdir()
            return patch_id
        except FileExistsError:
            candidate += 1
    raise XPatchError("xpatch id space is exhausted", code="VALIDATION_FAILED")


def write_intent(
    target_root: Path | str,
    *,
    source: dict,
    reason: str,
    contents: dict,
    now: str,
    mode: str = "proposal",
    verification: list | None = None,
    base_head: str = "",
    patch_id: str | None = None,
) -> dict:
    """Record a receipt for a bounded mutation of `target_root`.

    `contents` maps a declared target path to the EXACT bytes the patch wants
    there (`None` == declared deletion). Before-hashes are MEASURED from the
    live target, so a receipt can never claim a before-state that was never
    there. Nothing under the target's source tree is written: the intent and
    payload land in the exchange namespace and nowhere else.
    """
    from .paths import project_lineage_identity, safe_atomic_write_bytes

    root = Path(target_root)
    _require(mode in MODES, f"mode {mode!r} is not one of {MODES}")
    _require(isinstance(source, dict), "source block is required")
    for key in ("project_lineage", "work_id", "agent"):
        value = source.get(key)
        _require(isinstance(value, str) and bool(value), f"source.{key} is missing or empty")
    _require(
        isinstance(reason, str) and bool(reason.strip()),
        "a receipt without a reason is not a receipt",
    )
    _require(isinstance(contents, dict) and bool(contents), "no declared content")

    live_lineage = project_lineage_identity(root)
    _require(
        bool(live_lineage),
        "target project has no readable durable lineage -- refuse rather than "
        "bind a receipt to a project that cannot be identified later",
    )
    created_at = _strict_utc(now, "created_at")

    paths: dict[str, dict] = {}
    payload: dict[str, object] = {}
    originals: dict[str, object] = {}
    for declared, body in contents.items():
        rel = canonical_target_path(root, declared)
        _require(
            body is None or isinstance(body, bytes),
            f"declared content for {rel!r} is not bytes or None",
        )
        destination = root / rel
        before = _file_sha256(destination)
        after = None if body is None else sha256_hex(body)
        _require(
            before is not None or after is not None,
            f"{rel!r} declares a deletion of a file that does not exist",
        )
        _require(before != after, f"{rel!r} declares a no-op mutation")
        paths[rel] = {"before_sha256": before, "after_sha256": after}
        payload[rel] = None if body is None else base64.b64encode(body).decode("ascii")
        originals[rel] = (
            None if before is None else base64.b64encode(destination.read_bytes()).decode("ascii")
        )

    decoded_verification = list(_decode_verification(verification))
    allocated = patch_id or allocate_patch_id(root)
    _require(bool(PATCH_ID_RE.match(allocated)), f"patch id {allocated!r} is malformed")
    directory = receipt_dir(root, allocated)
    directory.mkdir(parents=True, exist_ok=True)

    record = {
        "schema": SCHEMA_VERSION,
        "patch_id": allocated,
        "mode": mode,
        "source": {
            "project_lineage": source["project_lineage"],
            "work_id": source["work_id"],
            "attempt_id": str(source.get("attempt_id") or ""),
            "agent": source["agent"],
        },
        "target": {"project_lineage": live_lineage, "base_head": str(base_head or "")},
        "reason": reason,
        "paths": paths,
        "verification": decoded_verification,
        "created_at": created_at,
    }
    # Payload first, intent last: the intent IS the commit pointer, so a torn
    # write can leave an ignorable half-receipt but never a claimed one.
    safe_atomic_write_bytes(
        directory / PAYLOAD_NAME,
        json.dumps(
            {
                "schema": SCHEMA_VERSION,
                "patch_id": allocated,
                "contents": payload,
                "originals": originals,
            },
            indent=2,
        ).encode("utf-8"),
        kind="xpatch payload",
        ownership_root=root,
    )
    safe_atomic_write_bytes(
        directory / INTENT_NAME,
        json.dumps(record, indent=2).encode("utf-8"),
        kind="xpatch intent",
        ownership_root=root,
    )
    return {"outcome": OUTCOME_RECORDED, "patch_id": allocated, "mode": mode, "writes": 0}


def apply_direct(target_root: Path | str, patch_id: str) -> dict:
    """Refuse direct mode, loudly and by name.

    Direct apply is a compare-and-swap against a file another agent may hold.
    That guard is T-473, HELD behind the T-442 concurrent-mode gate. Landing
    it here would be v8 Concurrent Mode through the back door AND would leave
    a receipt the target can invalidate 200ms later by writing its stale copy.
    The bounded, honest behaviour is: zero target-source writes, downgrade to
    the proposal the target applies itself.
    """
    return {
        "outcome": OUTCOME_DIRECT_MODE_UNAVAILABLE,
        "patch_id": patch_id,
        "mode": "proposal",
        "writes": 0,
        "detail": (
            "direct apply needs the shared stale-write guard T-473 (HELD on "
            "T-442); tracked by T-1257. Receipt stands as a proposal."
        ),
    }


# -- target-side consumption -------------------------------------------


def apply_proposal(target_root: Path | str, patch_id: str, *, now: str) -> dict:
    """Apply a PENDING proposal with the TARGET's own hands.

    Every declared before-hash is re-proved at write time (optimistic CAS): a
    single moved byte means the decision that produced this patch was made
    against a state that no longer exists, so the answer is TARGET_DRIFT with
    ZERO writes -- never a hopeful overwrite.
    """
    from .paths import safe_atomic_write_bytes

    root = Path(target_root)
    receipt = load_receipt(root, patch_id)
    # Mode says who was SUPPOSED to write, never who MAY: a direct receipt
    # whose source died before touching a byte would otherwise strand the
    # target with a patch nobody is allowed to finish.
    _require(receipt.state == STATE_PENDING, f"{patch_id} is already {receipt.state}")
    applied_at = _strict_utc(now, "applied_at")

    payload = _read_json(receipt_dir(root, patch_id) / PAYLOAD_NAME)
    _require(isinstance(payload, dict), f"{patch_id} has no readable {PAYLOAD_NAME}")
    contents = payload.get("contents")
    _require(isinstance(contents, dict), f"{patch_id} payload has malformed contents")
    _require(
        set(contents) == set(receipt.paths),
        f"{patch_id} payload does not cover exactly the declared paths",
    )

    # Decode and prove EVERYTHING before the first byte moves: a payload that
    # fails halfway must never leave a half-applied patch behind.
    staged: dict[str, bytes | None] = {}
    for rel, spec in receipt.paths.items():
        live = _file_sha256(root / rel)
        if live != spec["before_sha256"]:
            return {
                "outcome": OUTCOME_TARGET_DRIFT,
                "patch_id": patch_id,
                "mode": "proposal",
                "writes": 0,
                "detail": f"{rel} moved since the receipt was recorded",
            }
        blob = contents[rel]
        if spec["after_sha256"] is None:
            _require(blob is None, f"{patch_id} payload contradicts the declared deletion of {rel}")
            staged[rel] = None
            continue
        _require(isinstance(blob, str), f"{patch_id} payload for {rel} is not base64 text")
        try:
            body = base64.b64decode(blob, validate=True)
        except (binascii.Error, ValueError):
            raise XPatchError(f"{patch_id} payload for {rel} is not valid base64") from None
        _require(
            sha256_hex(body) == spec["after_sha256"],
            f"{patch_id} payload for {rel} does not hash to the declared after-state",
        )
        staged[rel] = body

    for rel, body in staged.items():
        destination = root / rel
        if body is None:
            destination.unlink()
            continue
        safe_atomic_write_bytes(destination, body, kind="xpatch target", ownership_root=root)

    safe_atomic_write_bytes(
        receipt_dir(root, patch_id) / APPLIED_NAME,
        json.dumps(
            {
                "schema": SCHEMA_VERSION,
                "patch_id": patch_id,
                "applied_at": applied_at,
                "applied_by": "target",
                "paths": receipt.paths,
                "verification": [dict(item) for item in receipt.verification],
            },
            indent=2,
        ).encode("utf-8"),
        kind="xpatch applied",
        ownership_root=root,
    )
    return {
        "outcome": OUTCOME_APPLIED,
        "patch_id": patch_id,
        "mode": "proposal",
        "writes": len(staged),
    }


def record_disposition(
    target_root: Path | str,
    patch_id: str,
    verdict: str,
    *,
    now: str,
    note: str = "",
) -> dict:
    """The TARGET's own verdict over a foreign patch.

    This is where the mutation enters target authority: the receipt proved
    provenance, this record proves the target looked. Path hashes are read
    LIVE, so a REPAIR records the target's bytes and supersedes the foreign
    after-state instead of leaving the receipt permanently "stale".
    """
    from .paths import safe_atomic_write_bytes

    root = Path(target_root)
    _require(verdict in DISPOSITIONS, f"{verdict!r} is not one of {DISPOSITIONS}")
    receipt = load_receipt(root, patch_id)
    _require(
        receipt.state != STATE_PENDING,
        f"{patch_id} has not been applied -- there is nothing to disposition yet",
    )
    recorded_at = _strict_utc(now, "recorded_at")
    live = {rel: _file_sha256(root / rel) for rel in receipt.paths}
    safe_atomic_write_bytes(
        receipt_dir(root, patch_id) / DISPOSITION_NAME,
        json.dumps(
            {
                "schema": SCHEMA_VERSION,
                "patch_id": patch_id,
                "verdict": verdict,
                "recorded_at": recorded_at,
                "paths": live,
                "note": note,
            },
            indent=2,
        ).encode("utf-8"),
        kind="xpatch disposition",
        ownership_root=root,
    )
    return {"outcome": verdict, "patch_id": patch_id, "paths": live}


def revert(target_root: Path | str, patch_id: str, *, now: str) -> dict:
    """Undo an applied patch ONLY while the current bytes are still its own.

    Blind reverse-patch over later work is exactly the clobber this protocol
    exists to prevent: when the bytes moved on, the answer is REPAIR through
    ordinary target Work, not a rollback that eats it.
    """
    from .paths import safe_atomic_write_bytes

    root = Path(target_root)
    receipt = load_receipt(root, patch_id)
    _require(receipt.state == STATE_APPLIED, f"{patch_id} is {receipt.state}, not APPLIED")
    for rel, spec in receipt.paths.items():
        if _file_sha256(root / rel) != spec["after_sha256"]:
            return {
                "outcome": OUTCOME_TARGET_DRIFT,
                "patch_id": patch_id,
                "writes": 0,
                "detail": f"{rel} no longer holds the patched bytes -- repair, never clobber",
            }
    payload = _read_json(receipt_dir(root, patch_id) / PAYLOAD_NAME) or {}
    originals = payload.get("originals")
    _require(
        isinstance(originals, dict) and set(originals) == set(receipt.paths),
        f"{patch_id} carries no recorded original bytes -- repair instead of reverting",
    )
    restored: dict[str, bytes | None] = {}
    for rel, spec in receipt.paths.items():
        blob = originals[rel]
        if spec["before_sha256"] is None:
            _require(blob is None, f"{patch_id} original for {rel} contradicts a creation")
            restored[rel] = None
            continue
        _require(isinstance(blob, str), f"{patch_id} original for {rel} is not base64 text")
        try:
            body = base64.b64decode(blob, validate=True)
        except (binascii.Error, ValueError):
            raise XPatchError(f"{patch_id} original for {rel} is not valid base64") from None
        _require(
            sha256_hex(body) == spec["before_sha256"],
            f"{patch_id} original for {rel} does not hash to the declared before-state",
        )
        restored[rel] = body
    for rel, body in restored.items():
        destination = root / rel
        if body is None:
            destination.unlink()
            continue
        safe_atomic_write_bytes(destination, body, kind="xpatch revert", ownership_root=root)
    record_disposition(
        root, patch_id, "REVERTED", now=now, note="reverted to recorded before-state"
    )
    return {"outcome": "REVERTED", "patch_id": patch_id, "writes": len(restored)}
