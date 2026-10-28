"""Native Kiro PreToolUse and Gemini BeforeTool transport for saipen guard.

No protocol policy lives here. Exact host built-ins are translated to the
common event vocabulary; unknown names retain their identity. Exit 2 blocks
both hosts. Gemini also receives its native JSON deny response.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

MAX_BYTES = 256 * 1024
READS = {
    # T-1317 APPEND: `skill` is the bootstrap/read tool (it READS skill and
    # protocol material into context and writes nothing), so it stays available
    # even when the guard subprocess or mutation admission is unavailable.
    "kiro": {"read", "fs_read", "skill"},
    "gemini": {"read_file", "read_many_files", "list_directory", "glob", "grep_search", "skill"},
}
TOOLS = {
    "kiro": {
        "fs_write": "write",
        "str_replace": "write",
        "delete_file": "delete",
        "execute_bash": "bash",
        "shell": "bash",
        # T-1317 Target A: reviewed Kiro translation. `control_bash_process`
        # resumes/steers an already-spawned OS process with arbitrary stdin.
        # Its event names a process id, never an inspectable command line or
        # a filesystem target, so the effect is UNRESOLVED consequential:
        # the guard refuses it before host execution and no canonical-verb
        # or path-shape inference can clear it.
        "control_bash_process": "process_control",
    },
    "gemini": {"write_file": "write", "replace": "edit", "run_shell_command": "bash"},
}


def run(host: str, skill_root: Path) -> tuple[bool, str]:
    try:
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            return False, "GUARD_EVENT_OVERFLOW"
        native = json.loads(raw)
        if not isinstance(native, dict):
            return False, "GUARD_EVENT_INVALID"
        name = native.get("tool_name")
        args = native.get("tool_input")
        if not isinstance(name, str) or not name or not isinstance(args, dict):
            return False, "GUARD_EVENT_INVALID"
        if name in READS[host]:
            return True, "ADMITTED_READ_ONLY"
        event = {
            "event": "before_tool",
            "host": host,
            "cwd": native.get("cwd") or os.getcwd(),
            "tool_name": TOOLS[host].get(name, name),
            "tool_input": args,
        }
        actor = os.environ.get("SAIPEN_AGENT", "").strip()
        if actor:
            event["actor"] = actor
        proc = subprocess.run(
            [
                sys.executable,
                str(skill_root / "tools" / "saipen.py"),
                "guard",
                "--event-json",
                "-",
                "--json",
            ],
            input=json.dumps(event),
            capture_output=True,
            text=True,
            timeout=20,
        )
        verdict = json.loads(proc.stdout)
        if (
            not isinstance(verdict, dict)
            or type(verdict.get("admitted")) is not bool
            or not isinstance(verdict.get("code"), str)
        ):
            return False, "GUARD_OUTPUT_INVALID"
        return proc.returncode == 0 and verdict["admitted"], verdict["code"]
    except (OSError, ValueError, subprocess.SubprocessError):
        return False, "GUARD_UNAVAILABLE_OR_INVALID"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", choices=("kiro", "gemini"), required=True)
    parser.add_argument("--saipen-root", type=Path, required=True)
    args = parser.parse_args()
    allowed, code = run(args.host, args.saipen_root)
    if args.host == "gemini":
        print(json.dumps({"decision": "allow" if allowed else "deny", "reason": code}))
    if not allowed:
        print("SAIPEN_GUARD_REFUSAL: " + code, file=sys.stderr)
    return 0 if allowed else 2


if __name__ == "__main__":
    raise SystemExit(main())
