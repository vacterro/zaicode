"""T-1363: an actionable user task reaches productive work with zero coaching.

The field transcript this exists for. A free model was given one ordinary task
-- fix a thing, the task text carried a Windows path -- inside a real project.
It never started. Every protocol surface it touched answered a different
question than the one asked:

* `saipen status --json`, the locator BOOT names, made the OpenCode plugin run
  Fleet prepare, which runs recovery, so a DIAGNOSTIC probe paid the project's
  execution debt;
* `saipen continue` reauthorized a safety valve that had never tripped,
  because `_continue` routed EVERY `RECONCILE_REAUTH_REQUIRED` there, and
  answered "valve has not tripped; no fresh budget is owed" -- a route that
  can never succeed;
* the ingress that persists a user request was unreachable: quotes disqualify
  the canonical grammar, so `saipen user-request '<text>'` read as an ordinary
  shell effect and was refused behind unrelated debt;
* human-mode refusals printed `REFUSE [CODE]` and nothing else, while the JSON
  beside them carried the exact command that would clear the refusal.

Each control below is the measured failure, not an API exercise. The module is
the ticket's own red oracle: run against the tree WITHOUT the T-1363 slice
(`python tools/t1363_red_subject.py`) every control class here goes red.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import ClassVar

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import codec  # noqa: E402
from saipen_engine.board import MAX_LIVE_RECORD_CHARS, parse_board  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402

CLI = REPO / "tools" / "saipen.py"
PLUGIN = REPO / "extensions" / "adapters" / "opencode" / "saipen-guard.js"
BOOT = REPO / "saipen" / "BOOT.md"
NODE = shutil.which("node")
PYTHON = shutil.which("python") or shutil.which("python3") or sys.executable


def setUpModule() -> None:
    isolate_host_session()


# ---------------------------------------------------------------------------
# Fixtures. Every project is written from bytes, never by mutating a live one:
# a forged mid-run edit breaks the append-only ledger, and the refusal that
# produces proves nothing about the gate under test.
# ---------------------------------------------------------------------------

def _stamp(delta_hours: int = 0) -> str:
    # T-1478: the clock is read when the fixture is BUILT, never at import. A
    # module-level "now" is discovery time, and the declared family reaches
    # these fixtures tens of minutes later: a "live" claim was already past
    # board.CLAIM_LIVENESS_WINDOW (15 min), so the verdict followed the
    # machine's speed.
    now = datetime.now(timezone.utc)
    return (now + timedelta(hours=delta_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")


_LEGAL_LOG = (
    "# Log\n- 14.09.26 00:00 [E-0001] [agent: test-agent] "
    "[op: transition-" + "a" * 32 + "] RUN: transition to SCOUT\n"
)


def _allocation_log(*tickets: str) -> str:
    """A LOG in which each fixture ticket was actually ALLOCATED.

    Ticket identity comes from canonical allocation, never from a BOARD row
    that merely looks like one, so a fixture that skips this measures the
    allocation gate instead of the gate under test.
    """
    log = _LEGAL_LOG
    for index, ticket in enumerate(tickets, start=2):
        log += (
            f"- 14.09.26 00:0{index} [E-000{index}] [parent: E-000{index - 1}] "
            f"[{ticket}] [agent: test-agent] [op: ticket-{chr(97 + index) * 32}] "
            f"DEC: ticket add via SAIOPS -- {ticket}\n"
        )
    return log


def _state(**fields) -> str:
    base = {
        "phase": "DONE",
        "task": "none",
        "next_action": "saipen continue",
        "blocker": "",
        "transition_from": "SHIP",
        "saipen_version": "8",
        "schema_version": "3",
        "last_event": "1",
        "style_contract": "ded-4ae736e4",
        "saipen_home": str(REPO),
        "agent": "test-agent",
        "mode": "full",
        "updated": _stamp(),
        "execution_intent": "normal",
    }
    base.update({key: str(value) for key, value in fields.items()})
    lines = ["---"]
    for key, value in base.items():
        quoted = key in ("next_action", "blocker", "updated", "saipen_home")
        lines.append(f'{key}: "{value}"' if quoted else f"{key}: {value}")
    lines.append("---")
    return "\n".join(lines) + "\n"


_EMPTY_BOARD = "## DOING\n## TODO\n## DONE\n## BLOCKED\n"


def project(
    case: unittest.TestCase | None = None,
    *,
    board: str = _EMPTY_BOARD,
    log: str = _LEGAL_LOG,
    **state_fields,
) -> Path:
    root = Path(tempfile.mkdtemp(prefix="t1363-"))
    if case is not None:
        case.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
    # STATE's freshness marker must equal the LOG tail, so derive it from the
    # log this fixture actually writes. A fixture whose marker is stale
    # measures the freshness repair instead of the gate under test.
    events = re.findall(r"\[E-(\d+)\]", log)
    state_fields.setdefault("last_event", int(events[-1]) if events else 1)
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    (saipen / "STATE.md").write_text(_state(**state_fields), encoding="utf-8")
    (saipen / "BOARD.md").write_text(board, encoding="utf-8")
    (saipen / "LOG.md").write_text(log, encoding="utf-8")
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text("code\n", encoding="utf-8")
    return root


def _doing(
    ticket: str, title: str, owner: str, hours: int, claim_session: str | None = None
) -> str:
    binding = f" | claim_session: {claim_session}" if claim_session else ""
    return (
        "## DOING\n"
        f"- [/] {ticket} [P1] {title} | verify: it holds | owner: {owner} "
        f"| claim_time: {_stamp(hours)}{binding}\n"
        "## TODO\n## DONE\n## BLOCKED\n"
    )


def healthy(case: unittest.TestCase) -> Path:
    """Nothing owed, nothing claimed: the plain case START must answer in one."""
    return project(case)


def valve_project(case: unittest.TestCase) -> Path:
    """A tripped safety valve and NOTHING else (MAINTENANCE 2.4)."""
    return project(case, execution_intent="goal", goal_waves=4, goal_tickets=2)


def blocker_project(case: unittest.TestCase) -> Path:
    """An operator-owned STATE.blocker: only a human may say the gate is gone."""
    return project(
        case,
        phase="BUILD",
        task="T-9100",
        next_action="PHASE BUILD T-9100",
        blocker="BLOCKED_EXTERNAL -- upstream API contract unconfirmed",
        transition_from="SCOUT",
        board=_doing("T-9100", "wire the importer", "test-agent", -1),
        log=_allocation_log("T-9100"),
    )


def valve_and_blocker_project(case: unittest.TestCase) -> Path:
    """Both at once -- the negative control P0-7 requires."""
    return project(
        case,
        phase="BUILD",
        task="T-9100",
        next_action="PHASE BUILD T-9100",
        blocker="BLOCKED_EXTERNAL -- upstream API contract unconfirmed",
        transition_from="SCOUT",
        execution_intent="goal",
        goal_waves=4,
        goal_tickets=2,
        board=_doing("T-9100", "wire the importer", "test-agent", -1),
        log=_allocation_log("T-9100"),
    )


#: The binding `foreign_owner_project` puts on its live claim. It stands for
#: the OTHER window's host session, and the arriving session can never present
#: it -- which is the whole point. T-1384 measured a second agent changing
#: product bytes in this exact condition while the ledger stayed clean,
#: because `owner` is a NAME and an arrival with no declared actor inherits
#: it. A claim with no binding models a project written before that existed,
#: not a foreign owner, so leaving this fixture unbound would keep scoring
#: the old hole as normal behaviour.
FOREIGN_CLAIM_SESSION = "f0" * 16


def foreign_owner_project(case: unittest.TestCase) -> Path:
    """Another agent holds a LIVE claim, in ITS OWN host session.

    START must never take that seat -- and no host tool may reach the product
    past it either.
    """
    return project(
        case,
        agent="codex",
        phase="BUILD",
        task="T-9200",
        next_action="PHASE BUILD T-9200",
        transition_from="SCOUT",
        board=_doing(
            "T-9200",
            "work owned elsewhere",
            "codex",
            0,
            claim_session=FOREIGN_CLAIM_SESSION,
        ),
        log=_allocation_log("T-9200"),
    )


def corrupt_receipt_project(case: unittest.TestCase) -> Path:
    """An unfinished canonical operation whose own receipt is unreadable.

    The one journal state NO command settles: the receipt's status lives in
    the bytes that will not decode, so nothing can prove what it applied.
    """
    root = healthy(case)
    op = root / ".saipen" / "recovery" / "ops" / "op-t1363-fixture"
    op.mkdir(parents=True)
    (op / "operation.json").write_bytes(b"this is not json")
    return root


def journal_conflict_project(case: unittest.TestCase) -> Path:
    """A genuine UNRESOLVED conflict: live bytes diverged from the plan."""
    from saipen_engine.journal import Journal, hash_bytes, recover
    from saipen_engine.paths import runtime_lock_identity

    root = healthy(case)
    (root / "a.txt").write_bytes(b"A")
    (root / "b.txt").write_bytes(b"B")
    op_id = "op-t1363-conflict"
    targets = [
        {
            "path": name,
            "role": "generic",
            "content": after,
            "before_hash": hash_bytes(before),
            "after_hash": hash_bytes(after),
        }
        for name, before, after in (("a.txt", b"A", b"A2"), ("b.txt", b"B", b"B2"))
    ]
    Journal(root, op_id).start("op", "probe", runtime_lock_identity(root), "hash", targets)
    # b materialized while a, before it, did not: an out-of-order frontier.
    (root / "b.txt").write_bytes(b"B2")
    recover(root, op_id)
    return root


def own_interrupted_project(case: unittest.TestCase) -> Path:
    """The caller's OWN live Work, mid-BUILD: the seat START must inherit."""
    return project(
        case,
        phase="BUILD",
        task="T-9300",
        next_action="PHASE BUILD T-9300",
        transition_from="SCOUT",
        board=_doing("T-9300", "the work already underway", "test-agent", -2),
        log=_allocation_log("T-9300"),
    )


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------


def cli(root: Path, *args: str, agent: str = "test-agent", timeout: int = 300):
    """One real CLI invocation: (returncode, parsed JSON or None, output)."""
    env = {**os.environ}
    for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT"):
        env.pop(key, None)
    proc = subprocess.run(
        [PYTHON, str(CLI), *args, "--project-root", str(root), "--agent", agent],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        encoding="utf-8",
        errors="replace",
    )
    payload = None
    if "--json" in args:
        try:
            payload = json.loads(proc.stdout)
        except (ValueError, TypeError):
            payload = None
    return proc.returncode, payload, proc.stdout + proc.stderr


def board_of(root: Path) -> dict:
    return parse_board(codec.read_doc(root / ".saipen" / "BOARD.md"))


def section_of(root: Path, ticket: str) -> str | None:
    record = board_of(root)["tickets"].get(ticket)
    return record.get("section") if record else None


def _canonical_bytes(root: Path) -> dict:
    return {
        name: (root / ".saipen" / name).read_bytes()
        for name in ("STATE.md", "BOARD.md", "LOG.md")
    }


def receipts_of(root: Path) -> list[str]:
    active = root / ".saipen" / "intake" / "active"
    if not active.is_dir():
        return []
    return sorted(path.stem for path in active.glob("SRC-*.md"))


# ---------------------------------------------------------------------------
# E / one owner: a diagnostic stays alive, and one table answers for every host
# ---------------------------------------------------------------------------


class CommandEffectOwnerTests(unittest.TestCase):
    """CMD-EFFECT-01: ONE owner decides what an invocation does (P0-1, E)."""

    def setUp(self):
        from saipen_engine import command_effects

        self.effects = command_effects

    def test_classes_are_the_closed_registry_set(self):
        self.assertEqual(
            set(self.effects.CLASSES),
            {"DIAGNOSTIC", "INGRESS", "RECOVERY", "EXECUTION"},
        )

    def test_the_diagnostics_the_transcript_used_never_pay_fleet(self):
        for verb, rest in (
            ("status", ["--json"]),
            ("validate", ["--json"]),
            ("next", []),
            ("context", ["orient", "--json"]),
            ("recover", ["inspect"]),
        ):
            with self.subTest(verb=verb):
                effect = self.effects.classify_invocation(verb, rest)
                self.assertEqual(effect, self.effects.DIAGNOSTIC)
                self.assertFalse(self.effects.fleet_preflight_required(effect))

    def test_help_anywhere_before_a_separator_is_diagnostic(self):
        for verb, rest in (
            (None, ["--help"]),
            ("--help", []),
            ("-h", []),
            ("help", []),
            ("goal", ["--help"]),
            ("user-request", ["--help"]),
            ("ticket", ["unblock", "-h"]),
        ):
            with self.subTest(verb=verb, rest=rest):
                self.assertEqual(
                    self.effects.classify_invocation(verb, rest),
                    self.effects.DIAGNOSTIC,
                )

    def test_help_after_a_separator_does_not_exempt_the_operation(self):
        # `saipen start -- --help` is a task whose TEXT says --help. A payload
        # may never buy its own exemption.
        self.assertEqual(
            self.effects.classify_invocation("start", ["--", "--help"]),
            self.effects.INGRESS,
        )
        self.assertEqual(
            self.effects.classify_invocation("checkpoint", ["--", "--help"]),
            self.effects.EXECUTION,
        )

    def test_ingress_is_reachable_and_execution_is_not_exempt(self):
        for verb in ("start", "user-request"):
            with self.subTest(verb=verb):
                effect = self.effects.classify_invocation(verb, ["some task"])
                self.assertEqual(effect, self.effects.INGRESS)
                self.assertFalse(self.effects.fleet_preflight_required(effect))
        for verb in ("checkpoint", "transition", "claim", "ship", "push"):
            with self.subTest(verb=verb):
                effect = self.effects.classify_invocation(verb, [])
                self.assertEqual(effect, self.effects.EXECUTION)
                self.assertTrue(self.effects.fleet_preflight_required(effect))

    def test_the_narrow_recovery_subcommands_stay_narrow(self):
        self.assertEqual(
            self.effects.classify_invocation("ticket", ["compact", "T-158"]),
            self.effects.RECOVERY,
        )
        for rest in (["compact"], ["compact", "T-158", "T-159"], ["compact", "ALL"]):
            with self.subTest(rest=rest):
                self.assertEqual(
                    self.effects.classify_invocation("ticket", rest),
                    self.effects.EXECUTION,
                )

    def test_global_options_are_not_operands(self):
        self.assertEqual(
            self.effects.classify_tokens(
                ["saipen", "ticket", "--project-root", "X", "compact", "T-158", "--json"]
            ),
            self.effects.RECOVERY,
        )

    def test_the_cli_mutation_gate_reads_the_same_owner(self):
        sys.path.insert(0, str(TOOLS))
        import saipen as cli_module

        self.assertFalse(cli_module._command_mutates("status", ["--json"]))
        self.assertFalse(cli_module._command_mutates("validate", []))
        self.assertTrue(cli_module._command_mutates("start", ["a task"]))
        self.assertTrue(cli_module._command_mutates("checkpoint", ["RUN", "text"]))

    def test_an_unknown_verb_fails_closed_as_execution(self):
        self.assertEqual(
            self.effects.classify_invocation("definitely-not-a-verb", []),
            self.effects.EXECUTION,
        )


class DiagnosticLivenessTests(unittest.TestCase):
    """E: the three probes the transcript ran must answer, not refuse."""

    def test_status_validate_and_help_answer_under_recovery_debt(self):
        root = corrupt_receipt_project(self)
        for args in (("status", "--json"), ("validate", "--json")):
            with self.subTest(args=args):
                _rc, payload, text = cli(root, *args)
                self.assertIsNotNone(payload, text)
                self.assertNotIn("PROTOCOL_STATE_INVALID", text)
        rc, payload, text = cli(root, "--help", "--json")
        self.assertEqual(rc, 0, text)
        self.assertTrue(payload and payload.get("ok"), text)
        self.assertIn("start", str(payload))

    def test_help_exits_zero_and_writes_nothing(self):
        root = healthy(self)
        before = (root / ".saipen" / "LOG.md").read_bytes()
        for args in (("--help",), ("-h",), ("help",)):
            with self.subTest(args=args):
                rc, _payload, text = cli(root, *args)
                self.assertEqual(rc, 0, text)
                self.assertIn("saipen", text)
        self.assertEqual((root / ".saipen" / "LOG.md").read_bytes(), before)

    def test_appending_help_to_a_mutation_writes_nothing(self):
        """A DIAGNOSTIC classification must be TRUE, not merely claimed.

        `--help` makes the classifier call any invocation DIAGNOSTIC, which
        exempts it from Fleet preparation. That exemption is only safe if the
        CLI really answers with usage and writes nothing -- otherwise
        appending `--help` would turn a mutation into an unguarded one.
        """
        root = healthy(self)
        before = _canonical_bytes(root)
        for args in (
            ("checkpoint", "RUN", "text", "--help"),
            ("transition", "BUILD", "--help"),
            ("claim", "T-1", "--help"),
            ("goal", "--help"),
            ("user-request", "a task", "--help"),
            ("start", "a task", "--help"),
            ("ticket", "done", "T-1", "--help"),
            ("recover", "--help"),
        ):
            with self.subTest(args=args):
                rc, _payload, text = cli(root, *args)
                self.assertEqual(rc, 0, text)
                self.assertEqual(_canonical_bytes(root), before, args)

    def test_a_payload_that_spells_help_buys_no_exemption(self):
        """Text AFTER `--` is a payload, never a usage probe.

        The CLI stops reading options at `--`, so a `--help` beyond it never
        reaches the usage branch. The classifier must stop in the same place,
        or a mutation could carry its own exemption in its arguments.
        """
        from saipen_engine import command_effects

        import saipen as cli_module

        for verb, rest in (
            ("checkpoint", ["RUN", "note", "--", "--help"]),
            ("transition", ["BUILD", "--", "-h"]),
        ):
            with self.subTest(verb=verb, rest=rest):
                effect = command_effects.classify_invocation(verb, rest)
                self.assertEqual(effect, command_effects.EXECUTION)
                self.assertTrue(command_effects.fleet_preflight_required(effect))
                self.assertTrue(cli_module._command_mutates(verb, rest))
        # ... while the same tokens BEFORE the separator are the usage probe,
        # and that invocation really does write nothing (the control above).
        self.assertEqual(
            command_effects.classify_invocation("checkpoint", ["RUN", "note", "--help"]),
            command_effects.DIAGNOSTIC,
        )
        self.assertFalse(cli_module._command_mutates("checkpoint", ["RUN", "note", "--help"]))

    def test_every_diagnostic_verb_is_read_only_in_the_dispatcher(self):
        """One owner: the table's DIAGNOSTIC set and the CLI's gate agree."""
        from saipen_engine import command_effects

        import saipen as cli_module

        for verb, entry in command_effects._VERBS.items():
            classes = [entry] if isinstance(entry, str) else [entry.get("default")]
            if classes[0] != command_effects.DIAGNOSTIC:
                continue
            with self.subTest(verb=verb):
                self.assertFalse(cli_module._command_mutates(verb, []), verb)


# ---------------------------------------------------------------------------
# P0-5: real task text reaches the ingress
# ---------------------------------------------------------------------------

#: The EXACT shape the field incident carried. A zero-manual entry that fails
#: on a Windows path reproduces the bug it was written to close.
FIELD_TASK = r"fix the drag handler in V:\_TEMP_\fastprompter_drag\SAIPENVIEW_main.py"

#: Task texts a real user writes. Each must reach durable intake AS TYPED --
#: in ONE command where a shell can carry the bytes literally, otherwise
#: through the exact `--hex` command the guard hands back (never through
#: rewording, and never by paying Fleet on the way).
LITERAL_TASKS = [
    "fix login bug",
    FIELD_TASK,
    r"fix V:\repo\file.py",
    "fix $HOME handling",
    "allow A&B",
    "support 50% threshold",
    "ratio 3:4 handling",
    "парсер падает на кириллице",
    "paranda sisselogimise viga tootekaardil",
]
#: Text no single shell argument can carry portably: the closing quote, a
#: second `%` cmd.exe would expand, a double quote PowerShell 5.1 re-quotes
#: wrong, a trailing backslash the C runtime eats, and a newline.
HEX_ONLY_TASKS = [
    "fix the user's profile page",
    'fix the "quoted" label',
    "expand %USERPROFILE% correctly",
    "handle the trailing separator in a path like C:\\tmp\\",
    "first line\nsecond line",
]


def _guard_event(command: str, root: Path | None = None) -> dict:
    return {
        "event": "before_tool",
        "host": "opencode",
        "cwd": str(root or REPO),
        "tool_name": "bash",
        "tool_input": {"command": command},
        "actor": "test-agent",
    }


class IngressGrammarTests(unittest.TestCase):
    """P0-5: the ingress is reachable for text people actually type."""

    def setUp(self):
        from saipen_engine import guard_events

        self.guard = guard_events

    def _mapped(self, command: str) -> dict:
        return self.guard.map_event(_guard_event(command))

    def test_literal_task_text_is_one_canonical_ingress_command(self):
        for task in LITERAL_TASKS:
            command = "saipen start '" + task + "'"
            with self.subTest(task=task):
                mapped = self._mapped(command)
                self.assertEqual(mapped["saipen_verb"], "start", mapped["detail"])
                self.assertEqual(mapped["command_class"], "INGRESS")
                self.assertFalse(mapped["fleet_preflight"])

    def test_unquotable_task_text_gets_the_exact_replacement_command(self):
        for task in HEX_ONLY_TASKS:
            command = "saipen start '" + task + "'"
            with self.subTest(task=task):
                mapped = self._mapped(command)
                self.assertNotEqual(mapped["action"], "saipen_op", mapped)
                route = mapped.get("canonical_next_command") or ""
                self.assertTrue(
                    route.startswith("saipen start --hex "),
                    f"no mechanical route for {task!r}: {mapped!r}",
                )
                payload = route.split(" --hex ", 1)[1].strip()
                self.assertEqual(bytes.fromhex(payload).decode("utf-8"), task)

    def test_the_replacement_command_is_itself_canonical_ingress(self):
        for task in LITERAL_TASKS + HEX_ONLY_TASKS:
            command = "saipen start --hex " + task.encode("utf-8").hex()
            with self.subTest(task=task):
                mapped = self._mapped(command)
                self.assertEqual(mapped["saipen_verb"], "start")
                self.assertEqual(mapped["command_class"], "INGRESS")
                self.assertFalse(mapped["fleet_preflight"])

    def test_the_field_incident_text_survives_double_quotes_too(self):
        """A weak model quotes with `"` as readily as `'`.

        Measured on the polygon: the free model typed the field task inside
        double quotes. Bash escapes with a backslash there ONLY before
        ``$ ` " \\`` or a newline, and PowerShell and cmd never do, so the
        three backslashes in a Windows path are literal in all of them.
        Refusing the whole line cost a route the request never needed.
        """
        from saipen_engine.guard_events import ingress_payload_literal

        for task in LITERAL_TASKS:
            with self.subTest(task=task):
                mapped = self._mapped('saipen start "' + task + '"')
                if "$" in task:
                    # `$` DOES expand inside double quotes: single quotes only.
                    self.assertNotEqual(mapped["action"], "saipen_op", mapped)
                    continue
                self.assertEqual(mapped["saipen_verb"], "start", mapped["detail"])
                self.assertEqual(mapped["command_class"], "INGRESS")
        for unsafe in ("a \\$b", 'a \\" b', "a b\\", "a `b`", "a $HOME b"):
            with self.subTest(unsafe=unsafe):
                self.assertFalse(ingress_payload_literal(unsafe, '"'), unsafe)

    def test_a_long_request_is_routed_to_a_transport_nobody_transcribes(self):
        """A route a weak model cannot COPY is not a route.

        Measured on the polygon: given a ~700 character hex blob the free
        model transcribed it twice and corrupted it both times -- once by
        inserting a literal ` app` into the middle of the digits -- then
        abandoned the route and improvised twelve refusals. Past a size a
        model can copy, the refusal names the file transport instead: written
        with the host's own write tool, it passes through no shell at all.
        """
        from saipen_engine.guard_events import MAX_INGRESS_HEX_PAYLOAD, ingress_rewrite

        long_task = "fix the user's profile page and " + ("keep the CSV export intact " * 6)
        self.assertGreater(len(long_task.encode("utf-8")), MAX_INGRESS_HEX_PAYLOAD)
        self.assertEqual(
            ingress_rewrite("saipen start '" + long_task + "'"),
            "saipen start --file <path>",
        )
        short = "fix the user's page"
        route = ingress_rewrite("saipen start '" + short + "'")
        self.assertTrue(route.startswith("saipen start --hex "), route)
        self.assertLessEqual(len(route), 2 * MAX_INGRESS_HEX_PAYLOAD + 40)

    def test_the_file_transport_carries_what_no_shell_argument_can(self):
        root = healthy(self)
        task = (
            "fix the user's profile page\n\n"
            'keep the "quoted" label, the 100% width and the C:\\tmp\\ prefix\n'
        )
        (root / "task.txt").write_text(task, encoding="utf-8")
        rc, payload, text = cli(root, "start", "--file", "task.txt", "--json")
        self.assertEqual(rc, 0, text)
        self.assertEqual(payload.get("code"), "STARTED", text)
        body = (
            root / ".saipen" / "intake" / "active" / f"{payload['receipt']}.md"
        ).read_text(encoding="utf-8")
        self.assertIn(task.strip(), body)

    def test_the_file_transport_refuses_what_it_cannot_read(self):
        root = healthy(self)
        rc, payload, text = cli(root, "start", "--file", "no-such-file.txt", "--json")
        self.assertEqual(rc, 2, text)
        self.assertEqual(payload.get("code"), "VALIDATION_FAILED", text)
        (root / "task.txt").write_text("a task", encoding="utf-8")
        rc, payload, text = cli(root, "start", "--file", "task.txt", "other text", "--json")
        self.assertEqual(rc, 2, text)

    def test_the_route_is_a_bounded_machine_fact(self):
        """A refusal may never print an unbounded fact back to the host."""
        from saipen_engine.guard_events import (
            MAX_INGRESS_HEX_PAYLOAD,
            MAX_INGRESS_REWRITE_CHARS,
            ingress_rewrite,
        )

        fits = "fix the exporter's column " * 60
        self.assertLessEqual(len(fits), MAX_INGRESS_REWRITE_CHARS)
        # Long but still within the request bound: routed to the transport
        # that needs no transcription, never to an unbounded hex blob.
        self.assertEqual(
            ingress_rewrite("saipen start '" + fits + "'"), "saipen start --file <path>"
        )
        short = "fix the user's page"
        self.assertLessEqual(len(short.encode("utf-8")), MAX_INGRESS_HEX_PAYLOAD)
        self.assertTrue(
            (ingress_rewrite("saipen start '" + short + "'") or "").startswith(
                "saipen start --hex "
            )
        )
        too_long = "x" * (MAX_INGRESS_REWRITE_CHARS + 1)
        self.assertIsNone(ingress_rewrite("saipen start '" + too_long + "'"))

    def test_only_an_ingress_verb_gets_a_transport_route(self):
        from saipen_engine.guard_events import ingress_rewrite

        for command in (
            "saipen checkpoint RUN 'some note'",
            "saipen recover 'x'",
            "rm -rf 'x'",
            "saipen start",
            "saipen start '--priority'",
        ):
            with self.subTest(command=command):
                self.assertIsNone(ingress_rewrite(command), command)

    def test_a_payload_may_never_buy_an_exemption_for_a_second_effect(self):
        hostile = [
            "saipen start 'ok' && rm -rf .saipen",
            "saipen start 'ok'; rm -rf .saipen",
            "saipen start 'ok' | tee .saipen/STATE.md",
            "saipen start 'a' 'b'",
            "saipen start 'ok'&&echo x",
            "saipen start '--priority' P0",
            "rm -rf .saipen && saipen start 'ok'",
            "saipen start 'unterminated",
        ]
        for command in hostile:
            with self.subTest(command=command):
                mapped = self._mapped(command)
                self.assertNotEqual(mapped["action"], "saipen_op", command)

    def test_the_hex_transport_carries_every_required_alphabet(self):
        root = healthy(self)
        for task in LITERAL_TASKS + HEX_ONLY_TASKS:
            with self.subTest(task=task):
                encoded = task.encode("utf-8").hex()
                rc, payload, text = cli(root, "start", "--hex", encoded, "--json")
                self.assertEqual(rc, 0, text)
                self.assertEqual(payload.get("code"), "STARTED", text)
                receipt = payload["receipt"]
                body = (
                    root / ".saipen" / "intake" / "active" / f"{receipt}.md"
                ).read_text(encoding="utf-8")
                self.assertIn(task, body)
                cli(root, "ticket", "done", payload["ticket"], "--json")

    def test_the_field_incident_text_starts_in_one_command(self):
        root = healthy(self)
        rc, payload, text = cli(root, "start", FIELD_TASK, "--json")
        self.assertEqual(rc, 0, text)
        self.assertEqual(payload.get("code"), "STARTED", text)
        receipt_body = (
            root / ".saipen" / "intake" / "active" / f"{payload['receipt']}.md"
        ).read_text(encoding="utf-8")
        self.assertIn(FIELD_TASK, receipt_body)

    def test_a_multiline_request_survives_byte_for_byte(self):
        root = healthy(self)
        task = "rewrite the importer\n\n- keep the CSV path\n- drop the XML branch\n"
        rc, payload, text = cli(root, "start", "--hex", task.encode("utf-8").hex(), "--json")
        self.assertEqual(rc, 0, text)
        body = (
            root / ".saipen" / "intake" / "active" / f"{payload['receipt']}.md"
        ).read_text(encoding="utf-8")
        self.assertIn(task.strip(), body)


class ReadOnlyProbeBoundaryTests(unittest.TestCase):
    """A shell probe earns the read class only when its effects are PROVEN.

    `Test-Path '.saipen/MANIFEST.json'` asked exactly what native `read` asks
    and was refused as PROTECTED_CANONICAL_NAMESPACE because the text named
    the namespace -- one question, two answers, and the model spent its turn
    working around the refusal. The exemption that fixes it must stay narrow:
    the boundary is a closed verb set over a line with nothing computed,
    redirected into a file, wrapped, evaluated or scripted. Unknown computed
    shell semantics stay ordinary shell semantics.
    """

    def setUp(self):
        from saipen_engine.guard_events import provably_read_only_shell

        self.probe = provably_read_only_shell

    def test_the_probes_the_transcript_used_are_reads(self):
        for command in (
            "Test-Path .saipen/MANIFEST.json",
            "Get-Content .saipen/STATE.md",
            "cat .saipen/STATE.md",
            "git rev-parse --show-toplevel",
            "git status",
            "ls -la",
            "head -n 40 .saipen/LOG.md",
            "grep -n phase .saipen/STATE.md 2>/dev/null",
            "cat .saipen/BOARD.md | head -n 5",
        ):
            with self.subTest(command=command):
                self.assertTrue(self.probe(command), command)

    def test_anything_computed_wrapped_or_written_stays_shell(self):
        for command in (
            'Write-Output "$(git rev-parse HEAD)"',
            "cat .saipen/STATE.md > /tmp/copy",
            "cat a>b",
            "python -c 'print(1)'",
            "bash -lc 'cat x'",
            "eval cat x",
            "git -c core.pager=cat log",
            "git diff --output=/tmp/x",
            "./cat.ps1",
            "C:/tmp/git.exe status",
            "cat x && rm -rf .saipen",
            "cat ${HOME}/x",
            "ls `pwd`",
            "npm install",
            "rm -rf .",
        ):
            with self.subTest(command=command):
                self.assertFalse(self.probe(command), command)

    def test_bounded_runtime_probes_are_reads(self):
        """SRC-085 M1: version probes a gate assigns are observation.

        The authority is the closed tool set plus a version-only argument
        grammar -- not a substring match on `--version`. A known program given
        any other argument stays an ordinary shell effect.
        """
        for command in (
            "node --version",
            "node -v",
            "python --version",
            "python3 --version",
            "py -V",
            "npm --version",
            "ruff --version",
            "git --version",
            "whoami",
            "hostname",
            "Get-Location",
            "Get-Date",
        ):
            with self.subTest(command=command):
                self.assertTrue(self.probe(command), command)

    def test_a_probe_tool_with_any_other_argument_is_not_a_read(self):
        for command in (
            "python script.py",
            "python -m pytest",
            "node server.js",
            "npm run build",
            "git add .",
            "git checkout main",
            "pip install requests",
            "powershell -Command Remove-Item .saipen/STATE.md",
        ):
            with self.subTest(command=command):
                self.assertFalse(self.probe(command), command)

    def test_the_read_class_reaches_the_mapped_event(self):
        from saipen_engine import guard_events

        mapped = guard_events.map_event(_guard_event("Test-Path .saipen/MANIFEST.json"))
        self.assertEqual(mapped["action"], "read")
        self.assertEqual(mapped["command_class"], "DIAGNOSTIC")
        self.assertFalse(mapped["fleet_preflight"])
        mapped = guard_events.map_event(_guard_event("npm install"))
        self.assertEqual(mapped["action"], "shell")
        self.assertEqual(mapped["command_class"], "EXECUTION")
        self.assertTrue(mapped["fleet_preflight"])

    def test_one_question_gets_one_answer_on_protected_state(self):
        """The T-1354 open finding, end to end through the real verdict.

        `read` of `.saipen/STATE.md` is ADMITTED_READ_ONLY ("read of protected
        canonical state is diagnostic access, permitted") while the shell
        spelling of the SAME question was refused, because the namespace flag
        was set from the command text and returned before any effect
        classification ran. A write or a delete over that namespace is still
        refused -- that part was never the bug.
        """
        from saipen_engine import guard_events

        root = healthy(self)
        for command, admitted in (
            ("Test-Path .saipen/STATE.md", True),
            ("cat .saipen/STATE.md", True),
            ("Get-Content .saipen/BOARD.md", True),
            ("rm -rf .saipen", False),
            ("echo x > .saipen/STATE.md", False),
            ("cp src/app.py .saipen/STATE.md", False),
        ):
            with self.subTest(command=command):
                verdict = guard_events.evaluate_event(_guard_event(command, root))
                self.assertEqual(verdict.get("admitted"), admitted, verdict)
                if not admitted:
                    self.assertEqual(verdict.get("code"), "PROTECTED_CANONICAL_NAMESPACE")


# ---------------------------------------------------------------------------
# A + P0-7: every RECONCILE_REAUTH_REQUIRED producer, not only the valve
# ---------------------------------------------------------------------------


def valve_next_action_project(case: unittest.TestCase) -> Path:
    """The counters are at the cap and `next_action` does not state the pause."""
    return project(
        case,
        execution_intent="goal",
        goal_waves=3,
        goal_tickets=21,
        next_action="saipen continue",
    )


def legacy_done_project(case: unittest.TestCase) -> Path:
    """A DONE record with no completion evidence in either generation."""
    from test_legacy_lifecycle_compat import audapack_project

    root = audapack_project(modern_phantom=False)
    case.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
    return root


def approved_repair_project(case: unittest.TestCase) -> Path:
    """A current-generation DONE record whose reopen needs ONE approval."""
    from test_recover_approved_repair import legacy_project

    root = legacy_project()
    case.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
    return root


def unallocated_record_project(case: unittest.TestCase) -> Path:
    """Open records the ledger never allocated (adoption)."""
    from test_adoption_section_parity import detached_project

    root = detached_project()
    case.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
    return root


def unexecutable_next_action_project(case: unittest.TestCase) -> Path:
    """A freeform `next_action` no router can project (SAITULS deadlock)."""
    return project(
        case,
        phase="DONE",
        task="none",
        next_action="carry on with the migration work",
        transition_from="SHIP",
    )


class ReauthProducerMatrixTests(unittest.TestCase):
    """A / P0-7: one code, several authorities. Only the valve is automatic."""

    PRODUCERS: ClassVar[dict] = {
        "safety_valve_counter": valve_project,
        "safety_valve_next_action": valve_next_action_project,
        "operator_blocker": blocker_project,
        "unexecutable_next_action": unexecutable_next_action_project,
        "legacy_done_attestation": legacy_done_project,
        "unallocated_record_adoption": unallocated_record_project,
        "approval_gated_lifecycle_plan": approved_repair_project,
    }

    def _reconcile(self, root: Path) -> dict:
        from saipen_engine.reconcile import reconcile_protocol_state

        return reconcile_protocol_state(root, "test-agent", dry_run=True)

    def test_every_producer_carries_a_structured_discriminator(self):
        for name, build in self.PRODUCERS.items():
            with self.subTest(producer=name):
                result = self._reconcile(build(self))
                if result.get("ok"):
                    self.skipTest(f"{name} does not reconcile as a refusal on this tree")
                self.assertEqual(result.get("code"), "RECONCILE_REAUTH_REQUIRED", result)
                self.assertIn(
                    result.get("remediation"),
                    ("SAFETY_VALVE_TRIPPED", "OPERATOR_DECISION"),
                    result,
                )
                expected = (
                    "SAFETY_VALVE_TRIPPED"
                    if name.startswith("safety_valve")
                    else "OPERATOR_DECISION"
                )
                self.assertEqual(result.get("remediation"), expected, result)

    def test_every_producer_names_an_exact_next_command(self):
        for name, build in self.PRODUCERS.items():
            with self.subTest(producer=name):
                result = self._reconcile(build(self))
                if result.get("ok"):
                    self.skipTest(f"{name} reconciles clean on this tree")
                command = result.get("canonical_next_command")
                self.assertTrue(
                    isinstance(command, str) and command.startswith("saipen "),
                    f"{name} named no command: {result}",
                )

    def test_continue_reauthorizes_only_a_proven_valve(self):
        _rc, payload, text = cli(valve_project(self), "continue", "--json")
        self.assertIn(
            str(payload and payload.get("code")),
            ("VALVE_REAUTHORIZED", "REAUTHORIZED", "CONTINUE", "PHASE"),
            text,
        )
        self.assertNotIn("valve has not tripped", text)

    def test_continue_never_answers_an_operator_decision_with_the_valve(self):
        for name, build in self.PRODUCERS.items():
            if name.startswith("safety_valve"):
                continue
            with self.subTest(producer=name):
                _rc, _payload, text = cli(build(self), "continue", "--json")
                self.assertNotIn("valve has not tripped", text)
                self.assertNotIn("no fresh budget is owed", text)


# ---------------------------------------------------------------------------
# B, C, P0-4, P0-6, P0-7 negative control: START itself
# ---------------------------------------------------------------------------


class StartEntryTests(unittest.TestCase):
    """The one entry command, measured end to end through the real CLI."""

    def test_b_ingress_is_not_blocked_by_unrelated_reconciliation_debt(self):
        root = blocker_project(self)
        _rc, payload, text = cli(root, "start", "add a CSV export button", "--json")
        self.assertIsNotNone(payload, text)
        receipt = payload.get("receipt")
        self.assertTrue(receipt, f"the request was not captured at all: {text}")
        self.assertIn(
            "add a CSV export button",
            (root / ".saipen" / "intake" / "active" / f"{receipt}.md").read_text(
                encoding="utf-8"
            ),
        )

    def test_c_the_seat_is_inherited_not_negotiated(self):
        root = own_interrupted_project(self)
        rc, payload, text = cli(root, "start", "urgent: patch the crash", "--json")
        self.assertEqual(rc, 0, text)
        self.assertEqual(payload.get("code"), "STARTED", text)
        self.assertEqual(section_of(root, payload["ticket"]), "## DOING")
        parked = payload.get("parked") or {}
        self.assertEqual(parked.get("ticket"), "T-9300", payload)
        self.assertEqual(parked.get("resume_phase"), "BUILD", payload)
        self.assertEqual(section_of(root, "T-9300"), "## BLOCKED")

    def test_a_healthy_project_starts_in_exactly_one_command(self):
        root = healthy(self)
        rc, payload, text = cli(root, "start", "add a CSV export button", "--json")
        self.assertEqual(rc, 0, text)
        self.assertEqual(payload.get("code"), "STARTED", text)
        self.assertTrue(str(payload.get("action", "")).startswith("PHASE "), payload)
        self.assertTrue(payload.get("load_path"), payload)

    def test_start_never_steals_a_live_foreign_seat(self):
        root = foreign_owner_project(self)
        _rc, payload, text = cli(root, "start", "unrelated new task", "--json")
        self.assertEqual(payload.get("code"), "WAIT_FOREIGN_OWNER", text)
        self.assertEqual(section_of(root, "T-9200"), "## DOING")
        record = board_of(root)["tickets"]["T-9200"]
        self.assertEqual((record.get("fields") or {}).get("owner"), "codex")
        self.assertTrue(payload.get("receipt"), payload)

    def test_the_valve_is_cleared_but_an_operator_decision_survives(self):
        # P0-7 negative control. The new explicit task IS the human authority
        # for the valve; it is not authority over an unrelated gate.
        root = valve_and_blocker_project(self)
        _rc, payload, text = cli(root, "start", "add a CSV export button", "--json")
        self.assertEqual(payload.get("code"), "WAIT_OPERATOR", text)
        decision = payload.get("decision") or {}
        self.assertEqual(decision.get("field"), "blocker", payload)
        self.assertTrue(
            str(decision.get("command", "")).startswith("saipen recover resolve-blocker"),
            payload,
        )
        self.assertEqual(
            payload.get("resume_command"), f"saipen start --receipt {payload['receipt']}"
        )
        self.assertTrue(payload.get("valve_reauthorized"), payload)

    def test_the_decision_is_asked_once_and_the_retry_starts(self):
        root = valve_and_blocker_project(self)
        rc, first, text = cli(root, "start", "add a CSV export button", "--json")
        self.assertEqual(first.get("code"), "WAIT_OPERATOR", text)
        command = (first.get("decision") or {})["command"].replace(
            "<decision>", "the upstream contract landed"
        )
        rc, _payload, text = cli(root, *command.split(" ")[1:], "--json")
        self.assertEqual(rc, 0, text)
        rc, second, text = cli(
            root, "start", "--receipt", first["receipt"], "--json"
        )
        self.assertEqual(second.get("code"), "STARTED", text)
        self.assertEqual(second.get("receipt"), first["receipt"])

    def test_start_waits_on_a_journal_conflict_and_names_the_settling_command(self):
        root = journal_conflict_project(self)
        _rc, payload, text = cli(root, "start", "add a CSV export button", "--json")
        self.assertEqual(payload.get("code"), "WAIT_OPERATOR", text)
        self.assertTrue(
            str(payload.get("canonical_next_command", "")).startswith("saipen recover"),
            payload,
        )
        self.assertTrue(payload.get("receipt"), "the request was lost to the conflict")


# ---------------------------------------------------------------------------
# P0-4: content equality is a TRANSPORT identity, never a new-action identity
# ---------------------------------------------------------------------------


def completed_request_project(case: unittest.TestCase, text: str) -> Path:
    """A project where THIS exact request was already asked and finished.

    Written from bytes, like every other fixture here: the finished Work sits
    under ## DONE with its allocation in history, and the receipt that
    produced it is linked to it. Driving a whole ticket lifecycle instead
    would measure the lifecycle, not the identity rule under test.
    """
    from saipen_engine import intake
    from saipen_engine.operations import USER_REQUEST_VERIFY, _user_request_body

    root = project(
        case,
        board=(
            "## DOING\n## TODO\n## DONE\n"
            f"- [x] T-8300 [P1] {text} | verify: it ran | user_explicit: true "
            "| closure_mode: own_patch\n## BLOCKED\n"
        ),
        log=_allocation_log("T-8300"),
    )
    body = _user_request_body(text, "P1", USER_REQUEST_VERIFY, [])
    captured = intake.capture(root, body, source_kind="user_instruction", work="T-8300")
    assert captured.get("ok"), captured
    assert captured.get("linked_work") == "T-8300", captured
    return root


class RequestIdentityTests(unittest.TestCase):
    """The same words twice: once a retry, once a genuinely new instruction."""

    TASK = "run the nightly cleanup"

    def _start(self, root: Path, *extra: str):
        return cli(root, "start", *(extra or (self.TASK,)), "--json")

    def test_a_retry_while_the_work_is_active_resumes_the_same_work(self):
        root = healthy(self)
        _rc, first, text = self._start(root)
        self.assertEqual(first.get("code"), "STARTED", text)
        _rc, second, text = self._start(root)
        self.assertEqual(second.get("code"), "STARTED", text)
        self.assertEqual(second.get("receipt"), first["receipt"], text)
        self.assertEqual(second.get("ticket"), first["ticket"], text)
        self.assertTrue(second.get("resumed"), second)
        self.assertEqual(len(receipts_of(root)), 1, receipts_of(root))

    def test_a_crash_after_capture_before_projection_resumes_that_receipt(self):
        root = healthy(self)
        from saipen_engine import intake
        from saipen_engine.operations import USER_REQUEST_VERIFY, _user_request_body

        body = _user_request_body(self.TASK, "P1", USER_REQUEST_VERIFY, [])
        captured = intake.capture(root, body, source_kind="user_instruction")
        self.assertTrue(captured.get("ok"), captured)
        self.assertIsNone(captured.get("linked_work"), captured)
        _rc, payload, text = self._start(root)
        self.assertEqual(payload.get("code"), "STARTED", text)
        self.assertEqual(payload.get("receipt"), captured["receipt"], text)
        self.assertEqual(len(receipts_of(root)), 1, receipts_of(root))

    def test_a_response_loss_after_projection_creates_no_second_work(self):
        root = healthy(self)
        _rc, first, text = self._start(root)
        self.assertEqual(first.get("code"), "STARTED", text)
        tickets_before = set(board_of(root)["tickets"])
        _rc, _second, text = self._start(root)
        self.assertEqual(set(board_of(root)["tickets"]), tickets_before, text)

    def test_an_explicit_receipt_resumes_that_exact_authority(self):
        root = healthy(self)
        _rc, first, _text = self._start(root)
        _rc, resumed, text = cli(root, "start", "--receipt", first["receipt"], "--json")
        self.assertEqual(resumed.get("code"), "STARTED", text)
        self.assertEqual(resumed.get("ticket"), first["ticket"], text)

    def test_the_same_text_after_done_is_a_new_action_not_a_duplicate(self):
        root = completed_request_project(self, self.TASK)
        before = receipts_of(root)
        self.assertEqual(len(before), 1, before)
        rc, again, text = self._start(root)
        self.assertEqual(rc, 0, text)
        self.assertEqual(again.get("code"), "STARTED", text)
        self.assertNotEqual(again.get("ticket"), "T-8300", again)
        self.assertNotIn(again.get("receipt"), before, again)
        self.assertEqual(section_of(root, again["ticket"]), "## DOING")
        self.assertEqual(section_of(root, "T-8300"), "## DONE")

    def test_the_new_action_is_itself_retry_safe(self):
        root = completed_request_project(self, self.TASK)
        _rc, again, text = self._start(root)
        self.assertEqual(again.get("code"), "STARTED", text)
        _rc, retry, text = self._start(root)
        self.assertEqual(retry.get("receipt"), again["receipt"], text)
        self.assertEqual(retry.get("ticket"), again["ticket"], text)
        self.assertEqual(len(receipts_of(root)), 2, receipts_of(root))

    def test_an_explicit_receipt_of_finished_work_says_so_and_mints_nothing(self):
        """`--receipt` resumes THAT authority, never a successor of its text."""
        root = completed_request_project(self, self.TASK)
        original = receipts_of(root)[0]
        rc, payload, text = cli(root, "start", "--receipt", original, "--json")
        self.assertEqual(payload.get("code"), "TICKET_ALREADY_DONE", text)
        self.assertEqual(payload.get("ticket"), "T-8300", payload)
        self.assertEqual(receipts_of(root), [original], receipts_of(root))
        self.assertEqual(rc, 1, text)

    def test_the_new_receipt_records_what_it_supersedes(self):
        root = completed_request_project(self, self.TASK)
        original = receipts_of(root)[0]
        _rc, again, _text = self._start(root)
        body = (
            root / ".saipen" / "intake" / "active" / f"{again['receipt']}.md"
        ).read_text(encoding="utf-8")
        self.assertIn("supersedes: " + original, body)
        self.assertIn(self.TASK, body)


# ---------------------------------------------------------------------------
# P0-6: the SRC-044 finding -- a durable request always reaches a Work line
# ---------------------------------------------------------------------------


class OversizedProjectionTests(unittest.TestCase):
    """Capture succeeded; the BOARD row did not fit. The receipt still wins."""

    TASK = "rebuild the exporter"

    def _verify(self, chars: int) -> str:
        return ("proof that " + ("the exporter emits every column " * (chars // 31))).strip()

    def test_an_oversized_verify_becomes_a_compact_row_pointing_at_the_receipt(self):
        root = healthy(self)
        verify = self._verify(2400)
        rc, payload, text = cli(
            root, "start", self.TASK, "--verify", verify, "--json"
        )
        self.assertEqual(rc, 0, text)
        self.assertEqual(payload.get("code"), "STARTED", text)
        record = board_of(root)["tickets"][payload["ticket"]]
        self.assertLessEqual(len(record["raw"].rstrip()), MAX_LIVE_RECORD_CHARS)
        fields = record.get("fields") or {}
        self.assertIn(payload["receipt"], fields.get("source_receipts", ""))
        self.assertIn(payload["receipt"], fields.get("verify", ""))
        body = (
            root / ".saipen" / "intake" / "active" / f"{payload['receipt']}.md"
        ).read_text(encoding="utf-8")
        self.assertIn(verify, body)

    def test_exactly_one_work_is_created_and_a_retry_adds_none(self):
        root = healthy(self)
        verify = self._verify(2400)
        _rc, first, text = cli(root, "start", self.TASK, "--verify", verify, "--json")
        self.assertEqual(first.get("code"), "STARTED", text)
        tickets = set(board_of(root)["tickets"])
        _rc, second, text = cli(root, "start", self.TASK, "--verify", verify, "--json")
        self.assertEqual(second.get("ticket"), first["ticket"], text)
        self.assertEqual(set(board_of(root)["tickets"]), tickets)
        self.assertEqual(len(receipts_of(root)), 1)

    def test_a_request_that_cannot_fit_at_all_returns_one_bounded_answer(self):
        root = healthy(self)
        huge_title = "rebuild " + ("the exporter pipeline component " * 60)
        rc, payload, text = cli(
            root, "start", huge_title, "--verify", self._verify(2400), "--json"
        )
        self.assertIsNotNone(payload, text)
        self.assertTrue(payload.get("receipt"), text)
        if payload.get("ok"):
            record = board_of(root)["tickets"][payload["ticket"]]
            self.assertLessEqual(len(record["raw"].rstrip()), MAX_LIVE_RECORD_CHARS)
        else:
            self.assertTrue(
                payload.get("canonical_next_command") or payload.get("resume_command"),
                payload,
            )
        rc2, repeat, text2 = cli(
            root, "start", huge_title, "--verify", self._verify(2400), "--json"
        )
        self.assertEqual(rc2, rc, text2)
        self.assertEqual(repeat.get("code"), payload.get("code"), text2)


# ---------------------------------------------------------------------------
# F / P0-8: the human projection is part of the weak-model API
# ---------------------------------------------------------------------------


class HumanRefusalTests(unittest.TestCase):
    """A model reading stdout must find the next command without grepping."""

    def _refusal(self, root: Path, *args: str) -> str:
        _rc, _payload, text = cli(root, *args)
        return text

    def _assert_actionable(self, text: str, *, expect_then: bool = False):
        self.assertIn("REFUSE [", text)
        self.assertIn("reason:", text)
        self.assertIn("next:", text)
        command = next(
            line for line in text.splitlines() if line.startswith("next:")
        )
        self.assertIn("saipen ", command)
        if expect_then:
            self.assertIn("then:", text)

    def test_wait_operator_prints_reason_next_and_then(self):
        text = self._refusal(
            valve_and_blocker_project(self), "start", "add a CSV export button"
        )
        self._assert_actionable(text, expect_then=True)
        self.assertIn("resolve-blocker", text)

    def test_reconcile_reauth_required_prints_its_exact_command(self):
        text = self._refusal(blocker_project(self), "continue")
        self._assert_actionable(text)

    def test_a_journal_conflict_prints_the_command_that_settles_it(self):
        text = self._refusal(journal_conflict_project(self), "start", "a new task")
        self._assert_actionable(text)
        self.assertIn("saipen recover", text)

    def test_a_foreign_owner_refusal_says_who_owns_the_seat(self):
        text = self._refusal(foreign_owner_project(self), "start", "a new task")
        self.assertIn("REFUSE [WAIT_FOREIGN_OWNER]", text)
        self.assertIn("reason:", text)
        self.assertIn("codex", text)
        self.assertIn("then:", text)

    def test_a_projected_request_failure_still_names_the_receipt(self):
        root = healthy(self)
        verify = "proof " + ("that every column is emitted exactly once " * 60)
        _rc, _payload, text = cli(
            root,
            "start",
            "rebuild " + ("the exporter pipeline component " * 60),
            "--verify",
            verify,
        )
        self.assertTrue(
            "STARTED" in text or ("REFUSE [" in text and "reason:" in text), text
        )
        self.assertTrue(any(name in text for name in receipts_of(root)), text)


# ---------------------------------------------------------------------------
# G: the cold route a weak model reads must be mechanical
# ---------------------------------------------------------------------------


class BootRouteTests(unittest.TestCase):
    """BOOT taught the old maze; a fixed engine behind it changes nothing."""

    @classmethod
    def setUpClass(cls):
        cls.text = BOOT.read_text(encoding="utf-8")

    def test_boot_names_start_as_the_route_for_a_new_actionable_task(self):
        self.assertIn("NEW ACTIONABLE USER INPUT", self.text)
        self.assertIn("saipen start", self.text)

    def test_the_three_entry_conditions_are_stated_as_a_closed_table(self):
        for marker in (
            "NEW ACTIONABLE USER INPUT",
            "NO NEW USER INPUT",
            "STATUS REQUEST",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.text)

    def test_the_preliminary_ritual_is_forbidden_by_name(self):
        entry = self.text[self.text.index("NEW ACTIONABLE USER INPUT") :][:1800]
        for ritual in ("status", "continue", "source", "recover", "seat"):
            with self.subTest(ritual=ritual):
                self.assertIn(ritual, entry)
        self.assertIn("NEW TASK -> START FIRST", self.text)

    def test_the_rule_is_short_enough_for_a_weak_model(self):
        start = self.text.index("NEW ACTIONABLE USER INPUT")
        block = self.text[start : self.text.index("\n\n", start)]
        self.assertLessEqual(len(block), 600, block)


# ---------------------------------------------------------------------------
# D: the REAL plugin, counting REAL Fleet prepare invocations
# ---------------------------------------------------------------------------


#: The plugin spawns `<skill>/tools/saipen.py`. This shim records every
#: invocation and then runs the REAL CLI, so the number of `fleet prepare`
#: spawns is MEASURED from the plugin's own behaviour rather than asserted
#: from Python-side reasoning about what the plugin ought to do.
_RECORDER = """import os, sys, runpy
sys.path.insert(0, {tools!r})
log = os.environ.get("SAIPEN_T1363_CALLS")
if log:
    try:
        with open(log, "a", encoding="utf-8") as handle:
            handle.write("\\t".join(sys.argv[1:]) + "\\n")
    except OSError:
        pass
runpy.run_path({real!r}, run_name="__main__")
"""


@unittest.skipUnless(NODE, "node runtime unavailable")
class PluginFleetRoutingTests(unittest.TestCase):
    """P0-1: the plugin obeys the canonical command effect, not a local list.

    The plugin and the Python mapper each owned a command taxonomy. Python
    said `status` is DIAGNOSTIC and needs no Fleet; the plugin ran Fleet
    prepare -- which can execute `saipen recover` -- for every verb except
    three it had hard-coded. That drift IS the live bug: a read probe paid the
    project's recovery debt, and a brand new user request was unreachable.
    """

    @classmethod
    def setUpClass(cls):
        from test_opencode_adapter import run_cases

        cls.run_cases = staticmethod(run_cases)
        cls.tmp = Path(tempfile.mkdtemp(prefix="t1363-plugin-"))
        cls.stage = cls.tmp / "skill"
        (cls.stage / "tools").mkdir(parents=True)
        (cls.stage / "tools" / "saipen.py").write_text(
            _RECORDER.format(real=str(CLI), tools=str(TOOLS)), encoding="utf-8"
        )

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _run(self, project_root: Path, command: str, tool: str = "bash") -> tuple[int, dict]:
        calls = self.tmp / f"calls-{abs(hash(command)) % 10**8}.log"
        if calls.exists():
            calls.unlink()
        args = {"command": command} if tool == "bash" else {"filePath": command}
        results = self.run_cases(
            PLUGIN,
            [
                {
                    "id": command,
                    "project": str(project_root),
                    "input": {"tool": tool, "sessionID": "ses_t1363"},
                    "output": {"args": args},
                    "env": {"SAIPEN_AGENT": "test-agent"},
                }
            ],
            self.tmp / "work",
            extra_env={
                "SAIPEN_SKILL_ROOT": str(self.stage),
                "SAIPEN_PYTHON": PYTHON,
                "SAIPEN_T1363_CALLS": str(calls),
            },
        )
        prepared = 0
        if calls.exists():
            for line in calls.read_text(encoding="utf-8").splitlines():
                fields = line.split("\t")
                if fields[:2] == ["fleet", "prepare"]:
                    prepared += 1
        return prepared, results[0]

    def test_diagnostics_and_ingress_never_run_fleet_prepare(self):
        root = healthy(self)
        for command in (
            "saipen status --json",
            "saipen validate --json",
            "saipen --help",
            "saipen recover",
            "saipen user-request 'add a CSV export button'",
            "saipen start 'add a CSV export button'",
        ):
            with self.subTest(command=command):
                prepared, result = self._run(root, command)
                self.assertEqual(
                    prepared, 0, f"{command} ran Fleet prepare {prepared}x: {result}"
                )

    def test_the_exemption_survives_unrelated_recovery_debt(self):
        root = corrupt_receipt_project(self)
        for command in ("saipen status --json", "saipen start 'a brand new task'"):
            with self.subTest(command=command):
                prepared, result = self._run(root, command)
                self.assertEqual(prepared, 0, f"{command}: {result}")

    def test_a_guard_refusal_names_the_command_it_refused(self):
        """T-1380: a refusal that does not say WHAT it refused reads identically
        for every effect one standing project state stops, so two different
        commands were measured as the same refusal repeating with nothing
        changed. Measured on the final matrix: three conditions."""
        root = healthy(self)  # nothing claimed -> the guard's NO_ACTIVE_WORK
        for command in ("echo one > a.txt", "echo two > b.txt"):
            with self.subTest(command=command):
                _prepared, result = self._run(root, command)
                message = str(result.get("message") or "")
                self.assertIn("SAIPEN_GUARD_REFUSAL", message, result)
                self.assertIn(f"attempted: {command}", message, result)

    def test_an_ordinary_execution_still_takes_the_fleet_path(self):
        root = healthy(self)
        prepared, result = self._run(root, "saipen checkpoint RUN build -> green")
        self.assertGreaterEqual(prepared, 1, result)
        prepared, result = self._run(root, str(root / "src" / "app.py"), tool="write")
        self.assertGreaterEqual(prepared, 1, result)

    def test_an_unquotable_ingress_line_is_refused_with_its_exact_transport(self):
        """The host refusal a weak model actually reads must carry the route.

        The model typed a task whose text no shell argument can carry. The
        guard computed the transport that does; if the thrown host error
        carries only a code, that computation never reaches the model and the
        session is back to guessing.
        """
        root = healthy(self)
        prepared, result = self._run(root, "saipen start 'fix the user's page'")
        self.assertEqual(prepared, 0, result)
        self.assertEqual(result["outcome"], "blocked", result)
        self.assertIn("INGRESS_TRANSPORT_UNSAFE", result["message"], result)
        self.assertIn("next: saipen start --hex ", result["message"], result)
        payload = result["message"].split("next: saipen start --hex ", 1)[1].strip()
        self.assertEqual(
            bytes.fromhex(payload.split()[0]).decode("utf-8"), "fix the user's page"
        )

    def test_a_field_fixture_is_a_worktree_before_a_model_sees_it(self):
        """A sandbox the host cannot see the edge of is not a sandbox.

        Measured: the field matrix ran its first pass against temporary
        directories that were not git worktrees. The host did not resolve them
        as projects, the model's shell reached THIS repository instead, and a
        free model minted real tickets and wrote a real file here. The fixture
        is a worktree now, and this control is what keeps it one.
        """
        import t1363_field_polygon as polygon

        if not shutil.which("git"):
            self.skipTest("git unavailable")
        built = polygon._git_worktree(healthy(self))
        self.assertTrue((built / ".git").exists(), built)

        # The control used to assert the literal call `_git_worktree(maker(holder))`
        # in the module's own source. The builder was refactored to
        # `build[name](holder)` and the string stopped matching, so a control
        # named for a sandbox boundary went red over a rename while the
        # boundary itself was intact. A control that pins a SPELLING measures
        # the spelling. This one asks the function what it builds: every
        # condition must come back a worktree, whatever the expression that
        # produced it looks like.
        one = next(iter(polygon.CONDITION_NAMES))
        maker = polygon.condition_builders()[one]

        class _Holder:
            def addCleanup(self, _fn):
                return None

        made = polygon._git_worktree(maker(_Holder()))
        self.assertTrue((made / ".git").exists(), made)
        shutil.rmtree(made, ignore_errors=True)

    def test_a_field_session_environment_agrees_with_its_directory(self):
        """`subprocess` sets cwd and leaves `PWD` -- that gap IS the escape.

        Measured after the worktree fix had NOT closed it: the child kept a
        `PWD` naming the repository the harness ran from, the model's shell
        believed it, and `saipen start` reached the repository's ledger while
        the fixture's own canonical files never changed. A sandbox is only a
        sandbox when the child's environment and its directory name the same
        project.
        """
        import t1363_field_polygon as polygon

        root = healthy(self)
        env = polygon._host_env(root)
        self.assertEqual(env.get("PWD"), str(root))
        for leaked in ("OLDPWD", "INIT_CWD", "SAIPEN_PROJECT_ROOT", "SAIPEN_SKILL_ROOT"):
            self.assertNotIn(leaked, env, leaked)

    def test_the_plugin_keeps_no_second_command_taxonomy(self):
        # Comments may still NAME the retired list -- that is the record of
        # why it went. Executable lines may not carry a verb rule.
        code = "\n".join(
            line
            for line in PLUGIN.read_text(encoding="utf-8").splitlines()
            if not line.lstrip().startswith("//")
        )
        self.assertIn("fleet_preflight", code)
        for taxonomy in (
            "isCanonicalRecoveryOrInspection",
            "ticket compact T-",
            'canonicalVerb === "recover"',
            'canonicalVerb === "ticket"',
        ):
            with self.subTest(taxonomy=taxonomy):
                self.assertNotIn(taxonomy, code)
        # The ONE command-shaped check left is the transport check no guard
        # event can make: a line that SPELLS a Fleet inspection the guard did
        # not parse as one.
        self.assertEqual(code.count("canonicalVerb"), 2, code.count("canonicalVerb"))


# ---------------------------------------------------------------------------
# H: the live transcript converges, and never asks the same question twice
# ---------------------------------------------------------------------------


class LiveTranscriptConvergenceTests(unittest.TestCase):
    """The field session, replayed: one entry, at most one question, work."""

    TASK = "fix the drag handler in the SAIPENVIEW window"

    def test_a_healthy_project_reaches_productive_work_in_one_command(self):
        root = healthy(self)
        rc, payload, text = cli(root, "start", self.TASK, "--json")
        self.assertEqual(rc, 0, text)
        self.assertEqual(payload.get("code"), "STARTED", text)
        self.assertTrue(payload.get("execution_instruction"), payload)

    def test_one_operator_decision_costs_exactly_one_question(self):
        root = valve_and_blocker_project(self)
        transcript = []

        _rc, first, text = cli(root, "start", self.TASK, "--json")
        transcript.append(("saipen start", first.get("code")))
        self.assertEqual(first.get("code"), "WAIT_OPERATOR", text)

        command = (first.get("decision") or {})["command"].replace(
            "<decision>", "operator cleared the gate"
        )
        rc, _answer, text = cli(root, *command.split(" ")[1:], "--json")
        transcript.append((command, rc))
        self.assertEqual(rc, 0, text)

        _rc, second, text = cli(root, "start", "--receipt", first["receipt"], "--json")
        transcript.append(("saipen start --receipt", second.get("code")))
        self.assertEqual(second.get("code"), "STARTED", f"{transcript}\n{text}")
        self.assertEqual(len(transcript), 3, transcript)

    def test_a_refusal_is_never_reproduced_by_the_command_it_names(self):
        for build in (
            valve_and_blocker_project,
            blocker_project,
            journal_conflict_project,
        ):
            with self.subTest(project=build.__name__):
                root = build(self)
                _rc, first, text = cli(root, "start", self.TASK, "--json")
                if first.get("ok"):
                    continue
                command = first.get("canonical_next_command") or (
                    first.get("decision") or {}
                ).get("command")
                self.assertTrue(command, first)
                named = (
                    command.replace("<decision>", "cleared")
                    .replace("<next-action>", "saipen continue")
                    .replace("<accept_live|replan>", "replan")
                )
                cli(root, *named.split(" ")[1:], "--json")
                _rc, second, text = cli(root, "start", self.TASK, "--json")
                self.assertNotEqual(
                    (second.get("code"), second.get("detail")),
                    (first.get("code"), first.get("detail")),
                    f"{command} reproduced its own refusal byte for byte: {text}",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)


