#!/usr/bin/env python
"""Prove every check in the portable floor can still go red.

`tests/validate.sh` is what a host without Python runs INSTEAD of
tools/validate.py. Its checks were verified by hand when they shipped and
nothing kept them verified -- the same shape as the LOG timestamp check that
lay dead in validate.py from feae149 to v7.99.0, and as the first draft of the
portable-floor drift check, which passed its own red test by accident because
it could never fail at all.

So: build a known-good scratch project, break it one way per check, and assert
the floor names that specific failure. A check nobody has seen fire is
indistinguishable from one that cannot.

Stdlib only, same rule as the validator. Run from the SAIPEN home:

    python tools/audit_floor.py

Both halves of the floor are audited. Running validate.ps1 against a conformant
repo only proves it runs; it says nothing about whether its individual checks
still fire, and the two halves have diverged before -- ps1 matched `needs: (.*)`
to end of line where the shell script used `[^|]*`, so it FAILed a perfectly
legal board and no run ever noticed.
"""

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HOME = Path(__file__).resolve().parent.parent
FLOOR = HOME / "tests" / "validate.sh"
FLOOR_PS1 = HOME / "tests" / "validate.ps1"
REGISTRY = HOME / "saipen" / "REGISTRY.json"

GOOD_STATE = """---
phase: PLAN
task: none
next_action: "saipen plan"
blocker: none
transition_from: INIT
saipen_version: 7
schema_version: 1
agent: test
mode: full
updated: 2026-07-28T10:00:00Z
---
"""
GOOD_BOARD = "# Board\n## DOING\n\n## TODO\n- [ ] T-001 a ticket\n\n## DONE\n\n## BLOCKED\n"
GOOD_LOG = "# Log\n\n- 28.07.26 10:00 [E-001] [T-none] DEC: fixture\n"


_MACHINE_FACTS = json.loads(REGISTRY.read_text(encoding="utf-8-sig"))
REQUIRED_FIELDS = _MACHINE_FACTS["state"]["required_fields"]
READ_ONLY_PHASES = _MACHINE_FACTS["capabilities"]["read_only_banned_phases"]


def without_state_field(field: str):
    return lambda s, b, lg: (
        re.sub(rf"^{re.escape(field)}:.*\n", "", s, count=1, flags=re.MULTILINE),
        b,
        lg,
    )


REQUIRED_FIELD_CASES = [
    (
        f"required field {field} missing",
        without_state_field(field),
        "missing valid phase" if field == "phase" else f"missing {field}",
    )
    for field in REQUIRED_FIELDS
]


READ_ONLY_CASES = [
    (
        f"read-only in {phase}",
        lambda s, b, lg, phase=phase: (
            s.replace("mode: full", "mode: read-only", 1).replace(
                "phase: PLAN", f"phase: {phase}", 1
            ),
            b,
            lg,
        ),
        "read-only MUST NOT enter",
    )
    for phase in READ_ONLY_PHASES
]


def find_bash():
    """A plain "bash" is wrong on Windows: from Python it resolves to the WSL
    stub, which without an installed distro prints a UTF-16 error and runs
    nothing. The first version of this audit reported every check dead because
    of exactly that -- the instrument, not the floor."""
    for candidate in (
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files\Git\bin\bash.exe",
    ):
        if os.path.isfile(candidate):
            return candidate
    found = shutil.which("bash")
    if found and "system32" not in found.lower():
        return found
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


def find_pwsh():
    """pwsh on CI (ubuntu-latest ships it), powershell.exe on Windows."""
    for name in ("pwsh", "powershell"):
        found = shutil.which(name)
        if found:
            return found
    return None


# (label, mutate(state, board, log) -> (state, board, log), expected substring)
# A None value means "do not write this file at all".
# The harness reads the repo's live STATE, which may itself sit at
# `execution_intent: goal` with counters during a running goal -- so a goal
# mutation must strip intent/counter lines first, never blindly append.
def _force_goal_state(s: str, counters: str) -> str:
    out = [
        ln
        for ln in s.splitlines()
        if not ln.startswith(("execution_intent:", "goal_mode:", "goal_waves:", "goal_tickets:"))
    ]
    joined = "\n".join(out).replace(
        "mode: full", "mode: full\nexecution_intent: goal\n" + counters, 1
    )
    return joined


CASES = [
    ("missing STATE.md", lambda s, b, lg: (None, b, lg), "STATE.md missing"),
    ("missing BOARD.md", lambda s, b, lg: (s, None, lg), "BOARD.md missing"),
    ("missing LOG.md", lambda s, b, lg: (s, b, None), "LOG.md missing"),
    (
        "bad mode",
        lambda s, b, lg: (s.replace("mode: full", "mode: banana", 1), b, lg),
        "missing mode",
    ),
    (
        "goal intent without goal_waves",
        lambda s, b, lg: (_force_goal_state(s, "goal_tickets: 0"), b, lg),
        "goal_waves counter missing",
    ),
    (
        "goal intent without goal_tickets",
        lambda s, b, lg: (_force_goal_state(s, "goal_waves: 0"), b, lg),
        "goal_tickets counter missing",
    ),
    (
        "cyclic needs",
        lambda s, b, lg: (
            s,
            "# Board\n## DOING\n\n## TODO\n- [ ] T-001 a | needs: T-002\n"
            "- [ ] T-002 b | needs: T-001\n\n## DONE\n\n## BLOCKED\n",
            lg,
        ),
        "cyclic needs",
    ),
    (
        "duplicate ticket ID",
        lambda s, b, lg: (
            s,
            "# Board\n## DOING\n\n## TODO\n- [ ] T-001 a\n- [ ] T-001 b\n\n## DONE\n\n## BLOCKED\n",
            lg,
        ),
        "duplicate ticket ID",
    ),
    (
        "dangling needs",
        lambda s, b, lg: (
            s,
            "# Board\n## DOING\n\n## TODO\n- [ ] T-001 a | needs: T-999\n\n## DONE\n\n## BLOCKED\n",
            lg,
        ),
        "dangling needs",
    ),
    (
        "missing BOARD heading",
        lambda s, b, lg: (s, "# Board\n## DOING\n\n## TODO\n\n## DONE\n", lg),
        "missing required section heading",
    ),
    (
        "malformed LOG line",
        lambda s, b, lg: (s, b, "# Log\n\n- this is not an event line at all\n"),
        "Graph Event format",
    ),
    *REQUIRED_FIELD_CASES,
    *READ_ONLY_CASES,
]


def audit(runner, script, half):
    """Run every case against one half of the floor. Returns a failure list."""
    failures = []
    control = Path(tempfile.mkdtemp(prefix="saipen-floor-control-"))
    try:
        (control / ".saipen").mkdir()
        for name, content in (
            ("STATE.md", GOOD_STATE),
            ("BOARD.md", GOOD_BOARD),
            ("LOG.md", GOOD_LOG),
        ):
            with io.open(control / ".saipen" / name, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)
        env = bash_env(runner[0]) if half == "sh" else None
        result = subprocess.run(
            [*runner, script], cwd=str(control), env=env, capture_output=True, text=True
        )
        if result.returncode:
            first = next(
                (line for line in (result.stdout + result.stderr).splitlines() if "FAIL" in line),
                "<no FAIL line at all>",
            )
            return [f"[{half}] known-good control exited {result.returncode}: {first[:100]}"]
    finally:
        shutil.rmtree(control, ignore_errors=True)

    for label, mutate, expect in CASES:
        work = Path(tempfile.mkdtemp(prefix="saipen-floor-"))
        try:
            (work / ".saipen").mkdir()
            state, board, log = mutate(GOOD_STATE, GOOD_BOARD, GOOD_LOG)
            for name, content in (("STATE.md", state), ("BOARD.md", board), ("LOG.md", log)):
                if content is not None:
                    with io.open(
                        work / ".saipen" / name, "w", encoding="utf-8", newline="\n"
                    ) as fh:
                        fh.write(content)
            env = bash_env(runner[0]) if half == "sh" else None
            r = subprocess.run(
                [*runner, script], cwd=str(work), env=env, capture_output=True, text=True
            )
            blob = (r.stdout or "") + (r.stderr or "")
            if expect not in blob:
                first = next(
                    (ln for ln in blob.splitlines() if "FAIL" in ln), "<no FAIL line at all>"
                )
                failures.append(f"[{half}] {label}: expected {expect!r}, got {first[:90]!r}")
            elif r.returncode == 0:
                failures.append(f"[{half}] {label}: named the failure but exited 0")
            else:
                print(f"PASS: [{half}] {label} -- floor reports {expect!r}")
        finally:
            shutil.rmtree(work, ignore_errors=True)
    return failures


def audit_sh_log_filter_failure(bash: str) -> str | None:
    """Make only the LOG-filter sed invocation fail after earlier sed uses."""
    work = Path(tempfile.mkdtemp(prefix="saipen-floor-sed-failure-"))
    try:
        (work / ".saipen").mkdir()
        for name, content in (
            ("STATE.md", GOOD_STATE),
            ("BOARD.md", GOOD_BOARD),
            ("LOG.md", GOOD_LOG),
        ):
            with io.open(work / ".saipen" / name, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(content)

        shim_dir = work / "bin"
        shim_dir.mkdir()
        sed = shim_dir / "sed"
        sed.write_text(
            "#!/bin/sh\n"
            'case "$1" in\n'
            "  1s/*) echo 'synthetic LOG sed failure' >&2; exit 7 ;;\n"
            "esac\n"
            'command -p sed "$@"\n',
            encoding="utf-8",
            newline="\n",
        )
        sed.chmod(0o755)
        env = bash_env(bash)
        env["PATH"] = str(shim_dir) + os.pathsep + env.get("PATH", "")
        result = subprocess.run(
            [bash, FLOOR.as_posix()],
            cwd=work,
            env=env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        output = result.stdout + result.stderr
        if result.returncode == 0:
            return "[sh] LOG sed-rc7 control exited 0"
        if "FAIL: LOG.md read/filter failed" not in output:
            return f"[sh] LOG sed-rc7 control missed focused failure: {output.strip()[-200:]}"
        forbidden = ("PASS: LOG.md format valid", "Portable floor complete")
        if any(text in output for text in forbidden):
            return "[sh] LOG sed-rc7 control printed success after process failure"
        print(
            "PASS: [sh] LOG sed-rc7 process failure -- exits nonzero before "
            "LOG PASS or floor completion"
        )
        return None
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    failures, audited = [], []

    if not FLOOR.is_file():
        print(f"FAIL: {FLOOR.as_posix()} not found")
        return 1
    bash = find_bash()
    if bash:
        failures += audit([bash], FLOOR.as_posix(), "sh")
        process_failure = audit_sh_log_filter_failure(bash)
        if process_failure:
            failures.append(process_failure)
        audited.append("sh")
    else:
        print(
            "SKIP: no usable bash here -- the sh floor cannot be audited "
            "(absence of a check is not a passing check)"
        )

    if FLOOR_PS1.is_file():
        pwsh = find_pwsh()
        if pwsh:
            failures += audit(
                [pwsh, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File"], str(FLOOR_PS1), "ps1"
            )
            audited.append("ps1")
        else:
            print(
                "SKIP: no pwsh/powershell here -- the ps1 floor cannot be "
                "audited (absence of a check is not a passing check)"
            )

    if not audited:
        print("SKIP: neither half of the floor could be audited on this host")
        return 0

    print(f"\n{len(CASES)} checks x {len(audited)} half/halves audited ({', '.join(audited)})")
    if failures:
        print(f"\nFAILED: {len(failures)} check(s) did not fire as expected")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("Every audited portable-floor check still goes red on its own condition.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
