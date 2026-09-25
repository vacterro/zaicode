#!/usr/bin/env python
"""Run every executable conformance fixture and compare to its declaration.

Stdlib only. Run from the SAIPEN home:

    python tools/run_scenarios.py

`tests/scenarios/` holds two kinds of fixture. Behavioral ones are README-only
-- the assertion is about agent decision-making, which no script can judge --
and are skipped here. Structural ones ship a real `.saipen/` and declare the
outcome they expect on a line of their own README:

    expect: pass      the state is valid; tools/validate.py must exit 0
    expect: fail      the state carries the defect the fixture exists to
                      demonstrate; validate.py must exit non-zero

A fixture with a `.saipen/` and no `expect:` line is itself an error: an
un-declared fixture cannot be checked, and silently skipping it is how this
whole directory sat unexecuted for months (CONFORMANCE.md's "honest status"
note, v7.75.0).

After the state fixtures, both bootstrap injectors run against isolated homes
seeded with stale managed directories. The probe checks installed artifacts,
not script tokens, and carries a broken-layout red-control.

Project-root probes also execute the canonical validator from a correct Git
root, nested Git and non-Git directories, a foreign repository, an explicit
root, and a linked worktree. They assert no fallback `.saipen/` is created.

The last-event probe upgrades one legacy fixture through schema v2, advances
its LOG, and executes the validator at every boundary. It proves migration,
missing, exact, stale, recovered, and corrupt marker behavior.

Exit code is non-zero if any fixture's real outcome differs from its
declaration, so CI fails on it like any other gate.
"""

import contextlib
import dataclasses
import datetime
import functools
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import zipfile
from pathlib import Path
from unittest import mock

import freshness
from freshness import (
    FreshnessError,
    SourceIdentity,
    compute_generic_role_revision,
    compute_role_revision,
    compute_source_identity,
)
from sub_clean import sub_clean_blockers
from improve import (
    ImproveError,
    abort_cycle,
    allocate_cycle_id,
    append_run,
    archive_cycle,
    complete_cycle,
    complete_report,
    create_cycle,
    create_report,
    cycle_dir,
    derive_status,
    installed_protocol_fingerprint,
    _saipen_install_version,
    prepare_audit_seat,
    register_cycle,
    register_seat,
    resolve_report_path,
    retire_seat,
    validate_manifest,
    validate_report,
    validate_strict_provenance,
    verify_cycle,
    write_sweep_entry,
)
from userperson import (
    merge_profile,
    onboarding_questions,
    parse_profile,
    project_profile,
    remove_preference,
    render_profile,
    validate_profile,
)
from saipen_engine import codec
from saipen_engine.board import parse_board
from saipen_engine.state import parse_state
from saipen_engine.journal import Journal, pending_ops, recover, recovery_preflight, run_mutation
from saipen_engine.lock import WriterLock
from saipen_engine.log import build_event, parse_log_line
from saipen_engine.operations import (
    apply_claim,
    checkpoint,
    goal_entry,
    next_ticket_id,
    plan_claim,
    reauthorize_valve,
    set_goal_intent,
    stop_checkpoint,
    ticket_add,
    ticket_move,
    transition_phase,
    _now,
    _plan_claim,
    _utc_iso,
)
from saipen_engine.result import Result
from saipen_engine.router import route_next
from saipen_engine.snapshot import ProjectSnapshot
from saipen_engine.state import parse_frontmatter

HOME = Path(__file__).resolve().parent.parent
VALIDATOR = HOME / "tools" / "validate.py"
SCENARIOS = HOME / "tests" / "scenarios"


@dataclasses.dataclass
class GroupResult:
    """What one probe group produced, including having produced nothing.

    A group that RAISED is not an absence: `crashed` carries the exception and
    the group still appears in the summary with a zero and a reason. The suite
    used to lose everything after such a group (T-1361).
    """

    name: str
    noun: str
    failures: list[str] = dataclasses.field(default_factory=list)
    checked: int = 0
    skipped: int = 0
    crashed: str | None = None

    def summary_line(self) -> str:
        if self.crashed is not None:
            return f"0 {self.noun} -- HARNESS CRASHED: {self.crashed}"
        tail = f", {self.skipped} skipped" if self.skipped else ""
        return f"{self.checked} {self.noun}{tail}"


def _group_counts(result: object) -> tuple[list[str], int, int]:
    """Normalize a probe group's (failures, checked[, skipped]) return."""
    if not isinstance(result, tuple) or not 2 <= len(result) <= 3:
        raise TypeError(f"probe group returned {type(result).__name__}, not a 2- or 3-tuple")
    failures = list(result[0])
    checked = int(result[1])
    skipped = int(result[2]) if len(result) == 3 else 0
    return failures, checked, skipped


#: What `recover()` returns when a target's live bytes match neither the
#: recorded before-hash nor the after-hash and it refuses to guess.
#:
#: Commit b2343541 (T-1334, 15.09.26) renamed this RESULT code from the bare
#: `CONFLICT` to `RECOVERY_CONFLICT`, while `journal.mark("CONFLICT")` kept
#: `CONFLICT` as the journal STATUS -- the two were the same word for two
#: different things, and only one of them moved. Other journal paths still
#: answer plain `CONFLICT`, so this is a named constant at the sites the
#: rename actually reached, not a global search and replace (T-1361 CL-06).
RECOVERY_REFUSED = "RECOVERY_CONFLICT"

#: The one-line history a probe fixture used to ship.
PROBE_BASE_EVENT = "- 09.08.26 00:00 [E-900] [T-none] DEC: base\n"


def probe_fixture_log(tickets, agent: str = "probe") -> tuple[str, int]:
    """A fixture history that ALLOCATES the tickets its BOARD declares.

    CORE-003 / SRC-026:R003 made ticket identity come from a structured
    `[T-###]` allocation event in the complete history: a record that merely
    looks like a ticket is not one. Fixtures that hand-write records into
    `BOARD.md` and ship a history containing only `[T-none]` therefore fail
    fast validation on their own setup -- `apply_claim`, `transition_phase`
    and `goal_entry` all return VALIDATION_FAILED naming the unallocated
    ticket, the fixture never reaches the state its first `expect` asserts,
    and every later check in the group cascades from that one (T-1361 CL-05).

    The fixtures are not wrong about what they test. They predate the
    contract. This journals the allocation the way the engine does, so the
    fixture is legal for the same reason a real project is, rather than the
    check being relaxed to accommodate it.

    Returns the history and the last event id, which STATE must carry.
    """
    lines = [PROBE_BASE_EVENT]
    event = 900
    for index, ticket in enumerate(tickets, start=1):
        parent, event = event, event + 1
        lines.append(
            f"- 09.08.26 00:{index:02d} [E-{event}] [parent: E-{parent}] "
            f"[{ticket}] [agent: {agent}] DEC: allocated for the probe fixture\n"
        )
    return "".join(lines), event


def run_probe_groups(groups) -> list[GroupResult]:
    """Attempt every declared group; a crash is a recorded failure, not an exit.

    The one rule this function exists to enforce: NOTHING a group does may
    prevent the next group from running. An exception inside one becomes a
    bounded failure entry naming the group, and the walk continues to the last
    declared group -- so the final totals are the totals of what was attempted
    and a tail can no longer disappear behind a traceback.

    `KeyboardInterrupt` and `SystemExit` are deliberately NOT swallowed: an
    operator stopping the suite is not a probe failure, and a group calling
    `sys.exit` is a harness bug that must stay loud rather than be logged as
    one more red line.
    """
    results: list[GroupResult] = []
    for name, func, noun in groups:
        result = GroupResult(name=name, noun=noun)
        try:
            failures, checked, skipped = _group_counts(func())
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:
            detail = f"{type(exc).__name__}: {exc}"
            result.crashed = detail
            result.failures = [f"{name} harness crashed: {detail}"]
        else:
            result.failures = failures
            result.checked = checked
            result.skipped = skipped
        results.append(result)
    return results



@functools.lru_cache(maxsize=1)
def symlinks_available() -> bool:
    """Can this host create a symlink at all?

    Measured, never assumed from `os.name`: Windows creates symlinks fine with
    Developer Mode or SeCreateSymbolicLinkPrivilege and refuses without either,
    and restricted containers refuse on any platform. Unguarded `os.symlink`
    calls do not degrade to a SKIP -- they raise OSError out of the probe
    function and take the whole scenario suite down with a traceback, which is
    the worst of the three outcomes because it hides every check after it
    (T-572). Lazy: the filesystem operation runs on first use, never merely
    from importing this module.
    """
    with tempfile.TemporaryDirectory(prefix="saipen-symlink-probe-") as raw:
        base = Path(raw)
        (base / "target").write_text("t\n", encoding="utf-8")
        try:
            os.symlink("target", base / "link")
        except (OSError, NotImplementedError, AttributeError):
            return False
        return (base / "link").is_symlink()


@functools.lru_cache(maxsize=1)
def junctions_available() -> bool:
    """Can this host create a directory junction (reparse point) at all?

    Junctions are not symlinks: `Path.is_symlink()` is False for one, which is
    exactly why detection must read the reparse-point attribute (T-572).
    `mklink /J` needs no privilege and works on every Windows host; anything
    else is not a junction-capable host and SKIPs out loud.
    """
    if os.name != "nt":
        return False
    with tempfile.TemporaryDirectory(prefix="saipen-junction-probe-") as raw:
        base = Path(raw)
        real = base / "real"
        real.mkdir()
        link = base / "junction"
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", os.fspath(link), os.fspath(real)],
            capture_output=True,
            text=True,
            errors="replace",
        )
        if result.returncode != 0 or not link.exists():
            return False
        info = link.lstat()
        return bool(getattr(info, "st_file_attributes", 0) & 0x400)


EXPECT_RE = re.compile(r"^expect:\s*(pass|fail)\s*$", re.MULTILINE)

_IGNORE_RUNTIME = shutil.ignore_patterns(
    "__pycache__", "*.pyc", ".saipen/recovery", ".saipen/locks", ".saipen/cache"
)

# A fixture that declares `expect: fail` and then fails for some OTHER reason
# asserts nothing at all, and says PASS while doing it. Three did exactly that:
# dependency-cycle, dangling-needs-reference and read-only-restriction each
# carried a control character where `saipen_version: 7` belonged, so every run
# died on unparseable frontmatter long before reaching the cycle, the dangling
# reference or the mode ban they exist to prove. The suite was green throughout.
#
# So a fail-fixture MAY pin the reason with a second line:
#     expect_fail_contains: <substring of the FAIL message>
# A fail-fixture MUST pin its reason. Unpinned, it asserts only that
# something, somewhere, went wrong -- which is the failure mode this whole
# harness exists to detect one layer down: red is not evidence unless it is red
# for the reason the fixture was built to prove. Reproduced twice in one
# session: three `audit_checks` controls went red on a mangled ticket line
# rather than on the cap they name, and a new fixture went red on an unrelated
# `[phase-ticket-ref]` FAIL leaking in from outside its own tree. Every
# fail-fixture in this repository already carries the pin, so this is a rot
# guard rather than a migration.
REASON_RE = re.compile(r"^expect_fail_contains:\s*(.+?)\s*$", re.MULTILINE)
WARN_RE = re.compile(r"^expect_warn_contains:\s*(.+?)\s*$", re.MULTILINE)


def find_bash() -> str | None:
    """Return a real bash, excluding Windows' WSL launcher stub."""
    for candidate in (
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files\Git\bin\bash.exe",
        shutil.which("bash"),
    ):
        if candidate and os.path.isfile(candidate) and "system32" not in candidate.lower():
            return candidate
    return None


def find_dash() -> str | None:
    """Return dash for proving the generated POSIX hook is not Bash itself."""
    for candidate in (r"C:\Program Files\Git\usr\bin\dash.exe", shutil.which("dash")):
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def bash_env(bash: str, home: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["HOME"] = str(home)
    env["USERPROFILE"] = str(home)
    # The injector probe runs uninstall.sh against a sandbox HOME, but the
    # scheduled task is machine-global -- the probe must not delete a real
    # scheduler entry (T-531/T-534).
    env["SAIPEN_UNINSTALL_SKIP_TASK"] = "1"
    if os.name == "nt":
        bindir = Path(bash).resolve().parent
        for tools_dir in (bindir, bindir.parent / "usr" / "bin"):
            if all((tools_dir / f"{name}.exe").is_file() for name in ("cp", "grep", "sed")):
                env["PATH"] = str(tools_dir) + os.pathsep + env.get("PATH", "")
                break
    return env


def find_powershell() -> str | None:
    for name in ("pwsh", "powershell", "powershell.exe"):
        found = shutil.which(name)
        if found:
            return found
    return None


def run_ci_status_probes() -> tuple[list[str], int]:
    """T-428: the four ways the CI-status tool could fail quietly.

    All four run OFFLINE. A probe that needs GitHub is a probe that skips on
    every machine without a network and reports "0 failures" while checking
    nothing -- the vacuous-gate shape this repository keeps finding in itself.
    The API is reached exactly once here, through a stub that raises.
    """
    failures = []
    spec = importlib.util.spec_from_file_location(
        "saipen_ci_status", HOME / "tools" / "ci_status.py"
    )
    ci = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ci)

    # 1. An in-progress run must not hide a red base. The URL is the whole
    #    mechanism: without status=completed the newest run wins even when it
    #    is still queued, classify() says "in progress" and exits 0, and the
    #    RED run underneath is never looked at -- which is exactly the moment
    #    the tool exists for, a red base being re-run while someone commits.
    url = ci.runs_url("owner/repo", "main", "validate.yml")
    if "status=completed" not in url:
        failures.append(f"ci_status branch query does not ask for completed runs: {url}")
    elif (
        ci.classify({"status": "in_progress", "run_number": 1})[0] != 0
        or ci.classify({"status": "completed", "conclusion": "failure", "run_number": 1})[0] != 1
    ):
        failures.append(
            "ci_status classify() does not separate an in-progress run from a completed failure"
        )
    else:
        print(
            "PASS: ci_status queries completed runs only; in-progress is "
            "not a verdict and a completed failure is"
        )

    # 2. An unreachable API must never block a commit, and must say nothing
    #    in hook mode -- a per-commit "cannot reach GitHub" line is noise the
    #    user learns to scroll past, which is how a real red line gets missed.
    def _boom(_url):
        raise urllib.error.URLError("probe: network down")

    ci.fetch_json = _boom
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = ci.main_argv(["--hook", "--repo", "owner/repo", "--branch", "main"])
    if rc != 0 or buf.getvalue().strip():
        failures.append(
            f"ci_status --hook did not fail open on an "
            f"unreachable API: rc={rc} out={buf.getvalue()[:120]!r}"
        )
    else:
        print("PASS: ci_status --hook fails open and stays silent when the API is unreachable")

    # 3. The cache path must come from git, not the literal `.git/`. In a
    #    linked worktree `.git` is a FILE, so the literal path cannot be
    #    written: the hook would silently stop caching and spend one of the
    #    60 unauthenticated requests per hour on every commit made there.
    with tempfile.TemporaryDirectory(prefix="saipen-ci-") as raw:
        root = Path(raw)
        main_repo = root / "main"
        main_repo.mkdir()
        for args in (
            ["init", "-q"],
            ["config", "user.email", "p@probe"],
            ["config", "user.name", "probe"],
            ["commit", "-q", "--allow-empty", "-m", "base"],
            ["worktree", "add", "-q", "-b", "probe", str(root / "linked")],
        ):
            subprocess.run(
                ["git", *args], cwd=main_repo, check=False, capture_output=True, text=True
            )
        linked = root / "linked"
        if not linked.is_dir():
            print("SKIP: ci_status worktree cache -- git worktree unavailable")
        else:
            cwd = os.getcwd()
            try:
                os.chdir(linked)
                path = ci.cache_path()
            finally:
                os.chdir(cwd)
            if path is None or not path.parent.is_dir():
                failures.append(
                    f"ci_status cache_path() does not resolve to "
                    f"a real directory in a linked worktree: "
                    f"{path}"
                )
            elif path.parent == linked / ".git":
                failures.append(
                    "ci_status cache_path() returned the literal "
                    ".git/ of a linked worktree, where .git is a "
                    "file -- the write can only fail"
                )
            else:
                print(
                    "PASS: ci_status cache path resolves through git and is "
                    "writable inside a linked worktree"
                )

    return failures, 3


def run_hook_probes() -> tuple[list[str], int, int]:
    failures = []
    bash, dash = find_bash(), find_dash()
    if not bash or not dash:
        print("SKIP: installed-hook Bash resolution -- bash or dash unavailable")
        return failures, 0, 1

    with tempfile.TemporaryDirectory(prefix="saipen-hook-") as raw:
        root = Path(raw)
        fake_home = root / "saipen-home"
        (fake_home / "tools").mkdir(parents=True)
        (fake_home / "tests").mkdir()
        shutil.copy2(HOME / "tools" / "install_hook.py", fake_home / "tools" / "install_hook.py")
        (fake_home / "tools" / "validate.py").write_text(
            "# forces the hook's no-Python fallback branch\n", encoding="utf-8"
        )
        (fake_home / "tests" / "validate.sh").write_text(
            "#!/bin/bash\nread -r value <<< 'bash-floor-ok'\n"
            '[ "$value" = bash-floor-ok ] || exit 8\necho FLOOR_OK\n',
            encoding="utf-8",
            newline="\n",
        )

        project = root / "project"
        (project / ".git" / "hooks").mkdir(parents=True)
        (project / ".saipen").mkdir()
        install = subprocess.run(
            [sys.executable, str(fake_home / "tools" / "install_hook.py")],
            cwd=project,
            capture_output=True,
            text=True,
            errors="replace",
        )
        if install.returncode:
            return [f"install-hook probe setup failed: {install.stderr.strip()[:160]}"], 1, 0
        hook = project / ".git" / "hooks" / "pre-commit"

        controlled = root / "bin"
        controlled.mkdir()
        if os.name == "nt":
            bash_path = str(Path(bash).resolve().parent)
        elif symlinks_available():
            (controlled / "bash").symlink_to(Path(bash).resolve())
            bash_path = str(controlled)
        else:
            bash_path = str(Path(bash).resolve().parent)
        env = os.environ.copy()
        env["PATH"] = bash_path
        working = subprocess.run(
            [dash, str(hook)],
            cwd=project,
            env=env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        working_output = working.stdout + working.stderr
        if working.returncode or "FLOOR_OK" not in working_output:
            failures.append(
                f"installed-hook dash control did not execute Bash floor: "
                f"rc={working.returncode} {working_output.strip()[-160:]}"
            )
        else:
            print("PASS: installed hook under dash -- Bash floor executed")

        no_bash_env = os.environ.copy()
        no_bash_env["PATH"] = ""
        missing = subprocess.run(
            [dash, str(hook)],
            cwd=project,
            env=no_bash_env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        missing_output = missing.stdout + missing.stderr
        expected = "saipen: validation failed -- Bash is required to run"
        if missing.returncode == 0 or expected not in missing_output:
            failures.append(
                f"installed-hook no-Bash control was not focused: "
                f"rc={missing.returncode} {missing_output.strip()[-160:]}"
            )
        elif "FLOOR_OK" in missing_output:
            failures.append("installed-hook no-Bash control printed floor success")
        else:
            print("PASS: installed hook without Bash -- focused nonzero failure")

        # T-428, the two halves of the CI-status line the hook grew in
        # generation 4. The fake home above deliberately has no ci_status.py,
        # which is every clone that predates it and every consuming project
        # that never installed it: the `-f` guard must skip the call silently
        # rather than let a missing tool leak an error into every commit.
        # The two controls above run on a PATH holding only bash, which also
        # hides `python` -- and the hook guards its CI line on `command -v
        # python`. Probing the CI line on that PATH would assert nothing
        # while printing PASS, the vacuous-control shape this file exists to
        # prevent, so both CI probes get python back on the PATH.
        python_exe = shutil.which("python")
        ci_env = os.environ.copy()
        ci_env["PATH"] = (
            bash_path + os.pathsep + str(Path(python_exe).resolve().parent)
            if python_exe
            else bash_path
        )
        no_tool = subprocess.run(
            [dash, str(hook)],
            cwd=project,
            env=ci_env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        no_tool_output = no_tool.stdout + no_tool.stderr
        if not python_exe:
            print("SKIP: installed-hook CI line -- no python on PATH")
            return failures, 2, 1
        # No FLOOR_OK expected here: with python back on the PATH the hook
        # takes its normal validate.py branch and never reaches the Bash
        # fallback the two controls above were built to exercise.
        if no_tool.returncode:
            failures.append(
                f"installed hook broke with no ci_status.py present: "
                f"rc={no_tool.returncode} {no_tool_output.strip()[-160:]}"
            )
        elif "RED" in no_tool_output or "ci_status" in no_tool_output:
            failures.append(
                "installed hook without ci_status.py leaked CI output -- the -f guard did not hold"
            )
        else:
            print(
                "PASS: installed hook with no ci_status.py present -- "
                "skipped silently, commit path unaffected"
            )

        # And the other half: with the tool present and RED, the hook must
        # still exit 0. Warn-only is not a preference here -- a red CI that
        # blocks commits blocks the commit that fixes it. Docstring, hook
        # comment and behaviour now say the same thing.
        (fake_home / "tools" / "ci_status.py").write_text(
            "import sys\nprint('run #1 failure (deadbee..) -- RED -- probe')\nsys.exit(1)\n",
            encoding="utf-8",
            newline="\n",
        )
        red = subprocess.run(
            [dash, str(hook)],
            cwd=project,
            env=ci_env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        red_output = red.stdout + red.stderr
        if red.returncode != 0:
            failures.append(
                f"installed hook blocked a commit on a RED CI status: "
                f"rc={red.returncode} {red_output.strip()[-160:]}"
            )
        elif "RED" not in red_output:
            failures.append(
                "installed hook swallowed the RED CI line -- a warning nobody sees is not a warning"
            )
        else:
            print(
                "PASS: installed hook reports a RED CI status and still "
                "exits 0 -- warn-only, as the docs now say"
            )

        # T-527, the two halves of the NOT-VALIDATED diagnostic. It exists to
        # catch a commit that LOOKS validated and was not, so it is worth
        # nothing unless it is silent on the healthy path: generation 6 fired
        # it on every successful commit for want of a success exit, and a
        # warning that always fires is one nobody reads on the day it is true.
        # The healthy run is `no_tool` above -- stub validate.py rc 0 and the
        # Bash floor both ran, which is exactly the case the line must not
        # describe.
        not_validated = "saipen: NOT VALIDATED"
        if not_validated in no_tool_output:
            failures.append(
                "installed hook claimed NOT VALIDATED after a validator ran "
                "and passed -- the success exit is missing or unreachable"
            )
        else:
            print(
                "PASS: installed hook is silent on the healthy path -- no "
                "false NOT-VALIDATED line after a passing validator"
            )

        # The other half, and the reason the success exit is gated on
        # `_validate_rc` being SET rather than added unconditionally: with no
        # validator reachable at all the line must still appear, and the commit
        # must still go through. Removing both entry points leaves the hook's
        # `-f` guards unsatisfied and its saipen_home fallback with nothing to
        # recover, which is the broken install this diagnostic was built for.
        (fake_home / "tools" / "validate.py").unlink()
        (fake_home / "tests" / "validate.sh").unlink()
        broken = subprocess.run(
            [dash, str(hook)],
            cwd=project,
            env=ci_env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        broken_output = broken.stdout + broken.stderr
        if broken.returncode != 0:
            failures.append(
                f"installed hook blocked a commit on a broken install: "
                f"rc={broken.returncode} {broken_output.strip()[-160:]}"
            )
        elif not_validated not in broken_output:
            failures.append(
                "installed hook went quiet with no validator reachable -- an "
                "unvalidated commit that looks validated is the silent PASS"
            )
        else:
            print(
                "PASS: installed hook with no validator reachable -- says "
                "NOT VALIDATED out loud and still exits 0"
            )
    return failures, 6, 0


def run_precommit_purity_probe() -> tuple[list[str], int, int]:
    """The pre-commit gate MUST be read-only: `git status --porcelain=v1 -uall`
    byte-identical before and after the hook runs (goal blind spot 10, T-518).
    The gen-5 hook captures status before validation and FAILs on any change;
    a stub validator that writes a file must trip that guard."""
    failures = []
    bash, dash = find_bash(), find_dash()
    if not bash or not dash:
        print("SKIP: pre-commit purity probe -- bash or dash unavailable")
        return failures, 0, 1

    env = bash_env(bash, Path("."))

    def build(validator_body: str):
        with tempfile.TemporaryDirectory(prefix="saipen-purity-") as raw:
            root = Path(raw)
            fake_home = root / "saipen-home"
            (fake_home / "tools").mkdir(parents=True)
            (fake_home / "tests").mkdir()
            shutil.copy2(
                HOME / "tools" / "install_hook.py", fake_home / "tools" / "install_hook.py"
            )
            (fake_home / "tools" / "validate.py").write_text(
                validator_body, encoding="utf-8", newline="\n"
            )
            (fake_home / "tests" / "validate.sh").write_text(
                "#!/bin/bash\necho FLOOR_OK\n", encoding="utf-8", newline="\n"
            )
            project = root / "project"
            (project / ".git" / "hooks").mkdir(parents=True)
            (project / ".saipen").mkdir()
            subprocess.run(["git", "init", "-q"], cwd=project, check=True)
            subprocess.run(["git", "config", "user.name", "purity"], cwd=project, check=True)
            subprocess.run(
                ["git", "config", "user.email", "p@example.invalid"], cwd=project, check=True
            )
            install = subprocess.run(
                [sys.executable, str(fake_home / "tools" / "install_hook.py")],
                cwd=project,
                capture_output=True,
                text=True,
                errors="replace",
            )
            if install.returncode:
                return (root, f"purity probe install failed: {install.stderr.strip()[:160]}")
            hook = project / ".git" / "hooks" / "pre-commit"

            before = subprocess.run(
                ["git", "status", "--porcelain=v1", "-uall"],
                cwd=project,
                capture_output=True,
                text=True,
                errors="replace",
            ).stdout
            run = subprocess.run(
                [dash, str(hook)],
                cwd=project,
                env=env,
                capture_output=True,
                text=True,
                errors="replace",
            )
            after = subprocess.run(
                ["git", "status", "--porcelain=v1", "-uall"],
                cwd=project,
                capture_output=True,
                text=True,
                errors="replace",
            ).stdout
            return (root, None, run, before, after)

    # Case 1: read-only validator -> hook passes, tree byte-identical.
    _, err, run, before, after = build("import sys\nprint('VALIDATOR-OK')\nsys.exit(0)\n")
    if err:
        failures.append(err)
    elif run.returncode != 0:
        failures.append(
            f"purity probe: read-only hook failed rc={run.returncode} {run.stderr.strip()[-160:]}"
        )
    elif after != before:
        failures.append(
            "purity probe: git status CHANGED across a read-only "
            "hook -- validation is not read-only"
        )
    else:
        print("PASS: pre-commit gate leaves git status byte-identical (read-only validation)")

    # Case 2: mutating validator -> gen-5 guard must FAIL the hook.
    _, err, run, before, after = build(
        "from pathlib import Path\n"
        "Path('tampered.txt').write_text('mutated', encoding='utf-8')\n"
        "import sys\nprint('VALIDATOR-MUTATED')\nsys.exit(0)\n"
    )
    if err:
        failures.append(err)
    elif run.returncode == 0:
        failures.append(
            "purity probe: a validator that WROTE a file did NOT "
            "trip the gen-5 mutation guard -- the guard is dead"
        )
    else:
        print("PASS: gen-5 guard FAILs a validator that mutates the tree")
    return failures, 2, 0


RUNTIME_MANIFEST = json.loads((HOME / "saipen" / "MANIFEST.json").read_text(encoding="utf-8"))

# T-992: fixtures that create STRICT ACTIVE reports validated by the real
# validator must carry the INSTALLED protocol fingerprint and version --
# the validator compares ACTIVE strict evidence to current installed truth,
# so a fixture digest would fail on purpose. Historical/archived fixtures
# keep their own historical values.
PROBE_INSTALLED_FP = installed_protocol_fingerprint(HOME)
PROBE_SAIPEN_VERSION = _saipen_install_version()


def install_relative_path(source: str) -> str:
    prefix = "saipen/"
    return source[len(prefix) :] if source.startswith(prefix) else source


REQUIRED_INSTALL_FILES = tuple(
    install_relative_path(entry["src"])
    for entry in RUNTIME_MANIFEST["files"]
    if entry.get("required", False)
) + tuple(f"phases/{name}" for name in RUNTIME_MANIFEST["phase_docs"]["files"])
STALE_SENTINEL = "obsolete-from-prior-install.txt"
MANAGED_DIRS = tuple(RUNTIME_MANIFEST["managed_dirs"])


def seed_stale_install(destination: Path) -> None:
    for rel in MANAGED_DIRS:
        target = destination / rel
        target.mkdir(parents=True, exist_ok=True)
        (target / STALE_SENTINEL).write_text("stale\n", encoding="utf-8")


def installed_layout_problems(destination: Path) -> list[str]:
    problems = [
        f"missing {rel}" for rel in REQUIRED_INSTALL_FILES if not (destination / rel).is_file()
    ]
    expected_version = (HOME / "VERSION").read_text(encoding="utf-8-sig").strip()
    installed_version = destination / "VERSION"
    if (
        installed_version.is_file()
        and installed_version.read_text(encoding="utf-8-sig").strip() != expected_version
    ):
        problems.append("installed VERSION differs from source")
    stale = [rel for rel in MANAGED_DIRS if (destination / rel / STALE_SENTINEL).exists()]
    if stale:
        problems.append(f"stale managed content survived in {stale}")
    installed_tools = destination / "tools"
    bytecode = sorted(
        str(path.relative_to(destination))
        for path in installed_tools.rglob("*")
        if (
            (path.is_dir() and path.name == "__pycache__")
            or (path.is_file() and path.suffix in {".pyc", ".pyo"})
        )
    )
    if bytecode:
        problems.append(f"installed tools contain generated Python bytecode: {bytecode}")
    for tree in RUNTIME_MANIFEST["copy_trees"]:
        source = HOME / tree["src"]
        installed = destination / tree["dst"]

        def copied_files(root: Path) -> dict[str, bytes]:
            return {
                path.relative_to(root).as_posix(): path.read_bytes()
                for path in root.rglob("*")
                if (
                    path.is_file()
                    and "__pycache__" not in path.parts
                    and path.suffix not in {".pyc", ".pyo"}
                )
            }

        source_files = copied_files(source)
        installed_files = copied_files(installed) if installed.is_dir() else {}
        if source_files != installed_files:
            problems.append(f"installed copy tree differs from source: {tree['src']}")
    return problems


ROUND_TRIP_BYTES = b"user-setting: keep  \r\n \t\r\n\r\n"
AIDER_ROUND_TRIP_BYTES = (
    b"\xef\xbb\xbfuser-setting: keep  \r\n  - C:/user/decoy/saipen/STYLE.md\r\n\r\n"
)
AIDER_SUFFIX_BYTES = b"user-after-install: keep\r\n"


def run_injector_probe(
    label: str, command: list[str], uninstall_command: list[str], env: dict[str, str], home: Path
) -> str | None:
    destination = home / ".claude" / "skills" / "saipen"
    (home / ".claude").mkdir(parents=True)
    config = home / ".claude" / "CLAUDE.md"
    config.write_bytes(ROUND_TRIP_BYTES)
    aider_config = home / ".aider.conf.yml"
    aider_config.write_bytes(AIDER_ROUND_TRIP_BYTES)
    shim_dir = home / "bin"
    shim_dir.mkdir()
    aider = shim_dir / "aider"
    aider.write_text("#!/usr/bin/env sh\nexit 0\n", encoding="utf-8", newline="\n")
    aider.chmod(0o755)
    (shim_dir / "aider.cmd").write_text("@exit /b 0\r\n", encoding="utf-8")
    env = env.copy()
    env["PATH"] = str(shim_dir) + os.pathsep + env.get("PATH", "")
    seed_stale_install(destination)
    # Hermetic: sentinels live inside the disposable home, never in HOME
    source_cache = home / "tools" / "__pycache__" / (f"saipen_distribution_probe_{os.getpid()}.pyc")
    source_loose_bytecode = home / "tools" / (f"saipen_distribution_probe_{os.getpid()}.pyc")
    source_cache.parent.mkdir(parents=True, exist_ok=True)
    source_cache.write_bytes(b"not real bytecode; distribution sentinel\n")
    source_loose_bytecode.write_bytes(b"not real bytecode; loose distribution sentinel\n")
    result = subprocess.run(
        command, cwd=home, env=env, capture_output=True, text=True, errors="replace"
    )
    problems = installed_layout_problems(destination)
    if result.returncode:
        problems.insert(0, f"exited {result.returncode}")
    if not problems:
        project = home / "validator-project"
        shutil.copytree(SCENARIOS / "resume-after-crash" / ".saipen", project / ".saipen")
        installed_validator = destination / "tools" / "validate.py"
        validation = subprocess.run(
            [sys.executable, str(installed_validator), "--project-root", str(project)],
            cwd=home,
            env=env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        expected_root = f"Project root: {project.resolve()} (explicit)"
        if validation.returncode != 0 or expected_root not in validation.stdout:
            first = next(
                (
                    line
                    for line in (validation.stdout + validation.stderr).splitlines()
                    if line.startswith(("FAIL", "Traceback"))
                ),
                "installed validator did not report a failure line",
            )
            problems.append(
                f"installed validator explicit-root smoke exited "
                f"{validation.returncode}: {first[:120]}"
            )
    if b"<!-- SAIPEN:BEGIN -->" not in config.read_bytes():
        problems.append("injector did not add its managed config block")
    aider_installed = aider_config.read_bytes()
    if b"BOOT.md" not in aider_installed or b"STYLE.md" not in aider_installed:
        problems.append("injector did not add its managed BOOT+STYLE Aider block")
    if not problems:
        marker = aider_installed.find(b"\n# saipen protocol auto-loaded\n")
        if marker < 0:
            problems.append("injector Aider block has no exact managed marker")
        else:
            # Editors routinely normalize a managed LF block to CRLF. Both
            # uninstallers must still remove it without touching user bytes.
            aider_installed = aider_installed[:marker] + aider_installed[marker:].replace(
                b"\n", b"\r\n"
            )
    if not problems:
        aider_config.write_bytes(aider_installed + AIDER_SUFFIX_BYTES)
        uninstall = subprocess.run(
            uninstall_command, cwd=HOME, env=env, capture_output=True, text=True, errors="replace"
        )
        uninstall_output = uninstall.stdout + uninstall.stderr
        if uninstall.returncode:
            problems.append(f"uninstaller exited {uninstall.returncode}")
        elif "Done." not in uninstall_output:
            problems.append("uninstaller succeeded without completion text")
        if config.read_bytes() != ROUND_TRIP_BYTES:
            problems.append("install/uninstall changed surrounding user bytes")
        aider_after = aider_config.read_bytes()
        aider_expected = AIDER_ROUND_TRIP_BYTES + AIDER_SUFFIX_BYTES
        if aider_after != aider_expected:
            problems.append(
                "Aider install/uninstall changed surrounding user bytes: "
                f"expected {aider_expected!r}, got {aider_after!r}"
            )
        if destination.exists():
            problems.append("uninstaller left the installed skill directory")
    if problems:
        detail = next(
            (
                line
                for line in (result.stdout + result.stderr).splitlines()
                if "FAILED" in line or "FATAL" in line
            ),
            "no failure line",
        )
        return f"{label}: {'; '.join(problems)} | {detail[:120]}"
    print(
        f"PASS: {label} -- manifest-complete install replaced stale dirs, "
        "ran validate.py, and uninstalled config + Aider byte-exact"
    )
    return None


def failed_bootstrap_problem(label: str, result: subprocess.CompletedProcess[str]) -> str | None:
    output = result.stdout + result.stderr
    if result.returncode == 0:
        return f"{label}: failure control exited 0"
    if "Done." in output:
        return f"{label}: failure control printed Done"
    if not any(word in output for word in ("FAILED", "not a file", "Is a directory")):
        return f"{label}: failure control had no focused diagnostic"
    print(f"PASS: {label} -- exits nonzero without completion text")
    return None


def run_atomic_copy_failure_probes(
    label: str, source: Path, home: Path, command: list[str], env: dict[str, str]
) -> tuple[list[str], int]:
    """Late source/manifest failures must preserve the active installed copy."""
    problems: list[str] = []
    checked = 0
    destination = home / ".claude" / "skills" / "saipen"
    destination.mkdir(parents=True)
    sentinel = destination / "active-install.txt"
    sentinel_bytes = b"preserve active install\r\n"
    sentinel.write_bytes(sentinel_bytes)
    manifest_path = source / "saipen" / "MANIFEST.json"
    original = json.loads(manifest_path.read_text(encoding="utf-8"))

    def execute(case: str, manifest: dict, expected: str) -> None:
        nonlocal checked
        checked += 1
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        result = subprocess.run(
            command, cwd=source, env=env, capture_output=True, text=True, errors="replace"
        )
        leftovers = sorted(destination.parent.glob(".saipen.saipen-*"))
        output = result.stdout + result.stderr
        failures = []
        if result.returncode == 0:
            failures.append("exited 0")
        if not sentinel.is_file() or sentinel.read_bytes() != sentinel_bytes:
            failures.append("active install changed")
        if leftovers:
            failures.append(f"staging debris remains: {[p.name for p in leftovers]}")
        if expected not in output:
            failures.append(f"missing diagnostic {expected!r}")
        if failures:
            problems.append(f"{label} {case}: {'; '.join(failures)}")
        else:
            print(f"PASS: {label} {case} -- old install preserved, no staging debris")

    missing = json.loads(json.dumps(original))
    missing["files"].append({"src": "missing-runtime-file", "required": True})
    execute("late missing source", missing, "runtime manifest file missing")

    traversal = json.loads(json.dumps(original))
    traversal["copy_trees"][0]["src"] = "../outside"
    execute("manifest traversal", traversal, "unsafe runtime manifest")
    manifest_path.write_text(
        json.dumps(original, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    return problems, checked


def run_injector_probes() -> tuple[list[str], int, int]:
    probe_failures = []
    checked = skipped = 0
    bash = find_bash()
    powershell = find_powershell()

    if bash:

        def grep_failure_env(home: Path) -> dict[str, str]:
            shim_dir = home / "bin"
            shim_dir.mkdir()
            grep = shim_dir / "grep"
            grep.write_text("#!/usr/bin/env bash\nexit 2\n", encoding="utf-8", newline="\n")
            grep.chmod(0o755)
            aider = shim_dir / "aider"
            aider.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8", newline="\n")
            aider.chmod(0o755)
            env = bash_env(bash, home)
            env["PATH"] = str(shim_dir) + os.pathsep + env.get("PATH", "")
            return env

        with tempfile.TemporaryDirectory(prefix="saipen-inject-sh-") as raw:
            home = Path(raw)
            problem = run_injector_probe(
                "bootstrap/inject.sh",
                [bash, str(HOME / "bootstrap" / "inject.sh")],
                [bash, str(HOME / "bootstrap" / "uninstall.sh")],
                bash_env(bash, home),
                home,
            )
            if problem:
                probe_failures.append(problem)

        with tempfile.TemporaryDirectory(prefix="saipen-inject-sh-grep-fail-") as raw:
            home = Path(raw)
            config = home / ".claude" / "CLAUDE.md"
            config.parent.mkdir(parents=True)
            original = b"user config\n"
            config.write_bytes(original)
            aider_config = home / ".aider.conf.yml"
            aider_original = b"read:\n  - user-owned.md\n"
            aider_config.write_bytes(aider_original)
            result = subprocess.run(
                [bash, str(HOME / "bootstrap" / "inject.sh")],
                cwd=HOME,
                env=grep_failure_env(home),
                capture_output=True,
                text=True,
                errors="replace",
            )
            problem = failed_bootstrap_problem("bootstrap/inject.sh grep failure", result)
            if problem:
                probe_failures.append(problem)
            elif config.read_bytes() != original or aider_config.read_bytes() != aider_original:
                probe_failures.append(
                    "bootstrap/inject.sh grep failure: config changed after read error"
                )
            else:
                print("PASS: bootstrap/inject.sh grep failure -- exits nonzero without Done")
            checked += 1

        with tempfile.TemporaryDirectory(prefix="saipen-inject-sh-fail-") as raw:
            home = Path(raw)
            config = home / ".claude" / "CLAUDE.md"
            config.mkdir(parents=True)
            result = subprocess.run(
                [bash, str(HOME / "bootstrap" / "inject.sh")],
                cwd=HOME,
                env=bash_env(bash, home),
                capture_output=True,
                text=True,
                errors="replace",
            )
            problem = failed_bootstrap_problem("bootstrap/inject.sh write failure", result)
            if problem:
                probe_failures.append(problem)

        with tempfile.TemporaryDirectory(prefix="saipen-uninstall-sh-fail-") as raw:
            home = Path(raw)
            config = home / ".claude" / "CLAUDE.md"
            config.parent.mkdir(parents=True)
            config.write_text(
                "user\n\n<!-- SAIPEN:BEGIN -->\nstale\n<!-- SAIPEN:END -->\n",
                encoding="utf-8",
                newline="\n",
            )
            shim_dir = home / "bin"
            shim_dir.mkdir()
            head = shim_dir / "head"
            head.write_text("#!/usr/bin/env bash\nexit 9\n", encoding="utf-8", newline="\n")
            head.chmod(0o755)
            env = bash_env(bash, home)
            env["PATH"] = str(shim_dir) + os.pathsep + env.get("PATH", "")
            result = subprocess.run(
                [bash, str(HOME / "bootstrap" / "uninstall.sh")],
                cwd=HOME,
                env=env,
                capture_output=True,
                text=True,
                errors="replace",
            )
            problem = failed_bootstrap_problem("bootstrap/uninstall.sh transform failure", result)
            if problem:
                probe_failures.append(problem)

        with tempfile.TemporaryDirectory(prefix="saipen-uninstall-sh-grep-fail-") as raw:
            home = Path(raw)
            config = home / ".claude" / "CLAUDE.md"
            config.parent.mkdir(parents=True)
            original = b"<!-- SAIPEN:BEGIN -->\nstale\n<!-- SAIPEN:END -->\n"
            config.write_bytes(original)
            aider_config = home / ".aider.conf.yml"
            aider_original = b"# saipen protocol auto-loaded\nread:\n"
            aider_config.write_bytes(aider_original)
            result = subprocess.run(
                [bash, str(HOME / "bootstrap" / "uninstall.sh")],
                cwd=HOME,
                env=grep_failure_env(home),
                capture_output=True,
                text=True,
                errors="replace",
            )
            problem = failed_bootstrap_problem("bootstrap/uninstall.sh grep failure", result)
            if problem:
                probe_failures.append(problem)
            elif config.read_bytes() != original or aider_config.read_bytes() != aider_original:
                probe_failures.append(
                    "bootstrap/uninstall.sh grep failure: config changed after read error"
                )
            else:
                print("PASS: bootstrap/uninstall.sh grep failure -- exits nonzero without Done")

        with tempfile.TemporaryDirectory(prefix="saipen-uninstall-sh-file-") as raw:
            home = Path(raw)
            skill = home / ".claude" / "skills" / "saipen"
            skill.parent.mkdir(parents=True)
            skill.write_text("stale managed path\n", encoding="utf-8")
            result = subprocess.run(
                [bash, str(HOME / "bootstrap" / "uninstall.sh")],
                cwd=HOME,
                env=bash_env(bash, home),
                capture_output=True,
                text=True,
                errors="replace",
            )
            output = result.stdout + result.stderr
            if result.returncode or "Done." not in output or skill.exists():
                probe_failures.append(
                    "bootstrap/uninstall.sh regular-file skill: expected removal "
                    f"and truthful success, got rc={result.returncode} exists={skill.exists()}"
                )
            else:
                print("PASS: bootstrap/uninstall.sh regular-file skill -- removed")

        with tempfile.TemporaryDirectory(prefix="saipen-inject-sh-atomic-") as raw:
            root = Path(raw)
            source = root / "source"
            home = root / "home"
            shutil.copytree(
                HOME,
                source,
                ignore=shutil.ignore_patterns(
                    ".git", ".saipen", ".venv", "__pycache__", "node_modules", "nul"
                ),
            )
            atomic_failures, atomic_checked = run_atomic_copy_failure_probes(
                "bootstrap/inject.sh",
                source,
                home,
                [bash, str(source / "bootstrap" / "inject.sh")],
                bash_env(bash, home),
            )
            probe_failures.extend(atomic_failures)
            checked += atomic_checked
    else:
        print("SKIP: bootstrap/inject.sh executable probe -- no usable bash")
        skipped += 1

    if powershell:
        with tempfile.TemporaryDirectory(prefix="saipen-inject-ps1-") as raw:
            home = Path(raw)
            env = os.environ.copy()
            env["HOME"] = str(home)
            env["USERPROFILE"] = str(home)
            # The injector probe runs uninstall.ps1 against a sandbox HOME,
            # but the scheduled task is machine-global -- the probe must not
            # delete a real scheduler entry (T-531/T-534).
            env["SAIPEN_UNINSTALL_SKIP_TASK"] = "1"
            problem = run_injector_probe(
                "bootstrap/inject.ps1",
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(HOME / "bootstrap" / "inject.ps1"),
                    "-SkillHome",
                    str(HOME / "saipen"),
                ],
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(HOME / "bootstrap" / "uninstall.ps1"),
                ],
                env,
                home,
            )
            if problem:
                probe_failures.append(problem)
            checked += 1

        with tempfile.TemporaryDirectory(prefix="saipen-inject-ps1-fail-") as raw:
            home = Path(raw)
            claude = home / ".claude"
            claude.mkdir(parents=True)
            (claude / "skills").write_text("not a directory\n", encoding="utf-8")
            env = os.environ.copy()
            env["HOME"] = str(home)
            env["USERPROFILE"] = str(home)
            result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(HOME / "bootstrap" / "inject.ps1"),
                    "-SkillHome",
                    str(HOME / "saipen"),
                ],
                cwd=HOME,
                env=env,
                capture_output=True,
                text=True,
                errors="replace",
            )
            problem = failed_bootstrap_problem("bootstrap/inject.ps1 copy failure", result)
            if problem:
                probe_failures.append(problem)

        with tempfile.TemporaryDirectory(prefix="saipen-uninstall-ps1-fail-") as raw:
            home = Path(raw)
            config = home / ".claude" / "CLAUDE.md"
            config.mkdir(parents=True)
            env = os.environ.copy()
            env["HOME"] = str(home)
            env["USERPROFILE"] = str(home)
            result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(HOME / "bootstrap" / "uninstall.ps1"),
                ],
                cwd=HOME,
                env=env,
                capture_output=True,
                text=True,
                errors="replace",
            )
            problem = failed_bootstrap_problem("bootstrap/uninstall.ps1 read failure", result)
            if problem:
                probe_failures.append(problem)

        with tempfile.TemporaryDirectory(prefix="saipen-inject-ps1-atomic-") as raw:
            root = Path(raw)
            source = root / "source"
            home = root / "home"
            shutil.copytree(
                HOME,
                source,
                ignore=shutil.ignore_patterns(
                    ".git", ".saipen", ".venv", "__pycache__", "node_modules", "nul"
                ),
            )
            env = os.environ.copy()
            env["HOME"] = str(home)
            env["USERPROFILE"] = str(home)
            env["SAIPEN_UNINSTALL_SKIP_TASK"] = "1"
            atomic_failures, atomic_checked = run_atomic_copy_failure_probes(
                "bootstrap/inject.ps1",
                source,
                home,
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(source / "bootstrap" / "inject.ps1"),
                    "-SkillHome",
                    str(source / "saipen"),
                ],
                env,
            )
            probe_failures.extend(atomic_failures)
            checked += atomic_checked
    else:
        print("SKIP: bootstrap/inject.ps1 executable probe -- no PowerShell")
        skipped += 1

    # Prove the artifact assertions can go red without depending on injector
    # formatting: model the old delete-after-create result (VERSION copied,
    # tests/ gone) and require the probe to reject it.
    with tempfile.TemporaryDirectory(prefix="saipen-inject-red-") as raw:
        broken = Path(raw)
        (broken / "VERSION").write_text(
            (HOME / "VERSION").read_text(encoding="utf-8-sig"), encoding="utf-8"
        )
        red = installed_layout_problems(broken)
        if not any("tests/validate" in problem for problem in red):
            probe_failures.append("injector red-control: layout with deleted tests/ stayed green")
        else:
            print("PASS: injector probe red-control -- deleted tests/ goes red")

    with tempfile.TemporaryDirectory(prefix="saipen-inject-bytecode-red-") as raw:
        broken = Path(raw)
        generated = broken / "tools" / "__pycache__" / "distributed.pyc"
        generated.parent.mkdir(parents=True)
        generated.write_bytes(b"distributed\n")
        red = installed_layout_problems(broken)
        if not any("generated Python bytecode" in problem for problem in red):
            probe_failures.append("injector red-control: installed generated bytecode stayed green")
        else:
            print("PASS: injector probe red-control -- installed bytecode goes red")

    return probe_failures, checked, skipped


def run_scheduler_probes() -> tuple[list[str], int, int]:
    """Canonical scheduler owns one task lifecycle without dirtying the clone."""
    problems: list[str] = []
    checked = skipped = 0
    schedule = HOME / "bootstrap" / "schedule.ps1"
    schedule_text = schedule.read_text(encoding="utf-8")
    schedule_run = HOME / "bootstrap" / "schedule-run.ps1"
    schedule_run_text = schedule_run.read_text(encoding="utf-8")
    uninstall_ps = (HOME / "bootstrap" / "uninstall.ps1").read_text(encoding="utf-8")
    uninstall_sh = (HOME / "bootstrap" / "uninstall.sh").read_text(encoding="utf-8")

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if ok:
            print(f"PASS: scheduler -- {label}")
        else:
            problems.append(f"scheduler {label}: {detail or 'condition false'}")

    def atomic_wrapper_contract(source: str) -> bool:
        return (
            '$RuntimeDir = Join-Path $env:LOCALAPPDATA "saipen"' in source
            and "[System.Guid]::NewGuid" in source
            and "[System.IO.File]::Move" in source
            and "[System.IO.File]::Replace" in source
            and "[System.Text.Encoding]::Unicode" in source
            and 'Join-Path $PSScriptRoot "schedule-run-hidden.vbs"' not in source
        )

    expect(
        "one manager and no generated repository wrapper",
        not (HOME / "tools" / "schedule_autoinject.py").exists()
        and not (HOME / "bootstrap" / "schedule-run-hidden.vbs").exists(),
        "legacy manager or machine-local wrapper still exists in source tree",
    )
    expect(
        "wrapper publication is atomic and outside the repository",
        atomic_wrapper_contract(schedule_text),
        "external path or atomic temp-and-replace contract missing",
    )
    expect(
        "external-wrapper contract red control",
        not atomic_wrapper_contract(
            schedule_text.replace(
                '$RuntimeDir = Join-Path $env:LOCALAPPDATA "saipen"',
                "$RuntimeDir = $PSScriptRoot",
                1,
            )
        ),
        "repository-local mutation stayed green",
    )
    expect(
        "all removers own current task, legacy task, and runtime wrapper",
        all(
            name in text
            for text in (schedule_text, uninstall_ps, uninstall_sh)
            for name in ("saipen-inject", "saipen-autoinject")
        )
        and all(
            "schedule-run-hidden.vbs" in text
            for text in (schedule_text, uninstall_ps, uninstall_sh)
        )
        and all("scheduled-source" in text for text in (schedule_text, uninstall_ps, uninstall_sh)),
        "a removal path can orphan a shipped task or wrapper",
    )
    expect(
        "background runner never updates the development clone",
        " pull " not in schedule_run_text.lower()
        and '"pull"' not in schedule_run_text.lower()
        and '"merge"' not in schedule_run_text.lower()
        and '"checkout"' not in schedule_run_text.lower()
        and '"reset"' not in schedule_run_text.lower(),
        "background runner still carries a working-tree mutation command",
    )
    expect(
        "background Git disables optional index mutation",
        '$env:GIT_OPTIONAL_LOCKS = "0"' in schedule_run_text,
        "git status may refresh the active development clone index",
    )

    powershell = find_powershell()
    if not powershell:
        print("SKIP: scheduler lifecycle probes -- no PowerShell")
        return problems, checked, skipped + 1
    if os.name != "nt":
        # The lifecycle below drives WINDOWS Task Scheduler: a mocked
        # `schtasks`, a UTF-16 `.vbs` wrapper published under %LOCALAPPDATA%,
        # `wscript.exe` as the task action. PowerShell existing is not the same
        # fact as the host being Windows -- the Linux CI runner ships pwsh, so
        # the old `find_powershell()` guard let these probes run there, the
        # mocked install could not complete, and the very next check read the
        # task file that was never created. That FileNotFoundError aborted the
        # ENTIRE conformance run rather than reporting one soft failure.
        # The platform-independent text contracts above stay armed everywhere.
        print("SKIP: scheduler lifecycle probes -- Windows Task Scheduler host only")
        return problems, checked, skipped + 1

    with tempfile.TemporaryDirectory(prefix="saipen-scheduler-") as raw:
        sandbox = Path(raw)
        state = sandbox / "tasks"
        local_app_data = sandbox / "local-app-data"
        state.mkdir()
        local_app_data.mkdir()
        scheduler_home = sandbox / "unicode-\u043f\u0443\u0442\u044c-\u03a9" / "bootstrap"
        scheduler_home.mkdir(parents=True)
        schedule_under_test = scheduler_home / "schedule.ps1"
        shutil.copy2(schedule, schedule_under_test)
        runner = scheduler_home / "schedule-run.ps1"
        runner.write_text(
            '[System.IO.File]::WriteAllText($env:MOCK_RUNNER_MARKER, "ran")\nexit 37\n',
            encoding="utf-8",
            newline="\n",
        )
        (scheduler_home / "inject.ps1").write_text(
            "# scheduler probe sentinel\n", encoding="utf-8", newline="\n"
        )
        harness = sandbox / "scheduler-harness.ps1"
        harness.write_text(
            r"""param(
  [string]$ScriptPath,
  [string]$CommandName
)
$ErrorActionPreference = "Stop"

function global:Get-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  if ($env:MOCK_QUERY_FAIL -eq $TaskName) {
    Write-Error "mock query failure" -Category ResourceUnavailable
    return $null
  }
  $path = Join-Path $env:MOCK_TASK_STATE $TaskName
  if (Test-Path -LiteralPath $path) {
    $definition = [System.IO.File]::ReadAllText($path)
    $state = if ($definition -match '<Enabled>false</Enabled>') { "Disabled" } else { "Ready" }
    return [pscustomobject]@{ State = $state }
  }
  return $null
}

function global:Get-ScheduledTaskInfo {
  [CmdletBinding()]
  param([string]$TaskName)
  return [pscustomobject]@{
    LastTaskResult = 0
    LastRunTime = "probe-last"
    NextRunTime = "probe-next"
  }
}

function global:Start-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  [System.IO.File]::WriteAllText($env:MOCK_START_MARKER, $TaskName)
}

function global:Export-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName)
  return [System.IO.File]::ReadAllText((Join-Path $env:MOCK_TASK_STATE $TaskName))
}

function global:Register-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [string]$Xml, [switch]$Force)
  [System.IO.File]::WriteAllText((Join-Path $env:MOCK_TASK_STATE $TaskName), $Xml)
  return [pscustomobject]@{ TaskName = $TaskName }
}

function global:New-ScheduledTaskSettingsSet {
  [CmdletBinding()]
  param(
    [switch]$StartWhenAvailable,
    [switch]$AllowStartIfOnBatteries,
    [switch]$DontStopIfGoingOnBatteries,
    [TimeSpan]$ExecutionTimeLimit,
    [string]$MultipleInstances
  )
  return [pscustomobject]@{}
}

function global:Set-ScheduledTask {
  [CmdletBinding()]
  param([string]$TaskName, [object]$Settings)
  if ($env:MOCK_SET_FAIL) { throw "mock settings failure" }
  return [pscustomobject]@{ TaskName = $TaskName }
}

function global:schtasks {
  $operation = [string]$args[0]
  $taskName = ""
  for ($i = 0; $i -lt $args.Count; $i++) {
    if ([string]$args[$i] -ieq "/TN") {
      $taskName = [string]$args[$i + 1]
      break
    }
  }
  $taskPath = Join-Path $env:MOCK_TASK_STATE $taskName
  if ($operation -ieq "/Create") {
    $wrapper = Join-Path $env:LOCALAPPDATA "saipen\schedule-run-hidden.vbs"
    $escapedWrapper = [System.Security.SecurityElement]::Escape($wrapper)
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $definition = @"
<Task>
  <Principals><Principal><UserId>$currentSid</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Triggers><TimeTrigger><Repetition><Interval>PT15M</Interval></Repetition></TimeTrigger></Triggers>
  <Settings>
    <Enabled>true</Enabled>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
  </Settings>
  <Actions><Exec><Command>wscript.exe</Command><Arguments>$escapedWrapper</Arguments></Exec></Actions>
</Task>
"@
    [System.IO.File]::WriteAllText($taskPath, $definition)
    $global:LASTEXITCODE = 0
    return "created $taskName"
  }
  if ($operation -ieq "/Delete") {
    if ($env:MOCK_DELETE_FAIL -eq $taskName) {
      $global:LASTEXITCODE = 5
      return "access denied"
    }
    Remove-Item -LiteralPath $taskPath -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
    return "deleted $taskName"
  }
  $global:LASTEXITCODE = 1
  return "unsupported mock operation"
}

if ($CommandName) { & $ScriptPath $CommandName } else { & $ScriptPath }
if ($LASTEXITCODE) { exit $LASTEXITCODE }
exit 0
""",
            encoding="utf-8",
            newline="\n",
        )

        base_env = os.environ.copy()
        base_env["LOCALAPPDATA"] = str(local_app_data)
        base_env["MOCK_TASK_STATE"] = str(state)
        base_env["MOCK_RUNNER_MARKER"] = str(sandbox / "runner-ran.txt")
        base_env["MOCK_START_MARKER"] = str(sandbox / "task-started.txt")
        base_env["MOCK_SET_FAIL"] = ""
        base_env["MOCK_DELETE_FAIL"] = ""
        base_env["MOCK_QUERY_FAIL"] = ""

        def invoke_script(
            script: Path, command: str = "", **changes: str
        ) -> subprocess.CompletedProcess[str]:
            env = {**base_env, **changes}
            return subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(harness),
                    str(script),
                    command,
                ],
                cwd=HOME,
                env=env,
                capture_output=True,
                text=True,
                errors="replace",
            )

        def invoke(command: str, **changes: str) -> subprocess.CompletedProcess[str]:
            return invoke_script(schedule_under_test, command, **changes)

        def git_status() -> str:
            result = subprocess.run(
                ["git", "status", "--short"],
                cwd=HOME,
                capture_output=True,
                text=True,
                errors="replace",
            )
            if result.returncode != 0:
                problems.append(f"scheduler git status failed: {result.stderr.strip()}")
            return result.stdout

        wrapper = local_app_data / "saipen" / "schedule-run-hidden.vbs"
        runtime_source = local_app_data / "saipen" / "scheduled-source"
        runtime_backup = local_app_data / "saipen" / "scheduled-source-previous-probe"
        runtime_backup_fixed = local_app_data / "saipen" / "scheduled-source-previous"
        runtime_temp_zip = local_app_data / "saipen" / "source-deadbeef0123.zip"
        runtime_temp_dir = local_app_data / "saipen" / "source-deadbeef0123"
        runtime_temp_raw = local_app_data / "saipen" / "inject-deadbeef0123.log"
        runtime_log = local_app_data / "saipen" / "inject.log"
        current = state / "saipen-inject"
        legacy = state / "saipen-autoinject"
        before = git_status()
        not_installed = invoke("status")
        expect(
            "status distinguishes NOT_INSTALLED",
            not_installed.returncode != 0 and "STATUS: NOT_INSTALLED" in not_installed.stdout,
            (not_installed.stdout + not_installed.stderr).strip(),
        )
        invalid = invoke("typo-command")
        expect(
            "unknown command is nonzero with concise usage",
            invalid.returncode != 0 and "usage: schedule.ps1" in invalid.stdout,
            (invalid.stdout + invalid.stderr).strip(),
        )
        legacy.write_text("present", encoding="ascii")
        installed = invoke("install")
        expect(
            "install migrates legacy task and publishes external wrapper",
            installed.returncode == 0
            and current.is_file()
            and not legacy.exists()
            and wrapper.is_file(),
            (installed.stdout + installed.stderr).strip(),
        )
        expect(
            "atomic install leaves no temporary wrapper",
            not list(wrapper.parent.glob(".schedule-run-hidden.vbs.*.tmp")),
            "temporary publication file remains",
        )
        wrapper_bytes = wrapper.read_bytes() if wrapper.is_file() else b""
        expect(
            "wrapper preserves a Unicode runner path",
            wrapper_bytes.startswith(b"\xff\xfe") and str(runner) in wrapper_bytes.decode("utf-16"),
            "wrapper is not UTF-16 with the exact Unicode runner path",
        )
        healthy = invoke("status")
        expect(
            "status distinguishes HEALTHY",
            healthy.returncode == 0 and "STATUS: HEALTHY" in healthy.stdout,
            (healthy.stdout + healthy.stderr).strip(),
        )
        canonical_task_xml = current.read_text(encoding="utf-8")
        current.write_text(
            canonical_task_xml.replace("wscript.exe", r"C:\malware\wscript.exe", 1),
            encoding="utf-8",
        )
        wrong_action = invoke("status")
        expect(
            "wrong scheduled action is DEGRADED",
            wrong_action.returncode != 0
            and "STATUS: DEGRADED" in wrong_action.stdout
            and "task action" in wrong_action.stdout,
            (wrong_action.stdout + wrong_action.stderr).strip(),
        )
        current.write_text(canonical_task_xml, encoding="utf-8")

        quoted_wrapper = canonical_task_xml.replace("<Arguments>", "<Arguments>&quot;", 1).replace(
            "</Arguments>", "&quot;</Arguments>", 1
        )
        current.write_text(quoted_wrapper, encoding="utf-8")
        quoted_action = invoke("status")
        # T-1250: quoting is a HOST detail, not a contract. Windows 10 Pro
        # 19045 stores the quoted form after a correct `install`, so demanding
        # the bare path made the installer produce a state its own status
        # called DEGRADED. One layer of surrounding quotes around the exact
        # canonical path is HEALTHY; the anti-laundering property is asserted
        # by the extra-argument case below, which is the form that actually
        # changes what runs.
        expect(
            "quoted wrapper path is HEALTHY (host quoting is not a contract)",
            quoted_action.returncode == 0 and "STATUS: HEALTHY" in quoted_action.stdout,
            (quoted_action.stdout + quoted_action.stderr).strip(),
        )
        current.write_text(canonical_task_xml, encoding="utf-8")

        smuggled = canonical_task_xml.replace(
            "</Arguments>", " //E:vbscript C:\evil.vbs</Arguments>", 1
        )
        current.write_text(smuggled, encoding="utf-8")
        smuggled_action = invoke("status")
        expect(
            "an extra argument after the wrapper is DEGRADED",
            smuggled_action.returncode != 0
            and "STATUS: DEGRADED" in smuggled_action.stdout
            and "task action" in smuggled_action.stdout,
            (smuggled_action.stdout + smuggled_action.stderr).strip(),
        )
        current.write_text(canonical_task_xml, encoding="utf-8")

        current_sid = re.search(r"<UserId>([^<]+)</UserId>", canonical_task_xml).group(1)
        current.write_text(
            canonical_task_xml.replace(current_sid, "S-1-5-21-0-0-0-9999", 1), encoding="utf-8"
        )
        wrong_principal = invoke("status")
        expect(
            "wrong task principal is DEGRADED",
            wrong_principal.returncode != 0
            and "STATUS: DEGRADED" in wrong_principal.stdout
            and "task principal" in wrong_principal.stdout,
            (wrong_principal.stdout + wrong_principal.stderr).strip(),
        )
        current.write_text(canonical_task_xml, encoding="utf-8")

        current.write_text(
            canonical_task_xml.replace("</Task>", "<Enabled>false</Enabled></Task>", 1),
            encoding="utf-8",
        )
        disabled = invoke("status")
        expect(
            "disabled scheduled task is DEGRADED",
            disabled.returncode != 0
            and "STATUS: DEGRADED" in disabled.stdout
            and "task is disabled" in disabled.stdout,
            (disabled.stdout + disabled.stderr).strip(),
        )
        current.write_text(canonical_task_xml, encoding="utf-8")

        current.write_text(
            canonical_task_xml.replace("TimeTrigger", "BootTrigger"), encoding="utf-8"
        )
        wrong_trigger_type = invoke("status")
        expect(
            "wrong task trigger type is DEGRADED",
            wrong_trigger_type.returncode != 0
            and "STATUS: DEGRADED" in wrong_trigger_type.stdout
            and "task trigger" in wrong_trigger_type.stdout,
            (wrong_trigger_type.stdout + wrong_trigger_type.stderr).strip(),
        )
        current.write_text(canonical_task_xml, encoding="utf-8")

        current.write_text(
            canonical_task_xml.replace(
                "</Repetition>", "<Duration>PT1H</Duration></Repetition>", 1
            ),
            encoding="utf-8",
        )
        finite_duration = invoke("status")
        expect(
            "finite repetition duration is DEGRADED",
            finite_duration.returncode != 0
            and "STATUS: DEGRADED" in finite_duration.stdout
            and "task trigger" in finite_duration.stdout,
            (finite_duration.stdout + finite_duration.stderr).strip(),
        )
        current.write_text(canonical_task_xml, encoding="utf-8")

        current.write_text(
            canonical_task_xml.replace("PT15M", "PT30M", 1).replace("IgnoreNew", "Parallel", 1),
            encoding="utf-8",
        )
        wrong_policy = invoke("status")
        expect(
            "wrong task trigger or runtime policy is DEGRADED",
            wrong_policy.returncode != 0
            and "STATUS: DEGRADED" in wrong_policy.stdout
            and "task trigger" in wrong_policy.stdout
            and "task settings" in wrong_policy.stdout,
            (wrong_policy.stdout + wrong_policy.stderr).strip(),
        )
        current.write_text(canonical_task_xml, encoding="utf-8")
        start_marker = Path(base_env["MOCK_START_MARKER"])
        start_marker.unlink(missing_ok=True)
        run_now = invoke("run-now")
        expect(
            "run-now triggers only a healthy installation",
            run_now.returncode == 0
            and start_marker.is_file()
            and start_marker.read_text(encoding="utf-8") == "saipen-inject",
            (run_now.stdout + run_now.stderr).strip(),
        )
        saved_canonical_wrapper = wrapper.read_bytes()
        wrapper.write_text(f'\' -File ""{runner}""\r\nWScript.Quit 0\r\n', encoding="utf-16")
        start_marker.unlink(missing_ok=True)
        hostile_wrapper = invoke("status")
        hostile_wrapper_run = invoke("run-now")
        expect(
            "wrapper with canonical path hidden in dead text is DEGRADED",
            hostile_wrapper.returncode != 0
            and "STATUS: DEGRADED" in hostile_wrapper.stdout
            and "canonical command body" in hostile_wrapper.stdout,
            (hostile_wrapper.stdout + hostile_wrapper.stderr).strip(),
        )
        expect(
            "run-now refuses a noncanonical wrapper body",
            hostile_wrapper_run.returncode != 0 and not start_marker.exists(),
            (hostile_wrapper_run.stdout + hostile_wrapper_run.stderr).strip(),
        )
        wrapper.write_bytes(saved_canonical_wrapper)
        wscript = shutil.which("wscript.exe") if os.name == "nt" else None
        if wscript:
            marker = Path(base_env["MOCK_RUNNER_MARKER"])
            marker.unlink(missing_ok=True)
            executed = subprocess.run(
                [wscript, str(wrapper)],
                env=base_env,
                capture_output=True,
                text=True,
                errors="replace",
            )
            expect(
                "generated wrapper waits and returns runner status",
                executed.returncode == 37
                and marker.is_file()
                and marker.read_text(encoding="utf-8") == "ran",
                (executed.stdout + executed.stderr).strip(),
            )
        else:
            print("SKIP: scheduler Unicode wrapper execution -- no Windows Script Host")
            skipped += 1

        legacy.write_text("present", encoding="ascii")
        start_marker.unlink(missing_ok=True)
        duplicate = invoke("status")
        duplicate_run = invoke("run-now")
        expect(
            "duplicate current and legacy tasks are DEGRADED",
            duplicate.returncode != 0
            and "STATUS: DEGRADED" in duplicate.stdout
            and "duplicate legacy task" in duplicate.stdout,
            (duplicate.stdout + duplicate.stderr).strip(),
        )
        expect(
            "run-now refuses a DEGRADED duplicate installation",
            duplicate_run.returncode != 0 and not start_marker.exists(),
            (duplicate_run.stdout + duplicate_run.stderr).strip(),
        )
        legacy.unlink()

        saved_wrapper = wrapper.read_bytes()
        wrapper.unlink()
        start_marker.unlink(missing_ok=True)
        missing_wrapper = invoke("status")
        missing_wrapper_run = invoke("run-now")
        expect(
            "missing VBS wrapper is DEGRADED",
            missing_wrapper.returncode != 0
            and "STATUS: DEGRADED" in missing_wrapper.stdout
            and "VBS wrapper missing" in missing_wrapper.stdout,
            (missing_wrapper.stdout + missing_wrapper.stderr).strip(),
        )
        expect(
            "run-now refuses a task with missing wrapper",
            missing_wrapper_run.returncode != 0 and not start_marker.exists(),
            (missing_wrapper_run.stdout + missing_wrapper_run.stderr).strip(),
        )
        wrapper.write_bytes(saved_wrapper)

        runner_missing = runner.with_suffix(".missing")
        runner.rename(runner_missing)
        missing_runner = invoke("status")
        expect(
            "wrapper referencing a missing runner is DEGRADED",
            missing_runner.returncode != 0
            and "STATUS: DEGRADED" in missing_runner.stdout
            and "referenced runner missing" in missing_runner.stdout,
            (missing_runner.stdout + missing_runner.stderr).strip(),
        )
        runner_missing.rename(runner)

        legacy.write_text("present", encoding="ascii")
        runtime_source.mkdir()
        runtime_backup.mkdir()
        runtime_backup_fixed.mkdir()
        runtime_temp_dir.mkdir()
        runtime_temp_zip.write_bytes(b"dead zip")
        runtime_temp_raw.write_text("dead raw", encoding="ascii")
        runtime_log.write_text("canonical log survives", encoding="ascii")
        removed = invoke("remove")
        expect(
            "remove cleans both task names and scheduler runtime",
            removed.returncode == 0
            and not current.exists()
            and not legacy.exists()
            and not wrapper.exists()
            and not runtime_source.exists()
            and not runtime_backup.exists()
            and not runtime_backup_fixed.exists(),
            (removed.stdout + removed.stderr).strip(),
        )
        expect(
            "remove sweeps killed-run temp files but keeps the canonical log",
            not runtime_temp_dir.exists()
            and not runtime_temp_zip.exists()
            and not runtime_temp_raw.exists()
            and runtime_log.read_text(encoding="ascii") == "canonical log survives",
            (removed.stdout + removed.stderr).strip(),
        )
        expect(
            "install and remove leave repository status unchanged",
            git_status() == before,
            "scheduler lifecycle changed working-tree status",
        )
        runtime_log.unlink()

        previous_task = "old-task-xml"
        previous_wrapper = b"previous-wrapper-bytes"
        current.write_text(previous_task, encoding="ascii")
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        wrapper.write_bytes(previous_wrapper)
        upgrade_failed = invoke("install", MOCK_SET_FAIL="1")
        expect(
            "failed reinstall restores previous task and wrapper",
            upgrade_failed.returncode != 0
            and current.read_text(encoding="ascii") == previous_task
            and wrapper.read_bytes() == previous_wrapper,
            (upgrade_failed.stdout + upgrade_failed.stderr).strip(),
        )
        invoke("remove")

        rolled_back = invoke("install", MOCK_SET_FAIL="1")
        expect(
            "fresh settings failure removes new task and wrapper",
            rolled_back.returncode != 0 and not current.exists() and not wrapper.exists(),
            (rolled_back.stdout + rolled_back.stderr).strip(),
        )

        current.write_text("preserve-task", encoding="ascii")
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        wrapper.write_text("preserve-wrapper", encoding="ascii")
        query_failed = invoke("remove", MOCK_QUERY_FAIL="saipen-inject")
        expect(
            "query failure is nonzero and preserves task and wrapper",
            query_failed.returncode != 0
            and current.read_text(encoding="ascii") == "preserve-task"
            and wrapper.read_text(encoding="ascii") == "preserve-wrapper",
            (query_failed.stdout + query_failed.stderr).strip(),
        )
        current.unlink()
        wrapper.unlink()

        current.write_text("present", encoding="ascii")
        wrapper.write_text("preserve", encoding="ascii")
        delete_failed = invoke("remove", MOCK_DELETE_FAIL="saipen-inject")
        expect(
            "delete failure is nonzero and preserves runnable wrapper",
            delete_failed.returncode != 0
            and current.is_file()
            and wrapper.read_text(encoding="ascii") == "preserve",
            (delete_failed.stdout + delete_failed.stderr).strip(),
        )

        current.unlink()
        wrapper.unlink()
        current.write_text("present", encoding="ascii")
        legacy.write_text("present", encoding="ascii")
        wrapper.write_text("present", encoding="ascii")
        runtime_source.mkdir()
        runtime_backup.mkdir()
        runtime_backup_fixed.mkdir()
        runtime_temp_dir.mkdir()
        runtime_temp_zip.write_bytes(b"dead zip")
        runtime_temp_raw.write_text("dead raw", encoding="ascii")
        runtime_log.write_text("canonical log survives", encoding="ascii")
        uninstall_home = sandbox / "powershell-uninstall-home"
        uninstall_home.mkdir()
        ps_uninstalled = invoke_script(
            HOME / "bootstrap" / "uninstall.ps1",
            HOME=str(uninstall_home),
            USERPROFILE=str(uninstall_home),
            SAIPEN_UNINSTALL_SKIP_TASK="",
        )
        expect(
            "PowerShell global uninstall removes both tasks and wrapper",
            ps_uninstalled.returncode == 0
            and not current.exists()
            and not legacy.exists()
            and not wrapper.exists()
            and not runtime_source.exists()
            and not runtime_backup.exists()
            and not runtime_backup_fixed.exists(),
            (ps_uninstalled.stdout + ps_uninstalled.stderr).strip(),
        )
        expect(
            "PowerShell uninstall sweeps killed-run temp files but keeps the canonical log",
            not runtime_temp_dir.exists()
            and not runtime_temp_zip.exists()
            and not runtime_temp_raw.exists()
            and runtime_log.read_text(encoding="ascii") == "canonical log survives",
            (ps_uninstalled.stdout + ps_uninstalled.stderr).strip(),
        )
        runtime_log.unlink()

        current.write_text("preserve", encoding="ascii")
        wrapper.write_text("preserve", encoding="ascii")
        ps_query_failed = invoke_script(
            HOME / "bootstrap" / "uninstall.ps1",
            HOME=str(uninstall_home),
            USERPROFILE=str(uninstall_home),
            SAIPEN_UNINSTALL_SKIP_TASK="",
            MOCK_QUERY_FAIL="saipen-inject",
        )
        expect(
            "PowerShell global uninstall fails closed on query error",
            ps_query_failed.returncode != 0 and current.is_file() and wrapper.is_file(),
            (ps_query_failed.stdout + ps_query_failed.stderr).strip(),
        )
        current.unlink()
        wrapper.unlink()

        fallback_harness = sandbox / "scheduler-fallback-harness.ps1"
        fallback_harness.write_text(
            r"""param([string]$ScriptPath)
$ErrorActionPreference = "Stop"
$env:PSModulePath = ""
Remove-Module ScheduledTasks -Force -ErrorAction SilentlyContinue

function global:Get-Command {
  [CmdletBinding()]
  param([string]$Name)
  if ($Name -eq "Get-ScheduledTask") { return $null }
  if ($Name -eq "schtasks") { return [pscustomobject]@{ Name = "schtasks" } }
  return Microsoft.PowerShell.Core\Get-Command $Name
}

function global:schtasks {
  $operation = [string]$args[0]
  $taskName = ""
  for ($i = 0; $i -lt $args.Count; $i++) {
    if ([string]$args[$i] -ieq "/TN") {
      $taskName = [string]$args[$i + 1]
      break
    }
  }
  if ($env:MOCK_QUERY_FAIL -and $operation -ieq "/Query") {
    $global:LASTEXITCODE = 5
    return "query failed"
  }
  $taskPath = Join-Path $env:MOCK_TASK_STATE $taskName
  if ($operation -ieq "/Query") {
    if (-not $taskName -or (Test-Path -LiteralPath $taskPath)) {
      $global:LASTEXITCODE = 0
    } else {
      $global:LASTEXITCODE = 1
    }
    return "query"
  }
  if ($operation -ieq "/Delete") {
    Remove-Item -LiteralPath $taskPath -Force -ErrorAction SilentlyContinue
    $global:LASTEXITCODE = 0
    return "deleted"
  }
  $global:LASTEXITCODE = 9
}

& $ScriptPath
if ($LASTEXITCODE) { exit $LASTEXITCODE }
exit 0
""",
            encoding="utf-8",
            newline="\n",
        )
        fallback_env = {
            **base_env,
            "HOME": str(uninstall_home),
            "USERPROFILE": str(uninstall_home),
            "PSModulePath": "",
            "SAIPEN_UNINSTALL_SKIP_TASK": "",
        }
        current.write_text("present", encoding="ascii")
        legacy.write_text("present", encoding="ascii")
        wrapper.write_text("present", encoding="ascii")
        runtime_source.mkdir()
        runtime_backup.mkdir()
        runtime_backup_fixed.mkdir()
        runtime_temp_dir.mkdir()
        runtime_temp_zip.write_bytes(b"dead zip")
        runtime_temp_raw.write_text("dead raw", encoding="ascii")
        runtime_log.write_text("canonical log survives", encoding="ascii")
        fallback_uninstalled = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(fallback_harness),
                str(HOME / "bootstrap" / "uninstall.ps1"),
            ],
            cwd=HOME,
            env=fallback_env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        expect(
            "PowerShell uninstall falls back when ScheduledTasks cmdlets are absent",
            fallback_uninstalled.returncode == 0
            and not current.exists()
            and not legacy.exists()
            and not wrapper.exists()
            and not runtime_source.exists()
            and not runtime_backup.exists()
            and not runtime_backup_fixed.exists(),
            (fallback_uninstalled.stdout + fallback_uninstalled.stderr).strip(),
        )
        expect(
            "PowerShell fallback uninstall sweeps temp files, keeps canonical log",
            not runtime_temp_dir.exists()
            and not runtime_temp_zip.exists()
            and not runtime_temp_raw.exists()
            and runtime_log.read_text(encoding="ascii") == "canonical log survives",
            (fallback_uninstalled.stdout + fallback_uninstalled.stderr).strip(),
        )
        runtime_log.unlink()

        current.write_text("preserve", encoding="ascii")
        wrapper.write_text("preserve", encoding="ascii")
        fallback_env["MOCK_QUERY_FAIL"] = "1"
        fallback_query_failed = subprocess.run(
            [
                powershell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(fallback_harness),
                str(HOME / "bootstrap" / "uninstall.ps1"),
            ],
            cwd=HOME,
            env=fallback_env,
            capture_output=True,
            text=True,
            errors="replace",
        )
        expect(
            "PowerShell schtasks fallback fails closed on query error",
            fallback_query_failed.returncode != 0 and current.is_file() and wrapper.is_file(),
            (fallback_query_failed.stdout + fallback_query_failed.stderr).strip(),
        )
        current.unlink(missing_ok=True)
        wrapper.unlink(missing_ok=True)

        bash = find_bash()
        if bash:
            shim_dir = sandbox / "scheduler-shims"
            shim_dir.mkdir()
            schtasks = shim_dir / "schtasks"
            schtasks.write_text(
                r"""#!/usr/bin/env bash
state=${MOCK_TASK_STATE:?}
operation=${1:-}
shift || true
task=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "/TN" ]; then task=${2:-}; shift 2; continue; fi
  shift
done
if [ "$operation" = "/Query" ]; then
  [ -z "${MOCK_QUERY_FAIL:-}" ] || exit 5
  [ -z "$task" ] && exit 0
  [ -f "$state/$task" ] && exit 0
  exit 1
fi
if [ "$operation" = "/Delete" ]; then
  rm -f "$state/$task"
  exit $?
fi
exit 9
""",
                encoding="utf-8",
                newline="\n",
            )
            schtasks.chmod(0o755)
            shell_home = sandbox / "shell-uninstall-home"
            shell_home.mkdir()
            if os.name == "nt":
                path_result = subprocess.run(
                    [bash, "-lc", 'cygpath -u "$1"', "_", str(state)],
                    capture_output=True,
                    text=True,
                    errors="replace",
                )
                shell_state = path_result.stdout.strip()
            else:
                path_result = subprocess.CompletedProcess([], 0, "", "")
                shell_state = str(state)
            shell_env = bash_env(bash, shell_home)
            shell_env["PATH"] = str(shim_dir) + os.pathsep + shell_env["PATH"]
            shell_env["LOCALAPPDATA"] = str(local_app_data)
            shell_env["MOCK_TASK_STATE"] = shell_state
            shell_env["SAIPEN_UNINSTALL_SKIP_TASK"] = ""
            current.write_text("present", encoding="ascii")
            legacy.write_text("present", encoding="ascii")
            wrapper.write_text("present", encoding="ascii")
            runtime_source.mkdir()
            runtime_backup.mkdir()
            runtime_backup_fixed.mkdir()
            runtime_temp_dir.mkdir()
            runtime_temp_zip.write_bytes(b"dead zip")
            runtime_temp_raw.write_text("dead raw", encoding="ascii")
            runtime_log.write_text("canonical log survives", encoding="ascii")
            sh_uninstalled = subprocess.run(
                [bash, str(HOME / "bootstrap" / "uninstall.sh")],
                cwd=HOME,
                env=shell_env,
                capture_output=True,
                text=True,
                errors="replace",
            )
            expect(
                "shell global uninstall removes both tasks and wrapper",
                path_result.returncode == 0
                and sh_uninstalled.returncode == 0
                and not current.exists()
                and not legacy.exists()
                and not wrapper.exists()
                and not runtime_source.exists()
                and not runtime_backup.exists()
                and not runtime_backup_fixed.exists(),
                (sh_uninstalled.stdout + sh_uninstalled.stderr).strip(),
            )
            expect(
                "shell uninstall sweeps killed-run temp files but keeps the canonical log",
                not runtime_temp_dir.exists()
                and not runtime_temp_zip.exists()
                and not runtime_temp_raw.exists()
                and runtime_log.read_text(encoding="ascii") == "canonical log survives",
                (sh_uninstalled.stdout + sh_uninstalled.stderr).strip(),
            )
            runtime_log.unlink()

            current.write_text("preserve", encoding="ascii")
            wrapper.write_text("preserve", encoding="ascii")
            shell_env["MOCK_QUERY_FAIL"] = "1"
            sh_query_failed = subprocess.run(
                [bash, str(HOME / "bootstrap" / "uninstall.sh")],
                cwd=HOME,
                env=shell_env,
                capture_output=True,
                text=True,
                errors="replace",
            )
            expect(
                "shell global uninstall fails closed on query error",
                sh_query_failed.returncode != 0 and current.is_file() and wrapper.is_file(),
                (sh_query_failed.stdout + sh_query_failed.stderr).strip(),
            )
            current.unlink()
            wrapper.unlink()
            runtime_source.mkdir()
            runtime_backup.mkdir()
            runtime_backup_fixed.mkdir()
            runtime_temp_dir.mkdir()
            runtime_temp_zip.write_bytes(b"dead zip")
            runtime_temp_raw.write_text("dead raw", encoding="ascii")
            runtime_log.write_text("canonical log survives", encoding="ascii")
            no_schtasks_env = {
                **shell_env,
                "PATH": "/usr/bin:/bin",
                # Isolate Task Scheduler, not the registry JSON reader.
                "PYTHON_BIN": Path(sys.executable).as_posix(),
                "MOCK_QUERY_FAIL": "",
            }
            shell_without_schtasks = subprocess.run(
                [bash, str(HOME / "bootstrap" / "uninstall.sh")],
                cwd=HOME,
                env=no_schtasks_env,
                capture_output=True,
                text=True,
                errors="replace",
            )
            expect(
                "shell uninstall without schtasks still cleans runtime source",
                shell_without_schtasks.returncode == 0
                and not runtime_source.exists()
                and not runtime_backup.exists()
                and not runtime_backup_fixed.exists(),
                (shell_without_schtasks.stdout + shell_without_schtasks.stderr).strip(),
            )
            expect(
                "shell uninstall without schtasks sweeps temp files, keeps canonical log",
                not runtime_temp_dir.exists()
                and not runtime_temp_zip.exists()
                and not runtime_temp_raw.exists()
                and runtime_log.read_text(encoding="ascii") == "canonical log survives",
                (shell_without_schtasks.stdout + shell_without_schtasks.stderr).strip(),
            )
            runtime_log.unlink()
        else:
            print("SKIP: scheduler shell uninstaller probes -- no usable bash")
            skipped += 1

        # Execute schedule-run.ps1 against a real temporary repository. The
        # injected marker stands in for every installed config, making refusal
        # preservation observable without touching the user's agent homes.
        source_repo = sandbox / "scheduled-source"
        source_bootstrap = source_repo / "bootstrap"
        source_bootstrap.mkdir(parents=True)
        shutil.copy2(schedule_run, source_bootstrap / "schedule-run.ps1")
        (source_repo / "SOURCE_SENTINEL.txt").write_text(
            "committed-source\n", encoding="utf-8", newline="\n"
        )
        # T-1251: the cleanliness guard asks about the INJECTED SURFACE, and
        # saipen/MANIFEST.json is the one owner of that list. The fixture
        # therefore carries a manifest naming its own surface -- without one the
        # runner refuses, which is correct: a source that cannot say what it
        # ships must not ship anything.
        (source_repo / "saipen").mkdir(parents=True, exist_ok=True)
        (source_repo / "saipen" / "MANIFEST.json").write_text(
            json.dumps(
                {
                    "description": "scheduler probe fixture surface",
                    "managed_dirs": ["bootstrap"],
                    "copy_trees": [
                        {"src": "bootstrap", "dst": "bootstrap"},
                        {"src": "tools", "dst": "tools"},
                    ],
                    "files": [{"src": "SOURCE_SENTINEL.txt", "required": True}],
                    "phase_docs": [],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        # T-1252: the injector copies but writes no freshness stamp; the
        # runner calls tools/autoinject.py --stamp-only to do it, so the
        # digest keeps exactly one owner. This stand-in records that the
        # callback happened and with which flag.
        (source_repo / "tools").mkdir(parents=True, exist_ok=True)
        (source_repo / "tools" / "autoinject.py").write_text(
            "import os, sys\n"
            "open(os.environ['MOCK_SCHEDULE_STAMP_PATH'], 'w').write(' '.join(sys.argv[1:]))\n"
            "print('stamped: probe-target')\n",
            encoding="utf-8",
            newline="\n",
        )
        (source_bootstrap / "inject.ps1").write_text(
            r"""
$root = Split-Path $PSScriptRoot -Parent
$value = [System.IO.File]::ReadAllText((Join-Path $root "SOURCE_SENTINEL.txt"))
[System.IO.File]::WriteAllText($env:MOCK_SCHEDULE_DESTINATION, $value)
[System.IO.File]::WriteAllText($env:MOCK_SCHEDULE_SOURCE_PATH, $root)
exit 0
""".lstrip(),
            encoding="utf-8",
            newline="\n",
        )

        def source_git(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["git", *args], cwd=source_repo, capture_output=True, text=True, errors="replace"
            )

        source_git("init", "-q")
        source_git("config", "user.name", "scheduler probe")
        source_git("config", "user.email", "scheduler@example.invalid")
        source_git("add", "-A")
        source_git("commit", "-q", "-m", "probe: committed source")
        source_git("remote", "add", "origin", "https://127.0.0.1:9/unreachable")
        runner_local = sandbox / "runner-local-app-data"
        runner_local.mkdir()
        destination = sandbox / "installed-snapshot.txt"
        source_path_marker = sandbox / "installed-source-path.txt"
        stamp_marker = sandbox / "installed-stamp-call.txt"
        runner_env = {
            **base_env,
            "LOCALAPPDATA": str(runner_local),
            "MOCK_SCHEDULE_DESTINATION": str(destination),
            "MOCK_SCHEDULE_SOURCE_PATH": str(source_path_marker),
            "MOCK_SCHEDULE_STAMP_PATH": str(stamp_marker),
        }

        def invoke_runner(script: Path | None = None) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script or source_bootstrap / "schedule-run.ps1"),
                    "-CloneRoot",
                    str(source_repo),
                ],
                cwd=source_repo,
                env=runner_env,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=60,
            )

        source_head = source_git("rev-parse", "HEAD").stdout.strip()
        source_bytes = (source_repo / "SOURCE_SENTINEL.txt").read_bytes()
        source_index_bytes = (source_repo / ".git" / "index").read_bytes()
        clean_run = invoke_runner()
        expect(
            "clean committed source injects exact HEAD without network access",
            clean_run.returncode == 0
            and destination.is_file()
            and destination.read_text(encoding="utf-8-sig") == source_bytes.decode("utf-8"),
            (clean_run.stdout + clean_run.stderr).strip(),
        )
        published_source = runner_local / "saipen" / "scheduled-source"
        advertised_source = (
            source_path_marker.read_text(encoding="utf-8-sig").strip()
            if source_path_marker.is_file()
            else ""
        )
        expect(
            "successful injection keeps its advertised source path alive",
            source_path_marker.is_file()
            and published_source.is_dir()
            and os.path.normcase(os.path.normpath(advertised_source))
            == os.path.normcase(os.path.normpath(str(published_source)))
            and (published_source / "SOURCE_SENTINEL.txt").read_text(encoding="utf-8-sig")
            == source_bytes.decode("utf-8"),
            f"advertised source missing after cleanup: {advertised_source!r}",
        )
        expect(
            "background run never changes HEAD or working-tree bytes",
            source_git("rev-parse", "HEAD").stdout.strip() == source_head
            and not source_git("status", "--short").stdout
            and (source_repo / "SOURCE_SENTINEL.txt").read_bytes() == source_bytes
            and (source_repo / ".git" / "index").read_bytes() == source_index_bytes,
            "clean run moved HEAD, index, or source bytes",
        )
        # T-1255: the callback also hands over the head the runner proved,
        # because the published snapshot is a git archive extraction with no
        # repository for the stamper to ask. Asserting the exact HEAD rather
        # than merely "some head" is what makes a wrong or stale revision
        # visible instead of merely present.
        _stamp_args = (
            stamp_marker.read_text(encoding="utf-8").split() if stamp_marker.is_file() else []
        )
        expect(
            "a successful inject writes the freshness stamp through its one owner",
            "--stamp-only" in _stamp_args
            and "--source-head" in _stamp_args
            and _stamp_args[_stamp_args.index("--source-head") + 1] == source_head,
            "stamp callback did not run: "
            + (stamp_marker.read_text(encoding="utf-8") if stamp_marker.is_file() else "absent"),
        )

        destination.write_text("previous-install\n", encoding="utf-8", newline="\n")
        (source_repo / "SOURCE_SENTINEL.txt").write_text(
            "half-edited\n", encoding="utf-8", newline="\n"
        )
        dirty_tracked = invoke_runner()
        runner_log = runner_local / "saipen" / "inject.log"
        expect(
            "dirty tracked source skips and preserves installed snapshot",
            dirty_tracked.returncode != 0
            and destination.read_text(encoding="utf-8") == "previous-install\n"
            and "SKIP: DIRTY_SOURCE" in runner_log.read_text(encoding="utf-8-sig"),
            (dirty_tracked.stdout + dirty_tracked.stderr).strip(),
        )
        (source_repo / "SOURCE_SENTINEL.txt").write_bytes(source_bytes)

        # T-1251: an untracked file OUTSIDE the injected surface is ordinary
        # project life -- caches, kitchens, the user's own notes -- and must not
        # stop the refresh. Rejecting it made the scheduled task a permanent
        # no-op on every real working tree.
        untracked = source_repo / "UNTRACKED_PROJECT_FILE.txt"
        untracked.write_text("not committed\n", encoding="utf-8", newline="\n")
        dirty_untracked = invoke_runner()
        expect(
            "untracked file outside the injected surface does not block the refresh",
            dirty_untracked.returncode == 0
            and destination.read_text(encoding="utf-8") == "committed-source\n",
            (dirty_untracked.stdout + dirty_untracked.stderr).strip(),
        )
        untracked.unlink()

        # ... while an untracked file INSIDE the surface still blocks: it would
        # be copied into every consumer home without ever having been reviewed.
        destination.write_text("previous-install\n", encoding="utf-8", newline="\n")
        surface_untracked = source_repo / "bootstrap" / "UNREVIEWED.ps1"
        surface_untracked.write_text("exit 0\n", encoding="utf-8", newline="\n")
        dirty_surface = invoke_runner()
        expect(
            "untracked file inside the injected surface still skips",
            dirty_surface.returncode != 0
            and destination.read_text(encoding="utf-8") == "previous-install\n"
            and "SKIP: DIRTY_SOURCE" in runner_log.read_text(encoding="utf-8-sig"),
            (dirty_surface.stdout + dirty_surface.stderr).strip(),
        )
        surface_untracked.unlink()

        # A source that cannot say what it ships must not ship anything.
        manifest_path = source_repo / "saipen" / "MANIFEST.json"
        manifest_bytes = manifest_path.read_bytes()
        manifest_path.unlink()
        no_manifest = invoke_runner()
        expect(
            "a source with no manifest refuses instead of guessing its surface",
            no_manifest.returncode != 0
            and destination.read_text(encoding="utf-8") == "previous-install\n",
            (no_manifest.stdout + no_manifest.stderr).strip(),
        )
        manifest_path.write_bytes(manifest_bytes)
        source_git("add", "-A")
        source_git("commit", "-q", "-m", "probe: restore manifest")

        git_dir = source_repo / ".git"
        hidden_git = source_repo / ".git-hidden"
        git_dir.rename(hidden_git)
        source_failure = invoke_runner()
        hidden_git.rename(git_dir)
        expect(
            "source operation failure never falls through into injection",
            source_failure.returncode != 0
            and destination.read_text(encoding="utf-8") == "previous-install\n",
            (source_failure.stdout + source_failure.stderr).strip(),
        )

        race_runner = sandbox / "schedule-run-race.ps1"
        race_anchor = "  Expand-Archive -LiteralPath $archive -DestinationPath $snapshot -Force\n"
        race_body = schedule_run_text.replace(
            race_anchor,
            race_anchor + "  [System.IO.File]::AppendAllText((Join-Path $sourceRoot "
            '"SOURCE_SENTINEL.txt"), "race-edit")\n',
            1,
        )
        race_runner.write_text(race_body, encoding="utf-8", newline="\n")
        source_race = invoke_runner(race_runner)
        expect(
            "source change during preflight refuses mixed-source injection",
            source_race.returncode != 0
            and destination.read_text(encoding="utf-8") == "previous-install\n"
            and "SKIP: DIRTY_SOURCE" in runner_log.read_text(encoding="utf-8-sig"),
            (source_race.stdout + source_race.stderr).strip(),
        )
        (source_repo / "SOURCE_SENTINEL.txt").write_bytes(source_bytes)
        expect(
            "every refusal preserves previous installed snapshot and HEAD",
            destination.read_text(encoding="utf-8") == "previous-install\n"
            and source_git("rev-parse", "HEAD").stdout.strip() == source_head
            and published_source.is_dir()
            and (published_source / "SOURCE_SENTINEL.txt").read_text(encoding="utf-8-sig")
            == source_bytes.decode("utf-8"),
            "a refusal changed installed bytes or HEAD",
        )

        stale_backup = runner_local / "saipen" / "scheduled-source-previous"
        stale_backup.mkdir(parents=True)
        stale_backup_run = invoke_runner()
        expect(
            "stale snapshot backup from a killed run is refused",
            stale_backup_run.returncode != 0
            and "REFUSE: PUBLISHED_SOURCE_BACKUP_EXISTS"
            in runner_log.read_text(encoding="utf-8-sig")
            and destination.read_text(encoding="utf-8") == "previous-install\n",
            (stale_backup_run.stdout + stale_backup_run.stderr).strip(),
        )
        stale_backup.rmdir()

        (source_repo / "SOURCE_SENTINEL.txt").write_text(
            "new-committed-source\n", encoding="utf-8", newline="\n"
        )
        (source_bootstrap / "inject.ps1").write_text("exit 9\n", encoding="utf-8", newline="\n")
        source_git("add", "-A")
        source_git("commit", "-q", "-m", "probe: failing injector update")
        failed_update = invoke_runner()
        expect(
            "failed injector restores previous persistent source snapshot",
            failed_update.returncode != 0
            and published_source.is_dir()
            and (published_source / "SOURCE_SENTINEL.txt").read_text(encoding="utf-8-sig")
            == source_bytes.decode("utf-8")
            and destination.read_text(encoding="utf-8") == "previous-install\n",
            (failed_update.stdout + failed_update.stderr).strip(),
        )

    return problems, checked, skipped


def run_project_root_probes() -> tuple[list[str], int]:
    problems = []
    checked = 0
    git = shutil.which("git")
    if not git:
        return ["project-root probes require git"], checked

    def git_run(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([git, *args], cwd=cwd, capture_output=True, text=True)

    def validate(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(VALIDATOR), *args], cwd=cwd, capture_output=True, text=True
        )

    def expect(
        label: str, result: subprocess.CompletedProcess[str], returncode: int, contains: str
    ) -> None:
        nonlocal checked
        checked += 1
        output = result.stdout + result.stderr
        if result.returncode != returncode or contains not in output:
            problems.append(
                f"{label}: exit {result.returncode}, expected {returncode}; "
                f"missing output {contains!r}"
            )
        else:
            print(f"PASS: project root -- {label}")

    with tempfile.TemporaryDirectory(prefix="saipen-root-") as raw:
        sandbox = Path(raw).resolve()
        project = sandbox / "project"
        project.mkdir()
        shutil.copytree(SCENARIOS / "resume-after-crash" / ".saipen", project / ".saipen")
        (project / ".gitignore").write_text(".saipen/\n", encoding="utf-8")
        (project / "tracked.txt").write_text("root probe\n", encoding="utf-8")

        setup = [
            ("init",),
            ("config", "user.name", "SAIPEN root probe"),
            ("config", "user.email", "root-probe@example.invalid"),
            ("add", ".gitignore", "tracked.txt"),
            ("commit", "-m", "root probe"),
        ]
        for command in setup:
            result = git_run(project, *command)
            if result.returncode != 0:
                return [
                    f"project-root git setup failed at {command}: "
                    f"{(result.stderr or result.stdout).strip()}"
                ], checked

        project_text = str(project)
        expect("correct root", validate(project), 0, f"Project root: {project_text} (git-worktree)")

        nested = project / "one" / "two"
        nested.mkdir(parents=True)
        expect("nested cwd", validate(nested), 0, f"Project root: {project_text} (git-worktree)")
        if (nested / ".saipen").exists() or (nested.parent / ".saipen").exists():
            problems.append("nested cwd created a second .saipen/")

        foreign = sandbox / "foreign"
        foreign.mkdir()
        init_foreign = git_run(foreign, "init")
        if init_foreign.returncode != 0:
            return [
                "foreign repository setup failed: "
                + (init_foreign.stderr or init_foreign.stdout).strip()
            ], checked
        wrong = validate(foreign)
        expect("wrong cwd rejected", wrong, 1, "refusing to guess or create a second .saipen/")
        if (foreign / ".saipen").exists():
            problems.append("wrong cwd created .saipen/")

        expect(
            "explicit root overrides cwd",
            validate(foreign, "--project-root", project_text),
            0,
            f"Project root: {project_text} (explicit)",
        )
        if (foreign / ".saipen").exists():
            problems.append("explicit-root invocation created .saipen/ in cwd")

        plain = sandbox / "plain-project"
        plain_nested = plain / "deep" / "cwd"
        plain_nested.mkdir(parents=True)
        shutil.copytree(SCENARIOS / "resume-after-crash" / ".saipen", plain / ".saipen")
        expect("non-Git nested cwd", validate(plain_nested), 0, f"Project root: {plain} (ancestor)")
        if (plain_nested / ".saipen").exists() or (plain / "deep" / ".saipen").exists():
            problems.append("non-Git nested cwd created a second .saipen/")

        linked = sandbox / "linked"
        add_worktree = git_run(project, "worktree", "add", "--detach", str(linked))
        if add_worktree.returncode != 0:
            return [
                "linked worktree setup failed: "
                + (add_worktree.stderr or add_worktree.stdout).strip()
            ], checked
        expect(
            "linked worktree uses main owner",
            validate(linked),
            0,
            f"Project root: {project_text} (git-common)",
        )
        if (linked / ".saipen").exists():
            problems.append("linked worktree created a second .saipen/")

        # The other half: a linked worktree that DOES carry its own `.saipen/`
        # must be validated as itself. Asking the main worktree first meant a
        # local `phase: NOT-A-PHASE` validated EXIT=0 against a different
        # tree -- green for a tree nobody edited.
        own = linked / ".saipen"
        own.mkdir()
        for name in ("STATE.md", "BOARD.md", "LOG.md"):
            shutil.copy2(project / ".saipen" / name, own / name)
        state_path = own / "STATE.md"
        state_path.write_text(
            re.sub(
                r"^phase:.*$",
                "phase: NOT-A-PHASE",
                state_path.read_text(encoding="utf-8-sig"),
                count=1,
                flags=re.MULTILINE,
            ),
            encoding="utf-8",
            newline="\n",
        )
        local = validate(linked)
        checked += 1
        local_text = local.stdout + local.stderr
        if local.returncode == 0 or "NOT-A-PHASE" not in local_text:
            problems.append(
                "linked worktree with its own .saipen/ did not validate itself: "
                f"exit {local.returncode} :: {local_text.strip()[:300]}"
            )
        elif f"Project root: {linked}" not in local_text:
            problems.append("linked worktree failure did not name the linked root")
        else:
            print(
                "PASS: project root -- linked worktree with its own .saipen/ is validated as itself"
            )

    return problems, checked


def run_export_probes() -> tuple[list[str], int, int]:
    """Execute both exporters across the Core project-root ownership paths."""
    problems = []
    checked = skipped = 0
    git = shutil.which("git")
    bash = find_bash()
    powershell = find_powershell()
    if not git:
        return ["export probes require git"], checked, skipped

    def git_run(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [git, *args], cwd=cwd, capture_output=True, text=True, errors="replace"
        )

    def bash_path(path: Path) -> str:
        if os.name != "nt" or not bash:
            return str(path)
        converted = subprocess.run(
            [bash, "-lc", 'cygpath -u "$1"', "saipen-export", str(path)],
            capture_output=True,
            text=True,
            errors="replace",
        )
        return converted.stdout.strip() if converted.returncode == 0 else str(path)

    def archive_marker(archive: Path) -> bytes | None:
        if archive.suffix == ".zip":
            with zipfile.ZipFile(archive) as bundle:
                name = next(
                    (
                        n
                        for n in bundle.namelist()
                        if n.replace("\\", "/").endswith(".saipen/marker.txt")
                    ),
                    None,
                )
                return bundle.read(name) if name else None
        with tarfile.open(archive, "r:gz") as bundle:
            member = next(
                (
                    m
                    for m in bundle.getmembers()
                    if m.name.replace("\\", "/").endswith(".saipen/marker.txt")
                ),
                None,
            )
            if member is None:
                return None
            stream = bundle.extractfile(member)
            return stream.read() if stream else None

    with tempfile.TemporaryDirectory(prefix="saipen-export-") as raw:
        sandbox = Path(raw).resolve()
        project = sandbox / "project"
        project.mkdir()
        (project / ".saipen").mkdir()
        marker = b"owner-project\n"
        (project / ".saipen" / "marker.txt").write_bytes(marker)
        (project / "tracked.txt").write_text("export probe\n", encoding="utf-8")
        for command in (
            ("init", "-q"),
            ("config", "user.name", "SAIPEN export probe"),
            ("config", "user.email", "export-probe@example.invalid"),
            ("add", "tracked.txt"),
            ("commit", "-q", "-m", "export probe"),
        ):
            result = git_run(project, *command)
            if result.returncode:
                return (
                    [
                        f"export Git setup failed at {command}: "
                        f"{(result.stderr or result.stdout).strip()}"
                    ],
                    checked,
                    skipped,
                )

        nested = project / "nested" / "cwd"
        nested.mkdir(parents=True)
        foreign = sandbox / "foreign"
        foreign.mkdir()
        if git_run(foreign, "init", "-q").returncode:
            return ["export foreign Git setup failed"], checked, skipped
        linked = sandbox / "linked"
        worktree = git_run(project, "worktree", "add", "--detach", str(linked))
        if worktree.returncode:
            return (
                [
                    "export linked-worktree setup failed: "
                    + (worktree.stderr or worktree.stdout).strip()
                ],
                checked,
                skipped,
            )

        external_parent = sandbox / "git-store"
        external_parent.mkdir()
        (external_parent / ".saipen").mkdir()
        (external_parent / ".saipen" / "marker.txt").write_bytes(b"wrong-external-owner\n")
        separate = sandbox / "separate"
        separate_git = git_run(
            sandbox,
            "init",
            "-q",
            "--separate-git-dir",
            str(external_parent / "repository.git"),
            str(separate),
        )
        if separate_git.returncode:
            return (
                [
                    "export separate-git-dir setup failed: "
                    + (separate_git.stderr or separate_git.stdout).strip()
                ],
                checked,
                skipped,
            )

        shell_home = sandbox / "shell-home"
        shell_home.mkdir()
        shell_environment = bash_env(bash, shell_home) if bash else None

        tools: list[tuple[str, list[str], str]] = []
        if bash:
            tools.append(
                ("export.sh", [bash, str(HOME / "bootstrap" / "export.sh")], "--project-root")
            )
        else:
            print("SKIP: bootstrap/export.sh probes -- no usable bash")
            skipped += 6
        if powershell:
            tools.append(
                (
                    "export.ps1",
                    [
                        powershell,
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        str(HOME / "bootstrap" / "export.ps1"),
                    ],
                    "-ProjectRoot",
                )
            )
        else:
            print("SKIP: bootstrap/export.ps1 probes -- no PowerShell")
            skipped += 6

        cases = (
            ("nested cwd", nested, None, True, None),
            ("foreign cwd rejected", foreign, None, False, "owns no .saipen"),
            ("explicit root overrides cwd", foreign, project, True, None),
            ("empty explicit root rejected", foreign, "", False, "requires a non-empty path"),
            ("linked worktree uses main owner", linked, None, True, None),
            ("external git-dir parent rejected", separate, None, False, "owns no .saipen"),
        )
        nonowner_roots = (foreign, nested, linked, external_parent, separate)
        for tool_name, base_command, explicit_flag in tools:
            for label, cwd, explicit, succeeds, failure_text in cases:
                for old in project.glob("saipen_export_*"):
                    old.unlink()
                for root in nonowner_roots:
                    for old in root.glob("saipen_export_*"):
                        old.unlink()
                command = list(base_command)
                if explicit is not None:
                    root_arg = (
                        bash_path(explicit)
                        if tool_name.endswith(".sh") and explicit
                        else str(explicit)
                    )
                    command.extend((explicit_flag, root_arg))
                result = subprocess.run(
                    command,
                    cwd=cwd,
                    capture_output=True,
                    text=True,
                    errors="replace",
                    env=shell_environment if tool_name.endswith(".sh") else None,
                )
                checked += 1
                output = result.stdout + result.stderr
                archives = list(project.glob("saipen_export_*"))
                wrong = [
                    archive for root in nonowner_roots for archive in root.glob("saipen_export_*")
                ]
                if not succeeds:
                    if (
                        result.returncode == 0
                        or "Done." in output
                        or archives
                        or wrong
                        or failure_text not in output
                    ):
                        problems.append(
                            f"{tool_name} {label}: expected focused failure containing "
                            f"{failure_text!r} with no archive"
                        )
                    else:
                        print(f"PASS: {tool_name} -- {label}")
                    continue
                if result.returncode or "Done. Export saved to:" not in output:
                    detail = next(
                        (
                            line
                            for line in output.splitlines()
                            if line.startswith(("FAILED", "tar:"))
                        ),
                        output.strip()[:160] or "no output",
                    )
                    problems.append(
                        f"{tool_name} {label}: exit {result.returncode} without "
                        f"success path: {detail}"
                    )
                    continue
                if len(archives) != 1 or wrong:
                    problems.append(
                        f"{tool_name} {label}: expected one owner archive, got "
                        f"owner={len(archives)} wrong={len(wrong)}"
                    )
                    continue
                try:
                    archived_marker = archive_marker(archives[0])
                except (OSError, tarfile.TarError, zipfile.BadZipFile) as exc:
                    problems.append(f"{tool_name} {label}: unreadable archive: {exc}")
                    continue
                if archived_marker != marker:
                    problems.append(f"{tool_name} {label}: archive has wrong owner marker")
                else:
                    print(f"PASS: {tool_name} -- {label}")
                archives[0].unlink(missing_ok=True)

    return problems, checked, skipped


def run_crew_probes() -> tuple[list[str], int, int]:
    """Execute both crew launchers against controlled start processes."""
    bash = find_bash()
    problems = []
    checked = 0
    skipped = 0
    if not bash:
        print("SKIP: bootstrap/saipen_crew.sh probes -- no usable bash")
        skipped += 2
    else:
        with tempfile.TemporaryDirectory(prefix="saipen-crew-") as raw:
            sandbox = Path(raw)
            shim_dir = sandbox / "bin"
            shim_dir.mkdir()
            probe_log = sandbox / "launcher.log"
            converted = subprocess.run(
                [
                    bash,
                    "-lc",
                    'cygpath -u "$1" 2>/dev/null || printf "%s" "$1"',
                    "saipen-crew",
                    str(probe_log),
                ],
                capture_output=True,
                text=True,
                errors="replace",
            )
            log_path = converted.stdout.strip() if converted.returncode == 0 else str(probe_log)
            launcher_source = (
                "#!/usr/bin/env sh\n"
                'printf "%s\\n" "$*" >> "$SAIPEN_CREW_PROBE_LOG"\n'
                'exit "$SAIPEN_CREW_PROBE_EXIT"\n'
            )
            for name in ("gnome-terminal", "konsole", "xterm"):
                launcher = shim_dir / name
                launcher.write_text(launcher_source, encoding="utf-8", newline="\n")
                launcher.chmod(0o755)

            env = bash_env(bash, sandbox)
            env["PATH"] = str(shim_dir) + os.pathsep + env.get("PATH", "")
            env["SAIPEN_CREW_LAUNCH_GRACE"] = "0.05"
            env["SAIPEN_CREW_PROBE_LOG"] = log_path
            command = [bash, str(HOME / "bootstrap" / "saipen_crew.sh")]

            env["SAIPEN_CREW_PROBE_EXIT"] = "9"
            failed = subprocess.run(
                command, cwd=HOME, env=env, capture_output=True, text=True, errors="replace"
            )
            checked += 1
            failed_output = failed.stdout + failed.stderr
            failed_calls = (
                probe_log.read_text(encoding="utf-8").splitlines() if probe_log.is_file() else []
            )
            if (
                failed.returncode == 0
                or "Done." in failed_output
                or "FAILED:" not in failed_output
                or len(failed_calls) != 9
            ):
                problems.append(
                    "bootstrap/saipen_crew.sh broken launcher: expected nine "
                    "failed fallback calls, focused nonzero, and no Done; got "
                    f"{len(failed_calls)}"
                )
            else:
                print(
                    "PASS: bootstrap/saipen_crew.sh broken launcher -- exits nonzero without Done"
                )

            probe_log.unlink(missing_ok=True)
            env["SAIPEN_CREW_PROBE_EXIT"] = "0"
            succeeded = subprocess.run(
                command, cwd=HOME, env=env, capture_output=True, text=True, errors="replace"
            )
            checked += 1
            succeeded_output = succeeded.stdout + succeeded.stderr
            calls = (
                probe_log.read_text(encoding="utf-8").splitlines() if probe_log.is_file() else []
            )
            if (
                succeeded.returncode != 0
                or "Done. Launched 3 crew windows." not in succeeded_output
                or len(calls) != 3
            ):
                problems.append(
                    "bootstrap/saipen_crew.sh working launcher: expected three "
                    "accepted calls and truthful Done, got "
                    f"rc={succeeded.returncode} calls={len(calls)}"
                )
            else:
                print("PASS: bootstrap/saipen_crew.sh working launcher -- three accepted calls")

    cmd = os.environ.get("COMSPEC") or shutil.which("cmd")
    if not cmd:
        print("SKIP: bootstrap/saipen_crew.bat probes -- no cmd.exe")
        skipped += 4
    else:
        with tempfile.TemporaryDirectory(prefix="saipen-crew-bat-") as raw:
            sandbox = Path(raw)
            probe_log = sandbox / "launcher.log"
            launcher = sandbox / "start-probe.cmd"
            launcher.write_text(
                "@echo off\n"
                '>>"%SAIPEN_CREW_PROBE_LOG%" echo call\n'
                'if "%SAIPEN_CREW_LAUNCH_INDEX%"=="%SAIPEN_CREW_FAIL_AT%" exit /b 9\n'
                "exit /b 0\n",
                encoding="utf-8",
                newline="\r\n",
            )
            env = os.environ.copy()
            env["SAIPEN_CREW_START_COMMAND"] = str(launcher)
            env["SAIPEN_CREW_PROBE_LOG"] = str(probe_log)
            command = [cmd, "/d", "/c", str(HOME / "bootstrap" / "saipen_crew.bat")]

            for fail_at in (1, 2, 3):
                probe_log.unlink(missing_ok=True)
                env["SAIPEN_CREW_FAIL_AT"] = str(fail_at)
                failed = subprocess.run(
                    command, cwd=HOME, env=env, capture_output=True, text=True, errors="replace"
                )
                checked += 1
                output = failed.stdout + failed.stderr
                calls = (
                    probe_log.read_text(encoding="utf-8").splitlines()
                    if probe_log.is_file()
                    else []
                )
                if (
                    failed.returncode == 0
                    or "Three crew windows opened." in output
                    or "FAILED:" not in output
                    or len(calls) != fail_at
                ):
                    problems.append(
                        f"bootstrap/saipen_crew.bat failed start {fail_at}: "
                        "expected focused nonzero and no success after "
                        f"{fail_at} calls; got rc={failed.returncode} calls={len(calls)}"
                    )
                else:
                    print(
                        f"PASS: bootstrap/saipen_crew.bat failed start {fail_at} "
                        "-- exits nonzero without success"
                    )

            probe_log.unlink(missing_ok=True)
            env["SAIPEN_CREW_FAIL_AT"] = "0"
            succeeded = subprocess.run(
                command, cwd=HOME, env=env, capture_output=True, text=True, errors="replace"
            )
            checked += 1
            output = succeeded.stdout + succeeded.stderr
            calls = (
                probe_log.read_text(encoding="utf-8").splitlines() if probe_log.is_file() else []
            )
            if (
                succeeded.returncode != 0
                or output.count("Three crew windows opened.") != 1
                or len(calls) != 3
            ):
                problems.append(
                    "bootstrap/saipen_crew.bat working start: expected three "
                    "accepted calls and one truthful success, got "
                    f"rc={succeeded.returncode} calls={len(calls)}"
                )
            else:
                print("PASS: bootstrap/saipen_crew.bat working start -- three accepted calls")

    return problems, checked, skipped


def run_saicrew_probes() -> tuple[list[str], int]:
    """SAICREW hostile controls: strict MANIFEST, dry-run byte-identity,
    sync repair/idempotency, local-charter role authority, sub-board
    coherence, truthful status, collect refusal, crew fixed-point blocking.

    Every probe runs in a fresh temp project whose `.saipen/extensions/subs/`
    is seeded from a minimal fake saipen_home, so a broken engine can never
    hide behind this repository's already-corrected live state.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if ok:
            print(f"PASS: saicrew -- {label}")
        else:
            problems.append(f"{label}: {detail}")
            print(f"FAIL: saicrew -- {label} -- {detail}")

    from saipen_engine.subs import (
        parse_manifest,
        parse_outbox,
        parse_sub_board,
        sub_adopt,
        sub_clean,
        sub_collect,
        sub_disposition,
        sub_list,
        sub_pause,
        sub_resume,
        sub_spawn,
        sub_sync,
        package_identity,
        shared_contract_status,
        sub_instance_health,
        current_local_role_revision,
        role_freshness,
        SUBS_REL,
        MANIFEST_REL,
        HEALTH_CURRENT,
        HEALTH_BLOCKED,
        HEALTH_NOT_RUN,
        HEALTH_INVALID,
        HEALTH_READY_FOR_REVIEW,
        HEALTH_REVIEW_PENDING,
    )

    try:
        from saipen_engine.crew import (
            crew_gate_problems,
            crew_plan,
            crew_ready_to_finalize,
            finalize_crew,
        )
    except ImportError as exc:
        return [f"saicrew import failed: {exc}"], checked

    def tree_snapshot(root: Path) -> str:
        """A deterministic hash of every file under root (byte-identity)."""
        import hashlib

        h = hashlib.sha256()
        for path in sorted(p for p in root.rglob("*") if p.is_file()):
            rel = path.relative_to(root).as_posix()
            h.update(rel.encode("utf-8"))
            h.update(path.read_bytes())
        return h.hexdigest()

    with tempfile.TemporaryDirectory(prefix="saipen-saicrew-") as raw:
        home = Path(raw) / "home"
        (home / "saipen").mkdir(parents=True)
        (home / "saipen" / "BOOT.md").write_text("# probe installed protocol\n", encoding="utf-8")
        (home / "extensions" / "subs" / "TEMPLATE" / "kitchen").mkdir(parents=True)
        (home / "extensions" / "subs" / "_shared").mkdir(parents=True)
        charter = (
            "# {name} -- role\n\n```yaml\n"
            'role_kind: {role_kind}\nwrite_scope: ".saipen/extensions/subs/'
            '{name}/"\ntrigger: "probe"\ncollect_policy: {collect_policy}\n'
            'done_condition: "probe"\nfreshness_inputs: ["source_head", '
            '"source_tree_fingerprint", "role_revision"]\n'
            'output_contract: "PROTOCOL.md \u00a7 2 complete package"\n'
            'role_revision: "sha256:probe-{name}"\n```\n'
        )
        for name in ("saihunt", "saitest", "saipython", "saiui", "saitranslate", "saiwiki"):
            producer = name in ("saitranslate", "saiwiki")
            (home / "extensions" / "subs" / f"{name}.md").write_text(
                charter.format(
                    name=name,
                    role_kind="PRODUCER" if producer else "SCOUT",
                    collect_policy="explicit" if producer else "core-review",
                ),
                encoding="utf-8",
            )
        for shared in ("PROTOCOL.md", "README.md", "crew.md"):
            (home / "extensions" / "subs" / shared).write_text(
                f"# {shared}\nprobe shared content\n", encoding="utf-8"
            )
        (home / "extensions" / "subs" / "TEMPLATE" / "STATE.md").write_text(
            '---\nphase: PLAN\ntask: none\nnext_action: "saipen plan"\n'
            "blocker: none\nagent: <name>\nsaipen_version: 7\n"
            "schema_version: 3\nstyle_contract: ded-probe\n"
            'saipen_home: ""\nmode: read-only\ntransition_from: INIT\n'
            "updated: 2026-01-01T00:00:00Z\n---\n",
            encoding="utf-8",
        )
        (home / "extensions" / "subs" / "TEMPLATE" / "BOARD.md").write_text(
            "# Board\n\n## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n", encoding="utf-8"
        )
        (home / "extensions" / "subs" / "TEMPLATE" / "LOG.md").write_text(
            "# Log\n", encoding="utf-8"
        )
        (home / "extensions" / "subs" / "TEMPLATE" / "kitchen" / "OUTBOX.md").write_text(
            "# OUTBOX\n", encoding="utf-8"
        )
        (home / "extensions" / "subs" / "_shared" / "inbox.md").write_text(
            "# shared inbox\n\n- seed entry\n", encoding="utf-8"
        )

        def refresh_charter_revisions() -> None:
            for path in (home / "extensions" / "subs").glob("sai*.md"):
                text = path.read_text(encoding="utf-8")
                path.write_text(
                    text.replace(
                        re.search(r'role_revision: "[^"]+"', text).group(0),
                        f'role_revision: "{compute_role_revision(path)}"',
                    ),
                    encoding="utf-8",
                )

        refresh_charter_revisions()

        def seed_project(proj: Path) -> None:
            (proj / ".saipen").mkdir(parents=True, exist_ok=True)
            (proj / ".saipen" / "STATE.md").write_text(
                '---\nphase: DONE\ntask: none\nnext_action: "saipen '
                'continue"\nblocker: ""\ntransition_from: SHIP\n'
                "saipen_version: 7\nschema_version: 3\nstyle_contract: "
                'ded-probe\nsaipen_home: "'
                + home.as_posix()
                + '"\nagent: probe\nmode: full\nupdated: '
                '"2026-08-13T00:00:00Z"\n---\n',
                encoding="utf-8",
            )
            (proj / ".saipen" / "LOG.md").write_text("# Log\n", encoding="utf-8")
            (proj / ".saipen" / "BOARD.md").write_text(
                "# Board\n\n## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n", encoding="utf-8"
            )
            (proj / ".saipen" / "extensions").mkdir(exist_ok=True)

        # 1. STRICT MANIFEST (hostile control 3): duplicate name, duplicate
        # path, malformed line and non-entry lines are ALL INVALID_MANIFEST.
        base = Path(raw) / "manifest"
        seed_project(base)
        entries, errors = parse_manifest(
            "# SubSaipen Manifest\n\n- saihunt -- "
            ".saipen/extensions/subs/saihunt/\n- saihunt -- "
            ".saipen/extensions/subs/saihunt/\n"
        )
        expect("duplicate instance name FAILs", bool(errors), f"expected errors, got {errors}")
        entries, errors = parse_manifest(
            "# SubSaipen Manifest\n\n- saihunt -- "
            ".saipen/extensions/subs/saihunt/\n- saiwiki -- "
            ".saipen/extensions/subs/saihunt/\n"
        )
        expect("duplicate canonical path FAILs", bool(errors), f"expected errors, got {errors}")
        entries, errors = parse_manifest("# SubSaipen Manifest\n\n- saihunt -> /etc/passwd\n")
        expect("malformed entry FAILs", bool(errors), f"got {errors}")
        entries, errors = parse_manifest(
            "# SubSaipen Manifest\n\n- saihunt -- ../outside/saihunt/\n"
        )
        expect("traversal path FAILs", bool(errors), f"got {errors}")
        entries, errors = parse_manifest(
            "# SubSaipen Manifest\n\nfree prose line\n- saihunt -- "
            ".saipen/extensions/subs/saihunt/\n"
        )
        expect("non-entry line FAILs (never skip+continue)", bool(errors), f"got {errors}")
        entries, errors = parse_manifest(
            "# Wrong Header\n\n- saihunt -- .saipen/extensions/subs/saihunt/\n"
        )
        expect("exact header required", bool(errors), f"got {errors}")
        entries, errors = parse_manifest(
            "# SubSaipen Manifest\n\n- saihunt -- "
            ".saipen/extensions/subs/saihunt/ | last_collect: "
            "2026-08-13T00:00:00Z\n"
        )
        expect(
            "valid canonical manifest passes",
            not errors and entries[0].path.endswith("/saihunt/"),
            f"got {errors}",
        )
        entries, errors = parse_manifest(
            "# SubSaipen Manifest\n\n- saihunt -- "
            ".saipen/extensions/subs/saihunt/ | last_collect: sha256:"
            + "a" * 64
            + "@2026-08-13T00:00:00Z\n"
        )
        expect(
            "identity-bound last_collect passes strict manifest",
            not errors and entries[0].metadata["last_collect"].startswith("sha256:"),
            f"got {errors}",
        )
        for label, manifest_text in (
            (
                "legacy current path FAILs",
                "# SubSaipen Manifest\n\n- saihunt -- extensions/subs/saihunt/\n",
            ),
            (
                "unknown metadata FAILs",
                "# SubSaipen Manifest\n\n- saihunt -- "
                ".saipen/extensions/subs/saihunt/ | spawned: now\n",
            ),
            (
                "duplicate metadata FAILs",
                "# SubSaipen Manifest\n\n- saihunt -- "
                ".saipen/extensions/subs/saihunt/ | last_collect: "
                "2026-08-13T00:00:00Z | last_collect: "
                "2026-08-13T00:00:00Z\n",
            ),
            ("absolute path FAILs", "# SubSaipen Manifest\n\n- saihunt -- C:/subs/saihunt/\n"),
        ):
            _entries, errors = parse_manifest(manifest_text)
            expect(label, bool(errors), f"got {errors}")
        manifest_file = base / MANIFEST_REL
        manifest_file.parent.mkdir(parents=True, exist_ok=True)
        manifest_file.write_text(
            "# SubSaipen Manifest\n\n- saihunt -- "
            ".saipen/extensions/subs/saihunt/\n- saihunt -- "
            ".saipen/extensions/subs/saihunt/\n",
            encoding="utf-8",
        )
        result = sub_list(base)
        expect(
            "sub list refuses INVALID_MANIFEST",
            not result.ok and result.code == "INVALID_MANIFEST",
            f"got {result.code}",
        )

        # 2. DRY-RUN BYTE-IDENTITY (hostile control 2): pause/resume/spawn/
        # sync tree byte-identical.
        base = Path(raw) / "dry"
        seed_project(base)
        spawn = sub_spawn(base, "saihunt", home.as_posix())
        expect("spawn succeeds in probe project", spawn.ok, spawn.message)
        before = tree_snapshot(Path(raw) / "dry")
        dry_pause = sub_pause(base, "saihunt", dry_run=True)
        sub_resume(base, "saihunt", dry_run=True)
        dry_adopt = sub_adopt(base, "saihunt", home.as_posix(), dry_run=True)
        sub_spawn(base, "saipython", home.as_posix(), dry_run=True)
        sub_sync(base, home.as_posix(), dry_run=True)
        after = tree_snapshot(Path(raw) / "dry")
        expect(
            "pause/resume/spawn/sync --dry-run write nothing",
            before == after,
            "tree changed under dry-run",
        )
        expect(
            "dry-run pause reports the same proposed outcome",
            dry_pause.ok and dry_pause.data.get("dry_run") is True,
            f"got {dry_pause.code} {dry_pause.message}",
        )
        expect(
            "dry-run adopt reports proposed outcome without writes",
            dry_adopt.ok and dry_adopt.data.get("dry_run") is True,
            f"got {dry_adopt.code} {dry_adopt.message}",
        )
        expect(
            "dry-run spawn does not create an instance",
            not (Path(raw) / "dry" / SUBS_REL / "saipython" / "STATE.md").is_file(),
            "saipython STATE exists after dry-run spawn",
        )

        # 3. SYNC (hostile control 4): partial bootstrap repaired, live
        # histories untouched, shared inbox preserved, second sync no drift.
        base = Path(raw) / "sync"
        seed_project(base)
        spawn = sub_spawn(base, "saihunt", home.as_posix())
        expect("sync-probe spawn ok", spawn.ok, spawn.message)
        inbox = base / SUBS_REL / "_shared" / "inbox.md"
        inbox_text = inbox.read_text(encoding="utf-8") if inbox.is_file() else ""
        # Delete a shared file to simulate a partial/outdated bootstrap.
        (base / SUBS_REL / "PROTOCOL.md").unlink(missing_ok=True)
        status = shared_contract_status(base, home.as_posix())
        expect("partial bootstrap reported not current", not status["current"], f"status={status}")
        expect(
            "missing file named exactly",
            f"{SUBS_REL}/PROTOCOL.md" in status["missing_files"],
            f"missing={status['missing_files']}",
        )
        dry = sub_sync(base, home.as_posix(), dry_run=True)
        expect(
            "sync --dry-run reports the exact diff",
            dry.ok
            and dry.data.get("drift") is True
            and f"{SUBS_REL}/PROTOCOL.md" in dry.data.get("would_write", []),
            f"got {dry.data}",
        )
        expect(
            "sync --dry-run did not repair",
            not (base / SUBS_REL / "PROTOCOL.md").is_file(),
            "PROTOCOL.md exists after dry-run",
        )
        live_state = tree_snapshot(base / SUBS_REL / "saihunt")
        sync = sub_sync(base, home.as_posix())
        expect("sync succeeds", sync.ok, sync.message)
        expect(
            "sync repaired the missing file",
            (base / SUBS_REL / "PROTOCOL.md").is_file(),
            "PROTOCOL.md still missing",
        )
        expect(
            "live instance history untouched by sync",
            live_state == tree_snapshot(base / SUBS_REL / "saihunt"),
            "saihunt STATE/BOARD/LOG/kitchen changed",
        )
        expect(
            "shared inbox preserved byte-identically",
            (inbox.is_file() and inbox.read_text(encoding="utf-8") == inbox_text),
            "inbox changed",
        )
        second = sub_sync(base, home.as_posix(), dry_run=True)
        expect(
            "second sync -> no drift",
            second.ok and second.data.get("drift") is False,
            f"drift={second.data.get('drift')} changed={second.data.get('changed')}",
        )

        # Exact inherited bytes without an ownership receipt used to form an
        # SC-0 fixed-point trap: the planner required sync, while sync returned
        # "no drift" and wrote no receipt forever. A metadata-only journal op
        # must establish provenance without touching the inherited files.
        receipt_only = Path(raw) / "sync-receipt-only"
        seed_project(receipt_only)
        shutil.copytree(home / "extensions" / "subs", receipt_only / SUBS_REL, dirs_exist_ok=True)
        before_receipt = shared_contract_status(receipt_only, home.as_posix())
        established = sub_sync(receipt_only, home.as_posix())
        after_receipt = shared_contract_status(receipt_only, home.as_posix())
        expect(
            "byte-current contract without receipt is not falsely terminal",
            not before_receipt["current"] and before_receipt.get("inventory_establishment") is True,
            repr(before_receipt),
        )
        expect(
            "metadata-only sync establishes ownership receipt",
            established.ok
            and bool(established.op_id)
            and established.changed_files == []
            and established.data.get("inventory_established") is True
            and after_receipt["current"],
            f"result={established.to_json()} status={after_receipt}",
        )

        # 3b. RECEIPT LINEAGE (hostile control, T-1001): the durable
        # canonical successor is the receipt's OWN created_at, never the
        # operation.json filesystem mtime -- a copy or touch can push an
        # older committed inventory's mtime forward and feed the wrong
        # obsolete reconciliation. Ambiguous or broken lineage fails closed.
        from saipen_engine.subs import _latest_sub_sync_inventory

        def write_receipt(
            root: Path, dir_name: str, op_id: str, created_at: str, extra_path: str, mtime: int
        ) -> Path:
            """Craft one committed sub_sync receipt over the base shared
            inventory plus one extra path, with a pinned durable timestamp
            and a pinned filesystem mtime."""
            inventory = [
                {"path": "PROTOCOL.md", "kind": "file", "source_hash": "0123456789abcdef"},
                {"path": "README.md", "kind": "file", "source_hash": "0123456789abcdef"},
                {"path": "crew.md", "kind": "file", "source_hash": "0123456789abcdef"},
            ]
            if extra_path:
                inventory.append(
                    {"path": extra_path, "kind": "file", "source_hash": "0123456789abcdef"}
                )
            ops = root / ".saipen" / "recovery" / "ops" / dir_name
            ops.mkdir(parents=True, exist_ok=True)
            op_file = ops / "operation.json"
            op_file.write_text(
                json.dumps(
                    {
                        "op_id": op_id,
                        "operation": "sub_sync",
                        "status": "COMMITTED",
                        "created_at": created_at,
                        "semantic_payload_hash": "fixture-sub-sync",
                        "agent": "scenario",
                        "project_identity": str(root.resolve()),
                        "verification_policy": "none",
                        "preconditions": {},
                        "read_preconditions": {},
                        "progress_index": 0,
                        "targets": [],
                        "receipt_metadata": {
                            "owned_source_inventory": inventory,
                            "obsolete_reconciliation": [],
                        },
                    },
                    indent=2,
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )
            os.utime(op_file, (mtime, mtime))
            return op_file

        late = 0x7FE000000000
        early = 0x100000000
        lineage_root = Path(raw) / "sync-lineage"
        seed_project(lineage_root)
        write_receipt(
            lineage_root, "sub-sync-old", "sub-sync-old", "2026-08-13T00:00:00Z", "", late
        )
        write_receipt(
            lineage_root,
            "sub-sync-new",
            "sub-sync-new",
            "2026-08-14T00:00:00Z",
            "TEMPLATE/sync-lineage-extra.txt",
            early,
        )
        lineage_chosen, _inv, lineage_kind = _latest_sub_sync_inventory(lineage_root)
        expect(
            "durable successor wins over inverted receipt mtime",
            lineage_kind == "ok"
            and lineage_chosen is not None
            and lineage_chosen.get("op_id") == "sub-sync-new",
            f"chosen={lineage_chosen and lineage_chosen.get('op_id')} lineage={lineage_kind}",
        )
        lineage_status = shared_contract_status(lineage_root, home.as_posix())
        expect(
            "obsolete reconciliation follows the durable successor",
            f"{SUBS_REL}/TEMPLATE/sync-lineage-extra.txt" in lineage_status["obsolete_files"],
            f"obsolete_files={lineage_status['obsolete_files']}",
        )

        amb_root = Path(raw) / "sync-lineage-ambiguous"
        seed_project(amb_root)
        write_receipt(
            amb_root,
            "sub-sync-amb-a",
            "sub-sync-amb-a",
            "2026-08-14T00:00:00Z",
            "",
            early,
        )
        write_receipt(
            amb_root,
            "sub-sync-amb-b",
            "sub-sync-amb-b",
            "2026-08-14T00:00:00Z",
            "TEMPLATE/sync-lineage-amb-extra.txt",
            early,
        )
        amb_ops = amb_root / ".saipen" / "recovery" / "ops"
        amb_before = sorted(p.name for p in amb_ops.iterdir())
        amb_chosen, _amb_inv, amb_kind = _latest_sub_sync_inventory(amb_root)
        amb_status = shared_contract_status(amb_root, home.as_posix())
        refused_amb = sub_sync(amb_root, home.as_posix())
        amb_after = sorted(p.name for p in amb_ops.iterdir())
        expect(
            "ambiguous receipt lineage fails closed",
            amb_chosen is None
            and amb_kind == "ambiguous"
            and amb_status["current"] is False
            and amb_status.get("inventory_lineage") == "ambiguous"
            and not refused_amb.ok
            and "ambiguous" in refused_amb.message
            and amb_before == amb_after,
            f"lineage={amb_kind} current={amb_status['current']} refused={refused_amb.to_json()}",
        )

        broken_root = Path(raw) / "sync-lineage-broken"
        seed_project(broken_root)
        broken_first = sub_sync(broken_root, home.as_posix())
        expect(
            "broken-lineage fixture receipt",
            broken_first.ok and bool(broken_first.op_id),
            broken_first.to_json(),
        )
        broken_op = (
            broken_root / ".saipen" / "recovery" / "settled" / broken_first.op_id / "operation.json"
        )
        if not broken_op.is_file():
            broken_op = (
                broken_root / ".saipen" / "recovery" / "ops" / broken_first.op_id / "operation.json"
            )
        broken_record = json.loads(broken_op.read_text(encoding="utf-8"))
        broken_record["created_at"] = "not-a-timestamp"
        broken_op.write_text(
            json.dumps(broken_record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        broken_chosen, _broken_inv, broken_kind = _latest_sub_sync_inventory(broken_root)
        expect(
            "broken receipt lineage fails closed",
            broken_chosen is None and broken_kind == "broken",
            f"chosen={broken_chosen} lineage={broken_kind}",
        )
        healed = sub_sync(broken_root, home.as_posix())
        healed_chosen, _healed_inv, healed_kind = _latest_sub_sync_inventory(broken_root)
        expect(
            "broken lineage self-heals with a fresh valid receipt",
            healed.ok
            and healed_kind == "ok"
            and healed_chosen is not None
            and healed_chosen.get("op_id") == healed.op_id
            and shared_contract_status(broken_root, home.as_posix())["current"],
            f"healed={healed.to_json()} kind={healed_kind}",
        )

        mix_root = Path(raw) / "sync-lineage-mixed"
        seed_project(mix_root)
        write_receipt(mix_root, "sub-sync-mix-broken", "sub-sync-mix-broken", "garbage", "", late)
        write_receipt(
            mix_root,
            "sub-sync-mix-valid",
            "sub-sync-mix-valid",
            "2026-08-14T00:00:00Z",
            "TEMPLATE/sync-lineage-mix-extra.txt",
            early,
        )
        mix_chosen, _mix_inv, mix_kind = _latest_sub_sync_inventory(mix_root)
        expect(
            "broken receipt never wins selection",
            mix_kind == "ok"
            and mix_chosen is not None
            and mix_chosen.get("op_id") == "sub-sync-mix-valid",
            f"chosen={mix_chosen and mix_chosen.get('op_id')} lineage={mix_kind}",
        )

        equal_root = Path(raw) / "sync-lineage-equal-distance"
        seed_project(equal_root)
        write_receipt(
            equal_root,
            "sub-sync-eq-a",
            "sub-sync-eq-a",
            "2026-08-14T00:00:00Z",
            "TEMPLATE/sync-lineage-eq-x.txt",
            early,
        )
        write_receipt(
            equal_root,
            "sub-sync-eq-b",
            "sub-sync-eq-b",
            "2026-08-14T00:00:00Z",
            "TEMPLATE/sync-lineage-eq-y.txt",
            early,
        )
        eq_chosen, _eq_inv, eq_kind = _latest_sub_sync_inventory(equal_root)
        eq_refused = sub_sync(equal_root, home.as_posix())
        expect(
            "equally-close same-second lineages fail closed",
            eq_chosen is None
            and eq_kind == "ambiguous"
            and not eq_refused.ok
            and "ambiguous" in eq_refused.message,
            f"lineage={eq_kind} refused={eq_refused.to_json()}",
        )

        def bump_receipt_ts(root: Path, op_id: str | None, ts: str) -> None:
            """Pin one committed receipt's durable timestamp. The obsolete
            and crash fixtures below run several syncs within the same real
            second; their lineages must be durably ordered for the durable
            selection (T-1001), exactly as spaced-out real syncs are."""
            if not op_id:
                return
            op_file = root / ".saipen" / "recovery" / "settled" / op_id / "operation.json"
            if not op_file.is_file():
                op_file = root / ".saipen" / "recovery" / "ops" / op_id / "operation.json"
            if not op_file.is_file():
                return
            record = json.loads(op_file.read_text(encoding="utf-8"))
            record["created_at"] = ts
            op_file.write_text(
                json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )

        # Removed inherited paths are owned only through the previous receipt.
        # Exact old bytes may be deleted, deepest file/directory first; local
        # edits refuse before a journal exists.
        obsolete_root = Path(raw) / "sync-obsolete"
        seed_project(obsolete_root)
        spawned = sub_spawn(obsolete_root, "saihunt", home.as_posix())
        expect("obsolete-sync fixture spawn ok", spawned.ok, spawned.message)
        bump_receipt_ts(obsolete_root, spawned.data.get("sync_op_id"), "2026-08-14T00:00:00Z")
        obsolete_source = home / "extensions" / "subs" / "TEMPLATE" / "retired" / "nested.txt"
        obsolete_source.parent.mkdir(parents=True)
        obsolete_source.write_text("owned old bytes\n", encoding="utf-8")
        admitted = sub_sync(obsolete_root, home.as_posix())
        bump_receipt_ts(obsolete_root, admitted.op_id, "2026-08-14T00:00:01Z")
        obsolete_local = obsolete_root / SUBS_REL / "TEMPLATE" / "retired" / "nested.txt"
        expect(
            "sync admits new inherited nested file with receipt",
            admitted.ok and obsolete_local.is_file(),
            admitted.to_json(),
        )
        obsolete_source.unlink()
        obsolete_source.parent.rmdir()
        removed = sub_sync(obsolete_root, home.as_posix())
        expect(
            "sync deletes receipt-owned obsolete file and empty directory",
            removed.ok
            and not obsolete_local.exists()
            and not obsolete_local.parent.exists()
            and f"{SUBS_REL}/TEMPLATE/retired/nested.txt" in removed.data.get("deleted", [])
            and shared_contract_status(obsolete_root, home.as_posix())["current"],
            removed.to_json(),
        )

        conflict_root = Path(raw) / "sync-obsolete-conflict"
        seed_project(conflict_root)
        conflict_source = home / "extensions" / "subs" / "saiconflict.md"
        conflict_source.write_text("owned source\n", encoding="utf-8")
        conflict_spawn = sub_spawn(conflict_root, "saihunt", home.as_posix())
        conflict_local = conflict_root / SUBS_REL / "saiconflict.md"
        conflict_local.write_text("local edit\n", encoding="utf-8")
        conflict_source.unlink()
        ops_before = set((conflict_root / ".saipen" / "recovery" / "ops").iterdir())
        refused = sub_sync(conflict_root, home.as_posix())
        ops_after = set((conflict_root / ".saipen" / "recovery" / "ops").iterdir())
        expect(
            "sync refuses modified obsolete inherited file with zero writes",
            conflict_spawn.ok
            and not refused.ok
            and "refusing deletion" in refused.message
            and conflict_local.read_text(encoding="utf-8") == "local edit\n"
            and ops_before == ops_after,
            refused.to_json(),
        )

        # A crash after an obsolete-file deletion resumes from the same staged
        # receipt and reaches the identical current fixed point.
        crash_root = Path(raw) / "sync-obsolete-crash"
        seed_project(crash_root)
        crash_source = home / "extensions" / "subs" / "saicrash.md"
        crash_source.write_text("crash-owned\n", encoding="utf-8")
        crash_spawn = sub_spawn(crash_root, "saihunt", home.as_posix())
        bump_receipt_ts(crash_root, crash_spawn.data.get("sync_op_id"), "2026-08-14T00:00:00Z")
        crash_local = crash_root / SUBS_REL / "saicrash.md"
        crash_source.unlink()
        from saipen_engine import journal as sync_journal
        from saipen_engine.journal import pending_ops as sync_pending, recover

        def crash_after_delete(key: str) -> None:
            if key == "delete_file":
                raise RuntimeError("simulated sync crash after delete")

        crashed = False
        with mock.patch.object(sync_journal, "_crash_after", side_effect=crash_after_delete):
            try:
                sub_sync(crash_root, home.as_posix())
            except RuntimeError:
                crashed = True
        pending = sync_pending(crash_root)
        recovered = recover(crash_root, pending[0]["op_id"]) if pending else {}
        expect(
            "obsolete sync crash resumes to receipt-bound current state",
            crash_spawn.ok
            and crashed
            and len(pending) == 1
            and recovered.get("ok")
            and not crash_local.exists()
            and shared_contract_status(crash_root, home.as_posix())["current"],
            f"pending={pending} recovered={recovered}",
        )

        # 4. ROLE REVISION AUTHORITY (hostile control 5): the PROJECT-LOCAL
        # charter is the only authority; missing local evidence is
        # UNAVAILABLE, never a silent fallback to the home charter.
        base = Path(raw) / "role"
        seed_project(base)
        spawn = sub_spawn(base, "saihunt", home.as_posix())
        expect("role-probe spawn ok", spawn.ok, spawn.message)
        recorded = spawn.data.get("role_revision") or ""
        expect(
            "spawned built-in worker has a real role_revision",
            recorded.startswith("sha256:"),
            f"got {recorded!r}",
        )
        current = current_local_role_revision(base, "saihunt")
        expect(
            "local charter is the authority",
            current is not None and current == recorded,
            f"current={current} recorded={recorded}",
        )
        expect(
            "role freshness CURRENT with local charter",
            role_freshness(base, "saihunt", recorded) == "current",
            "not current",
        )
        # Delete the LOCAL charter only; the home copy still exists.
        (base / SUBS_REL / "saihunt.md").unlink()
        expect(
            "local missing -> UNAVAILABLE, never home fallback",
            role_freshness(base, "saihunt", recorded, home.as_posix()) == "unavailable",
            "fell back to home charter",
        )
        # Generic role: revision derives from local PROTOCOL.md, never blank.
        spawn_gen = sub_spawn(base, "saiscan", home.as_posix())
        expect("generic spawn succeeds", spawn_gen.ok, spawn_gen.message)
        generic_rev = spawn_gen.data.get("role_revision") or ""
        expect(
            "generic worker revision never blank",
            generic_rev.startswith("sha256:"),
            f"got {generic_rev!r}",
        )
        expect(
            "generic revision derives from local PROTOCOL",
            generic_rev == current_local_role_revision(base, "saiscan"),
            "generic revision mismatch",
        )

        # 5. SUB-BOARD COHERENCE (hostile control 6).
        board = parse_sub_board("## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n\n## TODO\n")
        expect("duplicate heading FAILs", bool(board["errors"]), f"got {board['errors']}")
        board = parse_sub_board(
            "## DOING\n\n## TODO\n- [ ] H-1 open\n\n## DONE\n\n## BLOCKED\n", ticket_prefix="H"
        )
        expect("valid board passes", not board["errors"], f"got {board['errors']}")
        board = parse_sub_board(
            "## DOING\n- [x] H-1 wrong checkbox\n\n## TODO\n\n## DONE\n\n## BLOCKED\n"
        )
        expect("checkbox/section mismatch FAILs", bool(board["errors"]), f"got {board['errors']}")
        board = parse_sub_board(
            "## DOING\n- [/] H-1 a\n- [/] H-2 b\n\n## TODO\n\n## DONE\n\n## BLOCKED\n"
        )
        expect("two DOING FAILs", bool(board["errors"]), f"got {board['errors']}")
        board = parse_sub_board("## DOING\n\n## TODO\n- [ ] T-1 core id\n\n## DONE\n\n## BLOCKED\n")
        expect(
            "Core T-### namespace FAILs on a sub board",
            bool(board["errors"]),
            f"got {board['errors']}",
        )
        for role, prefix in (
            ("saihunt", "HUNT"),
            ("saitest", "TEST"),
            ("saipython", "PY"),
            ("saiui", "UI"),
            ("saiwiki", "W"),
        ):
            board = parse_sub_board(
                f"## DOING\n\n## TODO\n- [ ] {prefix}-1 open\n\n## DONE\n\n## BLOCKED\n",
                expected_role=role,
            )
            expect(
                f"{role} canonical {prefix}- board prefix passes",
                not board["errors"],
                f"got {board['errors']}",
            )
        board = parse_sub_board(
            "## DOING\n\n## TODO\n- [ ] PY-1 wrong\n\n## DONE\n\n## BLOCKED\n",
            expected_role="saihunt",
        )
        expect("wrong role ticket prefix FAILs", bool(board["errors"]), f"got {board['errors']}")
        board = parse_sub_board(
            "## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n\n## UNKNOWN\n", expected_role="saihunt"
        )
        expect("unknown board heading FAILs", bool(board["errors"]), f"got {board['errors']}")

        # 6. TRUTHFUL STATUS (hostile control 7): the real board state is
        # reported, and an empty OUTBOX never implies CURRENT.
        base = Path(raw) / "status"
        seed_project(base)
        spawn = sub_spawn(base, "saihunt", home.as_posix())
        expect("status-probe spawn ok", spawn.ok, spawn.message)
        (base / SUBS_REL / "saihunt" / "BOARD.md").write_text(
            "# Board\n\n## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n"
            "- [ ] HUNT-1 unresolved\n- [ ] HUNT-2 unresolved\n",
            encoding="utf-8",
        )
        (base / SUBS_REL / "saihunt" / "STATE.md").write_text(
            (base / SUBS_REL / "saihunt" / "STATE.md")
            .read_text(encoding="utf-8")
            .replace("phase: PLAN", "phase: DONE")
            .replace("transition_from: INIT", "transition_from: PLAN"),
            encoding="utf-8",
        )
        health = sub_instance_health(base, "saihunt")
        expect(
            "DONE + unresolved BLOCKED board is INVALID, not DONE",
            health["health"] == HEALTH_INVALID,
            f"got {health['health']}",
        )
        # Empty OUTBOX + no evidence: NOT_RUN, never CURRENT.
        (base / SUBS_REL / "saihunt" / "BOARD.md").write_text(
            "# Board\n\n## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n", encoding="utf-8"
        )
        health = sub_instance_health(base, "saihunt")
        expect(
            "empty OUTBOX never implies CURRENT",
            health["health"] != HEALTH_CURRENT and health["health"] == HEALTH_NOT_RUN,
            f"got {health['health']}",
        )
        (base / SUBS_REL / "saihunt" / "STATE.md").write_text(
            (base / SUBS_REL / "saihunt" / "STATE.md")
            .read_text(encoding="utf-8")
            .replace("phase: DONE", "phase: BLOCKED"),
            encoding="utf-8",
        )
        health = sub_instance_health(base, "saihunt")
        expect(
            "phase BLOCKED reports BLOCKED",
            health["health"] == HEALTH_BLOCKED,
            f"got {health['health']}",
        )

        # 7. TRUTHFUL JOURNALED COLLECT: incomplete/malformed packages refuse;
        # complete current evidence creates one Core review hypothesis.
        base = Path(raw) / "collect"
        seed_project(base)
        spawn = sub_spawn(base, "saihunt", home.as_posix())
        expect("collect-probe spawn ok", spawn.ok, spawn.message)
        outbox = base / SUBS_REL / "saihunt" / "kitchen" / "OUTBOX.md"
        outbox.write_text(
            "# OUTBOX\n\n## HUNT-1: finding\n- **status:** ready\n- **summary:** no triple\n",
            encoding="utf-8",
        )
        result = sub_collect(base, "saihunt")
        expect(
            "ready package without source triple refused",
            not result.ok and result.code == "MALFORMED_PACKAGE",
            f"got {result.code}",
        )
        outbox.write_text("# OUTBOX\n\n## not-a-package\nrandom prose\n", encoding="utf-8")
        result = sub_collect(base, "saihunt")
        expect(
            "malformed OUTBOX refused",
            not result.ok and result.code == "MALFORMED_PACKAGE",
            f"got {result.code}",
        )

        # 7b. ONE OUTBOX model backs health + collect. Header-only TEMPLATE is
        # valid; complete current evidence is ready for review/current after
        # review; duplicate/unknown/wrong-owner/ambiguous evidence fails.
        empty = parse_outbox("# OUTBOX\n\n<!-- template -->\n", "saihunt")
        expect(
            "header-only OUTBOX template is a valid empty queue",
            not empty.errors and not empty.packages,
            f"errors={empty.errors}",
        )
        from freshness import compute_source_identity

        current = compute_source_identity(base)
        role_revision = current_local_role_revision(base, "saihunt", home.as_posix())

        def complete_package(package_id="HUNT-1", producer="saihunt", status="ready"):
            return (
                f"# OUTBOX\n\n## {package_id}: complete evidence\n"
                f"- **status:** {status}\n- **producer:** {producer}\n"
                f"- **source_head:** {current.source_head}\n"
                f"- **source_tree_fingerprint:** "
                f"{current.source_tree_fingerprint}\n"
                f"- **role_revision:** {role_revision}\n"
                "- **coverage:** all requested surfaces\n"
                "- **payload:** []\n- **verified:** PASS -- probe\n"
                "- **instructions:** review evidence\n"
            )

        outbox.write_text(complete_package(), encoding="utf-8")
        (base / SUBS_REL / "saihunt" / "BOARD.md").write_text(
            "# Board\n\n## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n", encoding="utf-8"
        )
        (base / SUBS_REL / "saihunt" / "STATE.md").write_text(
            (base / SUBS_REL / "saihunt" / "STATE.md")
            .read_text(encoding="utf-8")
            .replace("phase: PLAN", "phase: DONE")
            .replace("transition_from: INIT", "transition_from: PLAN"),
            encoding="utf-8",
        )
        health = sub_instance_health(base, "saihunt", current)
        expect(
            "complete current READY OUTBOX -> READY_FOR_REVIEW",
            health["health"] == HEALTH_READY_FOR_REVIEW,
            f"got {health['health']} {health['outbox']}",
        )
        dry_before = tree_snapshot(base)
        dry_collect = sub_collect(base, "saihunt", dry_run=True)
        dry_after = tree_snapshot(base)
        expect(
            "collect dry-run computes ticket and writes zero bytes/journal",
            dry_collect.ok
            and dry_collect.code == "SUB_COLLECT_PLAN"
            and dry_collect.data.get("dry_run") is True
            and dry_collect.data.get("would_result") == "SUB_COLLECTED"
            and dry_before == dry_after,
            f"result={dry_collect.to_dict()} changed={dry_before != dry_after}",
        )
        collected = sub_collect(base, "saihunt")
        core_board = (base / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        core_log = (base / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        manifest_text = (base / MANIFEST_REL).read_text(encoding="utf-8")
        identity_match = re.search(
            r"last_collect: (sha256:[0-9a-f]{64})@"
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z",
            manifest_text,
        )
        expect(
            "complete current collection creates one Core TODO hypothesis",
            collected.ok
            and collected.code == "SUB_COLLECTED"
            and core_board.count("Review SubSaipen hypothesis") == 1
            and "not accepted fact" in core_board,
            f"result={collected.to_dict()} board={core_board}",
        )
        expect(
            "collection marks MANIFEST last_collect and binds identity",
            identity_match is not None and identity_match.group(1) in core_board,
            f"manifest={manifest_text} log={core_log}",
        )
        retry_before = tree_snapshot(base)
        retried = sub_collect(base, "saihunt")
        retry_after = tree_snapshot(base)
        expect(
            "collect retry deduplicates without second Core ticket",
            retried.ok
            and retried.code == "ALREADY_COLLECTED"
            and retry_before == retry_after
            and (base / ".saipen" / "BOARD.md")
            .read_text(encoding="utf-8")
            .count("Review SubSaipen hypothesis")
            == 1,
            retried.to_json(),
        )
        health = sub_instance_health(base, "saihunt", current)
        expect(
            "collected READY package with open review ticket -> REVIEW_PENDING",
            health["health"] == HEALTH_REVIEW_PENDING,
            f"got {health['health']} {health['outbox']}",
        )
        # INTAKE != REVIEW: collect leaves the OUTBOX READY; the reviewed
        # mark is a DISPOSITION (sub_disposition) that requires the linked
        # Core review ticket to be terminal first.
        board_lines = core_board.splitlines()
        hypothesis = next(
            line
            for line in board_lines
            if line.startswith("- [ ] T-") and "Review SubSaipen hypothesis" in line
        )
        re.search(r"^\- \[ \] (T-\d+)", hypothesis).group(1)
        board_lines.remove(hypothesis)
        done_index = board_lines.index("## DONE")
        board_lines.insert(done_index + 1, hypothesis.replace("[ ]", "[x]", 1))
        (base / ".saipen" / "BOARD.md").write_text("\n".join(board_lines) + "\n", encoding="utf-8")
        disposed = sub_disposition(base, "saihunt")
        expect(
            "disposition marks OUTBOX reviewed and binds immutable identity",
            disposed.ok
            and disposed.code == "SUB_DISPOSITIONED"
            and "- **status:** reviewed" in outbox.read_text(encoding="utf-8")
            and identity_match is not None
            and identity_match.group(1) in core_log,
            f"disposed={disposed.to_dict()} log={core_log}",
        )
        from saipen_engine.fast_check import validate_project as fast_validate

        expect(
            "collection preserves Core LOG/STATE binding",
            not fast_validate(base),
            repr(fast_validate(base)),
        )
        health = sub_instance_health(base, "saihunt", current)
        expect(
            "complete current reviewed OUTBOX -> CURRENT",
            health["health"] == HEALTH_CURRENT,
            f"got {health['health']} {health['outbox']}",
        )
        hostile_outboxes = (
            (
                "duplicate OUTBOX field FAILs",
                complete_package().replace(
                    "- **producer:** saihunt\n",
                    "- **producer:** saihunt\n- **producer:** saihunt\n",
                ),
            ),
            ("unknown OUTBOX field FAILs", complete_package() + "- **mystery:** nope\n"),
            ("wrong OUTBOX producer FAILs", complete_package(producer="saiwiki")),
            (
                "duplicate OUTBOX package ID FAILs",
                complete_package() + complete_package().split("# OUTBOX\n", 1)[1],
            ),
            (
                "invalid OUTBOX source_head FAILs",
                complete_package().replace(current.source_head, "not-a-sha"),
            ),
            (
                "invalid OUTBOX tree fingerprint FAILs",
                complete_package().replace(current.source_tree_fingerprint, "git-delta-v1:beef"),
            ),
            (
                "invalid OUTBOX role revision FAILs",
                complete_package().replace(role_revision, "sha256:beef"),
            ),
        )
        for label, hostile in hostile_outboxes:
            parsed = parse_outbox(hostile, "saihunt")
            expect(label, bool(parsed.errors), f"got {parsed.errors}")
        ambiguous = (
            complete_package("HUNT-7") + complete_package("HUNT-9").split("# OUTBOX\n", 1)[1]
        )
        outbox.write_text(ambiguous, encoding="utf-8")
        result = sub_collect(base, "saihunt")
        expect(
            "two current READY packages refuse as ambiguous",
            not result.ok and result.code == "MALFORMED_PACKAGE",
            f"got {result.code} {result.message}",
        )

        # Explicit producers are never swallowed by generic collection.
        explicit = Path(raw) / "collect-explicit"
        seed_project(explicit)
        expect("explicit-probe spawn core role", sub_spawn(explicit, "saihunt", home.as_posix()).ok)
        expect("explicit-probe spawn saiwiki", sub_spawn(explicit, "saiwiki", home.as_posix()).ok)
        expect(
            "explicit-probe spawn saitranslate",
            sub_spawn(explicit, "saitranslate", home.as_posix()).ok,
        )
        targeted_explicit = sub_collect(explicit, "saiwiki")
        expect(
            "targeted explicit producer refuses with EXPLICIT_POLICY",
            not targeted_explicit.ok and "EXPLICIT_POLICY" in targeted_explicit.message,
            targeted_explicit.to_json(),
        )
        aggregate = sub_collect(explicit)
        skipped_names = {item["name"] for item in aggregate.data.get("skipped", [])}
        expect(
            "aggregate skips explicit saiwiki/saitranslate",
            aggregate.ok and skipped_names == {"saiwiki", "saitranslate"},
            aggregate.to_json(),
        )

        # 7c. Stale-CAS simulations mutate captured dependencies immediately
        # after lock acquisition. No timing, threads, or sleeps.
        cas = Path(raw) / "cas"
        seed_project(cas)
        spawn = sub_spawn(cas, "saihunt", home.as_posix())
        expect("CAS-probe spawn ok", spawn.ok, spawn.message)

        class MutatingLock:
            def __init__(self, mutation):
                self.mutation = mutation

            def __enter__(self):
                self.mutation()
                return self

            def __exit__(self, *_args):
                return False

        state_path = cas / SUBS_REL / "saihunt" / "STATE.md"
        original_state = state_path.read_bytes()
        with mock.patch(
            "saipen_engine.subs.project_writer_lock",
            lambda _root: MutatingLock(
                lambda: state_path.write_bytes(original_state + b"\nforeign\n")
            ),
        ):
            stale = sub_adopt(cas, "saihunt", home.as_posix())
        expect(
            "adopt stale STATE CAS refuses",
            not stale.ok and stale.code == "STALE_STATE",
            f"got {stale.code}",
        )
        state_path.write_bytes(original_state)
        local_charter = cas / SUBS_REL / "saihunt.md"
        charter_before = local_charter.read_bytes()
        with mock.patch(
            "saipen_engine.subs.project_writer_lock",
            lambda _root: MutatingLock(
                lambda: local_charter.write_bytes(charter_before + b"foreign\n")
            ),
        ):
            stale = sub_adopt(cas, "saihunt", home.as_posix())
        expect(
            "adopt stale charter CAS refuses",
            not stale.ok and stale.code == "STALE_STATE",
            f"got {stale.code}",
        )
        local_charter.write_bytes(charter_before)
        log_path = cas / SUBS_REL / "saihunt" / "LOG.md"
        original_log = log_path.read_bytes()
        with mock.patch(
            "saipen_engine.subs.project_writer_lock",
            lambda _root: MutatingLock(lambda: log_path.write_bytes(original_log + b"foreign\n")),
        ):
            stale = sub_pause(cas, "saihunt")
        expect(
            "pause stale LOG CAS refuses",
            not stale.ok and stale.code == "STALE_STATE",
            f"got {stale.code}",
        )
        log_path.write_bytes(original_log)
        manifest_path = cas / MANIFEST_REL
        manifest_before = manifest_path.read_bytes()
        with mock.patch(
            "saipen_engine.subs.project_writer_lock",
            lambda _root: MutatingLock(lambda: manifest_path.write_bytes(manifest_before + b"\n")),
        ):
            stale = sub_pause(cas, "saihunt")
        expect(
            "pause stale MANIFEST CAS refuses",
            not stale.ok and stale.code == "STALE_STATE",
            f"got {stale.code}",
        )
        manifest_path.write_bytes(manifest_before)
        paused = sub_pause(cas, "saihunt")
        expect("CAS-probe pause setup ok", paused.ok, paused.message)
        paused_log = log_path.read_bytes()
        with mock.patch(
            "saipen_engine.subs.project_writer_lock",
            lambda _root: MutatingLock(lambda: log_path.write_bytes(paused_log + b"foreign\n")),
        ):
            stale = sub_resume(cas, "saihunt")
        expect(
            "resume stale LOG CAS refuses",
            not stale.ok and stale.code == "STALE_STATE",
            f"got {stale.code}",
        )
        log_path.write_bytes(paused_log)
        resumed = sub_resume(cas, "saihunt")
        expect("CAS-probe resume setup ok", resumed.ok, resumed.message)
        target_state = cas / SUBS_REL / "saiui" / "STATE.md"
        with mock.patch(
            "saipen_engine.subs.project_writer_lock",
            lambda _root: MutatingLock(
                lambda: (
                    target_state.parent.mkdir(parents=True),
                    target_state.write_text("foreign\n", encoding="utf-8"),
                )
            ),
        ):
            stale = sub_spawn(cas, "saiui", home.as_posix())
        expect(
            "spawn target-absence CAS refuses",
            not stale.ok and stale.code == "STALE_STATE",
            f"got {stale.code}",
        )
        shutil.rmtree(target_state.parent)
        protocol_source = home / "extensions" / "subs" / "PROTOCOL.md"
        source_before = protocol_source.read_bytes()
        (cas / SUBS_REL / "PROTOCOL.md").unlink()
        try:
            with mock.patch(
                "saipen_engine.subs.project_writer_lock",
                lambda _root: MutatingLock(
                    lambda: protocol_source.write_bytes(source_before + b"foreign\n")
                ),
            ):
                stale = sub_sync(cas, home.as_posix())
            expect(
                "sync stale source CAS refuses",
                not stale.ok and stale.code == "STALE_STATE",
                f"got {stale.code}",
            )
        finally:
            protocol_source.write_bytes(source_before)

        collect_cas = Path(raw) / "collect-cas"
        seed_project(collect_cas)
        expect("collect-CAS spawn ok", sub_spawn(collect_cas, "saihunt", home.as_posix()).ok)
        collect_outbox = collect_cas / SUBS_REL / "saihunt" / "kitchen" / "OUTBOX.md"
        collect_source = compute_source_identity(collect_cas)
        collect_role = current_local_role_revision(collect_cas, "saihunt", home.as_posix())
        collect_ready = (
            "# OUTBOX\n\n## HUNT-77: CAS evidence\n"
            "- **status:** ready\n- **producer:** saihunt\n"
            f"- **source_head:** {collect_source.source_head}\n"
            "- **source_tree_fingerprint:** "
            f"{collect_source.source_tree_fingerprint}\n"
            f"- **role_revision:** {collect_role}\n"
            "- **coverage:** CAS surface\n- **payload:** []\n"
            "- **verified:** PASS -- probe\n- **instructions:** review\n"
        )
        collect_outbox.write_text(collect_ready, encoding="utf-8")
        core_before = {
            rel: (collect_cas / rel).read_bytes()
            for rel in (".saipen/LOG.md", ".saipen/BOARD.md", ".saipen/STATE.md", MANIFEST_REL)
        }
        with mock.patch(
            "saipen_engine.subs.project_writer_lock",
            lambda _root: MutatingLock(
                lambda: collect_outbox.write_bytes(collect_outbox.read_bytes() + b"\nforeign\n")
            ),
        ):
            stale_collect = sub_collect(collect_cas, "saihunt")
        expect(
            "collect stale OUTBOX CAS refuses with zero Core writes",
            not stale_collect.ok
            and stale_collect.code == "STALE_STATE"
            and all(
                (collect_cas / rel).read_bytes() == before for rel, before in core_before.items()
            ),
            stale_collect.to_json(),
        )

        # 7d. Actual clean: exact archive first, strict unregister, journaled
        # file/dir deletion, CAS refusal, crash roll-forward, and confinement.
        def clean_fixture(label: str, name: str = "saihunt"):
            project = Path(raw) / label
            seed_project(project)
            spawned = sub_spawn(project, name, home.as_posix())
            instance = project / SUBS_REL / name
            state_path = instance / "STATE.md"
            state_path.write_text(
                state_path.read_text(encoding="utf-8").replace("phase: PLAN", "phase: DONE"),
                encoding="utf-8",
            )
            (instance / "nested" / "empty").mkdir(parents=True)
            (instance / "nested" / "payload.bin").write_bytes(b"\x00exact-clean-archive\xff")
            return project, instance, spawned

        def surface_snapshot(path: Path):
            entries = []
            for candidate in sorted(path.rglob("*")):
                rel = candidate.relative_to(path).as_posix()
                entries.append(
                    (rel, "d", b"") if candidate.is_dir() else (rel, "f", candidate.read_bytes())
                )
            return tuple(entries)

        clean_root, clean_instance, clean_spawn = clean_fixture("clean-actual")
        expect("clean fixture spawn succeeds", clean_spawn.ok, clean_spawn.message)
        expect("clean sibling spawn succeeds", sub_spawn(clean_root, "saiui", home.as_posix()).ok)
        source_bytes = {
            path.relative_to(clean_instance).as_posix(): path.read_bytes()
            for path in clean_instance.rglob("*")
            if path.is_file()
        }
        sibling_before = surface_snapshot(clean_root / SUBS_REL / "saiui")
        shared_before = {
            path.relative_to(clean_root / SUBS_REL).as_posix(): path.read_bytes()
            for path in (clean_root / SUBS_REL).iterdir()
            if path.is_file() and path.name != "MANIFEST.md"
        }
        cleaned = sub_clean(clean_root, "saihunt")
        archive = clean_root / cleaned.data.get("archive", "") / "instance"
        expect(
            "safe terminal worker is archived, removed, and unregistered",
            cleaned.ok
            and cleaned.code == "SUB_CLEANED"
            and not clean_instance.exists()
            and "- saihunt --" not in (clean_root / MANIFEST_REL).read_text(encoding="utf-8")
            and "- saiui --" in (clean_root / MANIFEST_REL).read_text(encoding="utf-8"),
            cleaned.to_json(),
        )
        archived_bytes = (
            {
                path.relative_to(archive).as_posix(): path.read_bytes()
                for path in archive.rglob("*")
                if path.is_file()
            }
            if archive.is_dir()
            else {}
        )
        expect(
            "clean archive preserves every source file byte-exactly",
            archived_bytes == source_bytes,
            repr((sorted(source_bytes), sorted(archived_bytes))),
        )
        expect(
            "clean leaves sibling worker and shared files untouched",
            sibling_before == surface_snapshot(clean_root / SUBS_REL / "saiui")
            and shared_before
            == {
                path.relative_to(clean_root / SUBS_REL).as_posix(): path.read_bytes()
                for path in (clean_root / SUBS_REL).iterdir()
                if path.is_file() and path.name != "MANIFEST.md"
            },
            "sibling or shared contract changed",
        )
        retry = sub_clean(clean_root, "saihunt")
        expect(
            "clean retry after COMMITTED is idempotent ALREADY_CLEAN",
            retry.ok and retry.code == "ALREADY_CLEAN",
            retry.to_json(),
        )

        dry_root, _dry_instance, _ = clean_fixture("clean-dry")
        dry_before = surface_snapshot(dry_root)
        dry_clean = sub_clean(dry_root, "saihunt", dry_run=True)
        expect(
            "clean dry-run reports exact writes/deletes and changes zero bytes",
            dry_clean.ok
            and dry_clean.data.get("would_write")
            and dry_clean.data.get("would_delete")
            and dry_before == surface_snapshot(dry_root)
            and not (
                dry_root / ".saipen" / "recovery" / "subs" / "saihunt" / dry_clean.op_id
            ).exists(),
            dry_clean.to_json(),
        )

        open_root, open_instance, _ = clean_fixture("clean-open")
        (open_instance / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n- [ ] HUNT-1 open\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        open_before = surface_snapshot(open_root)
        open_clean = sub_clean(open_root, "saihunt")
        expect(
            "clean refuses open board work with zero writes",
            not open_clean.ok
            and open_clean.code == "VALIDATION_FAILED"
            and open_before == surface_snapshot(open_root),
            open_clean.to_json(),
        )
        (open_instance / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        (open_instance / "kitchen" / "OUTBOX.md").write_text(
            "# OUTBOX\n\n## HUNT-1: pending\n- **status:** ready\n", encoding="utf-8"
        )
        ready_before = surface_snapshot(open_root)
        ready_clean = sub_clean(open_root, "saihunt")
        expect(
            "clean refuses READY OUTBOX with zero writes",
            not ready_clean.ok
            and ready_clean.code == "VALIDATION_FAILED"
            and ready_before == surface_snapshot(open_root),
            ready_clean.to_json(),
        )

        stale_root, stale_instance, _ = clean_fixture("clean-stale-manifest")
        stale_manifest = stale_root / MANIFEST_REL
        stale_raw = stale_manifest.read_bytes()
        ops_before = set((stale_root / ".saipen" / "recovery" / "ops").iterdir())
        with mock.patch(
            "saipen_engine.subs.project_writer_lock",
            lambda _root: MutatingLock(lambda: stale_manifest.write_bytes(stale_raw + b"\n")),
        ):
            stale_clean = sub_clean(stale_root, "saihunt")
        ops_after = set((stale_root / ".saipen" / "recovery" / "ops").iterdir())
        expect(
            "clean stale MANIFEST CAS refuses before journal/archive writes",
            not stale_clean.ok
            and stale_clean.code == "STALE_STATE"
            and ops_before == ops_after
            and stale_instance.is_dir(),
            stale_clean.to_json(),
        )

        tree_root, tree_instance, _ = clean_fixture("clean-stale-tree")
        tree_ops_before = set((tree_root / ".saipen" / "recovery" / "ops").iterdir())
        foreign = tree_instance / "foreign.txt"
        with mock.patch(
            "saipen_engine.subs.project_writer_lock",
            lambda _root: MutatingLock(lambda: foreign.write_bytes(b"foreign\n")),
        ):
            tree_clean = sub_clean(tree_root, "saihunt")
        tree_ops_after = set((tree_root / ".saipen" / "recovery" / "ops").iterdir())
        expect(
            "clean stale instance-tree CAS refuses before cleanup writes",
            not tree_clean.ok
            and tree_clean.code == "STALE_STATE"
            and tree_ops_before == tree_ops_after
            and foreign.is_file(),
            tree_clean.to_json(),
        )

        from saipen_engine import journal as clean_journal
        from saipen_engine.journal import pending_ops as clean_pending, recover

        def crash_clean(label: str, crash_key: str):
            project, instance, _spawned = clean_fixture(label)

            def injected(key: str):
                if key == crash_key:
                    raise RuntimeError(f"crash after {crash_key}")

            crashed = False
            with mock.patch.object(clean_journal, "_crash_after", side_effect=injected):
                try:
                    sub_clean(project, "saihunt")
                except RuntimeError:
                    crashed = True
            pending = clean_pending(project)
            recovered = recover(project, pending[0]["op_id"]) if pending else {}
            return project, instance, crashed, pending, recovered

        crash_manifest = crash_clean("clean-crash-manifest", "manifest")
        expect(
            "clean crash after MANIFEST recovers to same final state",
            crash_manifest[2]
            and len(crash_manifest[3]) == 1
            and crash_manifest[4].get("ok")
            and not crash_manifest[1].exists()
            and "- saihunt --"
            not in (crash_manifest[0] / MANIFEST_REL).read_text(encoding="utf-8"),
            repr(crash_manifest[4]),
        )
        crash_delete = crash_clean("clean-crash-delete", "delete_file")
        expect(
            "clean crash after first deletion recovers to same final state",
            crash_delete[2]
            and len(crash_delete[3]) == 1
            and crash_delete[4].get("ok")
            and not crash_delete[1].exists()
            and "- saihunt --" not in (crash_delete[0] / MANIFEST_REL).read_text(encoding="utf-8"),
            repr(crash_delete[4]),
        )

        escape_root, _escape_instance, _ = clean_fixture("clean-escape")
        escape_manifest = escape_root / MANIFEST_REL
        escape_manifest.write_text(
            escape_manifest.read_text(encoding="utf-8").replace(
                f"{SUBS_REL}/saihunt/", "../outside/saihunt/"
            ),
            encoding="utf-8",
        )
        escape_before = surface_snapshot(escape_root)
        escaped = sub_clean(escape_root, "saihunt")
        expect(
            "clean rejects manifest path escape with zero writes",
            not escaped.ok
            and escaped.code == "INVALID_MANIFEST"
            and escape_before == surface_snapshot(escape_root),
            escaped.to_json(),
        )

        # 8. CREW FIXED-POINT (hostile controls 9/10): one blocked role
        # blocks terminal SC; the plan derives the FIRST unsatisfied stage.
        base = Path(raw) / "crew"
        seed_project(base)
        for name in ("saihunt", "saitest", "saipython", "saiui", "saiwiki"):
            spawn = sub_spawn(base, name, home.as_posix())
            expect(f"crew-probe spawn {name}", spawn.ok, spawn.message)
        plan = crew_plan(base)
        expect(
            "crew plan derives the circuit",
            bool(plan.get("stages"))
            and plan.get("first_unsatisfied") == "SC-2"
            and plan.get("crew_complete") is False
            and (plan.get("action") or {}).get("action") == "RUN_ROLE",
            "crew plan did not derive an unsatisfied circuit",
        )
        expect(
            "crew plan names the first unsatisfied stage",
            plan.get("first_unsatisfied") == "SC-2",
            f"got {plan.get('first_unsatisfied')}",
        )
        gate = crew_gate_problems(base)
        expect(
            "--gate crew FAILs with unresolved role work",
            any("saihunt" in p for p in gate),
            f"gate problems={gate}",
        )
        # One role blocked => terminal SC impossible.
        (base / SUBS_REL / "saihunt" / "BOARD.md").write_text(
            "# Board\n\n## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n- [ ] HUNT-1 blocked\n",
            encoding="utf-8",
        )
        gate = crew_gate_problems(base)
        expect(
            "blocked role keeps --gate crew red",
            any("SC-2" in p or "saihunt" in p for p in gate),
            f"gate={gate}",
        )

        # 9. FULL POSITIVE WITNESS. Facts live under .saipen, which source
        # identity intentionally excludes; one immutable source triple binds
        # every package in each planner pass. The fixture drives the REAL
        # engine flow (sub_spawn -> sub_collect -> terminal ticket ->
        # sub_disposition) so every receipt is strict-decoder-valid, and
        # hand-written receipts (crew_run, producer_integration, release)
        # carry the full settled-record shape.
        pre = Path(raw) / "crew-positive-pre"
        seed_project(pre)
        durable = ("saihunt", "saitest", "saipython", "saiui", "saiwiki")
        for name in durable:
            spawned = sub_spawn(pre, name, home.as_posix())
            expect(f"positive fixture spawn {name}", spawned.ok, spawned.message)
            state_path = pre / SUBS_REL / name / "STATE.md"
            text = state_path.read_text(encoding="utf-8")
            text = text.replace("phase: PLAN", "phase: DONE")
            text = text.replace("transition_from: INIT", "transition_from: PLAN")
            state_path.write_text(text, encoding="utf-8")
            (pre / SUBS_REL / name / "BOARD.md").write_text(
                "# Board\n\n## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n", encoding="utf-8"
            )

        pre_source = compute_source_identity(pre)

        def fixture_op_receipt(
            root: Path, op_id: str, operation: str, created_at: str, meta: dict | None = None
        ) -> dict:
            """A strict-decoder-valid settled journal receipt carrying the
            same record shape real engine ops commit (T-1003 sweep)."""
            from saipen_engine.paths import (
                project_identity as _proj_identity,
                project_lineage_identity,
            )

            receipt = {
                "op_id": op_id,
                "operation": operation,
                "status": "COMMITTED",
                "created_at": created_at,
                "agent": "probe",
                "project_identity": _proj_identity(root),
                "project_lineage": project_lineage_identity(root),
                "semantic_payload_hash": "sha256:fixture",
                "verification_policy": "none",
                "preconditions": {},
                "read_preconditions": {},
                "progress_index": 1,
                "targets": [
                    {
                        "path": ".saipen/LOG.md",
                        "role": "log",
                        "action": "write",
                        "before_hash": "",
                        "after_hash": "",
                        "applied": True,
                    }
                ],
            }
            if meta is not None:
                meta = dict(meta)
                if operation == "crew_defer":
                    meta.setdefault("project_identity", receipt["project_identity"])
                    meta.setdefault("project_lineage", receipt["project_lineage"])
                receipt["receipt_metadata"] = meta
            receipt_dir = root / ".saipen" / "recovery" / "ops" / op_id
            receipt_dir.mkdir(parents=True, exist_ok=True)
            (receipt_dir / "operation.json").write_text(
                json.dumps(receipt, indent=2), encoding="utf-8"
            )
            return receipt

        package_ids = {
            "saihunt": "HUNT-900",
            "saitest": "TEST-900",
            "saipython": "PY-900",
            "saiui": "UI-900",
            "saiwiki": "W-900",
            "saitranslate": "SAIT-900",
        }

        def package_text(
            name: str, package_id: str, status: str, instructions: str, source=pre_source
        ) -> str:
            revision = current_local_role_revision(pre, name, home.as_posix())
            return (
                f"# OUTBOX\n\n## {package_id}: complete evidence\n"
                f"- **status:** {status}\n- **producer:** {name}\n"
                f"- **source_head:** {source.source_head}\n"
                f"- **source_tree_fingerprint:** "
                f"{source.source_tree_fingerprint}\n"
                f"- **role_revision:** {revision}\n"
                "- **coverage:** complete role surface\n"
                "- **payload:** []\n- **verified:** PASS -- probe\n"
                f"- **instructions:** {instructions}\n"
            )

        def package_identity_of(text: str, name: str) -> str:
            model = parse_outbox(text, name)
            if model.errors:
                raise AssertionError(f"fixture OUTBOX invalid for {name}: {model.errors}")
            return package_identity(model.packages[0])

        def outbox_rel(name: str) -> str:
            return (
                ".saipen/saitranslate/kitchen/OUTBOX.md"
                if name == "saitranslate"
                else f"{SUBS_REL}/{name}/kitchen/OUTBOX.md"
            )

        def write_outbox(root: Path, name: str, text: str) -> None:
            target = root / outbox_rel(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")

        def intake_and_dispose(root: Path, name: str) -> str:
            """REAL engine intake + review for one role: sub_collect, the
            linked Core review ticket made terminal on BOARD, then
            sub_disposition. Returns the reviewed OUTBOX text the
            disposition wrote (its identity is the durable evidence)."""
            collected = sub_collect(root, name)
            if not (collected.ok and collected.code == "SUB_COLLECTED"):
                raise AssertionError(f"fixture collect {name} failed: " + collected.to_json())
            board_lines = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8").splitlines()
            hypothesis = next(
                line
                for line in board_lines
                if line.startswith("- [ ] T-") and "Review SubSaipen hypothesis" in line
            )
            board_lines.remove(hypothesis)
            board_lines.insert(
                board_lines.index("## DONE") + 1, hypothesis.replace("[ ]", "[x]", 1)
            )
            (root / ".saipen" / "BOARD.md").write_text(
                "\n".join(board_lines) + "\n", encoding="utf-8"
            )
            disposed = sub_disposition(root, name)
            if not (disposed.ok and disposed.code == "SUB_DISPOSITIONED"):
                raise AssertionError(f"fixture disposition {name} failed: " + disposed.to_json())
            return outbox_text(root, name)

        def outbox_text(root: Path, name: str) -> str:
            return (root / outbox_rel(name)).read_text(encoding="utf-8")

        def _rebind_release_identity(root: Path) -> None:
            """A copytree changes the project identity; the copied release
            receipt must bind the copy's live identity or the release
            engine refuses it as foreign evidence."""
            _release_doc = (
                root / ".saipen" / "recovery" / "ops" / "release-crewprobe" / "operation.json"
            )
            _release_record = json.loads(_release_doc.read_text(encoding="utf-8"))
            _release_record["project_identity"] = _proj_identity(root)
            _release_doc.write_text(json.dumps(_release_record, indent=2), encoding="utf-8")

        sensor_names = ("saihunt", "saitest", "saipython", "saiui")
        sensor_reviewed = {}
        for name in sensor_names:
            write_outbox(
                pre, name, package_text(name, package_ids[name], "ready", "Core reviews evidence")
            )
            sensor_reviewed[name] = intake_and_dispose(pre, name)

        # Producers: saiwiki stays READY (SC-1 roster gate must stay green),
        # translate starts READY; the B/C/D steps mutate them through the
        # real flow with matching integration receipts.
        write_outbox(
            pre,
            "saiwiki",
            package_text("saiwiki", package_ids["saiwiki"], "ready", "Core reviews evidence"),
        )
        write_outbox(
            pre,
            "saitranslate",
            package_text(
                "saitranslate", package_ids["saitranslate"], "ready", "leave READY at terminal"
            ),
        )

        # Canonical Core closure: no workable TODO, no DOING, no non-exempt
        # BLOCKED; the no-publish release ticket is DONE with verify evidence.
        core_board = (pre / ".saipen" / "BOARD.md").read_text(encoding="utf-8").splitlines()
        core_board.insert(
            core_board.index("## DONE") + 1, "- [x] T-900 crew release | verify: evidence"
        )
        (pre / ".saipen" / "BOARD.md").write_text("\n".join(core_board) + "\n", encoding="utf-8")
        core_state_path = pre / ".saipen" / "STATE.md"
        core_state = core_state_path.read_text(encoding="utf-8")
        core_state = core_state.replace("mode: full", "mode: no-publish")
        core_state = core_state.replace("phase: INIT", "phase: DONE")
        core_state = core_state.replace(
            'next_action: "saipen status"', 'next_action: "saipen continue"'
        )
        core_state_path.write_text(core_state, encoding="utf-8")

        from saipen_engine.operations import set_converge_intent

        entered = set_converge_intent(pre, "probe", "crew")
        expect("positive fixture crew intent entered canonically", entered.ok, entered.message)
        epoch_op = entered.op_id

        # Epoch-bound sensor certification: one crew_run receipt per sensor
        # binding the reviewed package identity to THIS crew epoch, through
        # the canonical producer (T-1430): a hand-written receipt has no
        # journaled LOG line and no longer counts.
        from saipen_engine.crew import crew_record_run

        for name in sensor_names:
            recorded = crew_record_run(pre, "probe", name)
            expect(
                f"positive fixture crew run recorded for {name}",
                recorded.ok and recorded.data.get("crew_epoch") == epoch_op,
                recorded.message or str(recorded.data),
            )

        def integration_receipt(root: Path, name: str, text: str, created_at: str) -> str:
            identity = package_identity_of(text, name)
            fixture_op_receipt(
                root,
                f"prod-integ-{name}-{identity[7:15]}",
                "producer_integration",
                created_at,
                meta={
                    "operation": "producer_integration",
                    "status": "COMMITTED",
                    "producer": name,
                    "package_identity": identity,
                    "input_source": pre_source.source_head,
                    "input_source_fingerprint": pre_source.source_tree_fingerprint,
                    "resulting_source": pre_source.source_head,
                    "resulting_source_fingerprint": pre_source.source_tree_fingerprint,
                    "crew_epoch": epoch_op,
                },
            )
            return identity

        integration_receipt(pre, "saiwiki", outbox_text(pre, "saiwiki"), "2026-08-13T00:00:04Z")
        integration_receipt(
            pre, "saitranslate", outbox_text(pre, "saitranslate"), "2026-08-13T00:00:05Z"
        )

        # SC-7 canonical E-I convergence chain against the current source:
        # test gate E, forced HUNT F, CLEAN G (with resulting identity),
        # post-clean test H, final HUNT I -- verdicts from the closed sets.
        def convergence_receipt(
            op_id: str,
            event: int,
            stage: str,
            verdict: str,
            created_at: str,
            resulting: tuple[str, str] | None = None,
        ) -> None:
            meta = {
                "operation": "convergence_stage",
                "status": "COMMITTED",
                "stage": stage,
                "verdict": verdict,
                "event_id": f"E-{event}",
                "source_head": pre_source.source_head,
                "source_tree_fingerprint": pre_source.source_tree_fingerprint,
            }
            if resulting is not None:
                meta["resulting_source_head"] = resulting[0]
                meta["resulting_source_tree_fingerprint"] = resulting[1]
            fixture_op_receipt(pre, op_id, "convergence_stage", created_at, meta=meta)

        convergence_receipt("conv-e-test", 100, "E", "PASS", "2026-08-13T00:00:06Z")
        convergence_receipt("conv-f-hunt", 101, "F", "CLEAN", "2026-08-13T00:00:07Z")
        convergence_receipt(
            "conv-g-clean",
            102,
            "G",
            "COMPLETED",
            "2026-08-13T00:00:08Z",
            resulting=(pre_source.source_head, pre_source.source_tree_fingerprint),
        )
        convergence_receipt("conv-h-test", 103, "H", "PASS", "2026-08-13T00:00:09Z")
        convergence_receipt("conv-i-hunt", 104, "I", "CLEAN", "2026-08-13T00:00:10Z")

        # SC-7 attribution (no-git tree): a committed crew_defer receipt
        # claiming a path that never mutates again after pre, so the
        # no-git attribution gate has a provable claim.
        import hashlib as _hashlib

        claim_rel = f"{SUBS_REL}/saihunt/STATE.md"
        fixture_op_receipt(
            pre,
            "crew-defer-fixture",
            "crew_defer",
            "2026-08-13T00:00:11Z",
            meta={
                "operation": "crew_defer",
                "status": "COMMITTED",
                "ticket_id": "T-900",
                "crew_epoch": epoch_op,
                "paths": {
                    claim_rel: _hashlib.sha256((pre / claim_rel).read_bytes()).hexdigest()[:16]
                },
            },
        )

        plan_a = crew_plan(pre)
        if plan_a.get("action") is None:
            print("PLAN_A IS NONE! STAGES:", json.dumps(plan_a.get("stages", []), indent=2))
            print("PLAN_A:", json.dumps(plan_a, indent=2))
            from saipen_engine.crew import crew_snapshot

            print("ROLES:", json.dumps(crew_snapshot(pre).roles, indent=2))
        expect(
            "A perfect pre-ship fixed point routes exactly to SHIP",
            (plan_a.get("action") or {}).get("action") == "SHIP",
            repr(plan_a.get("action")),
        )

        post = Path(raw) / "crew-positive-post"
        shutil.copytree(pre, post)
        from saipen_engine.paths import project_identity as _proj_identity

        receipt = post / ".saipen" / "recovery" / "ops" / "release-crewprobe" / "operation.json"
        receipt.parent.mkdir(parents=True)
        receipt.write_text(
            json.dumps(
                {
                    "op_id": "release-crewprobe",
                    "operation": "release",
                    "created_at": "2099-01-01T00:00:00Z",
                    "status": "COMMITTED",
                    "agent": "probe",
                    "project_identity": _proj_identity(post),
                    "semantic_payload_hash": "sha256:fixture",
                    "verification_policy": "none",
                    "preconditions": {},
                    "read_preconditions": {},
                    "progress_index": 1,
                    "targets": [
                        {
                            "path": ".saipen/LOG.md",
                            "role": "log",
                            "action": "write",
                            "before_hash": "",
                            "after_hash": "",
                            "applied": True,
                        }
                    ],
                    "release_stage": "COMMITTED",
                    "mode": "no-publish",
                    "ticket_id": "T-900",
                    "tag": "v9.9.9",
                    "source_head": pre_source.source_head,
                    "source_tree_fingerprint": pre_source.source_tree_fingerprint,
                    "closure_commit": pre_source.source_head,
                    "stages": [
                        "CONTENT_COMMIT_CREATED",
                        "CONTENT_PUBLISHED",
                        "CLOSURE_COMMIT_CREATED",
                        "CLOSURE_PUBLISHED",
                        "TAG_CREATED",
                        "TAG_PUBLISHED",
                        "REMOTE_VERIFIED",
                    ],
                    "crew_epoch": entered.op_id,
                    "crew_pre_ship_evidence": {
                        name: [{"package_id": package_ids[name], "status": "reviewed"}]
                        for name in (*durable, "saitranslate")
                    },
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        def reviewed_variant(text: str) -> str:
            replaced = text.replace("- **status:** ready\n", "- **status:** reviewed\n")
            if replaced == text:
                raise AssertionError("fixture reviewed variant no-op")
            return replaced

        def write_post_package(name: str, text: str, stamp: str) -> None:
            write_outbox(post, name, text)
            integration_receipt(post, name, text, stamp)

        translate_ready_text = outbox_text(pre, "saitranslate")
        wiki_ready_text = outbox_text(pre, "saiwiki")
        write_post_package(
            "saitranslate", reviewed_variant(translate_ready_text), "2026-08-14T00:00:00Z"
        )
        plan_b = crew_plan(post)
        expect(
            "B post-ship except EE routes PREPARE_TRANSLATE_FINAL",
            (plan_b.get("action") or {}).get("action") == "PREPARE_TRANSLATE_FINAL",
            repr(plan_b.get("action")),
        )
        write_post_package("saitranslate", translate_ready_text, "2026-08-14T00:00:01Z")
        # C: QQ turns current READY; EE (wiki) becomes CURRENT through
        # durable evidence -- a COMMITTED collect receipt binding the
        # reviewed package identity to a terminal Core review ticket plus
        # the reviewed claim and its integration edge -- so SC-1 and SC-9
        # stay green while ready_current falls (reviewed != ready).
        wiki_reviewed_text = reviewed_variant(wiki_ready_text)
        write_outbox(post, "saiwiki", wiki_reviewed_text)
        wiki_reviewed_identity = package_identity_of(wiki_reviewed_text, "saiwiki")
        fixture_op_receipt(
            post,
            "collect-saiwiki-c",
            "sub_collect",
            "2026-08-14T00:00:02Z",
            meta={
                "operation": "sub_collect",
                "status": "COMMITTED",
                "package_identities": [wiki_reviewed_identity],
                "producers": ["saiwiki"],
                "tickets": ["T-3500"],
            },
        )
        wiki_board = (post / ".saipen" / "BOARD.md").read_text(encoding="utf-8").splitlines()
        wiki_board.insert(
            wiki_board.index("## DONE") + 1, "- [x] T-3500 review saiwiki | verify: evidence"
        )
        (post / ".saipen" / "BOARD.md").write_text("\n".join(wiki_board) + "\n", encoding="utf-8")
        integration_receipt(post, "saiwiki", wiki_reviewed_text, "2026-08-14T00:00:03Z")
        plan_c = crew_plan(post)
        expect(
            "C EE current and QQ stale routes PREPARE_WIKI_FINAL",
            (plan_c.get("action") or {}).get("action") == "PREPARE_WIKI_FINAL",
            repr(plan_c.get("action")),
        )
        write_post_package("saiwiki", wiki_ready_text, "2026-08-14T00:00:04Z")
        plan_d = crew_plan(post)
        ready_d, ready_problems = crew_ready_to_finalize(post)
        expect(
            "D all-green active crew plan is reachable",
            plan_d.get("ok") is True and ready_d,
            f"plan={plan_d} problems={ready_problems}",
        )

        # A snapshot must bind every role artifact it used. Mutating final EE
        # immediately after its read must route SC-0 to STALE_PLAN rather than
        # combine old parsed evidence with new live bytes.
        snapshot_race = Path(raw) / "crew-positive-snapshot-race"
        shutil.copytree(post, snapshot_race)
        from saipen_engine import crew as crew_engine

        translate_race = snapshot_race / ".saipen" / "saitranslate" / "kitchen" / "OUTBOX.md"
        original_crew_read = crew_engine._read_maybe
        moved = {"done": False}

        def moving_evidence(path: Path) -> str:
            text = original_crew_read(path)
            if Path(path) == translate_race and not moved["done"]:
                moved["done"] = True
                translate_race.write_text(
                    text.replace("PASS -- probe", "PASS -- probe MOVED"), encoding="utf-8"
                )
            return text

        with mock.patch.object(crew_engine, "_read_maybe", side_effect=moving_evidence):
            raced_plan = crew_engine.crew_plan(snapshot_race)
        expect(
            "moving role evidence makes the crew snapshot STALE_PLAN",
            moved["done"]
            and raced_plan.get("first_unsatisfied") == "SC-0"
            and "STALE_PLAN" in raced_plan["stages"][0].get("reason", ""),
            repr(raced_plan.get("stages", [])[:2]),
        )

        # The pending-op scan belongs before the closing dependency hash too.
        # If an op vanishes while that scan runs, the snapshot must be stale;
        # reading pending state after the barrier could falsely finalize.
        pending_race = Path(raw) / "crew-positive-pending-race"
        shutil.copytree(post, pending_race)
        vanishing_dir = pending_race / ".saipen/recovery/ops" / "vanishing-op"
        vanishing_dir.mkdir(parents=True)
        vanishing_receipt = vanishing_dir / "operation.json"
        vanishing_receipt.write_text(
            json.dumps(
                {
                    "op_id": "vanishing-op",
                    "operation": "probe",
                    "status": "PREPARED",
                    "targets": [],
                }
            ),
            encoding="utf-8",
        )

        def remove_during_pending(_root):
            vanishing_receipt.unlink()
            vanishing_dir.rmdir()
            return []

        with mock.patch.object(crew_engine, "pending_ops", side_effect=remove_during_pending):
            pending_plan = crew_engine.crew_plan(pending_race)
        expect(
            "pending-op movement before the closing hash is STALE_PLAN",
            pending_plan.get("first_unsatisfied") == "SC-0"
            and "STALE_PLAN" in pending_plan["stages"][0].get("reason", ""),
            repr(pending_plan.get("stages", [])[:2]),
        )

        # shared_contract_status derives its green ownership verdict from one
        # exact sub-sync receipt. The whole ops tree cannot be a finalizer CAS
        # dependency because the finalizer creates its own op there, so the
        # selected receipt must be bound by path and bytes instead. Removing
        # or mutating it after the snapshot must touch zero Core bytes.
        from saipen_engine import plan as plan_engine

        real_writer_lock = plan_engine.project_writer_lock

        sync_drop_race = Path(raw) / "crew-positive-sync-receipt-drop"
        shutil.copytree(post, sync_drop_race)
        _rebind_release_identity(sync_drop_race)
        drop_status = shared_contract_status(sync_drop_race, home.as_posix())
        drop_receipt = sync_drop_race / drop_status["inventory_receipt_path"]
        drop_core_before = (
            (sync_drop_race / ".saipen/LOG.md").read_bytes(),
            (sync_drop_race / ".saipen/STATE.md").read_bytes(),
        )

        @contextlib.contextmanager
        def drop_receipt_before_apply(lock_root):
            raw_receipt = drop_receipt.read_bytes()
            drop_receipt.unlink()
            try:
                with real_writer_lock(lock_root):
                    yield
            finally:
                drop_receipt.write_bytes(raw_receipt)

        with mock.patch.object(plan_engine, "project_writer_lock", drop_receipt_before_apply):
            refused_drop = finalize_crew(sync_drop_race)
        drop_core_after = (
            (sync_drop_race / ".saipen/LOG.md").read_bytes(),
            (sync_drop_race / ".saipen/STATE.md").read_bytes(),
        )
        expect(
            "finalizer CAS refuses missing sub-sync ownership receipt",
            not refused_drop.ok
            and refused_drop.code == "STALE_STATE"
            and drop_core_before == drop_core_after,
            refused_drop.to_json(),
        )

        sync_mutate_race = Path(raw) / "crew-positive-sync-receipt-mutate"
        shutil.copytree(post, sync_mutate_race)
        _rebind_release_identity(sync_mutate_race)
        mutate_status = shared_contract_status(sync_mutate_race, home.as_posix())
        mutate_receipt = sync_mutate_race / mutate_status["inventory_receipt_path"]
        mutate_core_before = (
            (sync_mutate_race / ".saipen/LOG.md").read_bytes(),
            (sync_mutate_race / ".saipen/STATE.md").read_bytes(),
        )

        @contextlib.contextmanager
        def mutate_receipt_before_apply(lock_root):
            raw_receipt = mutate_receipt.read_bytes()
            mutate_receipt.write_bytes(raw_receipt + b"\n")
            try:
                with real_writer_lock(lock_root):
                    yield
            finally:
                mutate_receipt.write_bytes(raw_receipt)

        with mock.patch.object(plan_engine, "project_writer_lock", mutate_receipt_before_apply):
            refused_mutation = finalize_crew(sync_mutate_race)
        mutate_core_after = (
            (sync_mutate_race / ".saipen/LOG.md").read_bytes(),
            (sync_mutate_race / ".saipen/STATE.md").read_bytes(),
        )
        expect(
            "finalizer CAS refuses mutated sub-sync ownership receipt",
            not refused_mutation.ok
            and refused_mutation.code == "STALE_STATE"
            and mutate_core_before == mutate_core_after,
            refused_mutation.to_json(),
        )

        # A change after the green snapshot but before APPLY is the other side
        # of the race. The finalizer passes exact evidence preconditions into
        # the journal, so it must refuse before touching Core LOG/STATE.
        finalize_race = Path(raw) / "crew-positive-finalize-race"
        shutil.copytree(post, finalize_race)
        _rebind_release_identity(finalize_race)
        wiki_race = finalize_race / SUBS_REL / "saiwiki" / "kitchen" / "OUTBOX.md"
        core_before = (
            (finalize_race / ".saipen/LOG.md").read_bytes(),
            (finalize_race / ".saipen/STATE.md").read_bytes(),
        )
        real_writer_lock = plan_engine.project_writer_lock

        @contextlib.contextmanager
        def drift_before_apply(lock_root):
            wiki_race.write_text(
                wiki_race.read_text(encoding="utf-8").replace(
                    "PASS -- probe", "PASS -- probe DRIFT"
                ),
                encoding="utf-8",
            )
            with real_writer_lock(lock_root):
                yield

        with mock.patch.object(plan_engine, "project_writer_lock", drift_before_apply):
            refused_finalize = finalize_crew(finalize_race)
        core_after = (
            (finalize_race / ".saipen/LOG.md").read_bytes(),
            (finalize_race / ".saipen/STATE.md").read_bytes(),
        )
        expect(
            "finalizer CAS refuses evidence drift with zero Core writes",
            not refused_finalize.ok
            and refused_finalize.code == "STALE_STATE"
            and core_before == core_after,
            refused_finalize.to_json(),
        )

        # The finalizer intentionally promotes one snapshot dependency from
        # READ-missing (file-missing-v1) to WRITE-missing (""). That token
        # normalization must not authorize a file another writer creates
        # between PLAN and APPLY.
        target_race = Path(raw) / "crew-positive-finalize-target-race"
        shutil.copytree(post, target_race)
        _rebind_release_identity(target_race)
        future_evidence = target_race / ".saipen/kitchen/crew_release_evidence.json"
        target_core_before = (
            (target_race / ".saipen/LOG.md").read_bytes(),
            (target_race / ".saipen/STATE.md").read_bytes(),
        )

        @contextlib.contextmanager
        def create_future_target_before_apply(lock_root):
            future_evidence.write_text("foreign writer\n", encoding="utf-8")
            with real_writer_lock(lock_root):
                yield

        with mock.patch.object(
            plan_engine,
            "project_writer_lock",
            create_future_target_before_apply,
        ):
            refused_target_race = finalize_crew(target_race)
        target_core_after = (
            (target_race / ".saipen/LOG.md").read_bytes(),
            (target_race / ".saipen/STATE.md").read_bytes(),
        )
        expect(
            "finalizer CAS refuses concurrent creation of promoted evidence target",
            not refused_target_race.ok
            and refused_target_race.code == "STALE_STATE"
            and target_core_before == target_core_after
            and future_evidence.read_text(encoding="utf-8") == "foreign writer\n",
            refused_target_race.to_json(),
        )

        finalized = finalize_crew(post)
        final_state = parse_state(codec.read_doc(post / ".saipen" / "STATE.md"))
        expect(
            "E finalizer clears target and returns normal DONE",
            finalized.ok
            and final_state.get("execution_intent") == "normal"
            and "converge_target" not in final_state
            and final_state.get("phase") == "DONE",
            f"result={finalized.to_dict()} state={final_state}",
        )
        final_gate = crew_gate_problems(post)
        expect("E finalized all-green crew gate passes", not final_gate, repr(final_gate))
        cold_plan = crew_plan(Path(str(post)))
        cold_gate = crew_gate_problems(Path(str(post)))
        expect(
            "F cold re-read derives same terminal answer",
            cold_plan.get("finalized") is True
            and (cold_plan.get("action") or {}).get("action") == "DONE"
            and not cold_gate,
            f"plan={cold_plan} gate={cold_gate}",
        )

        # Intent-family and router controls: no field from an old family may
        # survive, and active ticket continuation outranks outer crew routing.
        from saipen_engine.state import transition_execution_intent
        from saipen_engine.router import route_next

        base_state = (
            '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
            "transition_from: DONE\n"
            'blocker: ""\nagent: probe\nsaipen_version: 7\nmode: full\n'
            "updated: 2026-01-01T00:00:00Z\nexecution_intent: goal\n"
            "goal_waves: 1\ngoal_tickets: 7\n---\n"
        )
        converged = transition_execution_intent(base_state, "converge", "crew")
        parsed_converged = parse_state(converged)
        expect(
            "goal -> converge/crew drops both goal counters",
            parsed_converged.get("converge_target") == "crew"
            and "goal_waves" not in parsed_converged
            and "goal_tickets" not in parsed_converged,
            repr(parsed_converged),
        )
        normal = transition_execution_intent(converged, "normal")
        parsed_normal = parse_state(normal)
        expect(
            "crew -> normal terminal drops converge target",
            parsed_normal.get("execution_intent") == "normal"
            and "converge_target" not in parsed_normal,
            repr(parsed_normal),
        )
        active_state = (
            converged.replace("phase: DONE", "phase: VERIFY")
            .replace("transition_from: DONE", "transition_from: BUILD")
            .replace("task: none", "task: T-1")
            .replace('next_action: "saipen continue"', 'next_action: "RUN: binding tests"')
        )
        # The DOING line carries this session's own claim. Without it the
        # ticket is UNCLAIMED, and since b2343541 (router.py, "carries no live
        # claim of this session's own") an unclaimed active ticket routes to
        # adoption whether or not STATE.task names it -- deliberately, because
        # the old rule fired only at `task: none` and let a stale foreign owner
        # reach the ordinary FINISH branch. This fixture predates that contract
        # (94814c73, v7.224.0) and its point is continuation vs outer crew
        # routing, not whether an unowned ticket may be continued.
        active_board = (
            "# Board\n## DOING\n- [/] T-1 work | owner: probe "
            "| claim_time: 2026-01-01T00:00:00Z\n## TODO\n## DONE\n## BLOCKED\n"
        )
        active_route = route_next(active_state, active_board)
        idle_route = route_next(converged, "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n")
        expect(
            "active ticket keeps exact continuation under crew target",
            active_route.get("action") == "RUN: binding tests",
            repr(active_route),
        )
        expect(
            "cold idle continuation resumes crew from intent semantics",
            idle_route.get("action") == "saipen crew",
            repr(idle_route),
        )

    return problems, checked


def live_style_marker() -> str:
    """STYLE.md's declared boot marker, read the way an agent reads it.

    Never hardcoded: a pinned token silently turns the marker fixtures into a
    pair of always-failing states the moment STYLE.md is edited, which is the
    opposite of what they check.
    """
    text = (HOME / "saipen" / "STYLE.md").read_text(encoding="utf-8-sig")
    found = re.search(r"`style_contract:\s*(ded-[0-9a-f]{8})`", text)
    return found.group(1) if found else "ded-00000000"


def run_manifest_tracking_probes() -> tuple[list[str], int]:
    """A runtime-manifest entry must be in the repository, not just on disk.

    Needs a real repository for the same reason the hunt-mark probe does, so
    it cannot live in `tools/audit_checks.py`, whose snapshot excludes `.git`.
    The mutation removes one manifest file from the index and leaves it on
    disk -- exactly the state that shipped green locally and red in CI.
    """
    problems: list[str] = []
    checked = 0
    victim = "tools/audit_floor.py"

    with tempfile.TemporaryDirectory(prefix="saipen-manifest-") as raw:
        home = Path(raw) / "home"
        shutil.copytree(
            HOME,
            home,
            ignore=shutil.ignore_patterns(
                ".git", ".venv", "__pycache__", "node_modules", "nul", ".freebuff"
            ),
        )
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "probe",
            "GIT_AUTHOR_EMAIL": "probe@example.invalid",
            "GIT_COMMITTER_NAME": "probe",
            "GIT_COMMITTER_EMAIL": "probe@example.invalid",
        }

        def git(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["git", *args], cwd=home, env=env, capture_output=True, text=True, check=False
            )

        if git("init", "-q").returncode != 0:
            print("SKIP: manifest tracking probes -- git unavailable")
            return problems, checked
        git("add", "-A")
        git("commit", "-q", "-m", "probe")

        def validate() -> str:
            r = subprocess.run(
                [sys.executable, str(home / "tools" / "validate.py"), "--project-root", str(home)],
                cwd=home,
                capture_output=True,
                text=True,
                errors="replace",
            )
            return r.stdout + r.stderr

        def expect(label: str, output: str, contains: str) -> None:
            nonlocal checked
            checked += 1
            if contains not in output:
                problems.append(f"{label}: missing {contains!r}")
            else:
                print(f"PASS: manifest tracking -- {label}")

        # Copy-tree noise is ignored only by the binding SHIP gate, which
        # validates the exact release index. The ordinary/core validator must
        # still expose it because direct injectors copy the complete live tree.
        foreign_tree_file = home / "tools" / "foreign_untracked_runtime.py"
        foreign_tree_file.write_text("# foreign probe\n", encoding="utf-8", newline="\n")
        expect(
            "an untracked copy-tree member stays visible outside SHIP",
            validate(),
            "names a file git does not track: tools/foreign_untracked_runtime.py",
        )
        foreign_tree_file.unlink()

        git("rm", "-q", "--cached", victim)
        git("commit", "-q", "-m", "drop from index, keep on disk")
        expect(
            "an untracked manifest file fails",
            validate(),
            f"names a file git does not track: {victim}",
        )

        git("add", victim)
        git("commit", "-q", "-m", "restore")
        expect("the same file tracked again passes", validate(), "runtime manifest complete")

    return problems, checked


def run_lint_parity_probes() -> tuple[list[str], int]:
    """T-628: local-doc vs CI lint surface + ruff pin must stay in one voice.

    harness.md documents the canonical lint command and the pinned ruff
    version; validate.yml must run exactly that. A surface divergence or a
    version drift is a reproducibility defect (a local host lints a different
    tree than CI, or an unpinned ruff shifts the rule set between runs), so
    the validator FAILs it -- these probes prove that check can go red.
    """
    problems: list[str] = []
    checked = 0
    harness = HOME / ".saipen" / "KNOWLEDGE" / "harness.md"
    ci = HOME / ".github" / "workflows" / "validate.yml"
    if not harness.is_file() or not ci.is_file():
        return ["lint parity probe could not find harness.md or validate.yml"], checked

    def validate(home: Path) -> str:
        r = subprocess.run(
            [sys.executable, str(home / "tools" / "validate.py"), "--project-root", str(home)],
            cwd=home,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=120,
        )
        return r.stdout + r.stderr

    def probe(label: str, mutation, contains: str) -> None:
        nonlocal checked
        checked += 1
        with tempfile.TemporaryDirectory(prefix="saipen-lint-parity-") as raw:
            home = Path(raw) / "home"
            shutil.copytree(
                HOME,
                home,
                ignore=shutil.ignore_patterns(
                    ".git", ".venv", "__pycache__", "node_modules", "nul", ".freebuff"
                ),
            )
            mutation(
                home / ".saipen" / "KNOWLEDGE" / "harness.md",
                home / ".github" / "workflows" / "validate.yml",
            )
            output = validate(home)
            if contains in output:
                print(f"PASS: lint parity -- {label}")
            else:
                problems.append(f"{label}: missing {contains!r}")
                print(f"FAIL: lint parity -- {label}")

    probe(
        "surface divergence fails the validator",
        lambda h, c: h.write_text(
            h.read_text(encoding="utf-8").replace(
                "python -m ruff check tools/ tests/", "python -m ruff check tools/"
            ),
            encoding="utf-8",
        ),
        "lint parity [T-628]",
    )
    probe(
        "ruff version drift fails the validator",
        lambda h, c: h.write_text(
            h.read_text(encoding="utf-8").replace("ruff==0.16.0", "ruff==0.17.0"), encoding="utf-8"
        ),
        "lint parity [T-628]",
    )
    probe(
        "unpinned CI ruff fails the validator",
        lambda h, c: c.write_text(
            c.read_text(encoding="utf-8").replace(
                "pip install --quiet ruff==0.16.0", "pip install --quiet ruff"
            ),
            encoding="utf-8",
        ),
        "lint parity [T-628]",
    )
    return problems, checked


def run_autoinject_manifest_probes() -> tuple[list[str], int]:
    """Every copied manifest surface must invalidate installed-copy stamps."""
    problems: list[str] = []
    checked = 0
    spec = importlib.util.spec_from_file_location(
        "saipen_autoinject_probe", HOME / "tools" / "autoinject.py"
    )
    if spec is None or spec.loader is None:
        return ["autoinject manifest probe could not load autoinject.py"], checked
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    with tempfile.TemporaryDirectory(prefix="saipen-autoinject-manifest-") as raw:
        clone = Path(raw)
        for tree in RUNTIME_MANIFEST["copy_trees"]:
            shutil.copytree(HOME / tree["src"], clone / tree["src"])
        for entry in RUNTIME_MANIFEST["files"]:
            if not entry.get("required", False):
                continue
            source = HOME / entry["src"]
            target = clone / entry["src"]
            if target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        module.HOME = clone

        first = module._digest()
        index = clone / "saipen" / "INDEX.md"
        index.write_text(
            index.read_text(encoding="utf-8") + "\nprobe\n", encoding="utf-8", newline="\n"
        )
        second = module._digest()
        checked += 1
        if first == second:
            problems.append("autoinject digest ignored manifest file saipen/INDEX.md")
        else:
            print("PASS: autoinject manifest -- INDEX.md invalidates digest")

        core = clone / "saipen" / "CORE.md"
        core.write_text(
            core.read_text(encoding="utf-8") + "\nprobe\n", encoding="utf-8", newline="\n"
        )
        third = module._digest()
        checked += 1
        if second == third:
            problems.append("autoinject digest ignored manifest file saipen/CORE.md")
        else:
            print("PASS: autoinject manifest -- CORE.md invalidates digest")

        manifest_path = clone / "saipen" / "MANIFEST.json"
        malformed = json.loads(manifest_path.read_text(encoding="utf-8"))
        malformed["copy_trees"][0]["src"] = "../outside"
        manifest_path.write_text(json.dumps(malformed), encoding="utf-8", newline="\n")
        checked += 1
        try:
            module._digest()
        except RuntimeError as exc:
            if "unsafe runtime manifest source" not in str(exc):
                problems.append(f"autoinject traversal failed unclearly: {exc}")
            else:
                print("PASS: autoinject manifest -- traversal source fails closed")
        else:
            problems.append("autoinject accepted ../ traversal in copy_trees source")

    return problems, checked


def run_hunt_mark_probes() -> tuple[list[str], int]:
    """Execute `phases/hunt.md`'s skip condition against a real repository.

    Lives here rather than in `tools/audit_checks.py` because that harness
    copies the tree WITHOUT `.git`, so a hash-resolution check is skipped
    there and its red control would report a green mutation -- an instrument
    measuring nothing while reporting a result.
    """
    problems: list[str] = []
    checked = 0

    def validate(project: Path) -> str:
        r = subprocess.run(
            [sys.executable, str(VALIDATOR), "--project-root", str(project)],
            cwd=project,
            capture_output=True,
            text=True,
            errors="replace",
        )
        return r.stdout + r.stderr

    def expect(label: str, output: str, contains: str, absent: str = "") -> None:
        nonlocal checked
        checked += 1
        details = []
        if contains not in output:
            details.append(f"missing {contains!r}")
        if absent and absent in output:
            details.append(f"unexpected {absent!r}")
        if details:
            problems.append(f"{label}: {'; '.join(details)}")
        else:
            print(f"PASS: hunt mark -- {label}")

    marker = "LOG.md records a clean hunt against commit(s)"
    with tempfile.TemporaryDirectory(prefix="saipen-hunt-mark-") as raw:
        project = Path(raw) / "project"
        shutil.copytree(SCENARIOS / "stale-state-reconciliation" / ".saipen", project / ".saipen")
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "probe",
            "GIT_AUTHOR_EMAIL": "probe@example.invalid",
            "GIT_COMMITTER_NAME": "probe",
            "GIT_COMMITTER_EMAIL": "probe@example.invalid",
        }

        def git(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["git", *args], cwd=project, env=env, capture_output=True, text=True, check=False
            )

        if git("init", "-q").returncode != 0:
            print("SKIP: hunt mark probes -- git unavailable")
            return problems, checked
        git("add", "-A")
        git("commit", "-q", "-m", "probe")
        head = git("rev-parse", "--short", "HEAD").stdout.strip()
        if not head:
            print("SKIP: hunt mark probes -- no commit to resolve against")
            return problems, checked

        log_path = project / ".saipen" / "LOG.md"
        base = log_path.read_text(encoding="utf-8-sig").rstrip("\n")

        def write_mark(short_hash: str) -> None:
            log_path.write_text(
                f"{base}\n- 26.07.17 00:01 [E-002] [parent: E-001] [T-001] "
                f"RUN: hunt -> clean @{short_hash}\n",
                encoding="utf-8",
                newline="\n",
            )

        write_mark("dead0be")
        expect("a mark no commit backs fails", validate(project), marker)

        write_mark(head)
        expect(
            "the exact HEAD mark passes",
            validate(project),
            "hunt skip marks resolve to real commits",
            absent=marker,
        )

        # T-528 rung: a commit that exists locally but has never reached a
        # remote must FAIL, even though the old check passes it -- this is
        # exactly the db9d775 gap, where a local run stayed green while CI,
        # a fresh clone of the identical tree, went red.
        bare = Path(raw) / "remote.git"
        git("init", "-q", "--bare", str(bare))
        git("remote", "add", "origin", str(bare))
        if git("push", "-q", "-u", "origin", "HEAD").returncode == 0:
            other = project / "scratch.txt"
            other.write_text("unpushed local-only commit\n", encoding="utf-8")
            git("add", "-A")
            git("commit", "-q", "-m", "probe: unpushed local-only commit")
            unpushed = git("rev-parse", "--short", "HEAD").stdout.strip()
            if unpushed:
                write_mark(unpushed)
                expect(
                    "a local-only commit fails (never reached a remote)",
                    validate(project),
                    "sit on no remote branch",
                )
                write_mark(head)
                expect(
                    "a remote-backed mark still passes after the stray",
                    validate(project),
                    "hunt skip marks resolve to real commits",
                    absent=marker,
                )

    return problems, checked


def run_ship_staging_probes() -> tuple[list[str], int]:
    """Execute T-569: a runtime file this ship adds passes the gate once staged.

    The paradox this closes was an ORDERING one, so the probe measures the same
    file at three states in one repository -- untracked, staged, committed --
    and the finding must appear at exactly one of them. Asserting only that an
    untracked file FAILs would have passed before the fix too, and asserting
    only that a committed file passes proves nothing about the window SHIP
    actually runs in.
    """
    problems: list[str] = []
    checked = 0
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "probe",
        "GIT_AUTHOR_EMAIL": "probe@example.invalid",
        "GIT_COMMITTER_NAME": "probe",
        "GIT_COMMITTER_EMAIL": "probe@example.invalid",
    }
    home = VALIDATOR.parent.parent
    manifest_path = home / "saipen" / "MANIFEST.json"
    if not manifest_path.is_file():
        print("SKIP: ship staging probes -- no runtime MANIFEST")
        return problems, checked

    def expect(label: str, condition: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if condition:
            print(f"PASS: ship staging -- {label}")
        else:
            problems.append(f"{label}: {detail}")

    with tempfile.TemporaryDirectory(prefix="saipen-ship-staging-") as tmp:
        home_copy = Path(tmp) / "home"
        shutil.copytree(
            home,
            home_copy,
            ignore=shutil.ignore_patterns(
                ".git", ".venv", "__pycache__", ".freebuff", "node_modules", "nul"
            ),
        )

        def git(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["git", *args], cwd=home_copy, env=env, capture_output=True, text=True, check=False
            )

        if git("init", "-q").returncode != 0:
            print("SKIP: ship staging probes -- git unavailable")
            return problems, checked
        git("add", "-A")
        git("commit", "-q", "-m", "probe: baseline")

        def untracked_names() -> set[str]:
            r = subprocess.run(
                [
                    sys.executable,
                    str(home_copy / "tools" / "validate.py"),
                    "--project-root",
                    str(home_copy),
                    "--gate",
                    "ship",
                ],
                cwd=home_copy,
                capture_output=True,
                text=True,
                errors="replace",
            )
            return {
                line.split(": ")[-1].split(" --")[0].strip()
                for line in (r.stdout + r.stderr).splitlines()
                if line.startswith("FAIL: runtime manifest names a file git does not track")
            }

        expect(
            "baseline home has no untracked runtime file",
            not untracked_names(),
            f"unexpected untracked entries: {sorted(untracked_names())}",
        )

        # A required runtime file added by the ticket being shipped.
        rel = "tools/probe_runtime_addition.py"
        (home_copy / rel).write_text("# probe runtime file\n", encoding="utf-8", newline="\n")
        manifest_copy = home_copy / "saipen" / "MANIFEST.json"
        data = json.loads(manifest_copy.read_text(encoding="utf-8"))
        entries = data.get("files")
        if not isinstance(entries, list) or not all(
            isinstance(item, dict) and "src" in item for item in entries
        ):
            print("SKIP: ship staging probes -- MANIFEST shape unrecognized")
            return problems, checked
        data["files"] = [*entries, {"src": rel, "required": True}]
        manifest_copy.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8", newline="\n")
        git("add", "--", "saipen/MANIFEST.json")
        git("commit", "-q", "-m", "probe: manifest names the new file")

        expect(
            "a required runtime file merely present untracked FAILs",
            rel in untracked_names(),
            "the gate accepted a manifest entry no clone would receive",
        )

        git("add", "--", rel)
        expect(
            "the same file staged for THIS ship satisfies the gate",
            rel not in untracked_names(),
            "staging is the step SHIP performs before its binding gate, so "
            "a staged file the manifest requires must pass -- otherwise no "
            "sequence the protocol describes can ever add one",
        )

        # The staged state is the one SHIP gates on; committing must not
        # change the answer, or the gate would be measuring the commit rather
        # than the scope that was reviewed.
        git("commit", "-q", "-m", "probe: the new runtime file")
        expect(
            "committing does not change the answer staging gave",
            rel not in untracked_names(),
            "the gate disagrees with itself across the commit boundary",
        )

        # Unstaging returns it to the failing state: the pass came from the
        # index, not from the file existing on disk.
        git("rm", "-q", "--cached", "--", rel)
        expect(
            "removing it from the index brings the FAIL back",
            rel in untracked_names(),
            "the gate passed on a file's presence on disk, which is the "
            "exact reading that ships a home no clone can reproduce",
        )

    return problems, checked


def neutralize_sandbox_work_surface(saipen_dir: Path) -> set[str]:
    """Drop DONE/DOING from a COPIED board and keep intake consistent with it.

    Probes that rebuild a fixture from the live project cut LOG history, so the
    copied DONE tickets no longer carry the closure evidence their own gate
    demands. Emptying those two sections is the established fix; TODO/BLOCKED
    survive verbatim because the release-history WARN-ownership rule needs live
    owners for aged warning slugs and those live there.

    T-1240: the deletion is the PROBE's edit, so the copied Source intake has
    to follow it. An ACTIVE receipt linked to a ticket this function removed
    would otherwise make the copied project fail its own core gate with
    `references missing Work` -- a defect the probe manufactured and then
    reported against the live repository. Only receipts whose Work this
    function removed are unlinked. A receipt naming Work that exists nowhere in
    the ORIGINAL board is untouched, still dangling, and still fails; that is
    the condition the check exists to catch.

    T-1270 left a second surface behind the same reasoning. The Audit Inbox
    became WORK when `SOURCE-AUDIT-INBOX-01` landed: a workable layer routes an
    action, and a `next_action` that is neither that action nor a LIVE-TICKET
    continuation is a violation. This function removes every live ticket, and
    the probes that call it then force a neutral `next_action` -- so a copied
    `audit/` layer becomes a violation THE PROBE MANUFACTURED and reported
    against the live repository. Exactly the T-1240 shape one layer out, so the
    delivery inbox is emptied with the board rather than left to disagree with
    it. Fixtures that mean to exercise the inbox bring their own layer (see
    audit_checks' MULTI control), so nothing that tests it loses coverage.

    Returns the ticket ids that were dropped.
    """
    audit_dir = saipen_dir.parent / "audit"
    if audit_dir.is_dir():
        for entry in sorted(audit_dir.iterdir()):
            if entry.is_file() and not entry.name.startswith("."):
                entry.unlink()

    board_path = saipen_dir / "BOARD.md"
    board_out: list[str] = []
    dropped: set[str] = set()
    skip_section = None
    for line in board_path.read_text(encoding="utf-8-sig").splitlines():
        head = re.match(r"^## (\w+)\s*$", line)
        if head:
            skip_section = {"DONE": "drop", "DOING": "drop"}.get(head.group(1))
            board_out.append(line)
            continue
        if skip_section == "drop":
            ticket = re.search(r"\b(T-\d+)\b", line)
            if ticket:
                dropped.add(ticket.group(1))
            continue
        board_out.append(line)

    # T-1361 CL-03: the third instance of the shape the two paragraphs above
    # already name. A surviving TODO/BLOCKED record that `needs:` a ticket THIS
    # FUNCTION removed becomes a dangling reference the probe manufactured and
    # then reported against the live repository -- `T-1327 needs nonexistent
    # T-1326` is a closed dependency on the real board and a fabricated defect
    # in the copy. Only ids this function dropped are unlinked: a need that
    # names Work absent from the ORIGINAL board is untouched, still dangling,
    # and still fails, because that is the condition the check exists to catch.
    #
    # T-1361 release-freshness root: a `blocked_on:` continuation reservation
    # is a reference exactly like a `needs:` edge, and the copy must stay a
    # COHERENT board. Two defects lived here: the field rewrite dropped the
    # separator space (`T-1428| blocked_on:`), so the parser lost the
    # reservation fields, and a reservation naming a dropped ticket stayed
    # behind as a dangling reference. Both manufactured validator failures the
    # probe then reported against the live repository.
    if dropped:
        for index, line in enumerate(board_out):
            match = re.search(r"(?m)\|\s*needs:\s*([^|\n]*?)\s*(?=\||$)", line)
            if match:
                kept = [
                    need
                    for need in (part.strip() for part in match.group(1).split(","))
                    if need and need not in dropped
                ]
                board_out[index] = line[: match.start(1)] + ", ".join(kept) + line[match.end(1) :]
            blocked = re.search(
                r"\|\s*blocked_on:\s*(T-\d+)\s*(?=\|)", board_out[index]
            )
            if blocked and blocked.group(1) in dropped:
                stripped = re.sub(r"\|\s*blocked_on:\s*T-\d+\s*", "", board_out[index])
                stripped = re.sub(r"\|\s*resume_phase:\s*[A-Za-z_]+\s*", "", stripped)
                stripped = re.sub(
                    r"\|\s*resume_transition_from:\s*[A-Za-z_]+\s*", "", stripped
                )
                board_out[index] = stripped
    board_path.write_text("\n".join(board_out) + "\n", encoding="utf-8")

    intake_dir = saipen_dir / "intake"
    if not dropped or not intake_dir.is_dir():
        return dropped

    for meta_path in sorted((intake_dir / "active").glob("*.meta.json")):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            continue
        if isinstance(meta, dict) and meta.get("linked_work") in dropped:
            meta["linked_work"] = None
            meta_path.write_text(
                json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )

    index_path = intake_dir / "index.json"
    try:
        index = json.loads(index_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return dropped
    if not isinstance(index, dict) or not isinstance(index.get("active"), dict):
        return dropped
    touched = False
    for entry in index["active"].values():
        if isinstance(entry, dict) and entry.get("linked_work") in dropped:
            entry["linked_work"] = None
            touched = True
    if touched:
        index_path.write_text(
            json.dumps(index, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    return dropped


def run_release_freshness_probes() -> tuple[list[str], int]:
    """A pre-metadata green gate must not authorize mutated release bytes."""
    problems: list[str] = []
    checked = 0
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "probe",
        "GIT_AUTHOR_EMAIL": "probe@example.invalid",
        "GIT_COMMITTER_NAME": "probe",
        "GIT_COMMITTER_EMAIL": "probe@example.invalid",
    }
    home = VALIDATOR.parent.parent

    def expect(label: str, condition: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if condition:
            print(f"PASS: release freshness -- {label}")
        else:
            problems.append(f"release freshness {label}: {detail}")

    with tempfile.TemporaryDirectory(prefix="saipen-release-freshness-") as tmp:
        project = Path(tmp) / "home"
        shutil.copytree(
            home,
            project,
            ignore=shutil.ignore_patterns(
                ".git", ".venv", "__pycache__", ".freebuff", "node_modules", "nul"
            ),
        )
        def git(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["git", *args],
                cwd=project,
                env=env,
                capture_output=True,
                text=True,
                check=False,
                errors="replace",
            )

        def validate(*, bind: bool = False, gate: str = "ship") -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [
                    sys.executable,
                    str(project / "tools" / "validate.py"),
                    "--project-root",
                    str(project),
                    "--gate",
                    gate,
                    *(["--require-release-index"] if bind else []),
                ],
                cwd=project,
                capture_output=True,
                text=True,
                errors="replace",
            )

        if git("init", "-q").returncode != 0:
            print("SKIP: release freshness probes -- git unavailable")
            return problems, checked
        # T-994 / § 21: cut the copied LOG at the sealed boundary so the
        # fixture holds no hunt marks naming commits its fresh `git init`
        # cannot back, and reconcile STATE (last_event + § 1.5 goal replay)
        # to the cut so the fixture is internally valid.
        saipen_dir = project / ".saipen"
        # ONE SYNTHETIC work surface (same reasoning as the release executor
        # fixture): the copied repository's DONE tickets carry their verify
        # evidence in LOG history this cut removes, so a copied real board
        # fails closure-evidence on tickets this probe never touched. DONE is
        # emptied and DOING dropped (STATE below is neutralized to a
        # ticket-less DONE shape), while TODO/BLOCKED survive verbatim -- the
        # release-history WARN-ownership rule demands live owners for aged
        # warning slugs, and those live in exactly those two sections.
        neutralize_sandbox_work_surface(saipen_dir)
        st = (saipen_dir / "STATE.md").read_text(encoding="utf-8-sig")
        for key, val in (
            ("phase", "DONE"),
            ("task", "none"),
            ("next_action", "saipen continue"),
            ("transition_from", "DONE"),
        ):
            st = re.sub(rf"(?m)^({key}:\s*).*$", rf"\g<1>{val}", st)
        (saipen_dir / "STATE.md").write_text(st, encoding="utf-8")
        # T-1361 CL-03: this used to CUT the active LOG at the last sealed
        # boundary. The cut existed for one reason -- hunt marks naming
        # commits a fresh `git init` cannot back -- but it took the whole
        # recent history with them, and since CORE-003 / SRC-026:R003 that
        # history is where every ticket's identity lives. The surviving
        # TODO/BLOCKED records then had no allocation event, and the probe
        # reported thirty-odd fabricated `no [T-###] allocation event`
        # failures against the live repository's own board.
        #
        # Re-point the marks instead of deleting the history that carries
        # them, the way the audit harness already sanitizes its own fixtures:
        # commit the baseline first so there IS a commit to name, rewrite the
        # marks to it, and commit the sanitization. STATE.last_event and the
        # goal counters need no rebuild because nothing was removed.
        git("add", "-A")
        git("commit", "-q", "-m", "probe: baseline")
        short = git("rev-parse", "--short", "HEAD").stdout.strip()
        if short:
            logs_dir = saipen_dir / "logs"
            sealed = sorted(logs_dir.glob("LOG-*.md")) if logs_dir.is_dir() else []
            for log_path in [saipen_dir / "LOG.md", *sealed]:
                if not log_path.is_file():
                    continue
                text = log_path.read_text(encoding="utf-8-sig")
                sanitized = re.sub(
                    r"hunt -> clean @[0-9a-f]{7,40}\b", f"hunt -> clean @{short}", text
                )
                if sanitized != text:
                    log_path.write_text(sanitized, encoding="utf-8", newline="\n")
            git("add", "-A")
            git("commit", "-q", "-m", "probe: re-point synthetic hunt marks")

        locale_paths = sorted(
            (project / ".saipen" / "saitranslate" / "kitchen").glob("*/README_*.md")
        )
        old_version = (project / "VERSION").read_text(encoding="utf-8-sig").strip()
        parts = [int(part) for part in old_version.split(".")]
        new_version = f"{parts[0]}.{parts[1]}.{parts[2] + 1}"
        old_badge = f"**v{old_version}**"
        new_badge = f"**v{new_version}**"
        digest_re = re.compile(r"<!-- source-digest: README\.md sha256:([0-9a-f]+) -->")
        digests_before = {
            path.relative_to(project).as_posix(): digest_re.search(
                path.read_text(encoding="utf-8-sig")
            ).group(1)
            for path in locale_paths
            if digest_re.search(path.read_text(encoding="utf-8-sig"))
        }

        initial_gate = validate(gate="core")
        expect(
            "pre-metadata core signal is green",
            initial_gate.returncode == 0,
            (initial_gate.stdout + initial_gate.stderr).strip(),
        )
        empty_binding_gate = validate()
        expect(
            "binding gate rejects an empty release index",
            empty_binding_gate.returncode != 0
            and "requires every release metadata path staged"
            in (empty_binding_gate.stdout + empty_binding_gate.stderr),
            (empty_binding_gate.stdout + empty_binding_gate.stderr).strip(),
        )

        # A partial README stage exists before this ship. The release changes
        # that same path, so rollback must restore its exact old index blob,
        # not reset the path to HEAD or leave final metadata staged.
        root_readme = project / "README.md"
        root_text = root_readme.read_text(encoding="utf-8-sig")
        partial_marker = "\n<!-- pre-existing partial-stage probe -->\n"
        root_readme.write_text(root_text + partial_marker, encoding="utf-8", newline="\n")
        git("add", "--", root_readme.name)
        partial_index_before = git("ls-files", "-s", "--", root_readme.name).stdout
        pre_ship_tree = git("write-tree").stdout.strip()
        head_before = git("rev-parse", "HEAD").stdout.strip()
        tags_before = git("tag", "--list").stdout

        (project / "VERSION").write_text(new_version + "\n", encoding="utf-8", newline="\n")
        root_readme.write_text(
            root_text.replace(old_badge, new_badge, 1) + partial_marker,
            encoding="utf-8",
            newline="\n",
        )
        changelog = project / "CHANGELOG.md"
        changelog_text = changelog.read_text(encoding="utf-8-sig")
        changelog.write_text(
            re.sub(
                rf"(?m)^(##\s+\[?){re.escape(old_version)}(\]?(?=\s|$))",
                rf"\g<1>{new_version}\2",
                changelog_text,
                count=1,
            ),
            encoding="utf-8",
            newline="\n",
        )
        release_paths = [
            Path("VERSION"),
            Path("README.md"),
            Path("CHANGELOG.md"),
            *(path.relative_to(project) for path in locale_paths),
        ]
        git("add", "--", *(str(path) for path in release_paths[:3]))

        stale_gate = validate(bind=True)
        stale_output = stale_gate.stdout + stale_gate.stderr
        expect(
            "post-metadata binding gate rejects stale locale badges",
            stale_gate.returncode != 0
            and "translation README badge drift: 32 locale(s)" in stale_output,
            stale_output.strip(),
        )
        expect(
            "failed post-metadata gate creates no commit or tag",
            git("rev-parse", "HEAD").stdout.strip() == head_before
            and git("tag", "--list").stdout == tags_before,
            "HEAD or tag set changed after the failed gate",
        )

        restored = git(
            "restore",
            f"--source={pre_ship_tree}",
            "--staged",
            "--",
            *(str(path) for path in release_paths),
        )
        staged_after_rollback = set(
            filter(None, git("diff", "--cached", "--name-only").stdout.splitlines())
        )
        expect(
            "rollback removes only staging introduced by this ship",
            restored.returncode == 0
            and staged_after_rollback == {root_readme.name}
            and git("ls-files", "-s", "--", root_readme.name).stdout == partial_index_before,
            (restored.stdout + restored.stderr).strip(),
        )

        git("restore", "--staged", "--", root_readme.name)
        root_readme.write_text(
            root_text.replace(old_badge, new_badge, 1), encoding="utf-8", newline="\n"
        )
        for path in locale_paths:
            text = path.read_text(encoding="utf-8-sig")
            path.write_text(text.replace(old_badge, new_badge, 1), encoding="utf-8", newline="\n")
        git("add", "--", *(str(path) for path in release_paths))

        final_gate = validate(bind=True)
        probe_locale = locale_paths[0]
        final_locale_text = probe_locale.read_text(encoding="utf-8-sig")
        probe_locale.write_text(
            final_locale_text.replace(new_badge, new_badge + new_badge, 1),
            encoding="utf-8",
            newline="\n",
        )
        duplicate_badge_gate = validate(bind=True)
        probe_locale.write_text(
            final_locale_text.replace(new_badge, "", 1), encoding="utf-8", newline="\n"
        )
        missing_badge_gate = validate(bind=True)
        probe_locale.write_text(final_locale_text, encoding="utf-8", newline="\n")
        probe_locale.write_text(
            final_locale_text.replace(new_badge, old_badge, 1), encoding="utf-8", newline="\n"
        )
        git("add", "--", str(probe_locale.relative_to(project)))
        probe_locale.write_text(final_locale_text, encoding="utf-8", newline="\n")
        staged_worktree_divergence_gate = validate(bind=True)
        git("add", "--", str(probe_locale.relative_to(project)))
        cached_check = git("diff", "--cached", "--check")
        staged_final = set(filter(None, git("diff", "--cached", "--name-only").stdout.splitlines()))
        expected_final = {path.as_posix() for path in release_paths}
        digests_after = {
            path.relative_to(project).as_posix(): digest_re.search(
                path.read_text(encoding="utf-8-sig")
            ).group(1)
            for path in locale_paths
            if digest_re.search(path.read_text(encoding="utf-8-sig"))
        }
        expect(
            "all mechanically discovered locale mirrors pass",
            final_gate.returncode == 0 and len(locale_paths) == 32,
            (final_gate.stdout + final_gate.stderr).strip(),
        )
        expect(
            "duplicate locale badge fails the ship gate",
            duplicate_badge_gate.returncode != 0
            and "translation README badge drift"
            in (duplicate_badge_gate.stdout + duplicate_badge_gate.stderr),
            (duplicate_badge_gate.stdout + duplicate_badge_gate.stderr).strip(),
        )
        expect(
            "missing locale badge fails the ship gate",
            missing_badge_gate.returncode != 0
            and "translation README badge drift"
            in (missing_badge_gate.stdout + missing_badge_gate.stderr),
            (missing_badge_gate.stdout + missing_badge_gate.stderr).strip(),
        )
        expect(
            "stale staged badge cannot hide behind clean working bytes",
            staged_worktree_divergence_gate.returncode != 0
            and "staged release metadata differs from working-tree bytes"
            in (staged_worktree_divergence_gate.stdout + staged_worktree_divergence_gate.stderr),
            (
                staged_worktree_divergence_gate.stdout + staged_worktree_divergence_gate.stderr
            ).strip(),
        )
        expect(
            "final binding scope and cached diff are exact",
            staged_final == expected_final and cached_check.returncode == 0,
            f"staged={sorted(staged_final)}; check={cached_check.stderr.strip()}",
        )
        expect(
            "version-only mirror update leaves source digests unchanged",
            digests_after == digests_before,
            "a release badge update restamped translation freshness",
        )

    return problems, checked


def run_release_executor_probes() -> tuple[list[str], int]:
    """T-994: comprehensive hostile release matrix.

    Tests the release executor against every identified failure class with
    ISOLATED fixtures (one scenario never contaminates another's Git history,
    T-635's original blindness): PLAN identity, zero-write dry-run, first
    publish WAIT, no-publish policy, foreign staging, phase gate, stderr
    capture, REAL source release into a fresh clone, ALREADY_APPLIED full
    evidence, crash recovery between every A -> B -> tag edge, journal-write
    refusal surfacing, exact index rollback, and the closed-code guarantee
    (every public ok:false code is in errors.CODES).

    Every identity assertion demands a NON-EMPTY expected AND actual witness;
    empty == empty is never proof.
    """
    problems: list[str] = []
    checked = 0
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "probe",
        "GIT_AUTHOR_EMAIL": "probe@example.invalid",
        "GIT_COMMITTER_NAME": "probe",
        "GIT_COMMITTER_EMAIL": "probe@example.invalid",
    }

    home = VALIDATOR.parent.parent

    def expect(label: str, condition: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if condition:
            print(f"PASS: release executor -- {label}")
        else:
            problems.append(f"release executor {label}: {detail}")

    def expect_refusal(label: str, rd: dict) -> None:
        """A public refusal MUST return a closed-code from errors.CODES."""
        nonlocal checked
        checked += 1
        from saipen_engine.errors import CODES

        code = rd.get("code")
        ok = not rd.get("ok") and isinstance(code, str) and code in CODES
        if ok:
            print(f"PASS: release executor -- {label}")
        else:
            problems.append(
                f"release executor {label}: ok={rd.get('ok')} "
                f"code={code!r} not in errors.CODES -- detail="
                f"{str(rd.get('detail'))[:200]}"
            )

    def j(result) -> dict:
        try:
            return json.loads(result.stdout)
        except (json.JSONDecodeError, ValueError):
            # T-1361 CL-04: the detail was stdout only, and a CLI that dies
            # before printing anything has no stdout -- so ten checks reported
            # `code='PARSE_ERROR' detail=` and named nothing at all. Carry the
            # exit code and stderr: a probe that cannot say what went wrong
            # costs more than the check it was protecting.
            return {
                "ok": False,
                "code": "PARSE_ERROR",
                "detail": (
                    f"rc={result.returncode} "
                    f"stdout={result.stdout[:200]!r} stderr={result.stderr[-600:]!r}"
                ),
            }

    def _cut_log(saipen_dir: Path) -> None:
        """Cut the copied LOG at the last sealed-segment boundary so the
        fixture history holds no commit references (hunt marks etc.) the fresh
        `git init` cannot back. Aligns STATE.last_event / goal counters to the
        validator's OWN § 1.5 replay rule so the fixture is internally valid
        (T-994 / § 21: one valid fixture, never hand-hacked STATE shapes)."""
        sealed_max = 0
        logs_dir = saipen_dir / "logs"
        if logs_dir.is_dir():
            for seg in sorted(logs_dir.glob("LOG-*.md")):
                for ln in seg.read_text(encoding="utf-8-sig").splitlines():
                    m = re.search(r"\[E-(\d+)\]", ln)
                    if m:
                        sealed_max = max(sealed_max, int(m.group(1)))
        if not sealed_max:
            return
        log_text = (saipen_dir / "LOG.md").read_text(encoding="utf-8-sig")
        kept = [
            ln
            for ln in log_text.splitlines()
            if not (m := re.search(r"\[E-(\d+)\]", ln)) or int(m.group(1)) <= sealed_max
        ]
        (saipen_dir / "LOG.md").write_text("\n".join(kept) + "\n", encoding="utf-8")
        st = (saipen_dir / "STATE.md").read_text(encoding="utf-8")
        st = re.sub(r"(?m)^(\s*last_event:\s*)\d+$", f"\\g<1>{sealed_max}", st)
        # § 1.5 replay: goal counters rebuild from the NEWEST
        # `DEC: goal pivot|reauthorized` marker across SEALED + active logs
        # (the validator reads every log file). Reconcile STATE to the cut log
        # so the ship gate never fails on the fixture's own editing.
        all_lines = list(kept)
        if logs_dir.is_dir():
            for seg in sorted(logs_dir.glob("LOG-*.md")):
                all_lines += seg.read_text(encoding="utf-8-sig").splitlines()
        marker = re.compile(r"\]\s+DEC: goal (?:pivot|reauthorized)\b")
        last_marker = max((i for i, ln in enumerate(all_lines) if marker.search(ln)), default=None)
        for counter in ("goal_waves", "goal_tickets"):
            if not re.search(rf"(?m)^{counter}:", st):
                continue
            if last_marker is None:
                continue  # validator only WARNs in the no-marker shape
            rebuilt = sum(
                1
                for ln in all_lines[last_marker + 1 :]
                for m in [re.search(rf"DEC: {counter} (\d+)->(\d+)", ln)]
                if m and int(m.group(2)) > int(m.group(1))
            )
            st = re.sub(rf"(?m)^({counter}:\s*)\d+$", f"\\g<1>{rebuilt}", st)
        (saipen_dir / "STATE.md").write_text(st, encoding="utf-8")

    def _append_fixture_verification(saipen_dir: Path) -> None:
        """Give synthetic T-9000 real current-cycle VERIFY evidence.

        The release fixture used to patch STATE straight to SHIP while
        omitting the VERIFY boundary and PASS that production closure
        requires.  That made the harness itself invalid and collapsed most
        release assertions into the same INCOMPLETE_TICKET refusal. Build the
        complete VERIFY/PASS/REVIEW/SHIP chain with the canonical event
        renderer and bind STATE.last_event to the resulting tail.
        """
        log_path = saipen_dir / "LOG.md"
        log_text = log_path.read_text(encoding="utf-8-sig")
        events = [
            parsed["event"]
            for line in log_text.splitlines()
            if (parsed := parse_log_line(line)) is not None
        ]
        logs_dir = saipen_dir / "logs"
        if logs_dir.is_dir():
            for segment in sorted(logs_dir.glob("LOG-*.md")):
                events.extend(
                    parsed["event"]
                    for line in segment.read_text(encoding="utf-8-sig").splitlines()
                    if (parsed := parse_log_line(line)) is not None
                )
        tail = max(events, default=0)
        now_dt = datetime.datetime.now(datetime.timezone.utc)
        now = now_dt.strftime("%d.%m.%y %H:%M")
        boundary, boundary_line = build_event(
            tail,
            "RUN",
            "transition to VERIFY -- release fixture verification boundary",
            ticket="T-9000",
            agent="probe",
            now=now,
            op_id="transition-release-fixture-verify",
        )
        verdict, verdict_line = build_event(
            boundary,
            "RUN",
            "verify -> PASS: release fixture invariants proven conf: high",
            ticket="T-9000",
            agent="probe",
            now=now,
            op_id="checkpoint-release-fixture-verify",
        )
        review, review_line = build_event(
            verdict,
            "RUN",
            "transition to REVIEW -- release fixture verification accepted",
            ticket="T-9000",
            agent="probe",
            now=now,
            op_id="transition-release-fixture-review",
        )
        ship, ship_line = build_event(
            review,
            "RUN",
            "transition to SHIP -- release fixture review accepted",
            ticket="T-9000",
            agent="probe",
            now=now,
            op_id="transition-release-fixture-ship",
        )
        log_path.write_text(
            log_text.rstrip("\n")
            + "\n"
            + "\n".join((boundary_line, verdict_line, review_line, ship_line))
            + "\n",
            encoding="utf-8",
        )
        state_path = saipen_dir / "STATE.md"
        state_text = state_path.read_text(encoding="utf-8-sig")
        state_text = re.sub(
            r"(?m)^(\s*last_event:\s*)\d+$", f"\\g<1>{ship}", state_text
        )
        state_text = re.sub(
            r"(?m)^(\s*updated:\s*).*$",
            f"\\g<1>{now_dt.strftime('%Y-%m-%dT%H:%M:%SZ')}",
            state_text,
        )
        state_path.write_text(state_text, encoding="utf-8")

    def build_fixture(
        tmp: Path, *, mode: str = "full", gitless: bool = False, foreign: bool = False
    ) -> tuple:
        """ONE valid SHIP-phase fixture builder (T-994 / § 21): the copied
        project's real STATE keeps every required field (blocker,
        saipen_version, mode, ...) and only the SHIP-relevant fields are
        patched, so the ship gate never fails on the fixture's own corruption.
        """
        project = tmp / "home"
        shutil.copytree(
            home,
            project,
            ignore=shutil.ignore_patterns(
                ".git", ".venv", "__pycache__", ".freebuff", "node_modules", "nul"
            ),
        )
        # Release probes build their own synthetic BOARD/STATE/LOG and source
        # scope. Do not let an unrelated live receipt from the host project
        # become a hidden release precondition in every copied fixture.
        shutil.rmtree(project / ".saipen" / "intake", ignore_errors=True)

        def git(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["git", "-C", str(project), *args],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

        def cli(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [sys.executable, str(project / "tools" / "saipen.py"), *args],
                cwd=str(project),
                env={**env, "SAIPEN_CAPABILITY": mode},
                capture_output=True,
                text=True,
                errors="replace",
            )

        if not gitless:
            if git("init", "-q").returncode != 0:
                print("SKIP: release executor probes -- git unavailable")
                return None
            git("add", "-A")
            git("commit", "-q", "-m", "probe: baseline")
            git("branch", "-M", "main")
            origin = tmp / "origin.git"
            subprocess.run(["git", "init", "-q", "--bare", str(origin)], capture_output=True)
            git("remote", "add", "origin", f"file://{origin}")
            git("push", "-q", "origin", "HEAD:main")
            subprocess.run(
                ["git", "-C", str(origin), "symbolic-ref", "HEAD", "refs/heads/main"],
                capture_output=True,
            )
        else:
            origin = tmp / "origin.git"
            origin.mkdir()

        saipen_dir = project / ".saipen"
        st = (saipen_dir / "STATE.md").read_text(encoding="utf-8-sig")
        lines = st.splitlines()
        lines = [
            ln
            for ln in lines
            if not (
                ln.strip().startswith("converge_target:")
                or ln.strip().startswith("goal_waves:")
                or ln.strip().startswith("goal_tickets:")
            )
        ]
        out = []
        for ln in lines:
            new_ln = ln
            for key, val in (
                ("phase:", "SHIP"),
                ("task:", "T-9000"),
                ("next_action:", "PHASE SHIP T-9000"),
                ("transition_from:", "REVIEW"),
                ("mode:", mode),
                ("agent:", "probe"),
                ("execution_intent:", "normal"),
                # The copied STATE carries the AUTHORING machine's absolute
                # `saipen_home`. That path exists on exactly one host, so every
                # other one -- a Linux CI runner above all -- refuses the very
                # first fixture command with HOME_REQUIRED. The fixture is
                # self-hosting (the copy contains `saipen/BOOT.md`), so it
                # rebinds the pointer at its own root and stops depending on
                # where the repository happened to be written.
                ("saipen_home:", json.dumps(str(project))),
            ):
                if new_ln.strip().startswith(key):
                    new_ln = new_ln.replace(new_ln.split(":", 1)[1], " " + val)
                    break
            out.append(new_ln)
        (saipen_dir / "STATE.md").write_text("\n".join(out) + "\n", encoding="utf-8")

        # ONE SYNTHETIC work surface (T-994 / § 21): the copied repository's
        # own DONE tickets carry evidence in LOG history the _cut_log trim
        # below removes, so a copied real board would fail the ship gate's
        # closure-evidence check on tickets this fixture never touched. The
        # fixture's board is exactly its own synthetic ticket -- repo-state
        # independent by construction.
        (saipen_dir / "BOARD.md").write_text(
            "# Board\n"
            "## DOING\n"
            "- [/] T-9000 synthetic fixture ticket "
            "| verify: canonical release executor matrix passes "
            "| owner: probe | claim_time: 2026-01-01T00:00:00Z\n"
            "## TODO\n"
            "## DONE\n"
            "## BLOCKED\n",
            encoding="utf-8",
        )

        _cut_log(saipen_dir)
        _append_fixture_verification(saipen_dir)
        if not gitless:
            git("add", "-A")
            git("commit", "-q", "-m", "probe: fixture ship")
            git("push", "-q", "origin", "HEAD:main")

        # Real, non-metadata source change: the reviewed scope the release
        # must actually ship (T-994 / § 2, § 22).
        src = project / "tools" / "saipen_engine" / "release_contract.py"
        src.write_text(
            src.read_text(encoding="utf-8-sig").replace(
                "version_badges(path)", "version_badges_owned(path)"
            ),
            encoding="utf-8",
        )
        old_ver = (project / "VERSION").read_text(encoding="utf-8").strip()
        major, minor, patch = old_ver.split(".")
        new_ver = f"{major}.{minor}.{int(patch) + 1}"
        (project / "VERSION").write_text(new_ver + "\n", encoding="utf-8")
        readme = (project / "README.md").read_text(encoding="utf-8-sig")
        (project / "README.md").write_text(
            readme.replace(f"**v{old_ver}**", f"**v{new_ver}**"), encoding="utf-8"
        )
        # The three ROOT locale mirrors are part of the release surface
        # (release_contract.release_metadata_paths); a fixture that bumps
        # VERSION must bump their badges too, or every probe that plans a
        # release dies in _check_parity before it tests what it came for.
        for mirror in ("README.ee.md", "README.ded.md", "README.ja.md"):
            mirror_path = project / mirror
            if mirror_path.is_file():
                mirror_text = mirror_path.read_text(encoding="utf-8-sig")
                mirror_path.write_text(
                    mirror_text.replace(f"**v{old_ver}**", f"**v{new_ver}**"),
                    encoding="utf-8",
                )
        changelog = (project / "CHANGELOG.md").read_text(encoding="utf-8-sig")
        (project / "CHANGELOG.md").write_text(
            f"## {new_ver}\n\nTest release.\n\n" + changelog, encoding="utf-8"
        )
        kitchen = saipen_dir / "saitranslate" / "kitchen"
        if kitchen.is_dir():
            for rm in kitchen.glob("*/README_*.md"):
                t = rm.read_text(encoding="utf-8-sig")
                rm.write_text(t.replace(f"**v{old_ver}**", f"**v{new_ver}**"), encoding="utf-8")
        if foreign:
            # The intended final source tree includes this foreign untracked
            # file: the release must keep it out of its commits and preserve it
            # in the worktree. It has to exist BEFORE the scope identity is
            # recorded -- the fingerprint covers untracked non-.saipen bytes,
            # so writing it afterwards makes the reviewed scope stale.
            (project / "tools" / "foreign_file.py").write_text(
                "FOREIGN = True\n", encoding="utf-8"
            )
        # Scope binds the complete reviewed tree, including release metadata.
        # Recording it before the version bump creates a stale fixture.
        r = cli("scope", "T-9000", "tools/saipen_engine/release_contract.py")
        if r.returncode != 0:
            raise RuntimeError("fixture scope failed: " + r.stdout + r.stderr)
        return project, origin, git, cli, new_ver

    def remote_branch_tip(origin: Path) -> str:
        r = subprocess.run(
            ["git", "ls-remote", str(origin), "refs/heads/main"], capture_output=True, text=True
        )
        parts = r.stdout.strip().split()
        return parts[0] if parts else ""

    def remote_tag_commit(origin: Path, tag: str) -> str:
        r = subprocess.run(
            ["git", "ls-remote", str(origin), f"refs/tags/{tag}^{{}}"],
            capture_output=True,
            text=True,
        )
        parts = r.stdout.strip().split()
        return parts[0] if parts else ""

    # ======================================================================
    # 1. PLAN: ship and push dry-run plans are structurally identical
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-1-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, _new_ver = built
        ship_plan = cli("ship", "--dry-run", "--json")
        push_plan = cli("push", "--dry-run", "--json")
        sp = j(ship_plan)
        pp = j(push_plan)
        expect(
            "1. ship and push dry-run plans are structurally identical",
            sp.get("ok") and pp.get("ok") and sp.get("plan") == pp.get("plan"),
            f"ship={sp.get('plan')} push={pp.get('plan')} {sp.get('detail')} {pp.get('detail')}",
        )

    # ======================================================================
    # 2. DRY_RUN: zero writes (no file/index/commit/tag/object change)
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-2-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, _new_ver = built
        pre_obj = git("count-objects", "-v").stdout
        pre_status = git("status", "--short").stdout
        pre_log = git("log", "--oneline").stdout
        pre_tags = git("tag", "--list").stdout
        pre_refs = git("show-ref").stdout
        result = cli("ship", "--dry-run", "--json")
        rd = j(result)
        post_obj = git("count-objects", "-v").stdout
        post_status = git("status", "--short").stdout
        post_log = git("log", "--oneline").stdout
        post_tags = git("tag", "--list").stdout
        post_refs = git("show-ref").stdout
        expect(
            "2a. dry-run reports writes=none",
            rd.get("ok") and rd.get("writes") == "none",
            f"ok={rd.get('ok')} writes={rd.get('writes')}",
        )
        expect(
            "2b. dry-run does not change index/staged set",
            pre_status == post_status,
            f"before={pre_status!r} after={post_status!r}",
        )
        expect("2c. dry-run creates no new commits", pre_log == post_log, "")
        expect("2d. dry-run creates no tags", pre_tags == post_tags == "", f"tags={post_tags!r}")
        expect(
            "2e. dry-run creates no git objects",
            pre_obj == post_obj,
            f"before={pre_obj!r} after={post_obj!r}",
        )
        expect("2f. dry-run does not change refs", pre_refs == post_refs, "")

    # ======================================================================
    # 3. FIRST-PUBLISH WAIT is canonical, not an error string (T-994 / § 11)
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-3-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, new_ver = built
        origin_empty = Path(tmp) / "origin_empty.git"
        subprocess.run(["git", "init", "-q", "--bare", str(origin_empty)], capture_output=True)
        git("remote", "set-url", "origin", f"file://{origin_empty}")
        pre_head = git("rev-parse", "HEAD").stdout

        result = cli("ship", "--json")
        rd = j(result)
        expect_refusal("3a. first publish refuses with FIRST_PUBLISH_WAIT", rd)
        expect("3a-code", rd.get("code") == "FIRST_PUBLISH_WAIT", f"code={rd.get('code')}")
        expect(
            "3b. first-publish does not create commits",
            git("rev-parse", "HEAD").stdout == pre_head,
            "",
        )
        expect("3c. first-publish does not create tags", git("tag", "--list").stdout == "", "")
        st = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        expect(
            "3d. canonical WAIT persisted in STATE",
            'next_action: "WAIT: first-publish' in st
            or "next_action: WAIT: first-publish" in st
            or "next_action: WAIT:first-publish" in st,
            [ln for ln in st.splitlines() if "next_action" in ln][:1],
        )
        expect("3e. phase stays SHIP during the WAIT", "phase: SHIP" in st, "")

        result = cli("fpc", f"file://{origin_empty}", "public", "--json")
        rd = j(result)
        expect(
            "3f. confirmation is canonical evidence",
            rd.get("ok") and rd.get("code") == "FIRST_PUBLISH_CONFIRMED",
            f"code={rd.get('code')} detail={rd.get('detail')}",
        )
        st = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        expect(
            "3g. confirmation recorded in STATE",
            "first_publish_confirmation:" in st,
            [ln for ln in st.splitlines() if "first_publish_confirmation" in ln][:1],
        )

        result = cli("ship", "--json")
        rd = j(result)
        expect(
            "3h. confirmed first publish proceeds to RELEASED",
            rd.get("ok") and rd.get("code") == "RELEASED",
            f"code={rd.get('code')} detail={str(rd.get('detail'))[:200]}",
        )
        tag = remote_tag_commit(origin_empty, f"v{new_ver}")
        expect(
            "3i. tag published after confirmation",
            tag != "" and tag == remote_branch_tip(origin_empty),
            f"tag={tag} tip={remote_branch_tip(origin_empty)}",
        )

    # ======================================================================
    # 4. POLICY: no-publish matches ship.md exactly (T-994 / § 10)
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-4-") as tmp:
        built = build_fixture(Path(tmp), mode="no-publish")
        if built is None:
            return problems, checked
        project, origin, git, cli, new_ver = built
        pre_head = git("rev-parse", "HEAD").stdout
        pre_index = git("diff", "--cached", "--name-only").stdout
        pre_tags = git("tag", "--list").stdout
        pre_remote = subprocess.run(
            ["git", "ls-remote", str(origin)], capture_output=True, text=True
        ).stdout

        result = cli("ship", "--json")
        rd = j(result)
        expect(
            "4a. no-publish returns a truthful success",
            rd.get("ok") and rd.get("code") == "NO_PUBLISH_MODE",
            f"code={rd.get('code')} detail={rd.get('detail')}",
        )
        expect(
            "4b. no-publish does not create a local commit",
            git("rev-parse", "HEAD").stdout == pre_head,
            "HEAD changed under no-publish",
        )
        expect(
            "4c. no-publish does not stage anything",
            git("diff", "--cached", "--name-only").stdout == pre_index,
            f"index={git('diff', '--cached', '--name-only').stdout!r}",
        )
        expect("4d. no-publish creates no tags", git("tag", "--list").stdout == pre_tags == "", "")
        expect(
            "4e. no-publish remote refs unchanged",
            subprocess.run(["git", "ls-remote", str(origin)], capture_output=True, text=True).stdout
            == pre_remote,
            "remote changed under no-publish",
        )
        st = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        expect(
            "4f. canonical STATE becomes DONE", "phase: DONE" in st and "task: none" in st, st[:160]
        )
        board = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        expect("4g. ticket becomes DONE", "- [x] T-9000" in board, "")
        log_text = (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        expect(
            "4h. truthful skipped-publish LOG event",
            f"ship v{new_ver} -> skipped publish (no-publish: policy)" in log_text,
            [ln for ln in log_text.splitlines() if "skipped publish" in ln][:1],
        )
        digest = (project / ".saipen" / "kitchen" / "digest.md").read_text(encoding="utf-8")
        expect("4i. digest updated", "done:" in digest and "awaiting:" in digest, digest[:120])

    # ======================================================================
    # 4b. no-publish works when Git is genuinely unavailable
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-4b-") as tmp:
        built = build_fixture(Path(tmp), mode="no-publish", gitless=True)
        if built is None:
            return problems, checked
        project, origin, git, cli, new_ver = built
        result = cli("ship", "--json")
        rd = j(result)
        expect(
            "4j. git-less no-publish succeeds",
            rd.get("ok"),
            f"code={rd.get('code')} detail={rd.get('detail')}",
        )
        log_text = (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        expect(
            "4k. git-less no-publish records the true reason",
            "(no-publish: no git)" in log_text,
            [ln for ln in log_text.splitlines() if "skipped publish" in ln][:1],
        )
        st = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        expect("4l. git-less no-publish closes SHIP -> DONE", "phase: DONE" in st, "")

    # ======================================================================
    # 5. FOREIGN STAGING: refused and preserved
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-5-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, _new_ver = built
        foreign = project / "foreign_untracked.txt"
        foreign.write_text("foreign\n", encoding="utf-8")
        git("add", "--", foreign.name)
        result = cli("ship", "--dry-run", "--json")
        rd = j(result)
        expect_refusal("5a. foreign pre-existing staging is refused", rd)
        foreign_still_staged = foreign.name in git("diff", "--cached", "--name-only").stdout
        expect(
            "5b. foreign staging is preserved after refusal",
            foreign.is_file()
            and foreign.read_text(encoding="utf-8") == "foreign\n"
            and foreign_still_staged,
            f"staged={foreign_still_staged}",
        )

    # ======================================================================
    # 6. PHASE gate: release refuses a non-SHIP state
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-6-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, _new_ver = built
        st = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        st = re.sub(r"(?m)^(\s*phase:\s*).*$", "\\g<1>DONE", st)
        st = re.sub(r"(?m)^(\s*task:\s*).*$", "\\g<1>none", st)
        st = re.sub(r"(?m)^(\s*next_action:\s*).*$", "\\g<1>saipen continue", st)
        (project / ".saipen" / "STATE.md").write_text(st, encoding="utf-8")
        git("add", ".saipen/STATE.md")
        git("commit", "-q", "-m", "probe: set DONE")
        git("push", "-q", "origin", "HEAD:main")
        result = cli("ship", "--dry-run", "--json")
        rd = j(result)
        expect_refusal("6. release from an unproven DONE state is refused", rd)
        expect(
            "6-code. refusal names the phase/evidence problem",
            ("DONE" in str(rd.get("detail")) or "SHIP" in str(rd.get("detail")))
            or rd.get("code") == "ILLEGAL_PHASE",
            f"code={rd.get('code')} detail={rd.get('detail')}",
        )

    # ======================================================================
    # 7. COMMIT failure detail is not discarded (stderr captured)
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-7-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, _new_ver = built
        hook = project / ".git" / "hooks" / "pre-commit"
        hook.write_text("#!/bin/sh\necho HOOK REJECTION\nexit 1\n", encoding="utf-8")
        # POSIX git runs a hook only when it is EXECUTABLE, and silently skips
        # it otherwise. Windows ignores the bit, so a hook written without it
        # rejects commits there and does nothing on Linux -- the injection this
        # probe depends on never fires, the ship succeeds, and the probe
        # reports the real release as a missing refusal. A probe whose
        # fault injection is a no-op tests nothing.
        hook.chmod(0o755)
        pre_remote_tip = remote_branch_tip(origin)
        result = cli("ship", "--json")
        rd = j(result)
        expect_refusal("7a. commit rejection is a closed refusal", rd)
        expect(
            "7b. failure detail is non-empty (stderr captured)",
            len(rd.get("detail", "")) > 0,
            f"detail={str(rd.get('detail'))[:300]}",
        )
        expect(
            "7c. no push happened on commit failure",
            remote_branch_tip(origin) == pre_remote_tip,
            f"before={pre_remote_tip[:12] or '(none)'} after="
            f"{remote_branch_tip(origin)[:12] or '(none)'}",
        )

    # ======================================================================
    # 8. FULL SUCCESS: REAL source change ships into a fresh clone
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-8-") as tmp:
        built = build_fixture(Path(tmp), foreign=True)
        if built is None:
            return problems, checked
        project, origin, git, cli, new_ver = built
        foreign = project / "tools" / "foreign_file.py"

        result = cli("ship", "--json")
        rd = j(result)
        tag = f"v{new_ver}"
        release_commit = rd.get("commit", "")
        closure_commit = rd.get("closure_commit", "")
        stages = rd.get("stages_reached", [])

        expect(
            "8a. full release returns RELEASED",
            rd.get("ok") and rd.get("code") == "RELEASED",
            f"ok={rd.get('ok')} code={rd.get('code')} detail={str(rd.get('detail'))[:200]}",
        )
        expect(
            "8b. closure B is a separate non-empty commit after A",
            bool(release_commit) and bool(closure_commit) and closure_commit != release_commit,
            f"A={release_commit[:12]} B={closure_commit[:12]}",
        )
        remote_tip = remote_branch_tip(origin)
        remote_tag = remote_tag_commit(origin, tag)
        local_tag = git("rev-parse", f"{tag}^{{commit}}").stdout.strip()
        expect(
            "8c. remote branch tip == closure commit (non-empty)",
            remote_tip and remote_tip == closure_commit,
            f"remote={remote_tip[:12] or '(none)'} closure={closure_commit[:12]}",
        )
        expect(
            "8d. remote tag^{commit} == closure commit (non-empty)",
            remote_tag and remote_tag == closure_commit,
            f"remote tag={remote_tag[:12] or '(none)'}",
        )
        expect(
            "8e. local tag^{commit} == closure commit (non-empty)",
            local_tag and local_tag == closure_commit,
            f"local tag={local_tag[:12] or '(none)'} closure={closure_commit[:12]}",
        )
        expect(
            "8f. tag is created AFTER the closure is published",
            stages.index("TAG_CREATED") > stages.index("CLOSURE_PUBLISHED")
            if "TAG_CREATED" in stages and "CLOSURE_PUBLISHED" in stages
            else False,
            f"stages={stages}",
        )
        parent_of_b = git("rev-parse", f"{closure_commit}^").stdout.strip()
        expect(
            "8g. B.parent == A",
            parent_of_b and parent_of_b == release_commit,
            f"B^={parent_of_b[:12]} A={release_commit[:12]}",
        )

        # Fresh clone must carry the exact real source change + metadata
        clone = Path(tmp) / "fresh_clone"
        crc = subprocess.run(
            ["git", "clone", "-q", f"file://{origin}", str(clone)], capture_output=True, text=True
        )
        expect("8h. fresh clone succeeded", crc.returncode == 0, crc.stderr)
        if crc.returncode == 0:
            cloned_src = (clone / "tools" / "saipen_engine" / "release_contract.py").read_text(
                encoding="utf-8-sig"
            )
            expect(
                "8i. fresh clone carries the exact reviewed source change",
                "version_badges_owned(path)" in cloned_src,
                "source change missing in fresh clone",
            )
            clone_state = (clone / ".saipen" / "STATE.md").read_text(encoding="utf-8-sig")
            expect(
                "8j. fresh clone sees STATE DONE / task none",
                "phase: DONE" in clone_state and "task: none" in clone_state,
                "",
            )
            clone_board = (clone / ".saipen" / "BOARD.md").read_text(encoding="utf-8-sig")
            expect("8k. fresh clone sees ticket DONE", "- [x] T-9000" in clone_board, "")
            clone_log = (clone / ".saipen" / "LOG.md").read_text(encoding="utf-8-sig")
            expect(
                "8l. fresh clone LOG carries truthful release evidence",
                "ship v" + new_ver in clone_log
                and "T-9000" in clone_log
                and "content commit" in clone_log,
                "release evidence missing in cloned LOG",
            )
            scope_rec = clone / ".saipen" / "kitchen" / "release_scope" / "T-9000.json"
            expect(
                "8m. scope record reaches the fresh clone",
                scope_rec.is_file(),
                "scope record missing in clone",
            )

        # Foreign file must NOT be in either commit and must stay in worktree
        for commit in (release_commit, closure_commit):
            in_commit = git("cat-file", "-e", f"{commit}:tools/foreign_file.py").returncode
            expect(
                "8n. foreign file did not enter the release commits",
                in_commit != 0,
                f"{commit}:tools/foreign_file.py present",
            )
        expect(
            "8o. foreign file still in the worktree",
            foreign.is_file() and foreign.read_text(encoding="utf-8") == "FOREIGN = True\n",
            "",
        )
        status = git("status", "--porcelain").stdout
        expect(
            "8p. no owned work remains dirty (only the foreign untracked)",
            all(ln.startswith("??") for ln in status.splitlines() if ln.strip()),
            f"status={status!r}",
        )
        expect(
            "8q. scope record is committed (no tracked dirt)",
            git(
                "ls-files", "--error-unmatch", ".saipen/kitchen/release_scope/T-9000.json"
            ).returncode
            == 0,
            "scope record untracked",
        )

        # Retry: full remote + canonical evidence -> already applied, no writes
        pre_retry_head = git("rev-parse", "HEAD").stdout
        result = cli("ship", "--json")
        rd = j(result)
        expect(
            "8r. retry recognizes ALREADY_APPLIED from full evidence",
            rd.get("ok") and rd.get("code") == "RELEASED" and rd.get("already_applied") is True,
            f"code={rd.get('code')} already_applied={rd.get('already_applied')}",
        )
        expect("8s. retry writes nothing", git("rev-parse", "HEAD").stdout == pre_retry_head, "")

    # ======================================================================
    # 9. CRASH RECOVERY between every A -> B -> tag edge (T-994 / § 17, § 18)
    # ======================================================================
    for crash_point, probe_label in (
        ("SAIPEN_CRASH_AFTER_CONTENT_PUBLISH", "A after content push"),
        ("SAIPEN_CRASH_AFTER_CLOSURE_PUBLISH", "B after closure push"),
        ("SAIPEN_CRASH_AFTER_TAG_PUSH", "C after tag push"),
    ):
        with tempfile.TemporaryDirectory(prefix="saipen-rel-9-") as tmp:
            built = build_fixture(Path(tmp))
            if built is None:
                return problems, checked
            project, origin, git, cli, new_ver = built

            env_crash = {**env, crash_point: "1"}
            r = subprocess.run(
                [sys.executable, str(project / "tools" / "saipen.py"), "ship", "--json"],
                cwd=str(project),
                env=env_crash,
                capture_output=True,
                text=True,
                errors="replace",
            )
            expect(
                f"9. {probe_label}: crash injected at the edge",
                r.returncode == 86,
                f"rc={r.returncode}",
            )
            before_commits = git("rev-list", "--count", "HEAD").stdout
            result = cli("recover", "--json")
            rd = j(result)
            expect(
                f"9. {probe_label}: recovery settles", rd.get("ok"), f"rc={result.returncode} {rd}"
            )
            after_commits = git("rev-list", "--count", "HEAD").stdout
            after_tag = remote_tag_commit(origin, f"v{new_ver}")
            tip = remote_branch_tip(origin)
            expect(
                f"9. {probe_label}: remote branch reaches closure",
                tip != "" and after_tag != "" and after_tag == tip,
                f"tip={tip[:12] or '(none)'} tag={after_tag[:12] or '(none)'}",
            )
            expect(
                f"9. {probe_label}: no duplicate commits on recovery",
                before_commits == after_commits or crash_point.endswith("CONTENT_PUBLISH"),
                f"{before_commits}->{after_commits}",
            )
            # T-1361 CL-04: this grepped the human output for the word CLEAN.
            # `recover` with nothing pending now RECONCILES and emits that
            # result instead -- the change that closed the hole where
            # `recover: CLEAN` was immediately followed by
            # `continue: VALIDATION_FAILED` -- so the word is gone and the
            # check was reading prose for a fact the machine surface states.
            # Ask the machine: are there pending ops? And say what was found
            # when the answer is no, instead of passing "" as the detail.
            settled = j(cli("status", "--json"))
            expect(
                f"9. {probe_label}: pending ops cleared",
                settled.get("pending_ops") == [],
                f"pending_ops={settled.get('pending_ops')!r} code={settled.get('code')!r}",
            )

    # ======================================================================
    # 9b. FRESH-CLONE CONTINUATION (worktree destroyed, committed evidence)
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-9b-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, new_ver = built
        env_crash = {**env, "SAIPEN_CRASH_AFTER_CLOSURE_PUBLISH": "1"}
        r = subprocess.run(
            [sys.executable, str(project / "tools" / "saipen.py"), "ship", "--json"],
            cwd=str(project),
            env=env_crash,
            capture_output=True,
            text=True,
            errors="replace",
        )
        expect("9b. crash injected after closure publish", r.returncode == 86, f"rc={r.returncode}")
        expect(
            "9b. closure B pushed, tag absent",
            remote_branch_tip(origin) != "" and remote_tag_commit(origin, f"v{new_ver}") == "",
            "",
        )
        shutil.rmtree(project, ignore_errors=True)
        clone = Path(tmp) / "clone"
        crc = subprocess.run(
            ["git", "clone", "-q", f"file://{origin}", str(clone)], capture_output=True, text=True
        )
        expect("9b. fresh clone succeeded", crc.returncode == 0, crc.stderr)
        if crc.returncode == 0:

            def cli_clone(*args: str):
                return subprocess.run(
                    [sys.executable, str(clone / "tools" / "saipen.py"), *args],
                    cwd=str(clone),
                    env=env,
                    capture_output=True,
                    text=True,
                    errors="replace",
                )

            result = cli_clone("ship", "--json")
            rd = j(result)
            expect(
                "9b. fresh-clone continuation publishes only the missing tag",
                rd.get("ok") and rd.get("code") == "RELEASED",
                f"code={rd.get('code')} detail={rd.get('detail')}",
            )
            tip = remote_branch_tip(origin)
            tag = remote_tag_commit(origin, f"v{new_ver}")
            expect(
                "9b. tag now matches the closure tip (non-empty)",
                tip != "" and tag == tip,
                f"tag={tag[:12] or '(none)'} tip={tip[:12] or '(none)'}",
            )

    # ======================================================================
    # 10. RECEIPT/JOURNAL write failure surfaces through the PUBLIC result
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-10-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, _new_ver = built
        from saipen_engine import journal as journal_mod
        from saipen_engine.release import execute_release, plan_release

        plan = plan_release(project, "ship")

        class _FailingJournal:
            manifest = "simulated-journal/operation.json"

            def __init__(self, *a, **k):
                pass

            def start(self, *a, **k):
                raise OSError("simulated receipt write failure")

            def exists(self):
                return False

            def read(self):
                return {}

        original_journal = journal_mod.Journal
        journal_mod.Journal = _FailingJournal
        pre_remote_tip = remote_branch_tip(origin)
        try:
            result = execute_release(project, plan)
        finally:
            journal_mod.Journal = original_journal
        expect_refusal("10a. journal write failure is a public closed refusal", result)
        expect(
            "10b. no remote stage ran after the receipt failure",
            remote_branch_tip(origin) == pre_remote_tip,
            f"before={pre_remote_tip[:12] or '(none)'} after="
            f"{remote_branch_tip(origin)[:12] or '(none)'}",
        )
        expect(
            "10c. no tag pushed after the receipt failure",
            remote_tag_commit(origin, f"v{_new_ver}") == "",
            "",
        )

    # ======================================================================
    # 11. EXACT INDEX ROLLBACK preserves a staged deletion (T-994 / § 19)
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-11-") as tmp:
        project = Path(tmp) / "idx"
        project.mkdir()
        subprocess.run(
            ["git", "init", "-q", str(project)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

        def git11(*args: str):
            return subprocess.run(
                ["git", "-C", str(project), *args],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )

        (project / "a.txt").write_text("a\n", encoding="utf-8")
        git11("add", "a.txt")
        git11("commit", "-q", "-m", "add a")
        git11("rm", "--cached", "-q", "a.txt")
        from saipen_engine.release import _capture_index_state, _restore_index

        snap = _capture_index_state(project)
        has_deletion = any(mode == "D" for _p, mode, _b in snap.entries)
        expect(
            "11a. index snapshot records the staged deletion",
            has_deletion,
            f"entries={snap.entries}",
        )
        _restore_index(project, snap)
        status = git11("diff", "--cached", "--name-status").stdout
        expect(
            "11b. staged deletion is restored exactly",
            "D\ta.txt" in status or "D a.txt" in status,
            f"status={status!r}",
        )

    # ======================================================================
    # 11c. A REVIEWED DELETION scope ships the removal (T-994 / § 2)
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-11c-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, new_ver = built
        doomed = project / "tools" / "doomed_helper.py"
        doomed.write_text("DOOMED = True\n", encoding="utf-8")
        git("add", "--", "tools/doomed_helper.py")
        git("commit", "-q", "-m", "probe: add a tracked file to delete")
        git("push", "-q", "origin", "HEAD:main")
        doomed.unlink()
        # Re-record the scope with the deletion path (the existing source file
        # is still the review subject; the deleted file is a reviewed removal).
        r = cli(
            "scope",
            "T-9000",
            "tools/saipen_engine/release_contract.py",
            "tools/doomed_helper.py",
            "--json",
        )
        expect(
            "11c. scope accepts a tracked deletion path",
            r.returncode == 0 and "SCOPE_RECORDED" in r.stdout,
            r.stdout[:200],
        )
        result = cli("ship", "--json")
        rd = j(result)
        expect(
            "11c. deletion-scope release succeeds",
            rd.get("ok") and rd.get("code") == "RELEASED",
            f"code={rd.get('code')} detail={str(rd.get('detail'))[:200]}",
        )
        clone = Path(tmp) / "clone11c"
        crc = subprocess.run(
            ["git", "clone", "-q", f"file://{origin}", str(clone)], capture_output=True, text=True
        )
        expect(
            "11c. fresh clone lacks the reviewed deletion",
            crc.returncode == 0 and not (clone / "tools" / "doomed_helper.py").exists(),
            f"clone rc={crc.returncode} exists={(clone / 'tools' / 'doomed_helper.py').exists()}",
        )
        expect(
            "11c. fresh clone still carries the reviewed source change",
            "version_badges_owned(path)"
            in (clone / "tools" / "saipen_engine" / "release_contract.py").read_text(
                encoding="utf-8-sig"
            ),
            "source change missing",
        )

    # ======================================================================
    # 12. OBJECT COUNT detector responds to a new loose object (T-994 / § 20)
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-12-") as tmp:
        project = Path(tmp) / "oc"
        project.mkdir()
        subprocess.run(
            ["git", "init", "-q", str(project)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

        def git12(*args: str, input: str | None = None):
            return subprocess.run(
                ["git", "-C", str(project), *args],
                env=env,
                capture_output=True,
                text=True,
                check=False,
                input=input,
            )

        from saipen_engine.release import _git_object_count

        before = _git_object_count(project)
        git12("hash-object", "-w", "--stdin", input="probe\n")
        after = _git_object_count(project)
        expect(
            "12. loose object creation changes the detector", after > before, f"{before}->{after}"
        )

    # ======================================================================
    # 13. Closed-code guarantee: every refusal path returns an OPS code
    # ======================================================================
    from saipen_engine.errors import CODES

    expect(
        "13. errors.CODES is non-empty and closed",
        len(CODES) > 0 and "RELEASE_FAILED" in CODES and "FIRST_PUBLISH_WAIT" in CODES,
        f"codes={sorted(CODES)}",
    )

    # ======================================================================
    # 14. UNTRACKED-ONLY scope still creates a content commit (regression:
    #     v7.223.15 false-success -- `git diff` missed an untracked scope
    #     file, so the continuation skipped the content commit entirely)
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-14-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, _new_ver = built
        # Revert the tracked edit; the ONLY remaining scope change must be a
        # brand-new untracked file (the exact trap that skipped v7.223.15's
        # content commit).
        git("checkout", "HEAD", "--", "tools/saipen_engine/release_contract.py")
        new_file = project / "tools" / "brand_new_helper.py"
        new_file.write_text("BRAND_NEW = True\n", encoding="utf-8")
        r = cli("scope", "T-9000", "tools/brand_new_helper.py", "--json")
        expect(
            "14. scope records a brand-new untracked file",
            r.returncode == 0 and "SCOPE_RECORDED" in r.stdout,
            r.stdout[:200],
        )
        head_before = git("rev-parse", "HEAD").stdout.strip()
        remote_before = remote_branch_tip(origin)
        expect(
            "14. trap precondition: HEAD == remote tip (clean surface)",
            head_before == remote_before,
            "",
        )

        result = cli("ship", "--json")
        rd = j(result)
        expect(
            "14. untracked-only release returns RELEASED",
            rd.get("ok") and rd.get("code") == "RELEASED",
            f"code={rd.get('code')} detail={str(rd.get('detail'))[:200]}",
        )
        release_commit = rd.get("commit", "")
        closure_commit = rd.get("closure_commit", "")
        expect(
            "14. a content commit A was created (not skipped)",
            bool(release_commit) and release_commit != head_before,
            f"A={release_commit[:12]} parent={head_before[:12]}",
        )
        expect(
            "14. closure B is a child of the content commit",
            bool(closure_commit)
            and git("rev-parse", f"{closure_commit}^").stdout.strip() == release_commit,
            f"B={closure_commit[:12]} A={release_commit[:12]}",
        )
        clone14 = Path(tmp) / "clone14"
        crc = subprocess.run(
            ["git", "clone", "-q", f"file://{origin}", str(clone14)], capture_output=True, text=True
        )
        expect(
            "14. fresh clone carries the untracked scope file",
            crc.returncode == 0
            and (clone14 / "tools" / "brand_new_helper.py").is_file()
            and "BRAND_NEW = True"
            in (clone14 / "tools" / "brand_new_helper.py").read_text(encoding="utf-8"),
            f"clone rc={crc.returncode}",
        )

    # ======================================================================
    # 15. SEALED LOG SEGMENT ships in the closure (regression: v7.223.16
    #     shipped a tag whose fresh clone lacked the sealed E-### events --
    #     the closure did not stage `.saipen/logs/`)
    # ======================================================================
    with tempfile.TemporaryDirectory(prefix="saipen-rel-15-") as tmp:
        built = build_fixture(Path(tmp))
        if built is None:
            return problems, checked
        project, origin, git, cli, _new_ver = built
        saipen_dir = project / ".saipen"
        segment = saipen_dir / "logs" / "LOG-999.md"
        segment.write_text("# Log\n", encoding="utf-8")
        result = cli("ship", "--json")
        rd = j(result)
        expect(
            "15. seal-with-release succeeds",
            rd.get("ok") and rd.get("code") == "RELEASED",
            f"code={rd.get('code')} detail={str(rd.get('detail'))[:200]}",
        )
        clone15 = Path(tmp) / "clone15"
        crc = subprocess.run(
            ["git", "clone", "-q", f"file://{origin}", str(clone15)], capture_output=True, text=True
        )
        seg_in_clone = (clone15 / ".saipen" / "logs" / "LOG-999.md").is_file()
        expect(
            "15. fresh clone carries the sealed segment",
            crc.returncode == 0 and seg_in_clone,
            f"clone rc={crc.returncode} seg={seg_in_clone}",
        )
        if crc.returncode == 0:
            cv = subprocess.run(
                [sys.executable, str(clone15 / "tools" / "validate.py")],
                cwd=str(clone15),
                capture_output=True,
                text=True,
            )
            log_graph_fails = [
                ln
                for ln in (cv.stdout + cv.stderr).splitlines()
                if ln.startswith("FAIL")
                and ("LOG" in ln or "parent" in ln or "duplicate event" in ln)
            ]
            expect(
                "15. fresh clone LOG graph validates (no dangling E-###)",
                not log_graph_fails,
                str(log_graph_fails[:2]),
            )

    return problems, checked


def run_producer_gate_probes() -> tuple[list[str], int]:
    """Execute T-568's six red controls: gate context decides producer severity.

    The defect these close is an OWNERSHIP one, not a parsing one. Every check
    below already existed and already fired correctly -- at the wrong severity,
    on the wrong occasions, so a stale wiki package produced by a different
    model blocked an unrelated one-line Core commit. What is under test is
    therefore the mapping from GATE to severity, which means each fixture is
    run at several gates and compared against itself.
    """
    problems: list[str] = []
    checked = 0
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "probe",
        "GIT_AUTHOR_EMAIL": "probe@example.invalid",
        "GIT_COMMITTER_NAME": "probe",
        "GIT_COMMITTER_EMAIL": "probe@example.invalid",
    }

    def validate(project: Path, *gate: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(VALIDATOR), "--project-root", str(project), *gate],
            cwd=project,
            capture_output=True,
            text=True,
            errors="replace",
        )

    def expect(
        label: str, result: subprocess.CompletedProcess[str], contains: str = "", absent: str = ""
    ) -> None:
        nonlocal checked
        checked += 1
        output = result.stdout + result.stderr
        details = []
        if contains and contains not in output:
            details.append(f"missing {contains!r}")
        if absent and absent in output:
            details.append(f"unexpected {absent!r}")
        if details:
            problems.append(f"{label}: {'; '.join(details)}")
        else:
            print(f"PASS: producer gate -- {label}")

    stale_fail = "package is stale and MUST NOT be collected"
    malformed = "fails strict OUTBOX parsing"
    soft_note = "where this producer is not being consumed"

    def fails_on(result: subprocess.CompletedProcess[str], needle: str) -> bool:
        return any(
            line.startswith("FAIL") and needle in line
            for line in (result.stdout + result.stderr).splitlines()
        )

    def expect_severity(
        label: str, result: subprocess.CompletedProcess[str], needle: str, hard: bool
    ) -> None:
        nonlocal checked
        checked += 1
        got_hard = fails_on(result, needle)
        if got_hard != hard:
            problems.append(
                f"{label}: expected {'FAIL' if hard else 'WARN'} for {needle!r}, "
                f"got {'FAIL' if got_hard else 'no FAIL'}"
            )
        else:
            print(f"PASS: producer gate -- {label}")

    def write_outbox(path: Path, body: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8", newline="\n")

    def ready_package(
        identity_head: str, fingerprint: str, role_revision: str, producer: str = "saiwiki"
    ) -> str:
        return (
            "# OUTBOX\n\n"
            "## PROBE-1: probe package\n"
            "- **status:** ready\n"
            f"- **producer:** {producer}\n"
            "- **summary:** probe package\n"
            "- **critical:** none\n"
            "- **coverage:** complete\n"
            "- **payload:** probe\n"
            "- **instructions:** apply\n"
            "- **verified:** PASS -- probe suite green\n"
            f"- **source_head:** {identity_head}\n"
            f"- **source_tree_fingerprint:** {fingerprint}\n"
            f"- **role_revision:** {role_revision}\n"
        )

    with tempfile.TemporaryDirectory(prefix="saipen-producer-gate-") as tmp:
        project = Path(tmp) / "project"
        shutil.copytree(SCENARIOS / "stale-state-reconciliation" / ".saipen", project / ".saipen")
        if (
            subprocess.run(
                ["git", "init", "-q"], cwd=project, env=env, capture_output=True, text=True
            ).returncode
            != 0
        ):
            print("SKIP: producer gate probes -- git unavailable")
            return problems, checked

        wiki = project / ".saipen/extensions/subs/saiwiki/kitchen/OUTBOX.md"
        translate = project / ".saipen/saitranslate/kitchen/OUTBOX.md"

        # Control 1 + 2 + 3: ONE stale QQ package, read at three gates.
        write_outbox(
            wiki, ready_package("0000000", "git-delta-v1:" + "0" * 64, "sha256:" + "0" * 64)
        )
        write_outbox(translate, "# OUTBOX\n")
        subprocess.run(["git", "add", "-A"], cwd=project, env=env, capture_output=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "probe"], cwd=project, env=env, capture_output=True
        )

        expect_severity(
            "1. stale QQ does not fail the default gate", validate(project), stale_fail, hard=False
        )
        expect_severity(
            "1b. stale QQ does not fail the ship gate",
            validate(project, "--gate", "ship"),
            stale_fail,
            hard=False,
        )
        expect("1c. the stale package is still visible as a WARN", validate(project), soft_note)
        expect_severity(
            "2. the same stale QQ FAILs collect:saiwiki",
            validate(project, "--gate", "collect:saiwiki"),
            stale_fail,
            hard=True,
        )
        expect_severity(
            "3. the same stale QQ FAILs the converge gate",
            validate(project, "--gate", "converge"),
            stale_fail,
            hard=True,
        )
        # Collecting one producer says nothing about another: the whole point
        # of the split is that severity follows the CONSUMED producer.
        expect_severity(
            "2b. collecting saitranslate leaves saiwiki soft",
            validate(project, "--gate", "collect:saitranslate"),
            stale_fail,
            hard=False,
        )

        # Control 4 + 5: a malformed EE package.
        write_outbox(translate, "this is not an OUTBOX at all\n")
        expect_severity(
            "4. malformed EE does not block an ordinary Core ship",
            validate(project, "--gate", "ship"),
            malformed,
            hard=False,
        )
        expect_severity(
            "5. the same malformed EE FAILs collect:saitranslate",
            validate(project, "--gate", "collect:saitranslate"),
            malformed,
            hard=True,
        )

        # Control 6: fresh exact EE and QQ pass the converge gate. Both
        # packages are bound to the identity this tree actually computes, so
        # the rung proves the gate accepts correctness rather than merely
        # rejecting everything.
        sys.path.insert(0, str(VALIDATOR.parent))
        try:
            from freshness import compute_role_revision, compute_source_identity

            wiki_charter = VALIDATOR.parent.parent / "extensions/subs/saiwiki.md"
            translate_charter = VALIDATOR.parent.parent / "extensions/subs/saitranslate.md"
            fresh_ok = wiki_charter.is_file() and translate_charter.is_file()
        except Exception as exc:
            print(f"SKIP: producer gate fresh rung -- {exc}")
            fresh_ok = False
        if fresh_ok:
            # The charters must be project-local for role_revision to derive.
            local_subs = project / ".saipen/extensions/subs"
            local_subs.mkdir(parents=True, exist_ok=True)
            for charter in (wiki_charter, translate_charter):
                shutil.copy2(charter, local_subs / charter.name)
            identity = compute_source_identity(project)
            for path, charter, producer in (
                (wiki, wiki_charter, "saiwiki"),
                (translate, translate_charter, "saitranslate"),
            ):
                write_outbox(
                    path,
                    ready_package(
                        identity.source_head,
                        identity.source_tree_fingerprint,
                        compute_role_revision(charter),
                        producer,
                    ),
                )
            result = validate(project, "--gate", "converge")
            expect(
                "6. fresh exact EE and QQ pass the converge gate",
                result,
                "both closure-required packages (EE, QQ) are ready",
            )
            expect_severity(
                "6b. no producer finding survives on fresh packages", result, stale_fail, hard=False
            )
            # Absence is a finding at the consumer's gate: nothing to collect
            # must refuse rather than report a silent green.
            write_outbox(wiki, "# OUTBOX\n")
            expect(
                "7. a producer with no ready package cannot be collected",
                validate(project, "--gate", "collect:saiwiki"),
                "no OUTBOX entry from that producer is `status: ready`",
            )
            expect(
                "8. converge names the missing closure package",
                validate(project, "--gate", "converge"),
                "required producer package(s) are missing or not ready: QQ (saiwiki)",
            )

        # An unknown gate must refuse rather than fall back to the soft
        # default: a typo'd `collect:saiwki` that ran the soft gate would
        # report green on exactly the package the caller asked to hard-check.
        typo = validate(project, "--gate", "collect:saiwki")
        expect(
            "9. a misspelled producer gate still hard-checks (no fallback)",
            typo,
            "no OUTBOX entry from that producer is `status: ready`",
        )
        unknown = validate(project, "--gate", "nonsense")
        checked += 1
        if unknown.returncode != 2 or "unknown --gate" not in (unknown.stdout + unknown.stderr):
            problems.append(
                "10. unknown gate: expected exit 2 and a named "
                f"refusal, got exit {unknown.returncode}"
            )
        else:
            print("PASS: producer gate -- 10. an unknown gate exits 2, never falls back to soft")

    return problems, checked


def run_ccc_identity_probes() -> tuple[list[str], int]:
    """Execute the T-566 canonical-commit proof in the ccc I -> SHIP -> J route.

    Needs a real repository for the same reason the hunt-mark probes do: the
    subject is commit RESOLUTION, and `tools/audit_checks.py` copies the tree
    without `.git`, so every rung here would report green against a validator
    that resolved nothing. The SHA-256 rung needs its own repository because a
    repository's object format is fixed at `git init`.
    """
    problems: list[str] = []
    checked = 0
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "probe",
        "GIT_AUTHOR_EMAIL": "probe@example.invalid",
        "GIT_COMMITTER_NAME": "probe",
        "GIT_COMMITTER_EMAIL": "probe@example.invalid",
    }

    def validate(project: Path) -> str:
        r = subprocess.run(
            [sys.executable, str(VALIDATOR), "--project-root", str(project)],
            cwd=project,
            capture_output=True,
            text=True,
            errors="replace",
        )
        return r.stdout + r.stderr

    def expect(label: str, output: str, contains: str = "", absent: str = "") -> None:
        nonlocal checked
        checked += 1
        details = []
        if contains and contains not in output:
            details.append(f"missing {contains!r}")
        if absent and absent in output:
            details.append(f"unexpected {absent!r}")
        if details:
            problems.append(f"{label}: {'; '.join(details)}")
        else:
            print(f"PASS: ccc identity -- {label}")

    unchanged = "ccc SHIP did not change source revision"
    unresolved = "ccc SHIP evidence names commit(s) this repository cannot resolve"
    mismatch = "ccc SHIP evidence does not match current source_head"

    def write_state(project: Path) -> None:
        (project / ".saipen" / "STATE.md").write_text(
            '---\nphase: SHIP\ntask: none\nnext_action: "PHASE DONE"\n'
            "blocker: none\ntransition_from: REVIEW\nsaipen_version: 7\n"
            "agent: probe\nmode: full\nexecution_intent: converge\n"
            "converge_target: ship\nupdated: 2026-01-01T00:00:00Z\n---\n",
            encoding="utf-8",
            newline="\n",
        )

    def build(raw: Path, name: str, object_format: str | None) -> Path | None:
        project = raw / name
        shutil.copytree(SCENARIOS / "stale-state-reconciliation" / ".saipen", project / ".saipen")
        init = ["init", "-q"]
        if object_format:
            init += [f"--object-format={object_format}"]
        if (
            subprocess.run(
                ["git", *init], cwd=project, env=env, capture_output=True, text=True
            ).returncode
            != 0
        ):
            return None
        write_state(project)
        return project

    def git(project: Path, *args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=project, env=env, capture_output=True, text=True, check=False
        ).stdout.strip()

    def commit(project: Path, message: str) -> str:
        git(project, "add", "-A")
        git(project, "commit", "-q", "--allow-empty", "-m", message)
        return git(project, "rev-parse", "HEAD")

    # Split so the literal never forms a version string in this file's source:
    # the cross-doc drift check scans shipped sources for cited versions, and a
    # probe fixture is not a release. Same idiom as the audit tag shim.
    probe_version = "v" + "9.9.9"

    def write_log(project: Path, base: str, entry_at: str, shipped: str) -> None:
        (project / ".saipen" / "LOG.md").write_text(
            f"{base}\n"
            f"- 26.07.17 00:01 [E-002] [parent: E-001] "
            f"DEC: ccc converge target -> ship @{entry_at}\n"
            f"- 26.07.17 00:02 [E-003] [parent: E-002] "
            f"RUN: ship {probe_version} -> pushed {shipped}\n",
            encoding="utf-8",
            newline="\n",
        )

    with tempfile.TemporaryDirectory(prefix="saipen-ccc-identity-") as tmp:
        raw = Path(tmp)
        project = build(raw, "sha1", None)
        if project is None:
            print("SKIP: ccc identity probes -- git unavailable")
            return problems, checked
        base = (project / ".saipen" / "LOG.md").read_text(encoding="utf-8-sig").rstrip("\n")
        first = commit(project, "probe: pre-ship")
        if not first:
            print("SKIP: ccc identity probes -- no commit to resolve against")
            return problems, checked

        # The defect itself. Both references name the SAME commit, one
        # abbreviated -- string equality says "different", so the check that
        # exists to catch a SHIP which changed nothing concluded it had.
        write_log(project, base, first[:7], first)
        expect("one commit at two widths is caught as unchanged", validate(project), unchanged)
        # ... and the reverse width order, because `startswith` gets exactly
        # one of the two directions right by accident.
        write_log(project, base, first, first[:7])
        expect(
            "the same pair with the widths swapped is still unchanged", validate(project), unchanged
        )

        second = commit(project, "probe: the ship commit")
        write_log(project, base, first[:7], second)
        expect("distinct commits are a real revision change", validate(project), absent=unchanged)
        expect("distinct commits match the current HEAD", validate(project), absent=mismatch)

        # Evidence that resolves to nothing proves nothing -- it must FAIL
        # rather than skip, which is T-528's shape one check over.
        write_log(project, base, first[:7], "dead0beefdead0beefdead0beefdead0beef0001")
        expect("evidence naming a commit the repository lacks fails", validate(project), unresolved)

        # A real commit that is simply not the current HEAD: the packages
        # would bind to a revision the tree has already moved past.
        commit(project, "probe: work landed after the recorded ship")
        write_log(project, base, first[:7], second)
        expect("shipped evidence behind the current HEAD fails", validate(project), mismatch)

        # Outside a repository the proof is unperformable, not failed. Without
        # this rung the canonicalization would have turned every no-Git project
        # into a hard FAIL on evidence that was never checkable there.
        nogit = raw / "nogit"
        shutil.copytree(SCENARIOS / "stale-state-reconciliation" / ".saipen", nogit / ".saipen")
        write_state(nogit)
        write_log(nogit, base, first[:7], "dead0beefdead0beefdead0beefdead0beef0001")
        expect(
            "a no-Git project warns instead of failing the proof",
            validate(nogit),
            "ccc-identity-unverifiable",
            absent=unresolved,
        )

        # SHA-256: 64-hex OIDs. The old `{7,40}` pattern did not reject these,
        # it silently matched their first 40 characters and compared a
        # truncated string, which is why this rung reads the FULL identity.
        sha256 = build(raw, "sha256", "sha256")
        if sha256 is None:
            print("SKIP: ccc identity sha256 rung -- object-format unsupported")
        else:
            base256 = (sha256 / ".saipen" / "LOG.md").read_text(encoding="utf-8-sig").rstrip("\n")
            head256 = commit(sha256, "probe: sha256 pre-ship")
            if len(head256) != 64:
                print("SKIP: ccc identity sha256 rung -- not a 64-hex repository")
            else:
                write_log(sha256, base256, head256[:12], head256)
                expect("a 64-hex OID abbreviated is still one commit", validate(sha256), unchanged)
                ship256 = commit(sha256, "probe: sha256 ship")
                write_log(sha256, base256, head256, ship256)
                expect(
                    "distinct 64-hex OIDs are a real revision change",
                    validate(sha256),
                    absent=unchanged,
                )
                expect(
                    "the full 64-hex OID resolves rather than truncating",
                    validate(sha256),
                    absent=unresolved,
                )

    return problems, checked


def run_converge_routing_probes() -> tuple[list[str], int]:
    """Execute the T-539 intent-aware routing checks against a real project.

    Scenario 7 (a clean HUNT under `execution_intent: converge` must route to
    CLEAN/finalization, never ADD) and scenario 8 (the normal intent may still
    name ADD) both need a repository whose LOG carries the clean-HUNT marker
    the check reads, so they live here with the hunt-mark probes rather than
    in audit_checks.py, which copies the tree without writing LOG lines.
    """
    problems: list[str] = []
    checked = 0

    def validate(project: Path) -> str:
        r = subprocess.run(
            [sys.executable, str(VALIDATOR), "--project-root", str(project)],
            cwd=project,
            capture_output=True,
            text=True,
            errors="replace",
        )
        return r.stdout + r.stderr

    def expect(label: str, output: str, contains: str = "", absent: str = "") -> None:
        nonlocal checked
        checked += 1
        details = []
        if contains and contains not in output:
            details.append(f"missing {contains!r}")
        if absent and absent in output:
            details.append(f"unexpected {absent!r}")
        if details:
            problems.append(f"{label}: {'; '.join(details)}")
        else:
            print(f"PASS: converge routing -- {label}")

    add_fail = "converge clean-HUNT marker present but next_action names ADD"
    valve_fail = "safety-valve pause names the goal-create key"

    def write_state(
        project: Path, intent: str, next_action: str, converge_target: str | None = None
    ) -> None:
        target_line = f"converge_target: {converge_target}\n" if converge_target else ""
        (project / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: PLAN\n"
            "task: none\n"
            f"next_action: {next_action}\n"
            "blocker: none\n"
            "transition_from: INIT\n"
            "saipen_version: 7\n"
            "agent: probe\n"
            "mode: full\n"
            f"execution_intent: {intent}\n"
            f"{target_line}"
            "updated: 2026-01-01T00:00:00Z\n"
            "---\n",
            encoding="utf-8",
            newline="\n",
        )

    with tempfile.TemporaryDirectory(prefix="saipen-converge-") as raw:
        project = Path(raw) / "project"
        shutil.copytree(SCENARIOS / "stale-state-reconciliation" / ".saipen", project / ".saipen")
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "probe",
            "GIT_AUTHOR_EMAIL": "probe@example.invalid",
            "GIT_COMMITTER_NAME": "probe",
            "GIT_COMMITTER_EMAIL": "probe@example.invalid",
        }

        def git(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["git", *args], cwd=project, env=env, capture_output=True, text=True, check=False
            )

        if git("init", "-q").returncode != 0:
            print("SKIP: converge routing probes -- git unavailable")
            return problems, checked
        git("add", "-A")
        git("commit", "-q", "-m", "probe")
        pre_ship_head = git("rev-parse", "HEAD").stdout.strip()

        log_path = project / ".saipen" / "LOG.md"
        base = log_path.read_text(encoding="utf-8-sig").rstrip("\n")

        def write_mark() -> None:
            log_path.write_text(
                f"{base}\n- 26.07.17 00:02 [E-002] [parent: E-001] [T-001] "
                f"RUN: hunt -> clean @dead0be\n",
                encoding="utf-8",
                newline="\n",
            )

        # Scenario 7 red: converge + clean-HUNT marker + next_action naming ADD
        # FAILs -- ADD is invention, the one thing a converge run never does.
        write_mark()
        write_state(project, "converge", '"PHASE ADD"')
        expect("converge clean-HUNT naming ADD fails", validate(project), add_fail)

        # Scenario 7 green: the same state with next_action at CLEAN (stage F
        # destination) must NOT trigger the converge-ADD failure.
        write_state(project, "converge", '"PHASE CLEAN"')
        expect("converge clean-HUNT routing to CLEAN passes", validate(project), absent=add_fail)

        # Scenario 8: the normal intent MAY reference ADD -- the routing check
        # is scoped to converge and must not over-fire.
        write_state(project, "normal", '"PHASE ADD"')
        expect("normal intent may still name ADD", validate(project), absent=add_fail)

        # Valve wording red: a converge safety-valve pause naming `saipen goal`
        # as its resume key is a substitution, not a continuation.
        write_state(
            project,
            "converge",
            "\"WAIT: safety valve reached (N waves / M tickets) -- run 'saipen goal' to continue\"",
        )
        expect("converge valve pause naming saipen goal fails", validate(project), valve_fail)

        # Valve wording green: the cc form is the legal converge resume.
        write_state(
            project,
            "converge",
            "\"WAIT: safety valve reached (N waves / M tickets) -- run 'cc' to continue\"",
        )
        expect("converge valve pause naming cc passes", validate(project), absent=valve_fail)

        # Scenario 25 red: a persisted ccc route that prepares before its SHIP
        # boundary is rejected even though all event shapes are individually legal.
        log_path.write_text(
            f"{base}\n"
            "- 17.07.26 00:02 [E-002] [parent: E-001] "
            f"DEC: ccc converge target -> ship @{pre_ship_head}\n"
            "- 17.07.26 00:03 [E-003] [parent: E-002] "
            "RUN: prepare saitranslate -> done\n",
            encoding="utf-8",
            newline="\n",
        )
        write_state(project, "converge", '"PHASE PREPARE"', "ship")
        expect(
            "scenario 25 ccc preparation before SHIP fails",
            validate(project),
            contains="ccc prepared EE/QQ before SHIP",
        )

        # Green order: SHIP appears before either producer preparation.
        git("commit", "--allow-empty", "-q", "-m", "ccc ship")
        shipped_head = git("rev-parse", "HEAD").stdout.strip()
        log_path.write_text(
            f"{base}\n"
            "- 17.07.26 00:02 [E-002] [parent: E-001] "
            f"DEC: ccc converge target -> ship @{pre_ship_head}\n"
            "- 17.07.26 00:03 [E-003] [parent: E-002] "
            f"RUN: ship v0.0.0 -> pushed {shipped_head}\n"
            "- 17.07.26 00:04 [E-004] [parent: E-003] "
            "RUN: prepare saitranslate -> done\n",
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "scenario 25 ccc SHIP-before-prepare passes",
            validate(project),
            absent="ccc prepared EE/QQ before SHIP",
        )

    return problems, checked


def run_role_freshness_probes() -> tuple[list[str], int, int]:
    """Execute T-542/T-543 role and source freshness controls."""
    problems: list[str] = []
    checked = 0
    skipped = 0

    def validate(project: Path) -> str:
        result = subprocess.run(
            [sys.executable, str(VALIDATOR), "--project-root", str(project)],
            cwd=project,
            capture_output=True,
            text=True,
            errors="replace",
        )
        return result.stdout + result.stderr

    def expect(label: str, output: str, contains: str = "", absent: str = "") -> None:
        nonlocal checked
        checked += 1
        details = []
        if contains and contains not in output:
            details.append(f"missing {contains!r}")
        if absent and absent in output:
            details.append(f"unexpected {absent!r}")
        if details:
            problems.append(f"{label}: {'; '.join(details)}")
        else:
            print(f"PASS: role/source freshness -- {label}")

    mismatch = "produced under a superseded role"
    stale_warn = "carry an old role_revision"
    fp_fail = "the current tree computes"

    def write_charter(project: Path, behavior: str) -> str:
        directory = project / ".saipen" / "extensions" / "subs"
        directory.mkdir(parents=True, exist_ok=True)
        charter = directory / "saiwiki.md"
        charter.write_text(
            "# saiwiki -- the documenter\n\n"
            "```yaml\n"
            "role_kind: PRODUCER\n"
            "write_scope: .saipen/extensions/subs/saiwiki/\n"
            "trigger: bare saiwiki\n"
            "collect_policy: explicit\n"
            "done_condition: ready\n"
            "freshness_inputs: [source_head, source_tree_fingerprint, role_revision]\n"
            "output_contract: outbox\n"
            "role_revision: sha256:pending\n"
            "```\n\n"
            f"Behavior: {behavior}\n",
            encoding="utf-8",
            newline="\n",
        )
        revision = compute_role_revision(charter)
        charter.write_text(
            charter.read_text(encoding="utf-8").replace("sha256:pending", revision),
            encoding="utf-8",
            newline="\n",
        )
        return revision

    def write_sub(project: Path, inst_rev: str, outbox_rev: str, identity: SourceIdentity) -> None:
        sub = project / ".saipen" / "extensions" / "subs" / "saiwiki"
        (sub / "kitchen").mkdir(parents=True, exist_ok=True)
        (sub / "STATE.md").write_text(
            "---\n"
            "phase: DONE\n"
            "task: none\n"
            'next_action: "saipen continue"\n'
            "blocker: none\n"
            "transition_from: SHIP\n"
            "saipen_version: 7\n"
            "agent: saiwiki\n"
            "mode: read-only\n"
            f"role_revision: {inst_rev}\n"
            "updated: 2026-01-01T00:00:00Z\n"
            "---\n",
            encoding="utf-8",
            newline="\n",
        )
        (sub / "kitchen" / "OUTBOX.md").write_text(
            "# OUTBOX\n\n"
            "## WIKI-900: probe package\n"
            "- **status:** ready\n"
            "- **summary:** probe\n"
            "- **critical:** false\n"
            "- **producer:** saiwiki\n"
            f"- **source_head:** {identity.source_head}\n"
            f"- **source_tree_fingerprint:** {identity.source_tree_fingerprint}\n"
            f"- **role_revision:** {outbox_rev}\n"
            "- **coverage:** probe\n"
            "- **payload:** probe\n"
            "- **verified:** probe\n"
            "- **instructions:** probe\n",
            encoding="utf-8",
            newline="\n",
        )

    with tempfile.TemporaryDirectory(prefix="saipen-rolefresh-") as raw:
        project = Path(raw) / "project"
        shutil.copytree(SCENARIOS / "stale-state-reconciliation" / ".saipen", project / ".saipen")
        (project / ".gitignore").write_text(
            ".saipen/\n.freebuff/\n.pytest_cache/\n.ruff_cache/\n"
            ".claude/\n*.db\n*-wal\n*-shm\nnul\n",
            encoding="utf-8",
            newline="\n",
        )
        source = project / "source.txt"
        source.write_text("base\n", encoding="utf-8")
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "probe",
            "GIT_AUTHOR_EMAIL": "probe@example.invalid",
            "GIT_COMMITTER_NAME": "probe",
            "GIT_COMMITTER_EMAIL": "probe@example.invalid",
        }

        def git(*args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                ["git", *args], cwd=project, env=env, capture_output=True, text=True, check=False
            )

        if git("init", "-q").returncode != 0:
            print("SKIP: role/source freshness probes -- git unavailable")
            return problems, checked, 1
        git("add", "-A")
        git("commit", "-q", "-m", "probe")

        rev1 = write_charter(project, "v1")
        identity = compute_source_identity(project)
        write_sub(project, rev1, rev1, identity)
        expect("matching derived charter+package passes", validate(project), absent=mismatch)

        charter = project / ".saipen" / "extensions" / "subs" / "saiwiki.md"
        charter.write_text(
            charter.read_text(encoding="utf-8").replace("Behavior: v1", "Behavior: v2"),
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "charter behavior change without revision edit makes package stale",
            validate(project),
            mismatch,
        )

        rev2 = write_charter(project, "v2")
        charter_bytes = charter.read_bytes()
        charter.write_bytes(charter_bytes.replace(b"\n", b"\r\n"))
        expect(
            "role revision is stable across LF and CRLF checkouts",
            compute_role_revision(charter),
            contains=rev2,
        )
        charter.write_bytes(charter_bytes)
        identity = compute_source_identity(project)
        write_sub(project, rev1, rev2, identity)
        expect("instance on old derived revision is detected", validate(project), stale_warn)

        baseline = compute_source_identity(project)
        source.write_text("tracked dirty\n", encoding="utf-8")
        dirty = compute_source_identity(project)
        expect(
            "tracked dirty source changes fingerprint",
            dirty.source_tree_fingerprint,
            absent=baseline.source_tree_fingerprint,
        )
        source.write_text("base\n", encoding="utf-8")

        untracked = project / "new-source.txt"
        before = compute_source_identity(project)
        untracked.write_text("new\n", encoding="utf-8")
        after = compute_source_identity(project)
        expect(
            "untracked non-ignored source changes fingerprint",
            after.source_tree_fingerprint,
            absent=before.source_tree_fingerprint,
        )
        untracked.unlink()

        # The pre-T-543 concatenation (`path + NUL + content`, repeated) is
        # ambiguous: {a:b, c:d} and {a:empty, bc:d} produce identical bytes.
        # The framed representation must distinguish the two real trees.
        a_path, c_path, bc_path = (project / "a", project / "c", project / "bc")
        a_path.write_bytes(b"b")
        c_path.write_bytes(b"d")
        framed_one = compute_source_identity(project)
        c_path.unlink()
        a_path.write_bytes(b"")
        bc_path.write_bytes(b"d")
        framed_two = compute_source_identity(project)
        legacy_one = b"a\0b" + b"c\0d"
        legacy_two = b"a\0" + b"bc\0d"
        expect(
            "framing separates trees that collide under raw concatenation",
            framed_two.source_tree_fingerprint,
            absent=(
                framed_one.source_tree_fingerprint
                if legacy_one == legacy_two
                else "framing-control-broken"
            ),
        )
        a_path.unlink()
        bc_path.unlink()

        # The delta model is HEAD vs WORKING TREE, so the mode has to change
        # where that model looks -- on disk. `git update-index --chmod` moves
        # the INDEX only, which is how this rung used to measure git's
        # fallback instead of the fingerprint. Whether the host can represent
        # a tracked executable-bit transition is now MEASURED, never assumed
        # from `os.name` or `core.fileMode`: chmod on disk, stat it again,
        # then ask Git for the resulting HEAD-vs-working-tree delta. A
        # filesystem that cannot carry the bit, or a repository whose Git
        # config cannot see it, SKIPs out loud (T-572).
        source_mode = source.stat().st_mode
        try:
            before = compute_source_identity(project)
            os.chmod(source, source_mode | 0o111)
            post_mode = source.stat().st_mode
            delta = git("diff", "--raw", "-z", "--no-renames", "HEAD", "--", "source.txt").stdout
            old_mode = new_mode = None
            for field in delta.split("\0"):
                parts = field.split()
                if field.startswith(":") and len(parts) == 5:
                    old_mode = int(parts[0][1:], 8)
                    new_mode = int(parts[1], 8)
                    break
            represented = (
                (post_mode & 0o111) != (source_mode & 0o111)
                and old_mode is not None
                and (new_mode & 0o111) != (old_mode & 0o111)
            )
            if not represented:
                print(
                    "SKIP: role freshness -- this host cannot represent a "
                    "tracked executable-bit transition in the "
                    "HEAD-vs-working-tree delta"
                )
                skipped += 1
            else:
                mode_changed = compute_source_identity(project)
                expect(
                    "tracked mode change changes fingerprint",
                    mode_changed.source_tree_fingerprint,
                    absent=before.source_tree_fingerprint,
                )
        finally:
            os.chmod(source, source_mode)

        outside_one = Path(raw) / "outside-one.txt"
        outside_two = Path(raw) / "outside-two.txt"
        outside_one.write_text("one\n", encoding="utf-8")
        outside_two.write_text("one\n", encoding="utf-8")
        if symlinks_available():
            link = project / "outside-link"
            os.symlink(os.path.relpath(outside_one, project), link)
            link_identity = compute_source_identity(project)
            outside_one.write_text("changed outside bytes\n", encoding="utf-8")
            outside_bytes_changed = compute_source_identity(project)
            expect(
                "symlink hashes target text and never outside-root bytes",
                outside_bytes_changed.source_tree_fingerprint,
                contains=link_identity.source_tree_fingerprint,
            )
            link.unlink()
            os.symlink(os.path.relpath(outside_two, project), link)
            link_target_changed = compute_source_identity(project)
            expect(
                "symlink target-text change changes fingerprint",
                link_target_changed.source_tree_fingerprint,
                absent=link_identity.source_tree_fingerprint,
            )
            link.unlink()
        else:
            print(
                "SKIP: role freshness -- symlink probes need a host that "
                "can create symlinks (Developer Mode or "
                "SeCreateSymbolicLinkPrivilege on Windows)"
            )
            skipped += 2

        spaced = project / "with space.txt"
        before = compute_source_identity(project)
        spaced.write_text("space\n", encoding="utf-8")
        after = compute_source_identity(project)
        expect(
            "filename with spaces is fingerprinted",
            after.source_tree_fingerprint,
            absent=before.source_tree_fingerprint,
        )
        spaced.unlink()

        unicode_name = project / "tõstrik-ü.txt"
        before = compute_source_identity(project)
        unicode_name.write_text("üñïçødé\n", encoding="utf-8")
        after = compute_source_identity(project)
        expect(
            "Unicode filename is fingerprinted",
            after.source_tree_fingerprint,
            absent=before.source_tree_fingerprint,
        )
        unicode_name.unlink()

        case_one = project / "CaseDistinct.txt"
        case_two = project / "casedistinct.txt"
        case_one.write_text("upper\n", encoding="utf-8")
        before = compute_source_identity(project)
        holds_case = False
        try:
            case_two.write_text("lower\n", encoding="utf-8")
            holds_case = case_one.lstat().st_ino != case_two.lstat().st_ino
        except OSError:
            holds_case = False
        if holds_case:
            after = compute_source_identity(project)
            case_two.unlink()
            mid = compute_source_identity(project)
            expect(
                "case-distinct filenames fingerprint independently",
                after.source_tree_fingerprint,
                absent=before.source_tree_fingerprint,
            )
            expect(
                "removing one case-distinct file changes fingerprint",
                mid.source_tree_fingerprint,
                absent=after.source_tree_fingerprint,
            )
        else:
            # A case-insensitive host does not raise on the second write -- it
            # silently aliases the first file, so the inode comparison above
            # is the capability test, not the write's success (T-572).
            print(
                "SKIP: role freshness -- host filesystem cannot hold two "
                "case-distinct filenames simultaneously"
            )
            skipped += 2
        for leftover in (case_one, case_two):
            with contextlib.suppress(OSError):
                leftover.unlink()

        outer = Path(raw) / "outer-repo"
        outer.mkdir()
        inner = outer / "nested-project"
        inner.mkdir()
        (inner / "inner-source.txt").write_text("inner\n", encoding="utf-8")
        if (
            subprocess.run(
                ["git", "init", "-q"], cwd=outer, env=env, capture_output=True, text=True
            ).returncode
            == 0
        ):
            nested_identity = compute_source_identity(inner)
            expect(
                "nested project inside another git repository uses the no-Git discovery model",
                nested_identity.discovery_model,
                contains="no-git-tree-v1",
            )
        else:
            print("SKIP: role freshness -- nested-repository probe needs git")
            skipped += 1

        ignored = project / ".freebuff" / "runtime.db"
        ignored.parent.mkdir(parents=True, exist_ok=True)
        before = compute_source_identity(project)
        ignored.write_text("one\n", encoding="utf-8")
        ignored.write_text("two\n", encoding="utf-8")
        after = compute_source_identity(project)
        expect(
            "ignored runtime mutation does not change fingerprint",
            after.source_tree_fingerprint,
            contains=before.source_tree_fingerprint,
        )

        original_run_git = freshness._run_git
        head_reads = 0

        def moving_head(root: Path, *args: str) -> bytes:
            nonlocal head_reads
            result = original_run_git(root, *args)
            if args[:2] == ("rev-parse", "--verify") and args[2:] == ("HEAD",):
                head_reads += 1
                if head_reads == 2:
                    return b"f" * 40 + b"\n"
            return result

        try:
            with mock.patch.object(freshness, "_run_git", side_effect=moving_head):
                compute_source_identity(project)
        except FreshnessError:
            expect("HEAD movement during computation fails", "failed", contains="failed")
        else:
            expect("HEAD movement during computation fails", "passed", contains="failed")

        noise = project / ".saipen" / "kitchen" / "producer-noise.txt"
        noise.parent.mkdir(parents=True, exist_ok=True)
        noise.write_text("baseline\n", encoding="utf-8")
        git("add", "-f", ".saipen/kitchen/producer-noise.txt")
        git("commit", "-q", "-m", "tracked producer noise")
        before = compute_source_identity(project)
        noise.write_text("checkpoint\n", encoding="utf-8")
        after = compute_source_identity(project)
        expect(
            "tracked .saipen bookkeeping mutation does not change fingerprint",
            after.source_tree_fingerprint,
            contains=before.source_tree_fingerprint,
        )

        original_parse_delta = freshness._parse_git_delta_evidence
        parse_reads = 0

        def mutate_after_second_read(
            root: Path, raw_delta: bytes, raw_untracked: bytes, path_map=None
        ):
            nonlocal parse_reads
            records = original_parse_delta(root, raw_delta, raw_untracked, path_map)
            parse_reads += 1
            if parse_reads == 2:
                source.write_text("raced after second read\n", encoding="utf-8")
            return records

        try:
            with mock.patch.object(
                freshness,
                "_parse_git_delta_evidence",
                side_effect=mutate_after_second_read,
            ):
                compute_source_identity(project)
        except FreshnessError:
            expect("content race after second sample fails", "failed", contains="failed")
        else:
            expect("content race after second sample fails", "passed", contains="failed")
        source.write_text("base\n", encoding="utf-8")

        before = compute_source_identity(project)
        source.unlink()
        after = compute_source_identity(project)
        expect(
            "tracked source deletion changes fingerprint",
            after.source_tree_fingerprint,
            absent=before.source_tree_fingerprint,
        )
        source.write_text("base\n", encoding="utf-8")

        before = compute_source_identity(project)
        renamed = project / "renamed-source.txt"
        source.rename(renamed)
        after = compute_source_identity(project)
        expect(
            "source rename changes fingerprint",
            after.source_tree_fingerprint,
            absent=before.source_tree_fingerprint,
        )
        renamed.rename(source)

        source.write_text("unreadable probe\n", encoding="utf-8")
        try:
            with mock.patch.object(
                freshness.os, "read", side_effect=PermissionError("probe unreadable")
            ):
                compute_source_identity(project)
        except FreshnessError:
            expect("unreadable required input fails computation", "failed", contains="failed")
        else:
            expect("unreadable required input fails computation", "passed", contains="failed")
        source.write_text("base\n", encoding="utf-8")

        identity = compute_source_identity(project)
        write_sub(project, rev2, rev2, identity)
        expect("package bound to current source passes", validate(project), absent=fp_fail)

        generic_protocol = project / ".saipen" / "extensions" / "subs" / "PROTOCOL.md"
        generic_protocol.write_text("generic contract v1\n", encoding="utf-8")
        generic_revision = compute_generic_role_revision(generic_protocol)
        generic_outbox = (
            project / ".saipen" / "extensions" / "subs" / "saicustom" / "kitchen" / "OUTBOX.md"
        )
        generic_outbox.parent.mkdir(parents=True)
        wiki_outbox = (
            project / ".saipen" / "extensions" / "subs" / "saiwiki" / "kitchen" / "OUTBOX.md"
        )
        generic_outbox.write_text(
            wiki_outbox.read_text(encoding="utf-8")
            .replace("## WIKI-900:", "## CUSTOM-900:")
            .replace("- **producer:** saiwiki", "- **producer:** saicustom")
            .replace(rev2, generic_revision),
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "generic role binds to its governing PROTOCOL digest",
            validate(project),
            absent=mismatch,
        )
        generic_protocol.write_text("generic contract v2\n", encoding="utf-8")
        expect(
            "generic role contract change makes package stale", validate(project), contains=mismatch
        )
        generic_outbox.unlink()
        generic_outbox.parent.rmdir()
        generic_outbox.parent.parent.rmdir()
        generic_protocol.unlink()
        identity = compute_source_identity(project)
        write_sub(project, rev2, rev2, identity)

        source.write_text("final mutation\n", encoding="utf-8")
        expect("package produced before final source mutation is stale", validate(project), fp_fail)

        source.write_text("base\n", encoding="utf-8")
        identity = compute_source_identity(project)
        write_sub(project, rev2, rev2, identity)
        noise.write_text("post-package producer noise\n", encoding="utf-8")
        expect(
            "producer noise after package creation stays fresh", validate(project), absent=fp_fail
        )

        git("commit", "--allow-empty", "-q", "-m", "head-only movement")
        expect(
            "package with old source_head is stale even when delta matches",
            validate(project),
            contains="current source_head",
        )

        try:
            with mock.patch.object(
                freshness.subprocess, "run", side_effect=FileNotFoundError("probe git unavailable")
            ):
                compute_source_identity(project)
        except FreshnessError:
            expect("Git discovery failure cannot degrade to no-Git", "failed", contains="failed")
        else:
            expect("Git discovery failure cannot degrade to no-Git", "passed", contains="failed")

        no_git = Path(raw) / "no-git-project"
        no_git.mkdir()
        no_git_source = no_git / "source.txt"
        no_git_source.write_text("source\n", encoding="utf-8")
        named_like_runtime = no_git / "node_modules"
        before_named_file = compute_source_identity(no_git)
        named_like_runtime.write_text("real source file\n", encoding="utf-8")
        after_named_file = compute_source_identity(no_git)
        expect(
            "no-Git runtime names exclude directories, not files",
            after_named_file.source_tree_fingerprint,
            absent=before_named_file.source_tree_fingerprint,
        )
        no_git_before = compute_source_identity(no_git)
        no_git_noise = no_git / ".freebuff" / "runtime.db"
        no_git_noise.parent.mkdir()
        no_git_noise.write_text("one\n", encoding="utf-8")
        no_git_noise.write_text("two\n", encoding="utf-8")
        no_git_after = compute_source_identity(no_git)
        expect(
            "no-Git fallback uses its explicit runtime exclusions",
            no_git_after.source_tree_fingerprint,
            contains=no_git_before.source_tree_fingerprint,
        )

        # A FIFO is unsupported fingerprint input. Only the no-Git walk
        # enumerates every directory entry (scandir), so it is the model that
        # actually meets the object; the Git-delta model never sees it because
        # `git ls-files --others` does not report one -- CI measured that
        # (T-572), so the probe lives against the walk that raises.
        if hasattr(os, "mkfifo"):
            fifo = no_git / "pipe.fifo"
            os.mkfifo(fifo)
            try:
                compute_source_identity(no_git)
            except FreshnessError:
                expect(
                    "unsupported filesystem object fails computation", "failed", contains="failed"
                )
            else:
                expect(
                    "unsupported filesystem object fails computation", "passed", contains="failed"
                )
            finally:
                fifo.unlink()
        else:
            print("SKIP: role freshness -- FIFO probe needs a POSIX host (os.mkfifo unavailable)")
            skipped += 1

        no_git_exec = no_git / "script.sh"
        no_git_exec.write_text("#!/bin/sh\n", encoding="utf-8")
        exec_mode = no_git_exec.stat().st_mode
        try:
            os.chmod(no_git_exec, exec_mode | 0o111)
            post_mode = no_git_exec.stat().st_mode
            if (post_mode & 0o111) != (exec_mode & 0o111):
                no_git_exec_before = compute_source_identity(no_git)
                os.chmod(no_git_exec, exec_mode)
                no_git_exec_after = compute_source_identity(no_git)
                expect(
                    "no-Git executable-bit change changes fingerprint",
                    no_git_exec_after.source_tree_fingerprint,
                    absent=no_git_exec_before.source_tree_fingerprint,
                )
            else:
                print(
                    "SKIP: role freshness -- host cannot express an "
                    "executable bit in the no-Git discovery model"
                )
                skipped += 1
        finally:
            os.chmod(no_git_exec, exec_mode)
        no_git_exec.unlink()

        if junctions_available():
            junction_outside = Path(raw) / "junction-outside"
            junction_outside.mkdir()
            (junction_outside / "content.txt").write_text("v1\n", encoding="utf-8")
            junction = no_git / "junction-dir"
            result = subprocess.run(
                ["cmd", "/c", "mklink", "/J", os.fspath(junction), os.fspath(junction_outside)],
                capture_output=True,
                text=True,
                errors="replace",
            )
            if result.returncode == 0 and junction.exists():
                j_before = compute_source_identity(no_git)
                (junction_outside / "content.txt").write_text("v2\n", encoding="utf-8")
                j_after = compute_source_identity(no_git)
                expect(
                    "no-Git walk hashes a junction as link identity and "
                    "never recurses outside the root",
                    j_after.source_tree_fingerprint,
                    contains=j_before.source_tree_fingerprint,
                )
                junction.rmdir()
            else:
                print("SKIP: role freshness -- mklink /J failed despite the capability probe")
                skipped += 1
        else:
            print(
                "SKIP: role freshness -- junction probe needs a Windows "
                "host able to create junctions (cmd mklink /J)"
            )
            skipped += 1

    return problems, checked, skipped


def run_sub_clean_probes() -> tuple[list[str], int, int]:
    """Execute T-545 evidence-gated cleanup controls (scenarios 22-24)."""
    problems: list[str] = []
    checked = 0
    skipped = 0

    def expect(
        label: str, blockers: tuple[str, ...], contains: str = "", empty: bool = False
    ) -> None:
        nonlocal checked
        checked += 1
        joined = "\n".join(blockers)
        failed = (empty and bool(blockers)) or (contains and contains not in joined)
        if failed:
            problems.append(f"{label}: blockers={blockers!r}")
        else:
            print(f"PASS: sub-clean safety -- {label}")

    with tempfile.TemporaryDirectory(prefix="saipen-sub-clean-") as raw:
        instance = Path(raw) / ".saipen" / "extensions" / "subs" / "saiwiki"
        kitchen = instance / "kitchen"
        kitchen.mkdir(parents=True)
        board = instance / "BOARD.md"
        board.write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8", newline="\n"
        )
        outbox = kitchen / "OUTBOX.md"
        outbox.write_text(
            "# OUTBOX\n\n## WIKI-001: history\n- **status:** reviewed\n",
            encoding="utf-8",
            newline="\n",
        )

        expect("reviewed history alone permits cleanup", sub_clean_blockers(instance), empty=True)
        cli = subprocess.run(
            [sys.executable, str(HOME / "tools" / "sub_clean.py"), "saiwiki"],
            cwd=raw,
            capture_output=True,
            text=True,
            errors="replace",
        )
        expect(
            "bare sub name resolves from project root",
            () if cli.returncode == 0 else (cli.stdout + cli.stderr,),
            empty=True,
        )

        board.unlink()
        expect(
            "missing BOARD fails closed",
            sub_clean_blockers(instance),
            contains="missing lifecycle evidence: BOARD.md",
        )
        board.write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8", newline="\n"
        )
        board.write_text(
            "# Board\n## DOING\n## TOOD\n## DONE\n## BLOCKED\n", encoding="utf-8", newline="\n"
        )
        expect(
            "malformed BOARD fails closed",
            sub_clean_blockers(instance),
            contains="malformed BOARD sections",
        )
        board.write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n- [ ] SUB-OLD wrong state\n## BLOCKED\n",
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "section-checkbox mismatch fails closed",
            sub_clean_blockers(instance),
            contains="malformed DONE item state",
        )
        board.write_text(
            "# Board\n## DOING\n## TODO\n  - [ ] SUB-HIDDEN indented\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "indented BOARD ticket fails closed",
            sub_clean_blockers(instance),
            contains="malformed BOARD item indentation",
        )
        board.write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8", newline="\n"
        )

        outbox.unlink()
        expect(
            "missing OUTBOX fails closed",
            sub_clean_blockers(instance),
            contains="missing lifecycle evidence: kitchen/OUTBOX.md",
        )
        outbox.write_text(
            "# OUTBOX\n\n## WIKI-001: history\n- **status:** reviewed\n",
            encoding="utf-8",
            newline="\n",
        )
        outbox.write_text(
            "# OUTBOX\n\npackage text with no entry or status\n", encoding="utf-8", newline="\n"
        )
        expect(
            "nonempty unparseable OUTBOX fails closed",
            sub_clean_blockers(instance),
            contains="nonempty OUTBOX has no valid package entry",
        )
        outbox.write_text("# OUTBOX\n\n## WIKI-001: history\n", encoding="utf-8", newline="\n")
        expect(
            "OUTBOX entry without status fails closed",
            sub_clean_blockers(instance),
            contains="0 status fields",
        )
        outbox.write_text(
            "# OUTBOX\n\n## WIKI-001: history\n"
            "<!-- - **status:** reviewed -->\n"
            "```markdown\n- **status:** reviewed\n## WIKI-999: fake\n```\n",
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "commented or fenced status cannot authorize cleanup",
            sub_clean_blockers(instance),
            contains="0 status fields",
        )
        outbox.write_text(
            "# OUTBOX\n\n## WIKI-001: history\n    - **status:** reviewed\n",
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "indented-code status cannot authorize cleanup",
            sub_clean_blockers(instance),
            contains="0 status fields",
        )
        outbox.write_text(
            "# OUTBOX\n\n## WIKI-001: history\n- **status:** reviewed\n### Wiki-X: hidden\n",
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "malformed mixed-case entry heading fails closed",
            sub_clean_blockers(instance),
            contains="malformed OUTBOX entry heading",
        )
        outbox.write_text(
            "# OUTBOX\n\n## WIKI-001: history\n<!-- open\n- **status:** reviewed\n",
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "unclosed OUTBOX comment fails closed",
            sub_clean_blockers(instance),
            contains="unclosed HTML comment",
        )
        outbox.write_text(
            "# OUTBOX\n\n## WIKI-001: history\n````markdown\n- **status:** reviewed\n```\n",
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "unclosed long OUTBOX fence fails closed",
            sub_clean_blockers(instance),
            contains="unclosed fenced block",
        )

        outbox.write_text(
            "# OUTBOX\n\n## WIKI-002: package\n- **status:** ready\n",
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "scenario 22 ready-unreviewed OUTBOX blocks cleanup",
            sub_clean_blockers(instance),
            contains="OUTBOX status ready",
        )

        outbox.write_text("# OUTBOX\n", encoding="utf-8", newline="\n")
        old = 946684800
        os.utime(instance, (old, old))
        os.utime(board, (old, old))
        os.utime(outbox, (old, old))
        expect(
            "scenario 23 elapsed time alone cannot delete or block",
            sub_clean_blockers(instance),
            empty=True,
        )

        (instance / "LOG.md").write_text(
            "# Log\n- collect 1\n- collect 2\n- collect 3\n", encoding="utf-8", newline="\n"
        )
        expect(
            "scenario 24 repeated collects do not make history stale",
            sub_clean_blockers(instance),
            empty=True,
        )

        board.write_text(
            "# Board\n## DOING\n## TODO\n- [ ] SUB-001 open\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
            newline="\n",
        )
        expect(
            "open TODO blocks cleanup", sub_clean_blockers(instance), contains="TODO: SUB-001 open"
        )
        board.write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8", newline="\n"
        )

        nested_outbox = kitchen / "pending" / "OUTBOX.md"
        nested_outbox.parent.mkdir()
        nested_outbox.write_text("payload\n", encoding="utf-8", newline="\n")
        expect(
            "nested OUTBOX is an artifact, not the root exemption",
            sub_clean_blockers(instance),
            contains="pending/OUTBOX.md",
        )
        nested_outbox.unlink()
        nested_outbox.parent.rmdir()

        patch = kitchen / "pending.patch"
        patch.write_text("diff\n", encoding="utf-8", newline="\n")
        expect(
            "unacknowledged patch blocks cleanup",
            sub_clean_blockers(instance),
            contains="pending.patch",
        )
        patch.unlink()

        recovery = instance / "recovery" / "STATE.md"
        recovery.parent.mkdir()
        recovery.write_text("evidence\n", encoding="utf-8", newline="\n")
        expect(
            "unpreserved recovery evidence blocks cleanup",
            sub_clean_blockers(instance),
            contains="recovery/STATE.md",
        )
        preserved = Path(raw) / "preserved"
        preserved.mkdir()
        (preserved / "STATE.md").write_text("evidence\n", encoding="utf-8", newline="\n")
        expect(
            "byte-preserved recovery evidence permits cleanup",
            sub_clean_blockers(instance, preserved),
            empty=True,
        )

        if symlinks_available():
            recovery.unlink()
            os.symlink(os.fspath(preserved / "STATE.md"), recovery)
            blockers = sub_clean_blockers(instance, preserved)
            expect(
                "symlink recovery evidence is rejected even when its "
                "target content matches preserved bytes",
                blockers,
                contains="non-preserved recovery evidence",
            )
            recovery.unlink()
            recovery.write_text("evidence\n", encoding="utf-8", newline="\n")

            outside_ev = Path(raw) / "outside-recovery-dir"
            outside_ev.mkdir()
            (outside_ev / "hidden.txt").write_text("hidden\n", encoding="utf-8", newline="\n")
            sublink = instance / "recovery" / "sublink"
            sublink.symlink_to(outside_ev, target_is_directory=True)
            blockers = sub_clean_blockers(instance, preserved)
            expect(
                "directory symlink under recovery is never recursed",
                blockers,
                contains="non-preserved recovery evidence",
            )
            sublink.unlink()

            os.rename(instance / "recovery", instance / "recovery-real")
            os.symlink(os.fspath(preserved), instance / "recovery")
            blockers = sub_clean_blockers(instance, preserved)
            expect(
                "a recovery dir that is itself a symlink is rejected",
                blockers,
                contains="non-preserved recovery evidence",
            )
            (instance / "recovery").unlink()
            os.rename(instance / "recovery-real", instance / "recovery")
        else:
            print(
                "SKIP: sub-clean safety -- symlink probes need a host that "
                "can create symlinks (Developer Mode or "
                "SeCreateSymbolicLinkPrivilege on Windows)"
            )
            skipped += 3

        if junctions_available():
            real_ev = Path(raw) / "junction-evidence"
            real_ev.mkdir()
            (real_ev / "hidden.txt").write_text("hidden\n", encoding="utf-8", newline="\n")
            junction = instance / "recovery" / "junction-link"
            result = subprocess.run(
                ["cmd", "/c", "mklink", "/J", os.fspath(junction), os.fspath(real_ev)],
                capture_output=True,
                text=True,
                errors="replace",
            )
            if result.returncode == 0 and junction.exists():
                blockers = sub_clean_blockers(instance, preserved)
                expect(
                    "directory junction is never recursed and is rejected",
                    blockers,
                    contains="non-preserved recovery evidence",
                )
                junction.rmdir()
            else:
                print(
                    "SKIP: sub-clean safety -- mklink /J failed on this "
                    "host despite the capability probe"
                )
                skipped += 1
        else:
            print(
                "SKIP: sub-clean safety -- junction probe needs a Windows "
                "host able to create junctions (cmd mklink /J); a Linux "
                "symlink test is not proof of junction behavior"
            )
            skipped += 1

    return problems, checked, skipped


def run_hardening_control_inventory() -> tuple[list[str], int]:
    """Prove all 30 hardening red controls resolve to executable evidence.

    `hardening_controls.json` is platform-independent data -- every owner is a
    plain repository-relative file path and every anchor is plain text with no
    platform branch -- and the checks below prove that shape mechanically, so
    a future entry cannot quietly make the registry platform-conditional.
    """
    problems: list[str] = []
    checked = 0
    registry_path = HOME / "tools" / "hardening_controls.json"
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"hardening control registry unreadable: {exc}"], 0
    if not isinstance(registry, list):
        return [f"hardening control registry must be a JSON list, got {type(registry).__name__}"], 0
    expected_keys = {"id", "name", "owner", "anchor"}
    seen_names: set[str] = set()
    seen_anchors: set[str] = set()
    ids = []
    for index, entry in enumerate(registry, 1):
        if not isinstance(entry, dict):
            return [f"hardening control #{index} is not a JSON object"], index - 1
        if set(entry) != expected_keys:
            return [
                f"hardening control #{index} keys are {sorted(entry)!r}, "
                f"expected {sorted(expected_keys)}"
            ], index - 1
        name = entry["name"]
        if not isinstance(name, str) or not name:
            return [f"hardening control #{index} has an empty name"], index - 1
        if name in seen_names:
            return [f"hardening control names are not unique: {name!r}"], index - 1
        seen_names.add(name)
        owner = entry["owner"]
        if (
            not isinstance(owner, str)
            or not owner
            or "\\" in owner
            or owner.startswith("/")
            or owner.startswith(".")
            or ".." in owner.split("/")
        ):
            return [
                f"hardening control #{index} owner is not a canonical "
                f"repository-relative path: {owner!r}"
            ], index - 1
        anchor = entry["anchor"]
        if not isinstance(anchor, str) or not anchor:
            return [f"hardening control #{index} has an empty anchor"], index - 1
        if anchor in seen_anchors:
            return [
                f"hardening control #{index} anchor {anchor!r} is not "
                f"unique -- the anchor resolves ambiguously"
            ], index - 1
        seen_anchors.add(anchor)
        ids.append(entry["id"])
    if len(set(ids)) != len(ids):
        return ["hardening control IDs are not unique"], len(registry)
    if ids != list(range(1, len(registry) + 1)):
        return [f"hardening control IDs are {ids!r}, expected 1..{len(registry)} in order"], len(
            registry
        )
    for entry in registry:
        checked += 1
        owner = HOME / entry["owner"]
        if not owner.is_file():
            problems.append(f"control {entry['id']} owner is not a file: {entry['owner']}")
            continue
        try:
            source = owner.read_text(encoding="utf-8-sig")
        except OSError as exc:
            problems.append(f"control {entry['id']} owner unreadable: {exc}")
            continue
        if entry["anchor"] not in source:
            problems.append(
                f"control {entry['id']} {entry['name']}: anchor "
                f"{entry['anchor']!r} missing from {entry['owner']}"
            )
        else:
            print(
                f"PASS: hardening control {entry['id']:02d} -- {entry['name']} -> {entry['owner']}"
            )
    print(
        "hardening_controls.json is platform-independent data: every owner "
        "is a repository-relative file path and every anchor is plain text "
        "with no platform branch"
    )
    return problems, checked


def run_userperson_probes() -> tuple[list[str], int]:
    """T-574 + T-577: the optional USERPERSON profile mechanics.

    The profile is OFF by default -- absence is silent (verified against the
    validator's own output on this very tree, which carries no USERPERSON
    file). Preference identity is STRUCTURED (category + exact text) and the
    merge is deterministic lexical dedup -- never a claim of understanding
    natural-language semantics. Red controls cover the false-equivalence that
    shipped in v7.217.0 (a leading-phrase split silently discarded a distinct
    "Prefer UI: Material Design" beside "Prefer UI: Vintage Golden") and the
    false-negative case (differently-worded but equivalent preferences are
    NOT merged by the helper; the agent distills semantics before writing).
    Projections select actual preferences by category policy and return an
    auditable handoff -- a short scope string is not a projection.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if not ok:
            problems.append(f"{label}: {detail}")
        else:
            print(f"PASS: userperson -- {label}")

    # Red control: false equivalence. Two distinct UI preferences sharing a
    # leading phrase must BOTH survive -- the v7.217.0 bug discarded the second.
    merged = merge_profile(
        ["- [UI] Vintage Golden"], ["- [UI] Material Design", "- [UI] Vintage Golden"]
    )
    expect(
        "distinct preferences sharing a leading phrase are both kept",
        len(merged) == 2 and {e["text"] for e in merged} == {"Vintage Golden", "Material Design"},
        repr(merged),
    )

    # Red control: false negative. Semantically-equivalent but lexically
    # different preferences are NOT merged by the helper -- semantic
    # distillation is the agent's job, recorded as such (T-577).
    dist = merge_profile(
        ["- [Automation] Prefer safe autonomous continuation"],
        ["- [Automation] Automate continuation safely where reversible"],
    )
    expect(
        "helper never fabricates semantic equivalence between wordings", len(dist) == 2, repr(dist)
    )

    # Exact-duplicate dedup is deterministic and safe.
    dedup = merge_profile(
        ["- [Automation] avoid repetitive continue"], ["- [Automation] avoid repetitive continue"]
    )
    expect(
        "exact duplicate (same category, same text) is deduplicated", len(dedup) == 1, repr(dedup)
    )

    removed, remove_refusal = remove_preference(merged, "Material Design")
    expect(
        "remove drops the matching preference",
        remove_refusal is None
        and len(removed) == 1
        and removed[0]["text"] == "Vintage Golden",
        repr((removed, remove_refusal)),
    )

    rendered = render_profile(merged)
    parsed = parse_profile(rendered)["preferences"]
    expect(
        "render/parse round-trips",
        [(e["category"], e["text"]) for e in parsed]
        == [(e["category"], e["text"]) for e in merged],
        repr(parsed),
    )

    expect(
        "validate accepts a well-formed profile",
        validate_profile(rendered) == [],
        repr(validate_profile(rendered)),
    )
    malformed = "# USERPERSON\n\n- [UI] good preference\nnot-a-bullet\n"
    errs = validate_profile(malformed)
    expect(
        "validate flags a non-bullet line", any("markdown bullet" in e for e in errs), repr(errs)
    )
    dup = render_profile(["- [UI] Same leading phrase here.", "- [UI] Same leading phrase here."])
    expect(
        "validate flags exact duplicate history",
        any("duplicate" in e for e in validate_profile(dup)),
        repr(validate_profile(dup)),
    )

    expect(
        "onboarding asks at most three broad questions",
        1 <= len(onboarding_questions()) <= 3,
        repr(onboarding_questions()),
    )

    # Real projection behavior: the helper SELECTS preferences by category
    # policy. A short scope string is not evidence of projection (T-577).
    profile = [
        {"id": "p1", "category": "UI", "text": "Vintage Golden"},
        {"id": "p2", "category": "Language", "text": "Russian explanations"},
        {"id": "p3", "category": "Automation", "text": "avoid repetitive continue"},
        {"id": "p4", "category": "Localization", "text": "multilingual-first"},
    ]
    ui = project_profile(profile, "saiui", source_fingerprint="fp123")
    expect(
        "saiui projection selects UI/workflow preferences only",
        [e["text"] for e in ui["preferences"]] == ["Vintage Golden"],
        repr(ui),
    )
    tr = project_profile(profile, "saitranslate", source_fingerprint="fp123")
    expect(
        "saitranslate projection selects localization/language only",
        {e["category"] for e in tr["preferences"]} == {"Language", "Localization"},
        repr(tr),
    )
    ht = project_profile(profile, "saihunt", source_fingerprint="fp123")
    expect(
        "saihunt projection excludes UI baggage unless relevant",
        all(e["category"] != "UI" for e in ht["preferences"]),
        repr(ht),
    )
    expect(
        "projection never dumps the whole profile",
        all(
            len(project_profile(profile, role, "fp")["preferences"]) < len(profile)
            for role in ("saiui", "saitranslate", "saiwiki", "saihunt")
        ),
    )
    expect(
        "projection handoff carries the source fingerprint",
        ui["source_fingerprint"] == "fp123"
        and ui["projection_policy"] == sorted(["ui", "workflow"]),
        repr(ui),
    )

    core = (HOME / "saipen" / "CORE.md").read_text(encoding="utf-8-sig")
    expect(
        "CORE.md 1.10 documents both report traces",
        "USERPERSON alignment:" in core and "USERPERSON deviation:" in core,
    )
    expect(
        "CORE.md 1.10 documents the precedence chain",
        "current explicit request > project/task requirements > SAIPEN normative rules > "
        "verified evidence > project USERPERSON > global USERPERSON" in core,
    )

    focused = subprocess.run(
        [sys.executable, "-m", "unittest", "tools.test_userperson_global"],
        cwd=str(HOME),
        capture_output=True,
        text=True,
        timeout=120,
    )
    expect(
        "global/effective autoload regression matrix passes",
        focused.returncode == 0,
        (focused.stdout + focused.stderr)[-1000:],
    )

    return problems, checked


def run_improve_probes() -> tuple[list[str], int]:
    """T-551/T-555/T-556/T-570: the Improve mechanical core.

    The semantics live in saipen/IMPROVE.md; these probes prove the mechanical
    layer: canonical report paths that never touch the shared protocol
    install, one path per seat per cycle, report schema validation with closed
    vocabularies and the mandatory expected/actual/evidence triple, the
    derived status (roster + report + sweep, one fact one owner), and the
    Core-owned SWEEP ledger that never mutates the seat report.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if not ok:
            problems.append(f"{label}: {detail}")
        else:
            print(f"PASS: improve -- {label}")

    root = Path(tempfile.mkdtemp(prefix="saipen-improve-"))
    p1 = resolve_report_path(root, "imp-key-20260808", "opencode-01", "PROJ")
    p2 = resolve_report_path(root, "imp-key-20260808", "opencode-02", "PROJ")
    p3 = resolve_report_path(root, "imp-key-20260809", "opencode-01", "PROJ")
    expect(
        "report path lives under project .saipen/improve, never saipen_home",
        p1.is_relative_to(root / ".saipen" / "improve"),
        str(p1),
    )
    expect("two distinct seats resolve to different report paths", p1 != p2, f"{p1} vs {p2}")
    expect("same seat in a different cycle resolves to a different path", p1 != p3, f"{p1} vs {p3}")
    expect("requested basename is preserved exactly", p1.name == "saipen_improve_PROJ.md", p1.name)

    good = (
        "agent: opencode-01\nrole: core\nmodel_or_runtime: probe\n"
        "project: PROJ\nsaipen_version: 7.218.0\n"
        "protocol_fingerprint: deadbeef\nsource_head: abc\n"
        "source_tree_fingerprint: beef\ncontext_scope: tools/improve.py\n"
        "context_available: complete\nreport_status: draft\n\n"
        "IMP-001 [P1] [PROTOCOL_VIOLATION] [observed] [ticket]\n"
        "expected: reports under .saipen/improve\nactual: report in root\n"
        "evidence: path p\n"
    )
    expect(
        "a well-formed report validates", validate_report(good) == [], repr(validate_report(good))
    )
    bad = good.replace("evidence: path p\n", "")
    expect(
        "a finding without evidence is rejected",
        any("expected/actual/evidence" in e for e in validate_report(bad)),
        repr(validate_report(bad)),
    )
    bad2 = good.replace("[PROTOCOL_VIOLATION]", "[MAGIC]")
    expect(
        "a class outside the closed set is rejected",
        any("outside the closed set" in e for e in validate_report(bad2)),
        repr(validate_report(bad2)),
    )
    bad3 = good.replace("context_scope: tools/improve.py", "context_scope: ")
    expect(
        "context_available complete over an empty scope is refused",
        any("context_available: complete" in e for e in validate_report(bad3)),
        repr(validate_report(bad3)),
    )

    roster = (
        "# IMPROVE CYCLE ROSTER\nseat_id: report\nrole: core\n"
        "report_path: saipen_improve_REPORT.md\navailability: expected\n"
    )
    sweep = "# SWEEP\n- IMP-001 [CONFIRMED] T-900 report=saipen_improve_REPORT.md reproduced=y\n"
    full_sweep = sweep + (
        "- IMP-002 [CONFIRMED] T-900 report=saipen_improve_REPORT.md reproduced=y\n"
    )
    expect(
        "derived status: roster-only is expected",
        derive_status("saipen_improve_REPORT.md", roster, "", "")["visible"] == "expected",
    )
    expect(
        "derived status: report draft is draft",
        derive_status("saipen_improve_REPORT.md", roster, "report_status: draft\n", "")["visible"]
        == "draft",
    )
    expect(
        "derived status: complete without sweep is complete",
        derive_status("saipen_improve_REPORT.md", roster, "report_status: complete\n", "")[
            "visible"
        ]
        == "complete",
    )
    report_two = (
        "report_status: complete\n\n"
        "IMP-001 [P1] [PROTOCOL_VIOLATION] [proven] [ticket]\n"
        "IMP-002 [P1] [PROTOCOL_VIOLATION] [proven] [ticket]\n"
    )
    expect(
        "derived status: partial disposition coverage is never swept",
        derive_status("saipen_improve_REPORT.md", roster, report_two, sweep)["visible"] != "swept",
    )
    expect(
        "derived status: swept after FULL disposition coverage",
        derive_status("saipen_improve_REPORT.md", roster, report_two, full_sweep)["visible"]
        == "swept",
    )
    expect(
        "derived status: unavailable roster wins",
        derive_status(
            "saipen_improve_REPORT.md",
            roster.replace("availability: expected", "availability: unavailable"),
            report_two,
            full_sweep,
        )["visible"]
        == "unavailable",
    )
    seat2_roster = (
        "# IMPROVE CYCLE ROSTER\n"
        "seat_id: seat-a\nrole: core\nreport_path: a.md\n"
        "availability: unavailable\n"
        "seat_id: seat-b\nrole: core\nreport_path: b.md\n"
        "availability: expected\n"
    )
    seat2_sweep = (
        "# SWEEP\n- IMP-001 [CONFIRMED] T-900 report=b.md "
        "reproduced=y\n- IMP-002 [CONFIRMED] T-900 report=b.md "
        "reproduced=y\n"
    )
    expect(
        "derived status: per-seat availability, not the first field",
        derive_status("b.md", seat2_roster, report_two, seat2_sweep)["visible"] == "swept"
        and derive_status("a.md", seat2_roster, report_two, seat2_sweep)["visible"]
        == "unavailable",
    )

    # NITRO dogfood II: same IMP-001 in two reports stays independent and one
    # report disposition cannot sweep another.
    cross_roster = (
        "# IMPROVE CYCLE ROSTER\n"
        "seat_id: seat-a\nrole: core\nreport_path: a.md\n"
        "availability: expected\n"
        "seat_id: seat-b\nrole: core\nreport_path: b.md\n"
        "availability: expected\n"
    )
    report_a = "report_status: complete\n\nIMP-001 [P1] [PROTOCOL_VIOLATION] [proven] [ticket]\n"
    report_b = "report_status: complete\n\nIMP-001 [P1] [PROTOCOL_VIOLATION] [proven] [ticket]\n"
    sweep_a_only = "# SWEEP\n- IMP-001 [CONFIRMED] T-900 report=a.md reproduced=y\n"
    expect(
        "same IMP-001 in two reports stays independent",
        derive_status("a.md", cross_roster, report_a, sweep_a_only)["visible"] == "swept"
        and derive_status("b.md", cross_roster, report_b, sweep_a_only)["visible"] == "complete",
        repr(derive_status("b.md", cross_roster, report_b, sweep_a_only)),
    )

    def project_fixture(prefix: str) -> Path:
        """A minimal but real .saipen/ project root for the journaled writers."""
        proot = Path(tempfile.mkdtemp(prefix=prefix))
        saipen = proot / ".saipen"
        saipen.mkdir()
        (saipen / "LOG.md").write_text(
            "- 09.08.26 00:00 [E-900] [T-none] DEC: base\n", encoding="utf-8"
        )
        (saipen / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        (saipen / "STATE.md").write_text(
            '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
            'blocker: ""\ntransition_from: SHIP\n'
            "saipen_version: 7\nschema_version: 3\n"
            "last_event: 900\nstyle_contract: ded-4ae736e4\n"
            'saipen_home: "."\nagent: probe\nmode: full\n'
            "updated: 2026-08-09T00:00:00Z\n---\n",
            encoding="utf-8",
        )
        return proot

    def ticket_fixture(root: Path, tid: str = "T-900") -> None:
        """Put a real canonical ticket on the temp board so CONFIRMED sweeps
        can bind it (DOGFOOD V: a ledger may never claim a nonexistent
        ticket)."""
        board = root / ".saipen" / "BOARD.md"
        text = board.read_text(encoding="utf-8-sig")
        if tid in text:
            return
        text = text.replace("## TODO\n", f"## TODO\n- [ ] {tid} [P1] probe | verify: probe\n")
        board.write_text(text, encoding="utf-8")

    def mech_cycle(
        root: Path,
        cycle_id: str,
        seat_id: str,
        project_name: str,
        run_texts: list[str],
        ticket: str = "T-900",
        findings_ok: bool = True,
    ) -> tuple[Path, Path]:
        """Build a STRICT cycle entirely through the mechanical writers:
        create_cycle -> register_seat -> create_report -> append_run ->
        complete_report. Zero raw canonical Improve writes."""
        cdir = create_cycle(
            root, cycle_id, created_at="2026-08-10T00:00:00Z", project_identity="probe-project"
        )
        register_seat(cdir, seat_id, "core", f"saipen_improve_{project_name}.md")
        ticket_fixture(root, ticket)
        report = create_report(
            root,
            cycle_id,
            seat_id,
            project_name,
            agent=seat_id,
            role="core",
            model_or_runtime="probe",
            context_scope="probe scope",
        )
        if findings_ok:
            for run_text in run_texts:
                append_run(report, run_text)
            complete_report(report)
        return cdir, report

    proot = project_fixture("saipen-sweep-")
    cycle, report = mech_cycle(
        proot,
        "imp-key-20260808",
        "opencode-01",
        "PROJ",
        [
            "IMP-001 [P1] [PROTOCOL_VIOLATION] "
            "[proven] [ticket]\n"
            "expected: x\nactual: y\nevidence: z\n"
        ],
    )
    before = report.read_bytes()
    write_sweep_entry(
        cycle,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_PROJ.md",
            "reproduced": "y",
        },
    )
    expect("SWEEP ledger write never mutates the seat report", report.read_bytes() == before)
    expect(
        "SWEEP ledger exists with the disposition",
        (cycle / "SWEEP.md").is_file()
        and "RUN-1/IMP-001" in (cycle / "SWEEP.md").read_text(encoding="utf-8"),
    )

    # Cycle/seat admission: deterministic, collision-safe (T-570).
    proot = project_fixture("saipen-cycle-")
    c1 = create_cycle(proot, "imp-key-20260808")
    try:
        create_cycle(proot, "imp-key-20260808")
        dup_cycle = False
    except (FileExistsError, ValueError):
        dup_cycle = True
    expect("a second cycle with the same id is refused, not duplicated", dup_cycle)
    expect(
        "cycle creation writes the roster atomically",
        (c1 / "MANIFEST.md").is_file()
        and "imp-key-20260808" in (c1 / "MANIFEST.md").read_text(encoding="utf-8"),
    )
    rp = "saipen_improve_PROJ.md"
    register_seat(c1, "opencode-01", "core", rp)
    try:
        register_seat(c1, "opencode-01", "core", rp)
        dup_seat = False
    except ValueError:
        dup_seat = True
    expect(
        "duplicate seat registration fails",
        dup_seat
        and (c1 / "MANIFEST.md").read_text(encoding="utf-8").count("seat_id: opencode-01") == 1,
    )
    try:
        register_seat(c1, "opencode-02", "core", rp, availability="yolo")
        bad_avail = False
    except ValueError:
        bad_avail = True
    expect("a roster availability outside the closed set is rejected", bad_avail)

    # RUN append is immutable: a second run appends, never overwrites; a
    # complete report refuses further RUNs (T-551, DOGFOOD V T-616). T-638:
    # append_run requires a valid ACTIVE cycle manifest -- the report lives
    # under .saipen/improve/<cycle>/<seat>/ and the cycle must exist.
    proot = project_fixture("saipen-run-")
    _run_cycle = create_cycle(
        proot, "imp-key-20260808", created_at="2026-08-10T00:00:00Z", project_identity="p"
    )
    register_seat(_run_cycle, "opencode-01", "core", "saipen_improve_PROJ.md")
    seat_report = create_report(
        proot,
        "imp-key-20260808",
        "opencode-01",
        "PROJ",
        agent="opencode-01",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    append_run(seat_report, "first run")
    append_run(seat_report, "second run")
    after = seat_report.read_text(encoding="utf-8")
    expect(
        "a second run appends an immutable RUN section, never overwriting",
        "## RUN 1" in after and "## RUN 2" in after and "first" in after and "second run" in after,
    )
    append_run(seat_report, "third run")
    after2 = seat_report.read_text(encoding="utf-8")
    expect(
        "multiple RUNs accumulate without overwriting earlier ones",
        "## RUN 1" in after2 and "## RUN 2" in after2 and "## RUN 3" in after2,
    )
    completed = seat_report.read_text(encoding="utf-8").replace(
        "report_status: draft", "report_status: complete"
    )
    seat_report.write_text(completed, encoding="utf-8")
    try:
        append_run(seat_report, "late run")
        immutable = False
    except ValueError:
        immutable = True
    expect("a complete report refuses further RUN sections", immutable)

    # NITRO M6 (T-583): the Improve writers are journaled transactions, so a
    # crash cannot expose a roster-less cycle directory. Run register_cycle in
    # a subprocess that dies exactly after the journal PREPARES; recovery must
    # produce exactly one valid outcome -- no bare directory admitted.
    proot = project_fixture("saipen-cyclecrash-")
    crash_code = (
        "import sys, os; sys.path.insert(0, r'%s')\n"
        "os.environ['NITRO_CRASH_AFTER_PREPARE'] = '1'\n"
        "from improve import register_cycle\n"
        "register_cycle(r'%s', 'imp-crash', '# IMPROVE CYCLE ROSTER\\n')"
        % (str(HOME / "tools"), str(proot))
    )
    rc = subprocess.run(
        [sys.executable, "-c", crash_code],
        cwd=str(proot),
        capture_output=True,
        text=True,
        timeout=60,
    ).returncode
    owner = proot / ".saipen" / "improve"
    crash_dir = owner / "imp-crash"
    expect(
        "register_cycle crash after PREPARE leaves no admitted cycle",
        rc == 87 and not (crash_dir / "MANIFEST.md").is_file(),
        f"rc={rc}, manifest={(crash_dir / 'MANIFEST.md').is_file()}",
    )
    from saipen_engine.journal import auto_recover_pending

    recovered = auto_recover_pending(proot)
    expect(
        "recovery after the PREPARE crash leaves no roster-less cycle",
        recovered.get("ok") and not (owner / "imp-crash" / "MANIFEST.md").is_file(),
        repr(recovered),
    )
    # A later register_cycle with the same id still works (nothing admitted).
    c_again = register_cycle(proot, "imp-crash", "# IMPROVE CYCLE ROSTER\n")
    expect(
        "a fresh cycle can be admitted after clean recovery", (c_again / "MANIFEST.md").is_file()
    )

    # ---- T-589: stale Improve plan refuses (CAS, no lost update).
    import improve as _improve

    cas_root = project_fixture("saipen-cas-")
    cas_cycle = create_cycle(cas_root, "imp-cas")
    cas_manifest = cas_cycle / "MANIFEST.md"
    base_text = _improve._read_maybe(cas_manifest)
    base_hash_before = _improve._base_hash(cas_manifest)
    # B derived +seat B from the OLD base (before A commits).
    stale_text = (
        base_text.rstrip() + "\nseat_id: seat-b\nrole: core\n"
        "report_path: saipen_improve_B.md\navailability: expected\n"
    )
    # A builds +seat A and commits in between.
    _improve.register_seat(cas_cycle, "seat-a", "core", "saipen_improve_A.md")
    stale_res = _improve._journaled_write(
        cas_manifest, stale_text, "seat", base_hash=base_hash_before
    )
    expect(
        "stale Improve plan refuses STALE_STATE (base-hash binding)",
        not stale_res.get("ok") and stale_res.get("code") == "STALE_STATE",
        repr(stale_res),
    )
    # Re-read, re-plan, commit: A + B both present.
    _improve.register_seat(cas_cycle, "seat-b", "core", "saipen_improve_B.md")
    final_text = _improve._read_maybe(cas_manifest)
    expect(
        "retry after stale refusal keeps both seats (A + B)",
        "seat_id: seat-a" in final_text and "seat_id: seat-b" in final_text,
        repr(final_text),
    )

    # ---- T-589: cycle lifecycle -- complete allows the next cycle.
    # (NITRO dogfood III, T-595: this red control was vacuous -- both branches
    # set second_blocked=True. Now the success path sets False, so a mutation
    # removing the active-cycle refusal turns the scenario red.)
    life_root = project_fixture("saipen-life-")
    c1 = create_cycle(life_root, "imp-one")
    try:
        create_cycle(life_root, "imp-two")
        second_blocked = False
    except ValueError:
        second_blocked = True
    expect("a second ACTIVE cycle is refused while one is active", second_blocked)
    # Complete prerequisites: one expected seat with a complete report.
    register_seat(c1, "seat-1", "core", "saipen_improve_A.md")
    report1 = create_report(
        life_root,
        "imp-one",
        "seat-1",
        "A",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="probe scope",
    )
    # A strict cycle cannot be completed by a bare status skeleton.
    try:
        complete_report(report1)
        bare_ok = False
    except ValueError:
        bare_ok = True
    expect("complete_report refuses a report with no RUN evidence (DOGFOOD V)", bare_ok)
    append_run(
        report1,
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n",
    )
    complete_report(report1)
    ticket_fixture(life_root, "T-900")
    write_sweep_entry(
        c1,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    complete_cycle(c1)
    c2 = create_cycle(life_root, "imp-two")
    expect(
        "a completed cycle allows the next cycle (no evidence deleted)",
        (c1 / "MANIFEST.md").is_file() and (c2 / "MANIFEST.md").is_file(),
        repr((c1, c2)),
    )
    expect(
        "historical cycle evidence is not deleted to admit the next", (c1 / "MANIFEST.md").is_file()
    )

    # T-595: complete_cycle refuses when a required report is missing/draft;
    # completed cycle is immutable under register_seat/append_run.
    imm_root = project_fixture("saipen-imm-")
    cimm = create_cycle(imm_root, "imp-imm")
    register_seat(cimm, "seat-1", "core", "saipen_improve_A.md")
    imm_report = create_report(
        imm_root,
        "imp-imm",
        "seat-1",
        "A",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="probe scope",
    )
    try:
        complete_cycle(cimm)
        early = False
    except ValueError:
        early = True
    expect("complete_cycle refuses a draft report (completion means something)", early)
    append_run(
        imm_report,
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n",
    )
    complete_report(imm_report)
    ticket_fixture(imm_root, "T-900")
    write_sweep_entry(
        cimm,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    complete_cycle(cimm)
    try:
        register_seat(cimm, "seat-2", "core", "saipen_improve_B.md")
        late_seat = False
    except ValueError:
        late_seat = True
    expect("register_seat refuses a completed cycle (immutable)", late_seat)
    try:
        append_run(imm_report, "late run")
        late_run = False
    except ValueError:
        late_run = True
    expect("append_run refuses a completed cycle (immutable)", late_run)
    from improve import write_sweep_entry as _wse

    try:
        _wse(
            cimm,
            {
                "run": "RUN-1",
                "imp_id": "001",
                "disposition": "CONFIRMED",
                "ticket": "T-900",
                "report": "saipen_improve_A.md",
                "reproduced": "y",
            },
        )
        late_sweep = False
    except ValueError:
        late_sweep = True
    expect("write_sweep_entry refuses a completed cycle (immutable)", late_sweep)

    # ---- T-595: end-to-end writer -> filesystem -> parser -> derive_status
    # with NO hand-built intermediate strings. write_sweep_entry(imp_id="001")
    # must write exactly one IMP-001 that derive_status reads back.
    e2e_root = project_fixture("saipen-e2e-")
    e2e_cycle = create_cycle(e2e_root, "imp-e2e")
    register_seat(e2e_cycle, "seat-a", "core", "saipen_improve_A.md")
    register_seat(e2e_cycle, "seat-b", "core", "saipen_improve_B.md")
    rep_a = create_report(
        e2e_root,
        "imp-e2e",
        "seat-a",
        "A",
        agent="seat-a",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    rep_b = create_report(
        e2e_root,
        "imp-e2e",
        "seat-b",
        "B",
        agent="seat-b",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    append_run(
        rep_a,
        "IMP-001 [P1] [PROTOCOL_VIOLATION] [proven] [ticket]\n"
        "expected: a\nactual: b\nevidence: c\n",
    )
    append_run(
        rep_b,
        "IMP-001 [P1] [PROTOCOL_VIOLATION] [proven] [ticket]\n"
        "expected: d\nactual: e\nevidence: f\n",
    )
    complete_report(rep_a)
    complete_report(rep_b)
    ticket_fixture(e2e_root, "T-900")
    roster_e2e = (e2e_cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
    # Write one disposition for seat A only, using the numeric-id input that
    # once produced IMP-IMP-001.
    _wse(
        e2e_cycle,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    sweep_text = (e2e_cycle / "SWEEP.md").read_text(encoding="utf-8")
    expect(
        "sweep writer emits exactly one IMP-001 (never IMP-IMP-001)",
        sweep_text.count("IMP-001") == 1 and "IMP-IMP-001" not in sweep_text,
        repr(sweep_text),
    )
    # derive_status over the ACTUAL written SWEEP: A swept, B not.
    st_a = derive_status(
        "saipen_improve_A.md", roster_e2e, rep_a.read_text(encoding="utf-8"), sweep_text
    )
    st_b = derive_status(
        "saipen_improve_B.md", roster_e2e, rep_b.read_text(encoding="utf-8"), sweep_text
    )
    expect(
        "writer->parser->derive_status: A swept, B not (same local IMP-001)",
        st_a["visible"] == "swept" and st_b["visible"] == "complete",
        repr((st_a, st_b)),
    )

    # ---- T-589: deterministic cycle-id allocator.
    alloc_root = project_fixture("saipen-alloc-")
    id1 = allocate_cycle_id(alloc_root, "proj-x")
    cid1 = create_cycle(alloc_root, id1)
    register_seat(cid1, "seat-1", "core", "saipen_improve_A.md")
    a_report = create_report(
        alloc_root,
        id1,
        "seat-1",
        "A",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    append_run(
        a_report,
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n",
    )
    complete_report(a_report)
    ticket_fixture(alloc_root, "T-900")
    write_sweep_entry(
        cid1,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    complete_cycle(cid1)
    id2 = allocate_cycle_id(alloc_root, "proj-x")
    expect(
        "cycle-id allocator is deterministic and collision-safe",
        id1 != id2 and id2.endswith("-2"),
        repr((id1, id2)),
    )

    # ---- NITRO dogfood IV (T-601): complete_cycle must NOT freeze the
    # artifact before its Core sweep finishes. Real lifecycle test, not a
    # completion-then-refusal proof: active -> reports complete -> PARTIAL
    # sweep -> complete_cycle REFUSE -> remaining dispositions -> complete_cycle
    # COMMITTED -> every ordinary mutator REFUSEs -> next cycle admitted.
    from saipen_engine.journal import verify_improve as _verify_improve

    life2 = project_fixture("saipen-life2-")
    cL = create_cycle(life2, "imp-life2")
    register_seat(cL, "seat-1", "core", "saipen_improve_A.md")
    repL = create_report(
        life2,
        "imp-life2",
        "seat-1",
        "A",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    append_run(
        repL,
        "IMP-001 [P1] [PROTOCOL_VIOLATION] [proven] [ticket]\n"
        "expected: x\nactual: y\nevidence: z\n"
        "IMP-002 [P1] [PROTOCOL_VIOLATION] [proven] [ticket]\n"
        "expected: x\nactual: y\nevidence: z\n",
    )
    complete_report(repL)
    ticket_fixture(life2, "T-900")
    # partial sweep: only IMP-001 disposed
    write_sweep_entry(
        cL,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    try:
        complete_cycle(cL)
        partial_ok = False
    except ValueError:
        partial_ok = True
    expect(
        "lifecycle: partial sweep REFUSEs complete_cycle (unswept IMP-002)",
        partial_ok and _improve._cycle_status(cL / "MANIFEST.md") == "active",
        repr(_improve._cycle_status(cL / "MANIFEST.md")),
    )
    write_sweep_entry(
        cL,
        {
            "run": "RUN-1",
            "imp_id": "002",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    complete_cycle(cL)
    expect(
        "lifecycle: full sweep coverage permits complete_cycle",
        _improve._cycle_status(cL / "MANIFEST.md") == "complete",
    )
    for mutator, label in [
        (lambda: register_seat(cL, "seat-2", "core", "saipen_improve_B.md"), "register_seat"),
        (
            lambda: write_sweep_entry(
                cL,
                {
                    "run": "RUN-1",
                    "imp_id": "003",
                    "disposition": "CONFIRMED",
                    "ticket": "T-900",
                    "report": "saipen_improve_A.md",
                    "reproduced": "y",
                },
            ),
            "write_sweep_entry",
        ),
    ]:
        try:
            mutator()
            refused = False
        except ValueError:
            refused = True
        expect(f"lifecycle: {label} REFUSEs a completed cycle (immutable)", refused)
    cL2 = create_cycle(life2, "imp-life2-2")
    expect(
        "lifecycle: the next cycle is admitted after completion", (cL2 / "MANIFEST.md").is_file()
    )

    # ---- T-601: malformed SWEEP fails its OWN semantic verifier while a
    # valid SWEEP passes (writer and verifier consume the SAME grammar).
    sweep_bad = cL2 / "SWEEP.md"
    sweep_bad.write_text("arbitrary malformed garbage\nNOT A SWEEP\n", encoding="utf-8")
    bad_errs = _verify_improve(
        life2, [{"path": sweep_bad.relative_to(life2).as_posix(), "role": "sweep"}]
    )
    expect(
        "verifier: malformed SWEEP FAILs the semantic verifier",
        len(bad_errs) >= 3 and "ledger grammar" in " ".join(bad_errs),
        repr(bad_errs),
    )
    # fresh ledger: the writer's own output must satisfy the verifier
    sweep_bad.unlink()
    register_seat(cL2, "seat-1", "core", "saipen_improve_A.md")
    repL2 = create_report(
        life2,
        "imp-life2-2",
        "seat-1",
        "A",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    append_run(
        repL2, "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n"
    )
    complete_report(repL2)
    write_sweep_entry(
        cL2,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    sweep_text2 = (cL2 / "SWEEP.md").read_text(encoding="utf-8")
    good_errs = _verify_improve(
        life2, [{"path": ".saipen/improve/imp-life2-2/SWEEP.md", "role": "sweep"}]
    )
    expect(
        "verifier: the writer's own SWEEP output passes (same grammar)",
        good_errs == [] and sweep_text2.startswith("# SWEEP"),
        repr((good_errs, sweep_text2[:40])),
    )

    # ---- T-601: Recovery uses the SAME target-aware verifier as APPLY. A
    # journaled improve op whose applied SWEEP is malformed must CONFLICT on
    # recovery (never COMMITTED) -- the policy postcondition class is one.
    from saipen_engine.journal import Journal as _RecJournal
    from saipen_engine.journal import hash_bytes as _rec_hb

    rec_root = project_fixture("saipen-recover-")
    register_cycle(rec_root, "imp-rec", "# IMPROVE CYCLE ROSTER\ncycle_status: active\n")
    sweep_path = ".saipen/improve/imp-rec/SWEEP.md"
    garbage = "arbitrary malformed garbage\n"
    from saipen_engine.paths import runtime_lock_identity as _rec_identity

    jrec = _RecJournal(rec_root, "op-rec")
    jrec.start(
        "sweep",
        "probe",
        _rec_identity(rec_root),
        "h",
        [
            {
                "path": sweep_path,
                "role": "sweep",
                "content": garbage.encode("utf-8"),
                "before_hash": _rec_hb(b""),
                "after_hash": _rec_hb(garbage.encode("utf-8")),
            }
        ],
        verification_policy="improve_atomic_file",
    )
    (rec_root / sweep_path).write_bytes(garbage.encode("utf-8"))
    jrec.mark("APPLYING", progress_index=1, target_index=0)
    rec_res = recover(rec_root, "op-rec")
    expect(
        "recovery runs the same target-aware verifier: malformed SWEEP "
        "CONFLICTs on recovery, never COMMITTED",
        not rec_res.get("ok")
        and rec_res.get("code") == "CONFLICT"
        and "semantic verifier" in rec_res.get("detail", ""),
        repr(rec_res),
    )

    # ---- T-553: improve routing is DERIVED -- manifest/sweep edits change
    # the visible status with ZERO STATE writes (no independent counters).
    derive_root = project_fixture("saipen-derive-")
    d_cycle, report_d = mech_cycle(
        derive_root,
        "imp-derive",
        "seat-1",
        "A",
        [
            "IMP-001 [P1] [PROTOCOL_VIOLATION] "
            "[proven] [ticket]\n"
            "expected: x\nactual: y\nevidence: z\n"
        ],
    )
    state_bytes_before = (derive_root / ".saipen" / "STATE.md").read_bytes()
    write_sweep_entry(
        d_cycle,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    manifest_text = (d_cycle / "MANIFEST.md").read_text(encoding="utf-8")
    st_after = derive_status(
        "saipen_improve_A.md",
        manifest_text,
        report_d.read_text(encoding="utf-8"),
        (d_cycle / "SWEEP.md").read_text(encoding="utf-8"),
    )
    expect(
        "improve routing: manifest+sweep edits flip the derived status "
        "(complete->swept) with zero STATE writes",
        st_after["visible"] == "swept"
        and (derive_root / ".saipen" / "STATE.md").read_bytes() == state_bytes_before,
        repr(
            (
                st_after["visible"],
                (derive_root / ".saipen" / "STATE.md").read_bytes() == state_bytes_before,
            )
        ),
    )

    # ---- T-555: the report completion bar is mechanical. NO_FINDINGS with a
    # stated scope passes; report_status: complete without a context_scope is
    # an unmet completion bar; a partial scope cannot claim full context.
    nf_report = good.split("\nIMP-001")[0].rstrip() + "\n"
    expect(
        "improve report: NO_FINDINGS with a stated scope validates",
        validate_report(nf_report) == [],
        repr(validate_report(nf_report)),
    )
    complete_noscope = nf_report.replace(
        "context_scope: tools/improve.py", "context_scope: "
    ).replace("report_status: draft", "report_status: complete")
    expect(
        "improve report: report_status complete over an unmet completion bar is rejected",
        any("completion bar" in e for e in validate_report(complete_noscope)),
        repr(validate_report(complete_noscope)),
    )
    partial_full = good.replace(
        "context_scope: tools/improve.py", "context_scope: partial: tools only"
    )
    expect(
        "improve report: a partial scope cannot claim complete context",
        any("partial" in e and "complete" in e for e in validate_report(partial_full)),
        repr(validate_report(partial_full)),
    )

    # ---- T-556: Core sweep is the only path from report to canonical work.
    # Sweep dispositions are mechanically linked to tickets: CONFIRMED must
    # reference a real board ticket and be reproduced; INVALID/ALREADY_FIXED
    # must never carry a ticket; a disposition must still resolve to its
    # report's finding; a ticket's source_reports must resolve to SWEEP.md;
    # one root cause across reports produces ONE ticket.
    def sweep_project(
        dispositions: list[str],
        tickets: list[str],
        source_reports: dict[str, str],
        report_text: str,
    ) -> Path:
        _root = project_fixture("saipen-sweep")
        (_root / ".saipen" / "STATE.md").write_text(
            '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
            'blocker: ""\ntransition_from: SHIP\nsaipen_version: 7\n'
            "schema_version: 3\nlast_event: 900\nstyle_contract: ded-4ae736e4\n"
            'saipen_home: "."\nagent: probe\nmode: full\n'
            "updated: 2026-08-09T00:00:00Z\n---\n",
            encoding="utf-8",
        )
        _cycle = register_cycle(
            _root, "imp-sweep", "# IMPROVE CYCLE ROSTER\ncycle_status: active\n"
        )
        register_seat(_cycle, "seat1", "core", "saipen_improve_A.md")
        _rep = _cycle / "seat1" / "saipen_improve_A.md"
        _rep.parent.mkdir(parents=True, exist_ok=True)
        _rep.write_text(report_text, encoding="utf-8")
        (_cycle / "SWEEP.md").write_text(
            "# SWEEP\n" + "\n".join(dispositions) + "\n", encoding="utf-8"
        )
        board_lines = ["# Board", "## DOING", "## TODO"]
        for _tid, _sr in source_reports.items():
            board_lines.append(
                f"- [ ] {_tid} [P1] swept ticket | verify: "
                f"probe" + (f" | source_reports: {_sr}" if _sr else "")
            )
        board_lines += ["## DONE", "## BLOCKED"]
        (_root / ".saipen" / "BOARD.md").write_text("\n".join(board_lines) + "\n", encoding="utf-8")
        return _root

    def validator_rc(_root: Path) -> int:
        return subprocess.run(
            [sys.executable, str(VALIDATOR), "--project-root", str(_root)],
            cwd=str(_root),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=120,
        ).returncode

    _rep_header = (
        "agent: probe\nrole: core\nmodel_or_runtime: test\n"
        "project: PROJ\nsaipen_version: 7.220.0\n"
        "protocol_fingerprint: deadbeef\nsource_head: abc\n"
        "source_tree_fingerprint: beef\n"
        "context_scope: tools/\ncontext_available: partial\n"
        "report_status: complete\n\n"
    )
    _rep_text = (
        _rep_header
        + "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        + "expected: x\nactual: y\nevidence: z\n"
        + "IMP-002 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        + "expected: x\nactual: y\nevidence: z\n"
        + "IMP-003 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        + "expected: x\nactual: y\nevidence: z\n"
    )
    ok_root = sweep_project(
        [
            "- IMP-001 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=y",
            "- IMP-002 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=y",
            "- IMP-003 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=y",
        ],
        ["T-900"],
        {"T-900": "IMP-001,IMP-002,IMP-003"},
        _rep_text,
    )
    expect(
        "sweep: three reports' root cause deduplicates into ONE ticket "
        "(red control 11, validator green)",
        validator_rc(ok_root) == 0,
        validator_rc(ok_root),
    )
    bad10 = sweep_project(
        ["- IMP-001 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=n"],
        ["T-900"],
        {"T-900": "IMP-001"},
        _rep_text,
    )
    expect(
        "sweep: an unverified finding cannot produce a ticket (red control 10, validator red)",
        validator_rc(bad10) != 0,
        repr(validator_rc(bad10)),
    )
    bad12 = sweep_project(
        ["- IMP-001 [INVALID] T-900 report=saipen_improve_A.md reproduced=n"],
        ["T-900"],
        {"T-900": "IMP-001"},
        _rep_text,
    )
    expect(
        "sweep: an INVALID finding must never produce a ticket (red control 12, validator red)",
        validator_rc(bad12) != 0,
        repr(validator_rc(bad12)),
    )
    bad20 = sweep_project(
        ["- IMP-001 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=y"],
        ["T-900"],
        {"T-900": "IMP-999"},
        _rep_text,
    )
    expect(
        "sweep: an unresolvable source_reports ref fails (red control 20, validator red)",
        validator_rc(bad20) != 0,
        repr(validator_rc(bad20)),
    )
    bad19 = sweep_project(
        ["- IMP-001 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=y"],
        ["T-900"],
        {"T-900": "IMP-001"},
        _rep_header
        + "IMP-002 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        + "expected: x\nactual: y\nevidence: z\n",
    )
    expect(
        "sweep: an edited-away original finding loses its disposition "
        "(red control 19, validator red)",
        validator_rc(bad19) != 0,
        repr(validator_rc(bad19)),
    )
    # red control 22 (T-557): a seat report is evidence, never canonical
    # BOARD state -- a report carrying board section headings is rejected.
    report_as_board = sweep_project(
        ["- IMP-001 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=y"],
        ["T-900"],
        {"T-900": "IMP-001"},
        _rep_header.replace("report_status: complete", "report_status: complete\n## DOING\n## TODO")
        + "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        + "expected: x\nactual: y\nevidence: z\n",
    )
    expect(
        "sweep: a report treated as canonical BOARD state is rejected "
        "(red control 22, validator red)",
        validator_rc(report_as_board) != 0,
        repr(validator_rc(report_as_board)),
    )

    # T-558 reasoning gates: a PROTOCOL_VIOLATION finding that produced a
    # ticket MUST carry recurrence + weak_model (red 15/16); ACCIDENTAL_SUCCESS
    # is never PASS (red 5).
    def sweep_ticket_project(
        finding_class: str, fields: dict[str, str], reproduced: str = "y"
    ) -> Path:
        _extra = "".join(f" | {k}: {v}" for k, v in fields.items())
        _root = sweep_project(
            ["- IMP-001 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=" + reproduced],
            ["T-900"],
            {"T-900": "IMP-001" + _extra},
            _rep_header
            + (
                "IMP-001 [P1] ["
                + finding_class
                + "] [proven] [ticket]\n"
                + "expected: x\nactual: y\nevidence: z\n"
            ),
        )
        return _root

    no_gates = sweep_ticket_project("PROTOCOL_VIOLATION", {})
    expect(
        "sweep: a PROTOCOL_VIOLATION ticket without recurrence/weak_model "
        "fails (red controls 15/16, validator red)",
        validator_rc(no_gates) != 0,
        repr(validator_rc(no_gates)),
    )
    with_gates = sweep_ticket_project(
        "PROTOCOL_VIOLATION",
        {
            "recurrence": "recurs across projects (protocol rule)",
            "weak_model": "a weak model could still route past it; fixed by the validator check",
        },
    )
    expect(
        "sweep: a PROTOCOL_VIOLATION ticket with both reasoning gates passes",
        validator_rc(with_gates) == 0,
        repr(validator_rc(with_gates)),
    )
    acc_success = sweep_ticket_project("ACCIDENTAL_SUCCESS", {})
    expect(
        "sweep: an ACCIDENTAL_SUCCESS result recorded as PASS fails (red control 5, validator red)",
        validator_rc(acc_success) != 0,
        repr(validator_rc(acc_success)),
    )
    # T-559 archive-with-provenance: deleting SWEEP.md to "clean up" breaks an
    # archived report's ticket provenance (red control 24); partial/timed-out
    # evidence can never mark an IMP fixed (red control 25).
    ok_archive = sweep_project(
        ["- IMP-001 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=y"],
        ["T-900"],
        {"T-900": "IMP-001"},
        _rep_text,
    )
    _arch_sweeps = list((ok_archive / ".saipen" / "improve").rglob("SWEEP.md"))
    _arch_sweep = _arch_sweeps[0]
    _arch_sweep.unlink()
    expect(
        "sweep: deleting SWEEP.md breaks archived-report ticket "
        "provenance (red control 24, validator red)",
        validator_rc(ok_archive) != 0,
        repr(validator_rc(ok_archive)),
    )
    partial_evidence = sweep_project(
        ["- IMP-001 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=partial"],
        ["T-900"],
        {"T-900": "IMP-001"},
        _rep_text,
    )
    expect(
        "sweep: partial/timed-out evidence cannot mark an IMP fixed "
        "(red control 25, validator red)",
        validator_rc(partial_evidence) != 0,
        repr(validator_rc(partial_evidence)),
    )
    # Seat directories own report identity. Equal basenames in different seat
    # homes are distinct reports, not shared ownership.
    shared_roster = (
        "# IMPROVE CYCLE ROSTER\n"
        "seat_id: seat-a\nrole: core\nreport_path: a.md\n"
        "availability: expected\n"
        "seat_id: seat-b\nrole: core\nreport_path: a.md\n"
        "availability: expected\n"
    )
    expect(
        "improve roster: same basename in distinct seat homes is valid",
        validate_manifest(shared_roster) == [],
        repr(validate_manifest(shared_roster)),
    )
    proven_unverified = sweep_ticket_project("LOGIC_ERROR", {}, reproduced="n")
    expect(
        "sweep: confidence: proven does not override Core's verification "
        "requirement (red control 14, validator red)",
        validator_rc(proven_unverified) != 0,
        repr(validator_rc(proven_unverified)),
    )
    stale_report = _rep_header.replace("source_head: abc", "source_head: deadbeef")
    stale_root = sweep_project(
        ["- IMP-001 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=y"],
        ["T-900"],
        {"T-900": "IMP-001"},
        stale_report,
    )
    subprocess.run(["git", "init", "-q"], cwd=str(stale_root), check=False)
    subprocess.run(["git", "add", "-A"], cwd=str(stale_root), check=False)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"],
        cwd=str(stale_root),
        check=False,
    )
    expect(
        "sweep: a report auditing a stale head fails (reload-before-"
        "audit, red controls 1/2, validator red)",
        validator_rc(stale_root) != 0,
        repr(validator_rc(stale_root)),
    )
    fresh_report = (
        _rep_header.replace("source_head: abc", "source_head: ")
        + "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        + "expected: x\nactual: y\nevidence: z\n"
    )
    # a fresh report with the ACTUAL current head (after git init+commit) is
    # not flagged by the reload check
    fresh_root = sweep_project(
        ["- IMP-001 [CONFIRMED] T-900 report=saipen_improve_A.md reproduced=y"],
        ["T-900"],
        {"T-900": "IMP-001"},
        fresh_report,
    )
    subprocess.run(["git", "init", "-q"], cwd=str(fresh_root), check=False)
    subprocess.run(["git", "add", "-A"], cwd=str(fresh_root), check=False)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"],
        cwd=str(fresh_root),
        check=False,
    )
    _head2 = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=str(fresh_root), capture_output=True, text=True
    ).stdout.strip()
    _reps2 = list((fresh_root / ".saipen" / "improve").rglob("saipen_improve_*.md"))
    _rep2 = _reps2[0]
    _rep2.write_text(
        _rep2.read_text(encoding="utf-8").replace("source_head: ", f"source_head: {_head2}"),
        encoding="utf-8",
    )
    expect(
        "sweep: a report audited against the current head passes the "
        "reload check (no false positive)",
        validator_rc(fresh_root) == 0,
        repr(validator_rc(fresh_root))
        + "\n"
        + subprocess.run(
            [sys.executable, str(VALIDATOR), "--project-root", str(fresh_root)],
            cwd=str(fresh_root),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=120,
        ).stdout[-800:],
    )

    # T-606: the saipen improve CLI family EXECUTES (SAICRITIC's
    # register-without-executor fix). status is read-only and derives the
    # visible per-seat status with zero STATE writes; verify runs the
    # delta-only semantic verifier; clean archives a completed cycle.
    cli_root = project_fixture("saipen-cli-")
    _cli_cycle, _cli_rep = mech_cycle(
        cli_root,
        "imp-cli",
        "seat-1",
        "A",
        ["IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n"],
    )
    state_before = (cli_root / ".saipen" / "STATE.md").read_bytes()
    cli_proc = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "improve", "status", "--json"],
        cwd=str(cli_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "saipen improve status executes and derives per-seat status",
        '"code": "IMPROVE_STATUS"' in cli_proc.stdout
        and '"visible": "complete"' in cli_proc.stdout,
        repr(cli_proc.stdout[:200]),
    )
    expect(
        "saipen improve status is read-only (zero STATE writes)",
        (cli_root / ".saipen" / "STATE.md").read_bytes() == state_before,
        "state changed",
    )
    cli_clean = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "improve",
            "clean",
            "imp-cli",
            "--json",
        ],
        cwd=str(cli_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "saipen improve clean refuses an ACTIVE cycle (archive needs complete)",
        '"code": "VALIDATION_FAILED"' in cli_clean.stdout,
        repr(cli_clean.stdout[:200]),
    )
    _cli_sweep = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "improve",
            "sweep",
            "imp-cli",
            "RUN-1/IMP-001",
            "CONFIRMED",
            "--ticket",
            "T-900",
            "--report",
            "saipen_improve_A.md",
            "--reproduced",
            "y",
            "--json",
        ],
        cwd=str(cli_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "saipen improve sweep writes a disposition through the journal",
        '"code": "COMMITTED"' in _cli_sweep.stdout,
        repr(_cli_sweep.stdout[:200]),
    )
    # verify runs AFTER the sweep, so the complete cycle bar is actually met.
    cli_verify = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "improve",
            "verify",
            "imp-cli",
            "--json",
        ],
        cwd=str(cli_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "saipen improve verify executes the delta-only verifier on a fully-swept cycle",
        '"code": "IMPROVE_VERIFY_PASS"' in cli_verify.stdout
        and '"delta_only": true' in cli_verify.stdout,
        repr(cli_verify.stdout[:200]),
    )

    # ---- DOGFOOD V (T-617): bare `saipen improve` is the documented
    # meta-control -- it prepares the bounded audit assignment, never an alias
    # for status, and never changes phase/task/next_action.
    meta_root = project_fixture("saipen-meta-")
    state_before_meta = (meta_root / ".saipen" / "STATE.md").read_bytes()
    bare_proc = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "improve", "--json"],
        cwd=str(meta_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "bare saipen improve prepares the audit assignment (not status)",
        '"code": "IMPROVE_AUDIT_ASSIGNMENT"' in bare_proc.stdout
        and '"cycle_id"' in bare_proc.stdout
        and '"source_tree_fingerprint"' in bare_proc.stdout,
        repr(bare_proc.stdout[:300]),
    )
    _bare_data = json.loads(bare_proc.stdout)
    expect(
        "bare Improve assignment emits SAICRITIC's exact ordered proof set",
        _bare_data.get("proof_levels")
        == ["UNIT", "COMPOSITION", "CANONICAL", "GATE", "PROVENANCE"],
        repr(_bare_data.get("proof_levels")),
    )
    # ---- T-624: provenance truth -- the CLI-prepared report header must
    # carry a DERIVED protocol fingerprint (never a copied style marker), a
    # truthful neutral runtime (never a guessed model constant), and a
    # partial/unknown context (completeness is not yet proven).
    _bare_report = meta_root / _bare_data["report_path"]
    _bare_header = _bare_report.read_text(encoding="utf-8-sig").split("\n## ", 1)[0]
    _derived_fp = installed_protocol_fingerprint(HOME)
    expect(
        "CLI-prepared report derives its protocol fingerprint from owned protocol evidence",
        f"protocol_fingerprint: {_derived_fp}" in _bare_header
        and "ded-4ae736e4" not in _bare_header,
        _bare_header,
    )
    expect(
        "CLI-prepared report never carries a guessed model constant",
        re.search(r"(?m)^model_or_runtime:\s*deepseek", _bare_header) is None
        and "model_or_runtime: unknown" in _bare_header,
        _bare_header,
    )
    expect(
        "CLI-prepared report begins context as partial, not complete",
        "context_available: partial" in _bare_header
        and "context_available: complete" not in _bare_header,
        _bare_header,
    )
    with tempfile.TemporaryDirectory(prefix="saipen-proto-fp-") as _proto_raw:
        _proto_home = Path(_proto_raw) / "home"
        shutil.copytree(
            HOME,
            _proto_home,
            ignore=shutil.ignore_patterns(
                ".git", ".venv", "__pycache__", "node_modules", "nul", ".freebuff"
            ),
        )
        _fp_before = installed_protocol_fingerprint(_proto_home)
        _mutated_proto = _proto_home / "saipen" / "CORE.md"
        if _mutated_proto.is_file():
            _mutated_proto.write_text(
                _mutated_proto.read_text(encoding="utf-8-sig")
                + "\nT-624 provenance probe marker\n",
                encoding="utf-8",
            )
        _fp_after = installed_protocol_fingerprint(_proto_home)
        expect(
            "editing a protocol document changes the derived fingerprint",
            _fp_after != _fp_before and _fp_after.startswith("sha256:"),
            f"{_fp_before} vs {_fp_after}",
        )

    # T-992/§2 + §3: strict provenance value semantics -- fabricated identity
    # scalars, blank scalars, unknown headers, agent/seat mismatch, project/
    # manifest mismatch, and a foreign project VERSION laundering into
    # saipen_version must ALL be refused by the shared validator and the writer.
    _prov_truth = (
        "agent: seat-01\nrole: core\nmodel_or_runtime: unknown\n"
        f"project: probe-project\n"
        f"saipen_version: {PROBE_SAIPEN_VERSION}\n"
        f"protocol_fingerprint: {PROBE_INSTALLED_FP}\n"
        "source_head: abc\nsource_tree_fingerprint: "
        "git-delta-v1:beef\ndiscovery_model: git-delta-v1\n"
        "context_scope: tools\ncontext_available: partial\n"
        "report_status: draft\n\n"
    )
    for _label, _needle in [
        ("fabricated protocol fingerprint", "protocol_fingerprint"),
        ("blank required scalar", "non-empty"),
        ("agent != seat", "agent"),
        ("unknown header field", "unknown field"),
        ("control injection in runtime", "control"),
    ]:
        # rebuild precisely per case
        if _label == "fabricated protocol fingerprint":
            _bad = _prov_truth.replace(
                f"protocol_fingerprint: {PROBE_INSTALLED_FP}",
                "protocol_fingerprint: totally-fabricated",
            )
        elif _label == "blank required scalar":
            _bad = _prov_truth.replace(
                "saipen_version: " + PROBE_SAIPEN_VERSION, "saipen_version: "
            )
        elif _label == "agent != seat":
            _bad = _prov_truth.replace("agent: seat-01", "agent: not-seat-01")
        elif _label == "unknown header field":
            _bad = "extra: x\n" + _prov_truth
        elif _label == "control injection in runtime":
            _bad = _prov_truth.replace("model_or_runtime: unknown", "model_or_runtime: a\x00b")
        _errs = validate_strict_provenance(
            _bad,
            roster=_prov_truth,
            manifest_project_identity="probe-project",
            seat_id="seat-01",
            installed_saipen_version=PROBE_SAIPEN_VERSION,
            installed_protocol_fp=PROBE_INSTALLED_FP,
        )
        expect(f"strict provenance refuses {_label}", any(_needle in e for e in _errs), repr(_errs))

    # §3: the writer must never read the target project's VERSION into
    # saipen_version -- install-only, even when the project VERSION differs.
    with tempfile.TemporaryDirectory(prefix="saipen-fp-version-") as _fv_raw:
        _fv_root = Path(_fv_raw) / "proj"
        _fv_root.mkdir()
        (_fv_root / ".saipen").mkdir()
        (_fv_root / ".saipen" / "LOG.md").write_text(
            "- 09.08.26 00:00 [E-900] DEC: base\n", encoding="utf-8"
        )
        (_fv_root / ".saipen" / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        (_fv_root / ".saipen" / "STATE.md").write_text(
            '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
            'blocker: ""\ntransition_from: SHIP\nsaipen_version: 7\n'
            "schema_version: 3\nlast_event: 900\nstyle_contract: ded-4ae736e4\n"
            'saipen_home: "."\nagent: probe\nmode: full\n'
            "updated: 2026-08-09T00:00:00Z\n---\n",
            encoding="utf-8",
        )
        (_fv_root / "VERSION").write_text("1.2.3\n", encoding="utf-8")
        _fv_cycle = create_cycle(
            _fv_root, "imp-fv", created_at="2026-08-12T00:00:00Z", project_identity="p"
        )
        register_seat(_fv_cycle, "seat-1", "core", "saipen_improve_A.md")
        _fv_rep = create_report(
            _fv_root,
            "imp-fv",
            "seat-1",
            "A",
            agent="seat-1",
            role="core",
            model_or_runtime="probe",
            context_scope="scope",
        )
        _fv_header = _fv_rep.read_text(encoding="utf-8-sig").split("\n## ", 1)[0]
        expect(
            "foreign project VERSION can never become saipen_version",
            f"saipen_version: {PROBE_SAIPEN_VERSION}" in _fv_header
            and "saipen_version: 1.2.3" not in _fv_header,
            _fv_header,
        )
    _saipen_spec = importlib.util.spec_from_file_location(
        "saipen_flattened_proof_probe", HOME / "tools" / "saipen.py"
    )
    _saipen_module = importlib.util.module_from_spec(_saipen_spec)
    _saipen_spec.loader.exec_module(_saipen_module)
    with tempfile.TemporaryDirectory(prefix="saipen-flat-proof-") as _flat_raw:
        _flat_home = Path(_flat_raw)
        shutil.copy2(HOME / "saipen" / "SAICRITIC.md", _flat_home / "SAICRITIC.md")
        _saipen_module.HOME = _flat_home
        expect(
            "installed flattened layout exposes canonical SAICRITIC proof set",
            _saipen_module._canonical_proof_levels()
            == ["UNIT", "COMPOSITION", "CANONICAL", "GATE", "PROVENANCE"],
        )
        (_flat_home / "SAICRITIC.md").unlink()
        try:
            _saipen_module._canonical_proof_levels()
            _missing_proof_refused = False
        except ValueError:
            _missing_proof_refused = True
        expect(
            "missing installed SAICRITIC proof owner refuses before assignment",
            _missing_proof_refused,
        )
    _prepare_proc = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "improve", "prepare", "--json"],
        cwd=str(meta_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "explicit improve prepare is not a hidden public action",
        _prepare_proc.returncode == 2 and '"code": "UNKNOWN_ACTION"' in _prepare_proc.stdout,
        repr(_prepare_proc.stdout[:300]),
    )
    expect(
        "bare saipen improve never changes phase/task (audit prep is read-only for STATE)",
        (meta_root / ".saipen" / "STATE.md").read_bytes() == state_before_meta,
    )
    # Terminal receipts normally move from ops/ to settled/. Resolve through
    # the same Journal authority as production instead of pinning a stale
    # physical namespace in the fixture (a truthful COMMITTED receipt may
    # remain in ops only when the best-effort settlement move fails).
    _admit_journal = Journal(meta_root, _bare_data["op_id"]).read()
    expect(
        "Improve admission journals roster and report as one operation",
        _admit_journal.get("operation") == "improve_admit"
        and len(_admit_journal.get("targets", [])) == 2
        and _admit_journal.get("status") == "COMMITTED",
        repr(_admit_journal),
    )
    _crash_root = project_fixture("saipen-admit-crash-")
    import saipen_engine.journal as _admit_journal_module

    def _crash_between_admission_targets(stage: str) -> None:
        if stage == "manifest":
            raise SystemExit(91)

    with mock.patch.object(
        _admit_journal_module, "_crash_after", side_effect=_crash_between_admission_targets
    ):
        try:
            prepare_audit_seat(
                _crash_root,
                agent_family="probe",
                role="core",
                session_id="probe-crash",
                project_name="SAIPEN",
                model_or_runtime="probe",
                context_scope="atomic admission crash control",
            )
            _admit_crashed = False
        except SystemExit:
            _admit_crashed = True
    _pending_admit = pending_ops(_crash_root)
    _pending_admit_record = (
        Journal(_crash_root, _pending_admit[0]["op_id"]).read() if _pending_admit else {}
    )
    _crash_manifest_exists = any(
        (_crash_root / target["path"]).is_file()
        for target in _pending_admit_record.get("targets", [])
        if target.get("role") == "manifest"
    )
    _crash_report_absent = all(
        not (_crash_root / target["path"]).exists()
        for target in _pending_admit_record.get("targets", [])
        if target.get("role") == "report"
    )
    _admit_recovered = recover(_crash_root, _pending_admit[0]["op_id"]) if _pending_admit else {}
    _recovered_targets_exist = (
        all(
            (_crash_root / target["path"]).is_file()
            for target in _pending_admit_record.get("targets", [])
        )
        if _pending_admit
        else False
    )
    expect(
        "admission crash between roster/report rolls forward both targets",
        _admit_crashed
        and _crash_manifest_exists
        and _crash_report_absent
        and _admit_recovered.get("ok")
        and _recovered_targets_exist
        and not pending_ops(_crash_root),
        repr((_pending_admit, _admit_recovered)),
    )

    # ---- PRE-v8 DOGFOOD VI (T-623): role/session admission contract.
    def _prepare(*options: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(HOME / "tools" / "saipen.py"), "improve", *options, "--json"],
            cwd=str(meta_root),
            capture_output=True,
            text=True,
            timeout=60,
        )

    _second_proc = _prepare("--new-seat")
    _second = json.loads(_second_proc.stdout)
    expect(
        "bare/new-seat allocates an independent seat in the active cycle",
        _second_proc.returncode == 0
        and _second["cycle_id"] == _bare_data["cycle_id"]
        and _second["seat_id"] != _bare_data["seat_id"]
        and _second["report_path"] != _bare_data["report_path"],
        repr(_second),
    )
    _critic_proc = _prepare("--role", "critic", "--session", "critic-session-01")
    _critic = json.loads(_critic_proc.stdout)
    _critic_manifest_before = (
        meta_root / ".saipen" / "improve" / _critic["cycle_id"] / "MANIFEST.md"
    ).read_bytes()
    _critic_report = meta_root / _critic["report_path"]
    _critic_report_before = _critic_report.read_bytes()
    _critic_retry_proc = _prepare("--role", "critic", "--session", "critic-session-01")
    _critic_retry = json.loads(_critic_retry_proc.stdout)
    expect(
        "explicit session retry resumes idempotently without rewriting",
        _critic_proc.returncode == 0
        and _critic_retry_proc.returncode == 0
        and _critic_retry.get("resumed") is True
        and _critic_retry["seat_id"] == _critic["seat_id"]
        and (meta_root / ".saipen" / "improve" / _critic["cycle_id"] / "MANIFEST.md").read_bytes()
        == _critic_manifest_before
        and _critic_report.read_bytes() == _critic_report_before,
        repr(_critic_retry),
    )
    _wrong_role = _prepare("--role", "core", "--session", "critic-session-01")
    expect(
        "explicit session retry refuses role drift",
        _wrong_role.returncode != 0 and "is registered as role" in _wrong_role.stdout,
        repr(_wrong_role.stdout[:300]),
    )
    _bad_role = _prepare("--role", "reviewer")
    expect(
        "Improve role vocabulary is closed to core and critic",
        _bad_role.returncode != 0 and "outside core|critic" in _bad_role.stdout,
        repr(_bad_role.stdout[:300]),
    )

    _status = _prepare("status", _critic["cycle_id"])
    expect(
        "status derives independent same-basename seats by seat identity",
        _status.returncode == 0
        and _bare_data["seat_id"] in _status.stdout
        and _second["seat_id"] in _status.stdout
        and _critic["seat_id"] in _status.stdout
        and '"role": "critic"' in _status.stdout,
        repr(_status.stdout[:500]),
    )
    _critic_report.write_bytes(_critic_report_before.replace(b"role: critic", b"role: core"))
    _mismatch_status = _prepare("status", _critic["cycle_id"])
    expect(
        "status rejects roster/report role mismatch",
        "roster/report role mismatch" in _mismatch_status.stdout
        and '"visible": "INVALID_REPORT"' in _mismatch_status.stdout,
        repr(_mismatch_status.stdout[:500]),
    )
    _critic_report.write_bytes(_critic_report_before)

    # ---- PRE-v8 DOGFOOD VII (T-630): an existing seat's state is a decision,
    # never a blank slate -- missing/malformed/complete/unavailable evidence
    # refuses with zero writes instead of being recreated under the same
    # identity. Runs on its OWN fixture project so the corruption it creates
    # cannot poison the shared meta_root cycle used by later controls.
    _seatc_root = project_fixture("saipen-seat-continuity-")

    def _scprep(*options: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(HOME / "tools" / "saipen.py"), "improve", *options, "--json"],
            cwd=str(_seatc_root),
            capture_output=True,
            text=True,
            timeout=60,
        )

    def _recovery_ops_snapshot(root: Path) -> dict[str, bytes]:
        ops = root / ".saipen" / "recovery" / "ops"
        if not ops.is_dir():
            return {}
        return {
            p.relative_to(ops).as_posix(): p.read_bytes()
            for p in sorted(ops.rglob("*"))
            if p.is_file()
        }

    _gap_proc = _scprep("--role", "critic", "--session", "critic-gap-01")
    _gap = json.loads(_gap_proc.stdout)
    _gap_report = _seatc_root / _gap["report_path"]
    _gap_manifest = _seatc_root / ".saipen" / "improve" / _gap["cycle_id"] / "MANIFEST.md"
    _gap_manifest_before = _gap_manifest.read_bytes()
    _gap_recovery_before = _recovery_ops_snapshot(_seatc_root)
    _gap_report.unlink()
    _gap_retry = json.loads(_scprep("--role", "critic", "--session", "critic-gap-01").stdout)
    expect(
        "missing report under a registered seat REFUSEs SEAT_EVIDENCE_MISSING",
        _gap_proc.returncode == 0
        and _gap_retry.get("code") == "SEAT_EVIDENCE_MISSING"
        and _gap_retry.get("ok") is False,
        repr(_gap_retry),
    )
    expect(
        "missing report causes zero writes and no new provenance",
        not _gap_report.exists()
        and _gap_manifest.read_bytes() == _gap_manifest_before
        and _recovery_ops_snapshot(_seatc_root) == _gap_recovery_before,
        repr(
            (
                _gap_report.exists(),
                _gap_manifest.read_bytes() == _gap_manifest_before,
                sorted(set(_recovery_ops_snapshot(_seatc_root)) - set(_gap_recovery_before)),
            )
        ),
    )

    _complete_proc = _scprep("--role", "critic", "--session", "critic-complete-01")
    _complete = json.loads(_complete_proc.stdout)
    _complete_report_path = _seatc_root / _complete["report_path"]
    append_run(
        _complete_report_path,
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        "expected: executable next action\n"
        "actual: resumed immutable report\n"
        "evidence: seat continuity control\n",
    )
    complete_report(_complete_report_path)
    _complete_retry = json.loads(
        _scprep("--role", "critic", "--session", "critic-complete-01").stdout
    )
    expect(
        "COMPLETE report cannot resume (SEAT_COMPLETE, resumed false)",
        _complete_retry.get("code") == "SEAT_COMPLETE" and _complete_retry.get("resumed") is False,
        repr(_complete_retry),
    )
    expect(
        "COMPLETE report yields an executable stable instruction",
        _complete_retry.get("next") and "saipen improve sweep" in _complete_retry.get("next", ""),
        repr(_complete_retry.get("next", "")),
    )

    _unavail_proc = _scprep("--role", "critic", "--session", "critic-unavail-01")
    _unavail = json.loads(_unavail_proc.stdout)
    _unavail_manifest = _seatc_root / ".saipen" / "improve" / _unavail["cycle_id"] / "MANIFEST.md"
    _unavail_report = _seatc_root / _unavail["report_path"]
    _unavail_report.unlink()

    def _set_seat_availability(manifest_text: str, seat_id: str, value: str) -> str:
        lines = manifest_text.splitlines()
        out = []
        in_block = False
        for raw in lines:
            ln = raw
            if ln.startswith("seat_id: "):
                in_block = ln.strip() == f"seat_id: {seat_id}"
            if in_block and ln.strip().startswith("availability: "):
                ln = f"availability: {value}"
            out.append(ln)
        return "\n".join(out) + "\n"

    _unavail_manifest.write_text(
        _set_seat_availability(
            _unavail_manifest.read_text(encoding="utf-8-sig"), _unavail["seat_id"], "unavailable"
        ),
        encoding="utf-8",
    )
    _unavail_retry = json.loads(
        _scprep("--role", "critic", "--session", "critic-unavail-01").stdout
    )
    expect(
        "unavailable roster seat cannot revive (SEAT_UNAVAILABLE, zero writes)",
        _unavail_retry.get("code") == "SEAT_UNAVAILABLE" and not _unavail_report.exists(),
        repr(_unavail_retry),
    )

    _malformed_proc = _scprep("--role", "critic", "--session", "critic-malformed-01")
    _malformed = json.loads(_malformed_proc.stdout)
    _malformed_report = _seatc_root / _malformed["report_path"]
    _malformed_report.write_text(
        _malformed_report.read_text(encoding="utf-8-sig").replace(
            "report_status: draft", "report_status:", 1
        ),
        encoding="utf-8",
    )
    _malformed_retry = json.loads(
        _scprep("--role", "critic", "--session", "critic-malformed-01").stdout
    )
    expect(
        "malformed registered report refuses INVALID_REPORT, never replaced by prepare",
        _malformed_retry.get("code") == "INVALID_REPORT"
        and "report_status" in _malformed_report.read_text(encoding="utf-8-sig"),
        repr(_malformed_retry),
    )
    _malformed_report.write_text(
        _malformed_report.read_text(encoding="utf-8-sig").replace(
            "report_status:", "report_status: bogus", 1
        ),
        encoding="utf-8",
    )
    _bogus_retry = json.loads(
        _scprep("--role", "critic", "--session", "critic-malformed-01").stdout
    )
    expect(
        "an unexpected report_status (bogus) refuses INVALID_REPORT -- only an exact draft resumes",
        _bogus_retry.get("code") == "INVALID_REPORT" and "bogus" in _bogus_retry.get("detail", ""),
        repr(_bogus_retry),
    )
    _no_prov_proc = _scprep("--role", "critic", "--session", "critic-noprov-01")
    _no_prov = json.loads(_no_prov_proc.stdout)
    _no_prov_report = _seatc_root / _no_prov["report_path"]
    _no_prov_report.write_text(
        _no_prov_report.read_text(encoding="utf-8-sig").replace(
            "source_head: ", "source_head_missing: ", 1
        ),
        encoding="utf-8",
    )
    _no_prov_retry = json.loads(_scprep("--role", "critic", "--session", "critic-noprov-01").stdout)
    expect(
        "a draft missing required provenance refuses INVALID_REPORT "
        "(validate_report gates the resume)",
        _no_prov_retry.get("code") == "INVALID_REPORT"
        and "source_head" in _no_prov_retry.get("detail", ""),
        repr(_no_prov_retry),
    )
    _binary_proc = _scprep("--role", "critic", "--session", "critic-binary-01")
    _binary = json.loads(_binary_proc.stdout)
    (_seatc_root / _binary["report_path"]).write_bytes(b"\x80\x81\x82\xff")
    _binary_retry = json.loads(_scprep("--role", "critic", "--session", "critic-binary-01").stdout)
    expect(
        "an undecodable report refuses INVALID_REPORT without a traceback",
        _binary_retry.get("code") == "INVALID_REPORT"
        and "cannot be decoded" in _binary_retry.get("detail", ""),
        repr(_binary_retry),
    )
    _runless_proc = _scprep("--role", "critic", "--session", "critic-runless-01")
    _runless = json.loads(_runless_proc.stdout)
    _runless_report = _seatc_root / _runless["report_path"]
    _runless_report.write_text(
        _runless_report.read_text(encoding="utf-8-sig").replace(
            "report_status: draft", "report_status: complete", 1
        ),
        encoding="utf-8",
    )
    _runless_retry = json.loads(
        _scprep("--role", "critic", "--session", "critic-runless-01").stdout
    )
    expect(
        "a runless complete skeleton refuses INVALID_REPORT, never SEAT_COMPLETE",
        _runless_retry.get("code") == "INVALID_REPORT"
        and "without run evidence" in _runless_retry.get("detail", ""),
        repr(_runless_retry),
    )
    _duph_proc = _scprep("--role", "critic", "--session", "critic-duphdr-01")
    _duph = json.loads(_duph_proc.stdout)
    _duph_report = _seatc_root / _duph["report_path"]
    _duph_report.write_text(
        _duph_report.read_text(encoding="utf-8-sig").replace(
            "role: critic", "role: critic\nrole: critic", 1
        ),
        encoding="utf-8",
    )
    _duph_retry = json.loads(_scprep("--role", "critic", "--session", "critic-duphdr-01").stdout)
    expect(
        "a report repeating a required header field refuses INVALID_REPORT",
        _duph_retry.get("code") == "INVALID_REPORT"
        and "repeats required header" in _duph_retry.get("detail", ""),
        repr(_duph_retry),
    )
    _prose_proc = _scprep("--role", "critic", "--session", "critic-prose-01")
    _prose = json.loads(_prose_proc.stdout)
    _prose_report = _seatc_root / _prose["report_path"]
    append_run(
        _prose_report,
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        "report_status: mentioned inside finding evidence is prose\n"
        "expected: anchored header counting\n"
        "actual: prose ignored\n"
        "evidence: seat continuity control\n",
    )
    _prose_retry = json.loads(_scprep("--role", "critic", "--session", "critic-prose-01").stdout)
    expect(
        "a prose line mentioning report_status does not false-reject a "
        "draft resume (header-anchored count)",
        _prose_retry.get("ok") is True and _prose_retry.get("resumed") is True,
        repr(_prose_retry),
    )

    _identity_root = project_fixture("saipen-seat-identity-")
    _identity_assignments = [
        prepare_audit_seat(
            _identity_root,
            agent_family="probe",
            role="core",
            session_id=seat,
            project_name="SAME",
            model_or_runtime="probe",
            context_scope="seat identity control",
        )
        for seat in ("seat-a", "seat-b")
    ]
    for _assignment in _identity_assignments:
        _identity_report = Path(_assignment["report_path"])
        append_run(
            _identity_report,
            "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
            "expected: independent disposition\n"
            "actual: shared basename\n"
            "evidence: seat identity control\n",
        )
        complete_report(_identity_report)
    _identity_cycle = cycle_dir(_identity_root, _identity_assignments[0]["cycle_id"])
    write_sweep_entry(
        _identity_cycle,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "INVALID",
            "ticket": "-",
            "report": "seat-a/saipen_improve_SAME.md",
            "reproduced": "y",
        },
    )
    _identity_roster = (_identity_cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
    _identity_sweep = (_identity_cycle / "SWEEP.md").read_text(encoding="utf-8-sig")
    _identity_report_texts = [
        Path(a["report_path"]).read_text(encoding="utf-8-sig") for a in _identity_assignments
    ]
    expect(
        "same-basename disposition is isolated by exact seat/report key",
        derive_status(
            "saipen_improve_SAME.md",
            _identity_roster,
            _identity_report_texts[0],
            _identity_sweep,
            seat_id="seat-a",
        )["visible"]
        == "swept"
        and derive_status(
            "saipen_improve_SAME.md",
            _identity_roster,
            _identity_report_texts[1],
            _identity_sweep,
            seat_id="seat-b",
        )["visible"]
        == "complete",
    )
    try:
        derive_status(
            "saipen_improve_SAME.md", _identity_roster, _identity_report_texts[1], _identity_sweep
        )
        _ambiguous_status_refused = False
    except ValueError as _ambiguous_status_exc:
        _ambiguous_status_refused = "pass exact seat_id" in str(_ambiguous_status_exc)
    expect(
        "status derivation refuses ambiguous basename without seat_id", _ambiguous_status_refused
    )
    try:
        write_sweep_entry(
            _identity_cycle,
            {
                "run": "RUN-1",
                "imp_id": "001",
                "disposition": "INVALID",
                "ticket": "-",
                "report": "saipen_improve_SAME.md",
                "reproduced": "y",
            },
        )
        _ambiguous_report_refused = False
    except ValueError as _identity_exc:
        _ambiguous_report_refused = "multiple seat owners" in str(_identity_exc)
    expect("ambiguous legacy report basename refuses disposition", _ambiguous_report_refused)
    _identity_queue_proc = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "improve",
            "sweep-queue",
            _identity_cycle.name,
            "--json",
        ],
        cwd=str(_identity_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    _identity_queue = json.loads(_identity_queue_proc.stdout).get("queue", [])
    expect(
        "sweep queue keeps unswept same-basename seat addressable",
        len(_identity_queue) == 1
        and _identity_queue[0].get("report") == "seat-b/saipen_improve_SAME.md",
        repr(_identity_queue),
    )
    _legacy_identity_root = project_fixture("saipen-legacy-identity-")
    _legacy_first = prepare_audit_seat(
        _legacy_identity_root,
        agent_family="probe",
        role="core",
        session_id="seat-a",
        project_name="SAME",
        model_or_runtime="probe",
        context_scope="legacy identity control",
    )
    _legacy_report = Path(_legacy_first["report_path"])
    append_run(
        _legacy_report,
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        "expected: stable provenance\nactual: legacy basename\n"
        "evidence: late admission control\n",
    )
    complete_report(_legacy_report)
    _legacy_cycle = cycle_dir(_legacy_identity_root, _legacy_first["cycle_id"])
    write_sweep_entry(
        _legacy_cycle,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "INVALID",
            "ticket": "-",
            "report": "saipen_improve_SAME.md",
            "reproduced": "y",
        },
    )
    _legacy_sweep_path = _legacy_cycle / "SWEEP.md"
    _legacy_sweep_path.write_bytes(
        _legacy_sweep_path.read_bytes().replace(
            b"report=seat-a/saipen_improve_SAME.md", b"report=saipen_improve_SAME.md"
        )
    )
    _legacy_manifest_before = (_legacy_cycle / "MANIFEST.md").read_bytes()
    _legacy_sweep_before = (_legacy_cycle / "SWEEP.md").read_bytes()
    try:
        register_seat(_legacy_cycle, "seat-b", "core", "saipen_improve_SAME.md")
        _legacy_register_refused = False
    except ValueError as _legacy_register_exc:
        _legacy_register_refused = "existing bare SWEEP identity" in str(_legacy_register_exc)
    try:
        prepare_audit_seat(
            _legacy_identity_root,
            agent_family="probe",
            role="core",
            session_id="seat-b",
            project_name="SAME",
            model_or_runtime="probe",
            context_scope="legacy identity control",
        )
        _late_duplicate_refused = False
    except ValueError as _legacy_identity_exc:
        _late_duplicate_refused = "existing bare SWEEP identity" in str(_legacy_identity_exc)
    expect(
        "late duplicate-basename admission preserves legacy provenance",
        _legacy_register_refused
        and _late_duplicate_refused
        and (_legacy_cycle / "MANIFEST.md").read_bytes() == _legacy_manifest_before
        and (_legacy_cycle / "SWEEP.md").read_bytes() == _legacy_sweep_before
        and not (_legacy_cycle / "seat-b").exists(),
    )

    # ---- PRE-v8 DOGFOOD VIII (A1-A6): hostile evidence-continuity closeout.
    # T-1406: a DRAFT with ZERO committed RUN sections is an assignment, not
    # evidence -- when its mechanical identity header went stale (install
    # update or tracked source change between admission and resume) it is
    # re-bound IN PLACE through the journal: only installed version/fingerprint
    # and the source identity fields are re-derived, assignment context and
    # body bytes are never touched. A draft with ANY committed RUN is evidence
    # and is never re-bound; the refusal names the canonical retire route.
    _stale_root = project_fixture("saipen-stale-draft-")
    (_stale_root / "src.txt").write_text("v1\n", encoding="utf-8")
    _stale_first = prepare_audit_seat(
        _stale_root,
        agent_family="probe",
        role="critic",
        session_id="critic-stale-01",
        project_name="STALE",
        model_or_runtime="probe",
        context_scope="stale draft control",
    )
    _stale_report = _stale_root / _stale_first["report_path"]
    _stale_manifest = _stale_root / ".saipen" / "improve" / _stale_first["cycle_id"] / "MANIFEST.md"
    _stale_manifest_before = _stale_manifest.read_bytes()
    _stale_recovery_before = _recovery_ops_snapshot(_stale_root)
    (_stale_root / "src.txt").write_text("v2 -- tracked source changed\n", encoding="utf-8")
    _stale_retry = prepare_audit_seat(
        _stale_root,
        agent_family="probe",
        role="critic",
        session_id="critic-stale-01",
        project_name="STALE",
        model_or_runtime="probe",
        context_scope="stale draft control",
    )
    _stale_current = compute_source_identity(_stale_root)
    _stale_text = _stale_report.read_text(encoding="utf-8-sig")
    expect(
        "T-1406: stale un-audited DRAFT resume re-binds the mechanical header "
        "through the journal with zero manifest bytes",
        _stale_retry.get("code") == "ALREADY_ASSIGNED"
        and _stale_retry.get("resumed") is True
        and _stale_retry.get("header_rebound") is True
        and _stale_retry.get("previous_source_head") != ""
        and _stale_manifest.read_bytes() == _stale_manifest_before
        and _recovery_ops_snapshot(_stale_root) == _stale_recovery_before
        and f"source_tree_fingerprint: {_stale_current.source_tree_fingerprint}" in _stale_text
        and len(re.findall(r"(?m)^## RUN \d+\s*$", _stale_text)) == 0,
        repr(_stale_retry),
    )

    # T-1406: the FreeBuff incident shape -- install-stale (not source-stale)
    # un-audited draft resumes by re-binding the install identity fields.
    _fp_root = project_fixture("saipen-stale-fingerprint-")
    _fp_first = prepare_audit_seat(
        _fp_root,
        agent_family="probe",
        role="critic",
        session_id="critic-fp-01",
        project_name="FP",
        model_or_runtime="probe",
        context_scope="install fingerprint control",
    )
    _fp_report = _fp_root / _fp_first["report_path"]
    _fp_stale = "sha256:" + "f" * 64
    _fp_report.write_text(
        re.sub(
            r"(?m)^protocol_fingerprint:.*$",
            f"protocol_fingerprint: {_fp_stale}",
            _fp_report.read_text(encoding="utf-8-sig"),
            count=1,
        ),
        encoding="utf-8",
    )
    _fp_retry = prepare_audit_seat(
        _fp_root,
        agent_family="probe",
        role="critic",
        session_id="critic-fp-01",
        project_name="FP",
        model_or_runtime="probe",
        context_scope="install fingerprint control",
    )
    expect(
        "T-1406: install-stale un-audited DRAFT re-binds and reports the old "
        "fingerprint",
        _fp_retry.get("code") == "ALREADY_ASSIGNED"
        and _fp_retry.get("header_rebound") is True
        and _fp_retry.get("previous_protocol_fingerprint") == _fp_stale,
        repr(_fp_retry),
    )

    # A1: an audited DRAFT (any committed RUN) is evidence: the stale resume
    # still refuses, byte-preserves the report, and names the retire route.
    _stale2_root = project_fixture("saipen-stale-audited-")
    (_stale2_root / "src.txt").write_text("v1\n", encoding="utf-8")
    _stale2_first = prepare_audit_seat(
        _stale2_root,
        agent_family="probe",
        role="critic",
        session_id="critic-stale-02",
        project_name="STAUD",
        model_or_runtime="probe",
        context_scope="audited stale control",
    )
    _stale2_report = _stale2_root / _stale2_first["report_path"]
    append_run(_stale2_report, "NO_FINDINGS")
    _stale2_report_before = _stale2_report.read_bytes()
    (_stale2_root / "src.txt").write_text("v2 -- tracked source changed\n", encoding="utf-8")
    _stale2_retry = prepare_audit_seat(
        _stale2_root,
        agent_family="probe",
        role="critic",
        session_id="critic-stale-02",
        project_name="STAUD",
        model_or_runtime="probe",
        context_scope="audited stale control",
    )
    expect(
        "T-1406: a draft with a committed RUN is never re-bound and the "
        "refusal names the retire route",
        _stale2_retry.get("code") in ("STALE_REPORT", "INVALID_REPORT")
        and _stale2_retry.get("resumed") is False
        and _stale2_report.read_bytes() == _stale2_report_before
        and "improve retire" in str(_stale2_retry.get("detail", "")),
        repr(_stale2_retry),
    )

    # T-1406 bounded exit: retire the one seat that can never complete while a
    # second seat carries the evidence. Every SWEEP disposition survives, the
    # never-completed report stays byte-identical, the retired seat is skipped
    # by the cycle bar, and the cycle completes.
    _ret_root = project_fixture("saipen-retire-seat-")
    _ret_s1 = prepare_audit_seat(
        _ret_root,
        agent_family="probe",
        role="critic",
        session_id="critic-ret-01",
        project_name="RET",
        model_or_runtime="probe",
        context_scope="retire control",
    )
    _ret_s2 = prepare_audit_seat(
        _ret_root,
        agent_family="probe",
        role="critic",
        session_id="critic-ret-02",
        project_name="RET",
        model_or_runtime="probe",
        context_scope="retire control",
    )
    _ret_cycle = cycle_dir(_ret_root, _ret_s1["cycle_id"])
    _ret_r1 = _ret_root / _ret_s1["report_path"]
    _ret_r2 = _ret_root / _ret_s2["report_path"]
    append_run(_ret_r1, "NO_FINDINGS")
    _ret_r1.write_text(
        re.sub(
            r"(?m)^protocol_fingerprint:.*$",
            "protocol_fingerprint: sha256:" + "f" * 64,
            _ret_r1.read_text(encoding="utf-8-sig"),
            count=1,
        ),
        encoding="utf-8",
    )
    append_run(
        _ret_r2,
        "IMP-001 [P2] [LOGIC_ERROR] [observed] [note]\n"
        "expected: no synthetic finding\nactual: synthetic finding\n"
        "evidence: retire control\n",
    )
    complete_report(_ret_r2)
    write_sweep_entry(
        _ret_cycle,
        {
            "run": "RUN-1",
            "imp_id": "IMP-001",
            "disposition": "NOT_REPRODUCED",
            "ticket": "-",
            "report": "critic-ret-02/saipen_improve_RET.md",
            "reproduced": "n",
        },
    )
    _ret_r1_before = _ret_r1.read_bytes()
    _ret_r2_before = _ret_r2.read_bytes()
    try:
        abort_cycle(_ret_cycle)
        _ret_abort_refused = False
    except ImproveError as _ret_abort_exc:
        _ret_abort_refused = "improve retire" in str(_ret_abort_exc)
    _ret_done = retire_seat(_ret_cycle, "critic-ret-01", "STALE_INSTALL")
    _ret_manifest = (_ret_cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
    try:
        retire_seat(_ret_cycle, "critic-ret-01", "AGAIN")
        _ret_double_refused = False
    except ImproveError as _ret_double_exc:
        _ret_double_refused = "already unavailable" in str(_ret_double_exc)
    try:
        retire_seat(_ret_cycle, "critic-ret-02", "COMPLETE_SEAT")
        _ret_complete_refused = False
    except ImproveError as _ret_complete_exc:
        _ret_complete_refused = "is complete" in str(_ret_complete_exc)
    _ret_verify = verify_cycle(_ret_cycle)
    _ret_completed = complete_cycle(_ret_cycle)
    expect(
        "T-1406: bounded exit -- abort refuses post-sweep, retire preserves "
        "the dead report and every disposition, then the cycle completes",
        _ret_abort_refused
        and _ret_done.get("code") == "SEAT_RETIRED"
        and _ret_done.get("availability") == "unavailable"
        and "availability: unavailable" in _ret_manifest
        and _ret_double_refused
        and _ret_complete_refused
        and _ret_verify == []
        and _ret_completed.get("ok") is True
        and _ret_r1.read_bytes() == _ret_r1_before
        and _ret_r2.read_bytes() == _ret_r2_before,
        repr((_ret_done, _ret_verify, _ret_completed)),
    )

    # A2: an invalid active MANIFEST is never consumed or mutated. validate
    # _manifest(expected_cycle_id) gates admission, unavailable handling and
    # resume; an invalid roster returns structured INVALID_MANIFEST with zero
    # new mutation and byte-identical evidence.
    _manifest_root = project_fixture("saipen-invalid-manifest-")
    _mf_first = prepare_audit_seat(
        _manifest_root,
        agent_family="probe",
        role="critic",
        session_id="critic-mf-01",
        project_name="MF",
        model_or_runtime="probe",
        context_scope="invalid manifest control",
    )
    _mf_cycle = cycle_dir(_manifest_root, _mf_first["cycle_id"])
    _mf_manifest = _mf_cycle / "MANIFEST.md"
    _mf_recovery_before = _recovery_ops_snapshot(_manifest_root)
    _mf_manifest.write_text(
        _mf_manifest.read_text(encoding="utf-8-sig").replace(
            "cycle_id: " + _mf_first["cycle_id"], "cycle_id: WRONG", 1
        ),
        encoding="utf-8",
    )
    _mf_manifest_before = _mf_manifest.read_bytes()
    _mf_second = prepare_audit_seat(
        _manifest_root,
        agent_family="probe",
        role="critic",
        session_id="critic-mf-02",
        project_name="MF",
        model_or_runtime="probe",
        context_scope="invalid manifest control",
    )
    expect(
        "A2: admission on an invalid active manifest refuses "
        "INVALID_MANIFEST with zero new mutation",
        _mf_second.get("code") == "INVALID_MANIFEST"
        and _mf_second.get("ok") is False
        and not (_mf_cycle / "critic-mf-02").exists()
        and _mf_manifest.read_bytes() == _mf_manifest_before
        and _recovery_ops_snapshot(_manifest_root) == _mf_recovery_before,
        repr(_mf_second),
    )
    try:
        register_seat(_mf_cycle, "critic-mf-03", "critic", "saipen_improve_MF.md")
        _mf_register_refused = False
    except ImproveError as _mf_exc:
        _mf_register_refused = "invalid active manifest" in str(_mf_exc)
    expect("A2: register_seat refuses an invalid active manifest", _mf_register_refused, "")

    # A3: strict seat field cardinality -- exactly one identity/lifecycle
    # field per seat; duplicate fields and out-of-set availability refuse.
    _card_root = project_fixture("saipen-seat-cardinality-")
    _card_first = prepare_audit_seat(
        _card_root,
        agent_family="probe",
        role="critic",
        session_id="critic-card-01",
        project_name="CARD",
        model_or_runtime="probe",
        context_scope="cardinality control",
    )
    _card_cycle = cycle_dir(_card_root, _card_first["cycle_id"])
    _card_manifest = _card_cycle / "MANIFEST.md"
    _card_manifest.write_text(
        _card_manifest.read_text(encoding="utf-8-sig").replace(
            "role: critic", "role: critic\nrole: critic", 1
        ),
        encoding="utf-8",
    )
    _card_second = prepare_audit_seat(
        _card_root,
        agent_family="probe",
        role="critic",
        session_id="critic-card-02",
        project_name="CARD",
        model_or_runtime="probe",
        context_scope="cardinality control",
    )
    expect(
        "A3: a duplicated strict seat role field refuses INVALID_MANIFEST "
        "(exactly-once, no first/last-value ambiguity)",
        _card_second.get("code") == "INVALID_MANIFEST"
        and "exactly once" in _card_second.get("detail", ""),
        repr(_card_second),
    )
    _bogus_root = project_fixture("saipen-availability-bogus-")
    _bg_first = prepare_audit_seat(
        _bogus_root,
        agent_family="probe",
        role="critic",
        session_id="critic-bg-01",
        project_name="BG",
        model_or_runtime="probe",
        context_scope="bogus availability control",
    )
    _bg_cycle = cycle_dir(_bogus_root, _bg_first["cycle_id"])
    _bg_manifest = _bg_cycle / "MANIFEST.md"
    (_bogus_root / _bg_first["report_path"]).unlink()
    _bg_manifest.write_text(
        _bg_manifest.read_text(encoding="utf-8-sig").replace(
            "availability: expected", "availability: bogus", 1
        ),
        encoding="utf-8",
    )
    _bg_retry = prepare_audit_seat(
        _bogus_root,
        agent_family="probe",
        role="critic",
        session_id="critic-bg-01",
        project_name="BG",
        model_or_runtime="probe",
        context_scope="bogus availability control",
    )
    expect(
        "A3: availability bogus can never resume as ALREADY_ASSIGNED",
        _bg_retry.get("code") == "INVALID_MANIFEST" and _bg_retry.get("ok") is False,
        repr(_bg_retry),
    )

    # A4: strict RUN + finding identity is INJECTIVE -- unique, ascending,
    # contiguous 1..N RUNs, canonical IMP-NNN grammar, unique composite
    # <RUN>/<IMP> identities. False evidence cannot validate, and a duplicate
    # composite can never reach complete/swept state.
    _a4_strict = (
        "agent: a\nrole: core\nmodel_or_runtime: probe\nproject: P\n"
        "saipen_version: 7\nprotocol_fingerprint: fp\n"
        "source_head: no-git\n"
        "source_tree_fingerprint: no-git-tree-v1:abc\n"
        "discovery_model: no-git-tree-v1\n"
        "context_scope: tools\ncontext_available: complete\n"
        "report_status: complete\n"
    )
    _a4_run = (
        "\n## RUN {n}\nIMP-{i} [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        "expected: a\nactual: b\nevidence: c\n"
    )

    def _a4_errs(body: str) -> list[str]:
        return validate_report(_a4_strict + body, require_runs=True, strict=True)

    expect(
        "A4: a strict report with unique contiguous RUNs validates",
        _a4_errs(_a4_run.format(n=1, i="001")) == [],
        repr(_a4_errs(_a4_run.format(n=1, i="001"))),
    )
    expect(
        "A4: duplicate RUN 1 rejects (repeated section number)",
        any(
            "repeats RUN section" in e
            for e in _a4_errs(_a4_run.format(n=1, i="001") + _a4_run.format(n=1, i="002"))
        ),
        repr(_a4_errs(_a4_run.format(n=1, i="001") + _a4_run.format(n=1, i="002"))),
    )
    expect(
        "A4: RUN 1 then RUN 3 rejects (not contiguous 1..N)",
        any(
            "not contiguous" in e
            for e in _a4_errs(_a4_run.format(n=1, i="001") + _a4_run.format(n=3, i="002"))
        ),
        repr(_a4_errs(_a4_run.format(n=1, i="001") + _a4_run.format(n=3, i="002"))),
    )
    expect(
        "A4: RUN 2 as the first run rejects (not contiguous 1..N)",
        any("not contiguous" in e for e in _a4_errs(_a4_run.format(n=2, i="001"))),
        repr(_a4_errs(_a4_run.format(n=2, i="001"))),
    )
    expect(
        "A4: swapped/decreasing RUN numbers reject (not ascending)",
        any(
            "not ascending" in e
            for e in _a4_errs(_a4_run.format(n=2, i="001") + _a4_run.format(n=1, i="002"))
        ),
        repr(_a4_errs(_a4_run.format(n=2, i="001") + _a4_run.format(n=1, i="002"))),
    )
    _a4_dup_imp = _a4_run.format(n=1, i="001").replace(
        "evidence: c",
        "evidence: c\n"
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
        "expected: d\nactual: e\nevidence: f",
        1,
    )
    expect(
        "A4: duplicate IMP-001 inside one RUN rejects before any dedup",
        any("repeats composite finding identity" in e for e in _a4_errs(_a4_dup_imp)),
        repr(_a4_errs(_a4_dup_imp)),
    )
    expect(
        "A4: malformed IMP width (IMP-1) rejects canonical IMP-NNN",
        any("not canonical IMP-NNN" in e for e in _a4_errs(_a4_run.format(n=1, i="1"))),
        repr(_a4_errs(_a4_run.format(n=1, i="1"))),
    )
    _a4_same_in_two_runs = _a4_run.format(n=1, i="001") + _a4_run.format(n=2, i="001")
    expect(
        "A4: the same IMP-001 in two DIFFERENT RUNs stays distinct",
        _a4_errs(_a4_same_in_two_runs) == [],
        repr(_a4_errs(_a4_same_in_two_runs)),
    )
    _dc_root = project_fixture("saipen-dupcomposite-")
    _dc_cycle = create_cycle(_dc_root, "imp-dup")
    register_seat(_dc_cycle, "seat-1", "core", "saipen_improve_D.md")
    _dc_rep = create_report(
        _dc_root,
        "imp-dup",
        "seat-1",
        "D",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    _dc_bytes_before = _dc_rep.read_bytes()
    try:
        append_run(
            _dc_rep,
            "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
            "expected: a\nactual: b\nevidence: c\n"
            "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\n"
            "expected: d\nactual: e\nevidence: f\n",
        )
        _dc_append = False
    except ImproveError:
        _dc_append = True
    expect(
        "A4 + T-638/§2: a duplicate composite identity is refused at "
        "append with ZERO writes (never enters a report that could be "
        "swept)",
        _dc_append and _dc_rep.read_bytes() == _dc_bytes_before,
        "",
    )

    # A5: strict report requires discovery_model exactly once; legacy reports
    # keep the deliberate boundary and stay valid without it.
    _a5_root = project_fixture("saipen-a5-header-")
    _a5_first = prepare_audit_seat(
        _a5_root,
        agent_family="probe",
        role="critic",
        session_id="critic-a5-01",
        project_name="A5",
        model_or_runtime="probe",
        context_scope="header parity control",
    )
    _a5_report = _a5_root / _a5_first["report_path"]
    _a5_report.write_text(
        _a5_report.read_text(encoding="utf-8-sig").replace(
            "discovery_model: ", "removed_discovery_model: ", 1
        ),
        encoding="utf-8",
    )
    _a5_retry = prepare_audit_seat(
        _a5_root,
        agent_family="probe",
        role="critic",
        session_id="critic-a5-01",
        project_name="A5",
        model_or_runtime="probe",
        context_scope="header parity control",
    )
    expect(
        "A5: a strict report missing discovery_model refuses "
        "INVALID_REPORT (writer/spec/validator field parity)",
        _a5_retry.get("code") == "INVALID_REPORT"
        and "discovery_model" in _a5_retry.get("detail", ""),
        repr(_a5_retry),
    )
    _a5_legacy = validate_report(_a4_strict.replace("discovery_model: no-git-tree-v1\n", ""))
    expect(
        "A5: a legacy (non-strict) report may omit discovery_model "
        "(deliberate legacy boundary only where history needs it)",
        _a5_legacy == [],
        repr(_a5_legacy),
    )
    _a5_dup = _a4_strict.replace(
        "discovery_model: no-git-tree-v1", "discovery_model: no-git-tree-v1\ndiscovery_model: x", 1
    )
    expect(
        "A5: a duplicated discovery_model in a strict report rejects",
        any("repeats required header" in e for e in validate_report(_a5_dup, strict=True)),
        repr(validate_report(_a5_dup, strict=True)),
    )

    # HUNT closeout controls: the ledger side of A4 and the create_report
    # side of A2 -- no identity ambiguity survives on either write path.
    from improve import validate_sweep as _vsweep

    _dup_sweep = (
        "# SWEEP\n- RUN-1/IMP-001 [CONFIRMED] T-900 "
        "report=saipen_improve_D.md reproduced=y\n"
        "- RUN-1/IMP-001 [CONFIRMED] T-900 "
        "report=saipen_improve_D.md reproduced=y\n"
    )
    expect(
        "A4: a SWEEP ledger repeating one composite identity rejects "
        "(one disposition per composite finding identity)",
        any("repeats composite identity" in e for e in _vsweep(_dup_sweep)),
        repr(_vsweep(_dup_sweep)),
    )
    _cr_root = project_fixture("saipen-create-report-gate-")
    _cr_cycle = create_cycle(_cr_root, "imp-cr")
    register_seat(_cr_cycle, "seat-1", "core", "saipen_improve_CR.md")
    (_cr_cycle / "MANIFEST.md").write_text(
        (_cr_cycle / "MANIFEST.md")
        .read_text(encoding="utf-8-sig")
        .replace("cycle_id: imp-cr", "cycle_id: WRONG", 1),
        encoding="utf-8",
    )
    try:
        create_report(
            _cr_root,
            "imp-cr",
            "seat-1",
            "CR",
            agent="seat-1",
            role="core",
            model_or_runtime="probe",
            context_scope="scope",
        )
        _cr_gated = False
    except ImproveError as _cr_exc:
        _cr_gated = "invalid active manifest" in str(_cr_exc)
    expect(
        "A2: create_report refuses an invalid active manifest "
        "(no first-value roster interpretation)",
        _cr_gated,
        "",
    )

    _public_cmd = [
        sys.executable,
        str(HOME / "tools" / "saipen.py"),
        "improve",
        "--new-seat",
        "--json",
    ]
    _parallel = [
        subprocess.Popen(
            _public_cmd,
            cwd=str(meta_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(2)
    ]
    _parallel_results = []
    for _proc in _parallel:
        _out, _err = _proc.communicate(timeout=60)
        try:
            _payload = json.loads(_out)
        except (json.JSONDecodeError, ValueError):
            _payload = {
                "code": "MALFORMED_CHILD_OUTPUT",
                "stdout": _out[-500:],
                "stderr": _err[-1000:],
            }
        _parallel_results.append((_proc.returncode, _payload, _err))
    _parallel_assignments = [
        r[1] for r in _parallel_results if r[1].get("code") == "IMPROVE_AUDIT_ASSIGNMENT"
    ]
    for _result in _parallel_results:
        if _result[1].get("code") == "WRITER_BUSY":
            _retry = _prepare("--new-seat")
            if _retry.returncode == 0:
                _parallel_assignments.append(json.loads(_retry.stdout))
    expect(
        "simultaneous admissions lose no seat and allocate no duplicate",
        len(_parallel_assignments) == 2
        and len({a["seat_id"] for a in _parallel_assignments}) == 2
        and all("Traceback" not in r[2] for r in _parallel_results),
        repr(_parallel_results),
    )

    with WriterLock(meta_root):
        _busy_proc = _prepare("--new-seat")
    try:
        _busy_payload = json.loads(_busy_proc.stdout)
    except (json.JSONDecodeError, ValueError):
        _busy_payload = {
            "code": "MALFORMED_CHILD_OUTPUT",
            "stdout": _busy_proc.stdout[-500:],
            "stderr": _busy_proc.stderr[-1000:],
        }
    expect(
        "live Improve contention returns structured WRITER_BUSY",
        _busy_proc.returncode != 0
        and _busy_payload.get("code") == "WRITER_BUSY"
        and "Traceback" not in _busy_proc.stderr,
        repr((_busy_proc.returncode, _busy_payload, _busy_proc.stderr)),
    )

    _saipen_module.HOME = HOME
    with mock.patch.object(_saipen_module, "_improve", side_effect=TypeError("programming defect")):
        try:
            _saipen_module._public_improve(meta_root, [], True, False)
            _programming_error_raised = False
        except TypeError:
            _programming_error_raised = True
    expect("public Improve boundary never normalizes programming errors", _programming_error_raised)
    _mcycle = _bare_data["cycle_id"]
    _mseat = _bare_data["seat_id"]
    _cycles_before_verify = len(list((meta_root / ".saipen" / "improve").iterdir()))
    _mv = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "improve", "verify", _mcycle, "--json"],
        cwd=str(meta_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "saipen improve verify validates the complete cycle output and "
        "does not recurse into a new cycle",
        '"code": "VALIDATION_FAILED"' in _mv.stdout
        and len(list((meta_root / ".saipen" / "improve").iterdir())) == _cycles_before_verify,
        repr(_mv.stdout[:200]),
    )

    # ---- DOGFOOD V (T-616): saipen improve verify can no longer PASS an
    # incomplete completed report (a bare report_status skeleton).
    false_root = project_fixture("saipen-false-")
    _fc = register_cycle(false_root, "imp-false", "# IMPROVE CYCLE ROSTER\ncycle_status: active\n")
    register_seat(_fc, "seat-1", "core", "saipen_improve_A.md")
    _fr = resolve_report_path(false_root, "imp-false", "seat-1", "A")
    _fr.parent.mkdir(parents=True, exist_ok=True)
    _fr.write_text("report_status: complete\n", encoding="utf-8")
    _fv = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "improve",
            "verify",
            "imp-false",
            "--json",
        ],
        cwd=str(false_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "improve verify rejects a report containing only report_status: "
        "complete (false PASS closed)",
        '"code": "VALIDATION_FAILED"' in _fv.stdout,
        repr(_fv.stdout[:200]),
    )

    # ---- T-629: public submit boundary validates JSON shape before any
    # access -- array/scalar/null/non-string/empty/missing run_text all
    # refuse with a structured VALIDATION_FAILED and no traceback, surplus
    # args are rejected, and a valid payload still appends.
    _submit_root = project_fixture("saipen-submit-shape-")
    _submit_cycle = create_cycle(
        _submit_root,
        "imp-submit",
        created_at="2026-08-10T00:00:00Z",
        project_identity="probe-project",
    )
    register_seat(_submit_cycle, "seat-1", "core", "saipen_improve_A.md")
    _submit_report = create_report(
        _submit_root,
        "imp-submit",
        "seat-1",
        "A",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="probe scope",
    )
    _submit_payload = _submit_root / "findings.json"
    _submit_args = [
        sys.executable,
        str(HOME / "tools" / "saipen.py"),
        "improve",
        "submit",
        "imp-submit",
        "seat-1",
        "A",
        "--json",
    ]

    _submit_payload.write_text(
        json.dumps(
            {
                "run_text": "IMP-001 [P1] [LOGIC_ERROR] [proven] "
                "[ticket]\nexpected: x\nactual: y\n"
                "evidence: z\n"
            }
        ),
        encoding="utf-8",
    )
    _submit_positive = subprocess.run(
        [*_submit_args, str(_submit_payload)],
        cwd=str(_submit_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "submit with a valid string run_text appends a RUN",
        _submit_positive.returncode == 0
        and json.loads(_submit_positive.stdout).get("ok") is True
        and "Traceback" not in _submit_positive.stderr,
        repr((_submit_positive.stdout, _submit_positive.stderr)),
    )

    for _shape_label, _bad in [
        ("array", []),
        ("scalar", 42),
        ("null", None),
        ("string", "plain text"),
        ("run_text non-string", {"run_text": 7}),
        ("empty run_text", {"run_text": ""}),
        ("whitespace run_text", {"run_text": "   "}),
        ("missing run_text", {"other": 1}),
    ]:
        _submit_payload.write_text(json.dumps(_bad), encoding="utf-8")
        _submit_probe = subprocess.run(
            [*_submit_args, str(_submit_payload)],
            cwd=str(_submit_root),
            capture_output=True,
            text=True,
            timeout=60,
        )
        expect(
            f"submit refuses a {_shape_label} findings payload without traceback",
            _submit_probe.returncode != 0
            and '"code": "VALIDATION_FAILED"' in _submit_probe.stdout
            and "Traceback" not in _submit_probe.stderr,
            repr((_submit_probe.stdout, _submit_probe.stderr)),
        )
    _submit_payload.unlink()
    _submit_surplus = subprocess.run(
        [*_submit_args, str(_submit_payload), "extra"],
        cwd=str(_submit_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "submit rejects an unsupported surplus argument",
        _submit_surplus.returncode != 0
        and '"code": "VALIDATION_FAILED"' in _submit_surplus.stdout
        and "unsupported surplus argument" in _submit_surplus.stdout,
        repr(_submit_surplus.stdout),
    )

    # ---- DOGFOOD V (T-615): one disposition can never cover two findings
    # that share a local IMP number across RUNs; sweep-queue enumerates the
    # exact composite unswept findings; strict manifest + real fingerprint +
    # fake-fingerprint refusal through the public path.
    dg_root = project_fixture("saipen-dg5-")
    _dg_cycle, _dg_rep = mech_cycle(
        dg_root,
        "imp-dg5",
        "seat-1",
        "A",
        ["IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n"],
        ticket="T-900",
        findings_ok=False,
    )
    append_run(
        _dg_rep,
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n",
    )
    append_run(
        _dg_rep,
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: d\nactual: e\nevidence: f\n",
    )
    complete_report(_dg_rep)
    # sweep only RUN-1/IMP-001; RUN-2/IMP-001 must stay unswept.
    write_sweep_entry(
        _dg_cycle,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    st = derive_status(
        "saipen_improve_A.md",
        (_dg_cycle / "MANIFEST.md").read_text(encoding="utf-8-sig"),
        _dg_rep.read_text(encoding="utf-8"),
        (_dg_cycle / "SWEEP.md").read_text(encoding="utf-8"),
    )
    expect(
        "RUN-1/IMP-001 disposition never covers RUN-2/IMP-001 (composite identity)",
        "RUN-2/IMP-001" in st["missing"] and st["visible"] == "complete",
        repr((st["missing"], st["visible"])),
    )
    _qproc = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "improve",
            "sweep-queue",
            "imp-dg5",
            "--json",
        ],
        cwd=str(dg_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "high-level sweep enumerates the exact unswept composite finding",
        '"code": "IMPROVE_SWEEP_QUEUE"' in _qproc.stdout
        and "RUN-2/IMP-001" in _qproc.stdout
        and "RUN-1/IMP-001" not in _qproc.stdout,
        repr(_qproc.stdout[:300]),
    )
    _manifest = (_dg_cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
    expect(
        "strict manifest carries cycle_id/created_at/project_identity "
        "exactly once and round-trips the validator",
        validate_manifest(_manifest, expected_cycle_id="imp-dg5") == []
        and _manifest.count("manifest_schema: strict") == 1
        and _manifest.count("cycle_id: imp-dg5") == 1,
        repr(validate_manifest(_manifest, expected_cycle_id="imp-dg5")),
    )
    # fake fingerprint cannot claim fresh strict-cycle evidence.
    _fp_root = project_fixture("saipen-fakefp-")
    _fp_cycle, _fp_rep = mech_cycle(
        _fp_root,
        "imp-fakefp",
        "seat-1",
        "A",
        ["IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n"],
        ticket="T-900",
    )
    _fp_lines = _fp_rep.read_text(encoding="utf-8").splitlines()
    _fp_out = []
    for _line in _fp_lines:
        if _line.startswith("source_tree_fingerprint:"):
            _fp_out.append("source_tree_fingerprint: improve-cycle-9")
        else:
            _fp_out.append(_line)
    _fp_rep.write_text("\n".join(_fp_out) + "\n", encoding="utf-8")
    expect(
        "a fabricated friendly fingerprint fails the strict-cycle validator (DOGFOOD V)",
        validator_rc(_fp_root) != 0,
        repr(validator_rc(_fp_root)),
    )

    # ---- DOGFOOD V (T-615): write_sweep_entry refuses a nonexistent
    # run/finding and a CONFIRMED nonexistent ticket; INVALID never carries a
    # ticket.
    dgv_root = project_fixture("saipen-dgv-")
    _v_cycle, _v_rep = mech_cycle(
        dgv_root,
        "imp-dgv",
        "seat-1",
        "A",
        ["IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n"],
        ticket="T-900",
    )
    for _label, _entry in [
        (
            "nonexistent run refuses",
            {
                "run": "RUN-99",
                "imp_id": "001",
                "disposition": "CONFIRMED",
                "ticket": "T-900",
                "report": "saipen_improve_A.md",
                "reproduced": "y",
            },
        ),
        (
            "nonexistent finding refuses",
            {
                "run": "RUN-1",
                "imp_id": "999",
                "disposition": "CONFIRMED",
                "ticket": "T-900",
                "report": "saipen_improve_A.md",
                "reproduced": "y",
            },
        ),
        (
            "CONFIRMED nonexistent ticket cannot COMMIT",
            {
                "run": "RUN-1",
                "imp_id": "001",
                "disposition": "CONFIRMED",
                "ticket": "T-999999",
                "report": "saipen_improve_A.md",
                "reproduced": "y",
            },
        ),
        (
            "INVALID never authorizes a ticket",
            {
                "run": "RUN-1",
                "imp_id": "001",
                "disposition": "INVALID",
                "ticket": "T-900",
                "report": "saipen_improve_A.md",
                "reproduced": "n",
            },
        ),
    ]:
        try:
            write_sweep_entry(_v_cycle, _entry)
            _refused = False
        except ValueError:
            _refused = True
        expect(f"sweep authorization: {_label}", _refused)

    # ---- DOGFOOD V (T-615): source_reports resolves EXACT composite refs;
    # an unrelated cycle's IMP-001 never satisfies provenance; a bare ref
    # into a strict cycle fails.
    prov_root = project_fixture("saipen-prov-")
    _p_cycle, _p_rep = mech_cycle(
        prov_root,
        "imp-prov-a",
        "seat-a",
        "A",
        ["IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n"],
        ticket="T-900",
    )
    ticket_fixture(prov_root, "T-902")
    write_sweep_entry(
        _p_cycle,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    # good: T-900 cites the EXACT composite ref of imp-prov-a
    good_board = (prov_root / ".saipen" / "BOARD.md").read_text(encoding="utf-8-sig")
    good_board = good_board.replace(
        "| verify: probe",
        "| verify: probe | source_reports: imp-prov-a/seat-a/saipen_improve_A.md#RUN-1/IMP-001",
        1,
    )
    (prov_root / ".saipen" / "BOARD.md").write_text(good_board, encoding="utf-8")
    expect(
        "source_reports resolves an EXACT composite ref (validator green)",
        validator_rc(prov_root) == 0,
        repr(validator_rc(prov_root)),
    )
    # wrong-cycle: cite a ref naming a cycle that was never swept -- the same
    # local IMP number in another cycle must never satisfy provenance.
    bad_board = good_board.replace("imp-prov-a/seat-a", "imp-prov-b/seat-b")
    (prov_root / ".saipen" / "BOARD.md").write_text(bad_board, encoding="utf-8")
    expect(
        "an unrelated cycle's IMP-001 cannot satisfy ticket provenance (validator red)",
        validator_rc(prov_root) != 0,
        repr(validator_rc(prov_root)),
    )
    # bare ref into a strict cycle fails.
    bare_board = good_board.replace(
        " | source_reports: imp-prov-a/seat-a/saipen_improve_A.md#RUN-1/IMP-001",
        " | source_reports: IMP-001",
    )
    (prov_root / ".saipen" / "BOARD.md").write_text(bare_board, encoding="utf-8")
    expect(
        "a bare IMP ref can never launder a strict-cycle finding (validator red)",
        validator_rc(prov_root) != 0,
        repr(validator_rc(prov_root)),
    )

    # ---- DOGFOOD V (T-615): SWEEP writer/parser round-trip exact composite
    # identity (one structured record).
    from improve import SweepRecord, _sweep_records as _parse_records

    _sr = SweepRecord("RUN-1/IMP-001", "CONFIRMED", "T-900", "saipen_improve_A.md", "y", "-", "-")
    _rendered = _sr.render()
    _parsed = _parse_records("# SWEEP\n" + _rendered + "\n")
    expect(
        "SweepRecord writer/parser round-trip preserves exact identity",
        len(_parsed) == 1 and _parsed[0] == _sr,
        repr((_rendered, _parsed)),
    )

    # ---- DOGFOOD V (T-616): complete_report refuses an empty draft and a
    # strict cycle's report needs intentional RUN evidence (already covered);
    # append after completion refuses via the parser, not substring.
    imm2_root = project_fixture("saipen-imm2-")
    _i_cycle, _i_rep = mech_cycle(
        imm2_root,
        "imp-imm2",
        "seat-1",
        "A",
        ["IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n"],
        ticket="T-900",
    )
    _i_text = _i_rep.read_text(encoding="utf-8")
    _mention = _i_text.replace(
        "report_status: complete",
        "report_status: complete\n\n"
        "note: an earlier report said "
        "report_status: complete and was frozen",
    )
    try:
        append_run(_i_rep, "late after complete")
        _append_late = False
    except ValueError:
        _append_late = True
    expect(
        "append after completion refuses via the PARSER, not substring "
        "(an evidence mention of the phrase does not freeze a draft)",
        _append_late,
    )

    # ---- DOGFOOD V (T-616): NO_FINDINGS is intentional evidence, not
    # absence of output.
    nf_root = project_fixture("saipen-nf-")
    _nf_cycle = create_cycle(nf_root, "imp-nf")
    register_seat(_nf_cycle, "seat-1", "core", "saipen_improve_A.md")
    ticket_fixture(nf_root, "T-900")
    _nf_rep = create_report(
        nf_root,
        "imp-nf",
        "seat-1",
        "A",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    try:
        complete_report(_nf_rep)
        _empty_ok = False
    except ValueError:
        _empty_ok = True
    expect("an empty strict run without NO_FINDINGS cannot complete", _empty_ok)
    append_run(_nf_rep, "NO_FINDINGS\n")
    complete_report(_nf_rep)
    expect(
        "an explicit NO_FINDINGS run completes as intentional evidence",
        "report_status: complete" in _nf_rep.read_text(encoding="utf-8"),
    )
    # verify the completed NO_FINDINGS report passes the strict validator
    expect(
        "NO_FINDINGS report passes strict report validation",
        validate_report(_nf_rep.read_text(encoding="utf-8"), require_runs=True) == [],
        repr(validate_report(_nf_rep.read_text(encoding="utf-8"), require_runs=True)),
    )

    # ---- DOGFOOD V (SAICRITIC #4): source freshness at the gates (T-619),
    # status validation depth (T-620), mechanical abort (T-621).
    fs_root = project_fixture("saipen-fresh-")
    (fs_root / "src.txt").write_text("v1\n", encoding="utf-8")
    _fs_cycle, _fs_rep = mech_cycle(
        fs_root,
        "imp-fresh",
        "seat-1",
        "A",
        ["IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n"],
        ticket="T-900",
    )
    write_sweep_entry(
        _fs_cycle,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    (fs_root / "src.txt").write_text("v2\n", encoding="utf-8")
    _fsv = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "improve",
            "verify",
            "imp-fresh",
            "--json",
        ],
        cwd=str(fs_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "source freshness: verify refuses a fully-swept but STALE strict cycle (SAICRITIC #4)",
        '"code": "VALIDATION_FAILED"' in _fsv.stdout and "tree differs" in _fsv.stdout,
        repr(_fsv.stdout[:300]),
    )
    try:
        write_sweep_entry(
            _fs_cycle,
            {
                "run": "RUN-1",
                "imp_id": "001",
                "disposition": "CONFIRMED",
                "ticket": "T-900",
                "report": "saipen_improve_A.md",
                "reproduced": "y",
            },
        )
        _stale_sweep = False
    except ValueError:
        _stale_sweep = True
    expect(
        "source freshness: write_sweep_entry refuses CONFIRMED on stale evidence (SAICRITIC #4)",
        _stale_sweep,
    )
    (fs_root / "src.txt").write_text("v1\n", encoding="utf-8")
    _fp_text = _fs_rep.read_text(encoding="utf-8").splitlines()
    _fp_out = []
    for _line in _fp_text:
        if _line.startswith("source_tree_fingerprint:"):
            _fp_out.append("source_tree_fingerprint: fake-label")
        else:
            _fp_out.append(_line)
    _fs_rep.write_text("\n".join(_fp_out) + "\n", encoding="utf-8")
    _fss = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "improve", "status", "--json"],
        cwd=str(fs_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    _fss_data = json.loads(_fss.stdout)
    _fss_visible = _fss_data["cycles"][0]["seats"][0].get("visible")
    expect(
        "status depth: a fabricated fingerprint is INVALID_REPORT, never swept (SAICRITIC #4)",
        _fss_visible == "INVALID_REPORT",
        repr(_fss_visible),
    )

    # T-621 + P0 (T-632): mechanical abort rescues a stuck draft cycle, and
    # abort is crash-safe -- ONE journaled manifest write, no raw rename, no
    # report byte ever moved. The draft reports stay byte-identical at their
    # same path; the manifest's archived + cycle_aborted markers are the single
    # source of truth that they are non-authoritative.
    ab_root = project_fixture("saipen-abort-")
    (ab_root / "src.txt").write_text("v1\n", encoding="utf-8")
    _ab_cycle = create_cycle(ab_root, "imp-ab")
    register_seat(_ab_cycle, "seat-1", "core", "saipen_improve_A.md")
    _ab_rep = create_report(
        ab_root,
        "imp-ab",
        "seat-1",
        "A",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    append_run(
        _ab_rep,
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n",
    )
    # Make the report genuinely stuck by removing the evidence triple AFTER
    # the mechanical append -- a malformed finding can never complete, which
    # is exactly the stuck state abort exists to exit.
    _ab_rep.write_text(
        _ab_rep.read_text(encoding="utf-8-sig").replace("evidence: z", ""), encoding="utf-8"
    )
    try:
        complete_report(_ab_rep)
        _ab_stuck = False
    except ValueError:
        _ab_stuck = True
    expect("abort: an incomplete report is genuinely stuck (cannot complete)", _ab_stuck)
    _ab_bytes_before = _ab_rep.read_bytes()
    _abr = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "improve", "abort", "imp-ab", "--json"],
        cwd=str(ab_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    _ab_data = json.loads(_abr.stdout)
    _ab_ok = _ab_data.get("code") == "COMMITTED"
    expect(
        "abort: the stuck cycle aborts mechanically, reports byte-preserved "
        "at the same path, no .discarded split state",
        _ab_ok
        and _ab_rep.is_file()
        and _ab_rep.read_bytes() == _ab_bytes_before
        and not _ab_rep.with_name(_ab_rep.name + ".discarded").exists()
        and "cycle_aborted" in (_ab_cycle / "MANIFEST.md").read_text(encoding="utf-8")
        and "cycle_status: archived" in (_ab_cycle / "MANIFEST.md").read_text(encoding="utf-8"),
        repr(_abr.stdout[:300]),
    )
    _ab_cycle2 = create_cycle(ab_root, "imp-ab2")
    expect("abort: a new cycle is admitted after the abort", (_ab_cycle2 / "MANIFEST.md").is_file())

    # T-992/§8: IMPROVE.md's abort contract must match the writer -- drafts
    # preserved AT THE SAME PATH (never a .discarded rename).
    _abort_doc = (HOME / "saipen" / "IMPROVE.md").read_text(encoding="utf-8-sig")
    expect(
        "IMPROVE.md documents same-path abort preservation, never .discarded",
        "AT THEIR SAME PATH" in _abort_doc and ".discarded" not in _abort_doc,
        "IMPROVE.md abort contract drifted from the writer",
    )

    # T-1406: the canonical CLI exit -- `improve retire` flips ONE expected
    # seat to unavailable through the journaled roster write; the
    # never-completed report and every other report byte are preserved.
    _rt_root = project_fixture("saipen-retire-cli-")
    _rt_s1 = prepare_audit_seat(
        _rt_root,
        agent_family="probe",
        role="core",
        session_id="probe-rt-1",
        project_name="RTC",
        model_or_runtime="probe",
        context_scope="retire cli",
    )
    _rt_s2 = prepare_audit_seat(
        _rt_root,
        agent_family="probe",
        role="core",
        session_id="probe-rt-2",
        project_name="RTC",
        model_or_runtime="probe",
        context_scope="retire cli",
    )
    _rt_cycle = cycle_dir(_rt_root, _rt_s1["cycle_id"])
    _rt_rep1 = _rt_root / _rt_s1["report_path"]
    _rt_rep2 = _rt_root / _rt_s2["report_path"]
    append_run(_rt_rep2, "NO_FINDINGS")
    complete_report(_rt_rep2)
    _rt_bytes1 = _rt_rep1.read_bytes()
    _rt_bytes2 = _rt_rep2.read_bytes()
    _rt_proc = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "improve",
            "retire",
            _rt_s1["cycle_id"],
            _rt_s1["seat_id"],
            "--reason",
            "STALE_INSTALL",
            "--json",
        ],
        cwd=str(_rt_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    _rt_data = json.loads(_rt_proc.stdout)
    expect(
        "retire: the CLI flips one expected seat to unavailable and preserves "
        "both report bodies",
        _rt_data.get("code") == "SEAT_RETIRED"
        and _rt_data.get("availability") == "unavailable"
        and "availability: unavailable" in (_rt_cycle / "MANIFEST.md").read_text(encoding="utf-8")
        and _rt_rep1.read_bytes() == _rt_bytes1
        and _rt_rep2.read_bytes() == _rt_bytes2,
        repr(_rt_proc.stdout[:300]),
    )
    _rt_proc2 = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "improve",
            "retire",
            _rt_s1["cycle_id"],
            _rt_s2["seat_id"],
            "--reason",
            "WHY",
            "--json",
        ],
        cwd=str(_rt_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "retire: a completed seat's report is never retired",
        "is complete" in _rt_proc2.stdout and "never retired" in _rt_proc2.stdout,
        repr(_rt_proc2.stdout[:200]),
    )

    # ---- T-638 (P0): a known-INVALID base is never mutated. Every lifecycle
    # mutator must validate the manifest/report it consumes BEFORE writing --
    # abort/archive/complete on an invalid manifest, and append on a
    # malformed strict report, commit ZERO bytes.
    _ib_root = project_fixture("saipen-invalid-base-")
    _ib_cycle = create_cycle(
        _ib_root, "imp-ib", created_at="2026-08-12T00:00:00Z", project_identity="p"
    )
    register_seat(_ib_cycle, "seat-1", "core", "saipen_improve_A.md")
    _ib_rep = create_report(
        _ib_root,
        "imp-ib",
        "seat-1",
        "A",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    _ib_manifest = _ib_cycle / "MANIFEST.md"
    _ib_manifest_ok = _ib_manifest.read_text(encoding="utf-8-sig")
    _ib_manifest_bad = _ib_manifest_ok.replace("cycle_id: imp-ib", "cycle_id: WRONG")
    _ib_manifest.write_text(_ib_manifest_bad, encoding="utf-8")
    _ib_manifest_bytes = _ib_manifest.read_bytes()
    for _label, _call in [
        ("abort", lambda: abort_cycle(_ib_cycle)),
        ("complete", lambda: complete_cycle(_ib_cycle)),
        ("archive", lambda: archive_cycle(_ib_cycle)),
    ]:
        try:
            _call()
            _ib_refused = False
        except Exception:
            _ib_refused = True
        expect(
            f"invalid-manifest {_label} refuses with ZERO writes",
            _ib_refused and _ib_manifest.read_bytes() == _ib_manifest_bytes,
            "base mutated or not refused",
        )
    _ib_rep_bad = _ib_rep.read_text(encoding="utf-8-sig")
    _ib_rep_bad = _ib_rep_bad.replace("role: core", "role: critic\nrole: core", 1)
    _ib_rep.write_text(_ib_rep_bad, encoding="utf-8")
    _ib_rep_bytes = _ib_rep.read_bytes()
    try:
        append_run(_ib_rep, "NO_FINDINGS\n")
        _ib_append_refused = False
    except Exception:
        _ib_append_refused = True
    expect(
        "append_run on a malformed strict report refuses with ZERO writes",
        _ib_append_refused and _ib_rep.read_bytes() == _ib_rep_bytes,
        "malformed report was extended",
    )
    _ib_manifest.write_text(_ib_manifest_ok, encoding="utf-8")
    _ib_rep.write_text(
        _ib_rep.read_text(encoding="utf-8-sig").replace("role: critic\nrole: core", "role: core"),
        encoding="utf-8",
    )
    _ib_after_restore = True
    expect(
        "restored valid manifest + report still validate",
        validate_report(_ib_rep.read_text(encoding="utf-8-sig"), strict=True) == [],
        "restored report invalid",
    )

    # ---- T-638/§2 + §10: PROPOSED-state validation, mutator by mutator --
    # a known-invalid PROPOSED state never enters PREPARED/APPLY, never
    # leaves bytes, and no journal claims COMMITTED.
    _pc_root = project_fixture("saipen-proposed-")
    # create_cycle with invalid created_at: ZERO writes, no directory appears.
    _pc_owner = _pc_root / ".saipen" / "improve"
    try:
        create_cycle(_pc_root, "imp-bad-time", created_at="NOT-A-TIME", project_identity="p")
        _pc_time_refused = False
    except Exception:
        _pc_time_refused = True
    expect(
        "create_cycle invalid created_at refuses with ZERO writes (no manifest, no directory)",
        _pc_time_refused
        and not (_pc_owner / "imp-bad-time" / "MANIFEST.md").exists()
        and not (_pc_owner / "imp-bad-time").exists(),
        "invalid created_at left bytes behind",
    )
    try:
        create_cycle(
            _pc_root,
            "imp-bad-proj",
            created_at="2026-08-12T00:00:00Z",
            project_identity="V:/absolute/path",
        )
        _pc_proj_refused = False
    except Exception:
        _pc_proj_refused = True
    expect(
        "create_cycle non-portable project_identity refuses with ZERO writes",
        _pc_proj_refused and not (_pc_owner / "imp-bad-proj" / "MANIFEST.md").exists(),
        "invalid project_identity left bytes behind",
    )
    # write_sweep_entry on a malformed SWEEP base: ZERO writes.
    _pc_cycle = create_cycle(
        _pc_root, "imp-pc", created_at="2026-08-12T00:00:00Z", project_identity="p"
    )
    register_seat(_pc_cycle, "seat-1", "core", "saipen_improve_A.md")
    _pc_rep = create_report(
        _pc_root,
        "imp-pc",
        "seat-1",
        "A",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    append_run(
        _pc_rep,
        "IMP-001 [P1] [LOGIC_ERROR] [proven] [ticket]\nexpected: x\nactual: y\nevidence: z\n",
    )
    complete_report(_pc_rep)
    _pc_cycle_ticket = ticket_fixture(_pc_root, "T-900")
    (_pc_cycle / "SWEEP.md").write_text("# SWEEP\nTHIS IS GARBAGE\n", encoding="utf-8")
    _pc_sweep_bytes = (_pc_cycle / "SWEEP.md").read_bytes()
    try:
        write_sweep_entry(
            _pc_cycle,
            {
                "run": "RUN-1",
                "imp_id": "001",
                "disposition": "CONFIRMED",
                "ticket": "T-900",
                "report": "saipen_improve_A.md",
                "reproduced": "y",
            },
        )
        _pc_sweep_refused = False
    except Exception:
        _pc_sweep_refused = True
    expect(
        "write_sweep_entry on a malformed SWEEP ledger refuses with ZERO writes",
        _pc_sweep_refused and (_pc_cycle / "SWEEP.md").read_bytes() == _pc_sweep_bytes,
        "malformed SWEEP was extended",
    )
    # write_sweep_entry on a malformed COMPLETE report: ZERO sweep writes.
    (_pc_cycle / "SWEEP.md").write_text("# SWEEP\n", encoding="utf-8")
    _pc_rep_malformed = _pc_rep.read_text(encoding="utf-8-sig").replace(
        "role: core", "role: critic\nrole: core", 1
    )
    _pc_rep.write_text(_pc_rep_malformed, encoding="utf-8")
    _pc_sweep_bytes = (_pc_cycle / "SWEEP.md").read_bytes()
    try:
        write_sweep_entry(
            _pc_cycle,
            {
                "run": "RUN-1",
                "imp_id": "001",
                "disposition": "CONFIRMED",
                "ticket": "T-900",
                "report": "saipen_improve_A.md",
                "reproduced": "y",
            },
        )
        _pc_sweep_report_refused = False
    except Exception:
        _pc_sweep_report_refused = True
    expect(
        "write_sweep_entry on a malformed COMPLETE report refuses with ZERO writes",
        _pc_sweep_report_refused and (_pc_cycle / "SWEEP.md").read_bytes() == _pc_sweep_bytes,
        "malformed report's finding was swept",
    )
    _pc_rep.write_text(
        _pc_rep.read_text(encoding="utf-8-sig").replace("role: critic\nrole: core", "role: core"),
        encoding="utf-8",
    )
    # A valid full sweep, then complete_cycle -- the archive-corruption test
    # needs a genuinely COMPLETE+SWEPT cycle to corrupt.
    write_sweep_entry(
        _pc_cycle,
        {
            "run": "RUN-1",
            "imp_id": "001",
            "disposition": "CONFIRMED",
            "ticket": "T-900",
            "report": "saipen_improve_A.md",
            "reproduced": "y",
        },
    )
    complete_cycle(_pc_cycle)
    _pc_manifest_bytes = (_pc_cycle / "MANIFEST.md").read_bytes()
    _pc_corrupt_rep = _pc_rep.read_text(encoding="utf-8-sig").replace(
        "role: core", "role: critic\nrole: core", 1
    )
    _pc_rep.write_text(_pc_corrupt_rep, encoding="utf-8")
    try:
        archive_cycle(_pc_cycle)
        _pc_archive_refused = False
    except Exception:
        _pc_archive_refused = True
    expect(
        "archive of a corrupted COMPLETE cycle refuses with ZERO writes",
        _pc_archive_refused and (_pc_cycle / "MANIFEST.md").read_bytes() == _pc_manifest_bytes,
        "corrupted completed cycle was archived",
    )

    # P0 (T-632) crash-safety: a forced _journaled_write failure must leave no
    # split active-manifest/discarded-report state -- report bytes intact,
    # manifest still active, retry still possible.
    import saipen_engine.journal as _ab_journal_mod

    ab_crash_root = project_fixture("saipen-abort-crash-")
    (ab_crash_root / "src.txt").write_text("v1\n", encoding="utf-8")
    _abc_cycle = create_cycle(ab_crash_root, "imp-ab-crash")
    register_seat(_abc_cycle, "seat-1", "core", "saipen_improve_C.md")
    _abc_rep = create_report(
        ab_crash_root,
        "imp-ab-crash",
        "seat-1",
        "C",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    _abc_bytes = _abc_rep.read_bytes()

    def _fail_before_any_target(stage: str) -> None:
        raise OSError("forced abort write failure before first target")

    with mock.patch.object(_improve, "_journaled_write", side_effect=_fail_before_any_target):
        try:
            abort_cycle(_abc_cycle)
            _ab_failed = False
        except Exception:
            _ab_failed = True
    _abc_manifest_now = (_abc_cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
    expect(
        "abort failure before first target: no split state -- manifest "
        "still active, report byte-identical, no .discarded",
        _ab_failed
        and "cycle_status: active" in _abc_manifest_now
        and "cycle_aborted" not in _abc_manifest_now
        and _abc_rep.is_file()
        and _abc_rep.read_bytes() == _abc_bytes
        and not _abc_rep.with_name(_abc_rep.name + ".discarded").exists(),
        repr((_abc_manifest_now, _abc_rep.exists())),
    )

    # Crash after the journal writes the manifest target: recovery must roll
    # the operation forward (archived manifest, reports untouched) -- never
    # leave a half-aborted cycle.
    def _crash_after_manifest(stage: str) -> None:
        if stage == "manifest":
            raise SystemExit(91)

    with mock.patch.object(_ab_journal_mod, "_crash_after", side_effect=_crash_after_manifest):
        try:
            abort_cycle(_abc_cycle)
            _ab_crashed = False
        except SystemExit:
            _ab_crashed = True
    _ab_pending = pending_ops(ab_crash_root)
    expect(
        "abort crash after manifest write leaves one pending op",
        _ab_crashed and len(_ab_pending) == 1,
        repr((_ab_crashed, _ab_pending)),
    )
    _ab_recovered = recover(ab_crash_root, _ab_pending[0]["op_id"]) if _ab_pending else {}
    _abc_manifest_now = (_abc_cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
    expect(
        "abort crash recovery rolls forward: manifest archived, report "
        "byte-identical at same path, no split state",
        _ab_recovered.get("ok")
        and "cycle_status: archived" in _abc_manifest_now
        and "cycle_aborted" in _abc_manifest_now
        and _abc_rep.is_file()
        and _abc_rep.read_bytes() == _abc_bytes
        and not pending_ops(ab_crash_root),
        repr((_ab_recovered, _abc_manifest_now)),
    )
    # Already-applied retry after recovery is idempotent (refused: not active).
    try:
        abort_cycle(_abc_cycle)
        _ab_retry_refused = False
    except ImproveError:
        _ab_retry_refused = True
    expect(
        "abort retry after recovery refuses (cycle no longer active) with evidence untouched",
        _ab_retry_refused and _abc_rep.is_file() and _abc_rep.read_bytes() == _abc_bytes,
        repr(_abc_rep.exists()),
    )

    # External conflicting edit before recovery: recovery must refuse
    # CONFLICT and leave the report bytes intact.
    ab_conf_root = project_fixture("saipen-abort-conflict-")
    (ab_conf_root / "src.txt").write_text("v1\n", encoding="utf-8")
    _abcf_cycle = create_cycle(ab_conf_root, "imp-ab-conflict")
    register_seat(_abcf_cycle, "seat-1", "core", "saipen_improve_F.md")
    _abcf_rep = create_report(
        ab_conf_root,
        "imp-ab-conflict",
        "seat-1",
        "F",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    _abcf_bytes = _abcf_rep.read_bytes()
    with mock.patch.object(_ab_journal_mod, "_crash_after", side_effect=_crash_after_manifest):
        try:
            abort_cycle(_abcf_cycle)
            _abcf_crashed = False
        except SystemExit:
            _abcf_crashed = True
    _abcf_pending = pending_ops(ab_conf_root)
    # External edit to the manifest between crash and recovery.
    (_abcf_cycle / "MANIFEST.md").write_text(
        "cycle_status: active\ncycle_id: hijacked\n", encoding="utf-8"
    )
    _abcf_recovered = recover(ab_conf_root, _abcf_pending[0]["op_id"]) if _abcf_pending else {}
    expect(
        "abort recovery over an external conflicting manifest edit refuses "
        "CONFLICT and never touches report bytes",
        _abcf_crashed
        and not _abcf_recovered.get("ok")
        and _abcf_recovered.get("code") in ("CONFLICT", "RECOVERY_CONFLICT")
        and _abcf_rep.is_file()
        and _abcf_rep.read_bytes() == _abcf_bytes,
        repr((_abcf_crashed, _abcf_recovered)),
    )

    # ---- T-601: resolver race -- two processes resolving the same conflict
    # yield exactly one canonical settlement (WRITER_BUSY or a settled-journal
    # refusal for the loser, never two RESOLVED).
    from saipen_engine.journal import Journal as _RaceJournal, hash_bytes as _race_hb

    race_root = project_fixture("saipen-race-")
    saipen_r = race_root / ".saipen"
    # a DONE-state root so the external phase HUNT modification is real
    (saipen_r / "STATE.md").write_text(
        '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
        'blocker: ""\ntransition_from: SHIP\nsaipen_version: 7\n'
        'schema_version: 3\nlast_event: 900\n'
        'style_contract: ded-4ae736e4\n'
        f'saipen_home: "{HOME.resolve().as_posix()}"\nagent: probe\nmode: full\n'
        "updated: 2026-08-09T00:00:00Z\n---\n",
        encoding="utf-8",
    )
    log_r = (saipen_r / "LOG.md").read_bytes()
    state_r = (saipen_r / "STATE.md").read_bytes()
    new_log_r = log_r + b"\n- 09.08.26 00:01 [E-901] RUN: op\n"
    new_state_r = state_r.replace(b"phase: DONE", b"phase: BUILD")
    from saipen_engine.paths import runtime_lock_identity as _race_identity

    jr = _RaceJournal(race_root, "op-race")
    jr.start(
        "checkpoint",
        "probe",
        _race_identity(race_root),
        "h",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": new_log_r,
                "before_hash": _race_hb(log_r),
                "after_hash": _race_hb(new_log_r),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": new_state_r,
                "before_hash": _race_hb(state_r),
                "after_hash": _race_hb(new_state_r),
            },
        ],
        verification_policy="core_fast",
    )
    (saipen_r / "LOG.md").write_bytes(new_log_r)
    jr.mark("APPLYING", progress_index=1, target_index=0)
    ext_r = state_r.replace(b"phase: DONE", b"phase: HUNT").replace(
        b"last_event: 900", b"last_event: 901"
    )
    (saipen_r / "STATE.md").write_bytes(ext_r)
    recover(race_root, "op-race")
    race_code = (
        "import sys; sys.path.insert(0, r'%s')\n"
        "from saipen_engine.journal import resolve_conflict\n"
        "print(resolve_conflict(r'%s', 'op-race', 'accept_live', 'probe'))"
        % (str(HOME / "tools"), str(race_root))
    )
    procs = [
        subprocess.Popen(
            [sys.executable, "-c", race_code],
            cwd=str(race_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        for _ in range(2)
    ]
    outs = [p.communicate(timeout=90)[0] for p in procs]
    n_resolved = sum("'code': 'RESOLVED'" in o for o in outs)
    settled_status = _RaceJournal(race_root, "op-race").read().get("status")
    expect(
        "resolver race: exactly one process settles the conflict, the "
        "loser refuses (WRITER_BUSY or settled-journal refusal)",
        n_resolved == 1
        and settled_status == "RESOLVED"
        and all(
            ("'code': 'RESOLVED'" in o or "WRITER_BUSY" in o or "is RESOLVED, not CONFLICT" in o)
            for o in outs
        ),
        repr((n_resolved, settled_status, outs)),
    )

    return problems, checked


def run_nitro_probes() -> tuple[list[str], int]:
    """NITRO M1 (T-578): the shared mechanical parsers, snapshot, and the
    read-only saipen status/next commands.

    The parsers are the SAME implementation validate.py imports; these probes
    prove the engine consumes them correctly and that the snapshot detects a
    stale precondition.

    Hermetic (perf wave T-1022): every check -- including the stale-snapshot
    control that writes BOARD.md -- runs against a DISPOSABLE copy of the
    SAIPEN home, never the live checkout. The phase whitelist derives from
    the canonical ALL_PHASES enum (a hand-kept six-phase tuple drifted from
    the DFA once: MARKHUNT/VALIDATE/HUNT/CLEAN/TRANSLATE/PREPARE).
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if not ok:
            problems.append(f"{label}: {detail}")
        else:
            print(f"PASS: nitro -- {label}")

    root = Path(tempfile.mkdtemp(prefix="saipen-nitro-"))
    home = root / "home"
    shutil.copytree(
        HOME,
        home,
        ignore=shutil.ignore_patterns(
            ".git",
            ".freebuff",
            ".claude",
            "__pycache__",
            "*.pyc",
            ".pytest_cache",
            ".ruff_cache",
            "nul",
        ),
    )
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "probe",
        "GIT_AUTHOR_EMAIL": "probe@example.invalid",
        "GIT_COMMITTER_NAME": "probe",
        "GIT_COMMITTER_EMAIL": "probe@example.invalid",
    }
    subprocess.run(["git", "init", "-q"], cwd=home, env=env, capture_output=True, text=True)
    subprocess.run(["git", "add", "-A"], cwd=home, env=env, capture_output=True, text=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "probe"], cwd=home, env=env, capture_output=True, text=True
    )

    from saipen_engine.phases import ALL_PHASES

    state_text = (home / ".saipen" / "STATE.md").read_text(encoding="utf-8-sig")
    fields, err = parse_frontmatter(state_text)
    expect(
        "frontmatter parses the canonical STATE",
        err is None and fields.get("phase") in ALL_PHASES,
        repr((err, fields and fields.get("phase"))),
    )

    board_text = (home / ".saipen" / "BOARD.md").read_text(encoding="utf-8-sig")
    board = parse_board(board_text)
    expect(
        "board parser finds every canonical section",
        board["headings"] == ["## DOING", "## TODO", "## DONE", "## BLOCKED"],
        repr(board["headings"]),
    )
    doing = [t for t in board["tickets"].values() if t["section"] == "## DOING"]
    expect(
        "board parser enforces at-most-one claimed ticket with / checkbox",
        len(doing) <= 1 and all(t["checkbox"] == "/" for t in doing),
        repr([(t["id"], t["checkbox"]) for t in doing]),
    )

    log_line = "- 08.08.26 23:58 [E-2440] [parent: E-2439] [T-578] RUN: probe"
    ev = parse_log_line(log_line)
    expect(
        "log parser reads event, parent, ticket, taxonomy",
        ev is not None
        and ev["event"] == 2440
        and ev["parent"] == 2439
        and ev["ticket"] == "T-578"
        and ev["taxonomy"] == "RUN",
        repr(ev),
    )
    expect("log parser rejects a non-event line", parse_log_line("just prose") is None)

    snap = ProjectSnapshot.capture(home)
    expect(
        "snapshot carries hashes, log tail and head",
        snap.state_hash
        and snap.board_hash
        and snap.log_hash
        and snap.log_tail is not None
        and snap.head,
        repr((snap.log_tail, snap.head)),
    )
    expect("snapshot is not stale against the unchanged project", not snap.stale(home))
    board_path = home / ".saipen" / "BOARD.md"
    original = board_path.read_bytes()
    board_path.write_bytes(original + b"\n")
    expect("snapshot detects a changed board precondition", snap.stale(home))
    board_path.write_bytes(original)
    expect("snapshot is fresh again after restoring the board", not snap.stale(home))

    status = subprocess.run(
        [sys.executable, str(home / "tools" / "saipen.py"), "status"],
        cwd=home,
        capture_output=True,
        text=True,
    )
    expect(
        "saipen status is read-only and reports the phase",
        status.returncode == 0 and f"phase: {fields.get('phase')}" in status.stdout,
        repr(status.stdout[:120]),
    )
    nxt = subprocess.run(
        [sys.executable, str(home / "tools" / "saipen.py"), "next", "--json"],
        cwd=home,
        capture_output=True,
        text=True,
    )
    expect(
        "saipen next --json returns the action deterministically",
        nxt.returncode == 0 and '"action":' in nxt.stdout and '"load":' in nxt.stdout,
        repr(nxt.stdout[:120]),
    )

    shutil.rmtree(root, ignore_errors=True)
    return problems, checked


def run_nitro_m2_probes() -> tuple[list[str], int]:
    """NITRO M2 (T-579): OS single-writer lock + write-ahead journal +
    roll-forward recovery with crash injection at every commit boundary.

    A subprocess performs run_mutation with NITRO_CRASH_AFTER_<STAGE> set and
    dies (exit 87) exactly there; recovery must produce exactly one valid
    outcome and be idempotent. The LOG event is never deleted (roll-forward,
    not rollback).
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if not ok:
            problems.append(f"{label}: {detail}")
        else:
            print(f"PASS: nitro-m2 -- {label}")

    root = Path(tempfile.mkdtemp(prefix="saipen-m2-"))
    saipen = root / ".saipen"
    saipen.mkdir()
    log = saipen / "LOG.md"
    board = saipen / "BOARD.md"
    state = saipen / "STATE.md"
    log.write_text("- 09.08.26 00:00 [E-900] [T-none] DEC: base\n", encoding="utf-8")
    board.write_text("# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8")
    state.write_text(
        '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n---\n', encoding="utf-8"
    )

    log_before = log.read_bytes()
    board_before = board.read_bytes()
    state_before = state.read_bytes()

    def run_crash(stage_env: str, op_id: str) -> int:
        env = {**os.environ, stage_env: "1"}
        code = (
            "import sys; sys.path.insert(0, r'%s')\n"
            "from saipen_engine.journal import run_mutation\n"
            "run_mutation(r'%s', '%s', 'op', 'probe', 'id', 'hash', [\n"
            "  {'path': '.saipen/LOG.md', 'role': 'log', 'content': %r},\n"
            "  {'path': '.saipen/BOARD.md', 'role': 'board', 'content': %r},\n"
            "  {'path': '.saipen/STATE.md', 'role': 'state', 'content': %r}])"
            % (
                str(HOME / "tools"),
                str(root),
                op_id,
                log_before + b"\n- 09.08.26 00:01 [E-901] RUN: op\n",
                board_before,
                state_before.replace(b"phase: DONE", b"phase: BUILD"),
            )
        )
        return subprocess.run(
            [sys.executable, "-c", code],
            cwd=str(root),
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        ).returncode

    # Crash before LOG (NITRO_CRASH_AFTER_PREPARE): canonical state unchanged.
    rc = run_crash("NITRO_CRASH_AFTER_PREPARE", "op-prepare")
    expect(
        "crash before LOG leaves canonical state unchanged",
        rc == 87
        and log.read_bytes() == log_before
        and board.read_bytes() == board_before
        and state.read_bytes() == state_before,
        f"rc={rc}",
    )
    recover(root, "op-prepare")
    expect("PREPARED recovery aborts safely", log.read_bytes() == log_before)

    # Crash after LOG: LOG written, BOARD/STATE not; recover rolls forward.
    run_crash("NITRO_CRASH_AFTER_LOG", "op-log")
    expect(
        "crash after LOG leaves the LOG event and nothing else",
        b"E-901" in log.read_bytes()
        and board.read_bytes() == board_before
        and b"phase: BUILD" not in state.read_bytes(),
    )
    result = recover(root, "op-log")
    expect(
        "recovery rolls BOARD+STATE forward after LOG",
        result["ok"]
        and b"phase: BUILD" in state.read_bytes()
        and result.get("code") == "COMMITTED",
        repr(result),
    )
    again = recover(root, "op-log")
    expect(
        "repeated recovery is idempotent (ALREADY_APPLIED)",
        again["ok"] and again.get("code") == "ALREADY_APPLIED",
        repr(again),
    )
    expect(
        "the LOG event was not duplicated by recovery",
        log.read_text(encoding="utf-8").count("E-901") == 1,
    )

    # Crash after BOARD: LOG+BOARD written, STATE not; recover rolls STATE.
    log.write_bytes(log_before)
    board.write_bytes(board_before)
    state.write_bytes(state_before)
    run_crash("NITRO_CRASH_AFTER_BOARD", "op-board")
    expect("crash after BOARD leaves STATE unbuilt", b"phase: BUILD" not in state.read_bytes())
    result = recover(root, "op-board")
    expect(
        "recovery rolls STATE forward after BOARD",
        result["ok"]
        and b"phase: BUILD" in state.read_bytes()
        and result.get("code") == "COMMITTED",
        repr(result),
    )

    # Crash after STATE: all three written; recover validates and commits.
    log.write_bytes(log_before)
    board.write_bytes(board_before)
    state.write_bytes(state_before)
    run_crash("NITRO_CRASH_AFTER_STATE", "op-state")
    expect(
        "crash after STATE leaves the full mutation written",
        b"E-901" in log.read_bytes() and b"phase: BUILD" in state.read_bytes(),
    )
    result = recover(root, "op-state")
    expect(
        "recovery after STATE validates and commits",
        result["ok"] and result.get("code") == "COMMITTED",
        repr(result),
    )
    expect(
        "the crash-after-STATE op was not double-written by recovery",
        log.read_text(encoding="utf-8").count("E-901") == 1,
    )

    # A committed op's retry returns ALREADY_APPLIED without a second event.
    # The retry request must reproduce the record's semantic fingerprint
    # (operation, semantic_payload_hash, policy, per-target role + after_hash),
    # so it is built from the record's OWN targets and the live committed
    # bytes (which equal the planned after-state) -- a stale role/content
    # fixture would be an op_id collision, not a retry (perf wave T-1022).
    journal = Journal(root, "op-log")
    record = journal.read()
    retry_targets = [
        {"path": t["path"], "role": t["role"], "content": (root / t["path"]).read_bytes()}
        for t in record["targets"]
    ]
    result = run_mutation(
        root,
        "op-log",
        "op",
        "probe",
        "id",
        "hash",
        retry_targets,
        preconditions={"STATE.md": "x"},  # stale, must not matter when committed
        skip_preflight=True,
    )
    expect(
        "a committed op's retry returns ALREADY_APPLIED",
        result.get("code") == "ALREADY_APPLIED",
        repr(result),
    )
    expect(
        "no duplicate LOG event from a retried committed op",
        log.read_text(encoding="utf-8").count("E-901") == 1,
    )

    # Recovery conflict: a pending target mutated externally must CONFLICT
    # and preserve the external bytes (NITRO integrity R8).
    log.write_bytes(log_before)
    board.write_bytes(board_before)
    state.write_bytes(state_before)
    from saipen_engine.journal import hash_bytes
    from saipen_engine.paths import runtime_lock_identity

    op = "op-conflict"
    journal = Journal(root, op)
    # The receipt must be bound to THIS project's runtime identity, or the
    # strict legacy binding refuses with PROJECT_MISMATCH before recovery even
    # reaches the conflict (perf wave T-1022).
    journal.start(
        "op",
        "probe",
        runtime_lock_identity(root),
        "hash",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": log_before + b"\n- 09.08.26 00:01 [E-902] RUN: op\n",
                "before_hash": hash_bytes(log_before),
                "after_hash": "x",
            },
            {
                "path": ".saipen/BOARD.md",
                "role": "board",
                "content": board_before,
                "before_hash": hash_bytes(board_before),
                "after_hash": "y",
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": state_before.replace(b"phase: DONE", b"phase: BUILD"),
                "before_hash": hash_bytes(state_before),
                "after_hash": "z",
            },
        ],
    )
    (saipen / "LOG.md").write_bytes(log_before + b"\n- 09.08.26 00:01 [E-902] RUN: op\n")
    journal.mark("APPLYING", progress_index=1, target_index=0)
    external = board_before + b"\n# externally modified\n"
    (saipen / "BOARD.md").write_bytes(external)
    result = recover(root, op)
    expect(
        "recovery CONFLICTs on externally modified pending target",
        result.get("code") == RECOVERY_REFUSED
        and (saipen / "BOARD.md").read_bytes() == external,
        repr(result),
    )
    expect(
        "conflict preserves the journal for evidence",
        journal.exists() and journal.read()["status"] == "CONFLICT",
    )

    # Writer lock: second live writer refuses; release allows re-acquire.
    lock = WriterLock(root)
    lock.acquire()
    try:
        try:
            second = WriterLock(root)
            second.acquire()
            refused = False
        except PermissionError:
            refused = True
        expect("a second live writer is refused (WRITER_BUSY)", refused)
    finally:
        lock.release()
    reacquire = WriterLock(root)
    reacquire.acquire()
    reacquire.release()
    expect("the lock releases and re-acquires cleanly", True)

    return problems, checked


def run_nitro_m3_probes() -> tuple[list[str], int]:
    """NITRO M3 (T-580): claim as a journalled SAIOPS operation.

    PLAN writes zero canonical bytes; APPLY moves exactly one ticket, sets
    STATE to SCOUT/T-ID with the allocated event, and a second claim on the
    same ticket is refused.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if not ok:
            problems.append(f"{label}: {detail}")
        else:
            print(f"PASS: nitro-m3 -- {label}")

    def make_project() -> Path:
        """Create a fresh isolated project for testing."""
        r = Path(tempfile.mkdtemp(prefix="saipen-m3-goal-"))
        s = r / ".saipen"
        s.mkdir()
        history, last_event = probe_fixture_log(["T-1", "T-2"])
        (s / "LOG.md").write_text(history, encoding="utf-8")
        (s / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n"
            "- [ ] T-1 [P1] top probe | verify: probe\n"
            "- [ ] T-2 [P1] lower probe | verify: probe\n"
            "## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        # CORE-009: current-schema STATE requires absolute saipen_home.
        # Point to the actual SAIPEN install (HOME) which has BOOT.md and
        # extensions/subs/PROTOCOL.md -- the temp directory alone is not a
        # valid saipen home.
        (s / "STATE.md").write_text(
            '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
            'blocker: ""\ntransition_from: SHIP\nsaipen_version: 7\n'
            f"schema_version: 3\nlast_event: {last_event}\nstyle_contract: ded-4ae736e4\n"
            f'saipen_home: "{HOME.as_posix()}"\nagent: probe\nrequires:\n  - filesystem\n'
            "  - git\n  - python\nmode: full\nupdated: 2026-08-09T00:00:00Z\n"
            "---\n",
            encoding="utf-8",
        )
        return r

    root = Path(tempfile.mkdtemp(prefix="saipen-m3-"))
    saipen = root / ".saipen"
    saipen.mkdir()
    outer_history, outer_last_event = probe_fixture_log(["T-777"])
    (saipen / "LOG.md").write_text(outer_history, encoding="utf-8")
    (saipen / "BOARD.md").write_text(
        "# Board\n## DOING\n## TODO\n- [ ] T-777 [P1] probe ticket | "
        "verify: probe\n## DONE\n## BLOCKED\n",
        encoding="utf-8",
    )
    (saipen / "STATE.md").write_text(
        '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
        'blocker: ""\ntransition_from: SHIP\nsaipen_version: 7\n'
        f"schema_version: 3\nlast_event: {outer_last_event}\nstyle_contract: ded-4ae736e4\n"
        "agent: probe\nmode: full\nupdated: 2026-08-09T00:00:00Z\n---\n",
        encoding="utf-8",
    )

    board_before = (saipen / "BOARD.md").read_bytes()
    state_before = (saipen / "STATE.md").read_bytes()
    log_before = (saipen / "LOG.md").read_bytes()

    planned = plan_claim(root, "T-777", "probe")
    expect(
        "plan_claim returns a dry-run plan with no refusal",
        planned.get("ok") and planned.get("dry_run") and planned.get("code") == "CLAIMED",
        repr(planned),
    )
    expect(
        "plan writes zero canonical bytes",
        (saipen / "BOARD.md").read_bytes() == board_before
        and (saipen / "STATE.md").read_bytes() == state_before
        and (saipen / "LOG.md").read_bytes() == log_before,
    )

    result = apply_claim(root, "T-777", "probe")
    expect(
        "apply_claim commits the claim",
        result.get("ok") and result.get("code") == "CLAIMED",
        repr(result),
    )
    board_after = parse_board(codec.read_doc(saipen / "BOARD.md"))
    expect(
        "claim moves exactly one ticket to DOING with / checkbox",
        [t["id"] for t in board_after["tickets"].values() if t["section"] == "## DOING"]
        == ["T-777"]
        and board_after["tickets"]["T-777"]["checkbox"] == "/",
        repr(
            [
                (t["id"], t["checkbox"])
                for t in board_after["tickets"].values()
                if t["section"] == "## DOING"
            ]
        ),
    )
    state_after = parse_state(codec.read_doc(saipen / "STATE.md"))
    expect(
        "claim sets STATE to SCOUT/T-777 with a new event",
        state_after.get("phase") == "SCOUT"
        and state_after.get("task") == "T-777"
        # Derived from the fixture, not hardcoded: the history now carries the
        # allocation events CORE-003 requires, so "the next event" is one past
        # whatever the fixture ends on rather than a fixed 901 (T-1361 CL-05).
        and state_after.get("last_event") == outer_last_event + 1,
        repr((state_after.get("phase"), state_after.get("task"), state_after.get("last_event"))),
    )
    log_text = codec.read_doc(saipen / "LOG.md")
    expect(
        "claim appends exactly one LOG event with a real taxonomy",
        log_text.count(f"E-{outer_last_event + 1}") == 1 and "DEC:" in log_text,
        repr(log_text[-120:]),
    )

    again = apply_claim(root, "T-777", "probe")
    expect(
        "a same-agent re-claim refreshes the lease in place (no duplicate)",
        again.get("ok")
        and again.get("code") == "CLAIMED"
        and again.get("refresh") is True
        and again.get("changed_files") == [".saipen/BOARD.md"],
        repr(again),
    )
    foreign = apply_claim(root, "T-777", "other")
    expect(
        "a live foreign claim cannot be taken over (TICKET_NOT_WORKABLE)",
        not foreign.get("ok") and foreign.get("code") == "TICKET_NOT_WORKABLE",
        repr(foreign),
    )

    # Transition: SCOUT -> BUILD legal and journalled; illegal refused; dry-run
    # writes nothing.
    state_before = (saipen / "STATE.md").read_bytes()
    log_before = (saipen / "LOG.md").read_bytes()
    illegal = transition_phase(root, "REVIEW", "probe", "T-777")
    expect(
        "an illegal transition is refused with ILLEGAL_TRANSITION",
        not illegal.get("ok") and illegal.get("code") == "ILLEGAL_TRANSITION",
        repr(illegal),
    )
    plan = transition_phase(root, "BUILD", "probe", "T-777", "building", dry_run=True)
    expect(
        "transition dry-run writes zero canonical bytes",
        plan.get("ok")
        and plan.get("dry_run")
        and (saipen / "STATE.md").read_bytes() == state_before
        and (saipen / "LOG.md").read_bytes() == log_before,
        repr(plan),
    )
    result = transition_phase(root, "BUILD", "probe", "T-777", "building")
    expect(
        "SCOUT->BUILD transition commits with a new event",
        result.get("ok")
        and result.get("code") == "TRANSITIONED"
        and parse_state(codec.read_doc(saipen / "STATE.md")).get("phase") == "BUILD",
        repr(result),
    )

    # Checkpoint: allocates exactly one event, bumps last_event.
    log_before = (saipen / "LOG.md").read_bytes()
    state_before = (saipen / "STATE.md").read_bytes()
    cp = checkpoint(root, "probe", "RUN", "T-777", "probe checkpoint")
    log_after = codec.read_doc(saipen / "LOG.md")
    expect(
        "checkpoint appends exactly one event with an allocated E-ID",
        cp.get("ok")
        and cp.get("code") == "CHECKPOINTED"
        and log_after.count(cp.get("event_id", "E-0")) == 1,
        repr(cp),
    )
    expect(
        "checkpoint bumps STATE last_event to the new event",
        parse_state(codec.read_doc(saipen / "STATE.md")).get("last_event")
        == int(cp.get("event_id", "E-0")[2:]),
        repr(cp),
    )

    # Ticket lifecycle: canonical ID allocation reads STRUCTURED records only
    # (T-639/§9) -- prose that mentions T-NNN is not identity, canonical
    # ticket lines are.
    tid = next_ticket_id(
        "# Board\n## DOING\n## TODO\n- [ ] T-901 probe\n## DONE\n## BLOCKED\n"
        "note: synthetic T-900000 fixture mentioned in prose\n",
        "- 09.08.26 00:00 [E-1] [T-901] RUN: base\n",
    )
    expect("next_ticket_id ignores prose T-NNN mentions (structured-only)", tid == 902, repr(tid))
    tid_log = next_ticket_id(
        "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n",
        "- 09.08.26 00:00 [E-1] RUN: shipped T-800 in message prose\n",
    )
    expect("next_ticket_id ignores LOG prose T-NNN mentions", tid_log == 1, repr(tid_log))
    added = ticket_add(root, "probe", "P2", "probe ticket", [], "verify", dry_run=False)
    expect(
        "ticket_add creates a canonical ticket",
        added.get("ok") and added.get("code") == "TICKET_ADDED" and added.get("ticket") == "T-778",
        repr(added),
    )

    # Legal lifecycle: done accepts ONLY ## DOING. A TODO ticket cannot skip
    # claim/work (NITRO integrity R5) -- the old probe encoded the bug as PASS.
    todo_done = ticket_move(root, "done", "T-778", "probe")
    expect(
        "done on a TODO ticket is refused (IL_LEGAL_TICKET_LIFECYCLE)",
        not todo_done.get("ok") and todo_done.get("code") == "ILLEGAL_TICKET_LIFECYCLE",
        repr(todo_done),
    )
    expect(
        "refused done writes zero canonical bytes",
        parse_board(codec.read_doc(saipen / "BOARD.md"))["tickets"]["T-778"]["section"]
        == "## TODO",
    )

    # Finish the active T-777 through the legal lifecycle: done is the atomic
    # finish operation (NITRO dogfood III) requiring DOING + [/] + STATE.task
    # binding, and under the T-602 gate it requires the full phase chain to
    # have reached SHIP; it closes LOG+BOARD+STATE in one plan and reports
    # FINISHED.
    transition_phase(root, "VERIFY", "probe", "T-777", "verify")
    # VERIFY -> REVIEW requires current-cycle verification evidence: a RUN
    # PASS after the machine-owned VERIFY marker (T-1014). Without it REVIEW
    # refuses INCOMPLETE_TICKET and the whole chain stalls at VERIFY.
    checkpoint(root, "probe", "RUN", "T-777", "probe suite T-777 -> PASS conf: high")
    transition_phase(root, "REVIEW", "probe", "T-777", "review")
    transition_phase(root, "SHIP", "probe", "T-777", "ship")
    done = ticket_move(root, "done", "T-777", "probe")
    expect(
        "done on the active DOING ticket succeeds and moves it to DONE",
        done.get("ok")
        and done.get("code") == "FINISHED"
        and parse_board(codec.read_doc(saipen / "BOARD.md"))["tickets"]["T-777"]["section"]
        == "## DONE"
        and parse_state(codec.read_doc(saipen / "STATE.md")).get("phase") == "DONE",
        repr(done),
    )

    # Claim the now-topmost T-778, then finish it legally (full chain).
    claimed2 = apply_claim(root, "T-778", "probe")
    expect(
        "claim of the topmost workable ticket succeeds",
        claimed2.get("ok") and claimed2.get("code") == "CLAIMED",
        repr(claimed2),
    )
    transition_phase(root, "BUILD", "probe", "T-778", "b")
    transition_phase(root, "VERIFY", "probe", "T-778", "v")
    checkpoint(root, "probe", "RUN", "T-778", "probe suite T-778 -> PASS conf: high")
    transition_phase(root, "REVIEW", "probe", "T-778", "r")
    transition_phase(root, "SHIP", "probe", "T-778", "s")
    done2 = ticket_move(root, "done", "T-778", "probe")
    expect(
        "legal DOING->DONE lifecycle succeeds",
        done2.get("ok") and done2.get("code") == "FINISHED",
        repr(done2),
    )

    # M5: goal/cc mechanics. reauthorize refuses without a tripped valve.
    refused = reauthorize_valve(root, "probe")
    expect(
        "reauthorize_valve refuses a valve that has not tripped",
        not refused.get("ok") and refused.get("code") == "VALIDATION_FAILED",
        repr(refused),
    )
    phase_before_goal = parse_state(codec.read_doc(saipen / "STATE.md")).get("phase")
    goal = set_goal_intent(root, "probe", "M5 probe")
    state_after_goal = parse_state(codec.read_doc(saipen / "STATE.md"))
    expect(
        "set_goal_intent pivots to goal with counters from 0",
        goal.get("ok")
        and goal.get("code") == "GOAL_SET"
        and state_after_goal.get("execution_intent") == "goal"
        and state_after_goal.get("goal_waves") == 0,
        repr(goal),
    )
    expect(
        "set_goal_intent preserves phase/task (not a claim)",
        state_after_goal.get("phase") == phase_before_goal,
        repr((phase_before_goal, state_after_goal.get("phase"))),
    )
    stop = stop_checkpoint(root, "probe", "probe stop")
    expect(
        "stop_checkpoint writes a resumable next_action",
        stop.get("ok")
        and stop.get("code") == "STOPPED"
        and parse_state(codec.read_doc(saipen / "STATE.md")).get("next_action"),
        repr(stop),
    )

    # ---- T-1100: goal_entry regression ----
    # goal_entry demotes an active DOING ticket to TODO, sets goal intent,
    # clears task, and logs the pivot.
    ge_root = make_project()
    ge_saipen = ge_root / ".saipen"
    # Setup: claim T-1 and advance to BUILD so there's an active DOING ticket
    apply_claim(ge_root, "T-1", "probe")
    transition_phase(ge_root, "BUILD", "probe", "T-1", "b")
    ge_state_before = parse_state(codec.read_doc(ge_saipen / "STATE.md"))
    expect(
        "goal_entry precondition: active DOING ticket T-1 at BUILD",
        ge_state_before.get("task") == "T-1" and ge_state_before.get("phase") == "BUILD",
        repr(ge_state_before),
    )
    ge_result = goal_entry(ge_root, "probe", "T-1100 goal entry test")
    ge_state_after = parse_state(codec.read_doc(ge_saipen / "STATE.md"))
    ge_board = parse_board(codec.read_doc(ge_saipen / "BOARD.md"))
    expect(
        "goal_entry succeeds with GOAL_SET",
        ge_result.get("ok") and ge_result.get("code") == "GOAL_SET",
        repr(ge_result),
    )
    expect(
        "goal_entry sets execution_intent to goal",
        ge_state_after.get("execution_intent") == "goal"
        and ge_state_after.get("goal_waves") == 1
        and ge_state_after.get("goal_tickets") == 0,
        repr(ge_state_after),
    )
    expect(
        "goal_entry sets task to first plan ticket",
        ge_state_after.get("task") is not None
        and ge_state_after.get("task") != "none"
        and ge_state_after.get("task").startswith("T-"),
        repr(ge_state_after.get("task")),
    )
    expect(
        "goal_entry demotes active DOING ticket to TODO",
        ge_board["tickets"]["T-1"]["section"] == "## TODO"
        and ge_board["tickets"]["T-1"]["checkbox"] == " ",
        repr(ge_board["tickets"]["T-1"]),
    )
    ge_log = codec.read_doc(ge_saipen / "LOG.md")
    expect(
        "goal_entry logs a pivot DEC event",
        "goal pivot" in ge_log and "T-1100 goal entry test" in ge_log,
        repr(ge_log[-200:]),
    )
    expect(
        "goal_entry logs the recoverable Entry PLAN wave bump",
        "DEC: goal_waves 0->1" in ge_log,
        repr(ge_log[-300:]),
    )

    # ---- T-1100: goal_entry cold-start resume ----
    # After goal_entry, routing should find the next workable ticket
    # (cold-start into the NEW objective, not the old one).
    ge_routed = route_next(
        codec.read_doc(ge_saipen / "STATE.md"),
        codec.read_doc(ge_saipen / "BOARD.md"),
    )
    expect(
        "goal_entry cold-start routes to the plan ticket",
        ge_routed.get("ok") and ge_routed.get("ticket") is not None,
        repr(ge_routed),
    )

    # ---- T-1100: goal_entry with no active ticket ----
    # When there's no active DOING ticket, goal_entry just sets intent
    ge_empty = make_project()
    ge_empty_saipen = ge_empty / ".saipen"
    # Move T-1 to DONE so board has no DOING
    apply_claim(ge_empty, "T-1", "probe")
    transition_phase(ge_empty, "BUILD", "probe", "T-1", "b")
    transition_phase(ge_empty, "VERIFY", "probe", "T-1", "v")
    # Verification evidence required for VERIFY->REVIEW
    checkpoint(ge_empty, "probe", "RUN", "T-1", "suite T-1 -> PASS conf: high")
    transition_phase(ge_empty, "REVIEW", "probe", "T-1", "r")
    transition_phase(ge_empty, "SHIP", "probe", "T-1", "s")
    ticket_move(ge_empty, "done", "T-1", "probe")
    ge_empty_state = parse_state(codec.read_doc(ge_empty_saipen / "STATE.md"))
    expect(
        "no-active precondition: task is none",
        ge_empty_state.get("task") == "none",
        repr(ge_empty_state),
    )
    ge_empty_result = goal_entry(ge_empty, "probe", "empty board goal")
    ge_empty_after = parse_state(codec.read_doc(ge_empty_saipen / "STATE.md"))
    expect(
        "goal_entry with no active ticket still sets goal intent",
        ge_empty_result.get("ok")
        and ge_empty_after.get("execution_intent") == "goal"
        and ge_empty_after.get("goal_waves") == 1,
        repr(ge_empty_after),
    )

    # ---- T-1100: goal_entry credential redaction ----
    ge_cred = make_project()
    goal_entry(
        ge_cred,
        "probe",
        "fix the ghp_abcdefghijklmnopqrstuvwxyz0123456789ab token leak",
    )
    ge_cred_log = codec.read_doc(ge_cred / ".saipen" / "LOG.md")
    expect(
        "goal_entry redacts ghp_ credentials in LOG",
        "ghp_***" in ge_cred_log and "ghp_abcdefgh" not in ge_cred_log,
        repr(ge_cred_log[-200:]),
    )

    return problems, checked


def run_nitro_integrity_probes() -> tuple[list[str], int]:
    """NITRO integrity sweep red controls (T-584, audit R1..R12 + core).

    These are BEHAVIORAL controls against the repaired engine, not proxy
    assertions: each one creates the exact bad condition and demands the
    repaired refusal/behaviour. A control goes red when the engine regresses.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if not ok:
            problems.append(f"{label}: {detail}")
        else:
            print(f"PASS: nitro-integrity -- {label}")

    def make_project() -> Path:
        root = Path(tempfile.mkdtemp(prefix="saipen-integrity-"))
        saipen = root / ".saipen"
        saipen.mkdir()
        # T-1 and T-2 are written straight into BOARD below, so they need the
        # allocation events their identity now comes from (CORE-003 /
        # SRC-026:R003, b2343541). Without them `core_fast` refuses EVERY
        # mutation on this board, and the probe that used the refusal's result
        # raised KeyError -- which aborted the suite rather than failing one
        # check, hiding every scenario after it.
        (saipen / "LOG.md").write_text(
            "- 09.08.26 00:00 [E-898] [T-1] [agent: probe] [op: ticket-fixture] "
            "DEC: ticket added via SAIOPS\n"
            "- 09.08.26 00:00 [E-899] [T-2] [agent: probe] [op: ticket-fixture] "
            "DEC: ticket added via SAIOPS\n"
            "- 09.08.26 00:00 [E-900] [T-none] DEC: base\n",
            encoding="utf-8",
        )
        (saipen / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n"
            "- [ ] T-1 [P1] top probe | verify: probe\n"
            "- [ ] T-2 [P1] lower probe | verify: probe\n"
            "## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        # CORE-009: current-schema STATE requires absolute saipen_home.
        # Point to the actual SAIPEN install (HOME) which has BOOT.md.
        (saipen / "STATE.md").write_text(
            '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
            'blocker: ""\ntransition_from: SHIP\nsaipen_version: 7\n'
            "schema_version: 3\nlast_event: 900\nstyle_contract: ded-4ae736e4\n"
            f'saipen_home: "{HOME.as_posix()}"\nagent: probe\nrequires:\n  - filesystem\n'
            "  - git\n  - python\nmode: full\nupdated: 2026-08-09T00:00:00Z\n"
            "---\n",
            encoding="utf-8",
        )
        return root

    def project_tree(root: Path) -> dict[str, bytes]:
        out = {}
        for path in sorted((root / ".saipen").rglob("*")):
            if path.is_file():
                out[path.relative_to(root).as_posix()] = path.read_bytes()
        return out

    def verify_pass(root: Path, ticket: str = "T-1") -> None:
        """Record the RUN evidence the VERIFY -> REVIEW edge requires.

        `log.verification_evidence` refuses that edge without a current-cycle
        PASS for the ticket, so a probe chain walking BUILD -> VERIFY ->
        REVIEW must write the same evidence a real run writes. Without it the
        whole chain silently stalls at VERIFY and every control after it
        measures the wrong state.
        """
        checkpoint(root, "probe", "RUN", ticket, f"probe suite {ticket} -> PASS conf: high")

    def verify_cycle(root: Path, ticket: str = "T-1") -> None:
        """Write a COMPLETE verification cycle without leaving the phase.

        `verify_pass` relies on a real VERIFY transition to have written the
        machine-owned entry marker. A control that must stay in another
        phase records the marker and the PASS as plain checkpoints, which
        preserve phase/task, so the evidence exists without the transition.
        """
        checkpoint(root, "probe", "RUN", ticket, "transition to VERIFY")
        verify_pass(root, ticket)

    # Import floor: every shipped engine module imports in isolation.
    from saipen_engine import (
        codec,
        fast_check,  # noqa: F401
        subs,
    )

    expect("every shipped saipen_engine module imports in isolation", True)

    # ---- R1/R2: checkpoint and ticket_add preserve phase/task.
    root = make_project()
    _snap = project_tree(root)
    root2 = make_project()
    apply_claim(root2, "T-1", "probe")
    transition_phase(root2, "BUILD", "probe", "T-1", "integrity setup")
    st = parse_state(codec.read_doc(root2 / ".saipen" / "STATE.md"))
    cp = checkpoint(root2, "probe", "RUN", "T-1", "integrity checkpoint")
    st = parse_state(codec.read_doc(root2 / ".saipen" / "STATE.md"))
    expect(
        "checkpoint preserves phase (no SCOUT rewrite)",
        cp.get("ok") and st.get("phase") == "BUILD",
        repr(st),
    )
    expect("checkpoint preserves task", cp.get("ok") and st.get("task") == "T-1", repr(st))
    expect(
        "checkpoint preserves next_action",
        cp.get("ok") and st.get("next_action") == "PHASE BUILD T-1",
        repr(st),
    )
    add = ticket_add(root2, "probe", "P2", "future", [], "verify")
    st = parse_state(codec.read_doc(root2 / ".saipen" / "STATE.md"))
    expect(
        "ticket_add preserves execution phase",
        add.get("ok") and st.get("phase") == "BUILD",
        repr(st),
    )

    # ---- R6: dry-run writes zero bytes.
    before = project_tree(root)
    claim_plan = plan_claim(root, "T-1", "probe")
    after = project_tree(root)
    expect(
        "plan_claim dry-run writes zero canonical bytes",
        claim_plan.get("ok") and claim_plan.get("dry_run") and before == after,
        f"changed={set(before) ^ set(after)}",
    )
    cp_plan = checkpoint(root, "probe", "RUN", "T-1", "dry", dry_run=True)
    after2 = project_tree(root)
    expect(
        "checkpoint dry-run writes zero bytes",
        cp_plan.get("ok") and cp_plan.get("dry_run") and after == after2,
        repr(cp_plan.to_dict()),
    )

    # ---- Pick Rule: claiming the lower ticket refuses.
    lower = plan_claim(root, "T-2", "probe")
    expect(
        "normal claim of a non-top workable ticket refuses (NOT_TOP_WORKABLE)",
        not lower.get("ok") and lower.get("code") == "NOT_TOP_WORKABLE",
        repr(lower),
    )
    top = apply_claim(root, "T-1", "probe")
    expect(
        "claim of the topmost workable ticket succeeds",
        top.get("ok") and top.get("code") == "CLAIMED",
        repr(top),
    )

    # ---- T-631: blocker is an authorization boundary, even on malformed
    # TODO input that a caller passes without running the full validator.
    from saipen_engine.router import route_next as _blocker_route_next

    blocker_root = make_project()
    blocker_board = blocker_root / ".saipen" / "BOARD.md"
    blocker_board.write_text(
        blocker_board.read_text(encoding="utf-8").replace(
            "T-1 [P1] top probe | verify: probe",
            "T-1 [P1] top probe | blocker: WAIT_USER_CONFIRMATION | verify: probe",
        ),
        encoding="utf-8",
    )
    blocker_before = project_tree(blocker_root)
    blocker_normal = apply_claim(blocker_root, "T-1", "probe")
    blocker_explicit = apply_claim(blocker_root, "T-1", "probe", explicit=True)
    expect(
        "normal claim refuses a TODO ticket carrying blocker",
        blocker_normal.get("code") == "TICKET_NOT_WORKABLE",
        repr(blocker_normal),
    )
    expect(
        "explicit claim cannot override blocker authorization",
        blocker_explicit.get("code") == "TICKET_NOT_WORKABLE",
        repr(blocker_explicit),
    )
    expect(
        "refused normal and explicit blocker claims write zero bytes",
        blocker_before == project_tree(blocker_root),
    )
    blocker_state = codec.read_doc(blocker_root / ".saipen" / "STATE.md")
    blocker_text = codec.read_doc(blocker_board)
    blocker_route = _blocker_route_next(blocker_state, blocker_text)
    expect(
        "router skips malformed TODO+blocker and never emits SCOUT for it",
        blocker_route.get("action") == "PHASE SCOUT T-2",
        repr(blocker_route),
    )

    blocker_status = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "status", "--json"],
        cwd=str(blocker_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    blocker_status_data = json.loads(blocker_status.stdout)
    expect(
        "public status refuses structurally invalid TODO+blocker state",
        blocker_status_data.get("ok") is False
        and blocker_status_data.get("code") == "VALIDATION_FAILED",
        repr(blocker_status_data),
    )
    blocker_next = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "next", "--json"],
        cwd=str(blocker_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    blocker_next_data = json.loads(blocker_next.stdout)
    expect(
        "public next refuses structurally invalid TODO+blocker state",
        blocker_next_data.get("ok") is False
        and blocker_next_data.get("code") == "VALIDATION_FAILED"
        and blocker_next_data.get("action") != "PHASE SCOUT T-1",
        repr(blocker_next_data),
    )

    # Hypothetical T-624/T-625 completion cannot make a human gate executable.
    gated_root = make_project()
    (gated_root / ".saipen" / "BOARD.md").write_text(
        "# Board\n## DOING\n## TODO\n"
        "- [ ] T-3 [P3] human decision | needs: T-1,T-2 | "
        "blocker: WAIT_USER_CONFIRMATION | verify: human decision\n"
        "## DONE\n"
        "- [x] T-1 [P1] prerequisite one | verify: done\n"
        "- [x] T-2 [P1] prerequisite two | verify: done\n"
        "## BLOCKED\n",
        encoding="utf-8",
    )
    gated_route = _blocker_route_next(
        codec.read_doc(gated_root / ".saipen" / "STATE.md"),
        codec.read_doc(gated_root / ".saipen" / "BOARD.md"),
    )
    gated_claim = apply_claim(gated_root, "T-3", "probe", explicit=True)
    expect(
        "satisfied prerequisites never activate a human-decision blocker",
        gated_route.get("action") != "PHASE SCOUT T-3"
        and gated_claim.get("code") == "TICKET_NOT_WORKABLE",
        repr((gated_route, gated_claim)),
    )

    # Mutation: restore old Pick Rule by ignoring blocker. Forbidden ticket is
    # immediately routed, proving the controls are coupled to blocker defense.
    # The predicate moved to `board` when CORE-003 gave the Pick Rule one home
    # (`board.pick_next_work`), and the router stopped importing it. Patching
    # the old name raised AttributeError, which is not a probe failure but an
    # abort: every scenario after this line stopped running, and the suite
    # reported one opaque nonzero exit. Patch where the decision lives.
    with mock.patch(
        "saipen_engine.board.ticket_is_workable",
        side_effect=lambda ticket, tickets, agent=None, now=None: (
            ticket.get("section") == "## TODO"
            and all(
                tickets.get(need, {}).get("section") == "## DONE"
                for need in ticket.get("needs", [])
            )
        ),
    ):
        mutated_route = _blocker_route_next(blocker_state, blocker_text)
    expect(
        "mutation ignoring blocker makes Pick Rule route forbidden ticket",
        mutated_route.get("action") == "PHASE SCOUT T-1",
        repr(mutated_route),
    )

    # ---- R4: transition cannot switch ticket identity / fake ticket.
    fake = transition_phase(root, "BUILD", "probe", "T-999", "fake")
    expect(
        "transition with a nonexistent ticket refuses",
        not fake.get("ok") and fake.get("code") == "TICKET_NOT_FOUND",
        repr(fake),
    )
    swapped = transition_phase(root, "BUILD", "probe", "T-2", "swap")
    expect(
        "transition with a non-active ticket refuses (ACTIVE_TICKET_MISMATCH)",
        not swapped.get("ok") and swapped.get("code") == "ACTIVE_TICKET_MISMATCH",
        repr(swapped),
    )
    ok_tr = transition_phase(root, "BUILD", "probe", "T-1", "build")
    st = parse_state(codec.read_doc(root / ".saipen" / "STATE.md"))
    expect(
        "transition binds the exact active DOING ticket",
        ok_tr.get("ok") and st.get("phase") == "BUILD" and st.get("task") == "T-1",
        repr(st),
    )

    # ---- R5: legal lifecycle only. Block the active ticket, then unblock.
    active_board = root / ".saipen" / "BOARD.md"
    active_board.write_text(
        active_board.read_text(encoding="utf-8").replace(
            " | owner: probe", " | verify_attempts: 1 | owner: probe", 1
        ),
        encoding="utf-8",
    )
    blocked = ticket_move(root, "block", "T-1", "probe", "blocked now")
    blocked_ticket = parse_board(codec.read_doc(active_board))["tickets"]["T-1"]
    blocked_state = parse_state(codec.read_doc(root / ".saipen" / "STATE.md"))
    expect(
        "block of an active DOING ticket succeeds",
        blocked.get("ok")
        and blocked.get("code") == "BLOCK"
        and blocked_ticket["section"] == "## BLOCKED"
        and blocked_ticket["fields"].get("blocker") == "blocked now",
        repr((blocked, blocked_ticket)),
    )
    expect(
        "block of the active ticket never parks the session in a session-level BLOCKED state",
        blocked_state.get("phase") != "BLOCKED"
        and blocked_state.get("task") == "none"
        and blocked_state.get("blocker") in ("", "none"),
        repr(blocked_state),
    )
    expect(
        "block routes the next_action to the remaining workable TODO",
        blocked_state.get("next_action") == "PHASE SCOUT T-2",
        repr(blocked_state),
    )
    unblock_no_evidence = ticket_move(root, "unblock", "T-1", "probe")
    expect(
        "unblock without the lifting decision/evidence refuses",
        not unblock_no_evidence.get("ok")
        and unblock_no_evidence.get("code") == "VALIDATION_FAILED",
        repr(unblock_no_evidence),
    )
    unblocked = ticket_move(root, "unblock", "T-1", "probe", "block cleared by recorded decision")
    bd = parse_board(codec.read_doc(root / ".saipen" / "BOARD.md"))
    expect(
        "unblock atomically creates TODO without active blocker/history",
        unblocked.get("ok")
        and bd["tickets"]["T-1"]["section"] == "## TODO"
        and "blocker" not in bd["tickets"]["T-1"]["fields"]
        and "verify_attempts" not in bd["tickets"]["T-1"]["fields"],
        repr(bd["tickets"]["T-1"]["raw"]),
    )

    # ---- T-631: a malformed ticket line must not launder a blocker into a
    # workable ticket -- a typo'd `| blockr:` is exactly that laundering.
    malformed_root = make_project()
    (malformed_root / ".saipen" / "BOARD.md").write_text(
        (malformed_root / ".saipen" / "BOARD.md")
        .read_text(encoding="utf-8")
        .replace(
            "T-1 [P1] top probe | verify: probe",
            "T-1 [P1] top probe | blockr: WAIT_USER_CONFIRMATION | verify: probe",
        ),
        encoding="utf-8",
    )
    malformed_claim = apply_claim(malformed_root, "T-1", "probe")
    malformed_route = _blocker_route_next(
        codec.read_doc(malformed_root / ".saipen" / "STATE.md"),
        codec.read_doc(malformed_root / ".saipen" / "BOARD.md"),
    )
    expect(
        "claim refuses a board the parser cannot read whole",
        not malformed_claim.get("ok") and malformed_claim.get("code") == "VALIDATION_FAILED",
        repr(malformed_claim),
    )
    expect(
        "router routes malformed board to inspection, never a ticket",
        malformed_route.get("action") == "saipen status"
        and malformed_route.get("reason") == "board-malformed",
        repr(malformed_route),
    )

    escaped_root = make_project()
    escaped = ticket_add(escaped_root, "probe", "P1", "literal | blocker: description", [], "probe")
    escaped_board = parse_board(codec.read_doc(escaped_root / ".saipen" / "BOARD.md"))
    escaped_ticket = escaped_board["tickets"][escaped.get("ticket")]
    expect(
        "ticket add escapes description pipes instead of injecting fields",
        escaped.get("ok")
        and "blocker" not in escaped_ticket["fields"]
        and "literal | blocker: description" in escaped_ticket["description"]
        and "\\| blocker:" in escaped_ticket["raw"],
        repr(escaped_ticket),
    )

    # ---- T-631: pipe-bearing verify/blocker payloads must not inject fields.
    inject_root = make_project()
    inject = ticket_add(
        inject_root,
        "probe",
        "P1",
        "inject probe",
        [],
        "a | owner: eve | claim_time: 2026-08-10T00:00:00Z",
    )
    inject_board = parse_board(codec.read_doc(inject_root / ".saipen" / "BOARD.md"))
    inject_ticket = inject_board["tickets"][inject.get("ticket")]
    expect(
        "verify text with pipe delimiters cannot inject claim fields",
        inject.get("ok")
        and "owner" not in inject_ticket["fields"]
        and "a | owner: eve | claim_time: 2026-08-10T00:00:00Z"
        in inject_ticket["fields"].get("verify", ""),
        repr(inject_ticket),
    )
    block_root = make_project()
    block_claimed = apply_claim(block_root, "T-1", "probe")
    pipe_block = ticket_move(block_root, "block", "T-1", "probe", "stuck | verify: fake")
    pipe_block_ticket = parse_board(codec.read_doc(block_root / ".saipen" / "BOARD.md"))["tickets"][
        "T-1"
    ]
    expect(
        "blocker payload with pipe delimiters cannot inject a verify field",
        block_claimed.get("ok")
        and pipe_block.get("ok")
        and pipe_block_ticket["fields"].get("verify") == "probe"
        and "stuck | verify: fake" in pipe_block_ticket["fields"].get("blocker", ""),
        repr(pipe_block_ticket),
    )

    # ---- R7: WRITER_BUSY is a structured result, not a traceback.
    writer_lock = WriterLock(root)
    writer_lock.acquire()
    try:
        busy = ticket_add(root, "probe", "P2", "busy", [], "verify")
        expect(
            "WRITER_BUSY is a structured refusal",
            not busy.get("ok") and busy.get("code") == "WRITER_BUSY",
            repr(busy),
        )
    finally:
        writer_lock.release()

    # ---- plan/apply share one op_id and apply consumes exact plan bytes.
    root3 = make_project()
    p_apply = apply_claim(root3, "T-1", "probe")
    j3 = Journal(root3, p_apply.get("op_id"))
    expect(
        "plan op_id == journal op_id (apply consumed the plan)",
        p_apply.get("op_id") is not None
        and j3.exists()
        and j3.read()["op_id"] == p_apply.get("op_id"),
        repr(p_apply.get("op_id")),
    )
    expect(
        "applied journal is COMMITTED",
        j3.read()["status"] == "COMMITTED",
        repr(j3.read()["status"]),
    )

    # ---- R8: recovery CONFLICT preserves intervening bytes (journal level).
    root4 = make_project()
    saipen4 = root4 / ".saipen"
    log_b4 = (saipen4 / "LOG.md").read_bytes()
    state_b4 = (saipen4 / "STATE.md").read_bytes()
    from saipen_engine.journal import hash_bytes
    from saipen_engine.paths import runtime_lock_identity

    j = Journal(root4, "op-int")
    j.start(
        "op",
        "probe",
        runtime_lock_identity(root4),
        "hash",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": log_b4 + b"\n- 09.08.26 00:01 [E-901] RUN: x\n",
                "before_hash": hash_bytes(log_b4),
                "after_hash": "a",
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": state_b4.replace(b"phase: DONE", b"phase: BUILD"),
                "before_hash": hash_bytes(state_b4),
                "after_hash": "b",
            },
        ],
    )
    (saipen4 / "LOG.md").write_bytes(log_b4 + b"\n- 09.08.26 00:01 [E-901] RUN: x\n")
    j.mark("APPLYING", progress_index=1, target_index=0)
    external = state_b4 + b"\n# third party\n"
    (saipen4 / "STATE.md").write_bytes(external)
    from saipen_engine.journal import recover

    recovery_result = recover(root4, "op-int")
    expect(
        "recovery on an externally modified pending target CONFLICTs",
        recovery_result.get("code") == RECOVERY_REFUSED
        and (saipen4 / "STATE.md").read_bytes() == external,
        repr(recovery_result),
    )

    # ---- §69#19b: corrupt STAGED bytes are never committed as truth.
    root4b = make_project()
    saipen4b = root4b / ".saipen"
    log_b4b = (saipen4b / "LOG.md").read_bytes()
    state_b4b = (saipen4b / "STATE.md").read_bytes()
    new_log_b4b = log_b4b + b"\n- 09.08.26 00:01 [E-901] RUN: y\n"
    new_state_b4b = state_b4b.replace(b"phase: DONE", b"phase: BUILD")
    j4b = Journal(root4b, "op-staged")
    j4b.start(
        "op",
        "probe",
        runtime_lock_identity(root4b),
        "hash",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": new_log_b4b,
                "before_hash": hash_bytes(log_b4b),
                "after_hash": hash_bytes(new_log_b4b),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": new_state_b4b,
                "before_hash": hash_bytes(state_b4b),
                "after_hash": hash_bytes(new_state_b4b),
            },
        ],
    )
    # Corrupt the staged STATE bytes on disk after the journal was written.
    staged_candidates = sorted(j4b.dir.glob("*.staged"), key=lambda p: int(p.name.split("_", 1)[0]))
    assert staged_candidates, f"no staged files in {j4b.dir}"
    staged_candidates[1].write_bytes(b"# corrupt staged evidence\n")
    (saipen4b / "LOG.md").write_bytes(new_log_b4b)
    j4b.mark("APPLYING", progress_index=1, target_index=0)
    result4b = recover(root4b, "op-staged")
    expect(
        "recovery refuses corrupt staged bytes (CONFLICT, not COMMIT)",
        result4b.get("code") == "CONFLICT"
        and b"phase: BUILD" not in (saipen4b / "STATE.md").read_bytes(),
        repr(result4b),
    )

    # ---- Recovery preflight: pending op blocks a new mutation.
    root9 = make_project()
    saipen9 = root9 / ".saipen"
    log9 = (saipen9 / "LOG.md").read_bytes()
    state9 = (saipen9 / "STATE.md").read_bytes()
    j9 = Journal(root9, "op-pending")
    new_log9 = log9 + b"\n- 09.08.26 00:01 [E-901] RUN: x\n"
    new_state9 = state9.replace(b"phase: DONE", b"phase: BUILD")
    j9.start(
        "op",
        "probe",
        runtime_lock_identity(root9),
        "hash",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": new_log9,
                "before_hash": hash_bytes(log9),
                "after_hash": hash_bytes(new_log9),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": new_state9,
                "before_hash": hash_bytes(state9),
                "after_hash": hash_bytes(new_state9),
            },
        ],
    )
    (saipen9 / "LOG.md").write_bytes(new_log9)
    j9.mark("APPLYING", progress_index=1, target_index=0)
    pending = [op["op_id"] for op in pending_ops(root9)]
    expect(
        "status derives recovery_pending from real journals", "op-pending" in pending, repr(pending)
    )
    pre = recovery_preflight(root9)
    expect(
        "recovery preflight recovers the single pending op first",
        pre.get("ok") and pre.get("recovered") == ["op-pending"],
        repr(pre),
    )
    root5 = make_project()
    new_mutation = ticket_add(root5, "probe", "P2", "after", [], "verify")
    expect(
        "a new mutation over no pending op succeeds",
        new_mutation.get("ok"),
        repr(new_mutation.to_dict()),
    )

    # ---- Codec: UTF-8/CRLF/BOM representation survives a real operation.
    root6 = make_project()
    board6 = root6 / ".saipen" / "BOARD.md"
    text6 = (
        "# Board\n## DOING\n## TODO\n- [ ] T-1 [P1] probe | verify: probe\n## DONE\n## BLOCKED\n"
    )
    board6.write_bytes(text6.encode("utf-8"))
    add6 = ticket_add(root6, "probe", "P2", "crlf", [], "verify")
    after6 = board6.read_bytes()
    # T-1361 CL-09: the expectation said T-2, which was right while the next
    # ticket id came from the BOARD this test overwrites. Allocation identity
    # now comes from the COMPLETE HISTORY (CORE-003 / SRC-026:R003), and this
    # fixture's history allocates T-1 and T-2, so the next id is T-3 -- the
    # contract moved, the codec behaviour under test did not. Read the id the
    # operation reports rather than restating it, so the check measures
    # REPRESENTATION, which is all it was ever about.
    expected6 = (
        "# Board\n## DOING\n## TODO\n"
        f"- [ ] {add6.get('ticket')} [P2] crlf | verify: verify\n"
        "- [ ] T-1 [P1] probe | verify: probe\n"
        "## DONE\n## BLOCKED\n"
    )
    expect(
        "UTF-8 LF representation preserved",
        add6.get("ok") and after6.decode("utf-8") == expected6 and b"\xef\xbb\xbf" not in after6,
        repr(after6[:80]),
    )

    root7 = make_project()
    board7 = root7 / ".saipen" / "BOARD.md"
    text7 = (
        "# Board\r\n## DOING\r\n## TODO\r\n"
        "- [ ] T-1 [P1] probe | verify: probe\r\n"
        "## DONE\r\n## BLOCKED\r\n"
    )
    board7.write_bytes(text7.replace("\r\n", "\r\n").encode("utf-8"))
    ticket_add(root7, "probe", "P2", "crlf", [], "verify")
    after7 = board7.read_bytes()
    expect(
        "UTF-8 CRLF representation preserved by a real operation",
        b"\r\n" in after7 and b"\n" not in after7.replace(b"\r\n", b""),
        repr(after7[:60]),
    )

    root8 = make_project()
    board8 = root8 / ".saipen" / "BOARD.md"
    text8 = (
        "# Board\n## DOING\n## TODO\n- [ ] T-1 [P1] probe | verify: probe\n## DONE\n## BLOCKED\n"
    )
    board8.write_bytes(b"\xef\xbb\xbf" + text8.encode("utf-8"))
    before8 = board8.read_bytes()
    add8 = ticket_add(root8, "probe", "P2", "bom", [], "verify")
    after8 = board8.read_bytes()
    expect(
        "UTF-8 BOM board refused before any write (zero canonical writes)",
        (not add8.get("ok")) and add8.get("code") == "VALIDATION_FAILED" and after8 == before8,
        repr((add8.get("code"), after8[:6])),
    )

    # ---- Improve: path safety, one active cycle, sweep enum, propagation.
    import improve

    try:
        improve.cycle_dir(root, "../../escape")
        escaped = False
    except ValueError:
        escaped = True
    expect("improve cycle_id traversal is refused", escaped)
    croot = make_project()
    improve.register_cycle(croot, "imp-1", "# IMPROVE CYCLE ROSTER\n")
    try:
        improve.register_cycle(croot, "imp-2", "# IMPROVE CYCLE ROSTER\n")
        second = False
    except ValueError:
        second = True
    expect("only one active Improve cycle is admitted", second)
    sweep_cycle = improve.cycle_dir(croot, "imp-1")
    try:
        improve.write_sweep_entry(
            sweep_cycle,
            {
                "imp_id": "001",
                "disposition": "NOPE",
                "ticket": "-",
                "report": "r",
                "reproduced": "-",
            },
        )
        bad_enum = False
    except ValueError:
        bad_enum = True
    expect(
        "SWEEP disposition enum is enforced at the writer",
        bad_enum and not (sweep_cycle / "SWEEP.md").is_file(),
    )

    # ---- §69#05: checkpoint emits a mechanically parented event.
    rootp = make_project()
    apply_claim(rootp, "T-1", "probe")
    cp_p = checkpoint(rootp, "probe", "RUN", "T-1", "parent check")
    log_p = codec.read_doc(rootp / ".saipen" / "LOG.md")
    expect(
        "checkpoint event carries [parent: E-<prev>]",
        cp_p.get("ok") and f"[parent: E-{int(cp_p.get('event_id')[2:]) - 1}]" in log_p,
        repr(log_p[-140:]),
    )

    # ---- §69#04: checkpoint preserves unrelated STATE fields. The fixture
    # builds a LEGAL claimed/BUILD state first (a hand-set BUILD with no DOING
    # ticket is now refused by fast validation), then injects the unrelated
    # goal fields the checkpoint must carry through unchanged.
    rootu = make_project()
    apply_claim(rootu, "T-1", "probe")
    transition_phase(rootu, "BUILD", "probe", "T-1", "setup")
    state_u = (rootu / ".saipen" / "STATE.md").read_text(encoding="utf-8")
    (rootu / ".saipen" / "STATE.md").write_text(
        state_u.replace(
            "updated:", "execution_intent: goal\ngoal_waves: 1\ngoal_tickets: 2\nupdated:"
        ),
        encoding="utf-8",
    )
    _before_u = codec.read_doc(rootu / ".saipen" / "STATE.md")
    cp_u = checkpoint(rootu, "probe", "RUN", "T-1", "unrelated preserve")
    after_u = codec.read_doc(rootu / ".saipen" / "STATE.md")
    expect(
        "checkpoint preserves unrelated fields (intent/counters/mode)",
        cp_u.get("ok")
        and "execution_intent: goal" in after_u
        and "goal_waves: 1" in after_u
        and "goal_tickets: 2" in after_u
        and "mode: full" in after_u
        and "requires:" in after_u
        and "blocker:" in after_u,
        repr(after_u),
    )

    # ---- §69#07: goal intent from DONE/task:none never fabricates SCOUT.
    rootg = make_project()
    goal_g = set_goal_intent(rootg, "probe", "goal control")
    st_g = parse_state(codec.read_doc(rootg / ".saipen" / "STATE.md"))
    expect(
        "goal intent from DONE/none does not create SCOUT/none",
        goal_g.get("ok")
        and st_g.get("phase") == "DONE"
        and st_g.get("task") == "none"
        and st_g.get("execution_intent") == "goal",
        repr(st_g),
    )

    # ---- T-630: after a LOG seal the engine must continue the E-### sequence
    # from the NEWEST sealed segment, never the oldest. The old _read
    # prepended segments, so a fresh active log read LOG-001's tail as the
    # sequence head and minted a bogus low event.
    sealr = make_project()
    seal_log = sealr / ".saipen" / "LOG.md"
    (sealr / ".saipen" / "logs").mkdir()
    # T-1361 CL-06: blanking the active LOG moves the fixture's whole history
    # into these segments, and the fixture's history is where T-1 and T-2 get
    # the allocation events their identity now comes from (CORE-003 /
    # SRC-026:R003). Dropping them here left the board unallocated, so every
    # mutation refused and this seal-tail test measured a refusal instead of a
    # sequence. Seal them with the base event; the test is about which segment
    # the sequence continues from, not about allocation.
    (sealr / ".saipen" / "logs" / "LOG-001.md").write_text(
        "- 09.08.26 00:00 [E-898] [T-1] [agent: probe] [op: ticket-fixture] "
        "DEC: ticket added via SAIOPS\n"
        "- 09.08.26 00:00 [E-899] [T-2] [agent: probe] [op: ticket-fixture] "
        "DEC: ticket added via SAIOPS\n"
        "- 09.08.26 00:00 [E-900] [T-none] DEC: base\n",
        encoding="utf-8",
    )
    (sealr / ".saipen" / "logs" / "LOG-002.md").write_text(
        "- 09.08.26 00:01 [E-901] [T-none] DEC: sealed two\n"
        "- 09.08.26 00:02 [E-902] [T-none] DEC: sealed three\n",
        encoding="utf-8",
    )
    seal_log.write_text("# Log\n", encoding="utf-8")
    from saipen_engine.state import patch_state as _seal_patch

    seal_state = sealr / ".saipen" / "STATE.md"
    seal_state.write_text(
        _seal_patch(codec.read_doc(seal_state), {"last_event": 902}), encoding="utf-8"
    )
    seal_cp = checkpoint(sealr, "probe", "RUN", "T-1", "seal tail control")
    seal_st = parse_state(codec.read_doc(seal_state))
    expect(
        "checkpoint after a seal continues from the newest sealed event "
        "(E-903, not the oldest segment's E-901)",
        seal_cp.get("ok")
        and seal_st.get("last_event") == 903
        and seal_cp.get("event_id") == "E-903",
        repr((seal_cp, seal_st)),
    )

    # ---- §69#17: commit failure cannot be overwritten by semantic success.
    rootf = make_project()
    plan_f = _plan_claim(rootf, "T-1", "probe", _now(), _utc_iso())
    (rootf / ".saipen" / "BOARD.md").write_text(
        (rootf / ".saipen" / "BOARD.md")
        .read_text(encoding="utf-8")
        .replace(
            "- [ ] T-1 [P1] top probe | verify: probe",
            "- [/] T-1 [P1] top probe | owner: probe | claim_time: 2026-01-01T00:00:00Z",
        ),
        encoding="utf-8",
    )
    from saipen_engine.plan import apply_plan

    result_f = apply_plan(rootf, plan_f)
    expect(
        "stale apply returns failure, never semantic success",
        not result_f.get("ok") and result_f.get("code") in ("STALE_STATE", "ALREADY_CLAIMED"),
        repr(result_f),
    )

    # ---- §69#18: journal stores per-target before+after hashes.
    j18 = Journal(root3, p_apply.get("op_id"))
    rec18 = j18.read()
    expect(
        "every journal target carries before_hash and after_hash",
        all("before_hash" in t and "after_hash" in t for t in rec18["targets"])
        and all(t["before_hash"] and t["after_hash"] for t in rec18["targets"]),
        repr([{k: t[k] for k in ("path", "before_hash", "after_hash")} for t in rec18["targets"]]),
    )

    # ---- §69#27/#50: corrupt proposed state never reaches PREPARED.
    rootc = make_project()
    ops_dir = rootc / ".saipen" / "recovery" / "ops"
    log_c = (rootc / ".saipen" / "LOG.md").read_text(encoding="utf-8")
    # A duplicate event in the live LOG survives into the proposed LOG and
    # must refuse the mutation before any journal is PREPARED.
    (rootc / ".saipen" / "LOG.md").write_text(
        log_c + log_c.splitlines()[-1] + "\n", encoding="utf-8"
    )
    before_ops = sorted(p.name for p in ops_dir.glob("*")) if ops_dir.is_dir() else []
    claim_c = apply_claim(rootc, "T-1", "probe")
    after_ops = sorted(p.name for p in ops_dir.glob("*")) if ops_dir.is_dir() else []
    expect(
        "proposed-state invalidity refuses before any journal PREPARED",
        not claim_c.get("ok")
        # T-1361 CL-06: b2343541 (T-1334) gave immutable-ledger corruption its
        # own refusal class instead of the generic VALIDATION_FAILED --
        # `CheckpointError.code` names the class "when it is more precise".
        # A duplicate LOG line is exactly that, so the specific code is the
        # contract now; accepting the generic one would accept a refusal that
        # says less than the engine knows.
        and claim_c.get("code") == "HISTORY_LEDGER_CORRUPT"
        and before_ops == after_ops,
        repr(claim_c),
    )

    # ---- §69#32: UTF-16 supported path preserves representation (or refuses).
    rootu16 = make_project()
    board16 = rootu16 / ".saipen" / "BOARD.md"
    text16 = (
        "# Board\n## DOING\n## TODO\n- [ ] T-1 [P1] probe | verify: probe\n## DONE\n## BLOCKED\n"
    )
    board16.write_bytes(b"\xff\xfe" + text16.encode("utf-16-le"))
    before16 = board16.read_bytes()
    add16 = ticket_add(rootu16, "probe", "P2", "u16", [], "verify")
    after16 = board16.read_bytes()
    expect(
        "UTF-16LE BOM board refused before any write (zero canonical writes)",
        (not add16.get("ok")) and add16.get("code") == "VALIDATION_FAILED" and after16 == before16,
        repr((add16.get("code"), after16[:4])),
    )

    # ---- §69#33: a one-file generic journal never claims LOG_WRITTEN.
    rootone = make_project()
    j_one = Journal(rootone, "op-single")
    content_one = (rootone / ".saipen" / "STATE.md").read_bytes()
    j_one.start(
        "op",
        "probe",
        runtime_lock_identity(rootone),
        "h",
        [
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": content_one.replace(b"phase: DONE", b"phase: BUILD"),
                "before_hash": hash_bytes(content_one),
                "after_hash": hash_bytes(content_one.replace(b"phase: DONE", b"phase: BUILD")),
            },
        ],
    )
    rec_one = j_one.read()
    expect(
        "one-file journal uses generic truthful stage, never LOG_WRITTEN",
        rec_one["targets"][0]["role"] == "state" and rec_one["targets"][0]["applied"] is False,
        repr(rec_one["targets"]),
    )

    # ---- §69#35/#36: seat_id / report_path injection refused.
    croot35 = make_project()
    improve.register_cycle(croot35, "imp-s", "# IMPROVE CYCLE ROSTER\n")
    cdir35 = improve.cycle_dir(croot35, "imp-s")
    try:
        improve.register_seat(cdir35, "a\navailability: complete", "core", "saipen_improve_X.md")
        seat_inject = False
    except ValueError:
        seat_inject = True
    expect("seat_id newline injection is refused", seat_inject)
    try:
        improve.register_seat(cdir35, "seat-1", "core", "../../escape.md")
        path_escape = False
    except ValueError:
        path_escape = True
    expect("report_path traversal is refused", path_escape)

    # ---- §69#38/#39: append_run journalled; Improve writer propagates failure.
    # T-638: append_run requires a valid ACTIVE cycle manifest.
    rroot = make_project()
    _r_cycle = improve.create_cycle(
        rroot, "imp-s", created_at="2026-08-12T00:00:00Z", project_identity="p"
    )
    improve.register_seat(_r_cycle, "seat-1", "core", "saipen_improve_PROJ.md")
    rreport = improve.create_report(
        rroot,
        "imp-s",
        "seat-1",
        "PROJ",
        agent="seat-1",
        role="core",
        model_or_runtime="probe",
        context_scope="scope",
    )
    run_res = improve.append_run(rreport, "first run")
    expect(
        "append_run returns a committed transaction result",
        run_res.get("ok") and run_res.get("code") == "COMMITTED",
        repr(run_res),
    )
    complete_t = rreport.read_text(encoding="utf-8").replace(
        "report_status: draft", "report_status: complete"
    )
    rreport.write_text(complete_t, encoding="utf-8")
    try:
        improve.append_run(rreport, "late")
        prop = False
    except ValueError:
        prop = True
    expect("Improve writer refuses a complete report and propagates", prop)

    # ---- §69#47/#48: mechanical provenance -- structural events after the
    # first [op: ...] marker carry one; a manual structural edit is detected.
    import saipen_engine.log as engine_log

    _, event_line = engine_log.build_event(
        999,
        "DEC",
        "ticket added via SAIOPS",
        ticket="T-1",
        agent="probe",
        now="09.08.26 00:00",
        op_id="claim-abc",
    )
    parsed = engine_log.parse_log_line(event_line)
    expect(
        "SAIOPS structural event carries [op: ...] provenance",
        parsed is not None and parsed["op_id"] == "claim-abc",
        repr(parsed),
    )
    _, manual_line = engine_log.build_event(
        1000,
        "DEC",
        "ticket added via SAIOPS -- manual",
        ticket="T-1",
        agent="probe",
        now="09.08.26 00:00",
    )
    parsed_manual = engine_log.parse_log_line(manual_line)
    expect(
        "manual structural event lacks provenance (detectable)",
        parsed_manual is not None and parsed_manual["op_id"] is None,
        repr(parsed_manual),
    )

    # ---- §69#24: a committed op retried returns ALREADY_APPLIED.
    from saipen_engine.journal import run_mutation as _run_mutation

    root_retry = make_project()
    saipen_retry = root_retry / ".saipen"
    log_r = (saipen_retry / "LOG.md").read_bytes()
    state_r = (saipen_retry / "STATE.md").read_bytes()
    new_log_r = log_r + b"\n- 09.08.26 00:01 [E-901] RUN: op\n"
    new_state_r = state_r.replace(b"phase: DONE", b"phase: BUILD")
    commit_retry = _run_mutation(
        root_retry,
        "op-retry",
        "op",
        "probe",
        "id",
        "hash",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": new_log_r,
                "before_hash": hash_bytes(log_r),
                "after_hash": hash_bytes(new_log_r),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": new_state_r,
                "before_hash": hash_bytes(state_r),
                "after_hash": hash_bytes(new_state_r),
            },
        ],
        skip_preflight=True,
    )
    # The retry must reproduce the record's semantic fingerprint exactly
    # (operation, semantic_payload_hash, policy, per-target role + after_hash)
    # or it is an op_id collision, not a retry (perf wave T-1022).
    _j_retry = Journal(root_retry, "op-retry")
    _retry_rec = _j_retry.read()
    retry_result = _run_mutation(
        root_retry,
        "op-retry",
        _retry_rec.get("operation"),
        "probe",
        "id",
        _retry_rec.get("semantic_payload_hash"),
        [
            {"path": t["path"], "role": t["role"], "content": (root_retry / t["path"]).read_bytes()}
            for t in _retry_rec["targets"]
        ],
        skip_preflight=True,
        verification_policy=_retry_rec.get("verification_policy", "none"),
    )
    expect(
        "a committed op retried returns ALREADY_APPLIED, no second write",
        commit_retry.get("code") == "COMMITTED" and retry_result.get("code") == "ALREADY_APPLIED",
        repr((commit_retry, retry_result)),
    )

    # ---- §69#23: `saipen recover --json` returns a machine result.
    rec_root = make_project()
    _saipen_rec = rec_root / ".saipen"
    rec_proc = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "recover", "--json"],
        cwd=str(rec_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "saipen recover --json returns structured JSON",
        rec_proc.returncode == 0
        and (
            '"code": "CLEAN"' in rec_proc.stdout
            # T-1340: on a project with no audit manifest yet, the first
            # mutating lifecycle call enrolls it and must say so instead of
            # claiming CLEAN over the write it just performed.
            or '"code": "AUDIT_MANIFEST_WRITTEN"' in rec_proc.stdout
        ),
        repr(rec_proc.stdout[:160]),
    )

    # ---- NITRO M7: USERPERSON writer on the common journal machinery.
    import userperson

    up_root = make_project()
    up_path = userperson.profile_path(up_root)
    up_add = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "userperson",
            "add",
            "Prefer UI: Vintage Golden",
            "--json",
        ],
        cwd=str(up_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "saipen userperson add writes through the journal (COMMITTED)",
        up_add.returncode == 0 and '"code": "COMMITTED"' in up_add.stdout and up_path.is_file(),
        repr(up_add.stdout[:120]),
    )
    up_add2 = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "userperson",
            "add",
            "Prefer UI: Material Design",
        ],
        cwd=str(up_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    up_text = up_path.read_text(encoding="utf-8-sig")
    expect(
        "userperson add keeps distinct preferences sharing a leading phrase",
        up_add2.returncode == 0 and "Vintage Golden" in up_text and "Material Design" in up_text,
        repr(up_text),
    )
    up_reset_refuse = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "userperson", "reset", "--json"],
        cwd=str(up_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "userperson reset without confirmation REFUSEs",
        '"code": "DESTRUCTIVE_CONFIRMATION_REQUIRED"' in up_reset_refuse.stdout,
        repr(up_reset_refuse.stdout[:120]),
    )
    up_global_config = up_root / "global-user-config"
    up_global_config.mkdir()
    up_global_path = up_global_config / "USERPERSON.md"
    up_global_path.write_text(
        "# USERPERSON\n\n- [UI] Preserve global preference\n", encoding="utf-8"
    )
    up_reset_env = os.environ.copy()
    up_reset_env["SAIPEN_USER_CONFIG_HOME"] = str(up_global_config)
    up_reset = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "userperson",
            "reset",
            "--confirm",
            "--json",
        ],
        cwd=str(up_root),
        env=up_reset_env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "project userperson reset deletes only the project profile",
        up_reset.returncode == 0 and not up_path.is_file() and up_global_path.is_file(),
        repr(up_reset.stdout[:120]),
    )

    # ---- NITRO M8: SubSaipen lifecycle on the common machinery.
    sub_root = make_project()
    home = str(HOME)
    spawn_res = subs.sub_spawn(sub_root, "saiscout", home)
    sub_state_path = sub_root / ".saipen" / "extensions" / "subs" / "saiscout" / "STATE.md"
    expect(
        "sub spawn creates a journaled instance (SPAWNED)",
        spawn_res.get("ok") and spawn_res.get("code") == "SPAWNED" and sub_state_path.is_file(),
        repr(spawn_res),
    )
    st_spawn = sub_state_path.read_text(encoding="utf-8")
    import datetime as _dt

    _today_utc = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT")
    expect(
        "spawned sub has its own agent + real updated timestamp",
        "agent: saiscout" in st_spawn and _today_utc in st_spawn and "2026-01-01" not in st_spawn,
        repr(st_spawn[-200:]),
    )
    dup = subs.sub_spawn(sub_root, "saiscout", home)
    expect(
        "sub spawn refuses an existing instance, never overwrites",
        not dup.get("ok") and dup.get("code") == "ALREADY_CLAIMED",
        repr(dup),
    )
    listed = subs.sub_list(sub_root)
    expect(
        "sub list reports the spawned instance",
        listed.get("ok") and any(s["name"] == "saiscout" for s in listed["subs"]),
        repr(listed),
    )
    paused = subs.sub_pause(sub_root, "saiscout")
    st_pause = sub_state_path.read_text(encoding="utf-8")
    expect(
        "sub pause is a journaled owned-field BLOCKED patch",
        paused.get("ok")
        and "phase: BLOCKED" in st_pause
        and "paused by main agent" in st_pause
        and "paused_from_phase: PLAN" in st_pause
        and "paused_from_na:" in st_pause,
        repr(st_pause),
    )
    sub_log_path = sub_root / ".saipen" / "extensions" / "subs" / "saiscout" / "LOG.md"
    expect(
        "sub pause leaves a trace in the sub LOG",
        "main agent pause" in sub_log_path.read_text(encoding="utf-8"),
    )
    resumed = subs.sub_resume(sub_root, "saiscout")
    st_resume = sub_state_path.read_text(encoding="utf-8")
    expect(
        "sub resume restores the prior phase and next_action",
        resumed.get("ok")
        and "phase: PLAN" in st_resume
        and 'next_action: "saipen plan"' in st_resume
        and "paused by main agent" not in st_resume
        and 'paused_from_phase: ""' in st_resume
        and 'paused_from_na: ""' in st_resume,
        repr(st_resume),
    )
    expect(
        "sub resume leaves a trace in the sub LOG",
        "main agent resume" in sub_log_path.read_text(encoding="utf-8"),
    )
    expect(
        "resume of a non-paused sub refuses (no fake success)",
        not subs.sub_resume(sub_root, "saiscout").get("ok"),
    )

    # Clean preflight: read-only, refuses outstanding evidence, never deletes.
    clean_bad = subs.sub_clean_preflight(sub_root, "saiscout")
    clean_ok = subs.sub_clean_preflight(sub_root, "does-not-exist")
    expect(
        "sub clean preflight refuses a fresh instance with evidence",
        not clean_bad.get("ok")
        and clean_bad.get("code") == "VALIDATION_FAILED"
        and (sub_root / ".saipen" / "extensions" / "subs" / "saiscout").is_dir(),
        repr(clean_bad),
    )
    expect(
        "sub clean preflight refuses a nonexistent instance",
        not clean_ok.get("ok") and clean_ok.get("code") == "TICKET_NOT_FOUND",
        repr(clean_ok),
    )
    st_clean = sub_state_path.read_text(encoding="utf-8")
    expect("sub clean preflight never mutates the instance", st_clean == st_resume, "state changed")

    # Aggregate collect is a truthful no-op when eligible OUTBOXes are empty.
    collect_res = subs.sub_collect(sub_root, "saiscout")
    expect(
        "sub collect reports an empty eligible OUTBOX without writes",
        collect_res.get("ok") and collect_res.get("code") == "SUB_COLLECT",
        repr(collect_res),
    )

    # ---- T-588: SubSaipen path-escape regression (dogfood II).
    from saipen_engine import subs as _subs

    esc_root = make_project()
    esc_home = str(HOME)
    for bad in ("..", ".", "../x", "x/../y", "..\\x", r"V:\abs", "a\nb", "a\x00b"):
        try:
            _subs.sub_spawn(esc_root, bad, esc_home)
            refused = False
        except (ValueError, Exception):
            refused = True
        if not refused:
            r = _subs.sub_spawn(esc_root, bad, esc_home)
            refused = not r.get("ok") and r.get("code") in ("INVALID_ID", "PATH_ESCAPE")
        expect(f"sub name {bad!r} is refused (no path escape)", refused, repr(bad))
    # Zero bytes escaped anywhere outside the owner root. The fixture's own
    # three canonical files are expected; anything else outside
    # .saipen/extensions/subs/ would be an escape (e.g. .saipen/extensions/
    # STATE.md from a ".." spawn).
    canonical = {".saipen/STATE.md", ".saipen/BOARD.md", ".saipen/LOG.md"}
    escaped_files = [
        p
        for p in (esc_root / ".saipen").rglob("*")
        if p.is_file()
        and "extensions/subs" not in p.as_posix()
        and p.relative_to(esc_root).as_posix() not in canonical
    ]
    expect(
        "path-escape attempts write zero bytes outside the owner root",
        len(escaped_files) == 0,
        repr([p.relative_to(esc_root).as_posix() for p in escaped_files]),
    )

    # ---- T-588: first-spawn bootstrap installs the shared extension files.
    boot_root = make_project()
    _subs.sub_spawn(boot_root, "saiscout", esc_home)
    subs_dir = boot_root / ".saipen" / "extensions" / "subs"
    expect("first spawn installs PROTOCOL.md", (subs_dir / "PROTOCOL.md").is_file())
    expect("first spawn installs TEMPLATE/", (subs_dir / "TEMPLATE" / "STATE.md").is_file())
    expect("first spawn installs built-in sai*.md charters", (subs_dir / "saihunt.md").is_file())
    expect(
        "first spawn does NOT bootstrap on a second instance",
        not _subs.sub_spawn(boot_root, "saiscout2", esc_home).get("ok")
        or (subs_dir / "PROTOCOL.md").is_file(),
    )

    # ---- T-588: ready OUTBOX package completeness (dogfood II). T-991:
    # role freshness fails CLOSED -- a charter-backed sub (saihunt) with its
    # computed revision passes; missing/unverifiable role evidence refuses.
    comp_root = make_project()
    _comp_state = comp_root / ".saipen" / "STATE.md"
    _comp_state.write_text(
        _comp_state.read_text(encoding="utf-8-sig").replace(
            'saipen_home: "."', f'saipen_home: "{esc_home}"'
        ),
        encoding="utf-8",
    )
    _subs.sub_spawn(comp_root, "saihunt", esc_home)
    comp_outbox = (
        comp_root / ".saipen" / "extensions" / "subs" / "saihunt" / "kitchen" / "OUTBOX.md"
    )
    from freshness import compute_source_identity, compute_role_revision

    _current = compute_source_identity(comp_root)
    _wiki_charter = esc_home + "/extensions/subs/saihunt.md"
    _wiki_rev = compute_role_revision(_wiki_charter)
    complete = (
        "# OUTBOX\n\n## F-001: finding\n"
        "- **status:** ready\n"
        "- **summary:** a finding\n"
        f"- **source_head:** {_current.source_head}\n"
        f"- **source_tree_fingerprint:** "
        f"{_current.source_tree_fingerprint}\n"
        f"- **role_revision:** {_wiki_rev}\n"
        "- **producer:** saihunt\n"
        "- **coverage:** requested surface\n"
        "- **payload:** []\n"
        "- **verified:** PASS -- probe\n"
        "- **instructions:** review package\n"
    )
    comp_outbox.write_text(complete, encoding="utf-8")
    res_ok = _subs.sub_collect(comp_root, "saihunt", dry_run=True)
    expect(
        "complete ready OUTBOX package with a verifiable role passes collect",
        res_ok.get("ok"),
        repr(res_ok),
    )
    for missing_field in ("source_head", "source_tree_fingerprint", "role_revision"):
        partial = "\n".join(
            line for line in complete.splitlines() if not line.startswith(f"- **{missing_field}:**")
        )
        comp_outbox.write_text(partial, encoding="utf-8")
        res_missing = _subs.sub_collect(comp_root, "saihunt")
        expect(
            f"ready OUTBOX missing {missing_field} refuses (MALFORMED_PACKAGE)",
            not res_missing.get("ok") and res_missing.get("code") == "MALFORMED_PACKAGE",
            repr(res_missing),
        )
        comp_outbox.write_text(complete, encoding="utf-8")
    # A superseded role revision is STALE, never fresh.
    comp_outbox.write_text(
        complete.replace(
            f"- **role_revision:** {_wiki_rev}\n", "- **role_revision:** stale-revision\n"
        ),
        encoding="utf-8",
    )
    res_stale_role = _subs.sub_collect(comp_root, "saihunt")
    expect(
        "ready OUTBOX with a superseded role revision refuses (MALFORMED_PACKAGE, STALE)",
        not res_stale_role.get("ok") and res_stale_role.get("code") == "MALFORMED_PACKAGE",
        repr(res_stale_role),
    )
    # A sub whose role charter cannot be found (missing home/charter) is
    # UNAVAILABLE, never fresh -- collect refuses ready evidence it cannot
    # verify against a charter.
    _subs.sub_spawn(comp_root, "saiscout", esc_home)
    scout_outbox = (
        comp_root / ".saipen" / "extensions" / "subs" / "saiscout" / "kitchen" / "OUTBOX.md"
    )
    scout_outbox.write_text(
        complete.replace(
            f"- **role_revision:** {_wiki_rev}\n", "- **role_revision:** sha256:" + "0" * 64 + "\n"
        ).replace("- **producer:** saihunt\n", "- **producer:** saiscout\n"),
        encoding="utf-8",
    )
    res_unverifiable = _subs.sub_collect(comp_root, "saiscout")
    expect(
        "ready OUTBOX with an unverifiable role revision refuses (PACKAGE_INCOMPLETE)",
        not res_unverifiable.get("ok") and res_unverifiable.get("code") == "PACKAGE_INCOMPLETE",
        repr(res_unverifiable),
    )
    comp_outbox.write_text(complete, encoding="utf-8")

    # ---- T-588: malformed nonempty OUTBOX is not an empty queue.
    mal_root = make_project()
    _subs.sub_spawn(mal_root, "saiscout", esc_home)
    mal_outbox = mal_root / ".saipen" / "extensions" / "subs" / "saiscout" / "kitchen" / "OUTBOX.md"
    mal_outbox.write_text(
        "# OUTBOX\n\n## status: ready\nsome stray text that is not a package\n", encoding="utf-8"
    )
    res_mal = _subs.sub_collect(mal_root, "saiscout")
    expect(
        "malformed nonempty OUTBOX refuses (MALFORMED_PACKAGE)",
        not res_mal.get("ok") and res_mal.get("code") == "MALFORMED_PACKAGE",
        repr(res_mal),
    )

    # ---- T-588: sub collect (no name) aggregates all active subs.
    agg_root = make_project()
    _subs.sub_spawn(agg_root, "saiscout", esc_home)
    _subs.sub_spawn(agg_root, "saiscout2", esc_home)
    agg_res = _subs.sub_collect(agg_root)
    expect(
        "sub collect with no name aggregates all active subs",
        agg_res.get("ok") and {p["name"] for p in agg_res["packages"]} == {"saiscout", "saiscout2"},
        repr(agg_res),
    )

    # ---- NITRO M9: context compiler is read-only and derives from the engine.
    from saipen_engine import context as ctx

    ctx_root = make_project()
    tree_before = project_tree(ctx_root)
    cold = ctx.context_cold(ctx_root)
    hot = ctx.context_hot(ctx_root)
    audit = ctx.context_audit(ctx_root)
    tree_after = project_tree(ctx_root)
    expect(
        "context cold is read-only (zero bytes written)",
        cold.get("ok") and tree_before == tree_after,
        repr(cold),
    )
    expect(
        "context hot is read-only and names the claimed ticket",
        hot.get("ok")
        and "claimed_ticket:" in hot.get("surface", "")
        and "recovery_pending:" in hot.get("surface", ""),
        repr(hot),
    )
    expect(
        "context audit accounts bytes/tokens per source",
        audit.get("ok")
        and len(audit["sources"]) >= 3
        and "cold_surface" in audit
        and "projection_reduction_bytes" in audit
        and "repeated_unchanged_bytes" not in audit,
        repr(audit),
    )
    cold_bytes = cold.get("bytes", 0)
    raw_bytes = audit["total_bytes"]
    expect(
        "cold surface bytes are measured as real UTF-8 bytes",
        cold_bytes > 0 and raw_bytes > 0 and isinstance(cold_bytes, int),
        f"cold={cold_bytes} raw={raw_bytes}",
    )
    cold_tokens = cold.get("tokens", 0)
    expect(
        "cold surface token count is modest (token optimization target)",
        cold_tokens > 0 and cold_tokens < 5000,
        repr(cold_tokens),
    )

    # ---- NITRO dogfood IV (T-600): context projection integrity.
    # Real current shape: 10+ TODO tickets, the top several unworkable (needs
    # unmet), the ACTUAL top workable below the orientation limit, long
    # description, nonempty needs, long verify. A small budget must still
    # include in full: routed action, exact ticket, needs, verify, routed
    # phase doc, recovery state -- and the board map must be TRUTHFULLY
    # capped (never print a ticket AND count it as omitted).
    from saipen_engine.context import _board_map as _ctx_board_map

    shape_root = make_project()
    sf = shape_root / ".saipen"
    lines = ["# Board", "## DOING", "## TODO"]
    lines.append("- [ ] T-1 [P1] unworkable one | needs: T-2 | verify: v1")
    lines.append("- [ ] T-2 [P1] unworkable two | needs: T-3 | verify: v2")
    lines.append("- [ ] T-3 [P1] unworkable three | needs: T-4 | verify: v3")
    for i in range(4, 13):
        lines.append(
            f"- [ ] T-{i} [P1] ticket {i} with a long descriptive "
            f"body {'x' * 120} | verify: run a very long "
            f"verification command for T-{i} {'y' * 120}"
        )
    lines.append("## DONE\n## BLOCKED\n")
    (sf / "BOARD.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    cold_shape = ctx.context_cold(shape_root, limit=1500)
    surf = cold_shape.get("surface", "")
    expect(
        "context: with a small budget the exact routed ticket (the top "
        "workable below the orientation limit) survives in full "
        "(description + verify intact)",
        "## NEXT TICKET" in surf
        and "ticket 4 with a long descriptive body" in surf
        and "verify: run a very long verification command for T-4" in surf,
        repr(surf[:400]),
    )
    expect(
        "context: routed action + phase doc + recovery state survive a small budget",
        "PHASE SCOUT T-4" in surf
        and "phase_doc: saipen/phases/scout.md" in surf
        and "recovery_pending:" in surf,
        repr(surf[:400]),
    )
    expect(
        "context: the board map is present and truthfully capped",
        "## BOARD MAP" in surf and bool(re.search(r"\+ ?\d+ more", surf)),
        repr(surf[-300:]),
    )
    _shape_tickets = parse_board(codec.read_doc(sf / "BOARD.md"))["tickets"].values()
    _shape_buckets = {
        section: [ticket for ticket in _shape_tickets if ticket["section"] == section]
        for section in ("## DOING", "## TODO", "## BLOCKED", "## DONE")
    }
    bm = _ctx_board_map(_shape_buckets, full_ticket="T-4", cap=2)
    expect(
        "context: _board_map omits exactly the right count (+9 more from "
        "12 TODO tickets with cap 2 + protected full T-4)",
        "  ... +9 more" in bm and "ticket 4 with a long descriptive body" in bm,
        repr(bm),
    )

    # Byte accounting MUST describe the FINAL emitted surface: bytes ==
    # len(surface.encode('utf-8')) and characters == len(surface), exactly --
    # proven with Cyrillic + Japanese multibyte content.
    unicode_root = make_project()
    (unicode_root / ".saipen" / "BOARD.md").write_text(
        "# Board\n## DOING\n## TODO\n"
        "- [ ] T-1 [P1] тест японский 日本語プロジェクト | verify: прогон "
        "コマンド検証\n## DONE\n## BLOCKED\n",
        encoding="utf-8",
    )
    cold_uni = ctx.context_cold(unicode_root, limit=2000)
    surf_uni = cold_uni.get("surface", "")
    expect(
        "context: bytes == len(surface.encode('utf-8')) and characters == "
        "len(surface) exactly (Cyrillic + Japanese)",
        cold_uni.get("bytes") == len(surf_uni.encode("utf-8"))
        and cold_uni.get("characters") == len(surf_uni),
        repr(
            (
                cold_uni.get("bytes"),
                len(surf_uni.encode("utf-8")),
                cold_uni.get("characters"),
                len(surf_uni),
            )
        ),
    )
    expect(
        "context: multibyte content makes real bytes > characters",
        cold_uni.get("bytes") > cold_uni.get("characters"),
        repr((cold_uni.get("bytes"), cold_uni.get("characters"))),
    )

    # ---- T-587: unresolved CONFLICT blocks every new mutation.
    from saipen_engine.journal import pending_conflicts

    root_c = make_project()
    saipen_c = root_c / ".saipen"
    log_c = (saipen_c / "LOG.md").read_bytes()
    state_c = (saipen_c / "STATE.md").read_bytes()
    new_log_c = log_c + b"\n- 09.08.26 00:01 [E-901] RUN: op\n"
    new_state_c = state_c.replace(b"phase: DONE", b"phase: BUILD")
    j_c = Journal(root_c, "op-conf")
    j_c.start(
        "checkpoint",
        "probe",
        runtime_lock_identity(root_c),
        "h",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": new_log_c,
                "before_hash": hash_bytes(log_c),
                "after_hash": hash_bytes(new_log_c),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": new_state_c,
                "before_hash": hash_bytes(state_c),
                "after_hash": hash_bytes(new_state_c),
            },
        ],
        verification_policy="core_fast",
    )
    (saipen_c / "LOG.md").write_bytes(new_log_c)
    j_c.mark("APPLYING", progress_index=1, target_index=0)
    external_c = state_c + b"\n# third party\n"
    (saipen_c / "STATE.md").write_bytes(external_c)
    res_c = recover(root_c, "op-conf")
    expect(
        "crash control A: changed unfinished write target CONFLICTs",
        res_c.get("code") == RECOVERY_REFUSED
        and (saipen_c / "STATE.md").read_bytes() == external_c,
        repr(res_c),
    )
    expect(
        "unresolved CONFLICT is listed by pending_ops",
        "op-conf" in [p["op_id"] for p in pending_ops(root_c)],
        repr(pending_ops(root_c)),
    )
    expect(
        "unresolved CONFLICT is listed by pending_conflicts",
        "op-conf" in [c["op_id"] for c in pending_conflicts(root_c)],
    )
    blocked_c = ticket_add(root_c, "probe", "P2", "after conflict", [], "verify")
    expect(
        "new mutation over unresolved CONFLICT refuses (RECOVERY_CONFLICT)",
        not blocked_c.get("ok") and blocked_c.get("code") == "RECOVERY_CONFLICT",
        repr(blocked_c),
    )
    pre_c = recovery_preflight(root_c)
    expect(
        "recovery preflight over a conflict refuses RECOVERY_CONFLICT",
        pre_c.get("code") == "RECOVERY_CONFLICT",
        repr(pre_c),
    )

    # ---- T-587 control B: read-only dependency drift -> CONFLICT.
    root_b = make_project()
    saipen_b = root_b / ".saipen"
    log_b = (saipen_b / "LOG.md").read_bytes()
    state_b = (saipen_b / "STATE.md").read_bytes()
    board_b = (saipen_b / "BOARD.md").read_bytes()
    new_log_b = log_b + b"\n- 09.08.26 00:01 [E-901] RUN: op\n"
    new_state_b = state_b.replace(b"phase: DONE", b"phase: BUILD")
    j_b = Journal(root_b, "op-rdep")
    j_b.start(
        "checkpoint",
        "probe",
        runtime_lock_identity(root_b),
        "h",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": new_log_b,
                "before_hash": hash_bytes(log_b),
                "after_hash": hash_bytes(new_log_b),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": new_state_b,
                "before_hash": hash_bytes(state_b),
                "after_hash": hash_bytes(new_state_b),
            },
        ],
        verification_policy="core_fast",
        read_preconditions={".saipen/BOARD.md": hash_bytes(board_b)},
    )
    (saipen_b / "LOG.md").write_bytes(new_log_b)
    j_b.mark("APPLYING", progress_index=1, target_index=0)
    (saipen_b / "BOARD.md").write_text(
        "# Board\n## DOING\n- [/] T-1 [P1] probe | owner: probe | "
        "claim_time: 2026-08-09T00:00:00Z\n## TODO\n## DONE\n## BLOCKED\n",
        encoding="utf-8",
    )
    res_b = recover(root_b, "op-rdep")
    expect(
        "crash control B: changed read-only dependency CONFLICTs",
        res_b.get("code") == "CONFLICT" and b"DOING" in (saipen_b / "BOARD.md").read_bytes(),
        repr(res_b),
    )
    expect(
        "recovered state never COMMITTED over a drifted read dependency",
        j_b.read()["status"] == "CONFLICT",
    )
    blocked_b = ticket_add(root_b, "probe", "P2", "after rdep", [], "verify")
    expect(
        "new mutation refuses after read-dependency conflict",
        not blocked_b.get("ok")
        and blocked_b.get("code") in ("RECOVERY_CONFLICT", "VALIDATION_FAILED"),
        repr(blocked_b),
    )

    # ---- T-587: semantically invalid recovered state cannot COMMIT.
    root_s = make_project()
    saipen_s = root_s / ".saipen"
    log_s = (saipen_s / "LOG.md").read_bytes()
    state_s = (saipen_s / "STATE.md").read_bytes()
    board_s = (saipen_s / "BOARD.md").read_bytes()
    new_log_s = log_s + b"\n- 09.08.26 00:01 [E-901] RUN: op\n"
    new_state_s = (
        b"---\nphase: DONE\ntask: none\n"
        b'next_action: "saipen continue"\n'
        b'blocker: ""\ntransition_from: SHIP\nsaipen_version: 7\n'
        b"schema_version: 3\nlast_event: 901\n"
        b'style_contract: ded-4ae736e4\nsaipen_home: "."\n'
        b"agent: probe\nmode: full\n"
        b"updated: 2026-08-09T00:00:00Z\n---\n"
    )
    j_s = Journal(root_s, "op-sem")
    j_s.start(
        "checkpoint",
        "probe",
        runtime_lock_identity(root_s),
        "h",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": new_log_s,
                "before_hash": hash_bytes(log_s),
                "after_hash": hash_bytes(new_log_s),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": new_state_s,
                "before_hash": hash_bytes(state_s),
                "after_hash": hash_bytes(new_state_s),
            },
        ],
        verification_policy="core_fast",
        read_preconditions={".saipen/BOARD.md": hash_bytes(board_s)},
    )
    (saipen_s / "LOG.md").write_bytes(new_log_s)
    j_s.mark("APPLYING", progress_index=1, target_index=0)
    # BOARD DOING T-1 but STATE task:none: byte-valid, semantically invalid.
    (saipen_s / "BOARD.md").write_text(
        "# Board\n## DOING\n- [/] T-1 [P1] probe | owner: probe | "
        "claim_time: 2026-08-09T00:00:00Z\n## TODO\n## DONE\n## BLOCKED\n",
        encoding="utf-8",
    )
    res_s = recover(root_s, "op-sem")
    expect(
        "recovered invalid state cannot become COMMITTED (CONFLICT)",
        res_s.get("code") == "CONFLICT" and j_s.read()["status"] == "CONFLICT",
        repr(res_s),
    )

    # ---- T-587: public saipen recover --json refuses a conflict.
    rec_c = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "recover", "--json"],
        cwd=str(root_c),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "saipen recover --json refuses a conflict and names the op",
        f'"code": "{RECOVERY_REFUSED}"' in rec_c.stdout and "op-conf" in rec_c.stdout,
        repr(rec_c.stdout[:200]),
    )

    # ---- T-587: real subprocess crash (NITRO_CRASH_AFTER_LOG) leaves a
    # recoverable op; an intervening read-dependency edit CONFLICTs recovery
    # and the conflict then blocks a new mutation -- through the live CLI.
    root_sp = make_project()
    saipen_sp = root_sp / ".saipen"
    _log_sp = (saipen_sp / "LOG.md").read_bytes()
    _state_sp = (saipen_sp / "STATE.md").read_bytes()
    _board_sp = (saipen_sp / "BOARD.md").read_bytes()
    crash_code = (
        "import sys, os; sys.path.insert(0, r'%s')\n"
        "os.environ['NITRO_CRASH_AFTER_LOG'] = '1'\n"
        "from saipen_engine.operations import checkpoint\n"
        "checkpoint(r'%s', 'probe', 'RUN', 'T-1', 'crash probe')"
        % (str(HOME / "tools"), str(root_sp))
    )
    rc = subprocess.run(
        [sys.executable, "-c", crash_code],
        cwd=str(root_sp),
        capture_output=True,
        text=True,
        timeout=60,
    ).returncode
    expect(
        "subprocess crash after LOG leaves an unresolved op",
        rc == 87 and bool(pending_ops(root_sp)),
        f"rc={rc}",
    )
    (saipen_sp / "BOARD.md").write_text(
        "# Board\n## DOING\n- [/] T-1 [P1] probe | owner: probe | "
        "claim_time: 2026-08-09T00:00:00Z\n## TODO\n## DONE\n## BLOCKED\n",
        encoding="utf-8",
    )
    from saipen_engine.journal import recover as _recover

    sp_recover = _recover(root_sp, pending_ops(root_sp)[0]["op_id"])
    expect(
        "crash-then-drifted-read-dep recover CONFLICTs in a real op",
        sp_recover.get("code") == "CONFLICT",
        repr(sp_recover),
    )
    sp_new = ticket_add(root_sp, "probe", "P2", "after sp crash", [], "verify")
    expect(
        "new mutation refuses after the subprocess-crash conflict",
        not sp_new.get("ok") and sp_new.get("code") in ("RECOVERY_CONFLICT", "VALIDATION_FAILED"),
        repr(sp_new),
    )

    # ---- T-590: shared router -- DONE + workable TODO routes to the ticket.
    from saipen_engine.router import route_next

    router_root = make_project()
    st_done = codec.read_doc(router_root / ".saipen" / "STATE.md")
    board_done = codec.read_doc(router_root / ".saipen" / "BOARD.md")
    routed = route_next(st_done, board_done)
    expect(
        "route_next on DONE + workable TODO routes to the ticket",
        routed.get("action") == "PHASE SCOUT T-1" and routed.get("reason") == "start",
        repr(routed),
    )
    routed_na = route_next(st_done, board_done, pending_ops=["op-x"])
    expect(
        "route_next puts recovery ahead of normal work",
        routed_na.get("action") == "saipen recover"
        and routed_na.get("reason") == "recovery-pending",
        repr(routed_na),
    )
    routed_conf = route_next(st_done, board_done, conflict_ops=["op-c"])
    expect(
        "route_next puts unresolved conflict ahead of everything",
        not routed_conf.get("ok")
        and routed_conf.get("action") == "saipen recover"
        and routed_conf.get("reason") == "recovery-conflict",
        repr(routed_conf),
    )

    # ---- T-590: ticket add refuses placeholder verify through the PUBLIC CLI.
    tac_root = make_project()
    tac_bad = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "ticket",
            "add",
            "P1",
            "no proof ticket",
            "--verify",
            "TBD",
            "--json",
        ],
        cwd=str(tac_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "ticket add with TBD verify REFUSEs INCOMPLETE_TICKET",
        '"code": "INCOMPLETE_TICKET"' in tac_bad.stdout,
        repr(tac_bad.stdout[:120]),
    )
    tac_good = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "ticket",
            "add",
            "P1",
            "proven ticket",
            "--verify",
            "validator green; scenario green",
            "--json",
        ],
        cwd=str(tac_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "ticket add with a real verify succeeds and never emits TBD",
        tac_good.returncode == 0
        and '"code": "TICKET_ADDED"' in tac_good.stdout
        and "verify: verify: TBD" not in codec.read_doc(tac_root / ".saipen" / "BOARD.md"),
        repr(tac_good.stdout[:160]),
    )

    # ---- T-590: saiui projection through the PUBLIC add path.
    up_ui_root = make_project()
    up_ui_add = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "userperson",
            "add",
            "Prefer Golden UI",
            "--category",
            "UI",
            "--json",
        ],
        cwd=str(up_ui_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    from userperson import parse_profile, project_profile

    up_ui_text = (up_ui_root / ".saipen" / "USERPERSON.md").read_text(encoding="utf-8-sig")
    proj_ui = project_profile(parse_profile(up_ui_text)["preferences"], "saiui")
    expect(
        "userperson add with distilled category projects to saiui",
        up_ui_add.returncode == 0
        and "Prefer Golden UI" in up_ui_text
        and any("Prefer Golden UI" in p["text"] for p in proj_ui["preferences"]),
        repr((up_ui_text, proj_ui)),
    )

    # ---- T-590: cold context includes the exact next ticket (not truncated).
    ctx_cold_root = make_project()
    cold_exact = ctx.context_cold(ctx_cold_root)
    expect(
        "cold context names the exact next ticket via the router",
        "PHASE SCOUT T-1" in cold_exact.get("surface", ""),
        repr(cold_exact.get("surface", "")[:300]),
    )

    # ---- T-590: goal_tickets bumps mechanically on VERIFY->REVIEW under goal.
    goal_root = make_project()
    (goal_root / ".saipen" / "STATE.md").write_text(
        codec.read_doc(goal_root / ".saipen" / "STATE.md").replace(
            "mode: full", "mode: full\nexecution_intent: goal\ngoal_waves: 1\ngoal_tickets: 5"
        ),
        encoding="utf-8",
    )
    apply_claim(goal_root, "T-1", "probe")
    transition_phase(goal_root, "BUILD", "probe", "T-1", "build")
    transition_phase(goal_root, "VERIFY", "probe", "T-1", "verify")
    verify_pass(goal_root)
    tr_g = transition_phase(goal_root, "REVIEW", "probe", "T-1", "review gate")
    st_g = parse_state(codec.read_doc(goal_root / ".saipen" / "STATE.md"))
    expect(
        "VERIFY->REVIEW under goal mechanically bumps goal_tickets",
        tr_g.get("ok") and st_g.get("goal_tickets") == 6,
        repr(st_g),
    )
    log_g = codec.read_doc(goal_root / ".saipen" / "LOG.md")
    expect(
        "goal_tickets bump emits the DEC line mechanically",
        "goal_tickets 5->6" in log_g,
        repr(log_g[-200:]),
    )

    # ---- T-590: HUNT->ADD under goal mechanically bumps goal_waves.
    wave_root = make_project()
    (wave_root / ".saipen" / "STATE.md").write_text(
        codec.read_doc(wave_root / ".saipen" / "STATE.md").replace(
            "mode: full", "mode: full\nexecution_intent: goal\ngoal_waves: 1\ngoal_tickets: 3"
        ),
        encoding="utf-8",
    )
    (wave_root / ".saipen" / "STATE.md").write_text(
        codec.read_doc(wave_root / ".saipen" / "STATE.md")
        .replace("phase: DONE", "phase: HUNT")
        .replace('next_action: "saipen continue"', 'next_action: "PHASE HUNT"'),
        encoding="utf-8",
    )
    tr_w = transition_phase(wave_root, "ADD", "probe", None, "wave gate")
    st_w = parse_state(codec.read_doc(wave_root / ".saipen" / "STATE.md"))
    expect(
        "HUNT->ADD under goal mechanically bumps goal_waves",
        tr_w.get("ok") and st_w.get("goal_waves") == 2,
        repr(st_w),
    )
    log_w = codec.read_doc(wave_root / ".saipen" / "LOG.md")
    expect(
        "goal_waves bump emits the DEC line mechanically",
        "goal_waves 1->2" in log_w,
        repr(log_w[-200:]),
    )

    # ---- T-590: committed-journal compaction preserves ALREADY_APPLIED.
    from saipen_engine.journal import compact_committed, run_mutation as _rm

    comp_root = make_project()
    c_res = apply_claim(comp_root, "T-1", "probe")
    op_dir = comp_root / ".saipen" / "recovery" / "ops" / c_res.get("op_id")
    staged_before = [p for p in op_dir.glob("*.staged")]
    expect(
        "a committed claim carries no staged bytes (auto-dropped at COMMIT)",
        len(staged_before) == 0,
        repr(staged_before),
    )
    compact_committed(comp_root)
    staged_after = [p for p in op_dir.glob("*.staged")]
    expect(
        "compaction leaves committed ops staged-free (idempotent)",
        len(staged_after) == 0,
        repr(staged_after),
    )
    # The retry must reproduce the claim record's semantic fingerprint.
    _j_comp = Journal(comp_root, c_res.get("op_id"))
    _rec_comp = _j_comp.read()
    rec_comp = _rm(
        comp_root,
        c_res.get("op_id"),
        _rec_comp.get("operation"),
        "probe",
        "id",
        _rec_comp.get("semantic_payload_hash"),
        [
            {"path": t["path"], "role": t["role"], "content": (comp_root / t["path"]).read_bytes()}
            for t in _rec_comp["targets"]
        ],
        skip_preflight=True,
        verification_policy=_rec_comp.get("verification_policy", "none"),
    )
    expect(
        "compacted op retried still returns ALREADY_APPLIED",
        rec_comp.get("code") == "ALREADY_APPLIED",
        repr(rec_comp),
    )
    # A conflict journal is never compacted.
    conf_root = make_project()
    saipen_conf = conf_root / ".saipen"
    log_cf = (saipen_conf / "LOG.md").read_bytes()
    state_cf = (saipen_conf / "STATE.md").read_bytes()
    j_cf = Journal(conf_root, "op-cf")
    j_cf.start(
        "checkpoint",
        "probe",
        runtime_lock_identity(conf_root),
        "h",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": log_cf + b"\n- 09.08.26 00:01 [E-901] RUN: x\n",
                "before_hash": hash_bytes(log_cf),
                "after_hash": hash_bytes(log_cf + b"\n- 09.08.26 00:01 [E-901] RUN: x\n"),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": state_cf.replace(b"phase: DONE", b"phase: BUILD"),
                "before_hash": hash_bytes(state_cf),
                "after_hash": hash_bytes(state_cf.replace(b"phase: DONE", b"phase: BUILD")),
            },
        ],
        verification_policy="core_fast",
    )
    (saipen_conf / "LOG.md").write_bytes(log_cf + b"\n- 09.08.26 00:01 [E-901] RUN: x\n")
    j_cf.mark("APPLYING", progress_index=1, target_index=0)
    (saipen_conf / "STATE.md").write_bytes(state_cf + b"\n# third party\n")
    recover(conf_root, "op-cf")
    compact_committed(conf_root)
    cf_staged = [p for p in (conf_root / ".saipen" / "recovery" / "ops" / "op-cf").glob("*.staged")]
    expect("a conflict journal is never compacted", len(cf_staged) > 0, repr(cf_staged))

    # ---- T-596: compaction is the bounded SETTLED maintenance op -- a
    # RESOLVED op compacts (tombstone keeps identity + final hashes), while
    # PREPARED / APPLYING journals are never compacted.
    res_root = make_project()
    saipen_res = res_root / ".saipen"
    log_rs = (saipen_res / "LOG.md").read_bytes()
    state_rs = (saipen_res / "STATE.md").read_bytes()
    j_rs = Journal(res_root, "op-rs")
    j_rs.start(
        "checkpoint",
        "probe",
        runtime_lock_identity(res_root),
        "h",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": log_rs + b"\n- 09.08.26 00:01 [E-901] RUN: x\n",
                "before_hash": hash_bytes(log_rs),
                "after_hash": hash_bytes(log_rs + b"\n- 09.08.26 00:01 [E-901] RUN: x\n"),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": state_rs.replace(b"phase: DONE", b"phase: BUILD"),
                "before_hash": hash_bytes(state_rs),
                "after_hash": hash_bytes(state_rs.replace(b"phase: DONE", b"phase: BUILD")),
            },
        ],
        verification_policy="core_fast",
    )
    (saipen_res / "LOG.md").write_bytes(log_rs + b"\n- 09.08.26 00:01 [E-901] RUN: x\n")
    j_rs.mark("APPLYING", progress_index=1, target_index=0)
    (saipen_res / "STATE.md").write_bytes(
        state_rs.replace(b"phase: DONE", b"phase: HUNT").replace(
            b"last_event: 900", b"last_event: 901"
        )
    )
    recover(res_root, "op-rs")
    from saipen_engine.journal import resolve_conflict as _rs_resolve

    _rs_resolve(res_root, "op-rs", "accept_live", agent="probe")
    # Terminal receipts move out of the active ops namespace immediately.
    # Resolve through Journal again so the test follows the canonical
    # active-or-settled locator instead of pinning the pre-T-1008 path.
    rs_dir = Journal(res_root, "op-rs").dir
    _rs_record = json.loads((rs_dir / "operation.json").read_text(encoding="utf-8"))
    compact_committed(res_root)
    rs_staged = list(rs_dir.glob("*.staged"))
    rs_record2 = json.loads((rs_dir / "operation.json").read_text(encoding="utf-8"))
    expect(
        "compaction compacts a RESOLVED journal (settled maintenance op)",
        len(rs_staged) == 0,
        repr(rs_staged),
    )
    expect(
        "compaction keeps the full tombstone for a resolved op",
        rs_record2.get("op_id") == "op-rs"
        and rs_record2.get("status") == "RESOLVED"
        and rs_record2.get("operation") == "checkpoint"
        and bool(rs_record2.get("semantic_payload_hash"))
        and bool(rs_record2.get("created_at"))
        and all(
            t.get("before_hash") and t.get("after_hash") for t in rs_record2.get("targets", [])
        ),
        repr(rs_record2),
    )
    pre_root = make_project()
    j_pre = Journal(pre_root, "op-pre")
    j_pre.start(
        "checkpoint",
        "probe",
        runtime_lock_identity(pre_root),
        "h",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": b"x",
                "before_hash": "a",
                "after_hash": "b",
            }
        ],
    )
    compact_committed(pre_root)
    pre_staged = list((pre_root / ".saipen" / "recovery" / "ops" / "op-pre").glob("*.staged"))
    expect(
        "a PREPARED journal is never compacted (evidence still required)",
        len(pre_staged) > 0,
        repr(pre_staged),
    )

    # ---- T-590: validator rejects a placeholder verify on a new ticket.
    vp_root = make_project()
    (vp_root / ".saipen" / "BOARD.md").write_text(
        "# Board\n## DOING\n## TODO\n"
        "- [ ] T-1 [P1] weak ticket | verify: TBD\n"
        "## DONE\n## BLOCKED\n",
        encoding="utf-8",
    )
    vp_proc = subprocess.run(
        [sys.executable, str(VALIDATOR), "--project-root", str(vp_root)],
        cwd=str(vp_root),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=120,
    )
    expect(
        "validator FAILs a new TODO ticket with placeholder verify",
        vp_proc.returncode != 0 and "placeholder verify" in (vp_proc.stdout + vp_proc.stderr),
        repr((vp_proc.stdout + vp_proc.stderr)[-300:]),
    )

    # ---- T-590: >8 TODO tickets with the 9th workable -- cold context must
    # include the exact next ticket (not truncated).
    ctx9_root = make_project()
    lines = ["# Board", "## DOING", "## TODO"]
    for i in range(8):
        lines.append(f"- [ ] T-{i + 1} [P1] unworkable {i + 1} | needs: T-10 | verify: probe")
    lines.append("- [ ] T-9 [P1] the workable one | verify: probe")
    lines += [
        "## DONE",
        "## BLOCKED",
        "- [ ] T-10 [P1] external prerequisite | blocker: WAIT_EXTERNAL -- probe | verify: probe",
    ]
    (ctx9_root / ".saipen" / "BOARD.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    cold9 = ctx.context_cold(ctx9_root)
    expect(
        "cold context includes the exact next ticket below the 8-ticket truncation boundary",
        "PHASE SCOUT T-9" in cold9.get("surface", "")
        and "the workable one" in cold9.get("surface", "")
        and "verify: probe" in cold9.get("surface", ""),
        repr(cold9.get("surface", "")[:400]),
    )

    # ---- T-590: PUBLIC adapter path -- every public NITRO command through
    # `python tools/saipen.py`, not just the engine functions.
    pub_root = make_project()
    pub_next = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "next", "--json"],
        cwd=str(pub_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "public `saipen next` routes DONE+workable to the ticket",
        '"action": "PHASE SCOUT T-1"' in pub_next.stdout,
        repr(pub_next.stdout[:160]),
    )
    pub_status = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "status", "--json"],
        cwd=str(pub_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "public `saipen status` exposes computed_next_action",
        '"computed_next_action": "PHASE SCOUT T-1"' in pub_status.stdout,
        repr(pub_status.stdout[:200]),
    )
    pub_context = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "context", "hot"],
        cwd=str(pub_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "public `saipen context hot` includes the computed next",
        "PHASE SCOUT T-1" in pub_context.stdout,
        repr(pub_context.stdout[:160]),
    )
    pub_sub = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "sub", "spawn", "saipub", "--json"],
        cwd=str(pub_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    if pub_sub.returncode != 0:
        # make_project writes saipen_home: "." which has no TEMPLATE; point the
        # fixture at the real home and retry so the public path is exercised.
        from saipen_engine.state import patch_state as _patch_state

        sp_state = pub_root / ".saipen" / "STATE.md"
        sp_state.write_text(
            _patch_state(codec.read_doc(sp_state), {"saipen_home": str(HOME)}), encoding="utf-8"
        )
        pub_sub = subprocess.run(
            [sys.executable, str(HOME / "tools" / "saipen.py"), "sub", "spawn", "saipub", "--json"],
            cwd=str(pub_root),
            capture_output=True,
            text=True,
            timeout=60,
        )
    expect(
        "public `saipen sub spawn` works through the adapter",
        pub_sub.returncode == 0 and '"code": "SPAWNED"' in pub_sub.stdout,
        repr(pub_sub.stdout[:160]),
    )
    pub_pause = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "sub", "pause", "saipub", "--json"],
        cwd=str(pub_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    pub_resume = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "sub", "resume", "saipub", "--json"],
        cwd=str(pub_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    expect(
        "public sub pause/resume work through the adapter",
        '"code": "SUB_PAUSED"' in pub_pause.stdout and '"code": "SUB_RESUMED"' in pub_resume.stdout,
        repr((pub_pause.stdout[:120], pub_resume.stdout[:120])),
    )

    # T-602: PUBLIC gate composition -- `ticket done` through the CLI after
    # claim->BUILD must REFUSE ILLEGAL_PHASE and write zero canonical bytes,
    # because REVIEW/SHIP never ran. The old claim->BUILD->done "validator
    # green" precedent was FALSE_EVIDENCE: it laundered an illegal execution
    # history into a legal-looking DONE (NITRO dogfood IV, T-602).
    pubc_root = make_project()
    pubc_claim = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "claim", "T-1", "--json"],
        cwd=str(pubc_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    pubc_tr = subprocess.run(
        [
            sys.executable,
            str(HOME / "tools" / "saipen.py"),
            "transition",
            "BUILD",
            "T-1",
            "b",
            "--json",
        ],
        cwd=str(pubc_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    pubc_done = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "ticket", "done", "T-1", "--json"],
        cwd=str(pubc_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    pubc_st = parse_state(codec.read_doc(pubc_root / ".saipen" / "STATE.md"))
    pubc_board = parse_board(codec.read_doc(pubc_root / ".saipen" / "BOARD.md"))
    pubc_t1 = pubc_board["tickets"]["T-1"]
    pubc_validator = subprocess.run(
        [sys.executable, str(VALIDATOR), "--project-root", str(pubc_root)],
        cwd=str(pubc_root),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=120,
    )
    expect(
        "public closure: claim->BUILD->ticket done REFUSEs ILLEGAL_PHASE",
        '"code": "CLAIMED"' in pubc_claim.stdout
        and '"code": "TRANSITIONED"' in pubc_tr.stdout
        and '"code": "ILLEGAL_PHASE"' in pubc_done.stdout,
        repr((pubc_claim.stdout[:80], pubc_tr.stdout[:80], pubc_done.stdout[:80])),
    )
    expect(
        "public closure: the refused done writes zero bytes (ticket stays "
        "DOING, phase stays BUILD)",
        pubc_st.get("phase") == "BUILD"
        and pubc_st.get("task") == "T-1"
        and pubc_t1["section"] == "## DOING",
        repr((pubc_st, pubc_t1["section"])),
    )
    expect(
        "public closure: the state stays validator-green after the refusal",
        pubc_validator.returncode == 0,
        pubc_validator.stdout[-300:] if pubc_validator.returncode else "",
    )

    # T-591: `saipen next` action/load agreement through the public path.
    pubn_root = make_project()
    pubn_next = subprocess.run(
        [sys.executable, str(HOME / "tools" / "saipen.py"), "next", "--json"],
        cwd=str(pubn_root),
        capture_output=True,
        text=True,
        timeout=60,
    )
    import json as _json

    try:
        pubn = _json.loads(pubn_next.stdout)
        load_ok = pubn.get("load") == "saipen/phases/scout.md"
    except Exception:
        load_ok = False
    expect(
        "public `saipen next` pairs action with the routed phase doc",
        '"action": "PHASE SCOUT T-1"' in pubn_next.stdout and load_ok,
        repr(pubn_next.stdout[:200]),
    )

    # ---- T-591 closure composition controls (NITRO dogfood III, section 10).
    from saipen_engine.operations import finish_ticket
    from saipen_engine.journal import recover as _recover_op

    # Control A: claim->BUILD->VERIFY->REVIEW->SHIP->FINISH -> validator PASS.
    cA = make_project()
    apply_claim(cA, "T-1", "probe")
    transition_phase(cA, "BUILD", "probe", "T-1", "b")
    transition_phase(cA, "VERIFY", "probe", "T-1", "v")
    verify_pass(cA)
    transition_phase(cA, "REVIEW", "probe", "T-1", "r")
    transition_phase(cA, "SHIP", "probe", "T-1", "s")
    finA = finish_ticket(cA, "T-1", "probe")
    stA = parse_state(codec.read_doc(cA / ".saipen" / "STATE.md"))
    expect(
        "closure control A: SHIP->FINISH ends DONE/task none",
        finA.get("ok") and stA.get("phase") == "DONE" and stA.get("task") == "none",
        repr(stA),
    )

    # Control B: after finish, no DOING, ticket DONE [x], next routes legally.
    boardB = parse_board(codec.read_doc(cA / ".saipen" / "BOARD.md"))
    doingB = [t for t in boardB["tickets"].values() if t["section"] == "## DOING"]
    t1B = boardB["tickets"]["T-1"]
    expect(
        "closure control B: no DOING + ticket DONE[x] after finish",
        not doingB and t1B["section"] == "## DONE" and t1B["checkbox"] == "x",
        repr((doingB, t1B["checkbox"])),
    )

    # Control C: crash during FINISH after LOG -> recovery -> validator PASS.
    cC = make_project()
    apply_claim(cC, "T-1", "probe")
    transition_phase(cC, "BUILD", "probe", "T-1", "b")
    transition_phase(cC, "VERIFY", "probe", "T-1", "v")
    verify_pass(cC)
    transition_phase(cC, "REVIEW", "probe", "T-1", "r")
    transition_phase(cC, "SHIP", "probe", "T-1", "s")
    # finish with crash after LOG (the ticket is in SHIP -- the only legal
    # closure phase; T-602 gate)
    crash_code = (
        "import sys, os; sys.path.insert(0, r'%s')\n"
        "os.environ['NITRO_CRASH_AFTER_LOG'] = '1'\n"
        "from saipen_engine.operations import finish_ticket\n"
        "finish_ticket(r'%s', 'T-1', 'probe')" % (str(HOME / "tools"), str(cC))
    )
    rc = subprocess.run(
        [sys.executable, "-c", crash_code], cwd=str(cC), capture_output=True, text=True, timeout=60
    ).returncode
    _pending_cC = pending_ops(cC)
    expect(
        "closure control C: crash during finish leaves an unresolved op",
        rc == 87 and bool(_pending_cC),
        f"rc={rc}",
    )
    # A harness that raises on the FIRST unmet expectation hides every control
    # after it: the expectation above already recorded the failure, so recovery
    # is only attempted when there is actually an op to recover.
    if _pending_cC:
        _recover_op(cC, _pending_cC[0]["op_id"])
    boardC = parse_board(codec.read_doc(cC / ".saipen" / "BOARD.md"))
    stC = parse_state(codec.read_doc(cC / ".saipen" / "STATE.md"))
    expect(
        "closure control C: recovery finishes exactly one ticket",
        boardC["tickets"]["T-1"]["section"] == "## DONE"
        and stC.get("phase") == "DONE"
        and stC.get("task") == "none",
        repr((boardC["tickets"]["T-1"]["section"], stC.get("phase"))),
    )

    # Control E: repeat FINISH same op_id -> ALREADY_APPLIED, no 2nd event.
    cE = make_project()
    apply_claim(cE, "T-1", "probe")
    transition_phase(cE, "BUILD", "probe", "T-1", "b")
    transition_phase(cE, "VERIFY", "probe", "T-1", "v")
    verify_pass(cE)
    transition_phase(cE, "REVIEW", "probe", "T-1", "r")
    transition_phase(cE, "SHIP", "probe", "T-1", "s")
    from saipen_engine.plan import apply_plan as _apply_plan
    from saipen_engine.operations import _now as _now_e, _plan_finish_ticket, _utc_iso as _utc_e

    planE = _plan_finish_ticket(cE, "T-1", "probe", _now_e(), _utc_e())
    finE1 = _apply_plan(cE, planE)
    logE = codec.read_doc(cE / ".saipen" / "LOG.md")
    countE = logE.count(f"E-{finE1.get('event_id')[2:]}")
    # Apply the SAME plan object again: the committed op's retry must return
    # ALREADY_APPLIED with no second completion event.
    retryE = _apply_plan(cE, planE)
    expect(
        "closure control E: repeat finish returns ALREADY_APPLIED",
        retryE.get("code") == "ALREADY_APPLIED",
        repr(retryE),
    )
    expect(
        "closure control E: no second completion event",
        codec.read_doc(cE / ".saipen" / "LOG.md").count(f"E-{finE1.get('event_id')[2:]}") == countE,
    )

    # Control F: old ticket done cannot leave REVIEW/T-X + BOARD DONE (the
    # split is now refused at plan time).
    cF = make_project()
    apply_claim(cF, "T-1", "probe")
    transition_phase(cF, "BUILD", "probe", "T-1", "b")
    transition_phase(cF, "VERIFY", "probe", "T-1", "v")
    verify_pass(cF)
    transition_phase(cF, "REVIEW", "probe", "T-1", "r")
    from saipen_engine.operations import _now as _now_f, _ticket_targets, _utc_iso as _utc_f

    split_res = _ticket_targets(cF, "done", "T-1", "probe", "", _now_f(), _utc_f())
    stF = parse_state(codec.read_doc(cF / ".saipen" / "STATE.md"))
    boardF = parse_board(codec.read_doc(cF / ".saipen" / "BOARD.md"))
    expect(
        "closure control F: raw done split is refused (no REVIEW/T-X + BOARD DONE)",
        isinstance(split_res, Result)
        and not split_res.get("ok")
        and stF.get("phase") == "REVIEW"
        and boardF["tickets"]["T-1"]["section"] == "## DOING",
        repr((split_res, stF.get("phase"), boardF["tickets"]["T-1"]["section"])),
    )

    # ---- NITRO dogfood IV (T-602): the finish GATE. `finish_ticket` may only
    # close a ticket from phase SHIP; from SCOUT/BUILD/VERIFY/REVIEW it REFUSEs
    # ILLEGAL_PHASE with zero canonical bytes written, and transition_from
    # records the ACTUAL phase -- never a laundered SHIP.
    from saipen_engine.operations import finish_ticket as _gate_ft
    from saipen_engine.operations import _now as _now_g, _utc_iso as _utc_g
    from saipen_engine.plan import apply_plan as _gate_apply_plan
    from saipen_engine.state import patch_state as _gate_patch_state
    import hashlib as _gate_hashlib

    def _tree_hash(_root: Path) -> str:
        _h = _gate_hashlib.sha256()
        for _p in sorted((_root / ".saipen").rglob("*")):
            if _p.is_file():
                _h.update(_p.relative_to(_root).as_posix().encode("utf-8"))
                _h.update(_p.read_bytes())
        return _h.hexdigest()[:16]

    gate_cases = [
        ("SCOUT", []),
        ("BUILD", ["BUILD"]),
        ("VERIFY", ["BUILD", "VERIFY"]),
        ("REVIEW", ["BUILD", "VERIFY", "REVIEW"]),
    ]
    for _phase, _steps in gate_cases:
        _g = make_project()
        apply_claim(_g, "T-1", "probe")
        for _step in _steps:
            if _step == "REVIEW":
                verify_pass(_g)
            transition_phase(_g, _step, "probe", "T-1", "g")
        _before = _tree_hash(_g)
        _res = _gate_ft(_g, "T-1", "probe")
        _after = _tree_hash(_g)
        _st = parse_state(codec.read_doc(_g / ".saipen" / "STATE.md"))
        expect(
            f"gate control: finish from {_phase} REFUSEs ILLEGAL_PHASE",
            _res.get("code") == "ILLEGAL_PHASE" and not _res.get("ok"),
            repr(_res),
        )
        expect(
            f"gate control: finish from {_phase} writes zero canonical bytes",
            _before == _after,
            f"tree changed {_before} -> {_after}",
        )
        expect(
            f"gate control: finish from {_phase} leaves phase/task untouched",
            _st.get("phase") == _phase and _st.get("task") == "T-1",
            repr(_st),
        )

    # Gate control D: the FULL legal chain claim->BUILD->VERIFY->REVIEW->SHIP
    # -> finish -> FINISHED; transition_from is the ACTUAL phase (SHIP) and the
    # resulting repository is validator-green.
    gD = make_project()
    apply_claim(gD, "T-1", "probe")
    for _step in ("BUILD", "VERIFY", "REVIEW", "SHIP"):
        if _step == "REVIEW":
            verify_pass(gD)
        transition_phase(gD, _step, "probe", "T-1", "d")
    _gD_res = _gate_ft(gD, "T-1", "probe")
    _gD_st = parse_state(codec.read_doc(gD / ".saipen" / "STATE.md"))
    expect(
        "gate control D: full chain SHIP->finish ends FINISHED",
        _gD_res.get("ok")
        and _gD_res.get("code") == "FINISHED"
        and _gD_st.get("phase") == "DONE"
        and _gD_st.get("transition_from") == "SHIP",
        repr(_gD_st),
    )
    _gD_val = subprocess.run(
        [sys.executable, str(VALIDATOR), "--project-root", str(gD)],
        cwd=str(gD),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=120,
    )
    expect(
        "gate control D: full chain ends validator-green",
        _gD_val.returncode == 0,
        _gD_val.stdout[-300:],
    )

    # [gate-closure] validator red control (T-602): a fabricated non-SHIP
    # finish event AT/AFTER the first SHIP-finish boundary FAILs the
    # validator; the identical LOG with only the SHIP-finish passes.
    def _gate_project(log_events: list[tuple[str, str]]) -> Path:
        _r = make_project()
        _sf = _r / ".saipen"
        # T-1361 CL-06: this rewrites the fixture's whole history, and the
        # fixture's history is where T-1 and T-2 get the allocation events
        # CORE-003 / SRC-026:R003 requires. Seeding from the base event alone
        # made the INTENDED-GREEN leg fail on unallocated board records, so
        # the control read (1, 1) -- both legs red, which proves nothing about
        # the gate closure it exists to test. Keep the allocations.
        _log = (
            "- 09.08.26 00:00 [E-898] [T-1] [agent: probe] [op: ticket-fixture] "
            "DEC: ticket added via SAIOPS\n"
            "- 09.08.26 00:00 [E-899] [T-2] [agent: probe] [op: ticket-fixture] "
            "DEC: ticket added via SAIOPS\n"
            "- 09.08.26 00:00 [E-900] [T-none] DEC: base\n"
        )
        _e = 900
        for _msg, _tid in log_events:
            _e += 1
            _ticket = f"[{_tid}] " if _tid else ""
            _log += f"- 09.08.26 00:01 [E-{_e}] {_ticket}DEC: {_msg}\n"
        (_sf / "LOG.md").write_text(_log, encoding="utf-8")
        _st = (_sf / "STATE.md").read_text(encoding="utf-8")
        _st = _st.replace("last_event: 900", f"last_event: {_e}")
        (_sf / "STATE.md").write_text(_st, encoding="utf-8")
        return _r

    _g_ok = _gate_project(
        [
            ("ticket finished via SAIOPS -- completion (from SHIP)", "T-1"),
        ]
    )
    _g_ok_val = subprocess.run(
        [sys.executable, str(VALIDATOR), "--project-root", str(_g_ok)],
        cwd=str(_g_ok),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=120,
    )
    _g_bad = _gate_project(
        [
            ("ticket finished via SAIOPS -- completion (from SHIP)", "T-1"),
            ("ticket finished via SAIOPS -- completion (from VERIFY)", "T-2"),
        ]
    )
    _g_bad_val = subprocess.run(
        [sys.executable, str(VALIDATOR), "--project-root", str(_g_bad)],
        cwd=str(_g_bad),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=120,
    )
    expect(
        "gate-closure red control: pre-boundary history passes, "
        "post-boundary non-SHIP finish FAILs the validator",
        _g_ok_val.returncode == 0 and _g_bad_val.returncode != 0,
        repr((_g_ok_val.returncode, _g_bad_val.returncode))
        + "\nOK-STDOUT:\n"
        + _g_ok_val.stdout[-1200:]
        + "\nBAD-STDOUT:\n"
        + _g_bad_val.stdout[-1200:],
    )

    # Mutation red-control: removing the SHIP precondition (restoring the old
    # closure_from = "SHIP" laundering) must flip the BUILD-refuse control to
    # FINISHED -- proving the refuse controls are coupled to the gate, not
    # vacuous.
    import inspect as _gate_inspect
    from saipen_engine import operations as _gate_ops
    from saipen_engine.router import route_next as _gate_route_next

    _gate_src = _gate_inspect.getsource(_gate_ops._plan_finish_ticket)
    _gate_src = _gate_src.replace("    from .router import route_next\n", "")
    _gate_start = _gate_src.index("    # GATE: the canonical closure is SHIP -> DONE")
    _gate_end = _gate_src.index("    closure_from = prev_phase", _gate_start)
    _gate_end = _gate_src.index("\n", _gate_end) + 1
    _gate_mut = _gate_src[:_gate_start] + '    closure_from = "SHIP"\n' + _gate_src[_gate_end:]
    _gate_ns = dict(vars(_gate_ops))
    _gate_ns["route_next"] = _gate_route_next
    exec(compile(_gate_mut, "<mutated-finish-no-gate>", "exec"), _gate_ns)
    _gate_mut_pft = _gate_ns["_plan_finish_ticket"]
    _gM = make_project()
    apply_claim(_gM, "T-1", "probe")
    transition_phase(_gM, "BUILD", "probe", "T-1", "m")
    verify_cycle(_gM)
    _mut_plan = _gate_mut_pft(_gM, "T-1", "probe", _now_g(), _utc_g())
    _mut_res = _gate_apply_plan(_gM, _mut_plan)
    expect(
        "mutation red-control: removing the SHIP gate makes the BUILD "
        "closure succeed (the refuse controls are NOT vacuous)",
        _mut_res.get("ok") and _mut_res.get("code") == "FINISHED",
        repr(_mut_res),
    )

    # Gate control E (goal counter composition): goal_tickets bumps
    # mechanically at VERIFY->REVIEW under execution_intent goal -- NEVER at
    # finish. The safety valve can trip MID-ticket: VERIFY->REVIEW at cap
    # leaves phase REVIEW, ticket DOING, goal_tickets at cap, next_action the
    # exact safety-valve WAIT; premature finish behind the valve refuses; after
    # explicit reauthorization the chain continues REVIEW -> SHIP -> FINISH
    # legally.
    gE = make_project()
    set_goal_intent(gE, "probe", "valve mid-ticket control")
    apply_claim(gE, "T-1", "probe")
    transition_phase(gE, "BUILD", "probe", "T-1", "e")
    transition_phase(gE, "VERIFY", "probe", "T-1", "e")
    verify_pass(gE)
    transition_phase(gE, "REVIEW", "probe", "T-1", "e")
    _stE = parse_state(codec.read_doc(gE / ".saipen" / "STATE.md"))
    expect(
        "gate control E: VERIFY->REVIEW bumps goal_tickets (0->1), never at finish",
        _stE.get("goal_tickets") == 1 and _stE.get("phase") == "REVIEW",
        repr(_stE),
    )
    # drive goal_tickets to just under the cap: the VERIFY->REVIEW bump must
    # be the mechanical owner of reaching the cap
    _stateE = gE / ".saipen" / "STATE.md"
    _textE = _gate_patch_state(codec.read_doc(_stateE), {"goal_tickets": 19})
    _stateE.write_text(_textE, encoding="utf-8")
    transition_phase(gE, "BUILD", "probe", "T-1", "e2")
    transition_phase(gE, "VERIFY", "probe", "T-1", "e2")
    verify_pass(gE)
    _rv = transition_phase(gE, "REVIEW", "probe", "T-1", "e2")
    _stV = parse_state(codec.read_doc(_stateE))
    expect(
        "valve control: VERIFY->REVIEW trips at the 20-ticket cap",
        _rv.get("ok")
        and _stV.get("goal_tickets") == 20
        and _stV.get("phase") == "REVIEW"
        and _stV.get("task") == "T-1",
        repr((_rv, _stV)),
    )
    expect(
        "valve control: next_action is the exact safety-valve WAIT",
        _stV.get("next_action").startswith("WAIT: safety valve reached")
        and "run 'cc' to continue" in _stV.get("next_action"),
        repr(_stV.get("next_action")),
    )
    _bdV = parse_board(codec.read_doc(gE / ".saipen" / "BOARD.md"))
    _doingV = [t for t in _bdV["tickets"].values() if t["section"] == "## DOING"]
    expect(
        "valve control: the ticket stays DOING behind the valve",
        len(_doingV) == 1 and _doingV[0]["id"] == "T-1",
        repr(_doingV),
    )
    _finV = _gate_ft(gE, "T-1", "probe")
    expect(
        "valve control: finish behind the valve REFUSEs ILLEGAL_PHASE",
        _finV.get("code") == "ILLEGAL_PHASE",
        repr(_finV),
    )
    _re = reauthorize_valve(gE, "probe")
    expect(
        "valve control: explicit reauthorization resets the counters",
        _re.get("ok") and _re.get("code") == "VALVE_REAUTHORIZED",
        repr(_re),
    )
    transition_phase(gE, "SHIP", "probe", "T-1", "e3")
    _finV2 = _gate_ft(gE, "T-1", "probe")
    _stV3 = parse_state(codec.read_doc(_stateE))
    expect(
        "valve control: after reauthorization REVIEW->SHIP->FINISH completes",
        _finV2.get("ok")
        and _finV2.get("code") == "FINISHED"
        and _stV3.get("phase") == "DONE"
        and _stV3.get("transition_from") == "SHIP",
        repr(_stV3),
    )

    # Router precedent controls (section 12-15): WAIT/BLOCKED stop before
    # START.
    from saipen_engine.router import route_next as _route_next

    rc_state = (
        "---\nphase: BLOCKED\ntask: none\n"
        'next_action: "WAIT: user brake -- user asked to stop"\n'
        'blocker: "user brake"\ntransition_from: SHIP\n'
        "saipen_version: 7\nschema_version: 3\nlast_event: 900\n"
        'style_contract: ded-4ae736e4\nsaipen_home: "."\n'
        "agent: probe\nmode: full\n"
        "updated: 2026-08-09T00:00:00Z\n---\n"
    )
    rc_board = (
        "# Board\n## DOING\n## TODO\n- [ ] T-1 [P1] probe | verify: probe\n## DONE\n## BLOCKED\n"
    )
    rcA = _route_next(rc_state, rc_board)
    expect(
        # T-1361 CL-06. This fixture sets THREE brakes at once: phase BLOCKED,
        # a non-empty blocker, and a persisted WAIT. T-1322 unified them into
        # ONE classifier (`state.binding_brake`) shared with the admission
        # guard, and it reports `phase == BLOCKED` first -- so `wait` is
        # unreachable HERE by construction, not broken. What the check is
        # actually about, a user brake outranking START, still holds: the
        # router stops and restates rather than advertising board work. The
        # WAIT branch keeps its own control below, so unifying the brake does
        # not quietly cost us the precedence this line used to prove.
        "router: user brake outranks START (RESTATE_AND_STOP)",
        rcA.get("reason") == "unblock" and rcA.get("executable_behavior") == "RESTATE_AND_STOP",
        repr(rcA),
    )
    rc_wait_state = (
        "---\nphase: DONE\ntask: none\n"
        'next_action: "WAIT: user brake -- user asked to stop"\n'
        'blocker: ""\ntransition_from: SHIP\n'
        "saipen_version: 7\nschema_version: 3\nlast_event: 900\n"
        'style_contract: ded-4ae736e4\nsaipen_home: "."\n'
        "agent: probe\nmode: full\n"
        "updated: 2026-08-09T00:00:00Z\n---\n"
    )
    rcW = _route_next(rc_wait_state, rc_board)
    expect(
        "router: a persisted WAIT alone is still classified `wait`, not board work",
        rcW.get("reason") == "wait" and rcW.get("executable_behavior") == "RESTATE_AND_STOP",
        repr(rcW),
    )

    # ---- T-592: conflict inspection + safe resolution lifecycle.
    from saipen_engine.journal import (
        inspect_op as _inspect_op,
        resolve_conflict as _resolve_conflict,
    )

    conf_root = make_project()
    saipen_cf = conf_root / ".saipen"
    log_cf = (saipen_cf / "LOG.md").read_bytes()
    state_cf = (saipen_cf / "STATE.md").read_bytes()
    new_log_cf = log_cf + b"\n- 09.08.26 00:01 [E-901] RUN: op\n"
    new_state_cf = state_cf.replace(b"phase: DONE", b"phase: BUILD")
    j_cf = Journal(conf_root, "op-t592")
    j_cf.start(
        "checkpoint",
        "probe",
        runtime_lock_identity(conf_root),
        "h",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": new_log_cf,
                "before_hash": hash_bytes(log_cf),
                "after_hash": hash_bytes(new_log_cf),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": new_state_cf,
                "before_hash": hash_bytes(state_cf),
                "after_hash": hash_bytes(new_state_cf),
            },
        ],
        verification_policy="core_fast",
    )
    (saipen_cf / "LOG.md").write_bytes(new_log_cf)
    j_cf.mark("APPLYING", progress_index=1, target_index=0)
    external_cf = state_cf.replace(b"phase: DONE", b"phase: HUNT").replace(
        b"last_event: 900", b"last_event: 901"
    )
    (saipen_cf / "STATE.md").write_bytes(external_cf)
    recover(conf_root, "op-t592")
    insp = _inspect_op(conf_root, "op-t592")
    expect(
        "conflict inspect reports the conflicting location read-only",
        insp.get("code") == "CONFLICT_INSPECT"
        and insp.get("conflicting_locations") == [".saipen/STATE.md"]
        and insp.get("safe_resolution_classes") == ["accept_live", "replan"],
        repr(insp),
    )
    # Only the selected conflict may be settled: a second unrelated unresolved
    # op blocks.
    second_log = (saipen_cf / "LOG.md").read_bytes()
    j2 = Journal(conf_root, "op-other")
    j2.start(
        "checkpoint",
        "probe",
        runtime_lock_identity(conf_root),
        "h",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": second_log,
                "before_hash": hash_bytes(second_log),
                "after_hash": hash_bytes(second_log),
            },
        ],
        verification_policy="core_fast",
    )
    j2.mark("APPLYING", progress_index=1, target_index=0)
    blocked_res = _resolve_conflict(conf_root, "op-t592", "accept_live")
    expect(
        "resolution refuses when another unrelated op is unresolved",
        not blocked_res.get("ok") and blocked_res.get("code") == "RECOVERY_REQUIRED",
        repr(blocked_res),
    )
    # Clear the unrelated op (abort it: PREPARED-nothing-applied) then resolve.
    j2.mark("ABORTED")
    res_cf = _resolve_conflict(conf_root, "op-t592", "accept_live", agent="probe")
    expect(
        "accept_live settles the conflict (RESOLVED)",
        res_cf.get("ok")
        and res_cf.get("code") == "RESOLVED"
        and res_cf.get("resolution") == "accept_live"
        and res_cf.get("applied_targets") == [".saipen/LOG.md"]
        and res_cf.get("skipped_targets") == [".saipen/STATE.md"],
        repr(res_cf),
    )
    expect(
        "pending_ops clears after resolution",
        "op-t592" not in [p["op_id"] for p in pending_ops(conf_root)],
    )
    new_mut = ticket_add(conf_root, "probe", "P2", "after conflict resolve", [], "verify")
    expect(
        "a new mutation succeeds after the conflict is resolved", new_mut.get("ok"), repr(new_mut)
    )
    # REPLAN branch: a fresh conflict resolved as replan retires the op.
    conf2 = make_project()
    saipen2 = conf2 / ".saipen"
    log2 = (saipen2 / "LOG.md").read_bytes()
    state2 = (saipen2 / "STATE.md").read_bytes()
    new_log2 = log2 + b"\n- 09.08.26 00:01 [E-901] RUN: op\n"
    new_state2 = state2.replace(b"phase: DONE", b"phase: BUILD")
    j3 = Journal(conf2, "op-replan")
    j3.start(
        "checkpoint",
        "probe",
        runtime_lock_identity(conf2),
        "h",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": new_log2,
                "before_hash": hash_bytes(log2),
                "after_hash": hash_bytes(new_log2),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": new_state2,
                "before_hash": hash_bytes(state2),
                "after_hash": hash_bytes(new_state2),
            },
        ],
        verification_policy="core_fast",
    )
    (saipen2 / "LOG.md").write_bytes(new_log2)
    j3.mark("APPLYING", progress_index=1, target_index=0)
    ext2 = state2.replace(b"phase: DONE", b"phase: HUNT").replace(
        b"last_event: 900", b"last_event: 901"
    )
    (saipen2 / "STATE.md").write_bytes(ext2)
    recover(conf2, "op-replan")
    res2 = _resolve_conflict(conf2, "op-replan", "replan", agent="probe")
    expect(
        "replan retires the conflict op (RESOLVED)",
        res2.get("ok") and res2.get("code") == "RESOLVED" and res2.get("resolution") == "replan",
        repr(res2),
    )
    expect(
        "replan does not touch live canonical bytes",
        b"phase: HUNT" in (saipen2 / "STATE.md").read_bytes(),
    )

    return problems, checked


def run_last_event_probes() -> tuple[list[str], int]:
    """Execute the legacy-schema to current-schema checkpoint migration."""
    problems = []
    checked = 0

    def validate(project: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(VALIDATOR), "--project-root", str(project)],
            cwd=project,
            capture_output=True,
            text=True,
            errors="replace",
        )

    def expect(
        label: str,
        result: subprocess.CompletedProcess[str],
        returncode: int,
        contains: str,
        excludes: tuple[str, ...] = (),
    ) -> None:
        nonlocal checked
        checked += 1
        output = result.stdout + result.stderr
        missing = contains not in output
        leaked = next((value for value in excludes if value in output), None)
        if result.returncode != returncode or missing or leaked:
            details = []
            if result.returncode != returncode:
                details.append(f"exit {result.returncode}, expected {returncode}")
            if missing:
                details.append(f"missing {contains!r}")
            if leaked:
                details.append(f"unexpected {leaked!r}")
            problems.append(f"{label}: {'; '.join(details)}")
        else:
            print(f"PASS: last_event -- {label}")

    with tempfile.TemporaryDirectory(prefix="saipen-last-event-") as raw:
        project = Path(raw) / "project"
        shutil.copytree(SCENARIOS / "stale-state-reconciliation" / ".saipen", project / ".saipen")
        state_path = project / ".saipen" / "STATE.md"
        log_path = project / ".saipen" / "LOG.md"

        expect(
            "legacy absence warns but remains readable",
            validate(project),
            0,
            "WARN [schema-version]",
            ("requires last_event",),
        )

        state = state_path.read_text(encoding="utf-8-sig")
        state = state.replace("saipen_version: 7\n", "saipen_version: 7\nschema_version: 3\n", 1)
        state_path.write_text(state, encoding="utf-8", newline="\n")
        expect("current schema missing marker fails", validate(project), 1, "requires last_event")

        state = state_path.read_text(encoding="utf-8")
        state = state.replace("schema_version: 3\n", "schema_version: 3\nlast_event: 1\n", 1)
        state_path.write_text(state, encoding="utf-8", newline="\n")
        # The voice marker is the half a cold session can skip in silence:
        # every other required field is derivable from `.saipen/` itself, so
        # an agent that never opened STYLE.md fills the state in completely
        # and looks conformant. Checked on its own, between two states that
        # differ by that one line.
        expect(
            "current schema missing style marker fails",
            validate(project),
            1,
            "requires style_contract",
        )

        state = state_path.read_text(encoding="utf-8")
        state = state.replace(
            "last_event: 1\n", f"last_event: 1\nstyle_contract: {live_style_marker()}\n", 1
        )
        state_path.write_text(state, encoding="utf-8", newline="\n")
        expect(
            "exact recovered tail passes",
            validate(project),
            0,
            "Validation complete. Agent is conformant.",
            ("WARN [schema-version]", "FAIL: STATE.md last_event"),
        )

        log = log_path.read_text(encoding="utf-8-sig").rstrip()
        log += "\n- 26.07.17 00:01 [E-002] [parent: E-001] [T-001] RUN: checkpoint advanced\n"
        log_path.write_text(log, encoding="utf-8", newline="\n")
        # A recoverable checkpoint drift is deliberately a warning: the
        # reconciliation command repairs it, while the validator remains
        # usable for ordinary continuation.
        expect("advanced LOG makes old marker stale", validate(project), 0, "lower than the log")

        state = state_path.read_text(encoding="utf-8")
        state_path.write_text(
            state.replace("last_event: 1\n", "last_event: 2\n", 1), encoding="utf-8", newline="\n"
        )
        expect(
            "recovered exact tail passes",
            validate(project),
            0,
            "Validation complete. Agent is conformant.",
            ("FAIL: STATE.md last_event",),
        )

        state = state_path.read_text(encoding="utf-8")
        state_path.write_text(
            state.replace("last_event: 2\n", "last_event: 3\n", 1), encoding="utf-8", newline="\n"
        )
        expect("marker above LOG is repairable drift", validate(project), 0, "higher than the log")

    return problems, checked


def run_log_tail_probes() -> tuple[list[str], int]:
    """T-633 root cause: log_tail_event must return the ACTUAL maximum E-###
    across the LOG text, independent of line or file enumeration order.

    The old implementation returned the FINAL parsed E-###, so 'E-100 then
    E-9' minted a tail of 9 and a next checkpoint allocated E-10 -- reusing
    an already-used id. Allocation correctness never depends on ordering."""
    from saipen_engine import operations as _ops
    from saipen_engine.log import log_tail_event

    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if not ok:
            problems.append(f"{label}: {detail}")
        else:
            print(f"PASS: log-tail -- {label}")

    line = "- 09.08.26 00:00 [E-{n}] [parent: E-{p}] [T-none] DEC: ctl\n"
    e100_then_9 = line.format(n=100, p=99) + line.format(n=9, p=8)
    expect(
        "E-100 then E-9 returns 100 (not the final parsed 9)",
        log_tail_event(e100_then_9) == 100,
        repr(log_tail_event(e100_then_9)),
    )
    expect(
        "reordered (E-9 first) still returns 100",
        log_tail_event(line.format(n=9, p=8) + line.format(n=100, p=99)) == 100,
        repr(log_tail_event(line.format(n=9, p=8) + line.format(n=100, p=99))),
    )
    expect("empty text returns None", log_tail_event("") is None, repr(log_tail_event("")))
    expect(
        "999 vs 1000: max wins regardless of order",
        log_tail_event(line.format(n=999, p=998) + line.format(n=1000, p=999)) == 1000,
        repr(log_tail_event(line.format(n=999, p=998) + line.format(n=1000, p=999))),
    )

    # Engine-level: a checkpoint after a seal derives max(E)+1 exactly once,
    # and segment enumeration order cannot change allocation.
    root = Path(tempfile.mkdtemp(prefix="saipen-logtail-"))
    saipen = root / ".saipen"
    saipen.mkdir()
    logs = saipen / "logs"
    logs.mkdir()
    # Two sealed segments with a HIGHER event in the older file and the active
    # log empty after the seal -- the tail must be the global max.
    (logs / "LOG-001.md").write_text(
        line.format(n=100, p=99) + line.format(n=9, p=8), encoding="utf-8"
    )
    (logs / "LOG-002.md").write_text(line.format(n=50, p=49), encoding="utf-8")
    (saipen / "LOG.md").write_text("", encoding="utf-8")
    (saipen / "BOARD.md").write_text(
        "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
    )
    (saipen / "STATE.md").write_text(
        '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
        'blocker: ""\ntransition_from: SHIP\nsaipen_version: 7\n'
        "schema_version: 3\nlast_event: 100\nstyle_contract: ded-4ae736e4\n"
        'saipen_home: "."\nagent: probe\nmode: full\n'
        "updated: 2026-08-09T00:00:00Z\n---\n",
        encoding="utf-8",
    )
    _docs, _state, _board, _tail = _ops._read(root)
    expect(
        "engine tail across sealed segments + empty active = global max", _tail == 100, repr(_tail)
    )
    # Segment 999 vs 1000 names: numeric sort, never lexicographic.
    (logs / "LOG-999.md").write_text(line.format(n=3, p=2), encoding="utf-8")
    (logs / "LOG-1000.md").write_text(line.format(n=4, p=3), encoding="utf-8")
    _docs, _state, _board, _tail2 = _ops._read(root)
    expect("LOG-1000 sorts after LOG-999 numerically; tail still 100", _tail2 == 100, repr(_tail2))
    # Next checkpoint allocates max(E)+1 exactly once from the global max.
    _event, _rendered = _ops._event_line(
        _docs,
        _tail2,
        "DEC",
        "T-none",
        "probe",
        "log-tail control: next allocation",
        "09.08.26 00:01",
    )
    expect(
        "next checkpoint allocates max(E)+1 = 101 exactly once",
        _event == 101 and "[E-101]" in _rendered and "[parent: E-100]" in _rendered,
        repr((_event, _rendered)),
    )
    return problems, checked


def run_hostile_journal_probes() -> tuple[list[str], int]:
    """Hostile-regression journal controls (hostile sweep P0): relative
    root mutation, the pure validation gate (zero Journal construction on
    malformed requests, zero orphan op dirs), canonical owned-vs-read path
    identity, decoder alias rejection, corrupt-evidence partition
    (CORRUPT_JOURNAL refusal before any Journal is built), lineage
    fail-closed on a deleted IDENTITY.md carrier, and bounded append
    staged names for deep paths. Every probe runs in a fresh temp project.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if ok:
            print(f"PASS: hr-journal -- {label}")
        else:
            problems.append(f"{label}: {detail}")
            print(f"FAIL: hr-journal -- {label} -- {detail}")

    from saipen_engine.journal import (
        Journal,
        decode_operation_record,
        hash_file_dependency,
        recovery_preflight,
        run_mutation,
        scan_pending,
    )

    def mkrepo():
        tmp = Path(tempfile.mkdtemp(prefix="saipen-hr-journal-"))
        (tmp / ".saipen").mkdir()
        (tmp / "x.txt").write_text("one\n", encoding="utf-8")
        return tmp

    def hash_of(b: bytes) -> str:
        import hashlib

        return hashlib.sha256(b).hexdigest()[:16]

    def base_targets(content_bytes):
        return [{"path": "x.txt", "role": "generic", "action": "write", "content": content_bytes}]

    # 1. relative root works (was a crash)
    r = mkrepo()
    old_cwd = os.getcwd()
    try:
        os.chdir(r)
        res = run_mutation(".", "op-relroot", "probe", "smoke", "id", "sem", base_targets(b"two\n"))
    finally:
        os.chdir(old_cwd)
    expect("relative root commits", res["ok"], repr(res))
    relative_journal = Journal(r.resolve(), "op-relroot")
    expect(
        "receipt decodes",
        decode_operation_record(r.resolve(), relative_journal.dir)["ok"],
    )
    try:
        relative_journal.append_targets(base_targets(b"forbidden\n"))
        terminal_append_refused = False
    except ValueError:
        terminal_append_refused = True
    expect(
        "terminal receipt refuses appended targets",
        terminal_append_refused
        and not list(relative_journal.dir.glob("1_*.staged")),
    )
    shutil.rmtree(r, ignore_errors=True)

    # 2. malformed requests -> VALIDATION_FAILED, zero changes, no orphan dirs
    r = mkrepo()
    bad = [
        ("op bad", "op-bad", 123, "a", "id", "sem"),
        ("agent None", "op-bad2", "probe", None, "id", "sem"),
        ("opid hostile", "../../x", "probe", "a", "id", "sem"),
    ]
    for label, op, opn, ag, pid, sem in bad:
        res = run_mutation(r, op, opn, ag, pid, sem, base_targets(b"x"))
        expect(
            f"malformed {label} refuses VALIDATION_FAILED",
            (not res["ok"]) and res["code"] == "VALIDATION_FAILED",
            repr(res),
        )
    res = run_mutation(r, "op-t", "p", "a", "i", "s", None)
    expect(
        "targets=None refuses", (not res["ok"]) and res["code"] == "VALIDATION_FAILED", repr(res)
    )
    ops = r / ".saipen/recovery/ops"
    expect("no journal left after refusals", not ops.exists() or not any(ops.iterdir()))
    res = run_mutation(
        r, "op-rmeta", "p", "a", "i", "s", base_targets(b"x"), receipt_metadata={"bad": {1}}
    )
    expect(
        "non-JSON metadata refuses VALIDATION_FAILED",
        (not res["ok"]) and res["code"] == "VALIDATION_FAILED",
        repr(res),
    )
    expect("no orphan op dir after failed PREPARED", not ops.exists() or not any(ops.iterdir()))
    res = run_mutation(
        r, "op-rmeta2", "p", "a", "i", "s", base_targets(b"x"), preconditions={"x.txt": 7}
    )
    expect(
        "int precondition value refuses",
        (not res["ok"]) and res["code"] == "VALIDATION_FAILED",
        repr(res),
    )
    shutil.rmtree(r, ignore_errors=True)

    # 3. canonical identity: aliases collapse; target+read same file
    r = mkrepo()
    res = run_mutation(
        r,
        "op-dup",
        "p",
        "a",
        "i",
        "s",
        [
            {"path": "x.txt", "role": "generic", "action": "write", "content": b"a"},
            {"path": "./x.txt", "role": "generic", "action": "write", "content": b"b"},
        ],
    )
    expect(
        "alias targets refuse", (not res["ok"]) and res["code"] == "VALIDATION_FAILED", repr(res)
    )
    res = run_mutation(
        r,
        "op-tr",
        "p",
        "a",
        "i",
        "s",
        base_targets(b"c"),
        read_preconditions={"x.txt": hash_file_dependency(r / "x.txt")},
    )
    expect(
        "target+read same file zero-write refusal",
        (not res["ok"]) and res["code"] == "VALIDATION_FAILED",
        repr(res),
    )
    expect("file unchanged", (r / "x.txt").read_text() == "one\n")
    ext = Path(tempfile.mkdtemp(prefix="saipen-hr-ext-")) / "dep.txt"
    ext.write_text("d", encoding="utf-8")
    res = run_mutation(
        r,
        "op-extread",
        "p",
        "a",
        "i",
        "s",
        base_targets(b"c"),
        read_preconditions={str(ext): hash_of(b"d")},
    )
    expect("external absolute read legal", res["ok"], repr(res))
    shutil.rmtree(r, ignore_errors=True)
    shutil.rmtree(ext.parent, ignore_errors=True)

    # 4. decoder rejects alias receipt (a/../x + x) before replay
    r = mkrepo()
    opsd = r / ".saipen" / "recovery" / "ops" / "op-alias"
    opsd.mkdir(parents=True)
    rec = {
        "op_id": "op-alias",
        "operation": "p",
        "created_at": "2026-08-16T00:00:00Z",
        "agent": "a",
        "project_identity": "id",
        "semantic_payload_hash": "s",
        "preconditions": {},
        "read_preconditions": {},
        "verification_policy": "none",
        "status": "PREPARED",
        "progress_index": 0,
        "targets": [
            {
                "path": "a/../x.txt",
                "role": "generic",
                "action": "write",
                "before_hash": hash_of(b"one\n"),
                "after_hash": hash_of(b"z"),
                "applied": False,
            },
            {
                "path": "x.txt",
                "role": "generic",
                "action": "write",
                "before_hash": hash_of(b"one\n"),
                "after_hash": hash_of(b"y"),
                "applied": False,
            },
        ],
    }
    (opsd / "operation.json").write_text(json.dumps(rec), encoding="utf-8")
    (opsd / ("0_%s.staged" % hash_of(b"x.txt")[:16])).write_bytes(b"z")
    (opsd / ("1_%s.staged" % hash_of(b"x.txt")[:16])).write_bytes(b"y")
    dec = decode_operation_record(r, opsd)
    expect("decoder rejects alias pair", not dec["ok"], repr(dec))
    shutil.rmtree(r, ignore_errors=True)

    # 5. corrupt evidence partition: symlink op dir -> CORRUPT_JOURNAL
    r = mkrepo()
    opsd = r / ".saipen" / "recovery" / "ops"
    opsd.mkdir(parents=True)
    target = Path(tempfile.mkdtemp(prefix="saipen-hr-opsym-"))
    try:
        os.symlink(target, opsd / "op-bad", target_is_directory=True)
    except (OSError, NotImplementedError):
        print("SKIP: hr-journal -- symlink corrupt probe (host cannot symlink)")
    else:
        pending, _conflicts = scan_pending(r)
        expect("scan flags CORRUPT", any(p.get("corrupt") for p in pending), repr(pending))
        pre = recovery_preflight(r)
        expect(
            "preflight refuses CORRUPT_JOURNAL zero Journal",
            (not pre["ok"]) and pre["code"] == "CORRUPT_JOURNAL",
            repr(pre),
        )
        res = run_mutation(r, "op-after-corrupt", "p", "a", "i", "s", base_targets(b"q"))
        expect(
            "mutation refused while corrupt evidence present",
            (not res["ok"]) and res["code"] == "CORRUPT_JOURNAL",
            repr(res),
        )
    shutil.rmtree(r, ignore_errors=True)
    shutil.rmtree(target, ignore_errors=True)

    # 6. healthy single pending op still auto-recovers
    r = mkrepo()
    res = run_mutation(
        r, "op-ok", "p", "a", "i", "s", base_targets(b"new\n"), verification_policy="none"
    )
    expect("healthy op commits", res["ok"], repr(res))
    shutil.rmtree(r, ignore_errors=True)

    # 7. lineage fail-closed: deleted IDENTITY.md + retry -> refusal
    r = mkrepo()
    res = run_mutation(r, "op-lineage", "p", "a", "i", "s", base_targets(b"l1\n"))
    expect("first op commits", res["ok"], repr(res))
    ident = r / ".saipen" / "IDENTITY.md"
    expect("IDENTITY minted", ident.is_file())
    res3 = run_mutation(r, "op-lineage", "p", "a", "i", "s", base_targets(b"l1\n"))
    expect(
        "healthy retry ALREADY_APPLIED",
        res3["ok"] and res3["code"] == "ALREADY_APPLIED",
        repr(res3),
    )
    ident.unlink()
    res2 = run_mutation(r, "op-lineage", "p", "a", "i", "s", base_targets(b"l1\n"))
    expect(
        "retry with deleted carrier refuses (no ALREADY_APPLIED)",
        (not res2["ok"]) and res2["code"] != "ALREADY_APPLIED",
        repr(res2),
    )
    expect("carrier not recreated", not ident.exists())
    expect("file unchanged by refused retry", (r / "x.txt").read_text() == "l1\n")
    shutil.rmtree(r, ignore_errors=True)

    # 8. append_targets bounded staged names + deep path. Build an ACTIVE
    # receipt: terminal receipts are immutable and normally live in settled/.
    r = mkrepo()
    j = Journal(r, "op-append")
    base = base_targets(b"a1\n")[0]
    base["before_hash"] = hash_of((r / "x.txt").read_bytes())
    base["after_hash"] = hash_of(b"a1\n")
    j.start("p", "a", "i", "s", [base], verification_policy="none")
    deep = "/".join(["d%d" % i for i in range(40)]) + "/deep.txt"
    j.append_targets(
        [
            {
                "path": deep,
                "role": "generic",
                "action": "write",
                "content": b"deep\n",
                "before_hash": "",
                "after_hash": "",
            }
        ]
    )
    staged = list(j.dir.glob("1_*.staged"))
    expect(
        "append uses bounded staged_name",
        len(staged) == 1 and len(staged[0].stem) == 1 + 1 + 16,
        [p.name for p in staged],
    )
    shutil.rmtree(r, ignore_errors=True)

    return problems, checked


def run_hostile_release_probes() -> tuple[list[str], int]:
    """Hostile-regression release rollback controls (hostile sweep P0):
    index-owner-safe restore -- byte-exact pre-index restore on the owned
    post-stage SHA, foreign staging refusal, unowned-index refusal, foreign
    index.lock refusal with byte-for-byte survival, recovery-record restore,
    and bytes-primary over the lossy read-tree path. Fresh temp git repos.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if ok:
            print(f"PASS: hr-release -- {label}")
        else:
            problems.append(f"{label}: {detail}")
            print(f"FAIL: hr-release -- {label} -- {detail}")

    from saipen_engine.release import (
        IndexSnapshot,
        _exact_index_bytes,
        _restore_index,
        _restore_index_from_record,
    )

    def rm_tree(path: Path) -> None:
        for _ in range(5):
            try:
                shutil.rmtree(path)
                return
            except PermissionError:
                import time

                time.sleep(0.2)
        shutil.rmtree(path, onerror=lambda fn, p, e: None)

    def git(root, *args):
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, check=False)

    def setup():
        root = Path(tempfile.mkdtemp(prefix="saipen-hr-release-"))
        git(root, "init", "-q")
        git(root, "config", "user.email", "probe@probe")
        git(root, "config", "user.name", "probe")
        (root / "a.txt").write_text("a\n", encoding="utf-8")
        git(root, "add", "a.txt")
        git(root, "commit", "-q", "-m", "base")
        pre_sha, pre_b64 = _exact_index_bytes(root)
        pre = IndexSnapshot(
            paths=(),
            entries=(),
            content_hash="",
            index_sha256=pre_sha,
            index_bytes_b64=pre_b64,
            tree_sha="",
        )
        return root, pre

    def staged_names(root):
        r = git(root, "diff", "--cached", "--name-only")
        return sorted(r.stdout.splitlines())

    def index_sha(root):
        return _exact_index_bytes(root)[0]

    # 1. ordinary crash: restore byte-identical pre-index
    root, pre = setup()
    (root / "x.txt").write_text("x\n", encoding="utf-8")
    git(root, "add", "x.txt")
    owned = index_sha(root)
    expect("owned post-stage sha differs from pre", owned != pre.index_sha256)
    _restore_index(root, pre, owned)
    expect("restored byte-identical pre-index", index_sha(root) == pre.index_sha256)
    expect("no staging left", staged_names(root) == [])
    rm_tree(root)

    # 2. foreign staged y survives + refusal
    root, pre = setup()
    (root / "x.txt").write_text("x\n", encoding="utf-8")
    git(root, "add", "x.txt")
    owned = index_sha(root)
    (root / "y.txt").write_text("y\n", encoding="utf-8")
    git(root, "add", "y.txt")
    try:
        _restore_index(root, pre, owned)
        expect("foreign staging refuses", False, "no ValueError raised")
    except ValueError as exc:
        expect("foreign staging refuses", True, str(exc)[:60])
    expect("foreign y still staged", "y.txt" in staged_names(root))
    expect("release x still staged too", "x.txt" in staged_names(root))
    rm_tree(root)

    # 3. live == pre -> no-op even without owned sha
    root, pre = setup()
    _restore_index(root, pre, None)
    expect("already-pre no-op", index_sha(root) == pre.index_sha256)
    rm_tree(root)

    # 4. owned None + live != pre -> refusal
    root, pre = setup()
    (root / "x.txt").write_text("x\n", encoding="utf-8")
    git(root, "add", "x.txt")
    try:
        _restore_index(root, pre, None)
        expect("unowned index refuses", False, "no ValueError")
    except ValueError:
        expect("unowned index refuses", True)
    rm_tree(root)

    # 5. foreign index.lock survives byte-for-byte and causes refusal
    root, pre = setup()
    (root / "x.txt").write_text("x\n", encoding="utf-8")
    git(root, "add", "x.txt")
    owned = index_sha(root)
    loc = git(root, "rev-parse", "--git-path", "index").stdout.strip()
    lock_path = Path(loc) if Path(loc).is_absolute() else root / loc
    lock_path = lock_path.with_name(lock_path.name + ".lock")
    lock_bytes = b"foreign lock bytes 12345"
    lock_path.write_bytes(lock_bytes)
    try:
        _restore_index(root, pre, owned)
        expect("lock refusal", False, "no ValueError")
    except ValueError as exc:
        expect("lock refusal", True, str(exc)[:50])
    expect("lock survives byte-for-byte", lock_path.read_bytes() == lock_bytes)
    expect("staging intact", "x.txt" in staged_names(root))
    lock_path.unlink()
    rm_tree(root)

    # 6. recovery record path: _restore_index_from_record
    root, pre = setup()
    (root / "x.txt").write_text("x\n", encoding="utf-8")
    git(root, "add", "x.txt")
    owned = index_sha(root)
    record = {"pre_index_b64": pre.index_bytes_b64, "owned_post_stage_index_sha256": owned}
    _restore_index_from_record(root, record)
    expect("record restore byte-exact", index_sha(root) == pre.index_sha256)

    (root / "x.txt").write_text("x\n", encoding="utf-8")
    git(root, "add", "x.txt")
    owned = index_sha(root)
    (root / "y.txt").write_text("y\n", encoding="utf-8")
    git(root, "add", "y.txt")
    try:
        _restore_index_from_record(root, record)
        expect("record foreign staging refuses", False)
    except ValueError as exc:
        expect("record foreign staging refuses", True, str(exc)[:50])
    expect("foreign y still staged after record refusal", "y.txt" in staged_names(root))
    rm_tree(root)

    # 7. tree_sha present must NOT switch to lossy read-tree: bytes primary
    root, pre = setup()
    (root / "x.txt").write_text("x\n", encoding="utf-8")
    git(root, "add", "x.txt")
    owned = index_sha(root)
    pre_with_tree = IndexSnapshot(
        paths=pre.paths,
        entries=pre.entries,
        content_hash=pre.content_hash,
        index_sha256=pre.index_sha256,
        index_bytes_b64=pre.index_bytes_b64,
        tree_sha=git(root, "rev-parse", "HEAD^{tree}").stdout,
    )
    _restore_index(root, pre_with_tree, owned)
    expect("bytes primary even with tree_sha", index_sha(root) == pre.index_sha256)
    rm_tree(root)

    return problems, checked


def run_hostile_convergence_probes() -> tuple[list[str], int]:
    """Hostile-regression convergence identity controls (hostile sweep P1):
    `_identity_of` binds the INPUT source side only -- a receipt carrying
    only resulting_* fields (or missing its input side) is a broken chain
    link, never silent evidence; CLEAN's resulting side is read explicitly
    and only for G. A full E->I chain with one identity family passes.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if ok:
            print(f"PASS: hr-convergence -- {label}")
        else:
            problems.append(f"{label}: {detail}")
            print(f"FAIL: hr-convergence -- {label} -- {detail}")

    from saipen_engine.convergence import convergence_verdict

    S0 = ("1111111111111111111111111111111111111111", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    S1 = ("2222222222222222222222222222222222222222", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")

    def write_receipt(
        root: Path,
        op_id: str,
        stage: str,
        verdict: str,
        event_id: int,
        source: tuple[str, str],
        resulting: tuple[str, str] | None = None,
        omit_input: bool = False,
    ) -> None:
        meta = {
            "operation": "convergence_stage",
            "status": "COMMITTED",
            "stage": stage,
            "verdict": verdict,
            "event_id": f"E-{event_id}",
        }
        if not omit_input:
            meta["source_head"] = source[0]
            meta["source_tree_fingerprint"] = source[1]
        if resulting is not None:
            meta["resulting_source_head"] = resulting[0]
            meta["resulting_source_tree_fingerprint"] = resulting[1]
        record = {
            "op_id": op_id,
            "operation": "convergence_stage",
            "created_at": "2026-08-16T00:00:00Z",
            "agent": "probe",
            "project_identity": "probe",
            "semantic_payload_hash": "p",
            "preconditions": {},
            "read_preconditions": {},
            "verification_policy": "none",
            "status": "COMMITTED",
            "progress_index": 0,
            "targets": [],
            "receipt_metadata": meta,
        }
        op_dir = root / ".saipen" / "recovery" / "ops" / op_id
        op_dir.mkdir(parents=True, exist_ok=True)
        (op_dir / "operation.json").write_text(json.dumps(record), encoding="utf-8")

    def chain_root() -> Path:
        root = Path(tempfile.mkdtemp(prefix="saipen-hr-conv-"))
        (root / ".saipen" / "recovery" / "ops").mkdir(parents=True)
        subprocess.run(["git", "init", "-q"], cwd=root, check=False)
        subprocess.run(["git", "config", "user.email", "probe@probe"], cwd=root, check=False)
        subprocess.run(["git", "config", "user.name", "probe"], cwd=root, check=False)
        write_receipt(root, "op-e", "E", "PASS", 100, S0)
        write_receipt(root, "op-f", "F", "CLEAN", 101, S0)
        write_receipt(root, "op-g", "G", "COMPLETED", 102, S0, S1)
        write_receipt(root, "op-h", "H", "PASS", 103, S1)
        write_receipt(root, "op-i", "I", "CLEAN", 104, S1)
        return root

    def source_id(s: tuple[str, str]):
        return SourceIdentity(s[0], s[1], "probe-model")

    # 1. valid chain, live == S1 -> ok
    root = chain_root()
    v = convergence_verdict(root, source_id=source_id(S1))
    expect("valid E-I chain passes", v.ok, "; ".join(v.reasons))
    shutil.rmtree(root, ignore_errors=True)

    # 2. G with ONLY resulting fields (input side missing) -> chain fails
    root = chain_root()
    write_receipt(root, "op-g", "G", "COMPLETED", 102, S0, S1, omit_input=True)
    v = convergence_verdict(root, source_id=source_id(S1))
    expect(
        "G without input side fails closed",
        (not v.ok) and any("lacks a bound source identity" in r for r in v.reasons),
        "; ".join(v.reasons),
    )
    shutil.rmtree(root, ignore_errors=True)

    # 3. non-G receipt carrying only resulting fields -> never evidence
    root = chain_root()
    write_receipt(root, "op-e", "E", "PASS", 100, S0, resulting=S0, omit_input=True)
    v = convergence_verdict(root, source_id=source_id(S1))
    expect(
        "non-G resulting-only receipt fails closed",
        (not v.ok) and any("lacks a bound source identity" in r for r in v.reasons),
        "; ".join(v.reasons),
    )
    shutil.rmtree(root, ignore_errors=True)

    # 4. G input present but resulting mismatch -> explicit CLEAN failure
    root = chain_root()
    write_receipt(root, "op-g", "G", "COMPLETED", 102, S0, S0)
    v = convergence_verdict(root, source_id=source_id(S1))
    expect(
        "G resulting mismatch fails",
        (not v.ok) and any("CLEAN resulting identity differs" in r for r in v.reasons),
        "; ".join(v.reasons),
    )
    shutil.rmtree(root, ignore_errors=True)

    return problems, checked


def run_hostile_authority_probes() -> tuple[list[str], int]:
    """Hostile-regression AUTHORITY partition: what may PLAN a canonical write.

    Four independent authorities were each failing OPEN, and each is proved
    here against a hostile artifact:

      * P0#2 the complete LOG history -- sealed segments + active LOG.md are
        one immutable ledger. A void ledger (dangling parent, duplicate/out-of
        -order E-ID, forged line) must refuse BEFORE journaling, and the sealed
        tree is a bound read precondition, so creating/removing/altering
        `.saipen/logs` between PLAN and APPLY is STALE_STATE with zero writes.
      * P0#3 the RUNNING installation owns VERSION/schema/STYLE, and the
        persisted `saipen_home` is validated separately as a POINTER: a dead
        absolute pointer refuses ordinary mutation with HOME_REQUIRED, and
        `rebind-home` is the only repair.
      * P0#4 the CURRENT-SESSION capability is the only write/publish
        authority; the persisted `STATE.mode` is the last handshake outcome and
        proves nothing about now.
      * P1#6 corrupt recovery evidence classifies as CORRUPT_JOURNAL
        everywhere (status/next/preflight/recover) and is never replayed, while
        a genuinely absent/empty ops dir stays CLEAN.
      * P1#8 a stale-claim TAKEOVER records the predecessor and the staleness
        that authorized it; ordinary adoption invents no predecessor.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if ok:
            print(f"PASS: hr-authority -- {label}")
        else:
            problems.append(f"{label}: {detail}")
            print(f"FAIL: hr-authority -- {label} -- {detail}")

    from saipen_engine import codec
    from saipen_engine.journal import auto_recover_pending, recovery_preflight, scan_pending
    from saipen_engine.operations import (
        _now,
        _plan_checkpoint,
        _read,
        _utc_iso,
        apply_claim,
        checkpoint,
        rebind_saipen_home,
    )
    from saipen_engine.plan import apply_plan
    from saipen_engine.router import route_next
    from saipen_engine.state import (
        parse_state,
        persisted_home_error,
        running_home,
        running_protocol_major,
        running_schema_version,
        state_contract_errors,
    )

    # T-1361 CL-07: `saipen_version` was the literal 7, so once this home
    # shipped v8.0.0 every fixture declared a generation the running install
    # refuses to rebind onto (T-1352 HOME_REQUIRED) -- and the probes about
    # rebinding a DEAD pointer measured that refusal instead. The fixture must
    # declare the generation it is actually running under; the checks that
    # want a MISMATCH build one explicitly, relative to the same number.
    STATE_TMPL = (
        '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
        'blocker: ""\ntransition_from: SHIP\nsaipen_version: %(major)s\n'
        "schema_version: 3\nlast_event: 902\nstyle_contract: %(style)s\n"
        'saipen_home: "%(home)s"\nagent: probe\nmode: %(mode)s\n'
        "updated: 2026-08-16T00:00:00Z\n---\n"
    )

    def style_token() -> str:
        from saipen_engine.state import running_style_token

        return running_style_token() or "ded-4ae736e4"

    def mkproject(
        home: str | None = None, mode: str = "full", log_lines: str | None = None
    ) -> Path:
        root = Path(tempfile.mkdtemp(prefix="saipen-hr-auth-"))
        saipen = root / ".saipen"
        saipen.mkdir()
        # T-1361 CL-07: T-1 and T-2 are written straight into BOARD below, so
        # the default history has to ALLOCATE them -- CORE-003 / SRC-026:R003
        # made identity come from a structured [T-###] event, and without one
        # the claim/adoption probes measured `core_fast` refusing the fixture
        # rather than the authority behaviour they exist to test.
        (saipen / "LOG.md").write_text(
            log_lines
            if log_lines is not None
            else "# Log\n"
            "- 09.08.26 00:00 [E-899] [T-1] [agent: probe] "
            "DEC: ticket added via SAIOPS\n"
            "- 09.08.26 00:00 [E-900] [parent: E-899] [T-2] [agent: probe] "
            "DEC: ticket added via SAIOPS\n"
            "- 09.08.26 00:00 [E-901] [parent: E-900] [agent: probe] DEC: base\n"
            "- 09.08.26 00:01 [E-902] [parent: E-901] [agent: probe] "
            "DEC: second\n",
            encoding="utf-8",
        )
        (saipen / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n"
            "- [ ] T-1 [P1] top probe | verify: probe\n"
            "- [ ] T-2 [P1] lower probe | verify: probe\n"
            "## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (saipen / "STATE.md").write_text(
            STATE_TMPL
            % {
                "style": style_token(),
                "home": (home if home is not None else running_home().as_posix()),
                "mode": mode,
                "major": running_protocol_major(),
            },
            encoding="utf-8",
        )
        return root

    def canon(root: Path) -> dict[str, bytes]:
        return {
            p.relative_to(root).as_posix(): p.read_bytes()
            for p in sorted((root / ".saipen").rglob("*"))
            if p.is_file()
        }

    # The canonical checkpoint is exactly STATE/BOARD/LOG (+ the sealed ledger
    # under `.saipen/logs`); a STALE_STATE refusal may still create transient
    # infra (`.saipen/locks`, the project `.saipen/IDENTITY.md`) but must NOT
    # touch these decision-relevant files.
    _CANONICAL_FILES = {".saipen/STATE.md", ".saipen/BOARD.md", ".saipen/LOG.md"}

    # ---- P0#2 -- the complete ledger is validated before planning ---------
    void = mkproject(
        log_lines=(
            "# Log\n- 09.08.26 00:00 [E-901] [agent: probe] DEC: base\n"
            "- 09.08.26 00:01 [E-902] [parent: E-899] [agent: probe] "
            "DEC: dangling parent\n"
        )
    )
    before = canon(void)
    res = checkpoint(void, "probe", "RUN", None, "probe", dry_run=True)
    expect(
        "dangling parent in the ledger refuses even a dry-run PLAN",
        not res.ok and "history-void" in (res.message or ""),
        res.to_json(),
    )
    expect("refused history PLAN wrote nothing", canon(void) == before)
    shutil.rmtree(void, ignore_errors=True)

    dupe = mkproject(
        log_lines=(
            "# Log\n- 09.08.26 00:00 [E-901] [agent: probe] DEC: base\n"
            "- 09.08.26 00:01 [E-901] [agent: probe] DEC: replayed\n"
        )
    )
    res = checkpoint(dupe, "probe", "RUN", None, "probe")
    expect(
        "duplicate E-ID refuses with zero writes",
        not res.ok and "history-void" in (res.message or ""),
        res.to_json(),
    )
    shutil.rmtree(dupe, ignore_errors=True)

    forged = mkproject(
        log_lines=(
            "# Log\n- 09.08.26 00:00 [E-901] [agent: probe] DEC: base\n"
            "- 09.08.26 00:02 [E-903] DEC: forged line with no agent marker "
            "and no legal shape |\n"
        )
    )
    res = checkpoint(forged, "probe", "RUN", None, "probe")
    expect(
        "a forged non-event line refuses with its file:line",
        not res.ok and "LOG.md:" in (res.message or ""),
        res.to_json(),
    )
    shutil.rmtree(forged, ignore_errors=True)

    healthy = mkproject()
    res = checkpoint(healthy, "probe", "RUN", None, "healthy ledger probe")
    expect("a VALID ledger still checkpoints normally", res.ok, res.to_json())
    shutil.rmtree(healthy, ignore_errors=True)

    # The sealed tree is a bound read precondition: appearing, disappearing or
    # changing between PLAN and APPLY is STALE_STATE, never a silent skip.
    for label, mutate in (
        (
            "creating the sealed logs tree",
            lambda r: (
                (r / ".saipen" / "logs").mkdir(parents=True),
                (r / ".saipen" / "logs" / "LOG-001.md").write_text(
                    "# Log\n- 09.08.26 00:00 [E-1] [agent: probe] DEC: fabricated seal\n",
                    encoding="utf-8",
                ),
            ),
        ),
        (
            "adding a second sealed segment",
            lambda r: (r / ".saipen" / "logs" / "LOG-002.md").write_text(
                "# Log\n", encoding="utf-8"
            ),
        ),
        (
            "changing sealed segment bytes",
            lambda r: (r / ".saipen" / "logs" / "LOG-001.md").write_text(
                "# Log\n- 09.08.26 00:00 [E-1] [agent: probe] DEC: altered\n", encoding="utf-8"
            ),
        ),
        ("removing the sealed logs tree", lambda r: shutil.rmtree(r / ".saipen" / "logs")),
    ):
        root = mkproject()
        if "creating" not in label:
            (root / ".saipen" / "logs").mkdir(parents=True)
            (root / ".saipen" / "logs" / "LOG-001.md").write_text(
                "# Log\n- 09.08.26 00:00 [E-1] [agent: probe] DEC: sealed\n", encoding="utf-8"
            )
        plan = _plan_checkpoint(root, "probe", "RUN", None, "cas probe", _now(), _utc_iso())
        expect(f"PLAN built before {label}", not isinstance(plan, Result), repr(plan))
        if isinstance(plan, Result):
            shutil.rmtree(root, ignore_errors=True)
            continue
        pre = canon(root)
        mutate(root)
        applied = apply_plan(root, plan)
        expect(
            f"{label} between PLAN and APPLY is STALE_STATE",
            not applied.ok and applied.code == "STALE_STATE",
            applied.to_json(),
        )
        expect(
            f"{label} left STATE/BOARD/LOG untouched",
            {k: v for k, v in canon(root).items() if k in _CANONICAL_FILES}
            == {k: v for k, v in pre.items() if k in _CANONICAL_FILES},
        )
        shutil.rmtree(root, ignore_errors=True)

    # ---- P0#3 -- running install authoritative, pointer validated apart ---
    expect(
        # T-1361 CL-07: the major was written as a literal 7 and this home
        # shipped v8.0.0 on 06.09.26, so the check has read red on the
        # repository's own version number ever since. What P0#3 is about is
        # WHICH install answers -- the running one, never a project's STATE --
        # so read the running install's own files and compare the accessors to
        # them. A literal here is a bet that the product stops being released.
        "the running install answers the schema/protocol questions",
        running_schema_version()
        == json.loads(
            (HOME / "extensions" / "schemas" / "state.schema.json").read_text(encoding="utf-8-sig")
        )["x-current-schema-version"]
        and running_protocol_major()
        == int((HOME / "VERSION").read_text(encoding="utf-8-sig").strip().split(".")[0]),
        f"schema={running_schema_version()} major={running_protocol_major()}",
    )
    dead = (Path(tempfile.gettempdir()) / "saipen-hr-auth-dead-home").resolve()
    shutil.rmtree(dead, ignore_errors=True)
    expect("a dead absolute pointer is reported dead", persisted_home_error(str(dead)) is not None)
    expect(
        "an empty/relative pointer stays unverifiable, not dead",
        persisted_home_error("") is None and persisted_home_error(".") is None,
    )
    expect(
        "the running home is a live pointer",
        persisted_home_error(str(running_home())) is None,
        str(persisted_home_error(str(running_home()))),
    )

    dead_root = mkproject(home=dead.as_posix())
    before = canon(dead_root)
    res = checkpoint(dead_root, "probe", "RUN", None, "probe")
    expect(
        "dead home refuses an ordinary checkpoint with HOME_REQUIRED",
        not res.ok and res.code == "HOME_REQUIRED",
        res.to_json(),
    )
    expect("dead-home refusal wrote nothing", canon(dead_root) == before)
    res = apply_claim(dead_root, "T-1", "probe")
    expect(
        "dead home refuses a claim too", not res.ok and res.code == "HOME_REQUIRED", res.to_json()
    )
    res = rebind_saipen_home(dead_root, "probe", str(running_home()))
    expect(
        "rebind-home is the ONE repair and it succeeds",
        res.ok and res.code == "HOME_REBOUND",
        res.to_json(),
    )
    st = parse_state(codec.read_doc(dead_root / ".saipen" / "STATE.md"))
    expect(
        "the repaired pointer names the candidate",
        Path(st.get("saipen_home", "")).resolve() == running_home(),
        repr(st.get("saipen_home")),
    )
    res = checkpoint(dead_root, "probe", "RUN", None, "after rebind")
    expect("ordinary mutation resumes after the rebind", res.ok, res.to_json())
    shutil.rmtree(dead_root, ignore_errors=True)

    GOOD_V3 = {
        "phase": "DONE",
        "task": "none",
        "next_action": "saipen continue",
        "blocker": "",
        "agent": "probe",
        "saipen_version": 7,
        "schema_version": 3,
        "mode": "full",
        "transition_from": "SHIP",
        "updated": "2026-08-16T00:00:00Z",
        "last_event": 902,
        "style_contract": style_token(),
        "saipen_home": str(running_home()),
    }
    expect(
        "a schema-v3 state with the running style token passes",
        state_contract_errors(GOOD_V3, style_token=style_token(), current_schema_version=3) == [],
        "; ".join(
            state_contract_errors(GOOD_V3, style_token=style_token(), current_schema_version=3)
        ),
    )
    errs = state_contract_errors(
        {**GOOD_V3, "saipen_home": str(dead), "style_contract": "ded-deadbeef"},
        style_token=style_token(),
        current_schema_version=3,
    )
    expect(
        "a wrong style_contract fails against the RUNNING install EVEN "
        "with a dead pointer (the running install owns STYLE)",
        any("style_contract" in e for e in errs),
        "; ".join(errs),
    )
    # T-1361 CL-07: the literal 8 was "newer than running" only while the
    # running install was 7. Newer means newer than whatever is running.
    errs = state_contract_errors(
        {**GOOD_V3, "saipen_version": (running_protocol_major() or 0) + 1}
    )
    expect(
        "a project protocol major newer than the running one refuses",
        any("newer than the running" in e for e in errs),
        "; ".join(errs),
    )
    expect(
        "an older/equal protocol major stays readable",
        not any("newer than the running" in e for e in state_contract_errors(GOOD_V3)),
    )

    # ---- P0#4 -- current capability, never the persisted mode -------------
    stale_full = mkproject(mode="full")
    state_text = codec.read_doc(stale_full / ".saipen" / "STATE.md")
    board_text = codec.read_doc(stale_full / ".saipen" / "BOARD.md")
    routed = route_next(state_text, board_text, current_capability="read-only")
    expect(
        "stale disk `full` + current read-only routes inspect-only",
        routed.get("ok")
        and routed.get("executable_behavior") == "RESTATE_AND_STOP"
        and routed.get("action") == "saipen status",
        repr(routed),
    )
    routed = route_next(state_text, board_text, current_capability="full")
    expect(
        "current full routes real work",
        routed.get("ok") and routed.get("action") == "PHASE SCOUT T-1",
        repr(routed),
    )
    routed = route_next(state_text, board_text, current_capability="all-powerful")
    expect(
        "an unknown capability fails closed, never as `full`",
        not routed.get("ok") and routed.get("reason") == "capability-invalid",
        repr(routed),
    )
    shutil.rmtree(stale_full, ignore_errors=True)

    stale_ro = mkproject(mode="read-only")
    routed = route_next(
        codec.read_doc(stale_ro / ".saipen" / "STATE.md"),
        codec.read_doc(stale_ro / ".saipen" / "BOARD.md"),
        current_capability="full",
    )
    expect(
        "stale disk `read-only` does NOT suppress a writable session",
        routed.get("ok") and routed.get("action") == "PHASE SCOUT T-1",
        repr(routed),
    )
    shutil.rmtree(stale_ro, ignore_errors=True)

    from saipen_engine.release import _read_mode

    expect(
        "release publish policy follows the CURRENT capability",
        _read_mode({"mode": "no-publish"}, "full") == "full"
        and _read_mode({"mode": "full"}, "no-publish") == "no-publish",
    )
    for bad in ("read-only", "manual-verify", "bogus"):
        try:
            _read_mode({"mode": "full"}, bad)
        except Exception as exc:
            expect(
                f"current capability {bad!r} cannot authorize a release",
                getattr(exc, "code", "") == "VALIDATION_FAILED",
                repr(exc),
            )
        else:
            expect(
                f"current capability {bad!r} cannot authorize a release", False, "no refusal raised"
            )

    ro_crew = mkproject()
    before = canon(ro_crew)
    from saipen_engine.crew import crew_apply

    res = crew_apply(ro_crew, current_capability="read-only")
    expect(
        "a read-only session cannot execute a crew action",
        not res.ok and res.code == "VALIDATION_FAILED",
        res.to_json(),
    )
    expect("refused crew action wrote nothing", canon(ro_crew) == before)
    shutil.rmtree(ro_crew, ignore_errors=True)

    from saipen_engine.capability import may_mutate, may_publish, negotiate_capability

    expect(
        "capability negotiation reads the session, never STATE",
        negotiate_capability({}) == "full"
        and negotiate_capability({"SAIPEN_CAPABILITY": "read-only"}) == "read-only",
    )
    # CORE-004: this scenario used to assert that a nonsense declaration
    # negotiates `full`, which LOCKED IN the fail-open. An absent declaration
    # is still the default writable session; a PRESENT invalid one is now
    # returned verbatim so every closed-set check downstream can fire on it.
    from saipen_engine.capability import capability_error

    expect(
        "an invalid live capability declaration is never laundered into full",
        all(
            capability_error(negotiate_capability({"SAIPEN_CAPABILITY": bad})) is not None
            and not may_mutate(negotiate_capability({"SAIPEN_CAPABILITY": bad}))
            and not may_publish(negotiate_capability({"SAIPEN_CAPABILITY": bad}))
            for bad in ("nonsense", "readonly", "read only", "no_publish", "full-access")
        ),
    )
    expect(
        "an absent or empty declaration keeps the documented default",
        negotiate_capability({}) == "full"
        and negotiate_capability({"SAIPEN_CAPABILITY": ""}) == "full"
        and negotiate_capability({"SAIPEN_CAPABILITY": "   "}) == "full",
    )
    expect(
        "capability predicates are closed",
        may_mutate("full")
        and not may_mutate("read-only")
        and may_publish("full")
        and not may_publish("no-publish")
        and not may_mutate(None)
        and not may_publish(None),
    )

    # ---- P1#6 -- corrupt recovery evidence, one verdict everywhere --------
    clean = mkproject()
    pending, _conf = scan_pending(clean)
    expect("an absent ops dir is CLEAN", pending == [], repr(pending))
    (clean / ".saipen" / "recovery" / "ops").mkdir(parents=True)
    pending, _conf = scan_pending(clean)
    expect("an EMPTY ops dir is CLEAN", pending == [], repr(pending))
    expect(
        "preflight is clean over an empty ops dir",
        recovery_preflight(clean).get("ok"),
        repr(recovery_preflight(clean)),
    )
    shutil.rmtree(clean, ignore_errors=True)

    parent_file = mkproject()
    (parent_file / ".saipen" / "recovery").write_text("not a dir\n", encoding="utf-8")
    pending, _conf = scan_pending(parent_file)
    expect(
        "an ops PARENT that is a file is CORRUPT_JOURNAL, never CLEAN",
        len(pending) == 1
        and pending[0].get("corrupt")
        and pending[0].get("status") == "CORRUPT_JOURNAL",
        repr(pending),
    )
    pre = recovery_preflight(parent_file)
    expect(
        "preflight refuses that artifact as CORRUPT_JOURNAL",
        not pre.get("ok") and pre.get("code") == "CORRUPT_JOURNAL",
        repr(pre),
    )
    rec = auto_recover_pending(parent_file)
    expect(
        "auto recovery REFUSES corrupt evidence before any replay",
        not rec.get("ok") and rec.get("code") == "CORRUPT_JOURNAL",
        repr(rec),
    )
    before = canon(parent_file)
    res = checkpoint(parent_file, "probe", "RUN", None, "probe")
    expect(
        "a mutation over corrupt evidence refuses",
        not res.ok and res.code == "CORRUPT_JOURNAL",
        res.to_json(),
    )
    expect("corrupt-evidence refusal wrote nothing", canon(parent_file) == before)
    for command in ("status", "next"):
        proc = subprocess.run(
            [sys.executable, str(HOME / "tools" / "saipen.py"), command, "--json"],
            cwd=str(parent_file),
            capture_output=True,
            text=True,
            timeout=90,
        )
        expect(
            f"`saipen {command}` reports CORRUPT_JOURNAL with its detail",
            "CORRUPT_JOURNAL" in proc.stdout and "OPS_DIR" in proc.stdout,
            repr(proc.stdout[-300:]),
        )
    shutil.rmtree(parent_file, ignore_errors=True)

    bad_receipt = mkproject()
    opsd = bad_receipt / ".saipen" / "recovery" / "ops" / "op-broken"
    opsd.mkdir(parents=True)
    (opsd / "operation.json").write_text("{not json", encoding="utf-8")
    pending, _conf = scan_pending(bad_receipt)
    expect(
        "an undecodable receipt is CORRUPT_JOURNAL with a detail",
        len(pending) == 1 and pending[0].get("corrupt") and pending[0].get("detail"),
        repr(pending),
    )
    rec = auto_recover_pending(bad_receipt)
    expect(
        "auto recovery names the corrupt op instead of replaying it",
        not rec.get("ok") and rec.get("op_ids") == ["op-broken"],
        repr(rec),
    )
    shutil.rmtree(bad_receipt, ignore_errors=True)

    symlinked = mkproject()
    opsd = symlinked / ".saipen" / "recovery" / "ops"
    opsd.mkdir(parents=True)
    target = Path(tempfile.mkdtemp(prefix="saipen-hr-auth-sym-"))
    try:
        os.symlink(target, opsd / "op-sym", target_is_directory=True)
    except (OSError, NotImplementedError):
        print("SKIP: hr-authority -- symlinked op dir (host cannot symlink)")
    else:
        pending, _conf = scan_pending(symlinked)
        expect(
            "an EXISTING symlinked op dir is CORRUPT_JOURNAL",
            any(p.get("corrupt") for p in pending),
            repr(pending),
        )
        (opsd / "op-sym").unlink()
        shutil.rmtree(target, ignore_errors=True)
        try:
            os.symlink(target, opsd / "op-dangling", target_is_directory=True)
        except OSError:
            pass
        else:
            pending, _conf = scan_pending(symlinked)
            expect(
                "a DANGLING symlinked op dir is CORRUPT_JOURNAL too",
                any(p.get("corrupt") for p in pending),
                repr(pending),
            )
    shutil.rmtree(target, ignore_errors=True)
    shutil.rmtree(symlinked, ignore_errors=True)

    # ---- P1#8 -- a takeover records its predecessor -----------------------
    takeover = mkproject()
    board = takeover / ".saipen" / "BOARD.md"
    board.write_text(
        "# Board\n## DOING\n"
        "- [/] T-1 [P1] stale-claimed | owner: ghost | "
        "claim_time: 2020-01-01T00:00:00Z | verify: probe\n"
        "## TODO\n"
        "- [ ] T-2 [P1] unclaimed | verify: probe\n"
        "## DONE\n## BLOCKED\n",
        encoding="utf-8",
    )
    res = apply_claim(takeover, "T-1", "probe")
    expect("a stale foreign claim can be taken over", res.ok, res.to_json())
    log_text = codec.read_doc(takeover / ".saipen" / "LOG.md")
    takeover_line = [ln for ln in log_text.splitlines() if "claimed via SAIOPS" in ln][-1]
    expect(
        "the takeover DEC names the predecessor and its stale claim_time",
        "ghost" in takeover_line
        and "2020-01-01T00:00:00Z" in takeover_line
        and "STALE" in takeover_line,
        takeover_line,
    )
    _docs, st, brd, _tail = _read(takeover)
    expect(
        "the takeover claim landed on the ticket",
        brd["tickets"]["T-1"]["fields"].get("owner") == "probe",
        repr(brd["tickets"]["T-1"]["fields"]),
    )
    shutil.rmtree(takeover, ignore_errors=True)

    adopt = mkproject()
    res = apply_claim(adopt, "T-1", "probe")
    expect("an unclaimed adoption succeeds", res.ok, res.to_json())
    log_text = codec.read_doc(adopt / ".saipen" / "LOG.md")
    adopt_line = [ln for ln in log_text.splitlines() if "claimed via SAIOPS" in ln][-1]
    expect(
        "ordinary adoption invents no predecessor",
        adopt_line.endswith("claimed via SAIOPS -- owner probe"),
        adopt_line,
    )
    shutil.rmtree(adopt, ignore_errors=True)

    live = mkproject()
    (live / ".saipen" / "BOARD.md").write_text(
        "# Board\n## DOING\n"
        "- [/] T-1 [P1] live-claimed | owner: ghost | claim_time: %s | "
        "verify: probe\n## TODO\n## DONE\n## BLOCKED\n"
        % datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        encoding="utf-8",
    )
    res = apply_claim(live, "T-1", "probe")
    expect("a LIVE foreign claim still refuses", not res.ok, res.to_json())
    shutil.rmtree(live, ignore_errors=True)

    # ---- P1#7 -- one strict UTC parser for Core and subs ------------------
    from saipen_engine.subs import validate_sub_state

    SUB = {
        "phase": "DONE",
        "task": "none",
        "next_action": "saipen continue",
        "blocker": "",
        "agent": "probe",
        "saipen_version": 7,
        "mode": "full",
        "updated": "2026-08-16T00:00:00Z",
    }
    for bad_stamp in (
        "2026-99-99T25:61:61Z",
        "2026-08-16 00:00:00Z",
        "2026-08-16T00:00:00+03:00",
        "2026-08-16T00:00:00+0000",
        "2026-08-16T00:00Z",
    ):
        core_errs = state_contract_errors({**GOOD_V3, "updated": bad_stamp})
        sub_errs = validate_sub_state({**SUB, "updated": bad_stamp})
        expect(
            f"impossible/noncanonical `updated` {bad_stamp!r} fails Core AND sub",
            any("updated" in e for e in core_errs) and any("updated" in e for e in sub_errs),
            f"core={core_errs} sub={sub_errs}",
        )
    for good_stamp in (
        "2026-08-16T00:00:00Z",
        "2026-08-16T00:00:00+00:00",
        "2026-08-16T00:00:00.250000Z",
    ):
        expect(
            f"canonical `updated` {good_stamp!r} is accepted identically",
            not any(
                "updated" in e for e in state_contract_errors({**GOOD_V3, "updated": good_stamp})
            )
            and not any("updated" in e for e in validate_sub_state({**SUB, "updated": good_stamp})),
        )

    return problems, checked


def run_hostile_wait_probes() -> tuple[list[str], int]:
    """Hostile-regression WAIT grammar (P1#5).

    CORE.md § 1.2 fixes the shape of a stop instruction at
    `WAIT: <category> -- <one sentence>`, plus the engine's own verbatim
    safety-valve pause. Three properties are load-bearing and each one was
    violated by the prefix/substring classifier this replaced:

      * the ` -- ` DELIMITER is mandatory (a bare `WAIT: blocked` names a kind
        of stop and asks nothing);
      * the body is ONE SENTENCE (a stop carrying notes is a queue);
      * the DONE brakes have FIXED wordings, and the MARKHUNT phrase makes a
        string legal only as that exact whole string -- never as a substring.

    At `phase: DONE` with an empty `## TODO`, CORE permits exactly THREE brakes
    (safety valve with the resume key its own intent owns, user brake, the
    untriaged-MARKHUNT brake). Every other legal WAIT there asks about work in
    flight that does not exist, so § 1.11's UNBLOCK exception routes it onward
    to documented repair instead of stopping. Router, validator and `saipen
    stop` all read the SAME parser, so a WAIT legal in one half can never be
    rejected by another.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if ok:
            print(f"PASS: hr-wait -- {label}")
        else:
            problems.append(f"{label}: {detail}")
            print(f"FAIL: hr-wait -- {label} -- {detail}")

    from saipen_engine.state import (
        DONE_EMPTY_BRAKES,
        MARKHUNT_BRAKE,
        WAIT_CATEGORIES,
        binding_wait,
        is_legal_wait,
        parse_wait,
        safety_valve_resume_key,
        state_contract_errors,
    )
    from saipen_engine.router import route_next

    VALVE = "WAIT: safety valve reached (3 waves / 20 tickets) -- run 'cc' to continue"
    VALVE_GOAL_OLD = (
        "WAIT: safety valve reached (3 waves / 20 tickets) -- run 'saipen goal' to continue"
    )
    VALVE_CC = "WAIT: safety valve reached (1 waves / 4 tickets) -- run 'cc' to continue"

    # ---- rejected shapes -------------------------------------------------
    hostile = [
        ("bare category, no delimiter", "WAIT: blocked"),
        ("bare category with trailing spaces", "WAIT:   blocked   "),
        ("no delimiter, prose glued on", "WAIT: blocked fake"),
        ("empty body after the delimiter", "WAIT: blocked --"),
        ("prefix collision on a real category", "WAIT: blockedness -- fake"),
        ("reversed label/sentence order", "WAIT: did the manual check pass? -- manual-verify"),
        (
            "second sentence in the body",
            "WAIT: blocked -- the sub is down. Also triage the three findings in ## BLOCKED",
        ),
        (
            "second sentence introduced by a backtick",
            "WAIT: user brake -- stop here. `saipen status` shows the rest",
        ),
        ("category outside the closed seven", "WAIT: vibes -- should I keep going?"),
        ("empty WAIT", "WAIT:"),
        (
            "safety valve with reversed units",
            "WAIT: safety valve reached (3 tickets / 20 tickets) -- nonsense",
        ),
        (
            "safety valve with an arbitrary suffix",
            "WAIT: safety valve reached (3 waves / 20 tickets) -- nonsense",
        ),
        (
            "safety valve with an unknown resume command",
            "WAIT: safety valve reached (3 waves / 20 tickets) -- run 'rm -rf /' to continue",
        ),
    ]
    for label, value in hostile:
        expect(f"REJECTS {label}", not is_legal_wait(value), repr(value))

    # A MARKHUNT mention INSIDE another category's body must NOT hijack the
    # classification: the WAIT's OWN category (`user brake`) decides, and the
    # substring is inert (hostile-regression, P1#5 substring collision).
    _markhunt_in_user_brake = "WAIT: user brake -- untriaged MARKHUNT findings in ## BLOCKED"
    expect(
        "a MARKHUNT substring inside another category stays that category",
        is_legal_wait(_markhunt_in_user_brake)
        and parse_wait(_markhunt_in_user_brake) == "user brake"
        and parse_wait(_markhunt_in_user_brake) != "markhunt",
        repr(_markhunt_in_user_brake),
    )

    # A NON-WAIT string carrying the brake phrase is not a WAIT at all, and
    # must never be classified as one (the substring matcher accepted it).
    for label, value in (
        (
            "plain prose carrying the MARKHUNT phrase",
            "saipen continue -- untriaged MARKHUNT findings in ## BLOCKED",
        ),
        (
            "PHASE action carrying 'safety valve'",
            "PHASE HUNT T-1 safety valve reached (3 waves / 20 tickets)",
        ),
    ):
        expect(
            f"REJECTS {label} (not a WAIT)",
            parse_wait(value) is None
            and binding_wait(value, phase="DONE", empty_todo=True) is None,
            repr(value),
        )

    # ---- accepted shapes -------------------------------------------------
    for category in WAIT_CATEGORIES:
        value = f"WAIT: {category} -- is this exact question answerable?"
        expect(
            f"ACCEPTS category {category!r} in a normal context",
            parse_wait(value) == category,
            repr(value),
        )
    expect(
        "ACCEPTS a mixed-case category",
        parse_wait("WAIT: Manual-Verify -- did the check pass?") == "manual-verify",
    )
    expect(
        "ACCEPTS the § 1.2 progress tag as a trailing suffix",
        parse_wait("WAIT: blocked -- is the sub back up? [2/7]") == "blocked",
    )
    expect(
        "ACCEPTS a body containing a version number (not a sentence break)",
        parse_wait("WAIT: first-publish -- publish v7.176.0 to the remote?") == "first-publish",
    )
    expect(
        "ACCEPTS the exact MARKHUNT brake", parse_wait(MARKHUNT_BRAKE) == "blocked", MARKHUNT_BRAKE
    )
    expect("ACCEPTS the exact safety-valve pause", parse_wait(VALVE) == "safety valve", VALVE)
    expect(
        "safety-valve resume key is the uniform `cc`, read from the pause itself",
        safety_valve_resume_key(VALVE) == "cc"
        and safety_valve_resume_key(VALVE_GOAL_OLD) is None
        and safety_valve_resume_key("WAIT: blocked -- x?") is None,
    )

    # ---- the STATE contract refuses the same set -------------------------
    GOOD = {
        "phase": "DONE",
        "task": "none",
        "next_action": "saipen continue",
        "blocker": "",
        "agent": "probe",
        "saipen_version": 7,
        "schema_version": 3,
        "mode": "full",
        "updated": "2026-08-16T00:00:00Z",
        "transition_from": "DONE",
    }
    expect(
        "STATE contract refuses a bare WAIT",
        any(
            "malformed WAIT" in e
            for e in state_contract_errors({**GOOD, "next_action": "WAIT: blocked"})
        ),
    )
    expect(
        "STATE contract refuses a two-sentence WAIT",
        any(
            "malformed WAIT" in e
            for e in state_contract_errors(
                {**GOOD, "next_action": "WAIT: blocked -- sub down. Triage the findings"}
            )
        ),
    )
    expect(
        "STATE contract accepts a legal WAIT",
        state_contract_errors({**GOOD, "next_action": "WAIT: blocked -- is the sub back?"}) == [],
    )
    expect(
        "STATE contract accepts the exact safety-valve pause",
        state_contract_errors({**GOOD, "next_action": VALVE}) == [],
    )

    # ---- DONE + empty TODO: exactly three brakes bind --------------------
    expect(
        "exactly three DONE-empty brakes are declared",
        DONE_EMPTY_BRAKES == ("safety valve", "user brake", "markhunt"),
        repr(DONE_EMPTY_BRAKES),
    )
    expect(
        "DONE+empty binds the user brake",
        binding_wait("WAIT: user brake -- stop here?", phase="DONE", empty_todo=True)
        == "user brake",
    )
    expect(
        "DONE+empty binds the exact MARKHUNT brake",
        binding_wait(MARKHUNT_BRAKE, phase="DONE", empty_todo=True) == "markhunt",
    )
    expect(
        "DONE+empty binds a goal-intent safety valve naming `cc`",
        binding_wait(VALVE, phase="DONE", empty_todo=True, intent="goal") == "safety valve",
    )
    expect(
        "DONE+empty binds a converge-intent valve naming `cc`",
        binding_wait(VALVE_CC, phase="DONE", empty_todo=True, intent="converge") == "safety valve",
    )
    expect(
        "DONE+empty REFUSES a valve naming the create/pivot key `saipen goal`",
        binding_wait(VALVE_GOAL_OLD, phase="DONE", empty_todo=True, intent="goal") is None
        and binding_wait(VALVE_GOAL_OLD, phase="DONE", empty_todo=True, intent="converge") is None,
    )
    for category in ("blocked", "manual-verify", "destructive-op", "first-publish", "init"):
        value = f"WAIT: {category} -- is this answerable?"
        expect(
            f"DONE+empty does NOT bind {category!r} (routes to repair)",
            binding_wait(value, phase="DONE", empty_todo=True) is None
            and parse_wait(value) == category,
            repr(value),
        )
    expect(
        "every legal WAIT binds OUTSIDE the DONE+empty context",
        all(
            binding_wait(f"WAIT: {c} -- answerable?", phase="BUILD", empty_todo=False) == c
            for c in WAIT_CATEGORIES
        ),
    )

    # ---- router agreement -------------------------------------------------
    def _state(na: str, phase: str = "DONE", task: str = "none", tf: str = "DONE") -> str:
        return (
            '---\nphase: %s\ntask: %s\nnext_action: "%s"\n'
            'transition_from: %s\nblocker: ""\nagent: probe\n'
            "saipen_version: 7\nmode: full\n"
            "updated: 2026-08-16T00:00:00Z\n---\n" % (phase, task, na, tf)
        )

    EMPTY_BOARD = "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n"
    WORKABLE_BOARD = (
        "# Board\n## DOING\n"
        "- [/] T-7 [P2] real work | verify: probe\n"
        "## TODO\n## DONE\n## BLOCKED\n"
    )
    stop = route_next(_state("WAIT: user brake -- stop here?"), EMPTY_BOARD)
    expect(
        "router restates a DONE+empty user brake",
        stop.get("action") == "WAIT: user brake -- stop here?"
        and stop.get("executable_behavior") == "RESTATE_AND_STOP",
        repr(stop),
    )
    routed_on = route_next(_state("WAIT: blocked -- is the sub back?"), EMPTY_BOARD)
    expect(
        "router routes PAST a non-brake WAIT at DONE+empty",
        routed_on.get("ok") and routed_on.get("reason") != "wait",
        repr(routed_on),
    )
    held = route_next(
        _state("WAIT: blocked -- is the sub back?", phase="BUILD", task="T-7", tf="PLAN"),
        WORKABLE_BOARD,
    )
    expect(
        "router holds a legal WAIT with workable tickets present",
        held.get("reason") == "wait" and held.get("executable_behavior") == "RESTATE_AND_STOP",
        repr(held),
    )
    return problems, checked


def run_hostile_state_probes() -> tuple[list[str], int]:
    """Hostile-regression shared STATE contract (hostile sweep P1): the
    engine's state_contract_errors mirrors state.schema.json (required set,
    enums, types, minimums, additionalProperties, execution-intent
    conditionals) so every engine consumer refuses what the release gate
    FAILs; a FUTURE schema_version is still allowed (the gate WARNS on it --
    the bump workflow must not block); an empty STATE is bootstrap-only and
    never projects an ordinary action; post-write verification refuses
    non-plain-UTF-8 (BOM) checkpoint files byte-wise.
    """
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if ok:
            print(f"PASS: hr-state -- {label}")
        else:
            problems.append(f"{label}: {detail}")
            print(f"FAIL: hr-state -- {label} -- {detail}")

    from saipen_engine.state import state_contract_errors
    from saipen_engine.router import route_next
    from saipen_engine.fast_check import validate_project
    from saipen_engine import codec

    GOOD = {
        "phase": "BUILD",
        "task": "probe",
        "next_action": "continue",
        "blocker": "",
        "agent": "probe",
        "saipen_version": 7,
        "schema_version": 3,
        "mode": "full",
        "execution_intent": "goal",
        "goal_waves": 1,
        "goal_tickets": 2,
        "updated": "2026-08-16T00:00:00Z",
        "transition_from": "PLAN",
        "requires": ["filesystem", "git"],
    }
    expect("contract accepts a fully valid state", state_contract_errors(GOOD) == [])
    expect(
        "unknown field refused (additionalProperties false)",
        any("unknown STATE field" in e for e in state_contract_errors({**GOOD, "bogus_field": 1})),
    )
    expect(
        "phase outside the 16-phase enum refused",
        any("phase" in e for e in state_contract_errors({**GOOD, "phase": "BOGUS"})),
    )
    expect(
        "transition_from outside the enum refused",
        any(
            "transition_from" in e for e in state_contract_errors({**GOOD, "transition_from": "X"})
        ),
    )
    expect(
        "mode outside enum refused",
        any("mode" in e for e in state_contract_errors({**GOOD, "mode": "stealth"})),
    )
    expect(
        "goal intent without counters refused",
        any(
            "goal" in e
            for e in state_contract_errors(
                {k: v for k, v in GOOD.items() if k not in ("goal_waves", "goal_tickets")}
            )
        ),
    )
    expect(
        "converge intent without target refused",
        any(
            "converge_target" in e
            for e in state_contract_errors(
                {**GOOD, "execution_intent": "converge", "goal_waves": None, "goal_tickets": None}
            )
        ),
    )
    expect(
        "converge intent with goal counters refused",
        any(
            "converge" in e
            for e in state_contract_errors(
                {**GOOD, "execution_intent": "converge", "converge_target": "crew"}
            )
        ),
    )
    expect(
        "non-goal intent with goal counters refused",
        any(
            "goal" in e
            for e in state_contract_errors(
                {**GOOD, "execution_intent": "normal", "goal_waves": 1, "goal_tickets": 2}
            )
        ),
    )
    expect(
        "string schema_version refused",
        any("schema_version" in e for e in state_contract_errors({**GOOD, "schema_version": "3"})),
    )
    expect(
        "future schema_version is not an engine error (gate WARNS, bump stays alive)",
        state_contract_errors({**GOOD, "schema_version": 9}) == [],
    )
    expect(
        "negative goal_waves refused (schema minimum)",
        any("goal_waves" in e for e in state_contract_errors({**GOOD, "goal_waves": -1})),
    )
    expect(
        "required field missing refused",
        any(
            "missing required field" in e
            for e in state_contract_errors({k: v for k, v in GOOD.items() if k != "blocker"})
        ),
    )

    root = Path(tempfile.mkdtemp(prefix="saipen-hr-state-"))
    (root / ".saipen").mkdir(parents=True)
    (root / ".saipen" / "BOARD.md").write_text(
        "# BOARD\n\n## ACTIVE\n\n- none\n\n## DOING\n\n"
        "## TODO\n\n## BLOCKED\n\n## DONE\n",
        encoding="utf-8",
    )
    (root / ".saipen" / "LOG.md").write_text("# LOG\n", encoding="utf-8")
    (root / ".saipen" / "STATE.md").write_text("", encoding="utf-8")

    routed = route_next(
        (root / ".saipen" / "STATE.md").read_text(encoding="utf-8"),
        (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"),
    )
    expect(
        "empty STATE routes bootstrap-only, never an ordinary action",
        routed.get("ok")
        and routed.get("action") == "saipen status"
        and routed.get("reason") == "bootstrap",
        f"routed={routed}",
    )

    (root / ".saipen" / "STATE.md").write_text(
        "---\nphase: INIT\ntask: none\nnext_action: saipen status\n"
        'blocker: ""\nagent: probe\nsaipen_version: 7\nmode: full\nupdated: '
        "2026-08-16T00:00:00Z\n---\n",
        encoding="utf-8",
    )
    expect(
        "plain-UTF-8 project passes post-write verification",
        validate_project(root) == [],
        "; ".join(validate_project(root)),
    )
    bom_state = (root / ".saipen" / "STATE.md").read_bytes()
    (root / ".saipen" / "STATE.md").write_bytes(b"\xef\xbb\xbf" + bom_state)
    bom_errs = validate_project(root)
    expect(
        "BOM-carrying STATE refused byte-wise at post-write verification",
        any("not plain UTF-8" in e for e in bom_errs),
        "; ".join(bom_errs),
    )
    expect(
        "codec reports the BOM file as non-canonical",
        codec.encoding_of(root / ".saipen" / "STATE.md") != "utf-8",
    )
    shutil.rmtree(root, ignore_errors=True)

    return problems, checked


def run_t1012_strict_grammar_probes() -> tuple[list[str], int]:
    """T-1012 strict declaration grammar: CONVERGE.md converge_targets:
    must be parsed as an ordered token sequence before set conversion.
    Duplicates, empty tokens, leading/trailing delimiters, invalid syntax,
    and multiple declarations must all cause hard FAIL."""
    problems: list[str] = []
    checked = 0

    import subprocess as _sp

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if ok:
            print(f"PASS: t1012-strict -- {label}")
        else:
            problems.append(f"{label}: {detail}")
            print(f"FAIL: t1012-strict -- {label} -- {detail}")

    # Hermetic: build disposable copy for all red-controls.
    # Canonical HOME is NEVER written to; mutations happen only in the
    # disposable copy so forced-kill at any point leaves HOME unchanged.
    with tempfile.TemporaryDirectory(prefix="saipen-t1012-") as _tmp:
        _sandbox = Path(_tmp) / "home"
        _sandbox.mkdir(parents=True, exist_ok=True)
        for _sub in ["saipen", ".saipen", "tools", "extensions", "bootstrap"]:
            _src = HOME / _sub
            if _src.is_dir():
                _dst = _sandbox / _sub
                shutil.copytree(
                    _src,
                    _dst,
                    dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
                )
        for _f in ["VERSION", "README.md", "CHANGELOG.md"]:
            _src = HOME / _f
            if _src.is_file():
                shutil.copy2(_src, _sandbox / _f)
        _conv_p = _sandbox / "saipen" / "CONVERGE.md"
        if not _conv_p.is_file():
            problems.append("t1012-strict: could not build disposable copy")
            return problems, checked
        _orig = _conv_p.read_text(encoding="utf-8-sig")
        _val = _sandbox / "tools" / "validate.py"

        def _run_validator() -> tuple[int, str]:
            pr = _sp.run(
                [sys.executable, str(_val)],
                cwd=str(_sandbox),
                capture_output=True,
                text=True,
                timeout=400,
            )
            return pr.returncode, pr.stdout + pr.stderr

        def _red_control(old: str, new: str, label: str, substr: str) -> None:
            """Mutate CONVERGE.md in disposable copy, run validator, assert FAIL."""
            _conv_p.write_text(_orig.replace(old, new), encoding="utf-8")
            _rc, _out = _run_validator()
            expect(
                f"converge: red-control {label} makes validator FAIL",
                _rc != 0 and substr in _out,
                f"rc={_rc} substr={substr!r} missing",
            )
            _conv_p.write_text(_orig, encoding="utf-8")
            _rc2, _out2 = _run_validator()
            expect(
                f"converge: red-control {label} restored -> converge-target gone",
                "converge-target" not in _out2,
                f"converge-target still present after restore: rc={_rc2}",
            )

        VALID_DECL = "converge_targets: done | ship | crew"

        # Duplicate token: crew appears twice
        _red_control(
            VALID_DECL,
            "converge_targets: done | ship | crew | crew",
            "duplicate converge target",
            "converge-target-converge",
        )

        # Empty middle token: double pipe
        _red_control(
            VALID_DECL,
            "converge_targets: done || ship | crew",
            "empty middle token",
            "converge-target-converge",
        )

        # Leading delimiter
        _red_control(
            VALID_DECL,
            "converge_targets: | done | ship | crew",
            "leading delimiter",
            "converge-target-converge",
        )

        # Trailing delimiter
        _red_control(
            VALID_DECL,
            "converge_targets: done | ship | crew |",
            "trailing delimiter",
            "converge-target-converge",
        )

        # Invalid token syntax (space in token)
        _red_control(
            VALID_DECL,
            "converge_targets: done | ship | cr ew",
            "invalid token syntax (space)",
            "converge-target-converge",
        )

        # Invalid token syntax (@ prefix)
        _red_control(
            VALID_DECL,
            "converge_targets: done | ship | @crew",
            "invalid token syntax (@)",
            "converge-target-converge",
        )

        # Extra empty between tokens
        _red_control(
            VALID_DECL,
            "converge_targets: done | ship |  | crew",
            "extra empty between tokens",
            "converge-target-converge",
        )

    return problems, checked


def run_perf_wave_probes() -> tuple[list[str], int]:
    """Execute the standalone perf-wave regression gate (T-1019..T-1022).

    The perf wave owns a separate hermetic runner: it times medians and
    monkeypatches module internals (subprocess.run, freshness internals), so
    it must run in its own process to keep the rest of the suite honest.
    Invoking it here makes the T-1019..T-1022 regressions part of the
    canonical full gate -- a fresh clone executes them every time the full
    suite runs, and the standalone file is also wired as an explicit CI
    step (T-1006).
    """
    problems: list[str] = []
    script = HOME / "tools" / "perf_wave_regressions.py"
    if not script.is_file():
        return [f"perf wave runner missing: {script}"], 1
    try:
        r = subprocess.run(
            [sys.executable, str(script)],
            cwd=HOME,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=1800,
        )
    except subprocess.TimeoutExpired:
        return ["perf wave regressions TIMEOUT after 1800s"], 1
    blob = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0:
        problems.append(f"perf wave regressions exited {r.returncode}: {blob[-600:]}")
    else:
        print("PASS: perf wave regressions (T-1019..T-1022)")
    return problems, 1


def run_continuity_probes() -> tuple[list[str], int]:
    """Execute the Work/Attempt continuity gate (T-1148) in its own process.

    SC-CONTINUITY-001 (the canonical cold-handoff scenario: agent A dies,
    cold agent B resumes the SAME Work from repository state alone, agent C
    independently verifies) plus the hostile matrix H1..H20 live in
    ``tools/continuity_probes.py``. Hermetic subprocess, same reasoning as
    the perf wave: the runner copies fixtures into temp projects and drives
    the real engine CLI with mock agent identities, so it must not share
    process state with this suite.
    """
    problems: list[str] = []
    script = HOME / "tools" / "continuity_probes.py"
    if not script.is_file():
        return [f"continuity runner missing: {script}"], 1
    try:
        r = subprocess.run(
            [sys.executable, str(script)],
            cwd=HOME,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=1800,
        )
    except subprocess.TimeoutExpired:
        return ["continuity probes TIMEOUT after 1800s"], 1
    blob = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0:
        problems.append(f"continuity probes exited {r.returncode}: {blob[-600:]}")
    else:
        print("PASS: continuity probes (SC-CONTINUITY-001 + H1..H20, T-1148)")
    return problems, 1


def run_source_receipt_probes() -> tuple[list[str], int]:
    """Run the T-1162 hostile/incident matrix inside the canonical scenario gate."""
    import unittest

    stream = io.StringIO()
    suite = unittest.defaultTestLoader.loadTestsFromName("test_source_receipts")
    result = unittest.TextTestRunner(stream=stream, verbosity=0).run(suite)
    problems = []
    for test, detail in result.failures + result.errors:
        problems.append(f"source receipts {test.id()}: {detail.splitlines()[-1]}")
    if problems:
        print(f"FAIL: source receipts -- {len(problems)}/{result.testsRun} failed")
    else:
        print(f"PASS: source receipts -- {result.testsRun}/{result.testsRun}")
    return problems, result.testsRun


def run_scenario_fixture_probes(
    enabled: bool = True,
) -> tuple[list[str], int, int]:
    """Validate every behavioral scenario fixture against a DISPOSABLE copy.

    PERF-001: the canonical validator writes a conformance receipt on every
    run, so pointing it at a repository-owned fixture manufactures nested
    runtime evidence inside the source tree. Git source-freshness then has to
    enumerate that debris as source on every later pass, which made the suite
    slower each time it ran. Each fixture is therefore copied into a temporary
    directory and only the copy is validated -- the repository stays
    byte-identical no matter how often the suite runs.

    Exposed at module level so the hermeticity proof can be exercised directly
    instead of only as a side effect of a full suite run.
    """
    if not SCENARIOS.is_dir():
        print(f"FAIL: no {SCENARIOS} -- run this from the SAIPEN home")
        sys.exit(1)
    if not enabled:
        return [], 0, 0

    def check_fixture(d: Path) -> tuple[list[str], int, int]:
        """One fixture's verdict, isolated from every other fixture's.

        T-1361: this was the body of the walk below, so an exception raised
        while checking ONE fixture ended the walk and deleted every later
        fixture from the record -- the same shape as the probe-group driver,
        one level down. Extracted so the caller can bound it: a fixture that
        explodes is a recorded failure and the walk continues.
        """
        failures: list[str] = []
        checked = skipped = 0

        readme = d / "README.md"
        has_state = (d / ".saipen").is_dir()
        declared = None
        reason = None
        warn_reason = None
        if readme.is_file():
            _rtext = readme.read_text(encoding="utf-8-sig")
            m = EXPECT_RE.search(_rtext)
            declared = m.group(1) if m else None
            _rm = REASON_RE.search(_rtext)
            reason = _rm.group(1) if _rm else None
            _wm = WARN_RE.search(_rtext)
            warn_reason = _wm.group(1) if _wm else None

        if not has_state:
            # Behavioral fixture. It must NOT declare an expectation -- there is
            # nothing to run, so a declaration here would be a promise no one keeps.
            if declared:
                failures.append(
                    f"{d.name}: declares 'expect: {declared}' but ships "
                    f"no .saipen/ -- nothing to run"
                )
            else:
                skipped += 1
            return failures, checked, skipped

        if declared is None:
            failures.append(
                f"{d.name}: ships a .saipen/ but declares no "
                f"'expect: pass|fail' line -- cannot be checked"
            )
            return failures, checked, skipped

        if declared == "fail" and not reason:
            failures.append(
                f"{d.name}: declares 'expect: fail' with no "
                f"'expect_fail_contains:' line -- an unpinned "
                f"fail-fixture asserts only that something went "
                f"wrong, and any unrelated FAIL then scores it green"
            )
            return failures, checked, skipped

        with tempfile.TemporaryDirectory(prefix="saipen-scenario-") as raw:
            disposable = Path(raw) / d.name
            shutil.copytree(d, disposable, symlinks=True, ignore=_IGNORE_RUNTIME)
            r = subprocess.run(
                [sys.executable, str(VALIDATOR), "--project-root", str(disposable)],
                cwd=disposable,
                capture_output=True,
                text=True,
            )
            actual = "pass" if r.returncode == 0 else "fail"
            checked += 1
            if actual != declared:
                detail = ""
                for line in (r.stdout + r.stderr).splitlines():
                    if line.startswith("FAIL"):
                        detail = f" | first FAIL: {line[:120]}"
                        break
                failures.append(
                    f"{d.name}: declared '{declared}', got '{actual}' "
                    f"(validator exit {r.returncode}){detail}"
                )
            elif declared == "fail" and reason:
                blob = r.stdout + r.stderr
                if "Traceback (most recent call last)" in blob:
                    last = next(
                        (
                            ln
                            for ln in reversed(blob.splitlines())
                            if ln.strip() and not ln.startswith(" ")
                        ),
                        "<no exception line>",
                    )
                    failures.append(
                        f"{d.name}: the validator CRASHED instead of "
                        f"reporting -- {last.strip()[:110]!r}. A traceback "
                        f"exits non-zero and can be mistaken for the "
                        f"declared failure; it is a defect in the tool"
                    )
                elif reason not in blob:
                    first = next(
                        (ln for ln in blob.splitlines() if ln.startswith("FAIL")), "<no FAIL line>"
                    )
                    failures.append(
                        f"{d.name}: failed as declared, but for the wrong "
                        f"reason -- expected {reason!r}, first FAIL was "
                        f"{first[:110]!r}"
                    )
                else:
                    print(f"PASS: {d.name} -- failed on {reason!r}, as declared")
            elif declared == "pass" and warn_reason:
                blob = r.stdout + r.stderr
                if warn_reason not in blob:
                    failures.append(
                        f"{d.name}: passed as declared, but missing expected warning -- "
                        f"expected {warn_reason!r}"
                    )
                else:
                    print(f"PASS: {d.name} -- passed and warned on {warn_reason!r}, as declared")
            else:
                if declared == "fail":
                    print(
                        f"WARN: {d.name} -- fails as declared, but pins no reason; "
                        f"add `expect_fail_contains:` so it cannot pass by failing "
                        f"at something unrelated"
                    )
                print(f"PASS: {d.name} -- expected {declared}, got {actual}")

        return failures, checked, skipped

    failures: list[str] = []
    checked = skipped = 0

    for d in sorted(p for p in SCENARIOS.iterdir() if p.is_dir()):
        try:
            one_failures, one_checked, one_skipped = check_fixture(d)
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as exc:
            # Attempted, so it counts: a crashed fixture is a red result, not
            # an absence from the denominator.
            failures.append(
                f"{d.name}: fixture harness crashed: {type(exc).__name__}: {exc}"
            )
            checked += 1
            continue
        failures.extend(one_failures)
        checked += one_checked
        skipped += one_skipped
    return failures, checked, skipped


def _main_impl():
    """Run targeted probe groups or the full suite.

    When any SAIPEN_*_PROBES_ONLY=1 selector is active, run ONLY the
    requested group (minimal bootstrap first) and exit immediately.
    Multiple conflicting selectors cause a hard error.
    No selector runs the full suite exactly as before.
    """

    # ---- PROBES_ONLY targeted dispatch -------------------------------------
    _PROBE_SELECTORS = {
        "SAIPEN_PRODUCER_GATE_PROBES_ONLY": "producer_gate",
        "SAIPEN_ROLE_FRESHNESS_PROBES_ONLY": "role_freshness",
        "SAIPEN_NITRO_M2_PROBES_ONLY": "nitro_m2",
        "SAIPEN_SAICREW_PROBES_ONLY": "saicrew",
        "SAIPEN_HR_PROBES_ONLY": "hostile_regression",
        "SAIPEN_HR_AUTHORITY_PROBES_ONLY": "hostile_authority",
        "SAIPEN_NITRO_INTEGRITY_PROBES_ONLY": "nitro_integrity",
        "SAIPEN_SCHEDULER_PROBES_ONLY": "scheduler",
        "SAIPEN_FINAL_STAB_PROBES_ONLY": "final_stabilization",
        "SAIPEN_RELEASE_EXECUTOR_PROBES_ONLY": "release_executor",
        "SAIPEN_SW_PROBES_ONLY": "second_wave",
        "SAIPEN_THIRD_WAVE_PROBES_ONLY": "third_wave",
        "SAIPEN_T1012_STRICT_PROBES_ONLY": "t1012_strict",
        "SAIPEN_PERF_WAVE_PROBES_ONLY": "perf_wave",
        "SAIPEN_SOURCE_RECEIPT_PROBES_ONLY": "source_receipts",
        "SAIPEN_IMPROVE_PROBES_ONLY": "improve",
    }
    _active = [k for k, v in _PROBE_SELECTORS.items() if os.environ.get(k) == "1"]
    if len(_active) > 1:
        _names = ", ".join(_PROBE_SELECTORS[k] for k in _active)
        print(f"FAILED: conflicting PROBES_ONLY selectors: {_names}")
        sys.exit(1)

    # Detect unknown SAIPEN_*_PROBES_ONLY selectors.
    _known_keys = set(_PROBE_SELECTORS.keys())
    for _k, _v in os.environ.items():
        if (
            _k.startswith("SAIPEN_")
            and _k.endswith("_PROBES_ONLY")
            and _v == "1"
            and _k not in _known_keys
        ):
            print(f"FAILED: unknown PROBES_ONLY selector: {_k}")
            sys.exit(1)

    # Capture selected group for dispatch (happens after all function defs).
    _selected_group = None
    if _active:
        _selected_group = _PROBE_SELECTORS[_active[0]]

    # ---- Full suite --------------------------------------------------------

    failures: list[str] = []
    checked = skipped = 0

    # Every behavioral fixture is validated in a disposable copy so the
    # validator's mandatory receipt emission never lands in the source tree.
    _fixture_failures, _fixture_checked, _fixture_skipped = run_scenario_fixture_probes(
        enabled=_selected_group is None
    )
    failures.extend(_fixture_failures)
    checked += _fixture_checked
    skipped += _fixture_skipped

    def run_digest_stale_probes() -> tuple[list[str], int]:
        problems = []
        checked = 0
        git = shutil.which("git")
        if not git:
            return ["digest-stale probes require git"], checked

        def git_run(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [git, *args], cwd=cwd, capture_output=True, text=True, errors="replace"
            )

        with tempfile.TemporaryDirectory(prefix="saipen-digest-") as raw:
            sandbox = Path(raw).resolve()
            project = sandbox / "project"
            project.mkdir()

            shutil.copytree(SCENARIOS / "resume-after-crash" / ".saipen", project / ".saipen")

            # Setup basic IS_SAIPEN_HOME
            (project / "VERSION").write_text("1.0.0\n", encoding="utf-8-sig")
            (project / "README.md").write_text("# SAIPEN\n", encoding="utf-8-sig")
            (project / ".saipen" / "kitchen").mkdir(exist_ok=True, parents=True)
            (project / ".saipen" / "kitchen" / "digest.md").write_text(
                "done: v0.9.0\nremaining: 0\nawaiting: none\n", encoding="utf-8-sig"
            )
            (project / "saipen").mkdir(exist_ok=True)
            (project / "saipen" / "RFC.md").write_text("", encoding="utf-8-sig")
            (project / "bootstrap").mkdir(exist_ok=True)
            (project / "CHANGELOG.md").write_text("## [1.0.0]\n", encoding="utf-8-sig")

            git_run(project, "init", "-q")
            git_run(project, "config", "user.name", "SAIPEN")
            git_run(project, "config", "user.email", "test@test")
            git_run(project, "add", ".")
            git_run(project, "commit", "-q", "-m", "Initial")
            git_run(project, "tag", "v0.9.0")

            # Test 1: pre-tag (tag for 1.0.0 does not exist yet)
            checked += 1
            res1 = subprocess.run(
                [sys.executable, str(VALIDATOR), "--project-root", str(project)],
                cwd=project,
                capture_output=True,
                text=True,
            )
            if "[digest-stale]" in res1.stdout or "[digest-stale]" in res1.stderr:
                problems.append(
                    "digest-stale warned incorrectly on pre-tag state: " + res1.stdout + res1.stderr
                )
            else:
                print("PASS: digest-stale -- no warning before tag is created")

            # Test 2: post-tag (tag for 1.0.0 exists, but digest names 0.9.0)
            git_run(project, "tag", "v1.0.0")
            checked += 1
            res2 = subprocess.run(
                [sys.executable, str(VALIDATOR), "--project-root", str(project)],
                cwd=project,
                capture_output=True,
                text=True,
            )
            if "[digest-stale]" not in res2.stdout and "[digest-stale]" not in res2.stderr:
                problems.append(
                    "digest-stale failed to warn after tag was "
                    "created: " + res2.stdout + res2.stderr
                )
            else:
                print("PASS: digest-stale -- warned correctly after tag exists")
        return problems, checked

    def run_orphan_tag_probes() -> tuple[list[str], int]:
        """A tag pushed while its branch did not land must FAIL validation.

        Reproduces the E-1787/E-1882 sequence: the branch push is rejected
        (never lands on the remote branch), the tag push runs anyway and
        succeeds, so the remote carries a tag whose commit is on no remote
        branch. Needs a real repository with a real remote -- the orphan check
        reads refs/remotes and ls-remote, so it cannot live in
        `tools/audit_checks.py`, whose snapshot excludes `.git`.
        """
        problems: list[str] = []
        checked = 0
        with tempfile.TemporaryDirectory(prefix="saipen-orphan-") as raw:
            home = Path(raw) / "home"
            origin = Path(raw) / "origin.git"
            shutil.copytree(
                HOME,
                home,
                ignore=shutil.ignore_patterns(
                    ".git", ".venv", "__pycache__", "node_modules", "nul", ".freebuff"
                ),
            )
            env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "probe",
                "GIT_AUTHOR_EMAIL": "probe@example.invalid",
                "GIT_COMMITTER_NAME": "probe",
                "GIT_COMMITTER_EMAIL": "probe@example.invalid",
            }

            def git(*args: str) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    ["git", *args], cwd=home, env=env, capture_output=True, text=True, check=False
                )

            def validate() -> str:
                r = subprocess.run(
                    [
                        sys.executable,
                        str(home / "tools" / "validate.py"),
                        "--project-root",
                        str(home),
                    ],
                    cwd=home,
                    capture_output=True,
                    text=True,
                    errors="replace",
                )
                return r.stdout + r.stderr

            def expect(label: str, output: str, contains: str, absent: str = "") -> None:
                nonlocal checked
                checked += 1
                details = []
                if contains and contains not in output:
                    details.append(f"missing {contains!r}")
                if absent and absent in output:
                    details.append(f"unexpected {absent!r}")
                if details:
                    problems.append(f"{label}: {'; '.join(details)}")
                else:
                    print(f"PASS: orphan tag -- {label}")

            if git("init", "-q").returncode != 0:
                print("SKIP: orphan tag probes -- git unavailable")
                return problems, checked
            git("add", "-A")
            git("commit", "-q", "-m", "probe")
            if git("init", "-q", "--bare", str(origin)).returncode != 0:
                print("SKIP: orphan tag probes -- cannot create bare remote")
                return problems, checked
            git("remote", "add", "origin", str(origin))
            if git("push", "-q", "-u", "origin", "HEAD:main").returncode != 0:
                print("SKIP: orphan tag probes -- cannot push initial main")
                return problems, checked

            # The rejected-branch-then-tag sequence: a release commit is made but
            # its branch push never lands (here: simply not pushed), while the tag
            # push succeeds -- the remote now carries a tag whose commit is on no
            # remote branch.
            (home / "orphan-release.txt").write_text("orphan\n", encoding="utf-8")
            git("add", "orphan-release.txt")
            git("commit", "-q", "-m", "release commit, branch push rejected")
            git("tag", "v7.176.0")
            if git("push", "-q", "origin", "refs/tags/v7.176.0").returncode != 0:
                print("SKIP: orphan tag probes -- cannot push the orphan tag")
                return problems, checked
            expect(
                "a published tag whose commit rides no remote branch fails",
                validate(),
                "FAIL: orphaned release tag",
            )

            # Repair: the branch push finally lands, the tag's commit becomes
            # reachable from origin/main, and the same tag now passes.
            if git("push", "-q", "origin", "HEAD:main").returncode != 0:
                print("SKIP: orphan tag probes -- cannot land the branch")
                return problems, checked
            expect(
                "the same tag passes once its branch has landed",
                validate(),
                "",
                absent="FAIL: orphaned release tag",
            )

        return problems, checked

    def run_ship_pick_probes() -> tuple[list[str], int]:
        """The ticket that passes REVIEW stays in `## DOING` through SHIP.

        `PHASE SHIP T-###` is RFC § 1.2's prescribed `next_action` for the one
        state SHIP is ever entered from, and the Pick Rule accepts it exactly
        while the ticket sits in `## DOING` -- a claimed `## DOING` ticket IS
        the pick. This repository's habit of closing the ticket at REVIEW
        (E-1879, T-466) moved it to `## DONE` before anything was pushed, so
        the same string named a finished ticket and failed the pick check
        twice over. Lives here rather than in `tools/audit_checks.py` because
        the condition spans two files -- STATE's `next_action` and the
        ticket's board section -- and that harness mutates one file per case
        (the compound-fixture route T-457 asks for).
        """
        problems: list[str] = []
        checked = 0
        with tempfile.TemporaryDirectory(prefix="saipen-ship-pick-") as raw:
            home = Path(raw) / "home"
            shutil.copytree(
                HOME,
                home,
                ignore=shutil.ignore_patterns(
                    ".git", ".venv", "__pycache__", "node_modules", "nul", ".freebuff"
                ),
            )

            style_path = home / "saipen" / "STYLE.md"
            style_text = (
                style_path.read_text(encoding="utf-8-sig", errors="replace")
                if style_path.is_file()
                else ""
            )
            _sm = re.search(r"`style_contract:\s*(ded-[0-9a-f]{8})`", style_text)
            style_token = _sm.group(1) if _sm else "ded-00000000"

            state_path = home / ".saipen" / "STATE.md"
            board_path = home / ".saipen" / "BOARD.md"
            log_path = home / ".saipen" / "LOG.md"

            def validate() -> str:
                r = subprocess.run(
                    [
                        sys.executable,
                        str(home / "tools" / "validate.py"),
                        "--project-root",
                        str(home),
                    ],
                    cwd=home,
                    capture_output=True,
                    text=True,
                    errors="replace",
                )
                return r.stdout + r.stderr

            def expect(label: str, output: str, contains: str, absent: str = "") -> None:
                nonlocal checked
                checked += 1
                details = []
                if contains and contains not in output:
                    details.append(f"missing {contains!r}")
                if absent and absent in output:
                    details.append(f"unexpected {absent!r}")
                if details:
                    problems.append(f"{label}: {'; '.join(details)}")
                else:
                    print(f"PASS: ship pick -- {label}")

            def write_fixture(in_doing: bool) -> None:
                # A self-contained fixture: minimal LOG (one event) so
                # last_event: 1 matches, and a board where the shipped ticket
                # lives in either ## DOING or ## DONE.
                log_path.write_text(
                    "- 03.08.26 00:00 [E-001] [T-901] RUN: probe\n", encoding="utf-8", newline="\n"
                )
                state_path.write_text(
                    "---\n"
                    "phase: SHIP\n"
                    "task: T-901\n"
                    'next_action: "PHASE SHIP T-901"\n'
                    "blocker: none\n"
                    "transition_from: REVIEW\n"
                    "saipen_version: 7\n"
                    "schema_version: 3\n"
                    "last_event: 1\n"
                    f"style_contract: {style_token}\n"
                    "agent: probe\n"
                    "mode: full\n"
                    "updated: 2026-01-01T00:00:00Z\n"
                    "---\n",
                    encoding="utf-8",
                    newline="\n",
                )
                section = (
                    "## DOING\n- [/] T-901 ship | owner: probe | "
                    "claim_time: 2026-01-01T00:00:00Z | verify: probe\n"
                    if in_doing
                    else "## DONE\n- [x] T-901 ship | verify: probe\n"
                )
                board_path.write_text(
                    "# Board\n"
                    + section
                    + "## TODO\n"
                    + ("## DONE\n" if in_doing else "## DOING\n")
                    + "## BLOCKED\n",
                    encoding="utf-8",
                    newline="\n",
                )

            write_fixture(in_doing=True)
            expect(
                "a ticket kept in ## DOING through SHIP validates",
                validate(),
                "",
                absent="finished and blocked tickets are not executable",
            )

            write_fixture(in_doing=False)
            expect(
                "the same ticket closed at REVIEW fails the pick rule",
                validate(),
                "finished and blocked tickets are not executable",
            )

        return problems, checked

    def run_active_task_recovery_probes() -> tuple[list[str], int]:
        """T-573: the crash pair is rejected, then RFC § 1.5 Recovery rebuilds it.

        The v7.215.0 crash checkpoint made STATE claim a ticket the board never
        put in ## DOING, and the validator called it conformant. The new check
        rejects both interruption directions (STATE ahead of BOARD, BOARD ahead
        of STATE). This probe performs § 1.5's Recovery on each and proves the
        result validates and that a repeated Recovery is a byte-level no-op. The
        project carries only a minimal `.saipen/` so no full-repo baggage (sealed
        LOG segments, sub boards, board barriers) can mask what is being tested.
        """
        problems: list[str] = []
        checked = 0
        with tempfile.TemporaryDirectory(prefix="saipen-active-task-") as raw:
            project = Path(raw) / "project"
            shutil.copytree(
                SCENARIOS / "stale-state-reconciliation" / ".saipen", project / ".saipen"
            )
            state_path = project / ".saipen" / "STATE.md"
            board_path = project / ".saipen" / "BOARD.md"
            log_path = project / ".saipen" / "LOG.md"
            style_token = live_style_marker()

            def validate() -> str:
                r = subprocess.run(
                    [sys.executable, str(VALIDATOR), "--project-root", str(project)],
                    cwd=project,
                    capture_output=True,
                    text=True,
                    errors="replace",
                )
                return r.stdout + r.stderr

            def expect(label: str, output: str, contains: str = "", absent: str = "") -> None:
                nonlocal checked
                checked += 1
                details = []
                if contains and contains not in output:
                    details.append(f"missing {contains!r}")
                if absent and absent in output:
                    details.append(f"unexpected {absent!r}")
                if details:
                    problems.append(f"{label}: {'; '.join(details)}")
                else:
                    print(f"PASS: active-task recovery -- {label}")

            def write_state(task: str, na: str, last_event: int) -> None:
                state_path.write_text(
                    "---\nphase: SCOUT\n"
                    f"task: {task}\n"
                    f'next_action: "{na}"\n'
                    "blocker: none\n"
                    "transition_from: DONE\n"
                    "saipen_version: 7\n"
                    "schema_version: 3\n"
                    f"last_event: {last_event}\n"
                    f"style_contract: {style_token}\n"
                    "agent: probe\n"
                    "mode: full\n"
                    "updated: 2026-01-01T00:00:00Z\n"
                    "---\n",
                    encoding="utf-8",
                    newline="\n",
                )

            def write_log(ticket: str) -> None:
                log_path.write_text(
                    f"- 08.08.26 00:00 [E-001] [{ticket}] RUN: probe\n",
                    encoding="utf-8",
                    newline="\n",
                )

            def recover(ticket: str, claim_board: bool, label: str) -> None:
                # No-op when the previous recovery already produced this state:
                # RFC § 1.5's idempotency, proven byte-for-byte by the caller.
                board = board_path.read_text(encoding="utf-8-sig")
                state = state_path.read_text(encoding="utf-8-sig")
                already = f"task: {ticket}" in state and re.search(
                    r"^## DOING\n- \[/\] " + ticket + r"\b", board, re.MULTILINE
                )
                if already:
                    return
                recovery_dir = project / ".saipen" / "recovery"
                recovery_dir.mkdir(parents=True, exist_ok=True)
                shutil.copy2(state_path, recovery_dir / f"{label}-STATE.md")
                log = log_path.read_text(encoding="utf-8-sig").rstrip()
                log += f"\n- 08.08.26 00:01 [E-002] [{ticket}] DEC: RECOVER -- {label}\n"
                log_path.write_text(log, encoding="utf-8", newline="\n")
                if claim_board:
                    board_path.write_text(
                        "# Board\n## DOING\n"
                        f"- [/] {ticket} [P0] crash | owner: probe | "
                        "claim_time: 2026-01-01T00:00:00Z | verify: probe\n"
                        "## TODO\n## DONE\n## BLOCKED\n",
                        encoding="utf-8",
                        newline="\n",
                    )
                write_state(ticket, f"PHASE SCOUT {ticket}", 2)

            # Case A: STATE ahead of BOARD -- task claimed, no ## DOING ticket.
            write_state("T-999", "PHASE SCOUT T-999", 1)
            write_log("T-999")
            board_path.write_text(
                "# Board\n## DOING\n## TODO\n"
                "- [ ] T-999 [P0] crash | verify: probe\n"
                "## DONE\n## BLOCKED\n",
                encoding="utf-8",
                newline="\n",
            )
            expect(
                "STATE ahead of BOARD is rejected", validate(), "is not the claimed ## DOING ticket"
            )
            recover("T-999", claim_board=True, label="crash-A")
            expect("Recovery of case A validates", validate(), "Agent is conformant")
            snap = (state_path.read_bytes(), board_path.read_bytes(), log_path.read_bytes())
            recover("T-999", claim_board=True, label="crash-A")
            again = (state_path.read_bytes(), board_path.read_bytes(), log_path.read_bytes())
            expect(
                "repeated Recovery of case A is byte-idempotent",
                "same" if snap == again else "differed",
                contains="same",
            )

            # Case B: BOARD ahead of STATE -- self-claimed ## DOING, task: none.
            write_state("none", "saipen continue", 1)
            write_log("T-100")
            board_path.write_text(
                "# Board\n## DOING\n"
                "- [/] T-100 [P0] claimed | owner: probe | "
                "claim_time: 2026-01-01T00:00:00Z | verify: probe\n"
                "## TODO\n## DONE\n## BLOCKED\n",
                encoding="utf-8",
                newline="\n",
            )
            expect("BOARD ahead of STATE is rejected", validate(), "STATE is behind BOARD")
            recover("T-100", claim_board=False, label="crash-B")
            expect("Recovery of case B validates", validate(), "Agent is conformant")
            snap = (state_path.read_bytes(), board_path.read_bytes(), log_path.read_bytes())
            recover("T-100", claim_board=False, label="crash-B")
            again = (state_path.read_bytes(), board_path.read_bytes(), log_path.read_bytes())
            expect(
                "repeated Recovery of case B is byte-idempotent",
                "same" if snap == again else "differed",
                contains="same",
            )

        return problems, checked

    # ---- Targeted dispatch (after all function definitions) ---------
    if _selected_group is not None:
        _GROUPS = {
            "producer_gate": [run_producer_gate_probes],
            "role_freshness": [run_role_freshness_probes],
            "nitro_m2": [run_nitro_m2_probes],
            "saicrew": [run_saicrew_probes],
            "hostile_regression": [
                run_hostile_journal_probes,
                run_hostile_release_probes,
                run_hostile_convergence_probes,
                run_hostile_state_probes,
            ],
            "hostile_authority": [run_hostile_authority_probes],
            "nitro_integrity": [run_nitro_integrity_probes],
            "scheduler": [run_scheduler_probes],
            "final_stabilization": [
                run_hardening_control_inventory,
                run_digest_stale_probes,
                run_orphan_tag_probes,
                run_active_task_recovery_probes,
                run_t1012_strict_grammar_probes,
                run_log_tail_probes,
            ],
            "release_executor": [
                run_release_executor_probes,
                run_hardening_control_inventory,
                run_t1012_strict_grammar_probes,
            ],
            "second_wave": [
                run_injector_probes,
                run_project_root_probes,
                run_export_probes,
                run_manifest_tracking_probes,
                run_lint_parity_probes,
                run_autoinject_manifest_probes,
                run_ship_staging_probes,
                run_release_freshness_probes,
                run_ci_status_probes,
                run_hook_probes,
                run_precommit_purity_probe,
            ],
            "third_wave": [
                run_nitro_probes,
                run_nitro_m2_probes,
                run_nitro_m3_probes,
                run_producer_gate_probes,
                run_ccc_identity_probes,
                run_converge_routing_probes,
            ],
            "t1012_strict": [run_t1012_strict_grammar_probes],
            "perf_wave": [run_perf_wave_probes],
            "source_receipts": [run_source_receipt_probes],
            "improve": [run_improve_probes],
        }
        if _selected_group not in _GROUPS:
            print(f"FAILED: no probe group for {_selected_group!r}")
            sys.exit(1)
        _all_f, _all_c = [], 0
        for _func in _GROUPS[_selected_group]:
            _res = _func()
            _all_f.extend(_res[0])
            _all_c += _res[1]
        for p in _all_f:
            print(f"FAILED: {p}")
        # Real scoped summary (perf wave T-1022): the targeted runner must
        # terminate with explicit PASS/FAIL counts for the group it ran, not
        # just a raw behavior count, so a green exit is auditable.
        _passed = _all_c - len(_all_f)
        print(f"{_selected_group}: {_passed}/{_all_c} checks passed, {len(_all_f)} failed")
        raise SystemExit(1 if _all_f else 0)

    # ---- Full suite probe execution ----------------------------------------
    #
    # T-1361: a TABLE, not forty-four hand-written call/extend pairs. Only
    # `run_saicrew_probes` was wrapped, so any OTHER group that RAISED took the
    # whole suite down with it -- and everything below it vanished from the
    # record, green or red. That is exactly what happened: the suite reported
    # 751 PASS / 3 FAIL and stopped, and repairing the crash revealed roughly
    # 153 checks nobody had seen. A suite that can lose its own tail reports
    # less than it measured, and there is no way to tell the difference from
    # the outside.
    #
    # Every group is attempted. An exception is a bounded recorded failure.
    # The totals below are the totals of what was ATTEMPTED, so a crashed
    # group is visible as a zero with a reason rather than as an absence.
    probe_groups = (
        ("injector", run_injector_probes, "injector(s) executed"),
        ("scheduler", run_scheduler_probes, "scheduler behavior(s) executed"),
        ("project-root", run_project_root_probes, "project-root behavior(s) executed"),
        ("export", run_export_probes, "export ownership behavior(s) executed"),
        ("crew", run_crew_probes, "crew-launch behavior(s) executed"),
        ("saicrew", run_saicrew_probes, "saicrew hostile-control behavior(s) executed"),
        ("last-event", run_last_event_probes, "last_event migration behavior(s) executed"),
        ("log-tail", run_log_tail_probes, "log-tail behavior(s) executed"),
        ("hunt-mark", run_hunt_mark_probes, "hunt-mark behavior(s) executed"),
        ("converge-routing", run_converge_routing_probes, "converge-routing behavior(s) executed"),
        ("ccc-identity", run_ccc_identity_probes, "ccc commit-identity behavior(s) executed"),
        ("producer-gate", run_producer_gate_probes, "producer-gate behavior(s) executed"),
        ("ship-staging", run_ship_staging_probes, "ship-staging behavior(s) executed"),
        (
            "release-freshness",
            run_release_freshness_probes,
            "release-freshness behavior(s) executed",
        ),
        ("release-executor", run_release_executor_probes, "release-executor behavior(s) executed"),
        ("role-freshness", run_role_freshness_probes, "role-freshness behavior(s) executed"),
        ("sub-clean", run_sub_clean_probes, "sub-clean safety behavior(s) executed"),
        ("hardening", run_hardening_control_inventory, "hardening red control(s) resolved"),
        ("userperson", run_userperson_probes, "userperson behavior(s) executed"),
        ("source-receipt", run_source_receipt_probes, "source-receipt behavior(s) executed"),
        ("improve", run_improve_probes, "improve behavior(s) executed"),
        ("nitro", run_nitro_probes, "nitro behavior(s) executed"),
        ("nitro-m2", run_nitro_m2_probes, "nitro-m2 behavior(s) executed"),
        ("nitro-m3", run_nitro_m3_probes, "nitro-m3 behavior(s) executed"),
        ("nitro-integrity", run_nitro_integrity_probes, "nitro-integrity behavior(s) executed"),
        (
            "manifest-tracking",
            run_manifest_tracking_probes,
            "manifest-tracking behavior(s) executed",
        ),
        ("lint-parity", run_lint_parity_probes, "lint-parity behavior(s) executed"),
        (
            "autoinject-manifest",
            run_autoinject_manifest_probes,
            "autoinject-manifest behavior(s) executed",
        ),
        ("installed-hook", run_hook_probes, "installed-hook behavior(s) executed"),
        ("ci-status", run_ci_status_probes, "ci-status behavior(s) executed"),
        ("precommit-purity", run_precommit_purity_probe, "pre-commit-purity behavior(s) executed"),
        (
            "hostile-journal",
            run_hostile_journal_probes,
            "hostile-regression journal behavior(s) executed",
        ),
        (
            "hostile-release",
            run_hostile_release_probes,
            "hostile-regression release behavior(s) executed",
        ),
        (
            "hostile-convergence",
            run_hostile_convergence_probes,
            "hostile-regression convergence behavior(s) executed",
        ),
        (
            "hostile-state",
            run_hostile_state_probes,
            "hostile-regression state-contract behavior(s) executed",
        ),
        (
            "hostile-authority",
            run_hostile_authority_probes,
            "hostile-regression authority behavior(s) executed",
        ),
        (
            "hostile-wait",
            run_hostile_wait_probes,
            "hostile-regression WAIT-grammar behavior(s) executed",
        ),
        ("digest-stale", run_digest_stale_probes, "digest-stale behavior(s) executed"),
        ("orphan-tag", run_orphan_tag_probes, "orphan-tag behavior(s) executed"),
        ("ship-pick", run_ship_pick_probes, "ship-pick behavior(s) executed"),
        (
            "active-task-recovery",
            run_active_task_recovery_probes,
            "active-task recovery behavior(s) executed",
        ),
        (
            "t1012-strict-grammar",
            run_t1012_strict_grammar_probes,
            "T-1012 strict-grammar behavior(s) executed",
        ),
        (
            "perf-wave",
            run_perf_wave_probes,
            "perf-wave regression gate(s) executed (T-1019..T-1022)",
        ),
        (
            "continuity",
            run_continuity_probes,
            "continuity gate(s) executed (SC-CONTINUITY-001 + H1..H20)",
        ),
    )

    group_results = run_probe_groups(probe_groups)
    for result in group_results:
        failures.extend(result.failures)

    print(
        f"\n{checked} executable fixture(s) checked, "
        f"{skipped} behavioral fixture(s) skipped (README-only by design)"
    )
    for result in group_results:
        print(result.summary_line())

    attempted = len(probe_groups)
    executed = sum(1 for result in group_results if result.crashed is None)
    print(
        f"{executed} of {attempted} probe group(s) reached a verdict; "
        f"{sum(result.checked for result in group_results)} grouped check(s) executed"
    )

    if failures:
        print(f"\nFAILED: {len(failures)} executable check(s) failed")
        for f in failures:
            print(f"FAILED: {f}")
        sys.exit(1)

    if checked == 0:
        # A run that checked nothing is not a pass (phases/verify.md: a gate that
        # cannot fail is not a gate).
        print("FAILED: no executable fixtures found -- this suite collected 0 tests")
        sys.exit(1)

    print("All executable scenarios and injector probes passed.")


#: A HOST SESSION's project binding. Inheriting it into the disposable
#: fixture projects this suite drives is wrong twice over: `paths.py` reads the
#: ambient lineage as the expected one and refuses every explicit foreign root
#: with PROJECT_LINEAGE_MISMATCH, and the adapter's own binding check then
#: re-refuses the child. That is correct for a bound session and false for a
#: hermetic fixture run -- CI has none of these variables. Measured 2026-09-17
#: (T-1392 repair path: clearing them turns the same two tests green) and
#: 2026-09-20 (T-1361 remeasurement: same claim, 41 PROJECT_LINEAGE_MISMATCH
#: in one run, and an improve fixture that resolved the HOST project).
_SESSION_CARRIER_VARS = (
    "SAIPEN_PROJECT_ROOT",
    "SAIPEN_PROJECT_LINEAGE",
    "SAIPEN_AGENT",
    "SAIPEN_HOST_SESSION",
)


@contextlib.contextmanager
def session_carrier_isolation():
    """Run nested code with this session's project carriers removed."""
    saved = {
        name: os.environ.pop(name)
        for name in _SESSION_CARRIER_VARS
        if name in os.environ
    }
    try:
        yield
    finally:
        os.environ.update(saved)


def main():
    """Run hermetically: developer USERPERSON must never influence CI."""
    with session_carrier_isolation(), tempfile.TemporaryDirectory(
        prefix="saipen-scenarios-user-config-"
    ) as config, mock.patch.dict(
        os.environ, {"SAIPEN_USER_CONFIG_HOME": config}, clear=False
    ):
        return _main_impl()


if __name__ == "__main__":
    main()
