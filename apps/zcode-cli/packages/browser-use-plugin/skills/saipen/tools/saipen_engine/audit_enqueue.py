"""Shared audit enqueue producer API -- SOURCE-AUDIT-ENQUEUE-01 (T-1230).

ONE constrained writer for every producer (a human script, AUDAPACK, a future
SAIPAL) that wants to put an audit in front of SAIPEN. The producer supplies
BYTES and an operation id; it never supplies a path, never names a layer
number, and can touch nothing else in the project.

Why an allocator file rather than "lowest free number": a deleted layer's
number must never come back. `audit/3.md` consumed and journaled away is a
DIFFERENT thing from a new audit that happens to land on 3, and every
provenance record downstream (receipt, tombstone, LOG line) keys on that
number plus a digest. First-free-gap allocation makes those records ambiguous
the first time an audit is consumed.

Durability shape is reserve-then-place, in that order:

  1. under the writer lock: read allocator, reconcile against the directory,
     persist ``{op -> {layer, state: RESERVED}}`` AND the advanced ``next_id``;
  2. still under the lock: write a RANDOMLY NAMED staging file beside the
     target, created exclusively (``O_EXCL``/``O_NOFOLLOW``, regular-file
     witness, complete write, fsync), then install it with ``os.link`` --
     which fails rather than clobbers when the destination exists;
  3. persist ``state: COMMITTED`` with the digest.

A crash between 1 and 2 burns one id and leaves no file -- the retry with the
same ``producer_operation_id`` finds its RESERVED record and finishes the SAME
id. A crash between 2 and 3 leaves a complete canonical layer whose record
still says RESERVED -- the retry reads it back, compares its digest, and
promotes only on a match; bytes that do not match the reservation are an
incomplete placement, removed and rewritten rather than promoted. Neither path
allocates twice, and no consumer ever sees partial bytes because the staging
name cannot match the canonical layer regex.

Two properties of step 2 are load-bearing and were each a defect:

* **The staging name is unpredictable.** It used to be exactly
  ``audit/.enqueue-<layer>.tmp``, opened with ``O_CREAT | O_TRUNC`` and no
  ``O_EXCL``, no ``O_NOFOLLOW`` and no identity witness. Pre-creating that node
  as a symlink or hardlink to a file OUTSIDE the project turned this
  constrained producer into an arbitrary same-permission truncate-and-write
  (W2-001, reproduced on Windows through both link types).
* **The install cannot overwrite.** It used to be ``target.exists()`` followed
  by ``os.replace``, and replace clobbers whatever appeared inside that window.
  ``os.link`` fails with ``FileExistsError`` instead, so "enqueue never
  overwrites a layer" is a property of the syscall rather than of timing.

Both are same-directory, same-filesystem operations, so the install has no
cross-device case to fall back for.

TRANSPORT ONLY, exactly like `audit_inbox`: nothing here parses the audit
body, derives Work, writes BOARD/STATE/LOG, or trusts one producer claim.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path

from . import audit_inbox
from .journal import _atomic_write, owned_target_path
from .lock import FileLockBusy, FileWriterLock
from .paths import (
    prove_owned_dir_chain,
    prove_owned_regular,
    read_bound_regular_bytes,
    safe_create_bytes_exclusive,
    safe_unlink_owned,
)
from .safeid import InvalidIdError, validate_safe_id

RULE_ID = "SOURCE-AUDIT-ENQUEUE-01"
SCHEMA_VERSION = 1
ALLOCATOR_REL = ".saipen/intake/audit_allocator.json"
LOCK_REL = ".saipen/locks/audit-allocator.lock"

RESERVED = "RESERVED"
COMMITTED = "COMMITTED"

# A producer name is a path-safe id AND a lowercase-ish stable token: the name
# ends up in provenance records that a human reads, so `SAIPAL` and `saipal`
# being two producers would be a bug, not a feature.
_PRODUCER_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")

# Staging-file prefix. The suffix is random per call: a predictable staging
# name was W2-001, because it can be pre-created as a link to an outside file.
_TEMP_PREFIX = ".enqueue-"

# The OS file lock is the CROSS-PROCESS writer. Inside one process the lock
# module deliberately refuses a second holder outright rather than queueing,
# so two threads of one producer would see WRITER_BUSY on a perfectly legal
# pair of enqueues. This guard makes same-process callers queue instead, and
# it is taken BEFORE the file lock so the two orders can never invert.
_PROCESS_GUARD = threading.Lock()

# T-1244: the wait is bounded. The guard used to be taken before an OS lock
# acquired with `blocking=True`, which waits forever -- so a foreign process
# holding the allocator lock parked the holding thread inside the OS call
# while it owned the guard, and every other same-process producer queued
# behind it with no diagnostic and no bound. Waiting is still correct
# (two simultaneous producers must get N and N+1, not a refusal a correct
# producer has to retry), so the fix is a deadline rather than a non-blocking
# acquire: one deadline covers the guard and the file lock together, and
# exhausting it returns the WRITER_BUSY this API already speaks.
LOCK_TIMEOUT_ENV = "SAIPEN_AUDIT_ENQUEUE_LOCK_TIMEOUT"
DEFAULT_LOCK_TIMEOUT = 30.0
_LOCK_RETRY_SLEEP = 0.02


class _AllocatorBusy(Exception):
    """The allocator lock stayed held for the whole bounded wait."""


def lock_timeout() -> float:
    """Seconds to wait for the allocator before reporting WRITER_BUSY.

    Overridable through the environment so a test can prove the refusal
    without sitting through the production wait. A non-numeric or
    non-positive value is the default, never an unbounded wait.
    """
    raw = os.environ.get(LOCK_TIMEOUT_ENV)
    if raw is None:
        return DEFAULT_LOCK_TIMEOUT
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_LOCK_TIMEOUT
    return value if value > 0 else DEFAULT_LOCK_TIMEOUT


@contextlib.contextmanager
def _allocator_lock(root: Path, timeout: float):
    """Hold the allocator across allocation and placement, or refuse in time.

    The guard is never held across an unbounded wait: it is taken with the
    same deadline the file lock gets, and both halves report which one ran out
    so a stuck enqueue names its cause instead of hanging.
    """
    deadline = time.monotonic() + timeout
    if not _PROCESS_GUARD.acquire(timeout=timeout):
        raise _AllocatorBusy(
            f"another thread in this process held the audit allocator guard "
            f"for the full {timeout:g}s wait"
        )
    try:
        while True:
            candidate = FileWriterLock(root / Path(LOCK_REL), root, blocking=False)
            try:
                candidate.acquire()
            except FileLockBusy:
                if time.monotonic() >= deadline:
                    raise _AllocatorBusy(
                        f"another process held {LOCK_REL} for the full {timeout:g}s wait"
                    ) from None
                time.sleep(_LOCK_RETRY_SLEEP)
                continue
            lock = candidate
            break
        try:
            yield lock
        finally:
            lock.release()
    finally:
        _PROCESS_GUARD.release()


def layer_digest(body: bytes) -> str:
    """The generation digest of an audit layer.

    Full SHA-256, deliberately not `journal.hash_bytes` (which truncates to 16
    hex for CAS tokens): this value has to equal what `audit_inbox` computes
    for the same file, or the consumer would treat every API-created layer as
    a different generation than the one the producer was told about.
    """
    return hashlib.sha256(body).hexdigest()


def _fail(code: str, detail: str) -> dict:
    return {"ok": False, "code": code, "detail": detail}


def allocator_path(root: Path | str) -> Path:
    return owned_target_path(Path(root), ALLOCATOR_REL, kind="audit allocator")


#: Allocator read states. ABSENT and CORRUPT are DIFFERENT answers (W2-003).
ALLOCATOR_ABSENT = "ABSENT"
ALLOCATOR_OK = "OK"
ALLOCATOR_CORRUPT = "CORRUPT"


def read_allocator_state(root: Path | str) -> tuple[dict, str]:
    """`(document, state)` -- the allocator, and whether it was really read.

    The old contract said absent and corrupt alike read as an empty allocator,
    and that "the worst a lost allocator costs is the idempotency memory of
    in-flight operations". That sentence was false, and W2-003 is the proof:
    `_reconcile` can rebuild the numeric FLOOR from the directory, the
    allocator's own records and the inbox binding, but it cannot rebuild
    ``producer + producer_operation_id -> layer``, which is the sole idempotence
    authority the retry path consults. So a crash after placement plus a
    damaged allocator turned an idempotent retry into DUPLICATE DISPATCH:
    reproduced as two identical layers with `ok: true` and `idempotent: false`.

    Reconstructing `next_id` is not reconstructing idempotence. This function
    therefore reports which of the two situations it is in and lets the caller
    decide; `enqueue` refuses on CORRUPT rather than starting from an empty
    operation map.
    """
    empty = {"schema_version": SCHEMA_VERSION, "next_id": 1, "operations": {}}
    path = Path(root) / Path(ALLOCATOR_REL)
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return empty, ALLOCATOR_ABSENT
    except OSError:
        # Present but unreadable is not absent: something is there and we
        # cannot see it, which is exactly the case that must not be guessed.
        return empty, ALLOCATOR_CORRUPT
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError):
        return empty, ALLOCATOR_CORRUPT
    if not isinstance(doc, dict):
        return empty, ALLOCATOR_CORRUPT
    if not isinstance(doc.get("operations"), dict):
        return empty, ALLOCATOR_CORRUPT
    next_id = doc.get("next_id")
    if not isinstance(next_id, int) or isinstance(next_id, bool) or next_id < 1:
        return empty, ALLOCATOR_CORRUPT
    doc["schema_version"] = SCHEMA_VERSION
    return doc, ALLOCATOR_OK


def read_allocator(root: Path | str) -> dict:
    """The allocator document, tolerant. Prefer `read_allocator_state`.

    Kept for read-only callers that only want the numeric floor and genuinely
    do not care why the document is empty. Every AUTHORIZATION decision must
    use `read_allocator_state`, because an empty map here can mean "nothing has
    been enqueued yet" or "the idempotence memory is gone", and those two must
    never produce the same action.
    """
    return read_allocator_state(root)[0]


def write_allocator(root: Path | str, doc: dict) -> None:
    root = Path(root)
    path = allocator_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(doc)
    payload["schema_version"] = SCHEMA_VERSION
    _atomic_write(
        path,
        (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        ownership_root=root,
    )


def _op_key(producer: str, operation_id: str) -> str:
    return f"{producer} {operation_id}"


def _reconcile(root: Path, doc: dict) -> dict:
    """Raise the allocator floor above every number this project has ever used.

    Three sources, and all three matter:

    * files on disk -- a manual `audit/99.md` drop is legitimate transport, so
      the allocator steps over it rather than planning to overwrite it;
    * this allocator's own operation records;
    * the AUDIT INBOX BINDING -- the durable record of layers that were
      captured and then consumed. Those files are gone from the directory, so a
      disk scan alone would happily hand number 3 back out, and every
      provenance record that keys on `audit/3.md` would then name two different
      audits. A consumed number is spent forever; that is the entire reason
      this allocator exists rather than a first-free-gap search.
    """
    highest = 0
    for item in audit_inbox.scan_layers(root):
        highest = max(highest, item["layer"])
    for record in doc["operations"].values():
        layer = record.get("layer")
        if isinstance(layer, int) and not isinstance(layer, bool):
            highest = max(highest, layer)
    for record in (audit_inbox.read_binding(root).get("layers") or {}).values():
        if not isinstance(record, dict):
            continue
        layer = record.get("layer")
        if isinstance(layer, int) and not isinstance(layer, bool):
            highest = max(highest, layer)
    if doc["next_id"] <= highest:
        doc["next_id"] = highest + 1
    return doc


def _validate_inputs(producer, operation_id, item_id, body):
    if not isinstance(producer, str) or not _PRODUCER_RE.match(producer):
        return _fail(
            "VALIDATION_FAILED",
            f"producer {producer!r} is not a stable lowercase token ([a-z][a-z0-9_-]{{0,31}})",
        )
    for name, value in (("producer_operation_id", operation_id), ("producer_item_id", item_id)):
        if value is None and name == "producer_item_id":
            continue
        try:
            validate_safe_id(value, kind=name)
        except InvalidIdError as exc:
            return _fail("INVALID_ID", str(exc))
    if isinstance(body, str):
        body = body.encode("utf-8")
    if not isinstance(body, (bytes, bytearray)):
        return _fail("VALIDATION_FAILED", "audit body must be bytes or str")
    body = bytes(body)
    if not body.strip():
        return _fail("VALIDATION_FAILED", "audit body is empty")
    if len(body) > audit_inbox.MAX_LAYER_BYTES:
        return _fail(
            "VALIDATION_FAILED",
            f"audit body is {len(body)} bytes; the layer bound is "
            f"{audit_inbox.MAX_LAYER_BYTES}",
        )
    return body


def _result(root: Path, record: dict, *, idempotent: bool) -> dict:
    rel = f"{audit_inbox.AUDIT_DIRNAME}/{record['layer']}.md"
    present = (Path(root) / Path(rel)).is_file()
    return {
        "ok": True,
        "code": "AUDIT_ENQUEUED",
        "rule_id": RULE_ID,
        "layer": record["layer"],
        "rel": rel,
        "sha256": record.get("sha256"),
        "producer": record.get("producer"),
        "producer_operation_id": record.get("producer_operation_id"),
        "producer_item_id": record.get("producer_item_id"),
        "created_at": record.get("created_at"),
        "idempotent": idempotent,
        "present": present,
    }


def _place(root: Path, layer: int, body: bytes) -> dict | None:
    """Write `audit/<layer>.md` atomically. Returns a failure dict or None."""
    directory = audit_inbox.audit_dir(root)
    try:
        directory.mkdir(parents=True, exist_ok=True)
        prove_owned_dir_chain(directory, kind="audit inbox", ownership_root=root)
    except (OSError, ValueError) as exc:
        return _fail("PATH_ESCAPE", f"audit inbox is not an owned directory: {exc}")
    try:
        target = owned_target_path(root, f"{audit_inbox.AUDIT_DIRNAME}/{layer}.md", kind="layer")
    except InvalidIdError as exc:
        return _fail("PATH_ESCAPE", str(exc))
    # W2-001: no predictable temporary node, and no check-then-replace.
    #
    # The old sequence opened `audit/.enqueue-<layer>.tmp` -- a name an
    # attacker can compute -- with O_CREAT|O_TRUNC and no O_EXCL, no
    # O_NOFOLLOW and no identity witness, then `os.replace`d it onto the
    # target. Planting that node as a symlink or a hardlink to a file OUTSIDE
    # the project turned this constrained producer into an arbitrary
    # same-permission truncate-and-write primitive: reproduced on Windows,
    # `_place` returned success, the outside file became the payload, and
    # `audit/<layer>.md` was left pointing at it. The escape completed before
    # canonical-layer validation could reject the resulting link.
    #
    # `safe_create_bytes_exclusive` is the hardened primitive this module
    # should always have reused: O_EXCL | O_NOFOLLOW, an fstat regular-file
    # witness, a complete write that cannot be short, an lstat identity
    # re-check after the write, and removal of its own partial file on any
    # failure. Creating the CANONICAL name exclusively also makes "enqueue
    # never overwrites a layer" atomic instead of a `target.exists()` test
    # with a window after it -- a destination that appears between planning
    # and install now loses the race by construction rather than by timing.
    # The staging file keeps the atomicity the canonical name needs: bytes
    # become a LAYER at the install, never before it, so a concurrent
    # `scan_layers` needs no reader lock. What changes is that its name is
    # UNPREDICTABLE and its creation EXCLUSIVE, so there is no node an
    # attacker can pre-create, and that the install cannot overwrite.
    temp = directory / f"{_TEMP_PREFIX}{layer}-{os.urandom(8).hex()}.tmp"
    try:
        safe_create_bytes_exclusive(
            temp,
            body,
            kind=f"audit layer {layer} staging",
            ownership_root=root,
        )
    except ValueError as exc:
        return _fail("PATH_ESCAPE", f"could not stage audit layer {layer}: {exc}")
    except OSError as exc:
        return _fail("VALIDATION_FAILED", f"could not stage audit layer {layer}: {exc}")

    try:
        # `os.link` is the atomic no-overwrite install. `os.replace` would
        # REPLACE a destination that appeared after the `target.exists()` test
        # above -- the audit's exact warning against a generic replace helper
        # whose normal semantics permit clobbering a preexisting target. link
        # fails with FileExistsError instead, so "enqueue never overwrites a
        # layer" stops depending on the width of that window. Same directory,
        # same filesystem, so there is no cross-device case to fall back for.
        os.link(temp, target)
    except FileExistsError:
        _drop_staging(temp, layer, root)
        return _fail(
            "CONFLICT",
            f"{target.name} already exists; enqueue never overwrites a layer",
        )
    except OSError as exc:
        _drop_staging(temp, layer, root)
        return _fail("VALIDATION_FAILED", f"could not place audit layer {layer}: {exc}")
    _drop_staging(temp, layer, root)
    return None


def _drop_staging(temp: Path, layer: int, root: Path) -> None:
    """Remove our own staging file, never anything else.

    `safe_unlink_owned` refuses a linked, reparse or non-regular final node, so
    a staging path that somehow stopped being the file we created is left on
    disk as visible residue rather than followed and deleted.
    """
    with contextlib.suppress(OSError, ValueError):
        safe_unlink_owned(
            temp, kind=f"audit layer {layer} staging", ownership_root=root
        )


def _placed_digest(root: Path, layer: int) -> str | None:
    """The digest of an already-placed layer, or None when there is no owned
    regular file to read.

    W2-002: the retry path used `Path.is_file()`, which follows symlinks and
    says nothing about content, then promoted the record to COMMITTED with the
    digest it was HANDED. So a short write promoted partial bytes as complete
    and a planted link counted as a placed layer. The module's own contract
    always said the retry "sees the file, verifies the digest, and promotes" --
    this is the verification half, which was documented and absent.
    """
    target = root / audit_inbox.AUDIT_DIRNAME / f"{layer}.md"
    try:
        witnessed = prove_owned_regular(target, kind=f"audit layer {layer}")
    except (OSError, ValueError):
        return None
    try:
        raw = read_bound_regular_bytes(target, witnessed, max_bytes=audit_inbox.MAX_LAYER_BYTES)
    except (OSError, ValueError):
        return None
    return hashlib.sha256(raw).hexdigest()


def _digest_match_layer(root: Path, digest: str) -> tuple[int | None, str]:
    """The layer already carrying exactly these bytes, or `(None, "")`.

    SRC-019:R4 uses this only while the allocator is ABSENT, where the
    `producer + operation -> layer` map is gone and the bytes are the last
    surviving evidence of what a retry already sent. Two durable sources,
    answering different halves: a layer still on disk proves the delivery is
    pending, and a binding record proves it was captured and spent even though
    the file is long deleted.
    """
    for item in audit_inbox.scan_layers(root):
        layer = item.get("layer")
        if isinstance(layer, int) and _placed_digest(root, layer) == digest:
            return layer, f"{audit_inbox.AUDIT_DIRNAME}/{layer}.md"
    layers = audit_inbox.read_binding(root).get("layers")
    if isinstance(layers, dict):
        for rel, record in sorted(layers.items()):
            if not isinstance(record, dict) or record.get("file_sha256") != digest:
                continue
            layer = record.get("layer")
            if isinstance(layer, int) and not isinstance(layer, bool):
                return layer, str(rel)
    return None, ""


def _bound_delivery_state(root: Path, layer: int, digest: str) -> str | None:
    """The inbox binding state for exactly these bytes, or None when nothing
    downstream ever bound them.

    SRC-019:R5 -- an absent layer is a COMPLETED delivery only if something
    took the bytes, and `audit_inbox.consume_layer` cannot delete a layer
    without writing its binding record through the same journaled mutation.
    So a binding record carrying this digest is the proof, and its absence
    means the payload is gone with nobody having read it.
    """
    rel = f"{audit_inbox.AUDIT_DIRNAME}/{layer}.md"
    layers = audit_inbox.read_binding(root).get("layers")
    record = layers.get(rel) if isinstance(layers, dict) else None
    if not isinstance(record, dict) or record.get("file_sha256") != digest:
        return None
    state = record.get("state")
    return state if isinstance(state, str) and state else audit_inbox.NEW


def enqueue(
    root: Path | str,
    *,
    producer: str,
    body: bytes | str,
    producer_operation_id: str,
    producer_item_id: str | None = None,
) -> dict:
    """Place one producer audit as the next canonical layer. Idempotent per op."""
    root = Path(root)
    checked = _validate_inputs(producer, producer_operation_id, producer_item_id, body)
    if isinstance(checked, dict):
        return checked
    body = checked
    digest = layer_digest(body)
    key = _op_key(producer, producer_operation_id)

    try:
        # BLOCKING: two producers enqueueing at the same moment must both
        # succeed with N and N+1. A non-blocking refusal would make a correct
        # producer retry a correct call, which is the failure this API exists
        # to remove. The lock covers allocation and placement only -- never
        # analysis, never Source processing.
        with _allocator_lock(root, lock_timeout()):
            doc, allocator_state = read_allocator_state(root)
            if allocator_state == ALLOCATOR_CORRUPT:
                # W2-003: fail CLOSED. An empty operation map here is
                # indistinguishable from "nothing enqueued yet", and acting on
                # that guess allocates a SECOND layer for an operation that
                # already owns one. Refusing costs a retry after an explicit
                # repair; guessing costs duplicate audit work reported as
                # success, which is the strictly worse trade.
                return _fail(
                    "ALLOCATOR_CORRUPT",
                    f"{ALLOCATOR_REL} exists but cannot be read as an allocator "
                    "document. The numeric floor is rebuildable from the "
                    "directory; the producer-operation identity that makes a "
                    "retry idempotent is NOT, so enqueue refuses rather than "
                    "risk a duplicate allocation. Repair or remove the file "
                    "after confirming which operations already own a layer",
                )
            doc = _reconcile(root, doc)
            record = doc["operations"].get(key)

            if not isinstance(record, dict) and allocator_state == ALLOCATOR_ABSENT:
                # SRC-019:R4 -- the allocator is the ONLY home of
                # `producer + operation -> layer`, so when it is missing a retry
                # and a first attempt look identical: reproduced as the same
                # operation with the same bytes allocated a SECOND layer and
                # reported `idempotent: false`. `_reconcile` rebuilds the numeric
                # floor, which hides the symptom (no id is reused) while the
                # duplicate dispatch stays. The bytes themselves survived the
                # allocator, so they are the evidence: a layer already carrying
                # exactly this digest IS this operation's delivery, and the
                # record is rebuilt onto it instead of a second layer being spent.
                #
                # Bound to the ABSENT state deliberately. With a readable
                # allocator the operation map is authoritative and two distinct
                # operations sending identical bytes stay two deliveries.
                recovered, where = _digest_match_layer(root, digest)
                if recovered is not None:
                    record = {
                        "layer": recovered,
                        "producer": producer,
                        "producer_operation_id": producer_operation_id,
                        "producer_item_id": producer_item_id,
                        "created_at": audit_inbox._utc(),
                        "sha256": digest,
                        "state": COMMITTED,
                    }
                    doc["operations"][key] = record
                    write_allocator(root, doc)
                    result = _result(root, record, idempotent=True)
                    result["recovered_from"] = where
                    return result

            if isinstance(record, dict) and isinstance(record.get("layer"), int):
                # RETRY. The op already owns a number; finish that number or
                # report it. A retry with DIFFERENT bytes is a producer bug,
                # not a second audit -- refuse rather than silently keeping
                # whichever call happened to win.
                if record.get("sha256") not in (None, digest):
                    return _fail(
                        "CONFLICT",
                        f"producer_operation_id {producer_operation_id!r} already enqueued "
                        f"{record['sha256']}; a retry cannot change the audit body",
                    )
                # W2-002: promotion is a DIGEST comparison, never a existence
                # test. `Path.is_file()` follows symlinks and says nothing
                # about content, so a short write promoted partial bytes as a
                # complete layer and a planted link counted as a placement.
                # The contract at the top of this module always said the retry
                # "reads it back, compares its digest, and promotes only on a
                # match" -- this is that comparison.
                placed = _placed_digest(root, record["layer"])
                if placed == digest:
                    if record.get("state") != COMMITTED:
                        record.update(state=COMMITTED, sha256=digest)
                        write_allocator(root, doc)
                    return _result(root, record, idempotent=True)
                if placed is not None:
                    # Bytes are there and they are not the reserved ones. For a
                    # RESERVED record that is this operation's own incomplete
                    # placement: remove the proven-owned regular file and place
                    # again. `safe_unlink_owned` refuses a linked or non-regular
                    # node, so a hostile carrier is never silently deleted.
                    if record.get("state") == COMMITTED:
                        return _fail(
                            "CONFLICT",
                            f"audit layer {record['layer']} on disk does not match the "
                            f"committed digest {record['sha256']}; refusing to overwrite "
                            "a committed layer",
                        )
                    try:
                        safe_unlink_owned(
                            root / audit_inbox.AUDIT_DIRNAME / f"{record['layer']}.md",
                            kind=f"audit layer {record['layer']}",
                            ownership_root=root,
                        )
                    except (OSError, ValueError) as exc:
                        return _fail(
                            "PATH_ESCAPE",
                            f"audit layer {record['layer']} holds bytes that do not match "
                            f"its reservation and cannot be safely removed: {exc}",
                        )
                if record.get("state") == COMMITTED:
                    # SRC-019:R5 -- an absent layer used to be read as "consumed
                    # by the journaled cleanup" with nothing proving it. So a
                    # payload deleted before any capture was acknowledged
                    # `ok: true, idempotent: true, present: false`, and the
                    # producer was told its audit had been delivered when it
                    # existed nowhere. `consume_layer` writes the binding record
                    # in the same journaled mutation that deletes the bytes, so
                    # the binding IS the delivery proof: report the original
                    # allocation only when it names this digest.
                    bound = _bound_delivery_state(root, record["layer"], digest)
                    if bound is None:
                        return _fail(
                            "NEEDS_REPAIR",
                            f"audit layer {record['layer']} is absent and the audit inbox "
                            f"binding does not record digest {digest} at "
                            f"{audit_inbox.AUDIT_DIRNAME}/{record['layer']}.md, so nothing "
                            "downstream ever took these bytes and this retry cannot honestly "
                            "be called delivered. Replay a pending audit_inbox.consume "
                            "recovery if one is open, then retry; otherwise enqueue under a "
                            "new producer_operation_id",
                        )
                    result = _result(root, record, idempotent=True)
                    result["binding_state"] = bound
                    return result
                failure = _place(root, record["layer"], body)
                if failure is not None:
                    return failure
                record.update(state=COMMITTED, sha256=digest)
                write_allocator(root, doc)
                return _result(root, record, idempotent=True)

            layer = doc["next_id"]
            record = {
                "layer": layer,
                "producer": producer,
                "producer_operation_id": producer_operation_id,
                "producer_item_id": producer_item_id,
                "created_at": audit_inbox._utc(),
                "sha256": digest,
                "state": RESERVED,
            }
            doc["operations"][key] = record
            doc["next_id"] = layer + 1
            write_allocator(root, doc)

            failure = _place(root, layer, body)
            if failure is not None:
                # A REFUSAL is not a crash. Drop the reservation so the
                # operation is not poisoned forever by transient external
                # state, but leave `next_id` advanced -- the id is spent
                # either way, and reuse is the one thing this allocator
                # exists to prevent.
                doc["operations"].pop(key, None)
                write_allocator(root, doc)
                return failure
            record["state"] = COMMITTED
            write_allocator(root, doc)
            return _result(root, record, idempotent=False)
    except _AllocatorBusy as exc:
        return _fail("WRITER_BUSY", str(exc))
    except FileLockBusy as exc:
        return _fail("WRITER_BUSY", f"another audit enqueue holds the allocator lock: {exc}")
    except (OSError, ValueError) as exc:
        return _fail("VALIDATION_FAILED", f"audit enqueue failed: {exc}")


def status(root: Path | str) -> dict:
    """Read-only allocator projection. No audit body text, ever.

    W2-003: a corrupt allocator is REPORTED, never rendered as a synthetic
    empty one. A status that says `operations: 0` when the file is unreadable
    tells an operator the queue is idle at the exact moment it is unsafe.
    """
    doc, allocator_state = read_allocator_state(root)
    operations = doc["operations"]
    return {
        "ok": allocator_state != ALLOCATOR_CORRUPT,
        "code": (
            "AUDIT_ALLOCATOR_CORRUPT"
            if allocator_state == ALLOCATOR_CORRUPT
            else "AUDIT_ALLOCATOR_STATUS"
        ),
        "allocator_state": allocator_state,
        "rule_id": RULE_ID,
        "next_id": doc["next_id"],
        "last_allocated_id": doc["next_id"] - 1 if doc["next_id"] > 1 else None,
        "operations": len(operations),
        "reserved": sum(1 for r in operations.values() if r.get("state") == RESERVED),
    }
