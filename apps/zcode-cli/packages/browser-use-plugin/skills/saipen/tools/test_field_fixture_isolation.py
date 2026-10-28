"""Field-fixture ledger isolation (T-1370, SRC-049:R009).

WHAT THIS REPRODUCES
--------------------
The 16.09.26 harness defect, exactly as measured:

    main repository            the project the harness was launched from
    fixture worktree           the sandbox the session was supposed to use
    subprocess cwd = fixture   what `subprocess` sets
    PWD = main repository      what `subprocess` does NOT reset
    weak model                 resolved its work against PWD, not cwd
    saipen start               therefore ran against the WRONG project
    -> SRC-047/T-1368, SRC-048/T-1369 and src/app.py minted in the repository

The host binary is not what these tests drive -- they drive the measured
RESOLUTION RULE, in a stand-in host of four lines: chdir to `$PWD`, then run
`saipen start`. That is precisely what the session transcripts show the model's
shell doing, and it is the only part of the host this defect lives in.

WHY IT ASSERTS THE LEDGER, NOT THE FILE
---------------------------------------
"the docstring landed in the fixture" is a weak claim: a session can edit the
right file and still mint a receipt, a ticket and three canonical events in the
wrong project. The pass condition here is therefore CANONICAL LEDGER
ISOLATION -- `STATE.md`, `BOARD.md`, `LOG.md` and `intake/index.json` of the
project that was NOT targeted must be byte-identical afterwards.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import t1363_field_polygon as polygon  # noqa: E402
from saipen_engine.board import parse_board  # noqa: E402
from saipen_engine.journal import ensure_project_lineage  # noqa: E402
from saipen_engine.paths import unbound_environment  # noqa: E402

#: Every canonical carrier a wrong-project session can damage. `intake/index.json`
#: is on the list because the incident's first durable trace was a RECEIPT, and a
#: check that watched only STATE/BOARD/LOG would have called that run clean.
CANONICAL = ("STATE.md", "BOARD.md", "LOG.md", "intake/index.json")

TASK = "add a one-line docstring to the top of src/app.py"

#: The stand-in host. It does the one thing the transcripts prove the real
#: session did: trust `PWD` over the working directory it was given.
STAND_IN_HOST = (
    "import os, subprocess, sys\n"
    "os.chdir(os.environ['PWD'])\n"
    "sys.exit(subprocess.run([sys.executable, sys.argv[1], 'start', sys.argv[2],\n"
    "                         '--json']).returncode)\n"
)


def canonical_hashes(root: Path) -> dict:
    out = {}
    for name in CANONICAL:
        path = root / ".saipen" / name
        out[name] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    return out


class LedgerIsolationTests(unittest.TestCase):
    def make_project(self, label: str) -> Path:
        base = Path(tempfile.mkdtemp(prefix=f"saipen-{label}-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = base / label
        (project / ".saipen").mkdir(parents=True)
        (project / "src").mkdir(parents=True)
        (project / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")
        (project / ".saipen" / "STATE.md").write_text(
            "---\nphase: DONE\ntask: none\n"
            'next_action: "saipen continue"\n'
            'blocker: ""\ntransition_from: DONE\n'
            "saipen_version: 8\nschema_version: 3\nlast_event: 1\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{str(ROOT).replace(chr(92), chr(92) * 2)}"\n'
            "agent: tester\nrequires:\n  - filesystem\n  - python\n"
            "mode: full\n"
            'updated: "2026-09-16T00:00:00Z"\n---\n',
            encoding="utf-8",
        )
        (project / ".saipen" / "BOARD.md").write_text(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        (project / ".saipen" / "LOG.md").write_text(
            "- 16.09.26 00:00 [E-001] [agent: tester] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )
        ensure_project_lineage(project)
        polygon._git_worktree(project)
        return project

    def run_stand_in_host(self, *, cwd: Path, pwd: Path) -> subprocess.CompletedProcess:
        script = Path(tempfile.mkdtemp(prefix="saipen-host-")) / "host.py"
        self.addCleanup(lambda: shutil.rmtree(script.parent, ignore_errors=True))
        script.write_text(STAND_IN_HOST, encoding="utf-8")
        env = {**os.environ, "PWD": str(pwd), "PYTHONDONTWRITEBYTECODE": "1"}
        for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_SKILL_ROOT"):
            env.pop(key, None)
        return subprocess.run(
            [sys.executable, str(script), str(ROOT / "tools" / "saipen.py"), TASK],
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )

    def owning_ledger(self, project: Path) -> tuple[list[str], int]:
        board = parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        index = json.loads(
            (project / ".saipen" / "intake" / "index.json").read_text(encoding="utf-8-sig")
        ) if (project / ".saipen" / "intake" / "index.json").is_file() else {"active": {}}
        return sorted(board["tickets"]), len(index.get("active", {}))

    def test_red_inherited_pwd_mints_into_the_other_project(self):
        """The measured defect: cwd says fixture, PWD says repository."""
        repository = self.make_project("repository")
        fixture = self.make_project("fixture")
        repo_before = canonical_hashes(repository)
        fixture_before = canonical_hashes(fixture)

        self.run_stand_in_host(cwd=fixture, pwd=repository)

        self.assertNotEqual(
            canonical_hashes(repository),
            repo_before,
            "the RED control did not reproduce: the wrong project was untouched",
        )
        self.assertEqual(
            canonical_hashes(fixture),
            fixture_before,
            "the RED control is wrong: the fixture changed too",
        )
        tickets, receipts = self.owning_ledger(repository)
        self.assertTrue(tickets, "no ticket was minted in the wrong project")
        self.assertEqual(receipts, 1)
        self.assertEqual(self.owning_ledger(fixture), ([], 0))

    def test_green_bound_pwd_keeps_the_other_project_byte_identical(self):
        """The fix: the child's environment agrees with its directory."""
        repository = self.make_project("repository")
        fixture = self.make_project("fixture")
        repo_before = canonical_hashes(repository)
        fixture_before = canonical_hashes(fixture)

        self.run_stand_in_host(cwd=fixture, pwd=fixture)

        self.assertEqual(
            canonical_hashes(repository),
            repo_before,
            "canonical ledger isolation broken: the untargeted project changed",
        )
        self.assertNotEqual(
            canonical_hashes(fixture),
            fixture_before,
            "the fixture did no work, so this proves nothing",
        )
        tickets, receipts = self.owning_ledger(fixture)
        self.assertTrue(tickets, "the fixture minted no Work")
        self.assertEqual(receipts, 1)
        # And the claim a model makes is never the proof: the FIXTURE ledger is.
        self.assertEqual(self.owning_ledger(repository), ([], 0))

    # ------------------------------------------------------------------
    # The 17.09.26 twin: the same class through an ENVIRONMENT carrier.
    #
    # `PWD` (above) is read by the host's shell. `SAIPEN_PROJECT_ROOT` is read
    # by the protocol itself and RANKS ABOVE `cwd` (paths.resolve_project_root
    # precedence 2 vs 3), so a fixture subprocess that inherits it never
    # consults the directory it was given. Measured: SRC-059/T-1390 and
    # SRC-060/T-1391 were minted into the repository by SAIPEN's own tests.
    # ------------------------------------------------------------------

    def run_cli(self, *, cwd: Path, env: dict) -> dict:
        done = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "saipen.py"), "start", TASK, "--json"],
            cwd=str(cwd), env={**env, "PYTHONDONTWRITEBYTECODE": "1"},
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=300,
        )
        return json.loads(done.stdout or "{}")

    def test_a_stale_project_root_carrier_cannot_mint_into_the_other_project(self):
        """The exact contaminating call shape: full host env, cwd = fixture."""
        repository = self.make_project("repository")
        fixture = self.make_project("fixture")
        repo_before = canonical_hashes(repository)
        fixture_before = canonical_hashes(fixture)

        polluted = dict(os.environ)
        polluted["SAIPEN_PROJECT_ROOT"] = str(repository)
        polluted.pop("SAIPEN_PROJECT_LINEAGE", None)
        answer = self.run_cli(cwd=fixture, env=polluted)

        self.assertFalse(answer.get("ok"), answer)
        self.assertEqual(answer.get("code"), "PROJECT_BINDING_AMBIGUOUS", answer)
        self.assertEqual(
            canonical_hashes(repository), repo_before,
            "the carrier's project was mutated by a run whose cwd was the fixture",
        )
        self.assertEqual(
            canonical_hashes(fixture), fixture_before,
            "an ambiguous binding must write nowhere, not merely elsewhere",
        )
        self.assertEqual(self.owning_ledger(repository), ([], 0))
        self.assertEqual(self.owning_ledger(fixture), ([], 0))

    def test_the_unbound_environment_binds_the_fixture_it_was_given(self):
        """The harness fix: with the owner's environment, cwd decides."""
        repository = self.make_project("repository")
        fixture = self.make_project("fixture")
        repo_before = canonical_hashes(repository)

        os.environ["SAIPEN_PROJECT_ROOT"] = str(repository)
        self.addCleanup(os.environ.pop, "SAIPEN_PROJECT_ROOT", None)
        answer = self.run_cli(cwd=fixture, env=unbound_environment())

        self.assertEqual(answer.get("code"), "STARTED", answer)
        self.assertEqual(
            canonical_hashes(repository), repo_before,
            "canonical ledger isolation broken: the untargeted project changed",
        )
        tickets, receipts = self.owning_ledger(fixture)
        self.assertTrue(tickets, "the fixture minted no Work, so this proves nothing")
        self.assertEqual(receipts, 1)
        self.assertEqual(self.owning_ledger(repository), ([], 0))

    def test_a_carrier_still_binds_a_staging_directory_that_owns_no_project(self):
        """The carrier exists for this case and must keep working."""
        repository = self.make_project("repository")
        staging = Path(tempfile.mkdtemp(prefix="saipen-staging-"))
        self.addCleanup(lambda: shutil.rmtree(staging, ignore_errors=True))

        answer = self.run_cli(
            cwd=staging,
            env=unbound_environment(SAIPEN_PROJECT_ROOT=str(repository)),
        )
        self.assertEqual(answer.get("code"), "STARTED", answer)
        self.assertEqual(Path(answer["project_root"]), repository.resolve())
        tickets, receipts = self.owning_ledger(repository)
        self.assertTrue(tickets)
        self.assertEqual(receipts, 1)

    def test_one_worktree_of_the_same_project_is_not_an_ambiguous_binding(self):
        """Same lineage is the same project; only a DIFFERENT one is ambiguous."""
        project = self.make_project("project")
        answer = self.run_cli(
            cwd=project,
            env=unbound_environment(SAIPEN_PROJECT_ROOT=str(project)),
        )
        self.assertEqual(answer.get("code"), "STARTED", answer)

    def test_the_harness_environment_strips_every_stale_project_carrier(self):
        """`_host_env` is the fix's single point of truth -- pin its contract."""
        fixture = self.make_project("fixture")
        polluted = {
            "SAIPEN_PROJECT_ROOT": str(ROOT),
            "SAIPEN_PROJECT_LINEAGE": "stale",
            "SAIPEN_AGENT": "someone-else",
            "SAIPEN_SKILL_ROOT": str(ROOT),
            "SAIPEN_HOST_SESSION": "stale-seat",
            "OLDPWD": str(ROOT),
            "INIT_CWD": str(ROOT),
            "PWD": str(ROOT),
        }
        saved = {key: os.environ.get(key) for key in polluted}
        os.environ.update(polluted)
        try:
            env = polygon._host_env(fixture)
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        self.assertEqual(env["PWD"], str(fixture))
        for key in (
            "SAIPEN_PROJECT_ROOT",
            "SAIPEN_PROJECT_LINEAGE",
            "SAIPEN_AGENT",
            "SAIPEN_SKILL_ROOT",
            "SAIPEN_HOST_SESSION",
            "OLDPWD",
            "INIT_CWD",
        ):
            self.assertNotIn(key, env, f"{key} survived into the child environment")

    def test_the_polygon_watches_every_canonical_carrier(self):
        """A watcher blind to `intake/index.json` would have called this clean."""
        fixture = self.make_project("fixture")
        watched = set(polygon._canonical_hashes(fixture))
        self.assertEqual(watched, set(CANONICAL), "the polygon stopped watching a carrier")


class MatrixCompletenessTests(unittest.TestCase):
    """The matrix must build every condition it claims (T-1367, SRC-051 §11).

    `conditions()` built eight while the matrix named nine, and its own
    docstring said "eight", so a run that printed a row per built condition
    looked complete while the `--file` transport -- the one BOOT offers for a
    request the shell cannot carry -- was never driven by a model at all. The
    defect class: a matrix whose coverage is whatever the builder happened to
    write, checked against nothing.
    """

    #: Verbatim from SRC-051 section 11, in its order.
    DECLARED = (
        "healthy",
        "operator_decision",
        "safety_valve",
        "repairable_debt",
        "captured_unprojected",
        "already_done",
        "foreign_owner",
        "windows_path_task",
        "long_file_task",
    )

    def test_the_declared_matrix_still_equals_the_source(self):
        self.assertEqual(polygon.CONDITION_NAMES, self.DECLARED)

    def test_every_declared_condition_has_a_builder(self):
        self.assertEqual(set(polygon.condition_builders()), set(self.DECLARED))

    def test_a_builder_the_matrix_does_not_name_is_refused(self):
        """The check runs inside the builder, so it cannot be skipped."""
        original = polygon.CONDITION_NAMES
        polygon.CONDITION_NAMES = original[:-1]
        try:
            with self.assertRaises(ValueError) as caught:
                polygon.condition_builders()
        finally:
            polygon.CONDITION_NAMES = original
        self.assertIn("long_file_task", str(caught.exception))

    def test_the_long_request_routes_to_the_file_transport(self):
        """Not merely long -- long enough that the guard names `--file`."""
        from saipen_engine import guard_events

        payload = polygon.LONG_TASK
        self.assertGreater(len(payload.encode("utf-8")), guard_events.MAX_INGRESS_HEX_PAYLOAD)
        self.assertEqual(
            guard_events.ingress_rewrite(f"saipen start '{payload}'"),
            "saipen start --file <path>",
        )

    def test_an_unreadable_transcript_is_not_a_perfect_run(self):
        """Measured on `long_file_task`: the session drove the whole chain and
        closed T-1 at E-13 -- its own fixture ledger proves it -- while the
        host's JSON stream gave the harness nothing. The old metrics answered
        `protocol_commands_before_productive: 0`, which IS the strong
        acceptance number, so an unreadable transcript scored perfect."""
        blind = polygon.measure([], measured=False)
        self.assertEqual(blind["measurement"], polygon.UNMEASURED)
        for field in (
            "tools",
            "first_saipen_command",
            "protocol_commands_before_productive",
            "productive_action",
            "refusal_sequence",
            "repeated_refusal",
        ):
            self.assertIsNone(blind[field], field)

    def test_a_readable_transcript_still_measures(self):
        """The known-good control: the same call with events present."""
        seen = polygon.measure(
            [{"tool": "bash", "status": "completed",
              "input": {"command": "saipen start 'x'"}, "output": "", "error": ""}],
            measured=True,
        )
        self.assertEqual(seen["measurement"], polygon.MEASURED)
        self.assertEqual(seen["first_saipen_command"], "saipen start 'x'")
        self.assertEqual(seen["protocol_commands_before_productive"], 1)

    def test_looking_at_the_project_is_not_doing_the_work(self):
        """SRC-051 §11: status/read/git-status/test-only shell is not
        productivity. The old rule counted every non-`saipen` shell line, so
        `git status` scored a session productive at command one."""
        for inert in (
            "git status --porcelain",
            "git log --oneline -5",
            "ls -la src",
            "cat src/app.py",
            "pwd",
            "grep -rn docstring src",
            "python -m unittest discover -s tools",
            "ruff check tools/",
            "Get-Content src/app.py",
            "saipen status --json",
        ):
            self.assertFalse(polygon.productive_shell(inert), inert)
        for real in (
            "python -c \"open('src/app.py','w').write('x')\"",
            "sed -i '1i \"\"\"doc.\"\"\"' src/app.py",
            "git commit -m 'doc'",
            "npm run build",
        ):
            self.assertTrue(polygon.productive_shell(real), real)

    def test_an_inert_shell_line_does_not_score_a_session_productive(self):
        """The known-bad input the rule exists for, through `measure`."""
        looked = polygon.measure(
            [{"tool": "bash", "status": "completed",
              "input": {"command": "git status"}, "output": "", "error": ""}],
            measured=True,
        )
        self.assertIsNone(looked["productive_action"])

    def test_a_console_codec_cannot_kill_the_run(self):
        """The known-bad input: a cp1251 stream and a u-umlaut.

        That pair ended a nine-session matrix at session five with
        UnicodeEncodeError and threw away four measured sessions.
        """
        import io

        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1251", errors="strict")
        with self.assertRaises(UnicodeEncodeError):
            stream.write("für")
            stream.flush()

        raw = io.BytesIO()
        stream = io.TextIOWrapper(raw, encoding="cp1251", errors="strict")
        polygon.force_utf8_console(stream)
        stream.write("für")
        stream.flush()
        self.assertIn("f", raw.getvalue().decode("utf-8"))

    def test_the_report_is_on_disk_before_the_next_session_can_crash(self):
        """Live model time is the expensive part; a run that persists only at
        the end loses all of it to any crash in the loop."""
        out = Path(tempfile.mkdtemp(prefix="polygon-out-"))
        self.addCleanup(shutil.rmtree, out, True)
        report = {"sessions": [{"condition": "healthy", "note": "für"}]}
        self.assertTrue(polygon._write_report(str(out), report))
        written = json.loads((out / "polygon.json").read_text(encoding="utf-8"))
        self.assertEqual(written["sessions"][0]["note"], "für")
        self.assertFalse(polygon._write_report(None, report))

    def test_isolation_separates_contamination_from_a_concurrent_operator(self):
        """Measured 2026-09-16: an operator checkpointing in the main
        repository while the matrix ran scored a clean `healthy` session
        isolation=FAIL. "this repository moved" answers two questions."""
        repo = Path("V:/repo")
        clean = {
            "canonical_changed": ["BOARD.md"],
            "repository_canonical_changed": [],
            "owner_repository": {"T-1": ["V:/fixture"]},
        }
        self.assertEqual(polygon.isolation_verdict(clean, repo), polygon.ISOLATION_PASS)

        contaminated = {
            "canonical_changed": ["BOARD.md"],
            "repository_canonical_changed": ["BOARD.md", "LOG.md"],
            "owner_repository": {"T-1": ["V:/fixture", str(repo)]},
        }
        self.assertEqual(polygon.isolation_verdict(contaminated, repo), polygon.ISOLATION_FAIL)

        concurrent = {
            "canonical_changed": ["BOARD.md"],
            "repository_canonical_changed": ["LOG.md"],
            "owner_repository": {"T-1": ["V:/fixture"]},
        }
        self.assertEqual(
            polygon.isolation_verdict(concurrent, repo), polygon.ISOLATION_INCONCLUSIVE
        )

    def test_a_session_that_did_nothing_is_not_contamination(self):
        """Measured 2026-09-17: `windows_path_task` ran 137s, called no tool,
        minted nothing, and left this repository byte-identical -- and the old
        rule opened with "the fixture did not move -> FAIL", convicting it of
        contamination it could not have committed. Whether the fixture moved is
        productivity, and `matrix_verdict.py` already judges that."""
        repo = Path("V:/repo")
        nothing = {
            "canonical_changed": [],
            "repository_canonical_changed": [],
            "owner_repository": {},
            "main_minted": {"tickets": [], "receipts": []},
        }
        self.assertEqual(polygon.isolation_verdict(nothing, repo), polygon.ISOLATION_PASS)

    def test_an_id_minted_in_this_repository_is_contamination(self):
        """The incident's own signature: the session's work landed HERE. The
        fixture's ledger cannot show it -- the fixture never got the write --
        so the witness is this repository's own ledger gaining an id while a
        fixture session ran."""
        repo = Path("V:/repo")
        leaked = {
            "canonical_changed": [],
            "repository_canonical_changed": ["BOARD.md", "intake/index.json"],
            "owner_repository": {},
            "main_minted": {"tickets": ["T-1371"], "receipts": ["SRC-047"]},
        }
        self.assertEqual(polygon.isolation_verdict(leaked, repo), polygon.ISOLATION_FAIL)


    def test_each_condition_gets_the_task_its_name_promises(self):
        project = Path(tempfile.mkdtemp(prefix="t1363-tasks-"))
        self.addCleanup(lambda: shutil.rmtree(project, ignore_errors=True))
        self.assertEqual(polygon.condition_task("long_file_task", project), polygon.LONG_TASK)
        self.assertEqual(
            polygon.condition_task("windows_path_task", project),
            polygon.windows_path_task(project),
        )
        self.assertEqual(
            polygon.condition_task("windows_path_missing", project), polygon.FIELD_TASK
        )
        for name in self.DECLARED:
            if name not in ("long_file_task", "windows_path_task"):
                self.assertEqual(polygon.condition_task(name, project), polygon.SIMPLE_TASK)


class HostStoreMeasurementTests(unittest.TestCase):
    """The second source for the same facts, and the traps it must not fall in.

    A transcript the host did not print is not a session that did nothing:
    OpenCode writes every part it produces into its own store as it goes. The
    harness reads that store ONLY as a fallback, and only for a session it can
    prove is this one -- a fallback that adopts whatever ran most recently
    would quietly report another project's work as this condition's result.
    """

    SCHEMA = (
        "create table session (id text, project_id text, workspace_id text, "
        "parent_id text, slug text, directory text, path text, title text, "
        "version text, time_created integer, time_updated integer)",
        "create table part (id text, message_id text, session_id text, "
        "time_created integer, time_updated integer, data text)",
    )

    def store(self, rows, parts) -> Path:
        import sqlite3

        path = Path(tempfile.mkdtemp(prefix="t1367-store-")) / "opencode.db"
        self.addCleanup(lambda: shutil.rmtree(path.parent, ignore_errors=True))
        con = sqlite3.connect(path)
        for statement in self.SCHEMA:
            con.execute(statement)
        for session_id, directory, created in rows:
            con.execute(
                "insert into session (id, directory, time_created) values (?, ?, ?)",
                (session_id, directory, created),
            )
        for index, (session_id, data) in enumerate(parts):
            con.execute(
                "insert into part (id, message_id, session_id, time_created, data) "
                "values (?, ?, ?, ?, ?)",
                (f"prt_{index}", "msg_1", session_id, index, json.dumps(data)),
            )
        con.commit()
        con.close()
        return path

    @staticmethod
    def tool_part(command: str) -> dict:
        return {
            "type": "tool",
            "tool": "bash",
            "state": {"status": "completed", "input": {"command": command}, "output": ""},
        }

    def test_the_store_measures_a_session_whose_stdout_said_nothing(self):
        project = Path(tempfile.mkdtemp(prefix="t1367-fixture-"))
        self.addCleanup(lambda: shutil.rmtree(project, ignore_errors=True))
        store = self.store(
            [("ses_this", str(project), 5000)],
            [
                ("ses_this", self.tool_part("saipen start 'x'")),
                ("ses_this", self.tool_part("python -m pip list")),
            ],
        )
        parts = polygon._host_store_parts(project, 1000, None, store=store)
        self.assertEqual(len(parts), 2)
        seen = polygon.measure(polygon._part_tool_events(parts), measured=bool(parts))
        self.assertEqual(seen["measurement"], polygon.MEASURED)
        self.assertEqual(seen["first_saipen_command"], "saipen start 'x'")
        self.assertEqual(seen["protocol_commands_before_productive"], 1)
        self.assertEqual(seen["productive_action"], "shell")

    def test_a_session_in_another_project_is_never_adopted(self):
        """The trap: 'the newest session' is not 'this session'."""
        project = Path(tempfile.mkdtemp(prefix="t1367-fixture-"))
        other = Path(tempfile.mkdtemp(prefix="t1367-other-"))
        for path in (project, other):
            self.addCleanup(lambda p=path: shutil.rmtree(p, ignore_errors=True))
        store = self.store(
            [("ses_other", str(other), 9000)],
            [("ses_other", self.tool_part("saipen start 'not ours'"))],
        )
        self.assertEqual(polygon._host_store_parts(project, 1000, None, store=store), [])

    def test_a_session_older_than_this_run_is_never_adopted(self):
        project = Path(tempfile.mkdtemp(prefix="t1367-fixture-"))
        self.addCleanup(lambda: shutil.rmtree(project, ignore_errors=True))
        store = self.store(
            [("ses_old", str(project), 500)],
            [("ses_old", self.tool_part("saipen start 'yesterday'"))],
        )
        self.assertEqual(polygon._host_store_parts(project, 1000, None, store=store), [])

    def test_a_named_session_is_read_by_identity_not_by_recency(self):
        project = Path(tempfile.mkdtemp(prefix="t1367-fixture-"))
        self.addCleanup(lambda: shutil.rmtree(project, ignore_errors=True))
        store = self.store(
            [("ses_ours", str(project), 5000), ("ses_newer", str(project), 9000)],
            [
                ("ses_ours", self.tool_part("saipen start 'ours'")),
                ("ses_newer", self.tool_part("saipen start 'newer'")),
            ],
        )
        parts = polygon._host_store_parts(project, 1000, "ses_ours", store=store)
        self.assertEqual(len(parts), 1)
        events = polygon._part_tool_events(parts)
        self.assertEqual(events[0]["input"]["command"], "saipen start 'ours'")

    def test_an_empty_store_leaves_the_session_unmeasured(self):
        """The known-blind half: no stdout AND no store is still UNMEASURED."""
        project = Path(tempfile.mkdtemp(prefix="t1367-fixture-"))
        self.addCleanup(lambda: shutil.rmtree(project, ignore_errors=True))
        store = self.store([], [])
        parts = polygon._host_store_parts(project, 1000, None, store=store)
        self.assertEqual(parts, [])
        blind = polygon.measure(polygon._part_tool_events(parts), measured=bool(parts))
        self.assertEqual(blind["measurement"], polygon.UNMEASURED)
        self.assertIsNone(blind["protocol_commands_before_productive"])

    def test_a_missing_store_is_not_a_crash(self):
        project = Path(tempfile.mkdtemp(prefix="t1367-fixture-"))
        self.addCleanup(lambda: shutil.rmtree(project, ignore_errors=True))
        absent = project / "no-such-store.db"
        self.assertEqual(polygon._host_store_parts(project, 0, None, store=absent), [])


class RefusalCountingTests(unittest.TestCase):
    """A success code is not a refusal, and a repeat of one is not a loop.

    Measured on the 17.09 smoke: the extractor scraped every `"code"` field out
    of tool output, so `healthy` reported a refusal called `CLAIMED` and
    `long_file_task` reported `repeated_refusal: ['CHECKPOINTED']` -- the model
    convicted of looping on the two operations that mean it was working.
    """

    @staticmethod
    def tool(output: str, command: str = "saipen checkpoint RUN T-1 'x' --json") -> dict:
        """One tool event that RAN a saipen command and got `output` back.

        The command matters: after T-1377 a refusal counts as received only when
        the session ran `saipen` (or the guard emitted its own marker), because
        three field sessions grepped this repository and the old extractor
        scored the `REFUSE [CODE]` in a docstring as a refusal they got.
        """
        return {
            "tool": "bash",
            "status": "completed",
            "input": {"command": command},
            "output": output,
            "error": "",
        }

    def test_a_successful_operation_is_not_a_refusal(self):
        codes = polygon._refusal_codes(
            [
                self.tool('{"ok": true, "code": "CHECKPOINTED", "event_id": "E-1"}'),
                self.tool('{"ok": true, "code": "CLAIMED", "phase": "SCOUT"}'),
                self.tool('{"ok": true, "code": "TRANSITIONED"}'),
            ]
        )
        self.assertEqual(codes, [])

    def test_a_refused_operation_is_counted_however_it_is_spelled(self):
        codes = polygon._refusal_codes(
            [
                self.tool('{"ok": false, "code": "NO_ACTIVE_WORK", "detail": "x"}'),
                self.tool("REFUSE [SOURCE_UNRESOLVED] the request could not be captured"),
                {
                    "tool": "bash",
                    "status": "error",
                    "input": {"command": "echo hi > .saipen/STATE.md"},
                    "output": "",
                    "error": "SAIPEN_GUARD_REFUSAL: PROTECTED_CANONICAL_NAMESPACE",
                },
            ]
        )
        self.assertEqual(
            codes, ["NO_ACTIVE_WORK", "SOURCE_UNRESOLVED", "PROTECTED_CANONICAL_NAMESPACE"]
        )

    def test_two_human_mode_refusals_with_different_reasons_are_two(self):
        """T-1380: the CLI prints the sentence on the line AFTER `REFUSE [CODE]`.

        Matching only the rest of the first line captured an empty message for
        every human-mode refusal, so `saipen ship` refusing over a missing
        VERSION and `ticket done` refusing over a surplus `--paths` shared one
        identity -- and the final matrix scored two conditions as looping when
        each had simply hit two different problems.
        """
        seen = polygon.measure(
            [
                self.tool(
                    "REFUSE [VALIDATION_FAILED]\r\nreason: VERSION is missing from the "
                    "repository root",
                    command="saipen ship 2>&1",
                ),
                self.tool(
                    "REFUSE [VALIDATION_FAILED]\r\nreason: --paths is only valid with "
                    "closure_mode cohort",
                    command="saipen ticket done T-1 --paths src/app.py 2>&1",
                ),
            ],
            measured=True,
        )
        self.assertEqual(seen["refusal_sequence"], ["VALIDATION_FAILED", "VALIDATION_FAILED"])
        self.assertEqual(seen["repeated_refusal"], [])

    def test_the_same_human_mode_refusal_twice_is_still_a_repeat(self):
        payload = "REFUSE [VALIDATION_FAILED]\r\nreason: VERSION is missing"
        seen = polygon.measure(
            [self.tool(payload, command="saipen ship 2>&1")] * 2, measured=True
        )
        self.assertEqual(seen["repeated_refusal"], ["VALIDATION_FAILED"])

    def test_a_mixed_transcript_counts_only_the_refusals(self):
        seen = polygon.measure(
            [
                self.tool('{"ok": false, "code": "NO_ACTIVE_WORK"}'),
                self.tool('{"ok": true, "code": "CHECKPOINTED"}'),
                self.tool('{"ok": false, "code": "NO_ACTIVE_WORK"}'),
            ],
            measured=True,
        )
        self.assertEqual(seen["refusal_sequence"], ["NO_ACTIVE_WORK", "NO_ACTIVE_WORK"])
        self.assertEqual(seen["repeated_refusal"], ["NO_ACTIVE_WORK"])


class TheHarnessDeclaresTheOperatorTaskTests(unittest.TestCase):
    """T-1376: the harness knows the request, so it says so to the protocol.

    Measured 2026-09-17: `long_file_task` substituted 46 characters for a
    520-byte request and every gate agreed, because nothing in the session knew
    what the operator had actually asked. The harness DOES know -- it hands the
    task to the host itself -- so it declares the digest and the matrix can
    measure which of the two honest outcomes happened: the operator's own bytes
    arrived, or the ingress was refused.
    """

    def test_the_child_environment_declares_the_task_file(self):
        """T-1380: by FILE, so a refused session has bytes it can carry."""
        from saipen_engine import operator_task
        from saipen_engine.pending_ingress import ingress_digest

        project = Path(tempfile.mkdtemp(prefix="t1376-fixture-"))
        self.addCleanup(lambda: shutil.rmtree(project, ignore_errors=True))
        env = polygon._task_env(project, polygon.LONG_TASK)
        declared = Path(env[operator_task.ENV_TASK_FILE])
        self.assertTrue(declared.is_file(), declared)
        self.assertEqual(declared.read_text(encoding="utf-8"), polygon.LONG_TASK)
        self.assertEqual(
            operator_task.declared(env)["digest"], ingress_digest(polygon.LONG_TASK)
        )
        self.assertEqual(env["PWD"], str(project))

    def test_each_condition_declares_its_own_task(self):
        """A digest copied from another condition would witness the wrong words."""
        from saipen_engine import operator_task

        project = Path(tempfile.mkdtemp(prefix="t1376-fixture-"))
        self.addCleanup(lambda: shutil.rmtree(project, ignore_errors=True))
        digests = {
            name: operator_task.declared(
                polygon._task_env(project, polygon.condition_task(name, project))
            )["digest"]
            for name in polygon.CONDITION_NAMES
        }
        self.assertNotEqual(digests["long_file_task"], digests["healthy"])
        self.assertNotEqual(digests["windows_path_task"], digests["healthy"])


class WindowsPathAuthorityTests(unittest.TestCase):
    """SRC-055 section 6: the positive Windows-path case must be executable.

    `windows_path_task` named `V:\\_TEMP_\\fastprompter_drag\\SAIPENVIEW_main.py`,
    which does not exist on this machine. The 17.09 session read the task,
    looked, found nothing and refused to invent the notes -- the correct answer
    -- and the matrix scored it as broken Windows-path transport. A positive
    case whose authority is missing can only ever measure the model declining
    to hallucinate.
    """

    class _Case:
        def addCleanup(self, _fn):
            return None

    def build(self) -> Path:
        root = polygon.condition_builders()["windows_path_task"](self._Case())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        return root

    def test_the_positive_task_names_a_real_readable_file(self):
        import re

        root = self.build()
        task = polygon.condition_task("windows_path_task", root)
        named = re.search(r"([A-Za-z]:\\.+\.txt)$", task)
        self.assertIsNotNone(named, task)
        path = named.group(1)
        self.assertRegex(path, r"^[A-Za-z]:\\", "no drive colon and backslash")
        self.assertIn(" ", path, "no space in the path")
        self.assertTrue(Path(path).is_file(), f"the task names a file that is not there: {path}")
        value = polygon.notes_value(root)
        self.assertTrue(value)
        self.assertIn(f"{polygon.NOTES_KEY}={value}", Path(path).read_text(encoding="utf-8"))
        self.assertNotIn(value, (root / "src" / "app.py").read_text(encoding="utf-8"))

    def test_each_fixture_holds_its_own_value(self):
        """A value shared across runs could be remembered instead of read."""
        self.assertNotEqual(polygon.notes_value(self.build()), polygon.notes_value(self.build()))

    def test_the_missing_path_is_a_separate_negative_control(self):
        import re

        self.assertNotIn("windows_path_missing", polygon.CONDITION_NAMES)
        self.assertIn("windows_path_missing", polygon.NEGATIVE_CONTROLS)
        self.assertIn("windows_path_missing", polygon.negative_control_builders())
        missing = re.search(r"[A-Za-z]:\\\S+", polygon.FIELD_TASK).group(0)
        self.assertFalse(Path(missing).exists(), missing)

    def test_a_targeted_run_builds_only_what_it_names(self):
        built = polygon.conditions(["windows_path_missing"])
        for root in built.values():
            self.addCleanup(lambda root=root: shutil.rmtree(root, ignore_errors=True))
        self.assertEqual(list(built), ["windows_path_missing"])
        with self.assertRaises(ValueError):
            polygon.conditions(["no_such_condition"])


class InfrastructureFailureTests(unittest.TestCase):
    """SRC-055 section 7: a provider error before any tool is not a result.

    Measured twice on `long_file_task` (17.09): exit 1 with `Unexpected server
    error` before the first tool, recorded as MEASURED with
    `protocol_commands_before_productive: 0`.
    """

    STDERR = (
        '\x1b[91m\x1b[1mError: \x1b[0m{\n  "name": "UnknownError",\n  "data": '
        '{\n    "message": "Unexpected server error. Check server logs for details."\n  }\n}\n'
    )

    def test_a_provider_error_before_any_tool_is_infrastructure(self):
        reason = polygon.infrastructure_failure(1, [], [], self.STDERR)
        self.assertIsNotNone(reason)
        self.assertIn("Unexpected server error", reason)
        self.assertNotIn("\x1b", reason)

    def test_an_error_event_with_a_clean_exit_is_still_infrastructure(self):
        event = {"type": "error", "error": {"name": "UnknownError"}}
        self.assertIsNotNone(polygon.infrastructure_failure(0, [], [event], ""))

    def test_a_session_that_acted_is_measured_whatever_the_exit_code(self):
        """The known-good control: tools ran, so the transcript is a measurement."""
        tool = {"tool": "read", "status": "completed", "input": {}, "output": "", "error": ""}
        self.assertIsNone(polygon.infrastructure_failure(1, [tool], [], self.STDERR))

    def test_a_quiet_clean_session_is_not_infrastructure(self):
        self.assertIsNone(polygon.infrastructure_failure(0, [], [], ""))

    def test_failures_are_retried_a_bounded_number_of_times(self):
        calls = []

        def run_once():
            calls.append(1)
            return {
                "measurement": polygon.INFRASTRUCTURE_UNMEASURED,
                "returncode": 1,
                "infrastructure_error": "Unexpected server error",
            }

        record = polygon.drive_with_retries(run_once, 2, lambda: True)
        self.assertEqual(len(calls), 3)
        self.assertEqual(record["measurement"], polygon.INFRASTRUCTURE_UNMEASURED)
        self.assertEqual([a["attempt"] for a in record["attempts"]], [1, 2, 3])

    def test_a_measured_attempt_ends_the_retries(self):
        outcomes = iter(
            [
                {"measurement": polygon.INFRASTRUCTURE_UNMEASURED, "returncode": 1},
                {"measurement": polygon.MEASURED, "returncode": 0},
                {"measurement": polygon.MEASURED, "returncode": 0},
            ]
        )
        record = polygon.drive_with_retries(lambda: dict(next(outcomes)), 5, lambda: True)
        self.assertEqual(record["measurement"], polygon.MEASURED)
        self.assertEqual(len(record["attempts"]), 2)

    def test_a_fixture_that_moved_is_never_redriven(self):
        calls = []

        def run_once():
            calls.append(1)
            return {"measurement": polygon.INFRASTRUCTURE_UNMEASURED, "returncode": 1}

        polygon.drive_with_retries(run_once, 5, lambda: False)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
