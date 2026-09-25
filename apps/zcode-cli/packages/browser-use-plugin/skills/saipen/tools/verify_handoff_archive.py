#!/usr/bin/env python
"""Verify a SAIPEN handoff archive (delivery gate).

    python tools/verify_handoff_archive.py <archive.zip> [--project-root PATH]

Checks:
  A. Every git-tracked file is present in the archive (especially .saipen/logs/).
  B. No accidental tracked deletions before packaging.
  C. No ignored/runtime garbage inside the archive.
  D. Extract round-trip: extract to a fresh temp dir and re-verify.
  E. Portability: Windows reserved names, path escapes, case collisions.
  F. Sealed ledger completeness: LOG-*.md lineage.
  G. Archive reproducibility: no self-inclusion.
  H. Print ARCHIVE_SHA256 on success.

Exit 0 on pass, exit 1 on any hard failure.
"""

import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from saipen_engine.distribution import is_non_exportable_path

# ---------- helpers -------------------------------------------------------

_WINDOWS_RESERVED = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
        "NUL",
    }
)


def _git(project: Path, *args: str) -> subprocess.CompletedProcess[str]:
    # T-1349: git writes path bytes as UTF-8; `text=True` alone decodes them
    # with the machine's locale encoding. The verifier has to see the same
    # bytes the builder saw, or Gate A reports a member "missing" that is
    # sitting in the archive under the name git actually reported.
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

    Matches build_handoff_archive.py's inventory: tracked files plus
    untracked, non-ignored working-tree files. The verifier MUST check the
    same set the builder captured, or a tracked-only Gate A/F would certify
    an archive that silently dropped untracked source files.
    """
    # T-1349: `-z`, matching the builder. Without it git QUOTES and escapes any
    # path carrying non-ASCII, and the verifier then looks for that escaped
    # spelling in the archive: Gate A reported a packaged file as missing and
    # Gate F could not even open it ("Invalid argument" on the literal
    # backslash name), so a correct archive failed the delivery gate.
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
    u = _git(project, "ls-files", "--others", "--exclude-standard", "-z")
    if u.returncode != 0:
        print("FAIL: cannot enumerate untracked working-tree files for verification.")
        sys.exit(1)
    untracked = {entry for entry in u.stdout.split("\0") if entry.strip()}
    return {
        rel for rel in tracked | untracked if not is_non_exportable_path(rel)
    }


def _deleted_tracked(project: Path) -> list[str]:
    """Return tracked files that appear deleted in the working tree."""
    r = _git(project, "ls-files", "--deleted")
    if r.returncode != 0:
        return []
    return [line.strip() for line in r.stdout.splitlines() if line.strip()]


def _ignored_garbage_patterns() -> list[re.Pattern]:
    """Patterns that should NOT appear in a clean delivery archive."""
    return [
        re.compile(r"^nul$"),
        re.compile(r"\.pyc$"),
        re.compile(r"__pycache__/"),
        re.compile(r"\.swp$"),
        re.compile(r"\.swo$"),
        re.compile(r"saipen_distribution_probe_.*\.pyc$"),
        re.compile(r"probe_output_"),
        re.compile(r"\.pytest_cache/"),
        re.compile(r"\.ruff_cache/"),
        re.compile(r"benchmark_output"),
    ]


# ---------- gates ---------------------------------------------------------


def gate_b_pre_packaging(project: Path) -> bool:
    """Check B: no accidental tracked deletions before packaging."""
    print("\n--- Gate B: tracked deletion check ---")
    deleted = _deleted_tracked(project)
    sealed_logs = [f for f in deleted if re.match(r"^\.saipen/logs/LOG-\d+\.md$", f)]
    if sealed_logs:
        print(f"FAIL: sealed LOG deletions detected: {sealed_logs}")
        return False
    if deleted:
        print(
            f"WARN: {len(deleted)} tracked files appear deleted (not sealed LOG — review manually)"
        )
    else:
        print("PASS: no tracked deletions")
    return True


def gate_a_archive_contents(archive_path: Path, tracked: set[str]) -> bool:
    """Check A: every tracked file is present in the archive."""
    print("\n--- Gate A: tracked-file presence ---")
    with zipfile.ZipFile(archive_path) as zf:
        arc_names = set(zf.namelist())

    missing = []
    for tf in sorted(tracked):
        if tf not in arc_names:
            missing.append(tf)

    if missing:
        print(f"FAIL: {len(missing)} tracked file(s) missing from archive:")
        for m in missing[:20]:
            print(f"  - {m}")
        if len(missing) > 20:
            print(f"  ... and {len(missing) - 20} more")
        log_missing = [m for m in missing if re.match(r"^\.saipen/logs/LOG-\d+\.md$", m)]
        if log_missing:
            print(f"HARD FAIL: sealed LOG segments missing: {log_missing}")
        return False
    print(f"PASS: all {len(tracked)} tracked files present")
    return True


def gate_c_garbage_check(archive_path: Path) -> bool:
    """Check C: no ignored/runtime garbage in the archive."""
    print("\n--- Gate C: garbage check ---")
    patterns = _ignored_garbage_patterns()
    garbage = []
    with zipfile.ZipFile(archive_path) as zf:
        for name in zf.namelist():
            basename = name.rsplit("/", 1)[-1] if "/" in name else name
            for pat in patterns:
                if pat.search(basename) or pat.search(name):
                    garbage.append(name)
                    break
    if garbage:
        print(f"FAIL: {len(garbage)} ignored/garbage entry(ies) in archive:")
        for g in garbage[:10]:
            print(f"  - {g}")
        return False
    print("PASS: no garbage entries")
    return True


def gate_e_portability(archive_path: Path) -> bool:
    """Check E: portability — Windows reserved names, path escapes, case collisions."""
    print("\n--- Gate E: portability checks ---")
    problems = []

    with zipfile.ZipFile(archive_path) as zf:
        members = zf.namelist()

    # 1. Absolute paths
    abs_paths = [m for m in members if m.startswith("/") or (len(m) > 1 and m[1] == ":")]
    if abs_paths:
        problems.append(f"absolute member paths: {abs_paths[:5]}")

    # 2. Path traversal (..)
    escapes = [m for m in members if ".." in m.split("/")]
    if escapes:
        problems.append(f"path traversal (..): {escapes[:5]}")

    # 3. Duplicate member names (case-insensitive)
    lower_map = defaultdict(list)
    for m in members:
        lower_map[m.lower()].append(m)
    collisions = {k: v for k, v in lower_map.items() if len(v) > 1}
    if collisions:
        for canonical, variants in list(collisions.items())[:5]:
            problems.append(f"case-insensitive collision: {variants}")

    # 4. Windows reserved names in any path component
    reserved_found = []
    for m in members:
        parts = m.replace("\\", "/").split("/")
        for part in parts:
            stem = part.split(".")[0].upper()
            if stem in _WINDOWS_RESERVED:
                reserved_found.append(m)
                break
    if reserved_found:
        problems.append(f"Windows reserved name(s): {reserved_found[:5]}")

    # 5. Trailing space or dot in any path component
    trailing_issues = []
    for m in members:
        parts = m.replace("\\", "/").split("/")
        for part in parts:
            if part != part.rstrip(" ."):
                trailing_issues.append(m)
                break
    if trailing_issues:
        problems.append(f"trailing space/dot: {trailing_issues[:5]}")

    # 6. Duplicate exact member names
    from collections import Counter

    exact_dupes = [name for name, count in Counter(members).items() if count > 1]
    if exact_dupes:
        problems.append(f"duplicate member names: {exact_dupes[:5]}")

    # 7. Portable byte limits (T-1018)
    byte_issues = []
    for m in members:
        encoded = m.encode("utf-8")
        if len(encoded) > 4096:
            byte_issues.append(f"path exceeds 4096 bytes: {len(encoded)} bytes")
            continue
        parts = m.replace("\\", "/").split("/")
        for part in parts:
            if len(part.encode("utf-8")) > 255:
                byte_issues.append(
                    f"component exceeds 255 bytes: {len(part.encode('utf-8'))} bytes in {part[:20]}..." # noqa: E501
                )
                break
    if byte_issues:
        problems.append(f"portable byte limit exceeded: {byte_issues[:5]}")

    if problems:
        for p in problems:
            print(f"FAIL: {p}")
        return False

    print("PASS: portability checks clean")
    return True


def gate_f_tracked_integrity(archive_path: Path, project: Path, tracked: set[str]) -> bool:
    """Check F (T-1019): tracked file integrity + sealed ledger verification.

    Binds verification to one immutable expected `path -> sha256` source
    inventory and verifies every tracked member (including ALL sealed LOGs)
    against it.
    """
    print("\n--- Gate F: tracked integrity + sealed ledger ---")

    # Build immutable expected source inventory
    expected = {}
    for tf in tracked:
        try:
            expected[tf] = hashlib.sha256((project / tf).read_bytes()).hexdigest()
        except OSError as e:
            print(f"FAIL: could not read source file {tf}: {e}")
            return False

    with zipfile.ZipFile(archive_path) as zf:
        arc_names = set(zf.namelist())
        mismatches = []
        for tf, expected_hash in expected.items():
            if tf not in arc_names:
                # Missing files are caught by Gate A, but handle gracefully here
                mismatches.append(f"{tf} (missing)")
                continue
            arc_hash = hashlib.sha256(zf.read(tf)).hexdigest()
            if arc_hash != expected_hash:
                mismatches.append(tf)

        if mismatches:
            print(f"FAIL: content byte/hash mismatch for {len(mismatches)} tracked file(s):")
            for m in mismatches[:10]:
                print(f"  - {m}")
            return False

    print(
        f"PASS: all {len(expected)} tracked files (including all LOGs) exactly match source bytes"
    )
    return True


def gate_g_self_inclusion(archive_path: Path) -> bool:
    """Check G: archive must not contain itself or other ZIPs."""
    print("\n--- Gate G: self-inclusion check ---")
    with zipfile.ZipFile(archive_path) as zf:
        members = zf.namelist()
    zip_members = [m for m in members if m.endswith(".zip")]
    if zip_members:
        print(f"FAIL: ZIP file(s) inside archive: {zip_members}")
        return False
    print("PASS: no ZIP self-inclusion")
    return True


def gate_d_extract_roundtrip(archive_path: Path, tracked: set[str]) -> Path | None:
    """Check D: extract to fresh dir, re-verify tracked-file presence.

    Returns the extraction root path on success, None on failure.
    Callers use the path for semantic validation.
    """
    print("\n--- Gate D: extract round-trip ---")
    tmp_dir = tempfile.mkdtemp(prefix="saipen-verify-")
    extract_dir = Path(tmp_dir) / "extracted"
    extract_dir.mkdir()
    with zipfile.ZipFile(archive_path) as zf:
        zf.extractall(extract_dir)

    # Re-check tracked files
    arc_files = set()
    for p in extract_dir.rglob("*"):
        if p.is_file():
            rel = p.relative_to(extract_dir).as_posix()
            arc_files.add(rel)

    missing = []
    for tf in sorted(tracked):
        if tf not in arc_files:
            missing.append(tf)
    if missing:
        print(f"FAIL: after extraction, {len(missing)} file(s) still missing")
        for m in missing[:10]:
            print(f"  - {m}")
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return None

    logs = [f for f in arc_files if re.match(r"^\.saipen/logs/LOG-\d+\.md$", f)]
    print(f"PASS: extraction round-trip OK ({len(arc_files)} files, {len(logs)} sealed LOGs)")
    return extract_dir


def gate_h_project_snapshot(extract_dir: Path) -> bool:
    """Gate H for an archive that carries no protocol source (T-1349).

    A project snapshot cannot boot itself, so the gate is run by the protocol
    installation this verifier belongs to, pointed at the extracted copy. What
    it proves is what a cold consumer actually needs: the canonical snapshot is
    complete and the engine can read it without the live repository.

    It can fail -- an incomplete `.saipen/` or a snapshot the engine refuses to
    parse both exit non-zero here -- which is the difference between a gate
    that does not apply and a gate that was quietly dropped.
    """
    print("  archive carries no tools/saipen.py: this is a PROJECT SNAPSHOT, not a")
    print("  protocol-source delivery, so the BOOT contract does not apply to it.")
    print("  Gating it with the protocol installation instead:")

    protocol_cli = Path(__file__).resolve().parent / "saipen.py"
    if not protocol_cli.is_file():
        print(f"FAIL: the protocol CLI is missing at {protocol_cli}")
        return False

    saipen_dir = extract_dir / ".saipen"
    mandatory = ("STATE.md", "BOARD.md", "LOG.md", "IDENTITY.md")
    missing = [name for name in mandatory if not (saipen_dir / name).is_file()]
    if missing:
        print(f"FAIL: extracted snapshot is missing mandatory canonical file(s): {missing}")
        return False
    print(f"  PASS: mandatory canonical files present ({', '.join(mandatory)})")

    # READABLE, not healthy. A project is packaged precisely when someone has
    # to hand it over, and that is often exactly when its canonical state is
    # blocked, contradictory or mid-recovery. Requiring a green `status` would
    # refuse to package the snapshots a consumer most needs, so the gate is:
    # the protocol produces a STRUCTURED ANSWER about this snapshot and does
    # not crash on it. An unparseable answer or a traceback is a real failure.
    import json as _json

    for command in ("status", "next"):
        r = subprocess.run(
            [
                sys.executable,
                str(protocol_cli),
                "--project-root",
                str(extract_dir),
                command,
                "--json",
            ],
            cwd=str(extract_dir),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
        combined = r.stdout + r.stderr
        if "Traceback (most recent call last)" in combined:
            print(f"FAIL: the protocol CRASHED reading the extracted snapshot ('{command}')")
            for line in combined.splitlines()[-6:]:
                print(f"  {line[:160]}")
            return False
        try:
            answer = _json.loads(r.stdout)
        except ValueError:
            print(f"FAIL: '{command}' produced no structured answer for the extracted snapshot")
            for line in combined.splitlines()[-6:]:
                print(f"  {line[:160]}")
            return False
        if not isinstance(answer, dict):
            print(f"FAIL: '{command}' answered with {type(answer).__name__}, not a record")
            return False
        print(f"  '{command}' answered (ok={answer.get('ok')}) for the extracted copy")

    print("\nPASS: extracted project snapshot is readable by the protocol (BOOT contract N/A)")
    return True


def gate_h_semantic_validation(extract_dir: Path) -> bool:
    """Check H: run canonical validator + BOOT contract against the extracted copy.

    T-1014: use canonical extracted-copy BOOT/rebind only, require successful
    structured status/next, fingerprint all state around representative dry-run,
    and fail on any boot/rebind/smoke error.
    """
    print("\n--- Gate H: semantic validation + BOOT contract (extracted copy) ---")

    saipen_cli = extract_dir / "tools" / "saipen.py"
    if not saipen_cli.is_file():
        # T-1349: two different things arrive here. A PROTOCOL-SOURCE delivery
        # carries `tools/saipen.py`, and the BOOT contract is a statement about
        # that source. A PROJECT SNAPSHOT -- any repository that merely USES
        # SAIPEN, which is what `--project-root <other project>` produces --
        # carries no protocol source at all, and demanding one made every
        # cross-repository snapshot fail a gate it can never satisfy.
        #
        # Not applicable is not the same as skipped: the archive is still
        # gated, by the PROTOCOL's own tools against the extracted copy, and
        # the substitution is printed rather than assumed.
        return gate_h_project_snapshot(extract_dir)

    # H-1: Canonical rebind-home inside the disposable copy.
    # Unconditionally invoke canonical rebind to align the copy with its temp path.
    print(f"  Rebinding saipen_home to {extract_dir} (via canonical rebind)")
    r = subprocess.run(
        [
            sys.executable,
            str(saipen_cli),
            "rebind-home",
            str(extract_dir),
            "--project-root",
            str(extract_dir),
        ],
        cwd=str(extract_dir),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if r.returncode != 0:
        print("FAIL: canonical rebind-home failed on extracted copy")
        print(f"  {r.stderr.strip() or r.stdout.strip()}")
        return False
    print("  PASS: canonical rebind-home OK")

    # H-2: Run canonical validator.
    print("\n--- Gate H-2: canonical validator ---")
    validator = extract_dir / "tools" / "validate.py"
    if not validator.is_file():
        print(f"FAIL: validator not found in extracted copy: {validator}")
        return False
    r = subprocess.run(
        [sys.executable, str(validator), "--project-root", str(extract_dir)],
        cwd=str(extract_dir),
        capture_output=True,
        text=True,
        timeout=600,
    )
    output = r.stdout + r.stderr
    if r.returncode != 0:
        if "Traceback (most recent call last)" in output:
            print("FAIL: validator CRASHED on extracted copy")
            for line in output.splitlines()[-5:]:
                print(f"  {line[:120]}")
        else:
            print(f"FAIL: extracted archive fails semantic validation (rc={r.returncode})")
            for line in output.splitlines():
                if line.startswith("FAIL"):
                    print(f"  {line[:120]}")
        return False
    print("PASS: canonical validator exits 0 on extracted copy")

    # H-3: Smoke test — status + next (read-only, must not fail).
    print("\n--- Gate H-3: smoke test (status + next) ---")
    smoke_pass = True
    for cmd in ["status", "next"]:
        r = subprocess.run(
            [sys.executable, str(saipen_cli), cmd, "--project-root", str(extract_dir), "--json"],
            cwd=str(extract_dir),
            capture_output=True,
            text=True,
            timeout=120,
        )
        if r.returncode != 0:
            print(f"FAIL: '{cmd}' failed (rc={r.returncode}) on extracted copy")
            if "Traceback" in (r.stdout + r.stderr):
                print("  CRASHED")
            smoke_pass = False
        else:
            print(f"  '{cmd}' OK")

    if not smoke_pass:
        return False

    # H-4: Zero-write dry-run mutator.
    # T-1014: fingerprint all state around representative dry-run.
    print("\n--- Gate H-4: zero-write dry-run ---")
    import hashlib

    def get_state_fingerprint(d: Path) -> str:
        h = hashlib.sha256()
        for p in sorted(d.rglob("*")):
            if p.is_file():
                h.update(p.as_posix().encode())
                h.update(p.read_bytes())
        return h.hexdigest()

    fp_before = get_state_fingerprint(extract_dir / ".saipen")
    r = subprocess.run(
        [
            sys.executable,
            str(saipen_cli),
            "improve",
            "--dry-run",
            "--project-root",
            str(extract_dir),
            "--json",
        ],
        cwd=str(extract_dir),
        capture_output=True,
        text=True,
        timeout=120,
    )

    if r.returncode != 0:
        print(f"FAIL: improve --dry-run failed (rc={r.returncode}) on extracted copy")
        return False

    fp_after = get_state_fingerprint(extract_dir / ".saipen")
    if fp_before != fp_after:
        print("FAIL: improve --dry-run mutated .saipen state (T-1014 violation)")
        return False

    print("  PASS: improve --dry-run completed without mutating state")

    if not smoke_pass:
        return False

    print("\nPASS: extracted copy passes semantic validation + BOOT contract")
    return True


def gate_h_archive_hash(archive_path: Path) -> str:
    """Check I: compute and print ARCHIVE_SHA256."""
    sha = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    print(f"\nARCHIVE_SHA256={sha}")
    return sha


# ---------- main ----------------------------------------------------------


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <archive.zip> [--project-root PATH]")
        sys.exit(1)

    archive = Path(sys.argv[1]).resolve()
    if not archive.is_file():
        print(f"FAIL: archive not found: {archive}")
        sys.exit(1)

    project_root = Path.cwd()
    if "--project-root" in sys.argv:
        idx = sys.argv.index("--project-root")
        if idx + 1 < len(sys.argv):
            project_root = Path(sys.argv[idx + 1]).resolve()

    print(f"Archive: {archive}")
    print(f"Project root: {project_root}")

    tracked = _delivery_inventory(project_root)
    print(f"Tracked files: {len(tracked)}")

    # Phase 1: Structural + portability checks (non-mutating, fail-fast).
    # These run BEFORE any extraction to avoid operating on invalid input.
    print("\n=== PHASE 1: Structural verification (fail-fast) ===")
    structural_pass = True

    if not gate_b_pre_packaging(project_root):
        structural_pass = False
    if not gate_a_archive_contents(archive, tracked):
        structural_pass = False
    if not gate_c_garbage_check(archive):
        structural_pass = False
    if not gate_e_portability(archive):
        structural_pass = False
    if not gate_f_tracked_integrity(archive, project_root, tracked):
        structural_pass = False
    if not gate_g_self_inclusion(archive):
        structural_pass = False

    if not structural_pass:
        print("\nDELIVERY GATE: FAIL (structural)")
        sys.exit(1)

    # Phase 2: Extract + semantic validation.
    print("\n=== PHASE 2: Extract + semantic verification ===")
    extract_dir = gate_d_extract_roundtrip(archive, tracked)
    if extract_dir is None:
        print("\nDELIVERY GATE: FAIL (extraction)")
        sys.exit(1)

    semantic_pass = gate_h_semantic_validation(extract_dir)

    # Clean up extracted copy.
    shutil.rmtree(str(extract_dir.parent), ignore_errors=True)

    # Phase 3: Hash.
    gate_h_archive_hash(archive)

    if semantic_pass:
        print("\nDELIVERY GATE: PASS")
        sys.exit(0)
    else:
        print("\nDELIVERY GATE: FAIL (semantic)")
        sys.exit(1)


if __name__ == "__main__":
    main()
