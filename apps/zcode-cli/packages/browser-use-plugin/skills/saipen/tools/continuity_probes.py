"""SC-CONTINUITY-001 + hostile matrix H1..H20 (T-1148).

The canonical cold-handoff continuity scenario and the Work/Attempt
hostile-test matrix, in one hermetic runner. Both mock agents are plain
``--agent`` identities driving the REAL engine CLI against a fresh copy of
the ``tests/scenarios/cold-handoff-continuity`` fixture: no model, network
or provider participates, so the scenario is deterministic by construction.
What is under test is protocol continuity, not intelligence.

Run standalone (``python tools/continuity_probes.py``) or through the
canonical suite (``tools/run_scenarios.py`` executes it as its own step).
"""

from __future__ import annotations

import datetime
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HOME = Path(__file__).resolve().parent.parent
TOOLS = HOME / "tools"
SAIPEN_PY = TOOLS / "saipen.py"
VALIDATE_PY = TOOLS / "validate.py"
FIXTURE = HOME / "tests" / "scenarios" / "cold-handoff-continuity" / ".saipen"

if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def _utc_stamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%d.%m.%y %H:%M")


def _utc_iso_shifted(minutes: int) -> str:
    instant = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=minutes)
    return instant.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fresh_project(prefix: str = "saipen-continuity") -> Path:
    root = Path(tempfile.mkdtemp(prefix=prefix + "-"))
    shutil.copytree(FIXTURE, root / ".saipen")
    return root


def cli(project: Path, agent: str, *args: str) -> dict:
    r = subprocess.run(
        [
            sys.executable,
            str(SAIPEN_PY),
            "--project-root",
            str(project),
            "--agent",
            agent,
            "--json",
            *args,
        ],
        cwd=str(project),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=300,
    )
    blob = (r.stdout or "") + (r.stderr or "")
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        return {"ok": False, "code": "CLI_CRASH", "detail": blob[-800:]}


def cli_raw(project: Path, agent: str, *args: str) -> str:
    """Human-mode CLI output (brief prints a text surface without --json)."""
    r = subprocess.run(
        [
            sys.executable,
            str(SAIPEN_PY),
            "--project-root",
            str(project),
            "--agent",
            agent,
            *args,
        ],
        cwd=str(project),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=300,
    )
    return (r.stdout or "") + (r.stderr or "")


def validate(project: Path) -> tuple[int, str]:
    r = subprocess.run(
        [sys.executable, str(VALIDATE_PY), "--project-root", str(project)],
        cwd=str(HOME),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=600,
    )
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def append_log(project: Path, ticket: str, agent: str, text: str) -> None:
    log_path = project / ".saipen" / "LOG.md"
    content = log_path.read_text(encoding="utf-8")
    tail = max(int(m.group(1)) for m in re.finditer(r"\[E-(\d+)\]", content))
    line = (
        f"- {_utc_stamp()} [E-{tail + 1}] [parent: E-{tail}] "
        f"[{ticket}] [agent: {agent}] {text}"
    )
    log_path.write_text(
        content.rstrip("\n") + "\n" + line + "\n", encoding="utf-8", newline="\n"
    )


def backdate_claim(project: Path, minutes: int = 60) -> None:
    """Simulate claim staleness: any real liveness test must write
    claim_time at run time (the checked-in fixture cannot stay fresh)."""
    board_path = project / ".saipen" / "BOARD.md"
    raw = board_path.read_bytes().decode("utf-8")
    stale = _utc_iso_shifted(minutes)
    raw = re.sub(r"claim_time: [^|\n]+", f"claim_time: {stale}", raw)
    board_path.write_bytes(raw.encode("utf-8"))


def set_state_field(project: Path, field: str, value: str | None) -> None:
    state_path = project / ".saipen" / "STATE.md"
    raw = state_path.read_bytes().decode("utf-8")
    lines = raw.splitlines(keepends=True)
    out = []
    found = False
    for line in lines:
        if line.startswith(field + ":"):
            found = True
            if value is None:
                continue
            out.append(f"{field}: {value}\n")
        else:
            out.append(line)
    if not found and value is not None:
        # Insert before the closing fence so a missing optional field
        # (goal counters on a fixture without them) still lands.
        close = next(i for i, ln in enumerate(out) if ln.strip() == "---" and i > 0)
        out.insert(close, f"{field}: {value}\n")
    state_path.write_bytes("".join(out).encode("utf-8"))


def tree_fingerprint(project: Path) -> list[tuple[str, int, int]]:
    entries = []
    for path in sorted((project / ".saipen").rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            stat = path.stat()
            entries.append((path.name, stat.st_size, stat.st_mtime_ns))
    return entries


def drive_to_ship(project: Path, agent: str, *, evidence_pass_line: bool) -> dict:
    """Common completion drive; returns the `ticket done` result.

    Order matters: the PASS evidence line is appended AFTER the VERIFY
    boundary exists (a candidate claim admitted only by verification that
    postdates the boundary), mirroring the protocol's claim -> evidence ->
    verdict -> transition contract.
    """
    import os

    last: dict = {}

    def step(verb: str, *args: str) -> None:
        nonlocal last
        if verb == "transition":
            last = cli(project, agent, "transition", *args)
        else:
            last = cli(project, agent, "ticket", *args)
        if os.environ.get("SAIPEN_CDEBUG"):
            print(f"  [drive] {verb} {' '.join(args)} -> {json.dumps(last)[:220]}")

    step("transition", "BUILD", "T-001")
    step("transition", "VERIFY", "T-001")
    if evidence_pass_line:
        append_log(project, "T-001", agent, "RUN: python tools/validate.py -> PASS conf: high")
    step("transition", "REVIEW", "T-001")
    step("transition", "SHIP", "T-001")
    step("ticket", "done", "T-001")
    return last


def run_continuity_probes() -> tuple[list[str], int]:
    problems: list[str] = []
    checked = 0

    def expect(label: str, ok: bool, detail: str = "") -> None:
        nonlocal checked
        checked += 1
        if ok:
            print(f"PASS: continuity -- {label}")
        else:
            problems.append(f"{label}: {detail}")
            print(f"FAIL: continuity -- {label} -- {detail}")

    # ------------------------------------------------------------------
    # Unit layer: the shared grammar/matrix (no subprocess).
    # ------------------------------------------------------------------
    from saipen_engine import attempt as att

    expect(
        "grammar parses open with predecessor",
        att.parse_attempt_text("attempt A-002 open; supersedes A-001")
        == {"kind": "open", "id": "A-002", "supersedes": "A-001"},
    )
    try:
        att.parse_attempt_text("attempt A-1 open")
        expect("malformed attempt id refused", False, "ValueError not raised")
    except ValueError:
        expect("malformed attempt id refused", True)
    _recs, vocab_errs = att.build_attempts(
        [
            {"event": 5, "taxonomy": "DEC", "ticket": "T-001", "text": "attempt A-001 open"},
            {
                "event": 6,
                "taxonomy": "DEC",
                "ticket": "T-001",
                "text": "attempt A-001 close result bogus stop context_limit",
            },
        ]
    )
    expect(
        "unknown result vocabulary refused",
        any("result" in e and "not one of" in e for e in vocab_errs),
        str(vocab_errs),
    )
    _records, errs = att.build_attempts(
        [
            {"event": 5, "taxonomy": "DEC", "ticket": "T-001", "text": "attempt A-001 open"},
            {
                "event": 6,
                "taxonomy": "DEC",
                "ticket": "T-001",
                "text": "attempt A-001 close result interrupted stop validation_failure",
            },
        ]
    )
    expect(
        "result/stop matrix refuses failed+validation_failure mismatch pairing",
        any("allowed stops" in e for e in errs),
        str(errs),
    )
    events = [{"event": 3, "taxonomy": "DEC", "ticket": "T-009", "text": "attempt A-007 open"}]
    expect("attempt IDs allocate above the highest ever", att.next_attempt_id(events) == "A-008")

    # ------------------------------------------------------------------
    # SC-CONTINUITY-001 -- the canonical cold-handoff scenario.
    # ------------------------------------------------------------------
    root = fresh_project()

    # Agent A claims the Work, opens an attempt, produces a partial result,
    # then stops because its context window ended. The process disappears.
    r = cli(root, "claude-mock", "claim", "T-001")
    expect("SC A1: agent A claims T-001", r.get("code") == "CLAIMED", json.dumps(r)[:200])
    r = cli(root, "claude-mock", "attempt", "open")
    expect(
        "SC A2: agent A opens attempt A-001",
        r.get("code") == "ATTEMPT_OPENED" and r.get("attempt") == "A-001",
        json.dumps(r)[:200],
    )
    (root / "widget.partial").write_text("half a widget\n", encoding="utf-8")
    r = cli(root, "claude-mock", "attempt", "close", "interrupted", "context_limit")
    expect(
        "SC A3: agent A's attempt closes interrupted/context_limit",
        r.get("code") == "ATTEMPT_CLOSED" and r.get("stop") == "context_limit",
        json.dumps(r)[:200],
    )

    # Agent B: ZERO chat history, repository only.
    brief = cli(root, "codex-mock", "brief", "--json")
    work_ok = (
        brief.get("work_id") == "T-001"
        and isinstance(brief.get("objective"), str)
        and "widget" in brief["objective"]
    )
    expect("SC B1: cold brief recovers Work identity + objective", work_ok, json.dumps(brief)[:240])
    prev_ok = (
        (brief.get("previous_attempt") or {}).get("id") == "A-001"
        and (brief.get("previous_attempt") or {}).get("result") == "interrupted"
        and brief.get("previous_stop") == "context_limit"
    )
    expect(
        "SC B2: cold brief recovers previous attempt + stop reason",
        prev_ok,
        json.dumps(brief.get("previous_attempt"))[:160],
    )
    expect(
        "SC B3: cold brief recovers exact next action",
        brief.get("next_action") == "PHASE SCOUT T-001",
        json.dumps(brief.get("next_action")),
    )

    backdate_claim(root)
    r = cli(root, "codex-mock", "claim", "T-001")
    expect("SC B4: agent B adopts the same Work", r.get("code") == "CLAIMED", json.dumps(r)[:200])
    r = cli(root, "codex-mock", "attempt", "open")
    expect(
        "SC B5: agent B opens A-002 superseding A-001 on the SAME Work",
        r.get("code") == "ATTEMPT_OPENED"
        and r.get("attempt") == "A-002"
        and r.get("supersedes") == "A-001"
        and r.get("ticket") == "T-001",
        json.dumps(r)[:220],
    )
    r = cli(root, "codex-mock", "attempt", "close", "candidate", "completed_execution")
    expect(
        "SC B6: agent B closes its episode candidate/completed_execution",
        r.get("code") == "ATTEMPT_CLOSED",
        json.dumps(r)[:200],
    )
    finish = drive_to_ship(root, "codex-mock", evidence_pass_line=True)
    expect(
        "SC B7: independent gates admit the candidate to DONE",
        finish.get("code") == "FINISHED",
        json.dumps(finish)[:220],
    )

    rc, output = validate(root)
    expect("SC C1: independent validator re-checks the finished Work", rc == 0, output[-400:])

    # Negative control of the SAME flow minus the evidence line proves the
    # producer could NOT have self-approved (SELF_APPROVAL_BLOCKED).
    neg = fresh_project()
    cli(neg, "claude-mock", "claim", "T-001")
    cli(neg, "claude-mock", "attempt", "open")
    backdate_claim(neg)
    # Successor closes the dangling episode first (claim refuses while an
    # attempt is open), then adopts the SAME Work.
    cli(neg, "codex-mock", "attempt", "close", "interrupted", "unknown")
    cli(neg, "codex-mock", "claim", "T-001")
    cli(neg, "codex-mock", "attempt", "open")
    cli(neg, "codex-mock", "attempt", "close", "candidate", "completed_execution")
    neg_finish = drive_to_ship(neg, "codex-mock", evidence_pass_line=False)
    expect(
        "SC C2: producer cannot close the Work without independent evidence",
        neg_finish.get("ok") is False
        and neg_finish.get("code") in ("INCOMPLETE_TICKET", "ILLEGAL_PHASE"),
        json.dumps(neg_finish)[:220],
    )
    neg_rc, neg_out = validate(neg)
    expect(
        "SC C3: unproven closure never reaches the board green",
        neg_rc != 0
        or "[x] T-001" not in (neg / ".saipen" / "BOARD.md").read_text(encoding="utf-8"),
        neg_out[-200:],
    )

    scenario_verdicts = {
        "COLD_HANDOFF": True,
        "WORK_IDENTITY": work_ok,
        "ATTEMPT_LINEAGE": True,
        "OBJECTIVE_PRESERVED": work_ok,
        "PREVIOUS_EVIDENCE_VISIBLE": prev_ok,
        "NEXT_ACTION_RECOVERED": brief.get("next_action") == "PHASE SCOUT T-001",
        "SELF_APPROVAL_BLOCKED": neg_finish.get("ok") is False,
        "FINAL_VERIFICATION": rc == 0,
    }
    for name, ok in scenario_verdicts.items():
        print(f"{name}: {'PASS' if ok else 'FAIL'}")
    all_green = all(scenario_verdicts.values())
    print(f"CONTINUITY: {'VERIFIED' if all_green else 'BROKEN'}")
    expect("SC verdict block is fully green", all_green, json.dumps(scenario_verdicts))

    # ------------------------------------------------------------------
    # Hostile matrix H1..H20.
    # ------------------------------------------------------------------

    # H1: Work survives a FAILED attempt.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    cli(p, "a1", "attempt", "close", "failed", "validation_failure")
    board_text = (p / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
    expect(
        "H1: failed attempt leaves Work identity intact",
        "T-001 implement the widget per ADR-7" in board_text.replace("\n", " "),
        board_text[:120],
    )
    rc, out = validate(p)
    expect("H1b: validator green after failed attempt", rc == 0, out[-300:])

    # H4: attempt references nonexistent Work.
    p = fresh_project()
    append_log(p, "T-999", "ghost", "DEC: attempt A-001 open")
    rc, out = validate(p)
    expect(
        "H4: attempt on nonexistent Work FAILs",
        rc != 0 and "attempt-contract" in out and "T-999" in out,
        out[-300:],
    )

    # H5: duplicate attempt id.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    append_log(p, "T-001", "a1", "DEC: attempt A-001 open")
    rc, out = validate(p)
    expect(
        "H5: duplicate attempt id FAILs",
        rc != 0 and "duplicate attempt id" in out,
        out[-300:],
    )

    # H6: predecessor lineage cycle.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")  # A-001
    append_log(p, "T-001", "a1", "DEC: attempt A-002 open; supersedes A-002")
    rc, out = validate(p)
    expect(
        "H6: self-referential lineage cycle FAILs",
        rc != 0 and ("cycle" in out or "supersedes" in out),
        out[-300:],
    )

    # H7b: the Work is driven to a LEGAL DONE first (episode closed before
    # the boundary), then a producer fabricates a LATER candidate pair to
    # retroactively stamp its own authority onto finished Work.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    cli(p, "a1", "attempt", "close", "candidate", "completed_execution")
    fin = drive_to_ship(p, "a1", evidence_pass_line=True)
    expect(
        "H7b0: legal episode-then-verify order reaches DONE",
        fin.get("code") == "FINISHED",
        json.dumps(fin)[:220],
    )
    append_log(p, "T-001", "a1", "DEC: attempt A-002 open; supersedes A-001")
    append_log(
        p, "T-001", "a1", "DEC: attempt A-002 close result candidate stop completed_execution"
    )
    rc, out = validate(p)
    expect(
        "H7b: post-admission candidate fabrication FAILs closed",
        rc != 0 and "attempt-admission" in out,
        out[-300:],
    )

    # H7a: the ENGINE gate — finish refuses while the producing attempt is
    # still open; the producer's live episode must not close the Work.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    fin = drive_to_ship(p, "a1", evidence_pass_line=True)
    expect(
        "H7a: finish refuses while the producing attempt is still open",
        fin.get("ok") is False and fin.get("code") == "INCOMPLETE_TICKET",
        json.dumps(fin)[:220],
    )

    # H8: claim alone cannot close the Work (no VERIFY cycle at all).
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    cli(p, "a1", "attempt", "close", "candidate", "completed_execution")
    cli(p, "a1", "transition", "BUILD", "T-001")
    cli(p, "a1", "transition", "VERIFY", "T-001")
    r = cli(p, "a1", "transition", "REVIEW", "T-001")
    expect(
        "H8: candidate claim without evidence cannot pass VERIFY->REVIEW",
        r.get("ok") is False and r.get("code") == "INCOMPLETE_TICKET",
        json.dumps(r)[:200],
    )

    # H9: rejected verdict cannot authorize the transition.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    cli(p, "a1", "attempt", "close", "candidate", "completed_execution")
    cli(p, "a1", "transition", "BUILD", "T-001")
    cli(p, "a1", "transition", "VERIFY", "T-001")
    append_log(p, "T-001", "a1", "RUN: python tools/validate.py -> FAIL")
    r = cli(p, "a1", "transition", "REVIEW", "T-001")
    expect(
        "H9: FAIL evidence blocks VERIFY->REVIEW",
        r.get("ok") is False and r.get("code") == "INCOMPLETE_TICKET",
        json.dumps(r)[:200],
    )

    # H10: stale evidence reused across an incompatible attempt. A NEW
    # episode opens after the verification cycle ran and cites that OLD
    # evidence for its own candidate close on the finished Work.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    cli(p, "a1", "attempt", "close", "failed", "validation_failure")
    fin = drive_to_ship(p, "a1", evidence_pass_line=True)
    expect(
        "H10a: failed attempt does not block a later legal admission",
        fin.get("code") == "FINISHED",
        json.dumps(fin)[:220],
    )
    tail_event = max(
        int(m.group(1))
        for m in re.finditer(r"\[E-(\d+)\]", (p / ".saipen" / "LOG.md").read_text(encoding="utf-8"))
    )
    append_log(p, "T-001", "a1", "DEC: attempt A-002 open; supersedes A-001")
    append_log(
        p,
        "T-001",
        "a1",
        "DEC: attempt A-002 close result candidate stop completed_execution -- "
        f"evidence E-{tail_event}",
    )
    rc, out = validate(p)
    expect(
        "H10: pre-close evidence cannot admit a later candidate",
        rc != 0 and "attempt-admission" in out,
        out[-300:],
    )

    # H11: unknown is not a verified fact.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    cli(
        p,
        "a1",
        "attempt",
        "close",
        "candidate",
        "completed_execution",
        "--unknown",
        "windows restart behaviour unverified",
    )
    cli(p, "a1", "transition", "BUILD", "T-001")
    cli(p, "a1", "transition", "VERIFY", "T-001")
    r = cli(p, "a1", "transition", "REVIEW", "T-001")
    expect(
        "H11: recorded uncertainty never substitutes for evidence",
        r.get("ok") is False and r.get("code") == "INCOMPLETE_TICKET",
        json.dumps(r)[:200],
    )

    # H12: unsupported future protocol fails closed.
    from saipen_engine.state import running_protocol_major

    p = fresh_project()
    set_state_field(p, "saipen_version", str(running_protocol_major() + 1))
    r = cli(p, "a1", "claim", "T-001")
    expect(
        "H12: newer protocol state refuses mutation",
        r.get("ok") is False and "newer than the running" in str(r.get("message", "")),
        json.dumps(r)[:240],
    )

    # H13/H14: legacy state stays readable and gains no invented history.
    legacy = Path(tempfile.mkdtemp(prefix="saipen-legacy-"))
    legacy_fixture = HOME / "tests" / "scenarios" / "resume-after-crash" / ".saipen"
    shutil.copytree(legacy_fixture, legacy / ".saipen")
    before = (legacy / ".saipen" / "LOG.md").read_bytes()
    b = cli(legacy, "observer", "brief", "--json")
    expect(
        "H13: legacy project projects cleanly with no attempts",
        b.get("ok") is not False and b.get("attempt") is None,
        json.dumps(b)[:200],
    )
    after = (legacy / ".saipen" / "LOG.md").read_bytes()
    log_now = after.decode("utf-8", errors="replace")
    expect(
        "H14: projection invents no historical attempts",
        before == after and "attempt A-" not in log_now,
        "",
    )

    # H15/H16: human and JSON brief agree.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    surface = cli_raw(p, "a2", "brief")
    js = cli(p, "a2", "brief", "--json")
    consistent = (
        f"WORK: {js.get('work_id')}" in surface
        and str(js.get("next_action")) in surface
        and (js.get("attempt") or {}).get("id", "") in surface
        and f"PHASE: {js.get('phase')}" in surface
    )
    expect(
        "H15/H16: human and JSON projections carry identical semantics",
        consistent,
        surface[:200],
    )

    # H17: the projection writes NOTHING.
    fp = fresh_project()
    before_fp = tree_fingerprint(fp)
    cli_raw(fp, "observer", "brief")
    cli(fp, "observer", "brief", "--json")
    expect(
        "H17: brief is a pure read-only projection",
        tree_fingerprint(fp) == before_fp,
        "canonical tree changed during projection",
    )

    # H18: interrupted state survives a restart (crash WITHOUT close).
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    backdate_claim(p)
    b2 = cli(p, "a2", "brief", "--json")
    expect(
        "H18a: crashed session's OPEN attempt visible to the successor",
        (b2.get("attempt") or {}).get("id") == "A-001"
        and (b2.get("attempt") or {}).get("result") == "active",
        json.dumps(b2.get("attempt"))[:160],
    )
    r = cli(p, "a2", "claim", "T-001")
    expect(
        "H18b: takeover refuses while the dangling attempt is open",
        r.get("ok") is False and "still open" in str(r.get("message", "")),
        json.dumps(r)[:220],
    )
    r = cli(p, "a2", "attempt", "close", "interrupted", "unknown")
    expect(
        "H18c: successor closes the crashed attempt honestly as unknown-stop",
        r.get("code") == "ATTEMPT_CLOSED" and r.get("stop") == "unknown",
        json.dumps(r)[:200],
    )
    r = cli(p, "a2", "claim", "T-001")
    expect(
        "H18d: Work adoptable after honest closure",
        r.get("code") == "CLAIMED",
        json.dumps(r)[:200],
    )

    # H19: torn/corrupt attempt state is detected deterministically.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    set_state_field(p, "attempt", "A-042")
    rc, out = validate(p)
    expect(
        "H19a: pointer to a nonexistent attempt FAILs closed",
        rc != 0 and ("does not exist" in out or "torn" in out),
        out[-260:],
    )
    p2 = fresh_project()
    cli(p2, "a1", "claim", "T-001")
    append_log(p2, "T-001", "a1", "DEC: attempt A-001 close result candidate stop context_limit")
    rc, out = validate(p2)
    expect(
        "H19b: close-without-open FAILs deterministically",
        rc != 0 and "without any open event" in out,
        out[-260:],
    )

    # H20: replayed lifecycle commands are idempotent.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    first = cli(p, "a1", "attempt", "open")
    tail_before = max(
        int(m.group(1))
        for m in re.finditer(r"\[E-(\d+)\]", (p / ".saipen" / "LOG.md").read_text(encoding="utf-8"))
    )
    replay = cli(p, "a1", "attempt", "open")
    tail_after = max(
        int(m.group(1))
        for m in re.finditer(r"\[E-(\d+)\]", (p / ".saipen" / "LOG.md").read_text(encoding="utf-8"))
    )
    expect(
        "H20a: replayed open returns the live attempt without a new event",
        replay.get("idempotent") is True
        and replay.get("attempt") == first.get("attempt")
        and tail_before == tail_after,
        json.dumps(replay)[:220],
    )
    cli(p, "a1", "attempt", "close", "interrupted", "context_limit")
    tail_after_close = max(
        int(m.group(1))
        for m in re.finditer(r"\[E-(\d+)\]", (p / ".saipen" / "LOG.md").read_text(encoding="utf-8"))
    )
    replay_close = cli(p, "a1", "attempt", "close", "interrupted", "context_limit")
    conflict_close = cli(p, "a1", "attempt", "close", "failed", "capability_missing")
    tail_final = max(
        int(m.group(1))
        for m in re.finditer(r"\[E-(\d+)\]", (p / ".saipen" / "LOG.md").read_text(encoding="utf-8"))
    )
    expect(
        "H20b: replayed close is a no-op; conflicting close refuses; one event total",
        replay_close.get("idempotent") is True
        and conflict_close.get("ok") is False
        and tail_after_close == tail_final,
        json.dumps({"replay": replay_close, "conflict": conflict_close})[:300],
    )

    # ------------------------------------------------------------------
    # Second hostile wave (self-audit hunt): parser prose safety, vocab
    # casing, dangling evidence, bounded unknown, cross-seat replay,
    # close-ticket coherence, torn-pointer projection, goal counters,
    # sealed-segment lineage.
    # ------------------------------------------------------------------

    # H21: ordinary DEC prose beginning with the word "attempt" is NOT an
    # attempt event -- the validator must stay green, and mutations through
    # the engine must not be blocked by the attempt fast gate.
    p = fresh_project()
    append_log(p, "T-001", "a1", "DEC: attempt to fix flaky harness -> gave up")
    rc, out = validate(p)
    expect(
        "H21: English DEC prose starting with 'attempt' is not corruption",
        rc == 0,
        out[-300:],
    )
    cli(p, "a1", "claim", "T-001")
    r = cli(p, "a1", "attempt", "open")
    expect(
        "H21b: engine mutation unblocked after prose line",
        r.get("code") == "ATTEMPT_OPENED",
        json.dumps(r)[:200],
    )
    # ...but a REAL A-### id with a broken tail is still corruption.
    p2 = fresh_project()
    append_log(p2, "T-001", "a1", "DEC: attempt A-001 opens the gate")
    rc, out = validate(p2)
    expect(
        "H21c: A-### id with malformed tail FAILs closed",
        rc != 0 and "malformed attempt event" in out,
        out[-260:],
    )

    # H22: uppercase vocabulary is outside the closed sets.
    from saipen_engine import attempt as att_mod

    _recs, _verr = att_mod.build_attempts(
        [
            {"event": 5, "taxonomy": "DEC", "ticket": "T-001", "text": "attempt A-001 open"},
            {
                "event": 6,
                "taxonomy": "DEC",
                "ticket": "T-001",
                "text": "attempt A-001 close result CANDIDATE stop COMPLETED_EXECUTION",
            },
        ]
    )
    expect(
        "H22: uppercase result/stop refused by the closed vocabularies",
        any(("not one of" in e or "malformed attempt event" in e) for e in _verr),
        str(_verr[:2]),
    )

    # H24: evidence citing a nonexistent (future) event FAILs.
    p = fresh_project()
    append_log(p, "T-001", "a1", "DEC: attempt A-001 open")
    append_log(
        p,
        "T-001",
        "a1",
        "DEC: attempt A-001 close result candidate stop completed_execution "
        "-- evidence E-99999",
    )
    rc, out = validate(p)
    expect(
        "H24: dangling future evidence reference FAILs",
        rc != 0 and "does not exist in the LOG" in out,
        out[-260:],
    )

    # H25: overlong unknown clause refuses at the engine with zero writes.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    tail_before = max(
        int(m.group(1))
        for m in re.finditer(r"\[E-(\d+)\]", (p / ".saipen" / "LOG.md").read_text(encoding="utf-8"))
    )
    r = cli(
        p,
        "a1",
        "attempt",
        "close",
        "candidate",
        "completed_execution",
        "--unknown",
        "x" * 201,
    )
    tail_after = max(
        int(m.group(1))
        for m in re.finditer(r"\[E-(\d+)\]", (p / ".saipen" / "LOG.md").read_text(encoding="utf-8"))
    )
    expect(
        "H25: >200-char unknown clause refuses with zero writes",
        r.get("ok") is False
        and "at most" in str(r.get("message", ""))
        and tail_before == tail_after,
        json.dumps(r)[:220],
    )

    # H26: a DIFFERENT seat cannot replay someone else's live episode open.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    backdate_claim(p)
    r = cli(p, "a2", "attempt", "close", "interrupted", "unknown")
    expect(
        "H26a: foreign-stale seat may close the dangling episode",
        r.get("code") == "ATTEMPT_CLOSED",
        json.dumps(r)[:160],
    )
    cli(p, "a2", "claim", "T-001")
    cli(p, "a2", "attempt", "open")
    r = cli(p, "a1", "attempt", "open")
    expect(
        "H26b: second open while an episode is live refuses deterministically",
        r.get("ok") is False
        and (
            "still open" in str(r.get("message", ""))
            or "live foreign claim" in str(r.get("message", ""))
        ),
        json.dumps(r)[:220],
    )

    # H27: a hand-forged close naming a DIFFERENT ticket than its open FAILs.
    p = fresh_project()
    append_log(p, "T-001", "a1", "DEC: attempt A-001 open")
    append_log(
        p, "T-none", "a1", "DEC: attempt A-001 close result failed stop validation_failure"
    )
    rc, out = validate(p)
    expect(
        "H27: close ticket != open ticket FAILs coherence",
        rc != 0 and "belongs to exactly one Work" in out,
        out[-280:],
    )

    # H28: brief refuses to project from a torn attempt pointer.
    p = fresh_project()
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    set_state_field(p, "attempt", "A-042")
    b = cli(p, "a2", "brief", "--json")
    expect(
        "H28: torn pointer makes brief refuse instead of projecting",
        b.get("ok") is False and "torn attempt state" in str(b.get("message", "")),
        json.dumps(b)[:240],
    )

    # H29: attempt lifecycle leaves goal counters untouched.
    p = fresh_project()
    set_state_field(p, "execution_intent", "goal")
    set_state_field(p, "goal_waves", "2")
    set_state_field(p, "goal_tickets", "7")
    cli(p, "a1", "claim", "T-001")
    cli(p, "a1", "attempt", "open")
    cli(p, "a1", "attempt", "close", "interrupted", "context_limit")
    st_text = (p / ".saipen" / "STATE.md").read_text(encoding="utf-8")
    counters_ok = "goal_waves: 2" in st_text.replace('"', "") and (
        "goal_tickets: 7" in st_text
    )
    expect("H29: lifecycle ops do not disturb goal counters", counters_ok, st_text[:200])

    # H30: lineage across the seal boundary -- open sealed, close active.
    p = fresh_project()
    logs_dir = p / ".saipen" / "logs"
    logs_dir.mkdir()
    sealed = (
        "# Log\n\n"
        "- 01.01.26 00:00 [E-001] [T-001] [agent: bootstrap] DEC: bootstrapped\n"
        "- 01.01.26 00:01 [E-002] [parent: E-001] [T-001] [agent: old] "
        "DEC: attempt A-001 open\n"
    )
    (logs_dir / "LOG-001.md").write_text(sealed, encoding="utf-8", newline="\n")
    active_head = (
        "# Log\n\n"
        "- 01.01.26 00:02 [E-003] [parent: E-002] [T-001] [agent: new] "
        "DEC: attempt A-001 close result interrupted stop process_crash\n"
    )
    (p / ".saipen" / "LOG.md").write_text(active_head, encoding="utf-8", newline="\n")
    rc, out = validate(p)
    expect(
        "H30: sealed-open + active-close reads as one coherent lineage",
        rc == 0,
        out[-300:],
    )

    print(f"\ncontinuity probes: {checked} checked")
    return problems, checked


def main() -> int:
    problems, _checked = run_continuity_probes()
    if problems:
        print(f"FAILED: {len(problems)} continuity check(s)")
        for problem in problems:
            print(f"FAILED: {problem}")
        return 1
    print("All continuity checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
