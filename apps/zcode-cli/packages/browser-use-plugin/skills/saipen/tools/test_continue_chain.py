"""Bounded autonomous `cc` executor: one invocation, many canonical steps (T-1416).

THE INCIDENT THIS ORACLE IS BUILT FROM
--------------------------------------
`saipen continue` resolved ONE next action and returned it, so every
deterministic step between two model decisions came back to the operator as
another "continue" prompt -- measured on ticket closures whose gates were
already green, the parent resume a closure restores, and the next route
behind it. The operator drove a loop the protocol already owned.

This oracle pins the bounded executor:

* one `cc` drives an anchored deterministic chain -- finish the reviewed
  ticket at SHIP, let the closure restore its parked parent, finish that one
  too -- and stops only at the next real boundary;
* each iteration re-routes on CURRENT bytes and journals its own canonical
  operation; a machine-readable trace is returned;
* a hard budget stops with CONTINUE_BUDGET_EXHAUSTED (iterations, last
  operation, canonical next action);
* an executed step that leaves state and BOARD byte-identical is a
  deterministic fixed point (CONTINUE_FIXED_POINT), never a burnt budget;
* `--dry-run` projects the chain and writes nothing.

Run standalone:
    python tools/test_continue_chain.py
"""

from __future__ import annotations

import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.board import parse_board  # noqa: E402
from saipen_engine.journal import ensure_project_lineage  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    apply_claim,
    checkpoint,
    ticket_add,
    ticket_move,
    transition_phase,
)
from saipen_engine.paths import PROJECT_BINDING_ENV  # noqa: E402
from saipen_engine.state import parse_state  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"
AGENT = "tester"
#: T-1442: the engine's one list of binding carriers plus the seat, not a
#: remembered one -- SAIPEN_HOST_SESSION was missing, and inside a live host
#: session a fixture's resumed parent read as claimed.
ENV_KEYS = (
    *(name for name in PROJECT_BINDING_ENV if name.startswith("SAIPEN_")),
    "SAIPEN_AGENT",
)


def setUpModule() -> None:
    # T-1442: the in-process operations read the host-session carrier too, so
    # the whole module runs without the operator's session.
    isolate_host_session()


def _cli(project: Path, *args: str) -> tuple[int, dict]:
    env = {key: value for key, value in os.environ.items() if key not in ENV_KEYS}
    run = subprocess.run(
        [
            sys.executable,
            str(SAIPEN_PY),
            "--project-root",
            str(project),
            "--agent",
            AGENT,
            "--json",
            *args,
        ],
        cwd=str(project),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=300,
        env=env,
    )
    blob = (run.stdout or "") + (run.stderr or "")
    try:
        return run.returncode, json.loads(blob)
    except json.JSONDecodeError:
        return run.returncode, {"ok": False, "code": "CLI_CRASH", "detail": blob[-800:]}


def _board(project: Path) -> dict:
    return parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))


def _state(project: Path) -> dict:
    return parse_state((project / ".saipen" / "STATE.md").read_text(encoding="utf-8"))


class ContinueChainTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = {key: os.environ.pop(key, None) for key in ENV_KEYS}
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        for key, value in self._saved_env.items():
            if value is not None:
                os.environ[key] = value

    def _advance_to_ship(self, project: Path, ticket: str) -> None:
        """SCOUT -> SHIP through the canonical gates, evidence included."""
        notes = (
            ("BUILD", "RUN", f"build -> fixture work for {ticket}"),
            (
                "VERIFY",
                "RUN",
                f"verify -> PASS [target: {ticket}] conf: high -- fixture oracle ran and passed",
            ),
            ("REVIEW", "DEC", f"DEC: SHIP -- independent fixture review for {ticket}"),
        )
        for phase, taxonomy, text in notes:
            moved = transition_phase(project, phase, AGENT, ticket, f"fixture {phase}")
            self.assertTrue(moved.ok, moved.to_dict())
            logged = checkpoint(project, AGENT, taxonomy, ticket, text)
            self.assertTrue(logged.ok, logged.to_dict())
        shipped = transition_phase(project, "SHIP", AGENT, ticket, "fixture SHIP")
        self.assertTrue(shipped.ok, shipped.to_dict())

    def _make_project(self) -> Path:
        base = tempfile.mkdtemp(prefix="saipen-continue-chain-")
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = Path(base) / "project"
        (project / ".saipen").mkdir(parents=True)
        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        (project / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: DONE\n"
            "task: none\n"
            'next_action: "saipen continue"\n'
            'blocker: ""\n'
            "transition_from: SHIP\n"
            "saipen_version: 8\n"
            "schema_version: 3\n"
            "last_event: 1\n"
            "style_contract: ded-4ae736e4\n"
            f'agent: "{AGENT}"\n'
            "requires:\n  - filesystem\n  - python\n"
            "mode: full\n"
            f'updated: "{now}"\n'
            "execution_intent: converge\n"
            "converge_target: done\n"
            "---\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "BOARD.md").write_text(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "LOG.md").write_text(
            f"- 19.09.26 00:00 [E-001] [agent: {AGENT}] DEC: fixture\n",
            encoding="utf-8",
        )
        (project / "VERSION").write_text("8.0.1\n", encoding="utf-8")
        ensure_project_lineage(project)
        return project

    def _chain_project(self) -> Path:
        """Parent parked FOR the child; both end up finishable in one cc."""
        project = self._make_project()
        parent = ticket_add(
            project, AGENT, "P1", "reviewed parent at SHIP", [], "the reviewed parent closes"
        )
        child = ticket_add(
            project, AGENT, "P1", "child the parent will wait for", [], "the child closes first"
        )
        self.assertTrue(parent.ok, parent.to_dict())
        self.assertTrue(child.ok, child.to_dict())
        parent_id = parent.data["ticket"]
        child_id = child.data["ticket"]
        claimed = apply_claim(project, parent_id, AGENT, explicit=True)
        self.assertTrue(claimed.ok, claimed.to_dict())
        self._advance_to_ship(project, parent_id)
        parked = ticket_move(
            project,
            "block-for",
            parent_id,
            AGENT,
            "parent reviewed and parked for the child; it resumes at SHIP",
            blocked_on=child_id,
        )
        self.assertTrue(parked.ok, parked.to_dict())
        claimed = apply_claim(project, child_id, AGENT)
        self.assertTrue(claimed.ok, claimed.to_dict())
        self._advance_to_ship(project, child_id)
        state = _state(project)
        self.assertEqual(state.get("phase"), "SHIP", state)
        self.assertEqual(state.get("task"), child_id, state)
        self.parent_id = parent_id
        self.child_id = child_id
        return project

    def test_one_cc_drives_the_deterministic_chain_to_the_boundary(self) -> None:
        project = self._chain_project()
        rc, result = _cli(project, "cc")
        self.assertEqual(rc, 0, result)
        tickets = _board(project)["tickets"]
        self.assertEqual(tickets[self.child_id]["section"], "## DONE", tickets[self.child_id])
        self.assertEqual(tickets[self.parent_id]["section"], "## DONE", tickets[self.parent_id])
        self.assertGreaterEqual(result.get("iterations", 0), 2, result)
        trace = result.get("continue_trace") or []
        # T-1436: the dependency resume restores the parent WITHOUT a
        # synthesized live claim, so the deterministic chain adds the router's
        # own adoption step (`saipen claim`) before the parent can finish. The
        # T-1416 contract -- one cc drives the chain to the boundary with no
        # operator message -- is unchanged.
        self.assertEqual(
            [row["operation"] for row in trace],
            ["ticket_done", "claim", "ticket_done"],
            trace,
        )
        self.assertEqual(trace[0]["ticket"], self.child_id, trace)
        self.assertEqual(trace[1]["ticket"], self.parent_id, trace)
        self.assertEqual(trace[2]["ticket"], self.parent_id, trace)
        self.assertEqual(trace[1]["kind"], "adopt", trace)
        self.assertTrue(trace[1]["ok"], trace)
        self.assertNotEqual(trace[0]["before_last_event"], trace[0]["after_last_event"], trace)
        # The loop stopped at the real boundary: idle-maintain, whose single
        # existing fallthrough owns improvement discovery.
        self.assertEqual(result.get("code"), "IMPROVE_AUDIT_ASSIGNMENT", result)

    def test_trace_is_machine_readable_and_bounded(self) -> None:
        project = self._chain_project()
        _rc, result = _cli(project, "cc")
        for row in result.get("continue_trace") or []:
            for key in (
                "iteration",
                "action",
                "kind",
                "operation",
                "result",
                "ok",
                "before_last_event",
                "after_last_event",
            ):
                self.assertIn(key, row, row)

    def test_budget_exhaustion_is_classified_not_silent(self) -> None:
        project = self._chain_project()
        env = {key: value for key, value in os.environ.items() if key not in ENV_KEYS}
        env["SAIPEN_CONTINUE_MAX_ITERATIONS"] = "1"
        run = subprocess.run(
            [
                sys.executable,
                str(SAIPEN_PY),
                "--project-root",
                str(project),
                "--agent",
                AGENT,
                "--json",
                "cc",
            ],
            cwd=str(project),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=300,
            env=env,
        )
        payload = json.loads(run.stdout)
        self.assertEqual(payload.get("code"), "CONTINUE_BUDGET_EXHAUSTED", payload)
        self.assertEqual(payload.get("iterations"), 1, payload)
        self.assertEqual(payload.get("last_operation"), "ticket_done", payload)
        self.assertTrue(payload.get("canonical_next_action"), payload)
        tickets = _board(project)["tickets"]
        self.assertEqual(tickets[self.child_id]["section"], "## DONE", tickets[self.child_id])
        self.assertEqual(tickets[self.parent_id]["section"], "## DOING", tickets[self.parent_id])

    def test_fixed_point_stops_bounded(self) -> None:
        project = self._chain_project()
        from saipen_engine.result import Result

        saved = dict(os.environ)
        try:
            for key in ENV_KEYS:
                os.environ.pop(key, None)
            with mock.patch(
                "saipen_engine.operations.finish_ticket", return_value=Result(True, "FINISHED")
            ):
                import saipen as CLI

                import io
                from contextlib import redirect_stdout

                out = io.StringIO()
                with redirect_stdout(out):
                    rc = CLI.main(["cc", "--project-root", str(project), "--json"])
        finally:
            os.environ.clear()
            os.environ.update(saved)
        self.assertEqual(rc, 0)
        payload = json.loads(out.getvalue().strip())
        self.assertEqual(payload.get("code"), "CONTINUE_FIXED_POINT", payload)
        self.assertEqual(payload.get("stop_reason"), "fixed-point", payload)

    def test_dry_run_projects_the_chain_and_writes_nothing(self) -> None:
        project = self._chain_project()
        before_state = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        before_board = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        rc, result = _cli(project, "cc", "--dry-run")
        self.assertEqual(rc, 0, result)
        self.assertEqual(result.get("action"), f"PHASE SHIP {self.child_id}", result)
        steps = result.get("projected_steps") or []
        self.assertTrue(steps, result)
        self.assertIn(f"ticket done {self.child_id}", steps[0]["action"], steps)
        self.assertTrue(result.get("projection_ends_at"), result)
        self.assertEqual(
            before_state, (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        )
        self.assertEqual(
            before_board, (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        )

    def test_next_stays_a_pure_projection(self) -> None:
        project = self._chain_project()
        rc, result = _cli(project, "next")
        self.assertEqual(rc, 0, result)
        self.assertNotIn("continue_trace", result)
        tickets = _board(project)["tickets"]
        self.assertEqual(tickets[self.child_id]["section"], "## DOING", tickets[self.child_id])


if __name__ == "__main__":
    unittest.main(verbosity=2)
