"""Canonical, non-recursive test orchestration for ``saipen test``.

Every family runs against one disposable copy of the current working tree.
This keeps the public ``tt`` command read-only even when a validator or
scenario deliberately emits recovery/conformance evidence as part of its
test.  The family list is explicit: discovery can add tests inside a family,
but can never accidentally make the orchestrator discover and invoke itself.
"""

from __future__ import annotations

import json
import os
import signal
import shutil
import subprocess
import sys
import tempfile
from contextlib import nullcontext, suppress
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TestFamily:
    """One independently reported canonical test family."""

    name: str
    command: tuple[str, ...]
    timeout: int


def _python(*args: str) -> tuple[str, ...]:
    return (sys.executable, "-B", *args)


def _portable_floor() -> tuple[str, ...] | None:
    if os.name == "nt":
        shell = shutil.which("pwsh") or shutil.which("powershell")
        if shell:
            return (
                shell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                "tests/validate.ps1",
            )
        return None
    shell = shutil.which("bash")
    return (shell, "tests/validate.sh") if shell else None


def _families() -> tuple[TestFamily, ...]:
    portable = _portable_floor()
    families = [
        TestFamily(
            "unit",
            _python(
                "-m",
                "unittest",
                "discover",
                "-s",
                "tools",
                "-p",
                "test_*.py",
                "-v",
            ),
            # T-1344: measured 2254 s for 3475 tests on the operator host; the
            # old 600 s bound made every run of the family a TIMEOUT verdict.
            5400,
        ),
        TestFamily(
            "consumer-unit",
            _python(
                "-m",
                "unittest",
                "discover",
                "-s",
                "tests",
                "-p",
                "test_*.py",
                "-v",
            ),
            600,
        ),
        TestFamily("validator", _python("tools/validate.py"), 600),
        TestFamily("audit-checks", _python("tools/audit_checks.py"), 900),
        TestFamily("scenarios", _python("tools/run_scenarios.py"), 1800),
        TestFamily("audit-floor", _python("tools/audit_floor.py"), 600),
        TestFamily("audit-parity", _python("tools/audit_parity.py"), 1200),
        TestFamily("audit-order", _python("tools/audit_order.py"), 300),
        TestFamily("audit-tags", _python("tools/audit_tags.py"), 300),
        TestFamily(
            "ruff",
            _python("-m", "ruff", "check", "tools/", "tests/"),
            300,
        ),
    ]
    if portable is not None:
        families.append(TestFamily("portable-floor", portable, 300))
    else:
        families.append(TestFamily("portable-floor", (), 0))
    return tuple(families)


def canonical_test_plan(_project_root: Path | str) -> list[dict]:
    """Return the stable family plan without running or writing anything."""
    return [
        {
            "name": family.name,
            "command": list(family.command),
            "timeout": family.timeout,
            "available": bool(family.command),
        }
        for family in _families()
    ]


_SESSION_LOCAL = frozenset({".workbuddy-ai", ".pytest_cache", ".ruff_cache", ".mypy_cache"})


def _ignore_copy(_directory: str, names: list[str]) -> set[str]:
    ignored = {name for name in names if name == "__pycache__" or name.endswith(".pyc")}
    # These are editor/session-local and have no bearing on the declared test
    # surface. Everything else, including .git and canonical .saipen state, is
    # copied so the sandbox sees the same current working-tree generation.
    # Lint caches too (T-1483): REVIEW runs ruff after VERIFY's family run,
    # and a cache inside the tested subject made that run cite nothing.
    ignored.update(name for name in names if name in _SESSION_LOCAL)
    if os.name == "nt":
        reserved = {"CON", "PRN", "AUX", "NUL"}
        reserved.update(f"COM{index}" for index in range(1, 10))
        reserved.update(f"LPT{index}" for index in range(1, 10))
        ignored.update(
            name
            for name in names
            if name.rstrip(" .").split(".", 1)[0].upper() in reserved
        )
    return ignored


def _tail(text: str, limit: int = 8000) -> str:
    return text if len(text) <= limit else text[-limit:]


def _read_tail_from_path(path: Path, limit: int = 8000) -> str:
    """Read the bounded suffix of a temp-file child output without retaining
    the full file in memory."""
    try:
        size = path.stat().st_size
    except OSError:
        return ""
    with open(path, "rb") as handle:
        handle.seek(max(0, size - (limit * 4 + 4)))
        data = handle.read()
    return _tail(data.decode("utf-8", errors="replace"), limit)


def _terminate_process_tree(process: subprocess.Popen) -> None:
    """Terminate the owned family process and all descendants."""
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(process.pid)],
            capture_output=True,
            check=False,
        )
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, OSError):
        with suppress(ProcessLookupError, OSError):
            process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        with suppress(ProcessLookupError, OSError):
            os.killpg(process.pid, signal.SIGKILL)
        with suppress(ProcessLookupError, OSError):
            process.kill()


def _run_family(root: Path, family: TestFamily, *, spool: Path | None = None) -> dict:
    """Run one family; its report keeps only the bounded output tails.

    ``spool`` names a caller-owned directory that receives the COMPLETE
    ``stdout``/``stderr`` files, for a caller that must parse the whole run
    (the core-unit evidence reads every failure header, not the tail).
    """
    if not family.command:
        return {
            "name": family.name,
            "status": "NOT_AVAILABLE",
            "exit_code": None,
            "detail": "required platform shell is unavailable",
        }
    from .paths import unbound_environment

    # T-1442: a family run is evidence about the tree, never about the session
    # that launched it. The operator's project binding, host session and seat
    # (the engine's one carrier list, plus SAIPEN_AGENT) are not inherited, so
    # a module that forgot `isolate_host_session` cannot bind the live project
    # or read as that session's claim, and the verdict does not follow whoever
    # holds the seat.
    env = unbound_environment(os.environ.copy(), SAIPEN_AGENT=None)
    # T-1497: nor the operator's SAIMAIL mailbox -- a family run never reads it.
    env.pop("SAIMAIL_WORKSPACE", None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["SAIPEN_CANONICAL_TEST_CHILD"] = "1"
    creation = {"start_new_session": True} if os.name != "nt" else {
        "creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    }
    spool_context = (
        nullcontext(str(spool))
        if spool is not None
        else tempfile.TemporaryDirectory(prefix="saipen-family-")
    )
    with spool_context as spool_name:
        spool_dir = Path(spool_name)
        stdout_path = spool_dir / "stdout"
        stderr_path = spool_dir / "stderr"
        process: subprocess.Popen | None = None
        timed_out = False
        try:
            try:
                with open(stdout_path, "wb") as out, open(stderr_path, "wb") as err:
                    process = subprocess.Popen(
                        family.command,
                        cwd=root,
                        env=env,
                        stdout=out,
                        stderr=err,
                        **creation,
                    )
            except OSError as exc:
                return {
                    "name": family.name,
                    "status": "FAIL",
                    "exit_code": None,
                    "stdout": "",
                    "stderr": f"test family launch failed: {exc}",
                }
            try:
                process.wait(timeout=family.timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                _terminate_process_tree(process)
                process.wait()
            if timed_out and process.stdout is not None:
                with suppress(OSError):
                    process.stdout.close()
            if timed_out and process.stderr is not None:
                with suppress(OSError):
                    process.stderr.close()
            stdout_text = _read_tail_from_path(stdout_path)
            stderr_text = _read_tail_from_path(stderr_path)
            return {
                "name": family.name,
                "status": (
                    "TIMEOUT"
                    if timed_out
                    else ("PASS" if process.returncode == 0 else "FAIL")
                ),
                "exit_code": None if timed_out else process.returncode,
                "stdout": stdout_text,
                "stderr": stderr_text,
            }
        finally:
            # W2-003: every abnormal exit from this frame (KeyboardInterrupt,
            # SystemExit, BaseException) must still terminate the owned
            # process tree. The TimeoutExpired branch owns the timeout path;
            # this finally owns the rest. Reaping is idempotent.
            if (
                process is not None
                and process.poll() is None
            ):
                _terminate_process_tree(process)
                with suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=5)


def run_canonical_suite(project_root: Path | str) -> dict:
    """Run every declared family in a disposable working-tree copy."""
    source = Path(project_root).resolve()
    if not source.is_dir():
        return {
            "ok": False,
            "families": [
                {
                    "name": "bootstrap",
                    "status": "FAIL",
                    "detail": f"project root does not exist: {source}",
                }
            ],
        }
    with tempfile.TemporaryDirectory(prefix="saipen-test-") as tmp:
        sandbox = Path(tmp) / "project"
        shutil.copytree(source, sandbox, symlinks=True, ignore=_ignore_copy)
        reports = [_run_family(sandbox, family) for family in _families()]
    return {
        "ok": all(item["status"] == "PASS" for item in reports),
        "families": reports,
    }


def main(argv: list[str] | None = None) -> int:
    """CI entry point; ``--family`` uses the same explicit family registry."""
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", default=".")
    parser.add_argument("--family")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    source = Path(args.project_root).resolve()
    selected = [family for family in _families() if family.name == args.family]
    if args.family and not selected:
        report = {
            "ok": False,
            "families": [
                {
                    "name": args.family,
                    "status": "FAIL",
                    "detail": "unknown family",
                }
            ],
        }
    elif args.family:
        with tempfile.TemporaryDirectory(prefix="saipen-test-") as tmp:
            sandbox = Path(tmp) / "project"
            shutil.copytree(source, sandbox, symlinks=True, ignore=_ignore_copy)
            reports = [_run_family(sandbox, family) for family in selected]
        report = {
            "ok": all(item["status"] == "PASS" for item in reports),
            "families": reports,
        }
    else:
        report = run_canonical_suite(source)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        for item in report["families"]:
            print(f"{item['name']}: {item['status']}")
            if item["status"] != "PASS":
                detail = item.get("detail") or item.get("stderr") or item.get("stdout")
                if detail:
                    print(detail)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
