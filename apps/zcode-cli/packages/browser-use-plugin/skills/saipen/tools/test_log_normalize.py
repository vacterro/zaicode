"""T-1356: a LOG whose line syntax refuses the repair that would fix it.

Measured live on a bound project (`__SAITULS`, ticket T-170): five lines in
`.saipen/LOG.md` did not match `LOG_RE` -- three had lost their leading `- `
and two were free-text notes -- so `fast_check` put them on every mutation's
error list and SAIOPS refused before the journal was ever PREPARED. `saipen
recover` was admitted, returned a sanctioned plan, and applying it failed on
those same five lines and wrote zero bytes. No canonical verb rewrote a LOG
line, and a direct edit of `.saipen/LOG.md` is terminally refused by the guard
as `PROTECTED_CANONICAL_NAMESPACE`. Reads, globs and greps worked. Nothing else
did, and nothing ever would.

`saipen recover normalize-log` is the exit. It repairs SYNTAX and nothing else,
preserves the original bytes beside the journal, and refuses by name whenever
the repair is not provable -- because a repair for a corrupt ledger that
guesses at an event is worse than the deadlock.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.operations import normalize_log  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from test_hermetic_env import hermetic_env, isolate_host_session  # noqa: E402

HOME = TOOLS.parent


def setUpModule() -> None:
    isolate_host_session()


STATE = """---
phase: BUILD
task: T-1
next_action: "PHASE BUILD T-1"
blocker: ""
transition_from: SCOUT
saipen_version: 8
schema_version: 3
last_event: 1304
style_contract: ded-4ae736e4
saipen_home: "{home}"
mode: full
updated: 2026-09-16T00:00:00Z
agent: test-agent
---
"""
BOARD = (
    "## DOING\n- [/] T-1 [P1] normalize fixture | verify: the repair runs "
    "| owner: test-agent | claim_time: 2026-09-16T00:00:00Z\n"
    "## TODO\n## DONE\n## BLOCKED\n"
)
#: The five measured shapes, in the order the field report recorded them.
BROKEN_LOG = (
    "- 11.09.26 12:00 [E-1299] [T-1] [agent: test-agent] [op: ticket-fixture] "
    "DEC: ticket added via SAIOPS\n"
    "11.09.26 13:00 [E-1300] [agent: test-agent] RUN: lost its bullet\n"
    "11.09.26 13:01 [E-1301] [agent: test-agent] RUN: lost its bullet too\n"
    "11.09.26 13:02 [E-1302] [agent: test-agent] RUN: and again\n"
    "- 2026-09-11T10:20Z SAIPATCH pause checkpoint (st): free-text note\n"
    "11.09.26 12:11 [E-1303] [agent: test-agent] RUN: the last one\n"
    "- 11.09.26 14:00 [E-1304] [agent: test-agent] RUN: a legal line at the tail\n"
)


def project(base: Path, log: str = BROKEN_LOG) -> Path:
    root = base / "project"
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "STATE.md").write_text(STATE.format(home=HOME.as_posix()), encoding="utf-8")
    (saipen / "BOARD.md").write_text(BOARD, encoding="utf-8")
    (saipen / "LOG.md").write_text(log, encoding="utf-8")
    (saipen / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")
    return root


class NormalizeLogTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1356-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()

    def log_text(self, root: Path) -> str:
        return (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")

    def illegal_lines(self, root: Path) -> list[str]:
        from saipen_engine.log import parse_log_line

        return [
            line
            for line in self.log_text(root).splitlines()
            if line.strip() and not line.lstrip().startswith("#") and not parse_log_line(line)
        ]

    def test_the_fixture_really_is_the_deadlock(self) -> None:
        """Guard: five illegal lines, and an ordinary mutation refused."""
        root = project(self.base)
        self.assertEqual(len(self.illegal_lines(root)), 5, self.illegal_lines(root))
        from saipen_engine.operations import checkpoint

        blocked = checkpoint(root, "test-agent", "RUN", "T-1", "ordinary work")
        self.assertFalse(blocked.ok, "the fixture does not reproduce the deadlock")

    def test_the_repair_runs_from_the_state_that_needs_it(self) -> None:
        root = project(self.base)
        result = normalize_log(root, "test-agent")
        self.assertTrue(result.ok, getattr(result, "message", result))
        self.assertEqual(result.to_dict().get("code"), "LOG_NORMALIZED")
        self.assertEqual(self.illegal_lines(root), [])

    def test_ordinary_work_resumes_after_the_repair(self) -> None:
        """The whole point: the agent stops being an analyst."""
        root = project(self.base)
        self.assertTrue(normalize_log(root, "test-agent").ok)
        from saipen_engine.operations import checkpoint

        after = checkpoint(root, "test-agent", "RUN", "T-1", "ordinary work")
        self.assertTrue(after.ok, getattr(after, "message", after))

    def test_the_original_bytes_are_preserved(self) -> None:
        root = project(self.base)
        before = self.log_text(root)
        result = normalize_log(root, "test-agent")
        evidence = root / result.to_dict()["evidence_path"]
        self.assertTrue(evidence.is_file(), result.to_dict())
        self.assertEqual(evidence.read_text(encoding="utf-8"), before)

    def test_every_repaired_line_keeps_its_own_bytes(self) -> None:
        root = project(self.base)
        normalize_log(root, "test-agent")
        text = self.log_text(root)
        from saipen_engine.log import parse_log_line

        repaired = {
            parsed["event"]: parsed
            for parsed in (parse_log_line(line) for line in text.splitlines())
            if parsed
        }
        for event, message in (
            (1300, "lost its bullet"),
            (1301, "lost its bullet too"),
            (1302, "and again"),
            (1303, "the last one"),
        ):
            self.assertIn(event, repaired, f"E-{event} was lost by the repair")
            self.assertEqual(
                repaired[event]["text"],
                message,
                f"E-{event} kept its id but not its words",
            )
            self.assertEqual(repaired[event]["agent"], "test-agent")
        self.assertIn(
            "# - 2026-09-11T10:20Z SAIPATCH pause checkpoint",
            text,
            "the free-text note was not kept as a comment",
        )

    def test_a_line_carrying_an_event_id_is_never_guessed(self) -> None:
        """Its id is ledger identity; the rest cannot be invented."""
        broken = BROKEN_LOG + "- [E-1305] no taxonomy and no colon here\n"
        root = project(self.base, log=broken)
        result = normalize_log(root, "test-agent")
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.to_dict().get("code"), "CONFLICT")
        self.assertIn("E-1305", result.to_dict().get("message", ""))
        self.assertEqual(len(self.illegal_lines(root)), 6, "a refusal must write nothing")

    def test_the_repair_allocates_above_the_revealed_tail(self) -> None:
        """A hidden id reappears when its bullet does.

        A bulletless line is invisible to the parser, so its id does not count
        toward the tail. Allocating this repair's own DEC from that pre-repair
        tail collided with the id the repair had just restored, and the
        collision refused the repair -- the same deadlock, one line deep. The
        main fixture hid it because its highest id was already legal.
        """
        head = (
            "- 11.09.26 12:00 [E-1303] [T-1] [agent: test-agent] "
            "[op: ticket-fixture] DEC: ticket added via SAIOPS\n"
        )
        for label, broken in (
            ("bullet", "11.09.26 13:00 [E-1304] [agent: a] RUN: x\n"),
            ("indent", "   11.09.26 13:00 [E-1304] [agent: a] RUN: x\n"),
        ):
            with self.subTest(shape=label):
                root = project(self.base / label, log=head + broken)
                result = normalize_log(root, "test-agent")
                self.assertTrue(result.ok, result.to_dict())
                self.assertEqual(self.illegal_lines(root), [])

    def test_ledger_damage_that_is_not_line_syntax_still_refuses(self) -> None:
        """`allow_illegal_log` sees past ONE class, not past the contract."""
        head = (
            "- 11.09.26 12:00 [E-1303] [T-1] [agent: test-agent] "
            "[op: ticket-fixture] DEC: ticket added via SAIOPS\n"
        )
        for label, damage in (
            ("duplicate", "- 11.09.26 13:00 [E-1303] [agent: a] RUN: dup\n"),
            ("out-of-order", "- 11.09.26 13:00 [E-1302] [agent: a] RUN: older\n"),
            ("broken-parent", "- 11.09.26 13:00 [E-1304] [parent: E-9999] [agent: a] RUN: x\n"),
        ):
            with self.subTest(damage=label):
                root = project(self.base / label, log=head + damage)
                result = normalize_log(root, "test-agent")
                self.assertFalse(result.ok, result.to_dict())
                self.assertEqual(
                    result.to_dict().get("code"), "HISTORY_LEDGER_CORRUPT", result.to_dict()
                )

    def test_a_legal_log_refuses_rather_than_writing_a_no_op(self) -> None:
        legal = (
            "- 11.09.26 12:00 [E-1299] [T-1] [agent: test-agent] [op: ticket-fixture] "
            "DEC: ticket added via SAIOPS\n"
            "- 11.09.26 14:00 [E-1304] [agent: test-agent] RUN: legal\n"
        )
        root = project(self.base, log=legal)
        result = normalize_log(root, "test-agent")
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.to_dict().get("code"), "VALIDATION_FAILED")

    def test_the_canonical_command_reaches_it(self) -> None:
        """`saipen recover normalize-log` -- the route the guard admits."""
        root = project(self.base)
        completed = subprocess.run(
            [sys.executable, str(TOOLS / "saipen.py"), "--project-root", str(root),
             "recover", "normalize-log", "--json"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=hermetic_env(), timeout=600,
        )
        record = json.loads(completed.stdout)
        self.assertTrue(record.get("ok"), record)
        self.assertEqual(record.get("code"), "LOG_NORMALIZED")
        self.assertEqual(self.illegal_lines(root), [])

    def test_the_operator_can_see_why_and_then_fix_it(self) -> None:
        """The whole exit, both halves, through canonical verbs only.

        `saipen validate` (T-1357) answers WHAT is wrong from inside the
        session being refused, and `saipen recover normalize-log` (T-1356)
        repairs it. Before these existed the operator could read the project
        and nothing else, forever.
        """
        root = project(self.base)

        def canonical(*argv: str) -> dict:
            completed = subprocess.run(
                [sys.executable, str(TOOLS / "saipen.py"), "--project-root", str(root),
                 *argv, "--json"],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                env=hermetic_env(), timeout=600,
            )
            return json.loads(completed.stdout)

        why = canonical("validate")
        self.assertFalse(why.get("ok"), why)
        self.assertTrue(
            any("not a legal event line" in error for error in why.get("errors", [])),
            f"the operator cannot see the defect that is refusing them: {why}",
        )
        self.assertTrue(canonical("recover", "normalize-log").get("ok"))
        self.assertTrue(canonical("validate").get("ok"), canonical("validate"))

    def test_the_command_takes_no_other_argument(self) -> None:
        root = project(self.base)
        completed = subprocess.run(
            [sys.executable, str(TOOLS / "saipen.py"), "--project-root", str(root),
             "recover", "normalize-log", "--migrate-generation", "--json"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=hermetic_env(), timeout=600,
        )
        record = json.loads(completed.stdout)
        self.assertFalse(record.get("ok"), record)
        self.assertEqual(len(self.illegal_lines(root)), 5, "a refusal must write nothing")


if __name__ == "__main__":
    unittest.main(verbosity=2)
