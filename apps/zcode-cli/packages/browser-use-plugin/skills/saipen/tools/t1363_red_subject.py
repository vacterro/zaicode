"""The RED subject for T-1363: this tree with the T-1363 slice removed.

A control that has only ever been green proves nothing about the defect it
claims to close. This builds a disposable copy of the CURRENT tree, puts every
file T-1363 touches back to its HEAD bytes (and deletes the two files T-1363
adds), copies the UNCHANGED regression module in, and runs it there.

Same verifier, moved subject. The module must FAIL on that tree and pass on
this one; a control that survives the removal of its own fix is measuring
something else and is reported by name.

    python tools/t1363_red_subject.py            # build, run, report
    python tools/t1363_red_subject.py --keep     # leave the subject on disk
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
MODULE = "tools/test_t1363_zero_manual_entry.py"
#: The commit BEFORE the T-1363 slice. Pinned, not `HEAD`: once the slice is
#: committed, `HEAD` carries the fix and the subject stops being red -- which
#: would quietly retire the oracle exactly when it starts mattering.
BASE = "005a8ac2"

#: Files the T-1363 slice CHANGES. Each goes back to its HEAD bytes.
REVERTED = (
    "saipen/BOOT.md",
    "saipen/COMMANDS.md",
    "saipen/MANIFEST.json",
    "saipen/REGISTRY.json",
    "tools/saipen.py",
    "tools/saipen_engine/admission.py",
    "tools/saipen_engine/guard_events.py",
    "tools/saipen_engine/journal.py",
    "tools/saipen_engine/operations.py",
    "tools/saipen_engine/reconcile.py",
    # Adjacent controls the slice MOVED: each measured a property against the
    # old owner, and reverting them proves this module is the only verifier
    # that changed.
    "tools/test_guard_events.py",
    "tools/test_opencode_adapter.py",
    "tools/test_recovery_reachability.py",
    "tools/test_runtime_bootstrap.py",
    "tools/test_search_transport.py",
    "extensions/adapters/opencode/saipen-guard.js",
)
#: Files the T-1363 slice ADDS. Each is removed from the subject.
REMOVED = (
    "saipen/COMMAND_EFFECTS.json",
    "tools/saipen_engine/command_effects.py",
    "tools/saipen_engine/entry.py",
)
#: Copied only as far as the module needs: protocol documents, the tools tree,
#: the host adapters. Project memory, history and caches are not subjects.
COPIED = ("tools", "saipen", "extensions", "bootstrap")
_IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules", ".git")


def build(destination: Path, base: str = BASE) -> Path:
    shutil.rmtree(destination, ignore_errors=True)
    destination.mkdir(parents=True)
    for name in COPIED:
        source = REPO / name
        if source.is_dir():
            shutil.copytree(source, destination / name, ignore=_IGNORE)
    for relative in REVERTED:
        head = subprocess.run(
            ["git", "show", f"{base}:{relative}"],
            cwd=REPO,
            capture_output=True,
            check=True,
        ).stdout
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(head)
    for relative in REMOVED:
        (destination / relative).unlink(missing_ok=True)
    # The verifier itself is NOT part of the subject: it is copied verbatim
    # from the working tree, so the only thing that moved is the code it
    # measures.
    shutil.copyfile(REPO / MODULE, destination / MODULE)
    return destination


def run(tree: Path) -> tuple[int, str]:
    completed = subprocess.run(
        [sys.executable, str(tree / MODULE)],
        cwd=tree,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=3600,
    )
    return completed.returncode, completed.stdout + completed.stderr


def classes(output: str) -> dict[str, int]:
    found: dict[str, int] = {}
    for name in re.findall(r"^(?:FAIL|ERROR): \S+ \(__main__\.(\w+)\.", output, re.MULTILINE):
        found[name] = found.get(name, 0) + 1
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--base", default=BASE)
    args = parser.parse_args()

    base = Path(tempfile.mkdtemp(prefix="t1363-red-"))
    try:
        subject = build(base / "subject", args.base)
        code, output = run(subject)
        red = classes(output)
        total = re.search(r"^Ran (\d+) tests", output, re.MULTILINE)
        print(f"subject: {subject}")
        print(f"verifier: {MODULE} (verbatim from the working tree)")
        print(f"reverted: {len(REVERTED)} file(s) to {args.base}; removed: {len(REMOVED)}")
        print(f"exit: {code}; ran {total.group(1) if total else '?'} test(s)")
        if code == 0:
            print("RED SUBJECT FAILED: the module passes WITHOUT the T-1363 slice.")
            print(output[-4000:])
            return 1
        print("red classes (failures/errors per control class):")
        for name in sorted(red):
            print(f"  {name}: {red[name]}")
        expected = {
            "CommandEffectOwnerTests",
            "DiagnosticLivenessTests",
            "IngressGrammarTests",
            "ReauthProducerMatrixTests",
            "StartEntryTests",
            "RequestIdentityTests",
            "OversizedProjectionTests",
            "HumanRefusalTests",
            "BootRouteTests",
            "PluginFleetRoutingTests",
            "LiveTranscriptConvergenceTests",
            "ReadOnlyProbeBoundaryTests",
        }
        silent = sorted(expected - set(red))
        if silent:
            print("controls that stayed GREEN without the fix (measure something else):")
            for name in silent:
                print(f"  {name}")
            return 2
        print("every control class goes red on the pre-T-1363 subject.")
        return 0
    finally:
        if args.keep:
            print(f"kept: {base}")
        else:
            shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
