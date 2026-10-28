"""T-1377: a refusal that changes nothing about the next attempt is a loop.

Measured live on 2026-09-17, installed generation f3d2104a, the nine-condition
field matrix: four of nine sessions repeated an identical refusal with nothing
changed. Read back from OpenCode's own session store, the payloads say why.

    REFUSE [ILLEGAL_TRANSITION] reason: SCOUT -> VERIFY is not a legal edge
    REFUSE [ILLEGAL_TRANSITION] reason: BUILD -> REVIEW is not a legal edge
    "VERIFY -> REVIEW requires explicit verification evidence for ticket T-1
     (got: unproven/failed)"                                    -- twice
    "--paths is only valid with closure_mode cohort, not own_patch"
    "checkpoint ticket_id 'T-8301 build -> src/app.py: added ...' is not a
     valid T-### ref (expected T-<digits>)"
    SAIPEN_GUARD_REFUSAL: WAIT_BLOCKED: the saipen guard refused tool 'bash';
     the host tool did not execute                              -- twice

Every one names the rule. Not one names the move. SRC-051 §11 forbids "the same
refusal repeating with nothing changed", and a weak model handed a rule and no
command has nowhere to go but repetition -- this repository's own agent hit the
verification-evidence sentence twice in one session while writing T-1372.

These controls pin the exact command each refusal now carries, and two of them
RUN it: a route that is not executable is prose with a colon in it.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import guard_events  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import cli, healthy  # noqa: E402

TASK = "add a one-line docstring to the top of src/app.py"


def setUpModule() -> None:
    isolate_host_session()


def started(case: unittest.TestCase) -> Path:
    root = healthy(case)
    code, payload, text = cli(root, "start", TASK, "--json")
    case.assertEqual(code, 0, text)
    case.assertEqual(payload["code"], "STARTED", text)
    return root


def shell_event(command: str, cwd: Path) -> dict:
    return {
        "event": "PreToolUse",
        "host": "opencode",
        "tool_name": "bash",
        "tool_input": {"command": command},
        "cwd": str(cwd),
        "actor": "test-agent",
    }


class IllegalTransitionNamesTheLegalEdgeTests(unittest.TestCase):
    """`already_done` asked for two illegal edges and was told neither answer."""

    def test_the_refusal_carries_the_edge_that_leaves_this_phase(self):
        root = started(self)
        code, payload, text = cli(root, "transition", "VERIFY", "T-1", "skip ahead", "--json")
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], "ILLEGAL_TRANSITION")
        self.assertEqual(payload["legal_destinations"], ["BUILD", "BLOCKED"])
        self.assertEqual(payload["canonical_next_command"], "saipen transition BUILD T-1 '<why>'")
        self.assertIn("from SCOUT the legal edges are BUILD, BLOCKED", payload["detail"])

    def test_the_route_is_executable_not_prose(self):
        """Run exactly what the refusal printed; the project must move."""
        root = started(self)
        _code, payload, _text = cli(root, "transition", "VERIFY", "T-1", "skip ahead", "--json")
        route = payload["canonical_next_command"]
        self.assertTrue(route.startswith("saipen transition BUILD T-1 "), route)
        code, moved, text = cli(root, "transition", "BUILD", "T-1", "scout done", "--json")
        self.assertEqual(code, 0, text)
        self.assertEqual(moved["phase"], "BUILD", text)


class VerificationEvidenceNamesItsShapeTests(unittest.TestCase):
    """The gate wants a SHAPE; printing the rule made a session ask twice."""

    def reach_verify(self) -> Path:
        root = started(self)
        for args in (
            ("transition", "BUILD", "T-1", "scout done", "--json"),
            ("checkpoint", "RUN", "T-1", "build -> added the docstring", "--json"),
            ("transition", "VERIFY", "T-1", "build done", "--json"),
        ):
            code, _payload, text = cli(root, *args)
            self.assertEqual(code, 0, text)
        return root

    def test_the_transition_refusal_prints_the_checkpoint_that_satisfies_it(self):
        root = self.reach_verify()
        code, payload, text = cli(root, "transition", "REVIEW", "T-1", "done i think", "--json")
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], "INCOMPLETE_TICKET")
        route = payload["canonical_next_command"]
        self.assertIn("saipen checkpoint RUN T-1", route)
        self.assertIn("verify -> PASS [target: T-1]", route)
        self.assertIn("conf: high", route)

    def test_running_that_shape_opens_the_gate(self):
        root = self.reach_verify()
        _code, payload, _text = cli(root, "transition", "REVIEW", "T-1", "done i think", "--json")
        self.assertIn("conf: high", payload["canonical_next_command"])
        code, _payload, text = cli(
            root,
            "checkpoint",
            "RUN",
            "T-1",
            "verify -> PASS [target: T-1] conf: high -- python -m compileall src/app.py",
            "--json",
        )
        self.assertEqual(code, 0, text)
        code, moved, text = cli(root, "transition", "REVIEW", "T-1", "verify green", "--json")
        self.assertEqual(code, 0, text)
        self.assertEqual(moved["phase"], "REVIEW", text)

    def test_the_finish_refusal_prints_the_same_shape(self):
        root = self.reach_verify()
        code, payload, text = cli(
            root, "ticket", "done", "T-1", "--closure-mode", "own_patch", "--json"
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], "INCOMPLETE_TICKET")
        self.assertIn("verify -> PASS [target: T-1]", payload["canonical_next_command"])


class MalformedCommandsPrintTheCorrectedOneTests(unittest.TestCase):
    """Two argument mistakes the field made, each one deletion from correct."""

    def test_the_checkpoint_ticket_ref_prints_the_form(self):
        root = started(self)
        code, payload, text = cli(
            root, "checkpoint", "RUN", "T-1 build -> did the thing", "--json"
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], "VALIDATION_FAILED")
        self.assertEqual(
            payload["canonical_next_command"],
            'saipen checkpoint RUN <T-###> "<what happened>"',
        )
        self.assertIn("the ticket comes BEFORE the text", payload["detail"])

    def test_paths_with_own_patch_prints_the_command_without_it(self):
        root = started(self)
        code, payload, text = cli(
            root,
            "ticket",
            "done",
            "T-1",
            "--closure-mode",
            "own_patch",
            "--paths",
            "src/app.py",
            "--json",
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], "VALIDATION_FAILED")
        self.assertEqual(
            payload["canonical_next_command"],
            "saipen ticket done T-1 --closure-mode own_patch",
        )


class BlockedProjectNamesItsExitTests(unittest.TestCase):
    """WAIT_BLOCKED refused a tool and said nothing about why or what next."""

    def blocked(self, **fields) -> Path:
        root = healthy(self)
        state = root / ".saipen" / "STATE.md"
        text = state.read_text(encoding="utf-8")
        for key, value in fields.items():
            text = text.replace(f'{key}: ""', f'{key}: "{value}"')
        state.write_text(text, encoding="utf-8")
        return root

    def test_an_operator_blocker_names_the_command_that_resolves_it(self):
        root = self.blocked(blocker="BLOCKED_EXTERNAL -- upstream API contract unconfirmed")
        verdict = guard_events.evaluate_event(
            shell_event("echo hi > note.txt", root), project_root=str(root)
        )
        self.assertFalse(verdict["admitted"])
        self.assertEqual(verdict["code"], "WAIT_BLOCKED")
        self.assertEqual(
            verdict["canonical_next_command"], "saipen recover resolve-blocker <decision>"
        )
        self.assertIn("BLOCKED_EXTERNAL", verdict["detail"])

    def test_a_read_is_still_admitted_in_a_blocked_project(self):
        """A project that cannot be looked at cannot be diagnosed."""
        root = self.blocked(blocker="BLOCKED_EXTERNAL -- upstream API contract unconfirmed")
        verdict = guard_events.evaluate_event(
            shell_event("git status", root), project_root=str(root)
        )
        self.assertTrue(verdict["admitted"], verdict)


class TheSecondWaveOfRepeatsTests(unittest.TestCase):
    """What the first re-run exposed once the first five classes had routes."""

    def test_ship_in_a_project_without_a_version_names_the_closing_command(self):
        """Three sessions reached for `ship` to finish ordinary Work."""
        root = started(self)
        code, payload, text = cli(root, "ship", "--json")
        self.assertNotEqual(code, 0, text)
        blob = text + str(payload)
        self.assertIn("saipen ticket done <T-###> --closure-mode own_patch", blob)
        self.assertIn("does not apply to a project without one", blob)

    def test_a_surplus_argument_prints_the_command_without_it(self):
        root = started(self)
        code, payload, text = cli(root, "validate", "--gate", "core", "--json")
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["canonical_next_command"], "saipen validate")

    def test_no_active_work_names_the_entry_command(self):
        root = healthy(self)  # nothing claimed: the guard's own NO_ACTIVE_WORK
        verdict = guard_events.evaluate_event(
            shell_event("echo hi > note.txt", root), project_root=str(root)
        )
        self.assertFalse(verdict["admitted"], verdict)
        self.assertEqual(verdict["code"], "NO_ACTIVE_WORK")
        self.assertEqual(
            verdict["canonical_next_command"], "saipen start '<the task, one line>'"
        )


class TheThirdWaveOfRepeatsTests(unittest.TestCase):
    """What the live re-runs exposed once the earlier classes had routes."""

    def test_ship_carries_its_route_in_the_machine_field(self):
        """Measured: a session ran `saipen ship` twice in a project with no
        VERSION. The sentence named the right command and the machine field did
        not, so nothing a host reads could act on it. The machine field names
        the ticket the project is working on: `<T-###>` typed into PowerShell is
        a redirection error, not a command."""
        root = started(self)
        code, payload, text = cli(root, "ship", "--json")
        self.assertNotEqual(code, 0, text)
        self.assertEqual(
            payload["canonical_next_command"],
            "saipen ticket done T-1 --closure-mode own_patch",
        )

    def test_finishing_before_ship_names_the_transition(self):
        """Measured: a session in REVIEW ran `ticket done` twice."""
        root = started(self)
        for args in (
            ("transition", "BUILD", "T-1", "scout done", "--json"),
            ("checkpoint", "RUN", "T-1", "build -> added it", "--json"),
            ("transition", "VERIFY", "T-1", "build done", "--json"),
            (
                "checkpoint",
                "RUN",
                "T-1",
                "verify -> PASS [target: T-1] conf: high -- python -m compileall src/app.py",
                "--json",
            ),
            ("transition", "REVIEW", "T-1", "verify green", "--json"),
        ):
            code, _payload, text = cli(root, *args)
            self.assertEqual(code, 0, text)

        code, payload, text = cli(
            root, "ticket", "done", "T-1", "--closure-mode", "own_patch", "--json"
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], "ILLEGAL_PHASE")
        self.assertEqual(payload["canonical_next_command"], "saipen transition SHIP T-1 '<why>'")

        # Run exactly what it printed, then the close it was blocking.
        code, moved, text = cli(root, "transition", "SHIP", "T-1", "review passed", "--json")
        self.assertEqual(code, 0, text)
        self.assertEqual(moved["phase"], "SHIP")
        code, done, text = cli(
            root, "ticket", "done", "T-1", "--closure-mode", "own_patch", "--json"
        )
        self.assertEqual(code, 0, text)
        self.assertEqual(done["code"], "FINISHED", text)


PASS_EVIDENCE = "verify -> PASS [target: T-1] conf: high -- python -m compileall src/app.py"


class EveryRouteRunsFromTheStateThatPrintedItTests(unittest.TestCase):
    """A printed route is a command the session can run FROM HERE, and it moves.

    Measured by running rather than reading (T-1380, E-6940): four routes in the
    finish, transition and ship family classified as canonical literals and
    failed the moment they were typed from the state that printed them --

    * ILLEGAL_PHASE from BUILD (REVIEW had sent the ticket back) printed
      `transition REVIEW`, and BUILD -> REVIEW is not an edge;
    * finish from BUILD answered "no current-cycle VERIFY boundary" with the
      PASS checkpoint, which RUNS and leaves the refusal byte-identical;
    * ILLEGAL_TRANSITION in a project with no Work printed the STATE.task
      literal `none` as the ticket, and the guard refused the line;
    * ship with no active ticket printed `<T-###>` with nothing to resolve it.

    The harvest control in test_canonical_command_reachability classifies each
    literal and never types one, so it passed all four. A route that carries
    free text (`'<why>'`, `"<what happened>"`) is not a canonical grammar line
    and never was -- T-1357 keeps quotes out of that grammar on purpose -- so
    the proof for those is the guard admitting the typed line in the state
    that printed it, which always holds the caller's own claim. A route printed
    where no Work exists must be admitted there too, which only the canonical
    grammar can do.
    """

    def typed(self, route: str, why: str) -> str:
        """The line a session types: every placeholder filled, nothing else changed."""
        return (
            route.replace("<why>", why)
            .replace("<the task, one line>", TASK)
        )

    def run_route(self, root: Path, route: str, why: str = "review fix is in") -> dict:
        """Guard first, then the CLI -- exactly the path a host session takes."""
        import shlex

        line = self.typed(route, why)
        self.assertNotIn("<", line, f"unresolved placeholder in {route!r}")
        verdict = guard_events.evaluate_event(shell_event(line, root), project_root=str(root))
        self.assertTrue(
            verdict["admitted"],
            f"the guard refuses the route {line!r} in the state that printed it: {verdict}",
        )
        argv = shlex.split(line)
        self.assertEqual(argv[0], "saipen", line)
        code, payload, text = cli(root, *argv[1:], "--json")
        self.assertEqual(code, 0, f"{line!r} did not run: {text}")
        return payload

    def reach(self, root: Path, *steps: tuple) -> None:
        for args in steps:
            code, _payload, text = cli(root, *args, "--json")
            self.assertEqual(code, 0, text)

    def finish(self, root: Path) -> dict:
        code, payload, text = cli(
            root, "ticket", "done", "T-1", "--closure-mode", "own_patch", "--json"
        )
        self.assertNotEqual(code, 0, text)
        return payload

    def test_illegal_phase_names_the_edge_that_leaves_the_phase_it_is_in(self):
        root = started(self)
        self.reach(
            root,
            ("transition", "BUILD", "T-1", "scout done"),
            ("checkpoint", "RUN", "T-1", "build -> added it"),
            ("transition", "VERIFY", "T-1", "build done"),
            ("checkpoint", "RUN", "T-1", PASS_EVIDENCE),
            ("transition", "REVIEW", "T-1", "verify green"),
            ("transition", "BUILD", "T-1", "review wants the wording fixed"),
            ("checkpoint", "RUN", "T-1", "build -> reworded the docstring"),
        )
        refused = self.finish(root)
        self.assertEqual(refused["code"], "ILLEGAL_PHASE", refused)
        self.assertEqual(
            refused["canonical_next_command"], "saipen transition VERIFY T-1 '<why>'"
        )
        moved = self.run_route(root, refused["canonical_next_command"])
        self.assertEqual(moved["phase"], "VERIFY", moved)

    def test_a_finish_with_no_verify_boundary_routes_to_the_edge_not_the_checkpoint(self):
        """The checkpoint cannot open this gate: evidence counts only after a
        VERIFY boundary, and BUILD has none. Printing it guaranteed a repeat."""
        root = started(self)
        self.reach(root, ("transition", "BUILD", "T-1", "scout done"))
        refused = self.finish(root)
        self.assertEqual(refused["code"], "INCOMPLETE_TICKET", refused)
        self.assertIn("no current-cycle VERIFY boundary", refused["detail"])
        self.assertEqual(
            refused["canonical_next_command"], "saipen transition VERIFY T-1 '<why>'"
        )
        moved = self.run_route(root, refused["canonical_next_command"], why="build done")
        self.assertEqual(moved["phase"], "VERIFY", moved)

        again = self.finish(root)
        self.assertNotEqual(
            (again["code"], again["detail"]),
            (refused["code"], refused["detail"]),
            "running the printed route left the refusal byte-identical",
        )
        # Inside the VERIFY cycle the missing thing IS the evidence shape.
        self.assertIn("verify -> PASS [target: T-1]", again["canonical_next_command"])

    def test_the_same_refusal_from_scout_names_the_edge_out_of_scout(self):
        root = started(self)
        refused = self.finish(root)
        self.assertEqual(refused["code"], "INCOMPLETE_TICKET", refused)
        self.assertEqual(
            refused["canonical_next_command"], "saipen transition BUILD T-1 '<why>'"
        )
        moved = self.run_route(root, refused["canonical_next_command"], why="scout done")
        self.assertEqual(moved["phase"], "BUILD", moved)

    def test_an_illegal_transition_with_no_work_names_the_entry_command(self):
        root = healthy(self)  # phase DONE, task none, nothing claimed
        code, refused, text = cli(root, "transition", "VERIFY", "--json")
        self.assertNotEqual(code, 0, text)
        self.assertEqual(refused["code"], "ILLEGAL_TRANSITION", refused)
        route = refused["canonical_next_command"]
        self.assertNotIn("none", route)
        self.assertEqual(route, "saipen start '<the task, one line>'")
        started_payload = self.run_route(root, route)
        self.assertEqual(started_payload["code"], "STARTED", started_payload)

    def test_ship_with_no_active_ticket_prints_no_route_it_cannot_resolve(self):
        root = healthy(self)
        code, refused, text = cli(root, "ship", "--json")
        self.assertNotEqual(code, 0, text)
        self.assertIsNone(refused["canonical_next_command"], refused)
        self.assertIn("does not apply to a project without one", refused["detail"])

    def test_ship_names_the_active_ticket_and_that_close_runs_from_ship(self):
        root = started(self)
        self.reach(
            root,
            ("transition", "BUILD", "T-1", "scout done"),
            ("checkpoint", "RUN", "T-1", "build -> added it"),
            ("transition", "VERIFY", "T-1", "build done"),
            ("checkpoint", "RUN", "T-1", PASS_EVIDENCE),
            ("transition", "REVIEW", "T-1", "verify green"),
            ("transition", "SHIP", "T-1", "review passed"),
        )
        code, refused, text = cli(root, "ship", "--json")
        self.assertNotEqual(code, 0, text)
        route = refused["canonical_next_command"]
        self.assertEqual(route, "saipen ticket done T-1 --closure-mode own_patch")
        done = self.run_route(root, route)
        self.assertEqual(done["code"], "FINISHED", done)


class RefusalIdentityIsNotACodeBucketTests(unittest.TestCase):
    """The harness half: two different problems are not one repeated refusal."""

    @staticmethod
    def tool(command: str, output: str) -> dict:
        return {
            "tool": "bash",
            "status": "completed",
            "input": {"command": command},
            "output": output,
            "error": "",
        }

    def test_two_different_validation_errors_are_not_a_repeat(self):
        import t1363_field_polygon as polygon

        seen = polygon.measure(
            [
                self.tool("saipen ship --json", '{"ok": false, "code": "VALIDATION_FAILED",'
                          ' "detail": "VERSION is missing"}'),
                self.tool("saipen validate --gate core", '{"ok": false, "code":'
                          ' "VALIDATION_FAILED", "detail": "validate accepts no arguments"}'),
            ],
            measured=True,
        )
        self.assertEqual(seen["refusal_sequence"], ["VALIDATION_FAILED", "VALIDATION_FAILED"])
        self.assertEqual(seen["repeated_refusal"], [])

    def test_the_same_refusal_twice_is_a_repeat(self):
        import t1363_field_polygon as polygon

        payload = '{"ok": false, "code": "VALIDATION_FAILED", "detail": "VERSION is missing"}'
        seen = polygon.measure(
            [self.tool("saipen ship --json", payload), self.tool("saipen ship --json", payload)],
            measured=True,
        )
        self.assertEqual(seen["repeated_refusal"], ["VALIDATION_FAILED"])

    def test_a_refusal_the_session_only_read_about_is_not_one_it_received(self):
        """Measured: three sessions grepped this repository and the harness
        scored the `REFUSE [CODE]` in a docstring as a refusal they got."""
        import t1363_field_polygon as polygon

        seen = polygon.measure(
            [
                self.tool(
                    'Get-Content tools/test_t1363_zero_manual_entry.py',
                    "* human-mode refusals printed `REFUSE [CODE]` and nothing else",
                )
            ],
            measured=True,
        )
        self.assertEqual(seen["refusal_sequence"], [])

    def test_the_guard_marker_counts_whatever_the_command_was(self):
        """The host's own shape for a before-tool refusal: status error, the
        marker in the error text, nothing executed."""
        import t1363_field_polygon as polygon

        refused = {
            "tool": "bash",
            "status": "error",
            "input": {"command": "echo hi > note.txt"},
            "output": "",
            "error": "SAIPEN_GUARD_REFUSAL: WAIT_BLOCKED: the saipen guard refused tool 'bash'",
        }
        seen = polygon.measure([refused], measured=True)
        self.assertEqual(seen["refusal_sequence"], ["WAIT_BLOCKED"])

    def test_a_guard_marker_in_what_a_tool_read_is_not_a_refusal(self):
        """Measured on the T-1380 re-run: `operator_decision` grepped this
        repository for the marker, the completed grep listed source lines that
        carry it, and the harness scored three PROTOCOL_STATE_INVALID -- one
        'repeated' -- that the session never received."""
        import t1363_field_polygon as polygon

        grep = {
            "tool": "grep",
            "status": "completed",
            "input": {"pattern": "WAIT_BLOCKED|guard refused|SAIPEN_GUARD_REFUSAL"},
            "output": (
                "Found 100 matches\n"
                "V:\\repo\\tools\\test_opencode_adapter.py:\n"
                "  Line 412: \"SAIPEN_GUARD_REFUSAL: PROTOCOL_STATE_INVALID: \",\n"
                "  Line 413: \"SAIPEN_GUARD_REFUSAL: PROTOCOL_STATE_INVALID: \",\n"
                "  Line 530: `SAIPEN_GUARD_REFUSAL: PLUGIN_RESTART_REQUIRED: loaded build`\n"
            ),
            "error": "",
        }
        seen = polygon.measure([grep, grep], measured=True)
        self.assertEqual(seen["refusal_sequence"], [])
        self.assertEqual(seen["repeated_refusal"], [])


if __name__ == "__main__":
    unittest.main()
