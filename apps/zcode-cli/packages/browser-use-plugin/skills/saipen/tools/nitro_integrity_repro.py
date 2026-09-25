#!/usr/bin/env python
"""NITRO Integrity Sweep -- R1..R12 external-audit reproduction harness.

Each reproduction builds an ISOLATED fixture project under a temp directory and
demonstrates the claimed defect against the CURRENT engine. A reproduction
"succeeds" (prints REPRODUCED) when the defect is present, so this script is
the regression corpus for the NITRO integrity wave: every scenario here must
FLIP (the defect must be gone) once the engine is repaired.

Run:  python tools/nitro_integrity_repro.py
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from saipen_engine import codec
from saipen_engine.board import parse_board
from saipen_engine.journal import Journal, hash_bytes
from saipen_engine.lock import WriterLock
from saipen_engine.operations import (
    apply_claim,
    checkpoint,
    set_goal_intent,
    stop_checkpoint,
    ticket_add,
    ticket_move,
    transition_phase,
)
from saipen_engine.state import parse_state

LOG_BASE = "- 09.08.26 00:00 [E-900] [T-none] DEC: base\n"
BOARD_BASE = (
    "# Board\n## DOING\n## TODO\n- [ ] T-1 [P1] probe | verify: probe\n## DONE\n## BLOCKED\n"
)
STATE_BUILD = (
    '---\nphase: BUILD\ntask: T-1\nnext_action: "PHASE BUILD T-1"\n'
    'blocker: ""\ntransition_from: SCOUT\nsaipen_version: 7\n'
    "schema_version: 3\nlast_event: 900\nstyle_contract: ded-4ae736e4\n"
    'saipen_home: "."\nagent: probe\nrequires:\n  - filesystem\n'
    "  - git\n  - python\nmode: full\nupdated: 2026-08-09T00:00:00Z\n"
    "---\n"
)


def fixture() -> Path:
    root = Path(tempfile.mkdtemp(prefix="nitro-integrity-"))
    saipen = root / ".saipen"
    saipen.mkdir()
    (saipen / "LOG.md").write_text(LOG_BASE, encoding="utf-8")
    (saipen / "BOARD.md").write_text(BOARD_BASE, encoding="utf-8")
    (saipen / "STATE.md").write_text(STATE_BUILD, encoding="utf-8")
    return root


def state_phase(root: Path) -> str:
    return parse_state(codec.read_doc(root / ".saipen" / "STATE.md")).get("phase", "?")


def state_field(root: Path, key: str):
    return parse_state(codec.read_doc(root / ".saipen" / "STATE.md")).get(key)


def r1_checkpoint_changes_phase() -> tuple[bool, str]:
    root = fixture()
    result = checkpoint(root, "probe", "RUN", "T-1", "repro R1")
    observed = state_phase(root)
    ok = result.get("ok") and result.get("code") == "CHECKPOINTED" and observed == "SCOUT"
    return ok, (
        f"start BUILD, checkpoint, result={result.get('code')}, "
        f"phase={observed} (required: BUILD unchanged)"
    )


def r2_ticket_add_changes_phase() -> tuple[bool, str]:
    root = fixture()
    result = ticket_add(root, "probe", "P2", "future ticket", [], "verify")
    observed = state_phase(root)
    ok = result.get("ok") and result.get("code") == "TICKET_ADDED" and observed == "SCOUT"
    return ok, (
        f"start BUILD, ticket_add, result={result.get('code')}, "
        f"phase={observed} (required: BUILD unchanged)"
    )


def r3_goal_intent_creates_scout_none() -> tuple[bool, str]:
    root = fixture()
    (root / ".saipen" / "STATE.md").write_text(
        '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
        'blocker: ""\nsaipen_version: 7\nschema_version: 3\n'
        "last_event: 900\nstyle_contract: ded-4ae736e4\n"
        'saipen_home: "."\nagent: probe\nmode: full\n'
        "updated: 2026-08-09T00:00:00Z\n---\n",
        encoding="utf-8",
    )
    result = set_goal_intent(root, "probe", "repro R3")
    phase, task, na = (
        state_field(root, "phase"),
        state_field(root, "task"),
        state_field(root, "next_action"),
    )
    ok = (
        result.get("ok")
        and result.get("code") == "GOAL_SET"
        and phase == "SCOUT"
        and task == "none"
        and na == "PHASE SCOUT none"
    )
    return ok, (
        f"goal intent from DONE/none, result={result.get('code')}, "
        f"phase={phase}, task={task}, next_action={na!r} "
        f"(required: no SCOUT/none fabrication)"
    )


def r4_transition_accepts_fake_ticket() -> tuple[bool, str]:
    root = fixture()
    (root / ".saipen" / "BOARD.md").write_text(
        "# Board\n## DOING\n- [/] T-1 [P1] probe | owner: probe | "
        "claim_time: 2026-08-09T00:00:00Z\n## TODO\n## DONE\n## BLOCKED\n",
        encoding="utf-8",
    )
    (root / ".saipen" / "STATE.md").write_text(
        STATE_BUILD.replace("phase: BUILD\n", "phase: SCOUT\n").replace(
            'next_action: "PHASE BUILD T-1"', 'next_action: "PHASE SCOUT T-1"'
        ),
        encoding="utf-8",
    )
    result = transition_phase(root, "BUILD", "probe", "T-999", "repro R4")
    task = state_field(root, "task")
    ok = result.get("ok") and result.get("code") == "TRANSITIONED" and task == "T-999"
    return ok, (
        f"SCOUT/T-1 -> BUILD with T-999, result={result.get('code')}, "
        f"STATE.task={task} (required: REFUSE "
        f"ACTIVE_TICKET_MISMATCH / TICKET_NOT_FOUND)"
    )


def r5_todo_to_done_direct() -> tuple[bool, str]:
    root = fixture()
    result = ticket_move(root, "done", "T-1", "probe")
    section = parse_board(codec.read_doc(root / ".saipen" / "BOARD.md"))["tickets"]["T-1"][
        "section"
    ]
    ok = result.get("ok") and result.get("code") == "DONE" and section == "## DONE"
    return ok, (
        f"TODO ticket done directly, result={result.get('code')}, "
        f"T-1 now under {section} (required: REFUSE; source must be "
        f"DOING)"
    )


def r6_dry_run_writes_digest() -> tuple[bool, str]:
    root = fixture()
    digest = root / ".saipen" / "kitchen" / "digest.md"
    result = stop_checkpoint(root, "probe", "repro R6", dry_run=True)
    wrote = digest.is_file()
    ok = result.get("dry_run") and wrote
    return ok, (
        f"stop_checkpoint dry_run, result.dry_run={result.get('dry_run')}, "
        f"digest written={wrote} (required: zero bytes)"
    )


def r7_writer_busy_leaks_exception() -> tuple[bool, str]:
    root = fixture()
    held = WriterLock(root)
    held.acquire()
    try:
        try:
            apply_claim(root, "T-1", "probe")
            ok, detail = False, "no exception raised under held lock"
        except PermissionError as exc:
            ok, detail = True, f"PermissionError leaked: {exc}"
        except Exception as exc:
            ok, detail = True, f"exception leaked: {type(exc).__name__}: {exc}"
    finally:
        held.release()
    return ok, detail + " (required: structured result ok:false code:WRITER_BUSY)"


def r8_recovery_clobbers_intervening_work() -> tuple[bool, str]:
    root = fixture()
    saipen = root / ".saipen"
    log_before = (saipen / "LOG.md").read_bytes()
    board_before = (saipen / "BOARD.md").read_bytes()
    state_before = (saipen / "STATE.md").read_bytes()
    new_log = log_before + b"\n- 09.08.26 00:01 [E-901] RUN: op\n"
    new_board = board_before
    new_state = state_before.replace(b"phase: BUILD", b"phase: VERIFY")

    journal = Journal(root, "op-r8")
    journal.start(
        "repro",
        "probe",
        "id",
        "hash",
        [
            {
                "path": ".saipen/LOG.md",
                "role": "log",
                "content": new_log,
                "before_hash": hash_bytes(log_before),
                "after_hash": hash_bytes(new_log),
            },
            {
                "path": ".saipen/BOARD.md",
                "role": "board",
                "content": new_board,
                "before_hash": hash_bytes(board_before),
                "after_hash": hash_bytes(new_board),
            },
            {
                "path": ".saipen/STATE.md",
                "role": "state",
                "content": new_state,
                "before_hash": hash_bytes(state_before),
                "after_hash": hash_bytes(new_state),
            },
        ],
    )
    (saipen / "LOG.md").write_bytes(new_log)
    journal.mark("APPLYING", progress_index=1, target_index=0)
    external = board_before + b"\n# externally modified\n"
    (saipen / "BOARD.md").write_bytes(external)

    from saipen_engine.journal import recover

    result = recover(root, "op-r8")
    after_recovery = (saipen / "BOARD.md").read_bytes()
    ok = result.get("code") == "COMMITTED" and after_recovery != external
    return ok, (
        f"recovery code={result.get('code')}, external BOARD bytes "
        f"{'DESTROYED (clobbered)' if after_recovery != external else 'preserved'} "
        f"(required: CONFLICT, external bytes preserved)"
    )


def r9_cycle_path_traversal() -> tuple[bool, str]:
    root = fixture()
    try:
        import improve

        cdir = improve.cycle_dir(root, "../../escaped")
        escaped = cdir
        ok = not str(escaped.resolve()).startswith(str((root / ".saipen" / "improve").resolve()))
        detail = (
            f"cycle_dir resolves to {escaped.resolve()} -- "
            f"{'ESCAPES owner root' if ok else 'inside owner root'}"
        )
    except Exception as exc:
        ok = False
        detail = f"raised {type(exc).__name__}: {exc} (no clean validation)"
    return ok, detail + " (required: .. refused before path construction)"


def r10_multiple_active_cycles() -> tuple[bool, str]:
    root = fixture()
    import improve

    roster = "# IMPROVE CYCLE ROSTER\n"
    improve.register_cycle(root, "imp-a", roster)
    try:
        improve.register_cycle(root, "imp-b", roster)
        ok, detail = True, "second cycle imp-b admitted after active imp-a"
    except (FileExistsError, ValueError):
        ok = False
        detail = "second cycle refused (one active cycle enforced)"
    return ok, detail + " (required: one active Improve cycle per project)"


def r11_multi_run_collision() -> tuple[bool, str]:
    """DOGFOOD V (T-615): one legacy disposition must not cover two findings
    that only share a local IMP number across RUNs. RUN-1/IMP-001 and
    RUN-2/IMP-001 are DIFFERENT findings; a bare `IMP-001` sweep record may
    not sweep both. Defect present when derive_status reports swept."""
    _root = fixture()
    import improve

    roster = (
        "# IMPROVE CYCLE ROSTER\ncycle_status: active\n"
        "seat_id: seat-1\nrole: audit\n"
        "report_path: saipen_improve_SEAT.md\navailability: expected\n"
    )
    report = (
        "report_status: complete\n\n"
        "## RUN 1\n\n"
        "IMP-001 [P1] [PROTOCOL_VIOLATION] [reproduced] [fix]\n"
        "expected: a\nactual: b\nevidence: c\n\n"
        "## RUN 2\n\n"
        "IMP-001 [P1] [PROTOCOL_VIOLATION] [reproduced] [fix]\n"
        "expected: d\nactual: e\nevidence: f\n"
    )
    sweep = "# SWEEP\n- IMP-001 [CONFIRMED] T-1 report=saipen_improve_SEAT.md reproduced=y\n"
    status = improve.derive_status("saipen_improve_SEAT.md", roster, report, sweep)
    ok = status["visible"] == "swept" and status["swept"]
    return ok, (
        f"two RUNs both carry IMP-001, one bare disposition, "
        f"visible={status['visible']}, missing={status.get('missing')} "
        f"(required: RUN-2/IMP-001 stays missing -- the composite "
        f"identity is cycle + report + run + IMP)"
    )


def r12_utf16_corruption() -> tuple[bool, str]:
    root = fixture()
    board = root / ".saipen" / "BOARD.md"
    text = "# Board\n## DOING\n## TODO\n- [ ] T-1 [P1] probe | verify: probe\n## DONE\n## BLOCKED\n"
    board.write_bytes(b"\xff\xfe" + text.encode("utf-16-le"))
    result = ticket_add(root, "probe", "P2", "utf16 probe", [], "verify")
    raw = board.read_bytes()
    enc = codec.encoding_of(board)
    ok = result.get("ok") and result.get("code") == "TICKET_ADDED" and enc != "utf-16-le"
    return ok, (
        f"UTF-16LE BOM board mutated via ticket_add, encoding now "
        f"{enc!r}, bom={raw[:2]!r} (required: representation preserved "
        f"or explicit refusal)"
    )


def r13_finish_launders_transition_from() -> tuple[bool, str]:
    """Dogfood IV (T-602): the pre-fix finish wrote transition_from SHIP
    regardless of the actual phase, converting an illegal execution history
    (ticket never ran REVIEW/SHIP) into a syntactically legal DONE state."""
    root = fixture()
    apply_claim(root, "T-1", "probe")
    transition_phase(root, "BUILD", "probe", "T-1", "repro R13")
    transition_phase(root, "VERIFY", "probe", "T-1", "repro R13")
    result = ticket_move(root, "done", "T-1", "probe")
    phase = state_phase(root)
    tf = state_field(root, "transition_from")
    ok = result.get("ok") and result.get("code") == "FINISHED" and phase == "DONE" and tf == "SHIP"
    return ok, (
        f"finish from VERIFY, result={result.get('code')}, "
        f"phase={phase}, transition_from={tf} (required: REFUSE "
        f"ILLEGAL_PHASE, zero bytes, actual history preserved)"
    )


REPROS = [
    ("R1 checkpoint changes phase", r1_checkpoint_changes_phase),
    ("R2 ticket_add changes phase", r2_ticket_add_changes_phase),
    ("R3 goal intent creates SCOUT/none", r3_goal_intent_creates_scout_none),
    ("R4 transition accepts fake ticket", r4_transition_accepts_fake_ticket),
    ("R5 direct TODO -> DONE succeeds", r5_todo_to_done_direct),
    ("R6 dry-run writes digest", r6_dry_run_writes_digest),
    ("R7 WRITER_BUSY leaks exception", r7_writer_busy_leaks_exception),
    ("R8 recovery clobbers intervening work", r8_recovery_clobbers_intervening_work),
    ("R9 improve cycle path traversal", r9_cycle_path_traversal),
    ("R10 multiple active Improve cycles", r10_multiple_active_cycles),
    ("R11 multi-RUN IMP collision sweeps both findings", r11_multi_run_collision),
    ("R12 UTF-16 representation corruption", r12_utf16_corruption),
    ("R13 finish launders transition_from", r13_finish_launders_transition_from),
]


def main() -> int:
    print("NITRO integrity reproduction (R1..R13) -- defect present = REPRODUCED\n")
    all_ok = True
    for label, fn in REPROS:
        ok, detail = fn()
        tag = "REPRODUCED" if ok else "NOT REPRODUCED"
        if not ok:
            all_ok = False
        print(f"[{tag}] {label}")
        print(f"    {detail}")
    print(
        "\n"
        + (
            "ALL 13 REPRODUCED (every claimed defect is live)"
            if all_ok
            else "NOT ALL REPRODUCED -- audit claims need re-checking"
        )
    )
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
