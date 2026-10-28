"""T-1317 APPEND: durable-evidence storage hygiene (evidence.py).

Evidence must preserve PROOF, not the execution environment. This module is
the single owner of the storage model:

DURABLE EVIDENCE (``.saipen/**/evidence/``)
    Concise transcripts, JSON records, hashes, before/after byte checks,
    bounded diffs, summaries, exact command/environment metadata, small
    necessary fixtures, and a manifest describing discarded ephemera.

EPHEMERAL EXECUTION DATA (OS temporary directory)
    Temporary HOME trees, package caches, ``.local``/``.cache``/npm caches,
    ``node_modules``, provider profiles, runtime sandboxes, copied
    repositories, build trees, test-only application state -- anything
    reproducible whose contents are not themselves the proof.

Closed classification vocabulary (migration): DURABLE_REQUIRED,
EPHEMERAL_REPRODUCIBLE, SUPERSEDED, UNKNOWN.

Safety invariants:

* Cleanup is ownership-scoped. Only paths registered through
  :class:`EvidenceRun` -- or directories matching one of the known
  reproducible bulk names AND residing inside a registered evidence root --
  may ever be deleted. The real user HOME, the repository root, canonical
  ``.saipen`` protocol state files and any unregistered path are refused.
* No silent truncation: an artifact that must remain large is marked
  ``large_evidence_required`` with a reason, otherwise a hash/reference
  stands in for reproducible bulk.
* Unresolved/non-terminal requirements keep their evidence: pruning only
  touches paths explicitly registered as ephemeral or classified
  EPHEMERAL_REPRODUCIBLE / proven SUPERSEDED.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
import time
from pathlib import Path
from typing import Iterable

from .registry import load_registry, require_mapping, require_string_list

_REGISTRY = load_registry()
_RETENTION = require_mapping(_REGISTRY, "evidence_retention")


def _positive_registry_int(name: str) -> int:
    value = _RETENTION.get(name)
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"REGISTRY.json evidence_retention.{name} must be a positive integer")
    return value


#: Storage bounds (durable evidence, not in-flight temp space).
MAX_ARTIFACT_BYTES = _positive_registry_int("max_artifact_bytes")
TARGET_BYTES_PER_TICKET = _positive_registry_int("warn_bytes_per_ticket")
WARN_BYTES_PER_TICKET = TARGET_BYTES_PER_TICKET
HARD_BYTES_PER_TICKET = _positive_registry_int("review_bytes_per_ticket")

#: Reproducible bulk directory names. A directory with one of these names is
#: EPHEMERAL_REPRODUCIBLE wherever it appears INSIDE a registered evidence
#: root; the same name outside a registered root is never touched.
EPHEMERAL_DIR_NAMES = frozenset(
    {
        "home",
        ".local",
        ".cache",
        "npm-cache",
        "node_modules",
        ".npm",
        ".config",
        "opencode-home",
        "kiro-home",
        "gemini-home",
        "sandbox",
        "worktree-copy",
        "repo-copy",
        "build-tree",
    }
)

#: Canonical protocol state files cleanup must never touch even if a
#: registered root is (incorrectly) pointed at them.
PROTECTED_PROTOCOL_NAMES = frozenset({"STATE.md", "BOARD.md", "LOG.md", "IDENTITY.md"})

DISPOSITIONS = tuple(require_string_list(_RETENTION, "classifications"))

EVIDENCE_ROOT = Path(".saipen") / "evidence"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _tree_size(root: Path) -> int:
    total = 0
    for path in root.rglob("*"):
        try:
            if path.is_file() and not path.is_symlink():
                total += path.stat().st_size
        except OSError:
            continue
    return total


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


class EvidenceRefusal(Exception):
    """Cleanup refused an unsafe or unregistered path."""


class EvidenceRun:
    """One producer's evidence session.

    Registers an OS-temp execution root for bulk data and an optional
    durable evidence directory for bounded proof artifacts. The execution
    root is ALWAYS outside ``.saipen`` (``tempfile.mkdtemp`` under the OS
    temp dir) so a whole temporary HOME or package store can never become
    durable evidence by accident.
    """

    def __init__(
        self,
        producer: str,
        ticket: str,
        *,
        durable_dir: Path | str | None = None,
        temp_root: Path | str | None = None,
        now: str | None = None,
    ) -> None:
        self.producer = producer
        self.ticket = ticket
        self.created = now or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.durable_dir = (Path(durable_dir) if durable_dir else EVIDENCE_ROOT).resolve()
        self.durable_dir.mkdir(parents=True, exist_ok=True)
        if temp_root is not None:
            raise EvidenceRefusal(
                "external temp_root is not a proven run-owned root; let EvidenceRun create it"
            )
        else:
            self.temp_root = Path(
                tempfile.mkdtemp(prefix=f"saipen-evidence-{producer}-")
            ).resolve()
            self._owns_temp = True
        if _is_within(self.durable_dir, self.temp_root) or _is_within(
            self.temp_root, self.durable_dir
        ):
            raise EvidenceRefusal("durable evidence and runtime temp roots must be disjoint")
        if ".saipen" in {part.lower() for part in self.temp_root.parts}:
            raise EvidenceRefusal("runtime temp root must be outside .saipen")
        self._owned_temp_root = self.temp_root
        self.ephemeral: list[str] = []      # registered ephemeral paths (relative to temp root)
        self.retained: list[dict] = []      # durable artifacts kept
        self.discarded: list[dict] = []     # ephemera removed at finalize
        self.finalized = False
        self.last_threshold_report: dict | None = None
        self._final_manifest: dict | None = None

    # -- registration -------------------------------------------------

    def register_ephemeral(self, *paths: Path | str) -> list[Path]:
        """Register paths inside the run's temp root as disposable.

        Returns the resolved absolute paths. Registration is the ONLY way
        cleanup may remove an explicitly named path; anything not under the
        temp root is refused immediately.
        """
        resolved: list[Path] = []
        for raw in paths:
            candidate = Path(raw)
            if not candidate.is_absolute():
                candidate = self.temp_root / candidate
            candidate = candidate.resolve()
            if candidate != self.temp_root and not _is_within(candidate, self.temp_root):
                raise EvidenceRefusal(
                    f"refusing to register outside the run temp root: {candidate}"
                )
            if candidate == self.temp_root.resolve():
                raise EvidenceRefusal("refusing to register the temp root itself")
            resolved.append(candidate)
            if str(candidate) not in self.ephemeral:
                self.ephemeral.append(str(candidate))
        return resolved

    def retain(
        self,
        source: Path | str,
        *,
        name: str | None = None,
        large_evidence_required: str | None = None,
    ) -> Path:
        """Extract one bounded proof artifact into durable evidence.

        ``large_evidence_required`` records why an artifact above the
        per-artifact bound must remain; without it the write is refused so
        the producer must instead retain a hash/reference.
        """
        src = Path(source).resolve()
        if src == self.temp_root or not _is_within(src, self.temp_root):
            raise EvidenceRefusal(
                f"proof extraction source is outside the run-owned temp root: {src}"
            )
        if src.is_dir() and src.name in EPHEMERAL_DIR_NAMES:
            raise EvidenceRefusal(
                f"refusing to retain reproducible runtime directory as evidence: {src}"
            )
        size = src.stat().st_size if src.is_file() else _tree_size(src)
        if size > MAX_ARTIFACT_BYTES and not large_evidence_required:
            raise EvidenceRefusal(
                f"artifact {src} is {size} bytes (> {MAX_ARTIFACT_BYTES}); retain a "
                "hash/reference instead or pass large_evidence_required with a reason"
            )
        target = self.durable_dir / (name or src.name)
        if src.is_dir():
            shutil.copytree(src, target, dirs_exist_ok=True)
        else:
            shutil.copy2(src, target)
        self.retained.append(
            {
                "path": str(target),
                "bytes": size,
                "sha256": _sha256(target) if src.is_file() else None,
                "class": "DURABLE_REQUIRED",
                "large_evidence_required": large_evidence_required,
            }
        )
        return target

    def retain_reference(self, source: Path | str, *, note: str = "") -> dict:
        """Retain only a hash + metadata for reproducible bulk data."""
        src = Path(source).resolve()
        if src == self.temp_root or not _is_within(src, self.temp_root):
            raise EvidenceRefusal(
                f"reference source is outside the run-owned temp root: {src}"
            )
        record = {
            "path": str(src),
            "bytes": src.stat().st_size if src.is_file() else _tree_size(src),
            "sha256": _sha256(src) if src.is_file() else None,
            "note": note,
            "class": "EPHEMERAL_REPRODUCIBLE",
        }
        self.retained.append(record)
        return record

    # -- classification (migration) -----------------------------------

    def classify(self, root: Path | str) -> dict[str, str]:
        """Classify the large directories under one evidence tree.

        Only classification: nothing is removed here.
        """
        root = Path(root)
        out: dict[str, str] = {}
        for path in sorted(root.rglob("*")):
            if not path.is_dir() or path.is_symlink():
                continue
            size = _tree_size(path)
            if size < MAX_ARTIFACT_BYTES and path.name not in EPHEMERAL_DIR_NAMES:
                continue
            if path.name in EPHEMERAL_DIR_NAMES and _is_within(path.resolve(), root.resolve()):
                out[str(path)] = "EPHEMERAL_REPRODUCIBLE"
            elif size >= HARD_BYTES_PER_TICKET:
                out[str(path)] = "UNKNOWN"
            else:
                out[str(path)] = "DURABLE_REQUIRED"
        return out

    # -- cleanup -------------------------------------------------------

    def _guard(self, path: Path) -> None:
        resolved = path.resolve()
        if path.name in PROTECTED_PROTOCOL_NAMES:
            raise EvidenceRefusal(f"refusing to remove protocol state file: {path}")
        if resolved != self.temp_root.resolve() and not _is_within(
            resolved, self.temp_root.resolve()
        ):
            raise EvidenceRefusal(
                f"refusing to remove unregistered/external path: {path}"
            )

    def cleanup(self) -> list[str]:
        """Remove registered ephemeral paths. Ownership-scoped, idempotent."""
        removed: list[str] = []
        for raw in list(self.ephemeral):
            path = Path(raw)
            if not path.exists() and not path.is_symlink():
                self.ephemeral.remove(raw)  # idempotent
                continue
            self._guard(path)
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
            removed.append(raw)
            self.ephemeral.remove(raw)
            self.discarded.append(
                {
                    "path": raw,
                    "class": "EPHEMERAL_REPRODUCIBLE",
                    "reason": "registered run-owned runtime data",
                }
            )
        return removed

    def _cleanup_owned_root(self) -> bool:
        """Remove the exact root created by this run, never a caller path."""
        root = self._owned_temp_root
        if not root.exists():
            return False
        if root != self.temp_root or not self._owns_temp:
            raise EvidenceRefusal("runtime root is not owned by this evidence run")
        if root == Path.home().resolve() or root == self.durable_dir:
            raise EvidenceRefusal(f"refusing unsafe runtime-root cleanup: {root}")
        if ".saipen" in {part.lower() for part in root.parts}:
            raise EvidenceRefusal(f"refusing .saipen runtime-root cleanup: {root}")
        shutil.rmtree(root)
        self.discarded.append(
            {
                "path": str(root),
                "class": "EPHEMERAL_REPRODUCIBLE",
                "reason": "exact run-owned temporary root",
            }
        )
        return True

    def finalize(self, *, verdict: str = "UNRESOLVED", extra: dict | None = None) -> dict:
        """Preflight cumulative retention, then clean and write the manifest."""
        if self.finalized:
            assert self._final_manifest is not None
            return self._final_manifest
        manifest_path = self.durable_dir / f"MANIFEST-{self.producer}-{self.ticket}.json"
        old_manifest_size = manifest_path.stat().st_size if manifest_path.is_file() else 0
        base_bytes = _tree_size(self.durable_dir) - old_manifest_size
        planned_removed = [
            raw for raw in self.ephemeral if Path(raw).exists() or Path(raw).is_symlink()
        ]
        planned_discarded = [*self.discarded]
        planned_discarded.extend(
            {"path": raw, "class": "EPHEMERAL_REPRODUCIBLE",
             "reason": "registered run-owned runtime data"}
            for raw in planned_removed
        )
        if self._owned_temp_root.exists():
            planned_discarded.append({
                "path": str(self._owned_temp_root),
                "class": "EPHEMERAL_REPRODUCIBLE",
                "reason": "exact run-owned temporary root",
            })
        draft = self.manifest(
            verdict=verdict, removed=planned_removed, extra=extra,
            discarded=planned_discarded, retained_bytes=base_bytes,
        )
        draft_bytes = self._manifest_bytes(draft, base_bytes)
        projected_total = draft["retained_bytes"]
        thresholds = check_thresholds(self.durable_dir)
        thresholds["total_bytes"] = projected_total
        thresholds["hard_exceeded"] = projected_total > HARD_BYTES_PER_TICKET
        thresholds["warning"] = projected_total > WARN_BYTES_PER_TICKET
        largest = [
            item for item in thresholds["largest"] if item["path"] != str(manifest_path)
        ]
        largest.append({"path": str(manifest_path), "bytes": len(draft_bytes)})
        thresholds["largest"] = sorted(largest, key=lambda item: item["bytes"], reverse=True)[:5]
        self.last_threshold_report = thresholds
        if thresholds["hard_exceeded"]:
            # A cumulative excess needs explicit retained-artifact reasons.
            # Count actual files once, including pre-existing/unregistered
            # evidence, so repeated retains cannot manufacture justification.
            justified = [
                Path(item["path"]).resolve()
                for item in self.retained
                if isinstance(item.get("large_evidence_required"), str)
                and item["large_evidence_required"].strip()
            ]
            justified_bytes = sum(
                path.stat().st_size
                for path in self.durable_dir.rglob("*")
                if path.is_file() and not path.is_symlink()
                and any(path.resolve() == root or _is_within(path.resolve(), root)
                        for root in justified)
            )
            if projected_total - justified_bytes > HARD_BYTES_PER_TICKET:
                raise EvidenceRefusal(
                    f"cumulative evidence hard threshold exceeded: "
                    f"{projected_total} total bytes > {HARD_BYTES_PER_TICKET}; "
                    f"largest retained paths: {thresholds['largest']}; "
                    "retain explicit large_evidence_required reasons for the excess"
                )
        removed = self.cleanup()
        self._cleanup_owned_root()
        manifest = self.manifest(
            verdict=verdict, removed=removed, extra=extra,
            retained_bytes=base_bytes,
        )
        manifest_bytes = self._manifest_bytes(manifest, base_bytes)
        manifest_path.write_bytes(manifest_bytes)
        self.finalized = True
        self._final_manifest = manifest
        return manifest

    @staticmethod
    def _manifest_bytes(manifest: dict, base_bytes: int) -> bytes:
        """Resolve the manifest's own byte count without a stale size field."""
        for _ in range(8):
            encoded = json.dumps(manifest, indent=1).encode("utf-8")
            total = base_bytes + len(encoded)
            if manifest["retained_bytes"] == total:
                return encoded
            manifest["retained_bytes"] = total
            manifest["thresholds"] = {
                "warning": total > WARN_BYTES_PER_TICKET,
                "hard_exceeded": total > HARD_BYTES_PER_TICKET,
            }
        raise EvidenceRefusal("manifest byte count did not converge")

    def manifest(self, verdict: str = "UNRESOLVED", removed: list[str] | None = None,
                 extra: dict | None = None, discarded: list[dict] | None = None,
                 retained_bytes: int | None = None) -> dict:
        durable_bytes = _tree_size(self.durable_dir) if retained_bytes is None else retained_bytes
        manifest = {
            "producer": self.producer,
            "ticket": self.ticket,
            "created": self.created,
            "verdict": verdict,
            "temp_root": str(self.temp_root),
            "durable_dir": str(self.durable_dir),
            "retained": self.retained,
            "discarded_ephemeral": self.discarded if discarded is None else discarded,
            "retained_bytes": durable_bytes,
            "limits": {
                "max_artifact_bytes": MAX_ARTIFACT_BYTES,
                "warn_bytes_per_ticket": WARN_BYTES_PER_TICKET,
                "hard_bytes_per_ticket": HARD_BYTES_PER_TICKET,
            },
            "thresholds": {
                "warning": durable_bytes > WARN_BYTES_PER_TICKET,
                "hard_exceeded": durable_bytes > HARD_BYTES_PER_TICKET,
            },
        }
        if extra:
            if any(key in manifest for key in extra):
                raise EvidenceRefusal("extra metadata cannot replace manifest-owned fields")
            manifest.update(extra)
        return manifest


def check_thresholds(durable_dir: Path | str) -> dict:
    """Deterministic threshold report for one ticket's durable evidence.

    Crossing the warning threshold names the largest retained paths; the
    hard threshold fails finalization unless artifacts carry an explicit
    ``large_evidence_required`` reason (enforced by :meth:`EvidenceRun.retain`).
    """
    root = Path(durable_dir)
    sizes = sorted(
        ((p.stat().st_size, str(p)) for p in root.rglob("*") if p.is_file() and not p.is_symlink()),
        reverse=True,
    )
    total = sum(size for size, _p in sizes)
    return {
        "total_bytes": total,
        "warning": total > WARN_BYTES_PER_TICKET,
        "hard_exceeded": total > HARD_BYTES_PER_TICKET,
        "largest": [{"path": p, "bytes": s} for s, p in sizes[:5]],
    }


def migrate_classify(
    root: Path | str, *, superseded: Iterable[Path | str] = ()
) -> dict:
    """Classify an EXISTING evidence tree without removing anything.

    Returns counts per disposition plus the explicit UNKNOWN list for human
    review. Migration removes only EPHEMERAL_REPRODUCIBLE and proven
    SUPERSEDED data, and never while another active disposition references
    the path (callers must verify references before using ``prune``).
    """
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    proven_superseded: set[Path] = set()
    for raw in superseded:
        candidate = Path(raw).resolve()
        if candidate == root or not _is_within(candidate, root):
            raise EvidenceRefusal(f"superseded path is outside classification root: {candidate}")
        proven_superseded.add(candidate)
    classified: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            continue
        resolved = path.resolve()
        if any(
            disposition in ("EPHEMERAL_REPRODUCIBLE", "SUPERSEDED")
            and _is_within(resolved, Path(parent))
            for parent, disposition in classified.items()
        ):
            continue
        if resolved in proven_superseded:
            classified[str(path)] = "SUPERSEDED"
        elif path.is_dir() and path.name in EPHEMERAL_DIR_NAMES:
            classified[str(path)] = "EPHEMERAL_REPRODUCIBLE"
        elif path.is_file():
            # Existing ordinary proof files are kept conservatively. A human
            # may later mark a duplicate SUPERSEDED, but migration never
            # guesses deletion authority from names or timestamps.
            classified[str(path)] = "DURABLE_REQUIRED"
        elif path.is_dir():
            classified[str(path)] = "UNKNOWN"
    report = {d: [] for d in DISPOSITIONS}
    for path_str, disposition in classified.items():
        report[disposition].append(path_str)
    report["counts"] = {d: len(v) for d, v in report.items() if isinstance(v, list)}
    report["root"] = str(root)
    report["total_bytes"] = _tree_size(root)
    return report


def prune(root: Path | str, classified: dict[str, str], *,
          referenced: set[str] | None = None) -> list[str]:
    """Remove classified-ephemeral paths that nothing references.

    ``referenced`` carries paths an active source disposition still cites;
    anything referenced is kept and reported rather than removed.
    """
    referenced = referenced or set()
    root = Path(root).resolve()
    removed: list[str] = []
    for raw, disposition in sorted(classified.items()):
        if disposition not in ("EPHEMERAL_REPRODUCIBLE", "SUPERSEDED"):
            continue
        path = Path(raw)
        if not path.exists() and not path.is_symlink():
            continue  # already gone: idempotent
        resolved = path.resolve()
        if resolved == root or not _is_within(resolved, root):
            raise EvidenceRefusal(f"refusing cleanup outside migration root: {path}")
        if path.name in PROTECTED_PROTOCOL_NAMES:
            raise EvidenceRefusal(f"refusing cleanup of protocol state file: {path}")
        if any(
            _is_within(resolved, Path(ref).resolve())
            or _is_within(Path(ref).resolve(), resolved)
            for ref in referenced
            if Path(ref).exists()
        ):
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        removed.append(raw)
    return removed
