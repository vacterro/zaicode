#!/usr/bin/env python3
"""Measures how much weaker the portable floor is than the canonical validator.

The floor (`tests/validate.sh` / `.ps1`) exists for hosts without Python. It is
frozen against new checks on purpose, so the gap between it and
`tools/validate.py` is permanent by design -- but until this tool the SIZE of
that gap was documented as a single known omission, and it is not one. Applying
`tools/audit_checks.py`'s mutation table to both tools showed the floor catching
11 of 41, while announcing "Agent is conformant" in exactly the canonical
validator's words for the other 28.

The wording is corrected; the number is not something to correct, it is
something to keep honest. This prints it, and fails if the floor silently drops
below the recorded baseline -- a floor getting WEAKER without anyone saying so
is the failure worth guarding, not the gap itself.

Exit 0 when the floor still catches at least BASELINE cases, 1 otherwise.
Skips (exit 0, loudly) where no POSIX shell is available.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import suppress
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HOME = Path(__file__).resolve().parent.parent

# Measured at v7.120.0. Raise it when the floor genuinely gains coverage; a
# drop means the floor lost a check without anyone noticing, which is the whole
# reason this number is written down instead of recomputed and forgotten.
BASELINE = 11
VALIDATOR_TIMEOUT = 60


def find_bash() -> str | None:
    """Pick a real bash, and never `sh`.

    Two ways to get this wrong, and this tool managed both. On Windows a bare
    `bash` resolves from Python to the WSL stub in System32, which without an
    installed distro prints a UTF-16 error and runs nothing -- the trap that
    once scored every floor check dead. And on Ubuntu `sh` is **dash**, which
    the floor script is not written for: it died in 0.4 seconds on its first CI
    run, fast enough that the failure was obviously the shell rather than the
    subject, if anyone had looked at the clock.

    Explicit Git-for-Windows paths first, then `bash` from PATH. `sh` is never
    acceptable.
    """
    for candidate in (
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        shutil.which("bash"),
    ):
        if candidate and os.path.exists(candidate) and "system32" not in candidate.lower():
            return candidate
    return None


def bash_env(bash: str) -> dict[str, str]:
    """Expose Git Bash's POSIX tools without changing the user's PATH."""
    env = os.environ.copy()
    if os.name != "nt":
        return env
    bindir = Path(bash).resolve().parent
    for tools_dir in (bindir, bindir.parent / "usr" / "bin"):
        if all((tools_dir / f"{name}.exe").is_file() for name in ("grep", "sed", "sort")):
            env["PATH"] = str(tools_dir) + os.pathsep + env.get("PATH", "")
            break
    return env


def main() -> int:
    bash = find_bash()
    if os.name != "nt" and bash is None:
        print("SKIP: no POSIX shell found -- cannot compare against the floor")
        return 0
    floor_env = bash_env(bash) if bash is not None else os.environ.copy()

    spec = importlib.util.spec_from_file_location(
        "audit_checks", HOME / "tools" / "audit_checks.py"
    )
    ac = importlib.util.module_from_spec(spec)
    sys.modules["audit_checks"] = ac
    spec.loader.exec_module(ac)

    def compute_cache_key():
        h = hashlib.sha256()
        # Source bytes only. It used to hash `repr(ac.CASES)`, and a CASES
        # entry holds callables -- so the repr embedded memory addresses
        # (`<function demote_the_pick at 0x000001A898177880>`) and the key
        # changed every process. The cache could never hit, its
        # "skipped, unchanged floor and case list" line could never print,
        # and the 545-second run it exists to avoid ran every single time.
        # Hashing audit_checks.py instead is deterministic AND stricter: it
        # invalidates on any change to a case, its mutation or its expected
        # substring, which `repr` of a tuple of functions never could.
        for script in (
            "tests/validate.sh",
            "tests/validate.ps1",
            "tools/validate.py",
            "tools/audit_checks.py",
        ):
            p = HOME / script
            if p.exists():
                h.update(p.read_bytes())
        return h.hexdigest()[:16]

    cache_key = compute_cache_key()
    # T-640 / § 14: the cache is derived runtime state, never canonical
    # project truth. It lives under .saipen/cache/ (gitignored) so a
    # validation/audit run can never dirty the tracked tree.
    cache_file = HOME / ".saipen" / "cache" / "audit_parity_cache.json"
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text("utf-8"))
            if cached.get("key") == cache_key:
                print(f"PASS: skipped, unchanged floor and case list (hash {cache_key})")
                print(f"Parity result remains {cached.get('caught', BASELINE)} at baseline")
                return 0
        except Exception:
            pass

    temp_parent = None
    if os.name == "nt" and os.environ.get("LOCALAPPDATA"):
        temp_parent = Path(os.environ["LOCALAPPDATA"]) / "Temp"
        temp_parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="audit_parity_", dir=temp_parent))
    pristine = tmp / "pristine"
    shutil.copytree(HOME, pristine, ignore=ac.IGNORE)

    class _Result:
        def __init__(self, rc, out, err):
            self.returncode = rc
            self.stdout = out
            self.stderr = err

    def run_validate(root, gate=None):
        try:
            return subprocess.run(
                [
                    sys.executable,
                    str(root / "tools" / "validate.py"),
                    *(["--gate", gate] if gate else []),
                ],
                cwd=root,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=VALIDATOR_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            return _Result(124, "", "timeout")

    def run_floor(root):
        if sys.platform == "nt":
            try:
                return subprocess.run(
                    [
                        "powershell.exe",
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        "tests/validate.ps1",
                    ],
                    cwd=root,
                    capture_output=True,
                    text=True,
                    errors="replace",
                    timeout=VALIDATOR_TIMEOUT,
                )
            except subprocess.TimeoutExpired:
                return _Result(124, "", "timeout")
        else:
            try:
                return subprocess.run(
                    [bash, "tests/validate.sh"],
                    cwd=root,
                    env=floor_env,
                    capture_output=True,
                    text=True,
                    errors="replace",
                    timeout=VALIDATOR_TIMEOUT,
                )
            except subprocess.TimeoutExpired:
                return _Result(124, "", "timeout")

    def validate(root, gate=None):
        return run_validate(root, gate).returncode

    def floor(root):
        return run_floor(root).returncode

    # Name which tool objected and show what it said. The first version printed
    # "one of the two tools rejects an unmodified copy" and stopped -- true,
    # useless, and it cost a CI round-trip to learn nothing. A precondition
    # that fails without naming what it saw is the same defect this repository
    # keeps finding in its own checks.
    ctl_v, ctl_f = run_validate(pristine), run_floor(pristine)
    if ctl_v.returncode != 0 or ctl_f.returncode != 0:
        who = "tools/validate.py" if ctl_v.returncode != 0 else "tests/validate.sh"
        bad = ctl_v if ctl_v.returncode != 0 else ctl_f
        print(
            f"FAIL: {who} rejects an UNMODIFIED copy (exit "
            f"{bad.returncode}) -- every number below would be measuring "
            f"that instead of the floor's coverage. What it said:"
        )
        for ln in (bad.stdout + bad.stderr).splitlines():
            if ln.startswith(("FAIL", "Traceback")) or "Error" in ln:
                print("    " + ln.strip()[:160])
        shutil.rmtree(tmp, ignore_errors=True)
        return 1

    # Prove the canonical half once with its bounded-parallel red-control
    # harness. Re-running the full Python validator for every parity case was
    # the same proof serialized 227 times; audit_checks.py guarantees that
    # every exact CASES entry goes red and that restoration stays clean.
    canonical_hash = hashlib.sha256()
    for source in (HOME / "tools" / "validate.py", HOME / "tools" / "audit_checks.py"):
        canonical_hash.update(source.read_bytes())
    canonical_key = canonical_hash.hexdigest()[:16]
    canonical_cache = HOME / ".saipen" / "cache" / "audit_checks_cache.json"
    canonical_proven = False
    if canonical_cache.is_file():
        with suppress(OSError, UnicodeDecodeError, ValueError):
            canonical_proven = json.loads(canonical_cache.read_text("utf-8")).get(
                "key"
            ) == canonical_key
    if not canonical_proven:
        try:
            canonical_suite = subprocess.run(
                [sys.executable, str(HOME / "tools" / "audit_checks.py")],
                cwd=HOME,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=900,
            )
        except subprocess.TimeoutExpired:
            canonical_suite = _Result(124, "", "timeout")
        if canonical_suite.returncode != 0:
            print(
                "FAIL: canonical mutation suite is not green; portable-floor "
                "parity cannot assume the Python side catches every case"
            )
            for line in (canonical_suite.stdout + canonical_suite.stderr).splitlines():
                if line.startswith(("FAIL", "Traceback")) or "Error" in line:
                    print("    " + line.strip()[:200])
            shutil.rmtree(tmp, ignore_errors=True)
            return 1
        canonical_cache.parent.mkdir(parents=True, exist_ok=True)
        canonical_cache.write_text(json.dumps({"key": canonical_key}), "utf-8")

    cases = [ac.case_parts(case) for case in ac.CASES]
    unavailable = [
        label
        for label, rel, mutation, _expected, _gate in cases
        if not ac.case_available(pristine, rel, mutation)
    ]
    if unavailable:
        for label in unavailable:
            print(f"FAIL: skipped canonical mutation: {label}")
        print("FAIL: parity denominator would change because a canonical mutation cannot be set up")
        shutil.rmtree(tmp, ignore_errors=True)
        return 1

    # Hardlink worker trees avoid copying the whole protocol eight times.
    # Every file a case may mutate is detached with copy2 BEFORE mutation, so
    # no write can cross the hardlink boundary into pristine or another worker.
    worker_count = min(2, len(cases))
    chunks = [cases[index::worker_count] for index in range(worker_count)]

    def run_chunk(index, chunk):
        root = tmp / f"parity-{index:02d}"
        shutil.copytree(pristine, root, copy_function=os.link)
        local_both, local_only, local_skipped = [], [], []
        timeout_case = None
        for position, (label, rel, mutation, _expected, _gate) in enumerate(chunk, 1):
            files = ac.mutation_files(root, rel, mutation)
            saved = [(file, file.read_bytes() if file.exists() else None) for file in files]
            for file, content in saved:
                if content is None or not file.exists():
                    continue
                source = pristine / file.relative_to(root)
                file.unlink()
                shutil.copy2(source, file)
            try:
                if not ac.apply_case(root, rel, mutation):
                    local_skipped.append(label)
                    continue
                floor_result = run_floor(root)
                if floor_result.returncode == 124:
                    timeout_case = label
                    break
                if floor_result.returncode != 0:
                    local_both.append(label)
                else:
                    local_only.append(label)
            finally:
                ac.restore_case_files(saved)
            if position % 10 == 0:
                print(
                    f"worker {index}: {position}/{len(chunk)} floor cases",
                    flush=True,
                )
        clean = validate(root) == 0 and floor(root) == 0
        return local_both, local_only, local_skipped, timeout_case, clean

    both, only_canonical, neither, skipped = [], [], [], []
    clean = True
    timeout_cases = []
    completed = 0
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        futures = [pool.submit(run_chunk, index, chunk) for index, chunk in enumerate(chunks)]
        for future in as_completed(futures):
            local_both, local_only, local_skipped, timeout_case, local_clean = future.result()
            both.extend(local_both)
            only_canonical.extend(local_only)
            skipped.extend(local_skipped)
            if timeout_case is not None:
                timeout_cases.append(timeout_case)
            clean = clean and local_clean
            completed += len(local_both) + len(local_only) + len(local_skipped)
            print(f"[{completed}/{len(cases)}] portable-floor cases complete", flush=True)

    if timeout_cases:
        for label in timeout_cases:
            print(f"FAIL: portable floor timed out on case: {label}")
        shutil.rmtree(tmp, ignore_errors=True)
        return 1

    if not clean:
        print(
            "FAIL: a hardlink worker did not survive the run -- detached-file "
            "restoration left a mutation behind, so the counts are measuring "
            "a drifting tree"
        )
        shutil.rmtree(tmp, ignore_errors=True)
        return 1
    shutil.rmtree(tmp, ignore_errors=True)

    print()
    applied = len(both) + len(only_canonical) + len(neither)
    print(f"cases applied: {applied} of {len(ac.CASES)}")
    print(f"  caught by both:                 {len(both)}")
    print(f"  caught only by tools/validate:  {len(only_canonical)}")
    print(f"  caught by neither (WARN-only):  {len(neither)}")
    for label in neither:
        print(f"      {label}")

    if skipped:
        for label in skipped:
            print(f"FAIL: skipped canonical mutation: {label}")
        print("\nFAIL: parity denominator changed because a canonical mutation could not be set up")
        return 1

    if len(both) < BASELINE:
        print(
            f"\nFAIL: the floor catches {len(both)} of {applied}, below the "
            f"recorded baseline of {BASELINE}. It has LOST coverage -- that "
            f"is the failure this tool exists for, not the gap itself"
        )
        return 1

    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps({"key": cache_key, "caught": len(both)}), "utf-8")

    print(
        f"\nPASS: the floor catches {len(both)} of {applied} "
        f"(baseline {BASELINE}). The other {len(only_canonical)} need "
        f"Python, which is why the floor no longer claims conformance in the "
        f"canonical validator's words"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
