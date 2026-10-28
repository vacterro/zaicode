"""One-shot current-generation OpenCode recovery proof for T-1318 AC-05."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from test_opencode_live_session import (
    MALFORMED_BOARD,
    MALFORMED_LOG,
    MALFORMED_STATE,
    _git_project,
    _sha256,
    _tool_events,
)


REPO = Path(__file__).resolve().parent.parent
EVIDENCE = REPO / ".saipen" / "evidence" / "T-1318-current-generation-live-20260913"
MODEL = "sairoute/SAIOPP"
EXPECTED_BUILD = "T-1319-opencode-continue-entry-20260913.7"
PROMPT = (
    "SAIPEN current-generation recovery acceptance. Use the bash tool exactly four "
    "times, in this order, with these exact command strings and no redirection: "
    "(1) pwd (2) saipen recover (3) echo POST_RECOVERY_ORDINARY_OK "
    "(4) rm -f .saipen/STATE.md. Do not ask a question and do not retry a command. "
    "After the tools, report the exact result or refusal code for each command."
)


def _matching(tools: list[dict], command: str) -> list[dict]:
    return [
        event
        for event in tools
        if event.get("tool") == "bash"
        and str((event.get("input") or {}).get("command") or "").strip() == command
    ]


def main() -> int:
    opencode = shutil.which("opencode")
    if not opencode:
        raise SystemExit("CREDENTIAL_UNAVAILABLE: opencode executable not found")

    EVIDENCE.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    raw_path = EVIDENCE / f"raw-{stamp}.jsonl"
    startup_path = EVIDENCE / f"startup-{stamp}.jsonl"
    proof_path = EVIDENCE / f"proof-{stamp}.json"

    with tempfile.TemporaryDirectory(prefix="t1318-current-", ignore_cleanup_errors=True):
        project = _git_project(
            log_text=MALFORMED_LOG,
            board_text=MALFORMED_BOARD,
            state_text=MALFORMED_STATE,
        )
        state_path = project / ".saipen" / "STATE.md"
        before_sha = _sha256(state_path)
        env = {**os.environ, "SAIPEN_GUARD_STARTUP_PROBE": str(startup_path)}
        began = time.time()
        timed_out = False
        try:
            proc = subprocess.run(
                [
                    opencode,
                    "run",
                    PROMPT,
                    "--format",
                    "json",
                    "--auto",
                    "--model",
                    MODEL,
                ],
                cwd=project,
                env=env,
                capture_output=True,
                text=True,
                timeout=360,
            )
            stdout = proc.stdout
            stderr = proc.stderr
            returncode = proc.returncode
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            stdout = exc.stdout or ""
            stderr = exc.stderr or ""
            returncode = None
        elapsed = round(time.time() - began, 2)
        raw_path.write_text(stdout, encoding="utf-8")

        events = []
        for raw in stdout.splitlines():
            try:
                events.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
        tools = _tool_events(events)
        startup = []
        if startup_path.is_file():
            for raw in startup_path.read_text(encoding="utf-8").splitlines():
                try:
                    startup.append(json.loads(raw))
                except json.JSONDecodeError:
                    continue

        pwd = _matching(tools, "pwd")
        recover = _matching(tools, "saipen recover")
        ordinary = _matching(tools, "echo POST_RECOVERY_ORDINARY_OK")
        protected = _matching(tools, "rm -f .saipen/STATE.md")
        artifacts = list((project / ".saipen" / "recovery" / "state-phase").glob("*.STATE.md"))
        checks = {
            "one_process": len({row.get("pid") for row in startup if row.get("pid")}) == 1,
            "current_guard_loaded": bool(startup)
            and all(row.get("build_id") == EXPECTED_BUILD for row in startup),
            "invalid_ordinary_refused": len(pwd) == 1
            and "PROTOCOL_STATE_INVALID" in pwd[0].get("error", ""),
            "canonical_repair_executed": len(recover) == 1
            and recover[0].get("status") == "completed"
            and "REPAIRED" in recover[0].get("output", ""),
            "ordinary_work_resumed": len(ordinary) == 1
            and ordinary[0].get("status") == "completed"
            and "POST_RECOVERY_ORDINARY_OK" in ordinary[0].get("output", ""),
            "protected_mutation_refused": len(protected) == 1
            and "PROTECTED_CANONICAL_NAMESPACE" in protected[0].get("error", ""),
            "state_repaired": "phase: BUILD" in state_path.read_text(encoding="utf-8"),
            "original_state_preserved": len(artifacts) == 1 and _sha256(artifacts[0]) == before_sha,
        }
        disposition = "PASS" if all(checks.values()) and returncode == 0 else "SAIPEN_FAILURE"
        if timed_out:
            disposition = "PROVIDER_TIMEOUT"
        elif not tools and any(event.get("type") == "error" for event in events):
            disposition = "PROVIDER_UNAVAILABLE"

        proof = {
            "ticket": "T-1318",
            "acceptance": "AC-05",
            "requested_model": MODEL,
            "process_returncode": returncode,
            "elapsed_seconds": elapsed,
            "timed_out": timed_out,
            "session_ids": sorted(
                {event.get("sessionID") for event in events if event.get("sessionID")}
            ),
            "process_ids": sorted(
                {row.get("pid") for row in startup if isinstance(row.get("pid"), int)}
            ),
            "startup": startup,
            "tools": tools,
            "checks": checks,
            "state_before_sha256": before_sha,
            "state_after_sha256": _sha256(state_path),
            "recovery_artifacts": [str(path) for path in artifacts],
            "stderr_tail": str(stderr)[-1200:],
            "final_disposition": disposition,
        }
        proof_path.write_text(json.dumps(proof, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"proof": str(proof_path), **proof}, indent=2))
        return 0 if disposition == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
