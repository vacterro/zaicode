"""A refusal that states the rule and hides the move gets retried (T-1385).

`PROTECTED_CANONICAL_NAMESPACE` is correct: canonical state is not written by
hand. It was also routeless -- `canonical_next_command` was None and the
detail said only that the command was refused.

The first route this ticket printed was `saipen checkpoint RUN T-### '<what
happened>'`. The guard never knows what happened: that line is either not
runnable as printed or, typed verbatim, a checkpoint whose evidence is the
placeholder itself (SRC-057 section 4). A refusal that only knows direct
canonical mutation is forbidden cannot know which canonical operation was
meant, so the route is the canonical router's own read instead --
`saipen next --json` -- which answers, from the state it runs in, what the
legal move is. It writes nothing, so it is safe in every state, including
the one where STATE.md cannot be parsed.

The route must also REACH the session. Measured from OpenCode's session store
(`.saipen/evidence/T-1385-routeless-refusal-20260917/pcn-causality/`): in all
eleven PCN refusals the field recorded, the host error text was
`SAIPEN_GUARD_REFUSAL: PROTECTED_CANONICAL_NAMESPACE: the host tool did not
execute` -- the adapter's terminal-code branch threw before the branch that
names the route and the attempted command. Every pair the polygon scored as a
repeat was a DIFFERENT effect (seven of seven, none parallel), collapsed into
one identity by that constant sentence.

These controls run the string the verdict carries byte for byte -- no
placeholder filling, no substitution -- and prove it moved nothing.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import test_t1363_zero_manual_entry as fixtures  # noqa: E402
from saipen_engine import guard_events  # noqa: E402
from saipen_engine.admission import evaluate_admission  # noqa: E402
from saipen_engine.board import HOST_SESSION_ENV  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402

SAIPEN = TOOLS / "saipen.py"
SESSION = "ses_route_probe"
CODE = "PROTECTED_CANONICAL_NAMESPACE"
#: Pinned literally, so changing the route is a decision and not a side effect.
ROUTE = "saipen next --json"
#: Every surface that can reach canonical state. The field hit it through the
#: shell; a route present there and absent on `edit` would still strand a
#: session, so each is asserted rather than assumed to share a code path.
SURFACES = ("bash", "edit", "write")
#: What the harvest control calls a placeholder. A route carrying one is a
#: template, and a template typed verbatim records the template.
PLACEHOLDER = re.compile(r"<[^<>]*>|\{[^{}]*\}")
CANONICAL_CARRIERS = ("STATE.md", "BOARD.md", "LOG.md", "intake/index.json")


def setUpModule() -> None:
    isolate_host_session()


def _tool_input(project: Path, surface: str) -> dict:
    target = project / ".saipen" / "STATE.md"
    if surface == "bash":
        return {"command": f'echo x >> "{target}"'}
    if surface == "edit":
        return {"filePath": str(target), "oldString": "phase:", "newString": "phase: DONE"}
    return {"filePath": str(target), "content": "phase: DONE\n"}


def _event(project: Path, tool: str, tool_input: dict) -> dict:
    return {
        "event": "before_tool",
        "host": "opencode",
        "cwd": str(project),
        "tool_name": tool,
        "tool_input": tool_input,
        "session_id": SESSION,
    }


def _verdict(project: Path, surface: str) -> dict:
    event = _event(project, surface, _tool_input(project, surface))
    return guard_events.evaluate_event(guard_events.load_event(json.dumps(event)), None)


def _canonical(project: Path) -> dict:
    out = {}
    for name in CANONICAL_CARRIERS:
        path = project / ".saipen" / name
        out[name] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    return out


def _run_verbatim(case: unittest.TestCase, project: Path, route: str):
    """Guard first, then the CLI, exactly as a host session in `project` runs it.

    The line is tokenized the way a shell would and nothing else happens to it:
    no placeholder is filled, no flag is added, and the project is bound by the
    working directory alone -- the only binding a session typing it has.
    """
    event = _event(project, "bash", {"command": route})
    verdict = guard_events.evaluate_event(guard_events.load_event(json.dumps(event)), None)
    case.assertTrue(
        verdict["admitted"],
        f"the guard refuses its own route {route!r} in the state that printed it: {verdict}",
    )
    argv = shlex.split(route)
    case.assertEqual(argv[0], "saipen", route)
    env = {**os.environ}
    for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT"):
        env.pop(key, None)
    proc = subprocess.run(
        [sys.executable, str(SAIPEN), *argv[1:]],
        cwd=str(project),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=300,
    )
    try:
        payload = json.loads(proc.stdout)
    except ValueError:
        payload = None
    return proc.returncode, payload, proc.stdout + proc.stderr


def _started(case: unittest.TestCase, phase: str | None = None) -> Path:
    project = Path(fixtures.healthy(case))
    env = {**os.environ, HOST_SESSION_ENV: SESSION}
    started = subprocess.run(
        [
            sys.executable,
            str(SAIPEN),
            "start",
            "add a docstring to src/app.py",
            "--json",
            "--project-root",
            str(project),
            "--agent",
            "test-agent",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=300,
    )
    case.assertEqual(json.loads(started.stdout or "{}").get("code"), "STARTED", started.stdout)
    if phase:
        code, _payload, text = fixtures.cli(
            project, "transition", phase, "T-1", "scout done", "--json"
        )
        case.assertEqual(code, 0, text)
    return project


class TheRouteIsOneHonestCommandTests(unittest.TestCase):
    def test_every_surface_that_is_refused_carries_the_same_route(self):
        project = Path(fixtures.healthy(self))
        for surface in SURFACES:
            with self.subTest(surface=surface):
                verdict = _verdict(project, surface)
                self.assertEqual(verdict["code"], CODE)
                self.assertFalse(verdict["ok"], "the route is an exit, not a loophole")
                self.assertEqual(verdict.get("canonical_next_command"), ROUTE, verdict)

    def test_the_route_carries_no_placeholder(self):
        """A placeholder is authority the guard does not have."""
        for state in ("healthy", "build"):
            with self.subTest(state=state):
                project = (
                    Path(fixtures.healthy(self)) if state == "healthy" else _started(self, "BUILD")
                )
                route = _verdict(project, "bash")["canonical_next_command"]
                self.assertEqual(PLACEHOLDER.findall(route), [], route)

    def test_the_route_classifies_canonical_and_needs_no_preparation(self):
        """Not an ordinary shell line admitted by luck: the canonical grammar's own verb."""
        self.assertEqual(guard_events._saipen_cli_verb(ROUTE), "next")
        mapped = guard_events.map_event(
            guard_events.load_event(json.dumps(_event(Path.cwd(), "bash", {"command": ROUTE})))
        )
        self.assertEqual(mapped["action"], "saipen_op")
        self.assertEqual(mapped["command_class"], "DIAGNOSTIC")
        self.assertIs(mapped["fleet_preflight"], False)


class TheRouteRunsVerbatimFromTheStateThatPrintedItTests(unittest.TestCase):
    """SRC-057 section 6: execute the returned string, not a repaired copy of it."""

    def test_no_active_work(self):
        project = Path(fixtures.healthy(self))
        route = _verdict(project, "bash")["canonical_next_command"]
        before = _canonical(project)
        code, payload, text = _run_verbatim(self, project, route)
        self.assertEqual(_canonical(project), before, "the route moved canonical state")
        self.assertEqual(code, 0, text)
        self.assertTrue((payload or {}).get("ok"), text)
        self.assertTrue(str((payload or {}).get("action") or "").strip(), text)

    def test_active_build_work_records_no_fabricated_checkpoint(self):
        """The RED this replaces: `saipen checkpoint RUN T-1 '<what happened>'`
        typed verbatim appended a LOG event whose evidence was the placeholder."""
        project = _started(self, "BUILD")
        for surface in SURFACES:
            with self.subTest(surface=surface):
                route = _verdict(project, surface)["canonical_next_command"]
                before = _canonical(project)
                log_before = (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")
                code, payload, text = _run_verbatim(self, project, route)
                log_after = (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")
                self.assertNotIn("<what happened>", log_after, "a placeholder became evidence")
                self.assertEqual(log_after, log_before, "the route wrote a LOG event")
                self.assertEqual(_canonical(project), before, "the route moved canonical state")
                self.assertEqual(code, 0, text)
                self.assertTrue((payload or {}).get("ok"), text)
                self.assertEqual(payload.get("ticket"), "T-1", text)
                self.assertEqual(payload.get("action"), "PHASE BUILD T-1", text)

    def test_unreadable_state_is_diagnosed_and_nothing_is_written(self):
        """Never send a session to checkpoint over state nobody could parse."""
        project = Path(fixtures.healthy(self))
        (project / ".saipen" / "STATE.md").write_text("not a checkpoint", encoding="utf-8")
        route = _verdict(project, "bash")["canonical_next_command"]
        before = _canonical(project)
        code, payload, text = _run_verbatim(self, project, route)
        self.assertNotEqual(code, 0, text)
        self.assertEqual((payload or {}).get("code"), "VALIDATION_FAILED", text)
        self.assertIn("state-malformed", str((payload or {}).get("detail")), text)
        self.assertEqual(_canonical(project), before, "diagnosis wrote canonical state")


class EveryRefusalSiteCarriesTheRouteTests(unittest.TestCase):
    """The route is attached where the code is chosen, not at each call site.

    Measured on this ticket's first slice: five sites were given the route by
    hand and the hard-link site was not, so one PCN shape stayed routeless.
    """

    def assertRouted(self, verdict: dict) -> None:
        self.assertEqual(verdict.get("code"), CODE, verdict)
        self.assertEqual(verdict.get("canonical_next_command"), ROUTE, verdict)

    def test_containment_of_the_memory_directory(self):
        project = Path(fixtures.healthy(self))
        self.assertRouted(
            evaluate_admission(
                str(project), target_paths=[str(project / ".saipen")], action="delete"
            )
        )

    def test_another_projects_canonical_state(self):
        project = Path(fixtures.healthy(self))
        other = Path(fixtures.healthy(self))
        self.assertRouted(
            evaluate_admission(
                str(project), target_paths=[str(other / ".saipen" / "STATE.md")], action="write"
            )
        )

    def test_a_directory_that_holds_another_project(self):
        project = Path(fixtures.healthy(self))
        holder = Path(tempfile.mkdtemp(prefix="t1385-holder-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(holder, ignore_errors=True))
        (holder / "inner" / ".saipen").mkdir(parents=True)
        (holder / "inner" / ".saipen" / "STATE.md").write_text("phase: DONE\n", encoding="utf-8")
        self.assertRouted(
            evaluate_admission(str(project), target_paths=[str(holder)], action="delete")
        )

    def test_a_hard_link_to_canonical_state(self):
        project = Path(fixtures.healthy(self))
        alias = project / "src" / "state-alias.md"
        try:
            os.link(project / ".saipen" / "STATE.md", alias)
        except OSError as exc:  # pragma: no cover -- filesystem without hard links
            self.skipTest(f"hard links unavailable: {exc}")
        self.assertRouted(
            evaluate_admission(str(project), target_paths=[str(alias)], action="write")
        )


class TheHostDeliversTheRouteTests(unittest.TestCase):
    """The shipped OpenCode plugin, in node, with the real spawned guard.

    A route in the verdict that the host error text drops is a route no model
    ever reads. The two shell commands are the shape of the field pair from the
    T-1385 smoke's long_file_task (run a script, then delete it), which the
    polygon scored as one refusal repeating. The field pair named
    `.saipen/kitchen/`, which T-1387 made an ordinary project path judged like a
    file-tool target; the same pair inside the protected namespace is still the
    refusal whose route this class pins.
    """

    RUN = "python .saipen/recovery/review_check.py"
    DELETE = "Remove-Item -LiteralPath .saipen/recovery/review_check.py"

    @classmethod
    def setUpClass(cls):
        import test_opencode_adapter as adapter

        if not adapter.NODE or not adapter.PYTHON:
            raise unittest.SkipTest("node or python runtime unavailable")
        from test_guard_hostile_matrix import active_project

        cls.project = active_project()
        env = {
            "SAIPEN_SKILL_ROOT": str(adapter.REPO),
            "SAIPEN_PYTHON": adapter.PYTHON,
            "SAIPEN_GUARD_STARTUP_PROBE": None,
            "SAIPEN_AGENT": "test-agent",
        }

        def shell(case_id: str, command: str) -> dict:
            return {
                "id": case_id,
                "project": str(cls.project),
                "env": env,
                "input": {"tool": "bash", "sessionID": "ses_probe"},
                "output": {"args": {"command": command}},
            }

        cases = [
            shell("run", cls.RUN),
            shell("delete", cls.DELETE),
            {
                "id": "write",
                "project": str(cls.project),
                "env": env,
                "input": {"tool": "write", "sessionID": "ses_probe"},
                "output": {"args": {"filePath": ".saipen/STATE.md", "content": "phase: DONE\n"}},
            },
        ]
        workdir = Path(tempfile.mkdtemp(prefix="t1385-adapter-"))
        cls.by_id = {
            record["id"]: record
            for record in adapter.run_cases(adapter.PLUGIN, cases, workdir)
        }

    def blocked(self, case_id: str) -> str:
        record = self.by_id[case_id]
        self.assertEqual(record["outcome"], "blocked", record)
        self.assertIn(f"SAIPEN_GUARD_REFUSAL: {CODE}:", record["message"], record)
        return record["message"]

    def test_the_route_reaches_the_model_on_every_surface(self):
        for case_id in ("run", "delete", "write"):
            with self.subTest(case=case_id):
                self.assertIn(f" next: {ROUTE}", self.blocked(case_id))

    def test_the_refusal_says_what_it_refused(self):
        self.assertIn(f" attempted: {self.RUN}", self.blocked("run"))
        self.assertIn(f" attempted: {self.DELETE}", self.blocked("delete"))

    def test_two_different_effects_are_two_refusals_and_one_effect_twice_is_a_repeat(self):
        """The polygon reads the host error text; PARALLEL/SEQUENTIAL provenance
        is not in that text, so what this pins is identity, from real bytes."""
        import t1363_field_polygon as polygon

        def refused(command: str, message: str) -> dict:
            return {
                "tool": "bash",
                "status": "error",
                "input": {"command": command},
                "output": "",
                "error": message,
            }

        run = refused(self.RUN, self.blocked("run"))
        delete = refused(self.DELETE, self.blocked("delete"))
        seen = polygon.measure([run, delete], measured=True)
        self.assertEqual(seen["refusal_sequence"], [CODE, CODE])
        self.assertEqual(seen["repeated_refusal"], [])
        again = polygon.measure([run, run], measured=True)
        self.assertEqual(again["repeated_refusal"], [CODE])


if __name__ == "__main__":
    unittest.main()
