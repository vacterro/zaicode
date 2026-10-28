"""Public-CLI subprocess regressions for the T-1302 orchestration repair.

CONTROLS A-I from the handoff: the public command surface must actually work
end to end -- not just the engine functions. The FastPrompter failure was a
PUBLIC workflow (agent runs `saipen ...`), so these tests drive the real
`tools/saipen.py` as a subprocess against a throwaway project and assert the
public JSON contract. Engine-level regressions stay in
test_orchestration_repair.py; this suite proves the CLI exposes them.

Run standalone:
    python tools/test_public_closure_cli.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.operations import apply_claim  # noqa: E402
from test_orchestration_repair import OrchestrationFixture  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"


def _with_published_release(project: Path, version: str = "0.4.2") -> str:
    """Durable publication evidence (FINDING 3 authority): the implementation
    the verification-only ticket inherits was already released. Scenario setup,
    not a closure shortcut."""
    (project / ".saipen" / "kitchen").mkdir(parents=True, exist_ok=True)
    (project / ".saipen" / "kitchen" / "release_receipt.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "op_id": "release-abc123",
                "version": version,
                "tag": f"v{version}",
                "commit": "c0ffee",
            }
        ),
        encoding="utf-8",
    )
    return f"release:v{version}"


def _install_runtime(project: Path) -> None:
    """Give the fixture a REAL SAIPEN installation to publish from.

    The no-publish release path runs `<project>/tools/validate.py --gate core`
    (T-994 / § 10) as a subprocess inside the project, and that validator
    resolves its own protocol directory and schemas. Copying only `tools/`
    left it with no BOOT.md/REGISTRY.json to resolve, so the gate died on an
    installation error long before it could judge anything. The fixture
    installs the three directories a real project has and nothing else --
    running the ACTUAL gate is the point of an end-to-end publication test.
    """
    if (project / "tools").exists():
        return
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc")
    shutil.copytree(TOOLS, project / "tools", ignore=ignore)
    shutil.copytree(ROOT / "saipen", project / "saipen", ignore=ignore)
    shutil.copytree(ROOT / "extensions", project / "extensions", ignore=ignore)


def _release_metadata(project: Path, version: str) -> None:
    """The release surface a cohort publication must keep consistent.

    `saipen cohort ship` runs the SAME R001 release path an ordinary ship
    runs, so it enforces the same version-parity contract: VERSION, the README
    badges the locale mirror discovers, and the CHANGELOG head. The fixture
    provides them because the machinery is real, not because a cohort gets a
    special case.
    """
    (project / "VERSION").write_text(version + "\n", encoding="utf-8")
    for name in ("README.md", "README.ee.md", "README.ded.md", "README.ja.md"):
        (project / name).write_text(
            "# fixture\n\n**v" + version + "**\n", encoding="utf-8"
        )
    (project / "CHANGELOG.md").write_text(
        "# Changelog\n\n## " + version + "\n- cohort fixture\n", encoding="utf-8"
    )


class PublicClosureCliTests(OrchestrationFixture):
    """CONTROL A/B: public `ticket done --closure-mode ...` grammar."""

    def run_cli(
        self, project: Path, *args: str, capability: str | None = None
    ) -> tuple[int, dict, str]:
        """Drive the REAL public adapter as a subprocess.

        `capability` declares the CURRENT-SESSION capability the way a host
        does. It is not a convenience: since the capability hardening, a
        persisted `mode: no-publish` is only the LAST handshake outcome and
        grants nothing, so a fixture that wants a non-publishing session must
        say so through `SAIPEN_CAPABILITY` like every real caller.
        """
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        if capability:
            env["SAIPEN_CAPABILITY"] = capability
        proc = subprocess.run(
            [
                sys.executable,
                str(SAIPEN_PY),
                "--project-root",
                str(project),
                "--agent",
                "tester",
                "--json",
                *args,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
            timeout=180,
        )
        try:
            payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
        except ValueError:
            payload = {"_unparseable_stdout": proc.stdout}
        return proc.returncode, payload, proc.stderr

    def test_control_a_inherited_cli(self):
        """A verification-only ticket closes through the PUBLIC CLI with
        closure provenance, zero Git publication."""
        project = self.make_project(active=True)
        source = _with_published_release(project)
        self.to_ship(project, "T-7")
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "done",
            "T-7",
            "--closure-mode",
            "inherited_verified",
            "--implementation-source",
            source,
        )
        self.assertEqual(rc, 0, payload)
        self.assertTrue(payload.get("ok"), payload)
        board = self.board(project)
        done = board["tickets"]["T-7"]
        self.assertEqual(done["section"], "## DONE")
        fields = done["fields"]
        self.assertEqual(fields.get("closure_mode"), "inherited_verified")
        self.assertEqual(fields.get("implementation_delta"), "none")
        self.assertEqual(fields.get("implementation_source"), source)
        self.assertFalse((project / ".git").exists())
        state = self.state(project)
        self.assertEqual(state["phase"], "DONE")
        self.assertEqual(state["task"], "none")

    def test_control_b_malformed_inherited_cli(self):
        """Missing / malformed / duplicate / unknown closure options REFUSE
        with zero canonical mutation (FINDING 1 + 3)."""
        project = self.make_project(active=True)
        self.to_ship(project, "T-7")
        # Missing implementation_source.
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "done",
            "T-7",
            "--closure-mode",
            "inherited_verified",
        )
        self.assertNotEqual(rc, 0)
        self.assertEqual(payload.get("code"), "VALIDATION_FAILED")
        self.assertIn("--implementation-source", payload.get("detail", ""))
        self.assertEqual(self.board(project)["tickets"]["T-7"]["section"], "## DOING")
        # Duplicate option.
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "done",
            "T-7",
            "--closure-mode",
            "cohort",
            "--closure-mode",
            "own_patch",
            "--closure-cohort",
            "C-001",
            "--paths",
            "main.py",
        )
        self.assertNotEqual(rc, 0)
        self.assertIn("duplicate option", payload.get("detail", ""))
        # Unknown option.
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "done",
            "T-7",
            "--closure-mode",
            "cohort",
            "--closure-cohort",
            "C-001",
            "--paths",
            "main.py",
            "--frobnicate",
        )
        self.assertNotEqual(rc, 0)
        self.assertIn("unknown option", payload.get("detail", ""))
        # Option value missing.
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "done",
            "T-7",
            "--closure-mode",
        )
        self.assertNotEqual(rc, 0)
        self.assertIn("needs a value", payload.get("detail", ""))
        # Semantics: cohort without cohort id refuses (engine gate).
        rc, payload, _err = self.run_cli(
            project, "ticket", "done", "T-7", "--closure-mode", "cohort", "--paths", "main.py"
        )
        self.assertNotEqual(rc, 0)
        self.assertIn("closure_cohort", payload.get("detail", ""))
        # Semantics: --closure-cohort on own_patch refuses.
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "done",
            "T-7",
            "--closure-cohort",
            "C-001",
        )
        self.assertNotEqual(rc, 0)
        self.assertIn("only valid with closure_mode cohort", payload.get("detail", ""))
        # The ticket never moved: every refusal above was zero-write.
        self.assertEqual(self.board(project)["tickets"]["T-7"]["section"], "## DOING")

    def test_control_c_d_cohort_cli_and_publication(self):
        """CONTROL C/D: two overlapping members join C-001 through the public
        CLI; `saipen cohort ship C-001` publishes ONE batch scope through the
        release machinery and flips the durable registry to shipped."""
        project = self.make_project(active=True)
        # The shared accumulated bytes both members attribute (FastPrompter's
        # main.py), under a directory: the release gate enforces a CLOSED
        # repository-root file set, so a stray root-level fixture file is a
        # real release-integrity failure and not a cohort question.
        (project / "assets").mkdir(parents=True, exist_ok=True)
        (project / "assets" / "main.py").write_text("shared = True\n", encoding="utf-8")
        # no-publish policy: the fixture project never publishes Git.
        state_path = project / ".saipen" / "STATE.md"
        state_text = state_path.read_text(encoding="utf-8")
        state_path.write_text(
            state_text.replace("mode: full", "mode: no-publish"), encoding="utf-8"
        )
        # A 0.x version would trip the protocol version guard against the
        # fixture's `saipen_version: 7` state; the release identity has to be
        # coherent with the state it publishes.
        _release_metadata(project, "7.5.0")
        _install_runtime(project)

        second = self.add(project, "overlapping work")
        self.to_ship(project, "T-7")
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "done",
            "T-7",
            "--closure-mode",
            "cohort",
            "--closure-cohort",
            "C-001",
            "--paths",
            "assets/main.py",
        )
        self.assertEqual(rc, 0, payload)
        self.assertTrue(payload.get("ok"), payload)
        # ONE fixture actor. The earlier version of this suite claimed the
        # second member as `buffy` while the subprocess CLI ran as `tester`,
        # which correctly triggered the foreign-claim refusal and made the
        # whole cohort suite fail for an unrelated reason. Foreign-actor
        # refusal is a REAL rule and gets its own test below, not an accident
        # baked into an unrelated fixture.
        claim = apply_claim(project, second, "tester", explicit=True)
        self.assertTrue(claim.ok, claim.to_dict())
        self.to_ship(project, second)
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "done",
            second,
            "--closure-mode",
            "cohort",
            "--closure-cohort",
            "C-001",
            "--paths",
            "assets/main.py",
        )
        self.assertEqual(rc, 0, payload)

        registry = json.loads(
            (project / ".saipen" / "kitchen" / "cohort_registry.json").read_text(
                encoding="utf-8"
            )
        )
        cohort = registry["cohorts"]["C-001"]
        self.assertEqual(cohort["publication_status"], "pending")
        self.assertEqual(set(cohort["members"]), {"T-7", second})
        # No individual fake commit exists.
        self.assertFalse((project / ".git").exists())

        # CONTROL D: foreign dirty work elsewhere must survive publication.
        (project / "assets" / "foreign.py").write_text(
            "foreign = True\n", encoding="utf-8"
        )

        # Public cohort publication: one batch scope, registry flips shipped.
        rc, payload, _err = self.run_cli(
            project, "cohort", "ship", "C-001", capability="no-publish"
        )
        self.assertEqual(rc, 0, payload)
        self.assertTrue(payload.get("ok"), payload)
        registry = json.loads(
            (project / ".saipen" / "kitchen" / "cohort_registry.json").read_text(
                encoding="utf-8"
            )
        )
        cohort = registry["cohorts"]["C-001"]
        self.assertEqual(cohort["publication_status"], "shipped")
        self.assertTrue(cohort["release_op_id"], cohort)
        self.assertEqual(cohort["version"], "7.5.0")
        self.assertEqual(cohort["tag"], "v7.5.0")
        # The frozen batch scope names the shared path exactly once.
        self.assertEqual(sorted(cohort["scope"]), ["assets/main.py"])
        # Foreign bytes are untouched.
        self.assertEqual(
            (project / "assets" / "foreign.py").read_text(encoding="utf-8"),
            "foreign = True\n",
        )
        # Idempotency: a second ship refuses (already published).
        rc, payload, _err = self.run_cli(
            project, "cohort", "ship", "C-001", capability="no-publish"
        )
        self.assertNotEqual(rc, 0)
        self.assertIn("already published", payload.get("detail", ""))
        # Durable publication receipt exists (FINDING 4).
        receipt = json.loads(
            (project / ".saipen" / "kitchen" / "release_receipt.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(receipt["cohort_id"], "C-001")
        self.assertEqual(receipt["op_id"], cohort["release_op_id"])

    def test_control_e_fastprompter_verification_only(self):
        """CONTROL E: the original T-1201 class -- implementation already
        durably owned elsewhere, current ticket adds no code, shared worktree
        carries unrelated bytes -- closes inherited_verified through the
        public CLI with no attempted isolation/commit."""
        project = self.make_project(active=True)
        source = _with_published_release(project)
        # Shared accumulated worktree with unrelated bytes (FastPrompter main.py).
        (project / "main.py").write_text(
            "# accumulated from T-A, T-B, T-C\ncheckbox = False\n", encoding="utf-8"
        )
        self.to_ship(project, "T-7")
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "done",
            "T-7",
            "--closure-mode",
            "inherited_verified",
            "--implementation-source",
            source,
        )
        self.assertEqual(rc, 0, payload)
        board = self.board(project)
        self.assertEqual(board["tickets"]["T-7"]["section"], "## DONE")
        fields = board["tickets"]["T-7"]["fields"]
        self.assertEqual(fields.get("closure_mode"), "inherited_verified")
        self.assertEqual(fields.get("implementation_delta"), "none")
        # main.py was never staged/committed/isolated -- no .git at all.
        self.assertFalse((project / ".git").exists())
        self.assertEqual(
            (project / "main.py").read_text(encoding="utf-8"),
            "# accumulated from T-A, T-B, T-C\ncheckbox = False\n",
        )

    def test_control_f_user_interrupt(self):
        """CONTROL F: public `user-request` persists the new explicit request
        while T-A stays DOING; after a ticket-scope block the scheduler picks
        the new request."""
        project = self.make_project(active=True)
        rc, payload, _err = self.run_cli(project, "user-request", "make checkbox indicators square")
        self.assertEqual(rc, 0, payload)
        self.assertTrue(payload.get("ok"), payload)
        new_ticket = payload.get("data", {}).get("ticket") or payload.get("ticket")
        self.assertTrue(new_ticket, payload)
        board = self.board(project)
        self.assertTrue(board["tickets"][new_ticket].get("fields", {}).get("user_explicit"))
        # T-A untouched and still claimed.
        self.assertEqual(board["tickets"]["T-7"]["section"], "## DOING")
        # Now block T-A with ticket scope through the public CLI.
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "block",
            "T-7",
            "exact patch isolation unavailable",
            "--scope",
            "ticket",
        )
        self.assertEqual(rc, 0, payload)
        state = self.state(project)
        self.assertTrue(state["next_action"].endswith(new_ticket), state)
        # The request survives a re-read (durable projection, not agent memory).
        board = self.board(project)
        self.assertEqual(board["tickets"][new_ticket]["section"], "## TODO")

    def test_control_g_h_blocked_release_and_goal_block(self):
        """CONTROL G/H: `saipen continue` + `saipen status --json` agree that
        an independent explicit ticket is next while a release's gates are
        blocked; with only goal-scope blockers left, GOAL_BLOCKED appears."""
        project = self.make_project()
        self.add(project, "gate A", verify="PASS A")
        gate_b = self.add(project, "gate B", verify="PASS B")
        release = self.add(project, "release work", needs=[gate_b])
        rc, payload, _err = self.run_cli(
            project,
            "ticket",
            "block",
            gate_b,
            "operator hardware confirmation",
            "--scope",
            "goal",
        )
        self.assertEqual(rc, 0, payload)
        rc, payload, _err = self.run_cli(
            project, "user-request", "make checkbox indicators square"
        )
        self.assertEqual(rc, 0, payload)
        new_ticket = payload.get("data", {}).get("ticket") or payload.get("ticket")
        # Public status agrees on the workable pick.
        rc, status, _err = self.run_cli(project, "status", "--json")
        self.assertEqual(rc, 0, status)
        # status --json reports the FRESH route (computed_next_action) beside
        # the persisted next_action; both must agree the user ticket is next
        # and never the blocked release.
        self.assertIn(new_ticket, status.get("computed_next_action") or "", status)
        self.assertNotIn(release, status.get("computed_next_action") or "", status)
        self.assertEqual(status.get("computed_reason"), "start-user-explicit")
        self.assertNotEqual(release, new_ticket)
        # Public continue re-routes and PERSISTS the pick on STATE.
        rc, cont, _err = self.run_cli(project, "continue")
        self.assertEqual(rc, 0, cont)
        state = self.state(project)
        self.assertIn(new_ticket, state["next_action"], state)
        self.assertNotIn(release, state["next_action"], state)

    def test_control_i_help_contract(self):
        """CONTROL I: `saipen --help` advertises every surface the agent
        needs -- the executable feature must never become undiscoverable."""
        proc = subprocess.run(
            [sys.executable, str(SAIPEN_PY), "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            timeout=60,
        )
        text = proc.stdout + proc.stderr
        for token in (
            "user-request",
            "--closure-mode",
            "--closure-cohort",
            "--implementation-source",
            "--paths",
            "cohort ship",
        ):
            self.assertIn(token, text, f"--help must advertise {token!r}")

    def test_control_i_help_advertises_the_block_scope(self):
        proc = subprocess.run(
            [sys.executable, str(SAIPEN_PY), "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            timeout=60,
        )
        text = proc.stdout + proc.stderr
        self.assertIn("--scope ticket|goal", text)
        self.assertIn("cohort status", text)


class ForeignActorRefusalTests(OrchestrationFixture):
    """CONTROL 8: a foreign actor mutates nothing, through the PUBLIC CLI.

    This is the rule the old fixture tripped over by accident, by claiming a
    ticket as one agent and driving the CLI as another. It is a REAL rule and
    it deserves its own test: an actor who does not own the live claim gets a
    refusal and leaves zero canonical bytes behind, whether it tries to
    finish, block, or take the seat.
    """

    def run_as(self, project: Path, agent: str, *args: str) -> tuple[int, dict]:
        proc = subprocess.run(
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
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            timeout=180,
        )
        try:
            payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
        except ValueError:
            payload = {"_unparseable_stdout": proc.stdout}
        return proc.returncode, payload

    def digest(self, project: Path) -> str:
        import hashlib

        h = hashlib.sha256()
        for path in sorted(p for p in (project / ".saipen").rglob("*") if p.is_file()):
            h.update(str(path.relative_to(project)).replace("\\", "/").encode())
            h.update(path.read_bytes())
        return h.hexdigest()

    def test_a_foreign_actor_cannot_finish_block_or_take_the_seat(self):
        project = self.make_project(active=True)
        self.to_ship(project, "T-7")
        before = self.digest(project)
        for args in (
            ("ticket", "done", "T-7"),
            ("ticket", "block", "T-7", "I would like this parked", "--scope", "goal"),
            ("transition", "REVIEW", "T-7", "REVIEW: PASS"),
        ):
            with self.subTest(args=args):
                rc, payload = self.run_as(project, "intruder", *args)
                self.assertNotEqual(rc, 0, payload)
                self.assertEqual(self.digest(project), before, "a foreign actor wrote bytes")
        self.assertEqual(self.board(project)["tickets"]["T-7"]["section"], "## DOING")
        self.assertEqual(self.state(project)["agent"], "tester")

    def test_a_foreign_actor_may_still_record_intent(self):
        """Refusal is about the SEAT, not about the agent existing.

        Recording future work or a user request is exactly what an
        out-of-band actor is allowed to do (CORE-001 CONTROL A/B); it simply
        does not move the seat.
        """
        project = self.make_project(active=True)
        rc, payload = self.run_as(
            project, "intruder", "user-request", "make checkbox indicators square"
        )
        self.assertEqual(rc, 0, payload)
        self.assertTrue(payload.get("ticket"), payload)
        self.assertEqual(self.state(project)["agent"], "tester")
        self.assertEqual(
            self.board(project)["tickets"]["T-7"]["fields"]["owner"], "tester"
        )


if __name__ == "__main__":
    unittest.main()