"""SAIPEN audit-evidence manifest — the protocol's own export contract.

WHY THIS EXISTS
---------------
A packager cannot know which of `.saipen/` is load-bearing. Before this
module every consumer had to guess, and the guess was silently coupled to
Git: a project whose `.gitignore` carries `.saipen/*` hides the whole
protocol memory from `git ls-files --others --exclude-standard`, so an audit
snapshot could contain an old active intake receipt and nothing that could
contradict it. Measured across the registered project fleet, 10 of 24 SAIPEN
projects were in exactly that state.

Git visibility is a PUBLICATION decision. Audit evidence is a PROTOCOL
decision. This module keeps them separate: SAIPEN declares what its own
evidence is, and a consumer collects exactly that, bounded, without an
unrestricted walk of ignored trees and without anyone weakening
`.gitignore`.

The manifest is DECLARATIVE, not a file listing. It names paths and rules,
so it does not go stale when a checkpoint is written; only a protocol layout
change invalidates it. That is why a consumer may trust a manifest it did
not just watch SAIPEN generate.

CLASSIFICATION
--------------
`mandatory`
    Current-state interpretation is impossible without these. A snapshot
    missing one is not a degraded snapshot, it is a misleading one: STATE
    names the phase and the claimed ticket, BOARD carries the Work, LOG is
    the append-only event authority, IDENTITY is the lineage carrier.

`conditional`
    Required WHEN PRESENT. Sealed log segments make LOG's parent chain
    resolvable; the intake tree decides whether a source is active or
    closed; archived source bodies prove a closure was legitimate;
    KNOWLEDGE holds the durable detail artifacts that bounded LOG events
    reference by `detail_ref` (CORE.md: a new event is at most 1024 bytes
    and full proof lives in a hashable evidence artifact) -- without them
    an oversized proof is a dangling pointer. `evidence/` is the durable
    closure-proof store EVIDENCE-RETENTION-01 names; it was missing here, so
    a consumer packed a project as complete without the proof its LOG cited,
    and a project-local declaration was erased by the next regeneration.

`references`
    The closure records that cite evidence BY PATH (STATE, BOARD, LOG, sealed
    segments, active and archived coverage) and the surfaces a citation may
    point into. A cited file is required evidence even when no directory rule
    found it, so a consumer can prove the archive holds what closures claim
    instead of trusting equal counts over an incomplete discovery set. Source
    bodies and derived contracts are NOT carriers: they quote user prose, and
    a hypothetical path in a handoff is not a claim that proof exists.

`optional`
    Supporting material. Absence is honest, not degrading.

`non_exportable`
    Never leaves the project: OS lock files carrying no canonical truth,
    settled recovery records, machine-local runtime state, and exact receipt
    bodies whose distribution record declares quarantine. A consumer that
    copies these is leaking local state or protected authority, not collecting
    distributable evidence.
"""

from __future__ import annotations

import json
import stat as stat_module
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .paths import (
    BOARD_NAME,
    IDENTITY_NAME,
    LOCKS_DIR,
    LOG_NAME,
    LOGS_DIR,
    SAIPEN_DIR,
    STATE_NAME,
    safe_atomic_write_bytes,
)

#: Bumped only when the SHAPE of this contract changes. A consumer that
#: understands version N must refuse a manifest declaring N+1 rather than
#: reinterpreting unknown fields (see `compatibility` below).
CONTRACT_VERSION = 3

#: The manifest's own filename inside `.saipen/`. Deliberately MANIFEST.json:
#: a consumer that already honours a project-owned `MANIFEST.json` "required"
#: closure gets the mandatory files through machinery it already has, and
#: only the bounded directory rules need new code.
MANIFEST_NAME = "MANIFEST.json"

#: Files without which the snapshot cannot state the current lifecycle.
MANDATORY_FILES = (STATE_NAME, BOARD_NAME, LOG_NAME, IDENTITY_NAME)

#: (relative path, recursive, max_files). The cap is a containment bound, not
#: a budget: a consumer that hits it must report the snapshot incomplete
#: rather than truncate evidence silently.
CONDITIONAL_DIRS = (
    (LOGS_DIR, True, 4000),
    ("intake", True, 8000),
    ("archive/source", True, 8000),
    ("KNOWLEDGE", True, 4000),
    ("audit", False, 500),
    ("evidence", True, 4000),
    # T-1452: BOARD rows compacted by `saipen ticket compact` keep their full
    # text HERE and cite it as `detail_ref: .saipen/recovery/board-compaction/
    # T-###/...json`. `recovery/` is non-exportable as a whole, so an
    # "authoritative" snapshot used to drop text BOARD itself points at and
    # still report required_evidence_omitted=false. A positive durable
    # declaration outranks the broad prefix -- see `EXPORT_PRECEDENCE`.
    ("recovery/board-compaction", True, 8000),
    # T-1374: the LOG twin. An event over the live cap keeps its full text
    # HERE and LOG cites it as `detail_ref: .saipen/recovery/log-detail/
    # E-###-<hash>.json` (63 in SAIPEN and 4 in ProTrail when first measured,
    # 141 in SAIPEN on 2026-09-23), so an archive without it carried dangling
    # pointers while reporting COMPLETE. The metadata embeds the machine-local
    # project_identity, the same trade T-1452 made for board-compaction.
    ("recovery/log-detail", True, 8000),
)

#: Surfaces a closure record may cite by path (`<memory_root>/<surface>/...`).
#: Each one is also a CONDITIONAL_DIRS entry, so a cited file that exists is
#: collected by its directory rule as well.
#: T-1374: both externalized-detail stores are surfaces too -- a LOG or BOARD
#: `detail_ref` is a citation, and a consumer that cannot resolve one must
#: report the snapshot incomplete naming it, not COMPLETE.
REFERENCE_SURFACES = ("evidence", "recovery/log-detail", "recovery/board-compaction")

#: (relative path, kind, recursive, name suffix, max_files): the closure
#: records whose citations a consumer must resolve. Files carry no cap; a
#: directory carrier is walked only for names ending in its suffix.
REFERENCE_CARRIERS = (
    (STATE_NAME, "file", False, "", 0),
    (BOARD_NAME, "file", False, "", 0),
    (LOG_NAME, "file", False, "", 0),
    (LOGS_DIR, "dir", True, ".md", 4000),
    ("intake/coverage", "dir", False, ".json", 8000),
    ("archive/source", "dir", False, ".coverage.json", 8000),
)

#: Reading bounds for citation discovery. The carrier cap matches the intake
#: ledger cap; a consumer that hits any bound must report the snapshot
#: incomplete, because a citation it did not read is one it cannot account for.
REFERENCE_MAX_CARRIER_BYTES = 8 * 1024 * 1024
REFERENCE_MAX_TOTAL_BYTES = 64 * 1024 * 1024
REFERENCE_MAX_REFERENCES = 20000

OPTIONAL_DIRS = (
    ("extensions", True, 4000),
    ("kitchen", True, 500),
    ("saitranslate", True, 500),
)

#: Working state and OS artifacts. `locks/` holds no canonical truth (OPS.md
#: § 5), `recovery/` holds settled operation records, and LOCAL_STATE.json is
#: machine-local. None of it is evidence and all of it is private.
NON_EXPORTABLE = (
    f"{LOCKS_DIR}/",
    "recovery/",
    "quarantine/",
    "LOCAL_STATE.json",
)

#: T-1452 / SRC-103 defect A. The prefix list above answers "is this path
#: under a private ROOT" and nothing else, so a transient directory that
#: appears BELOW an allowed optional root -- `saitranslate/.prepare-staging/
#: <id>/.in-flight`, its payload tree, `.translation-cache` -- was exported by
#: an artifact that then declared `authoritative_state=true` and
#: `required_evidence_omitted=false`. Measured live on 2026-09-21 by
#: SAIPENVIEW at HEAD 654916e35a4c, and the same class as T-850.
#:
#: These are STRUCTURAL classes matched on any path SEGMENT at ANY depth, so a
#: new transient directory appearing under an otherwise durable root is
#: excluded the day it appears, without excluding the durable family above it.
TRANSIENT_SEGMENTS = (
    ".prepare-staging",
    ".collect-staging",
    ".staging",
    ".in-flight",
    ".translation-cache",
    ".cache",
    "__pycache__",
    SAIPEN_DIR,
)

#: Runtime coordination markers, matched on the FILE NAME at any depth. An
#: epoch marker says which producer generation is live right now; it is a
#: coordination value, never durable audit evidence.
TRANSIENT_FILENAMES = (
    "LOCAL_STATE.json",
    "producer_epoch.json",
    "crew_epoch.json",
    ".in-flight",
)

#: Write-in-progress and lock artifacts, matched on the file-name SUFFIX at
#: any depth. One constant for the classifier AND the published declaration:
#: a consumer applies the declaration, so a second literal is a second answer.
TRANSIENT_SUFFIXES = (".tmp", ".lock", ".partial")

#: A nested instance's OWN live checkpoint (`extensions/subs/<role>/STATE.md`
#: and friends). It is that instance's canonical truth, not this project's
#: evidence, and exporting it puts two live protocol states in one snapshot.
#: Matched structurally: a core protocol-memory filename anywhere BELOW the
#: memory root rather than at it.
NESTED_INSTANCE_FILES = (STATE_NAME, BOARD_NAME, LOG_NAME, IDENTITY_NAME)

#: The ONE ordering a consumer applies. Declared in the manifest so a packager
#: cannot invent its own and call the result authoritative.
EXPORT_PRECEDENCE = (
    "transient_segment_or_filename",
    "nested_instance_state",
    "declared_durable_path",
    "non_exportable_prefix",
    "directory_rule",
)

#: Result codes. One stable vocabulary for the CLI, the lifecycle hook and the
#: regression matrix.
CODE_WRITTEN = "AUDIT_MANIFEST_WRITTEN"
CODE_UPGRADED = "AUDIT_MANIFEST_UPGRADED"
CODE_CURRENT = "AUDIT_MANIFEST_CURRENT"
CODE_PLAN = "AUDIT_MANIFEST_PLAN"
CODE_REFUSED = "AUDIT_MANIFEST_REFUSED"

#: Why an enrollment did not happen. Never a silent no-op: a project that is not
#: enrolled must be able to say WHY in machine-readable form, because the
#: consumer downstream only knows the contract is missing.
REASON_MEMORY_ABSENT = "PROTOCOL_MEMORY_ABSENT"
REASON_LAYOUT_MALFORMED = "PROTOCOL_LAYOUT_MALFORMED"
REASON_CONTRACT_MALFORMED = "PROTOCOL_CONTRACT_MALFORMED"
REASON_CONTRACT_UNSUPPORTED = "PROTOCOL_CONTRACT_UNSUPPORTED"

#: Protocol-memory layout shapes. `UNSUPPORTED` is deliberately absent: an
#: unrecognized layout is REFUSED, never guessed at, because guessing is how a
#: manifest gets minted over a tree that is not a checkpoint at all.
LAYOUT_ABSENT = "ABSENT"            # no real `.saipen/` directory
LAYOUT_MALFORMED = "MALFORMED"      # `.saipen/` exists but is not a checkpoint
LAYOUT_LEGACY = "LEGACY_LINEAGE_ABSENT"  # supported older layout (pre-T-1003)
LAYOUT_CURRENT = "CURRENT"

#: What the on-disk `.saipen/MANIFEST.json` declares, if anything.
DECLARED_ABSENT = "ABSENT"
DECLARED_CURRENT = "CURRENT"
DECLARED_STALE = "STALE"            # older SUPPORTED contract -> migrate
DECLARED_MALFORMED = "MALFORMED"    # not this contract / unreadable
DECLARED_UNSUPPORTED = "UNSUPPORTED"  # a NEWER contract -> refuse

#: The documents a checkpoint cannot be read without. STATE names the phase and
#: the claimed ticket, BOARD carries the Work, LOG is the append-only event
#: authority. IDENTITY is mandatory evidence but a project may legitimately
#: predate it (see `LAYOUT_LEGACY`).
LAYOUT_CORE_FILES = (STATE_NAME, BOARD_NAME, LOG_NAME)


def _segments(relative_path: str) -> list[str]:
    raw = str(relative_path or "").replace("\\", "/")
    return [part for part in raw.split("/") if part and part != "."]


def is_transient(relative_path: str) -> bool:
    """True when a path under the memory root is runtime coordination.

    Structural and nesting-independent on purpose: the defect was a contract
    that could only answer "which ROOTS are private", so anything transient
    below a durable root shipped as evidence.
    """
    parts = _segments(relative_path)
    if not parts:
        return False
    if any(part in TRANSIENT_SEGMENTS for part in parts):
        return True
    last = parts[-1]
    return last in TRANSIENT_FILENAMES or last.endswith(TRANSIENT_SUFFIXES)


def is_nested_instance_state(relative_path: str) -> bool:
    """True for another live instance's own STATE/BOARD/LOG/IDENTITY."""
    parts = _segments(relative_path)
    return len(parts) > 1 and parts[-1] in NESTED_INSTANCE_FILES


def _declared_durable(relative_path: str) -> bool:
    parts = _segments(relative_path)
    if not parts:
        return False
    if len(parts) == 1 and parts[0] in MANDATORY_FILES:
        return True
    joined = "/".join(parts)
    for path, recursive, _cap in CONDITIONAL_DIRS:
        if joined == path:
            return True
        if joined.startswith(path + "/"):
            return recursive or "/" not in joined[len(path) + 1 :]
    return False


def is_exportable(relative_path: str) -> bool:
    """May this path, relative to `<memory_root>`, enter an audit snapshot?

    ONE owner for the question, applied in `EXPORT_PRECEDENCE` order, so the
    generator, the consumer and the regression matrix cannot disagree about
    what `authoritative_state=true` claims. Both failure directions are real
    and both were measured: transient runtime state leaking OUT through a
    broad optional root, and BOARD-cited `recovery/board-compaction` detail
    disappearing IN through a broad private prefix.
    """
    parts = _segments(relative_path)
    if not parts:
        return False
    joined = "/".join(parts)
    if is_transient(joined) or is_nested_instance_state(joined):
        return False
    if _declared_durable(joined):
        return True
    for prefix in NON_EXPORTABLE:
        if prefix.endswith("/"):
            if joined == prefix.rstrip("/") or joined.startswith(prefix):
                return False
        elif joined == prefix:
            return False
    return True


def _protocol_version(protocol_dir: Path | None) -> str:
    if protocol_dir is None:
        return ""
    for candidate in (protocol_dir / "VERSION", protocol_dir.parent / "VERSION"):
        try:
            return candidate.read_text(encoding="utf-8").strip()
        except OSError:
            continue
    return ""


def build(root: Path | str, *, protocol_dir: Path | str | None = None) -> dict[str, Any]:
    """Return the declarative audit-evidence manifest for this project.

    Pure: reads only the protocol VERSION. It never enumerates `.saipen/` --
    the manifest declares RULES, so it stays true across checkpoints and
    cannot drift from a listing it does not contain.

    Deliberately carries NO project identity. `paths.project_identity` is a
    machine-local runtime lock identity that changes when the project moves,
    so embedding it would churn the manifest per machine and invite a
    consumer to trust it as portable provenance. The portable lineage
    already travels in IDENTITY.md, which this contract makes mandatory.
    """
    _ = Path(root)
    # ONE resolution rule for every entry point: an omitted `protocol_dir`
    # means the RUNNING install's protocol home, never "no version". A
    # resolved-here value and an explicitly passed one are the same document,
    # so `is_current` cannot disagree with the writer that produced the bytes.
    pdir = Path(protocol_dir) if protocol_dir is not None else default_protocol_dir()
    return {
        "schema_version": 1,
        "kind": "saipen_audit_manifest",
        "contract_version": CONTRACT_VERSION,
        "protocol_version": _protocol_version(pdir),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": f"saipen-audit-manifest/{CONTRACT_VERSION}",
        "memory_root": SAIPEN_DIR,
        # Consumed by the conservative project-MANIFEST "required" closure a
        # packager may already implement. Paths are relative to THIS file's
        # directory, i.e. `.saipen/`.
        "required": list(MANDATORY_FILES),
        "evidence": {
            "mandatory": [{"path": name, "kind": "file"} for name in MANDATORY_FILES],
            "conditional": [
                {"path": p, "kind": "dir", "recursive": r, "max_files": cap}
                for p, r, cap in CONDITIONAL_DIRS
            ],
            "optional": [
                {"path": p, "kind": "dir", "recursive": r, "max_files": cap}
                for p, r, cap in OPTIONAL_DIRS
            ],
            "non_exportable": list(NON_EXPORTABLE),
            # T-1452: structural classes, matched on any path segment or file
            # name at ANY depth. A consumer that applies only the prefix list
            # above exports runtime coordination state and must not call the
            # result authoritative.
            "non_exportable_segments": list(TRANSIENT_SEGMENTS),
            "non_exportable_filenames": list(TRANSIENT_FILENAMES),
            "non_exportable_suffixes": list(TRANSIENT_SUFFIXES),
            "nested_instance_files": list(NESTED_INSTANCE_FILES),
            "precedence": list(EXPORT_PRECEDENCE),
            "authority_note": (
                "authoritative_state=true asserts this artifact satisfies THIS "
                "contract -- every declared durable path present and every "
                "transient class excluded -- not merely that the mandatory "
                "files happened to exist."
            ),
        },
        "references": {
            "surfaces": list(REFERENCE_SURFACES),
            "carriers": [
                {"path": p, "kind": kind}
                if kind == "file"
                else {"path": p, "kind": kind, "recursive": r, "suffix": suffix, "max_files": cap}
                for p, kind, r, suffix, cap in REFERENCE_CARRIERS
            ],
            "max_carrier_bytes": REFERENCE_MAX_CARRIER_BYTES,
            "max_total_bytes": REFERENCE_MAX_TOTAL_BYTES,
            "max_references": REFERENCE_MAX_REFERENCES,
        },
        "compatibility": {
            "unknown_contract_version": "refuse",
            "note": (
                "A consumer reading contract_version greater than it "
                "implements MUST report the snapshot as protocol-unknown "
                "rather than reinterpreting this document."
            ),
        },
    }


def default_protocol_dir() -> Path | None:
    """The running install's canonical protocol home, or None.

    Optional by design: reading a manifest never needs it, and an engine
    running outside an install (unit fixtures) simply records an empty
    `protocol_version` rather than failing the enrollment over metadata the
    contract does not depend on.
    """
    try:
        from .paths import resolve_protocol_dir, resolve_tool_root

        return resolve_protocol_dir(resolve_tool_root())
    except (OSError, ValueError):
        return None


def render(manifest: dict[str, Any]) -> bytes:
    """Deterministic UTF-8 bytes for a manifest (stable key order, LF)."""
    text = json.dumps(manifest, indent=1, sort_keys=True, ensure_ascii=False)
    return (text + "\n").encode("utf-8")


def manifest_path(root: Path | str) -> Path:
    return Path(root) / SAIPEN_DIR / MANIFEST_NAME


def classify_layout(root: Path | str) -> dict[str, Any]:
    """Classify the project's protocol-memory layout, fail closed.

    Three answers are possible for a `.saipen/` that exists:

    ``CURRENT``
        STATE/BOARD/LOG are present as real regular files and IDENTITY.md
        carries the portable lineage.

    ``LEGACY``
        The same checkpoint, written before the T-1003 lineage carrier. It is
        a SUPPORTED older layout: enrollment proceeds, and the contract keeps
        declaring IDENTITY.md mandatory so a consumer reports the snapshot
        honest-but-incomplete until `journal.ensure_project_lineage` mints it
        on the project's next canonical mutation. Migration happens through
        the protocol's own journaled path -- never by fabricating an identity
        document here.

    ``MALFORMED``
        `.saipen/` exists but is not a loadable checkpoint (a missing, empty or
        non-regular STATE/BOARD/LOG). Refused: minting a contract that declares
        current lifecycle evidence over a tree that has none would produce
        exactly the false confidence this contract exists to remove.

    Reads are bounded to the layout: one stat per canonical document, one
    short read of STATE.md.
    """
    root = Path(root)
    saipen_dir = root / SAIPEN_DIR
    try:
        if saipen_dir.is_symlink() or not saipen_dir.is_dir():
            return {
                "state": LAYOUT_ABSENT,
                "detail": f"no real {SAIPEN_DIR}/ directory at {root}",
                "missing": list(MANDATORY_FILES),
            }
    except OSError as exc:
        return {
            "state": LAYOUT_ABSENT,
            "detail": f"{SAIPEN_DIR}/ is not readable: {exc}",
            "missing": list(MANDATORY_FILES),
        }

    present: list[str] = []
    missing: list[str] = []
    malformed: list[str] = []
    for name in MANDATORY_FILES:
        path = saipen_dir / name
        try:
            st = path.lstat()
        except OSError:
            missing.append(name)
            continue
        if path.is_symlink() or not stat_module.S_ISREG(st.st_mode):
            malformed.append(name)
            continue
        present.append(name)

    broken = [name for name in LAYOUT_CORE_FILES if name in missing or name in malformed]
    if broken:
        return {
            "state": LAYOUT_MALFORMED,
            "detail": (
                f"{SAIPEN_DIR}/ is not a loadable checkpoint: "
                + ", ".join(sorted({*missing, *malformed}))
                + " absent or not a regular file"
            ),
            "missing": sorted({*missing, *malformed}),
        }
    try:
        if not (saipen_dir / STATE_NAME).read_bytes().strip():
            return {
                "state": LAYOUT_MALFORMED,
                "detail": f"{SAIPEN_DIR}/{STATE_NAME} is empty",
                "missing": [STATE_NAME],
            }
    except OSError as exc:
        return {
            "state": LAYOUT_MALFORMED,
            "detail": f"{SAIPEN_DIR}/{STATE_NAME} is unreadable: {exc}",
            "missing": [STATE_NAME],
        }

    if IDENTITY_NAME not in present:
        return {
            "state": LAYOUT_LEGACY,
            "detail": (
                f"a checkpoint predating {SAIPEN_DIR}/{IDENTITY_NAME}; the "
                "lineage carrier is established by the next canonical mutation "
                "(journal.ensure_project_lineage)"
            ),
            "missing": [IDENTITY_NAME],
        }
    return {"state": LAYOUT_CURRENT, "detail": "", "missing": []}


def declared(root: Path | str, *, protocol_dir: Path | str | None = None) -> dict[str, Any]:
    """What `.saipen/MANIFEST.json` declares right now, without writing.

    A newer `contract_version` is its own answer (`UNSUPPORTED`): refusing it
    is the only honest option, because reinterpreting a document whose shape
    is unknown is how a consumer ends up certifying evidence it cannot name.
    """
    root = Path(root)
    path = manifest_path(root)
    base: dict[str, Any] = {
        "state": DECLARED_ABSENT,
        "path": path.as_posix(),
        "contract_version": None,
        "detail": "",
    }
    try:
        st = path.lstat()
    except OSError:
        return base
    if path.is_symlink() or not stat_module.S_ISREG(st.st_mode):
        return {**base, "state": DECLARED_MALFORMED, "detail": "not a regular file"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError) as exc:
        return {**base, "state": DECLARED_MALFORMED, "detail": f"unreadable: {exc}"}
    if not isinstance(data, dict) or data.get("kind") != "saipen_audit_manifest":
        return {
            **base,
            "state": DECLARED_MALFORMED,
            "detail": "does not declare kind=saipen_audit_manifest",
        }
    version = data.get("contract_version")
    if not isinstance(version, int) or isinstance(version, bool):
        return {
            **base,
            "state": DECLARED_MALFORMED,
            "detail": "contract_version is missing or not an integer",
        }
    base["contract_version"] = version
    if version > CONTRACT_VERSION:
        return {
            **base,
            "state": DECLARED_UNSUPPORTED,
            "detail": (
                f"declares contract_version {version}; this protocol writes "
                f"{CONTRACT_VERSION} and refuses to downgrade a newer contract"
            ),
        }
    if version < CONTRACT_VERSION or not is_current(root, protocol_dir=protocol_dir):
        return {
            **base,
            "state": DECLARED_STALE,
            "detail": (
                "an older or drifted declaration of a supported contract; "
                "rewritten deterministically from the current contract"
            ),
        }
    return {**base, "state": DECLARED_CURRENT, "detail": ""}


def ensure(
    root: Path | str,
    *,
    protocol_dir: Path | str | None = None,
    force: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Enroll or migrate this project in the audit-evidence contract.

    THE lifecycle entry point: a project that is a valid SAIPEN project must
    not have to know that a consumer needs a contract document, and must not
    have to hand-author one. This is idempotent (a current manifest returns
    ``AUDIT_MANIFEST_CURRENT`` having written nothing), deterministic (the
    bytes come from `build`), additive (nothing else in `.saipen/` is read
    beyond the layout probe, and nothing is ever deleted) and entirely
    independent of Git -- a project whose `.gitignore` hides `.saipen/*` is
    enrolled exactly like any other.

    Fail closed. It refuses when there is no real protocol memory root, when
    the checkpoint is not loadable, when an existing `.saipen/MANIFEST.json` is
    not this contract, and when it declares a NEWER contract version. `force`
    is the explicit operator override for the two *declaration* refusals (a
    malformed or newer manifest) and deliberately does NOT override a broken
    layout: no flag may mint a contract over a tree that has no checkpoint.
    """
    root = Path(root)
    protocol_dir = Path(protocol_dir) if protocol_dir is not None else default_protocol_dir()
    path = manifest_path(root)
    layout = classify_layout(root)
    result: dict[str, Any] = {
        "ok": False,
        "code": CODE_REFUSED,
        "path": path.as_posix(),
        "contract_version": CONTRACT_VERSION,
        "changed": False,
        "layout": layout["state"],
        "dry_run": dry_run,
    }
    if layout["state"] == LAYOUT_ABSENT:
        return {
            **result,
            "reason_code": REASON_MEMORY_ABSENT,
            "detail": layout["detail"],
        }
    if layout["state"] == LAYOUT_MALFORMED:
        return {
            **result,
            "reason_code": REASON_LAYOUT_MALFORMED,
            "detail": layout["detail"],
        }

    current = declared(root, protocol_dir=protocol_dir)
    if current["state"] == DECLARED_UNSUPPORTED and not force:
        return {
            **result,
            "reason_code": REASON_CONTRACT_UNSUPPORTED,
            "declared": current["state"],
            "declared_contract_version": current["contract_version"],
            "detail": current["detail"],
        }
    if current["state"] == DECLARED_MALFORMED and not force:
        return {
            **result,
            "reason_code": REASON_CONTRACT_MALFORMED,
            "declared": current["state"],
            "detail": (
                f"{path.as_posix()} is not this contract ({current['detail']}); "
                "it is never overwritten implicitly -- re-run with --force to "
                "replace the declaration"
            ),
        }
    if current["state"] == DECLARED_CURRENT:
        return {
            **result,
            "ok": True,
            "code": CODE_CURRENT,
            "declared": current["state"],
            "manifest_present": True,
            "manifest_current": True,
        }

    upgrading = current["state"] in (DECLARED_STALE, DECLARED_UNSUPPORTED)
    code = CODE_UPGRADED if upgrading else CODE_WRITTEN
    # Regeneration may legally replace a drifted document, but never narrow
    # the declared evidence without saying which surface it removed.
    dropped = _dropped_declarations(root, build(root, protocol_dir=protocol_dir))
    narrowing = {"dropped_declarations": dropped} if dropped else {}
    if dry_run:
        return {
            **result,
            "ok": True,
            "code": CODE_PLAN,
            "changed": True,
            "would_change": True,
            "declared": current["state"],
            "changed_files": [path.as_posix()],
            **narrowing,
        }

    written = write(root, protocol_dir=protocol_dir, force=True)
    if not written.get("ok"):
        return {
            **result,
            "reason_code": REASON_LAYOUT_MALFORMED,
            "declared": current["state"],
            "detail": written.get("detail", "manifest write refused"),
        }
    return {
        **result,
        "ok": True,
        "code": code,
        "changed": True,
        "declared": current["state"],
        "manifest_present": True,
        "manifest_current": True,
        "detail": current["detail"],
        **narrowing,
    }


def _dropped_declarations(root: Path, wanted: dict[str, Any]) -> list[str]:
    """`tier:path` evidence declarations on disk that `wanted` no longer makes."""
    try:
        on_disk = json.loads(manifest_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return []
    evidence = on_disk.get("evidence") if isinstance(on_disk, dict) else None
    if not isinstance(evidence, dict):
        return []
    dropped: list[str] = []
    for tier in ("mandatory", "conditional", "optional"):
        kept = {item["path"] for item in wanted["evidence"][tier]}
        items = evidence.get(tier)
        for item in items if isinstance(items, list) else ():
            declared_path = item.get("path") if isinstance(item, dict) else item
            if isinstance(declared_path, str) and declared_path not in kept:
                dropped.append(f"{tier}:{declared_path}")
    return dropped


def is_current(root: Path | str, *, protocol_dir: Path | str | None = None) -> bool:
    """True when the on-disk manifest already declares this exact contract.

    Compares everything except the timestamp, so a no-op refresh does not
    rewrite bytes and does not churn the packager's change detection.
    """
    path = manifest_path(root)
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return False
    if not isinstance(current, dict):
        return False
    wanted = build(root, protocol_dir=protocol_dir)
    current.pop("generated_at", None)
    wanted.pop("generated_at", None)
    return current == wanted


def write(
    root: Path | str,
    *,
    protocol_dir: Path | str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Write `.saipen/MANIFEST.json` atomically. Idempotent unless `force`.

    The low-level writer. Callers that are NOT the operator (any lifecycle
    hook) use :func:`ensure`, which decides whether a write is legal at all
    before a byte is planned. This one still refuses a project with no real
    `.saipen/`, so no path can create the document elsewhere.
    """
    root = Path(root)
    path = manifest_path(root)
    if not force and is_current(root, protocol_dir=protocol_dir):
        return {
            "ok": True,
            "code": CODE_CURRENT,
            "path": path.as_posix(),
            "contract_version": CONTRACT_VERSION,
            "changed": False,
        }
    manifest = build(root, protocol_dir=protocol_dir)
    saipen_dir = root / SAIPEN_DIR
    try:
        valid_root = not saipen_dir.is_symlink() and saipen_dir.is_dir()
    except OSError:
        valid_root = False
    if not valid_root:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"no {SAIPEN_DIR}/ at {root}",
        }
    safe_atomic_write_bytes(path, render(manifest), kind="audit manifest")
    return {
        "ok": True,
        "code": CODE_WRITTEN,
        "path": path.as_posix(),
        "contract_version": CONTRACT_VERSION,
        "changed": True,
        "manifest": manifest,
    }


def status(root: Path | str, *, protocol_dir: Path | str | None = None) -> dict[str, Any]:
    """Read-only projection: what the contract declares and what exists."""
    root = Path(root)
    saipen_dir = root / SAIPEN_DIR
    present, missing = [], []
    for name in MANDATORY_FILES:
        (present if (saipen_dir / name).is_file() else missing).append(name)
    conditional = []
    for p, recursive, cap in CONDITIONAL_DIRS:
        target = saipen_dir.joinpath(*p.split("/"))
        if not target.is_dir():
            continue
        try:
            count = sum(
                1
                for entry in (target.rglob("*") if recursive else target.iterdir())
                if entry.is_file()
            )
        except OSError:
            count = -1
        conditional.append(
            {"path": p, "files": count, "over_cap": count > cap if count >= 0 else False}
        )
    on_disk = manifest_path(root)
    layout = classify_layout(root)
    return {
        "ok": not missing,
        "code": "AUDIT_MANIFEST_STATUS" if not missing else "PROTOCOL_INCOMPLETE",
        "contract_version": CONTRACT_VERSION,
        "manifest_present": on_disk.is_file(),
        "manifest_current": is_current(root, protocol_dir=protocol_dir),
        "manifest_path": on_disk.as_posix(),
        "layout": layout["state"],
        "declared": declared(root, protocol_dir=protocol_dir)["state"],
        "mandatory_present": present,
        "mandatory_missing": missing,
        "conditional": conditional,
        "non_exportable": list(NON_EXPORTABLE),
    }


__all__ = [
    "CODE_CURRENT",
    "CODE_PLAN",
    "CODE_REFUSED",
    "CODE_UPGRADED",
    "CODE_WRITTEN",
    "CONDITIONAL_DIRS",
    "CONTRACT_VERSION",
    "LAYOUT_CORE_FILES",
    "MANDATORY_FILES",
    "MANIFEST_NAME",
    "NON_EXPORTABLE",
    "OPTIONAL_DIRS",
    "REASON_CONTRACT_MALFORMED",
    "REASON_CONTRACT_UNSUPPORTED",
    "REASON_LAYOUT_MALFORMED",
    "REASON_MEMORY_ABSENT",
    "REFERENCE_CARRIERS",
    "REFERENCE_MAX_CARRIER_BYTES",
    "REFERENCE_MAX_REFERENCES",
    "REFERENCE_MAX_TOTAL_BYTES",
    "REFERENCE_SURFACES",
    "build",
    "classify_layout",
    "declared",
    "default_protocol_dir",
    "ensure",
    "is_current",
    "manifest_path",
    "render",
    "status",
    "write",
]
