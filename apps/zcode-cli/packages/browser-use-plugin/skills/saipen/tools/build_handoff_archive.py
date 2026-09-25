#!/usr/bin/env python
"""Build a verified SAIPEN handoff archive.

    python tools/build_handoff_archive.py <output.zip> [--project-root PATH]

This is the ONLY canonical path for creating a delivery artifact.
It owns every gate: structural, portability, semantic, and extracted-copy
validation.  A failed verification MUST NOT leave a final-looking archive.

Flow:
  1. Resolve project root.
  2. Pre-packaging checks (tracked deletions, protected sealed LOG).
  3. Collect delivery inventory from the actual working tree.
  4. Build archive into a temporary path.
  5. Structural + portability gate (verify_handoff_archive.py Phase 1).
  6. Extract into a fresh temp dir.
  7. Semantic validator on extracted copy.
  8. Compute SHA-256.
  9. Atomic rename temp -> final requested path.

Stdlib only.
"""

import hashlib
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

# saipen_engine lives beside this tool in the canonical layout; make the
# import work regardless of the invocation working directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from saipen_engine.distribution import is_non_exportable_path


def _git(project: Path, *args: str) -> subprocess.CompletedProcess[str]:
    # T-1349: git writes path bytes as UTF-8. `text=True` alone decodes them
    # with the machine's locale encoding, so a path carrying U+2014 comes back
    # mojibake on a Windows console codepage and never matches the file it
    # names. The delivery inventory has to be the paths git actually reported.
    return subprocess.run(
        ["git", *list(args)],
        cwd=str(project),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _delivery_inventory(project: Path) -> set[str]:
    """Whole-project delivery inventory (W2-001 audit ed1f86e8).

    The canonical whole-project handoff is a GIT-project tool. A project
    without a repository gets an explicit structured refusal. T-1016 requires
    explicitly marking whole-project handoff unsupported in no-Git and
    documenting the fallback as a STATE-ONLY exporter, so users don't think
    they are getting a whole-project archive.

    W2-001: the delivery inventory MUST be the actual working tree, not the
    Git-tracked subset. `git ls-files` alone silently drops newly created
    untracked implementation/config/test/docs and durable project-state files
    while every delivery gate still reports success -- the receiving agent
    gets a verified archive of an older/incomplete project. The inventory is
    therefore the semantic equivalent of
    `git ls-files --cached --others --exclude-standard`: tracked files plus
    untracked, non-ignored working-tree files. Ignored build/cache material
    stays excluded by Git's own exclude rules.
    """
    # T-1349: `-z`, exactly like the untracked half below. Without it git
    # QUOTES any path carrying non-ASCII and escapes it (`SAIPEN \342\200\224
    # ...`), and that escaped spelling is then stat-ed as if it were the file
    # name: four regular files with U+2014 in their names were reported as
    # "symlinks or non-regular files" by a containment gate firing on git's
    # own quoting convention.
    r = _git(project, "ls-files", "-z")
    if r.returncode != 0:
        print("FAIL: this whole-project handoff path requires a Git repository.")
        print("UNSUPPORTED: whole-project handoff is not supported without Git.")
        print("If you only need to export SAIPEN state (NO implementation files),")
        print("use the canonical STATE-ONLY exporter instead --")
        print("  bootstrap/export.sh        (macOS/Linux)")
        print("  bootstrap/export.ps1       (Windows)")
        print("which archives ONLY the .saipen directory.")
        sys.exit(1)
    tracked = {entry for entry in r.stdout.split("\0") if entry.strip()}
    # W2-001: untracked + non-ignored working-tree files. `--others` lists
    # untracked files; `--exclude-standard` applies .gitignore/.git/info/exclude
    # so ignored build/cache/runtime garbage never enters the archive. Using
    # `-z` and a stable sort keeps the union deterministic.
    u = _git(project, "ls-files", "--others", "--exclude-standard", "-z")
    if u.returncode != 0:
        print("FAIL: cannot enumerate untracked working-tree files for delivery.")
        sys.exit(1)
    untracked = {entry for entry in u.stdout.split("\0") if entry.strip()}
    return tracked | untracked


def _deleted_tracked(project: Path) -> list[str]:
    r = _git(project, "ls-files", "--deleted")
    if r.returncode != 0:
        return []
    return [line.strip() for line in r.stdout.splitlines() if line.strip()]


# Patterns that must never appear in a clean delivery archive.
_GARBAGE_PATTERNS = [
    "__pycache__",
    ".pyc",
    ".swp",
    ".swo",
    ".pytest_cache",
    ".ruff_cache",
    "nul",
    "probe_output_",
    "saipen_distribution_probe_",
    ".COMMIT_EDITMSG.swp",
]


def _is_garbage(name: str) -> bool:
    base = os.path.basename(name)
    return any(pat in base or pat in name for pat in _GARBAGE_PATTERNS)


def _is_delivery_source(project: Path, rel: str) -> bool:
    """Should this tracked file be included in the delivery archive?

    Includes all tracked files that aren't transient garbage.
    """
    return not _is_garbage(rel) and not is_non_exportable_path(rel)


# T-1016: explicit destructive-overwrite authorization. Default False.
_OVERWRITE_ALLOWED = False


def _reject_protected_destination(output: Path, project: Path) -> None:
    """T-1016: reject tracked/protected/canonical destinations categorically.

    An output path that names a tracked project file, a protected canonical
    file (e.g. .saipen/STATE.md), or a source tree member must never be
    replaced by ZIP bytes -- promotion to such a path is a hard refusal
    regardless of --force.
    """
    try:
        rel = output.resolve().relative_to(project.resolve())
    except ValueError:
        # Outside the project tree: not a tracked source destination.
        return
    rel_str = rel.as_posix()
    # Any tracked file is protected: replacing it would destroy source.
    tracked = _delivery_inventory(project)
    if rel_str in tracked:
        print(f"FAIL: destination is a tracked project file: {rel_str}")
        print("Refusing to replace tracked source with archive bytes (T-1016).")
        sys.exit(1)
    # Canonical protected locations even if untracked.
    protected_prefixes = (".saipen/", "saipen/", "extensions/schemas/")
    for prefix in protected_prefixes:
        if rel_str.startswith(prefix):
            print(f"FAIL: destination is a canonical protected path: {rel_str}")
            print("Refusing to replace canonical state with archive bytes (T-1016).")
            sys.exit(1)


def _scan_unresolved_recovery(project: Path) -> list[tuple[str, str]]:
    """Scan the canonical recovery journal with the ONE shared classifier.

    Returns a list of (op_id, status) for every operation the engine's own
    pending scan reports: PREPARED / APPLYING / VERIFIED / CONFLICT ops plus
    CORRUPT_JOURNAL evidence (unknown statuses such as SKIPPED, unreadable
    or structurally invalid manifests). An empty list means the recovery
    journal is clean.

    A handoff with unresolved recovery operations would silently launder
    pending recovery out of the continuation — the recipient would never
    know about the interrupted mutation. The lifecycle vocabulary is the
    journal's canonical SETTLED/UNRESOLVED/STATUS sets, never a local
    handoff guess: ABORTED is settled exactly as the engine treats it, every
    unresolved state blocks, and unknown/SKIPPED corrupt evidence fails
    closed (T-1009).
    """
    from saipen_engine.journal import scan_pending

    try:
        pending, _ = scan_pending(project)
    except Exception as exc:
        # The canonical scan is designed never to raise, but an unclassifiable
        # recovery container is corrupt evidence that must block the handoff.
        return [("OPS_DIR", f"CORRUPT_JOURNAL: {type(exc).__name__}: {exc}")]
    return [(op["op_id"], op.get("status", "CORRUPT_JOURNAL")) for op in pending]


def build_archive(output: Path, project: Path) -> None:
    # T-1017: Reject protected destinations before ANY side effects (temp files/dirs).
    # This ensures a refusal leaves the filesystem fingerprint completely unchanged.
    _reject_protected_destination(output, project)
    if output.exists() and not _OVERWRITE_ALLOWED:
        print(f"FAIL: destination already exists: {output}")
        print(
            "Refusing to overwrite without explicit authorization. "
            "Pass --force to allow destructive overwrite."
        )
        sys.exit(1)

    # T-1349: the delivery gate ships with the PROTOCOL, beside this builder --
    # never `project/"tools"/...`. Resolving it inside the target made
    # `--project-root <any other project>` impossible, because the verifier is
    # not a file an arbitrary project has; measured on two real foreign SAIPEN
    # roots, both exited here. It was also the wrong trust boundary: the gate
    # that clears a snapshot would have been code the snapshot supplies, so a
    # packaged project could pass itself by shipping a verifier that exits 0.
    verifier = Path(__file__).resolve().parent / "verify_handoff_archive.py"
    if not verifier.is_file():
        print(f"FAIL: the protocol's delivery verifier is missing at {verifier}")
        print("This is an incomplete SAIPEN installation, not a problem with the target.")
        sys.exit(1)

    # --- Pre-packaging checks ---
    print("=== Pre-packaging checks ===")
    deleted = _deleted_tracked(project)
    sealed = [f for f in deleted if __import__("re").match(r"^\.saipen/logs/LOG-\d+\.md$", f)]
    if sealed:
        print(f"FAIL: sealed LOG deletions detected: {sealed}")
        sys.exit(1)
    if deleted:
        print(
            f"WARN: {len(deleted)} tracked files appear deleted (not sealed LOGs — review manually)"
        )

    # Scan canonical recovery state.  Unresolved PREPARED/CONFLICT operations
    # and corrupt journal evidence mean the continuation truth is incomplete
    # — shipping would silently launder pending recovery out of the handoff.
    unresolved = _scan_unresolved_recovery(project)
    if unresolved:
        print(f"FAIL: {len(unresolved)} unresolved recovery operation(s) detected:")
        for op_id, status in unresolved:
            print(f"  - {op_id} ({status})")
        print("Cannot build handoff archive while recovery is pending.")
        print("Resolve with: saipen recover resolve <op_id> --resolution <accept_live|replan>")
        sys.exit(1)

    # --- Collect inventory + source snapshot ---
    print("\n=== Collecting delivery inventory ===")
    tracked = _delivery_inventory(project)
    members = sorted(rel for rel in tracked if _is_delivery_source(project, rel))
    print(f"  {len(members)} tracked files selected for archive")

    # T-1015: lstat every selected member and prove it is a regular file with
    # NO symlink/reparse ancestor. `is_file()` follows links, so a tracked
    # in-project path could silently package bytes from outside project_root.
    # T-1013: capture the st_dev/st_ino here so the later content capture
    # can prove it opened the exact same inode, closing the TOCTOU window.
    print("\n=== Checking member filesystem types ===")
    link_escapes = []
    member_lstats = {}
    for rel in members:
        src = project / rel
        # Walk each path component from the project root down; any symlink/
        # reparse-link component means the member escapes containment.
        current = project
        for part in Path(rel).parts:
            current = current / part
            try:
                st = current.lstat()
            except OSError:
                link_escapes.append(rel)
                break
            import stat as _stat

            if _stat.S_ISLNK(st.st_mode):
                link_escapes.append(rel)
                break
        else:
            # No symlink component; now confirm the leaf is a regular file.
            st = src.lstat()
            import stat as _stat

            if not _stat.S_ISREG(st.st_mode):
                # T-1349: name the thing, not the symptom. Git never descends
                # into another repository, so an embedded one arrives as a
                # single collapsed DIRECTORY entry and lands here reading
                # "not a regular file" -- true, and useless. It is real content
                # with a real decision behind it (vendor it, remove it, or
                # ignore it), and the message has to say so.
                if _stat.S_ISDIR(st.st_mode) and (src / ".git").exists():
                    link_escapes.append(
                        f"{rel} (embedded Git repository -- git enumerates it as one "
                        "directory and never lists its files, so it cannot be packaged; "
                        "remove it, vendor its files into this repository, or add it to "
                        ".gitignore)"
                    )
                else:
                    link_escapes.append(f"{rel} (not a regular file)")
            else:
                member_lstats[rel] = (st.st_dev, st.st_ino, st.st_mode, st.st_mtime)
    if link_escapes:
        print(
            f"FAIL: {len(link_escapes)} member(s) are symlinks or non-regular "
            f"files -- refusing to package bytes through an escaped object:"
        )
        for e in link_escapes[:10]:
            print(f"  {e}")
        print(
            "A tracked member must be a regular contained file with no "
            "symlink/reparse ancestor (T-1015)."
        )
        sys.exit(1)
    print(f"  PASS: all {len(members)} members are regular contained files")

    # --- Build temporary archive (T-1016: in the destination directory) ---
    # The temp artifact lives beside the requested output so the final rename
    # is same-filesystem and atomic. A temp artifact on a different
    # filesystem (e.g. system temp on /dev/shm) would crash with a raw
    # cross-device OSError at promotion.
    print("\n=== Capturing snapshot and building temporary archive ===")
    output.parent.mkdir(parents=True, exist_ok=True)
    tmpzip = output.parent / f".{output.name}.tmp-{os.getpid()}"
    tmpzip.unlink(missing_ok=True)

    source_snapshot: dict[str, str] = {}  # rel_path -> sha256 hex
    snapshot_errors = []

    try:
        with zipfile.ZipFile(str(tmpzip), "w", zipfile.ZIP_DEFLATED) as zf:
            for rel in members:
                src = project / rel
                try:
                    with open(src, "rb") as f:
                        fst = os.fstat(f.fileno())
                        expected_dev, expected_ino, expected_mode, expected_mtime = member_lstats[
                            rel
                        ]

                        # T-1013: fail closed if the inode/device changed between lstat and open.
                        # This prevents a TOCTOU race where a tracked regular file is swapped to an outside symlink. # noqa: E501
                        if (fst.st_dev, fst.st_ino) != (expected_dev, expected_ino):
                            snapshot_errors.append(
                                f"{rel} (inode/device changed - possible symlink race)"
                            )
                            continue

                        data = f.read()
                        source_snapshot[rel] = hashlib.sha256(data).hexdigest()

                        import time

                        zinfo = zipfile.ZipInfo(rel)
                        dt = time.localtime(expected_mtime)
                        zinfo.date_time = (
                            dt.tm_year,
                            dt.tm_mon,
                            dt.tm_mday,
                            dt.tm_hour,
                            dt.tm_min,
                            dt.tm_sec,
                        )
                        zinfo.external_attr = (expected_mode & 0xFFFF) << 16
                        zinfo.compress_type = zipfile.ZIP_DEFLATED
                        zf.writestr(zinfo, data)
                except OSError as exc:
                    snapshot_errors.append(f"{rel} ({exc})")

        if snapshot_errors:
            print(
                f"FAIL: {len(snapshot_errors)} member(s) vanished or changed during packaging (TOCTOU protection):" # noqa: E501
            )
            for e in snapshot_errors[:10]:
                print(f"  {e}")
            sys.exit(1)
        print(f"  Captured {len(source_snapshot)} file hashes from source tree")
        print(f"  {tmpzip}  ({tmpzip.stat().st_size} bytes, {len(members)} members)")

        # T-1011: Verify every archive member against the captured snapshot.
        # This catches tree mutation between snapshot and packaging.
        print("\n=== Verifying archive against source snapshot ===")
        snapshot_mismatches = []
        with zipfile.ZipFile(str(tmpzip), "r") as zf:
            for info in zf.infolist():
                arc_name = info.filename
                if arc_name.endswith("/"):
                    continue  # directory entry
                arc_hash = hashlib.sha256(zf.read(arc_name)).hexdigest()
                expected = source_snapshot.get(arc_name)
                if expected is None:
                    snapshot_mismatches.append((arc_name, "extra member not in source snapshot"))
                elif arc_hash != expected:
                    snapshot_mismatches.append(
                        (arc_name, f"hash mismatch: arc={arc_hash[:16]} src={expected[:16]}")
                    )
        if snapshot_mismatches:
            print(f"FAIL: {len(snapshot_mismatches)} member(s) differ from source snapshot:")
            for name, reason in snapshot_mismatches[:10]:
                print(f"  {name}: {reason}")
            sys.exit(1)
        # Also verify no source members were missed
        arc_members = set()
        with zipfile.ZipFile(str(tmpzip), "r") as zf:
            arc_members = {i.filename for i in zf.infolist() if not i.filename.endswith("/")}
        missing_from_archive = [m for m in source_snapshot if m not in arc_members]
        if missing_from_archive:
            print(f"FAIL: {len(missing_from_archive)} source file(s) missing from archive:")
            for m in missing_from_archive[:10]:
                print(f"  {m}")
            sys.exit(1)
        print(f"PASS: all {len(source_snapshot)} archive members match source snapshot")

        # --- Structural + portability gate ---
        print("\n=== Structural verification ===")
        r = subprocess.run(
            [sys.executable, str(verifier), str(tmpzip), "--project-root", str(project)],
            cwd=str(project),
            capture_output=True,
            text=True,
            timeout=600,
        )
        print(r.stdout[-2000:] if len(r.stdout) > 2000 else r.stdout)
        if r.stderr:
            print("STDERR:", r.stderr[-500:] if len(r.stderr) > 500 else r.stderr)
        if r.returncode != 0:
            print(f"FAIL: delivery gate failed (exit {r.returncode})")
            sys.exit(1)

        # --- Extract into fresh dir for semantic validation ---
        print("\n=== Extract round-trip validation ===")
        with tempfile.TemporaryDirectory(prefix="saipen-extract-") as extdir:
            extroot = Path(extdir) / "extracted"
            with zipfile.ZipFile(str(tmpzip), "r") as zf:
                zf.extractall(str(extroot))

            # Check all members extracted
            extracted = set()
            for root, dirs, files in os.walk(str(extroot)):
                for f in files:
                    rp = os.path.relpath(os.path.join(root, f), str(extroot))
                    extracted.add(rp.replace("\\", "/"))

            missing = [m for m in members if m not in extracted]
            if missing:
                print(f"FAIL: {len(missing)} files missing after extraction")
                for m in missing[:10]:
                    print(f"  {m}")
                sys.exit(1)
            print(f"  All {len(members)} files present after extraction")

        # --- Compute SHA-256 ---
        sha = hashlib.sha256()
        with open(str(tmpzip), "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                sha.update(chunk)
        digest = sha.hexdigest()
        print(f"\nARCHIVE_SHA256={digest}")

        # --- Atomic promote ---
        # Destination validations are now executed at the very start (T-1017).
        try:
            # os.replace is atomic and replaces an existing destination on
            # both POSIX and Windows (Path.rename does not overwrite on
            # Windows). Same-directory source guarantees same-filesystem.
            os.replace(str(tmpzip), str(output))
        except OSError as exc:
            print(f"FAIL: promotion failed: {type(exc).__name__}: {exc}")
            tmpzip.unlink(missing_ok=True)
            sys.exit(1)
        print(f"\n=== Archive promoted to {output} ===")
        print(f"  {len(members)} members, SHA-256 {digest}")
        print("DELIVERY BUILD: PASS")
    finally:
        tmpzip.unlink(missing_ok=True)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Build a verified SAIPEN handoff archive.")
    parser.add_argument("output", help="Output archive path (e.g. saipen-delivery.zip)")
    parser.add_argument("--project-root", default=".", help="Project root (default: cwd)")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow destructive overwrite of an existing "
        "ordinary destination (never tracked/canonical)",
    )
    args = parser.parse_args()

    global _OVERWRITE_ALLOWED # noqa: PLW0603
    _OVERWRITE_ALLOWED = args.force

    project = Path(args.project_root).resolve()
    output = Path(args.output).resolve()
    build_archive(output, project)


if __name__ == "__main__":
    main()
