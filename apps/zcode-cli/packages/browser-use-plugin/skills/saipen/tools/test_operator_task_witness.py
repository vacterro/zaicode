"""T-1376: a receipt says whose words it holds.

Measured live on 2026-09-17, nine-condition matrix, installed generation
f3d2104a. `long_file_task` was handed a 520-byte request over twelve lines with
four explicit constraints and ran `saipen start` with a 46-character substitute
it wrote itself: `T-1` and `SRC-001` minted, `src/app.py` changed, every gate
green. T-1372's obligation never armed, because that mechanism records what a
transport refusal REFUSED and nothing refused anything -- the session never
attempted the literal ingress at all.

`source_authority: exact` was true and was being read as more than it says: it
is a statement about BYTES (the stored body is unredacted and whole), never
about WORDS. These controls pin the missing statement -- who compared the text
that arrived with what the operator actually wrote -- and the refusal that
happens when a declared task and the arriving text disagree.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import operator_task, pending_ingress  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import PYTHON, healthy, receipts_of  # noqa: E402

TASK = "add a one-line docstring to the top of src/app.py"
PARAPHRASE = "docstring for app"


def setUpModule() -> None:
    isolate_host_session()


def start(root: Path, text: str, **env_extra):
    """One real CLI start, with whatever the launcher declared."""
    env = {**os.environ}
    for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT",
                operator_task.ENV_TASK_SHA256, operator_task.ENV_TASK_FILE):
        env.pop(key, None)
    for key, value in env_extra.items():
        if value is not None:
            env[key] = value
    proc = subprocess.run(
        [
            PYTHON,
            str(REPO / "tools" / "saipen.py"),
            "start",
            text,
            "--json",
            "--project-root",
            str(root),
            "--agent",
            "test-agent",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
        env=env,
    )
    try:
        payload = json.loads(proc.stdout)
    except ValueError:
        payload = None
    return proc.returncode, payload, proc.stdout + proc.stderr


def start_raw(root: Path, command: list[str], carrier: dict):
    """The same CLI call, for a command whose arguments are not one task string."""
    env = {**os.environ}
    for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT",
                operator_task.ENV_TASK_SHA256, operator_task.ENV_TASK_FILE):
        env.pop(key, None)
    env.update(carrier)
    proc = subprocess.run(
        [PYTHON, str(REPO / "tools" / "saipen.py"), *command, "--json",
         "--project-root", str(root), "--agent", "test-agent"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=300, env=env,
    )
    try:
        payload = json.loads(proc.stdout)
    except ValueError:
        payload = None
    return proc.returncode, payload, proc.stdout + proc.stderr


def provenance_of(root: Path) -> dict:
    receipt = receipts_of(root)[0]
    meta = root / ".saipen" / "intake" / "active" / f"{receipt}.meta.json"
    return json.loads(meta.read_text(encoding="utf-8"))["request_provenance"]


class NobodyComparedItAndTheReceiptSaysSoTests(unittest.TestCase):
    """The ordinary case: no carrier, no obligation, and no pretending."""

    def test_an_unwitnessed_request_is_recorded_as_model_supplied(self):
        root = healthy(self)
        code, payload, text = start(root, TASK)
        self.assertEqual(code, 0, text)
        self.assertEqual(payload["code"], "STARTED", text)

        witness = provenance_of(root)
        self.assertEqual(witness["witness"], operator_task.WITNESS_MODEL)
        self.assertEqual(witness["compared_digest"], pending_ingress.ingress_digest(TASK))
        self.assertIn("nothing compared them", witness["note"])

    def test_model_supplied_is_not_a_refusal(self):
        """Most sessions have no carrier; inventing one would be the fabrication."""
        root = healthy(self)
        code, _payload, text = start(root, PARAPHRASE)
        self.assertEqual(code, 0, text)
        self.assertEqual(len(receipts_of(root)), 1)


class AnOperatorCarrierIsComparedTests(unittest.TestCase):
    """When the launcher declares the task, the receipt is witnessed by it."""

    def test_matching_text_records_the_carrier(self):
        root = healthy(self)
        code, _payload, text = start(
            root,
            TASK,
            **{operator_task.ENV_TASK_SHA256: hashlib.sha256(TASK.encode()).hexdigest()},
        )
        self.assertEqual(code, 0, text)
        witness = provenance_of(root)
        self.assertEqual(witness["witness"], operator_task.WITNESS_CARRIER)
        self.assertEqual(witness["declared_by"], operator_task.ENV_TASK_SHA256)

    def test_a_task_file_carries_it_when_a_digest_cannot(self):
        root = healthy(self)
        task_file = root / "launched-task.txt"
        task_file.write_text(TASK + "\r\n", encoding="utf-8")
        code, _payload, text = start(
            root, TASK, **{operator_task.ENV_TASK_FILE: str(task_file)}
        )
        self.assertEqual(code, 0, text)
        witness = provenance_of(root)
        self.assertEqual(witness["witness"], operator_task.WITNESS_CARRIER)
        self.assertEqual(witness["declared_by"], operator_task.ENV_TASK_FILE)

    def test_a_paraphrase_of_a_declared_task_is_refused_with_both_digests(self):
        """The measured failure, caught at the door this time."""
        root = healthy(self)
        declared = hashlib.sha256(TASK.encode()).hexdigest()
        code, payload, text = start(
            root, PARAPHRASE, **{operator_task.ENV_TASK_SHA256: declared}
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], operator_task.CODE_MISMATCH)
        self.assertEqual(payload["declared_digest"], declared)
        self.assertEqual(
            payload["supplied_digest"], pending_ingress.ingress_digest(PARAPHRASE)
        )
        self.assertEqual(receipts_of(root), [], "a refused ingress captured a receipt")

    def test_a_digest_only_mismatch_prints_no_route_it_cannot_run(self):
        """T-1380, measured: a route the session cannot run becomes a guess.

        `long_file_task` was refused, wrote its OWN paraphrase to a file, ran
        `saipen start --file` on that (refused again), then dumped the carrier
        variable and built a list of text variants to search for one hashing to
        it. A digest is irreversible; the refusal says so instead of implying
        the session can produce the bytes.
        """
        root = healthy(self)
        digest = hashlib.sha256(TASK.encode()).hexdigest()
        code, payload, text = start(
            root, PARAPHRASE, **{operator_task.ENV_TASK_SHA256: digest}
        )
        self.assertNotEqual(code, 0, text)
        self.assertIsNone(payload["canonical_next_command"])
        self.assertFalse(payload["operator_text_reachable"])
        self.assertIn("a digest is irreversible", payload["detail"])
        self.assertIn("do not try to reconstruct", payload["detail"])

    def test_a_file_carrier_mismatch_names_that_exact_file_and_it_works(self):
        """With the bytes on disk the refusal is answerable, and answered."""
        root = healthy(self)
        task_file = root / "launched-task.txt"
        task_file.write_text(TASK, encoding="utf-8")
        code, payload, text = start(
            root, PARAPHRASE, **{operator_task.ENV_TASK_FILE: str(task_file)}
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], operator_task.CODE_MISMATCH)
        self.assertTrue(payload["operator_text_reachable"])
        route = payload["canonical_next_command"]
        self.assertEqual(route, f'saipen start --file "{task_file}"')

        # Run exactly what it printed.
        env_key = {operator_task.ENV_TASK_FILE: str(task_file)}
        code, payload, text = start_raw(root, ["start", "--file", str(task_file)], env_key)
        self.assertEqual(code, 0, text)
        self.assertEqual(payload["code"], "STARTED", text)
        self.assertEqual(provenance_of(root)["witness"], operator_task.WITNESS_CARRIER)

    def test_a_malformed_carrier_fails_closed(self):
        """An environment that meant to declare a task and failed is not silence."""
        root = healthy(self)
        code, payload, text = start(root, TASK, **{operator_task.ENV_TASK_SHA256: "nonsense"})
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], operator_task.CODE_CARRIER_INVALID)
        self.assertEqual(receipts_of(root), [])

    def test_an_unreadable_task_file_fails_closed(self):
        root = healthy(self)
        code, payload, text = start(
            root, TASK, **{operator_task.ENV_TASK_FILE: str(root / "no-such-file.txt")}
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], operator_task.CODE_CARRIER_INVALID)


class TheTransportObligationIsAlsoAWitnessTests(unittest.TestCase):
    """T-1372's mechanism answers the same question for the refused case."""

    def test_bytes_that_answered_an_obligation_are_witnessed_by_it(self):
        from saipen_engine import guard_events

        root = healthy(self)
        long_task = (
            "Rewrite the greeting in src/app.py so it reads as one paragraph.\n"
            "Keep it plain, no marketing words, and say which line you changed.\n"
            "Do not touch any other file and do not reformat the module.\n"
        )
        guard_events.evaluate_event(
            {
                "event": "PreToolUse",
                "host": "opencode",
                "tool_name": "bash",
                "tool_input": {"command": "saipen start '" + long_task + "'"},
                "cwd": str(root),
                "actor": "test-agent",
            },
            project_root=str(root),
        )
        self.assertIsNotNone(pending_ingress.pending(root))

        task_file = root / "task.txt"
        task_file.write_text(long_task, encoding="utf-8")
        env = {**os.environ}
        for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT",
                    operator_task.ENV_TASK_SHA256, operator_task.ENV_TASK_FILE):
            env.pop(key, None)
        proc = subprocess.run(
            [
                PYTHON,
                str(REPO / "tools" / "saipen.py"),
                "start",
                "--file",
                str(task_file),
                "--json",
                "--project-root",
                str(root),
                "--agent",
                "test-agent",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            env=env,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(
            provenance_of(root)["witness"], operator_task.WITNESS_OBLIGATION
        )


class WitnessIsDecidedFromBytesTests(unittest.TestCase):
    """The unit half: what `declared` and `witness` do with each input."""

    def test_a_digest_carrier_is_read_as_declared(self):
        digest = hashlib.sha256(TASK.encode()).hexdigest()
        record = operator_task.declared({operator_task.ENV_TASK_SHA256: digest})
        self.assertEqual(record, {"digest": digest, "source": operator_task.ENV_TASK_SHA256})

    def test_no_carrier_is_none_not_an_error(self):
        self.assertIsNone(operator_task.declared({}))

    def test_line_endings_do_not_change_the_answer(self):
        """A launcher's file and a shell payload are the same request."""
        outcome = operator_task.witness(
            TASK + "\r\n",
            env={operator_task.ENV_TASK_SHA256: pending_ingress.ingress_digest(TASK)},
        )
        self.assertEqual(outcome["witness"], operator_task.WITNESS_CARRIER)

    def test_an_oversized_task_file_is_refused(self):
        root = healthy(self)
        big = root / "big.txt"
        big.write_text("x" * (operator_task.MAX_TASK_FILE_BYTES + 1), encoding="utf-8")
        record = operator_task.declared({operator_task.ENV_TASK_FILE: str(big)})
        self.assertIn("larger than", record["error"])


class TheFileRouteSurvivesEveryShellTests(unittest.TestCase):
    """T-1380 REVIEW F1: a route is only a route in the shell that types it.

    Measured in four real shells: the unquoted `saipen start --file V:\\...` was
    intact in PowerShell 5, pwsh 7 and cmd, and Git Bash handed the CLI
    `V:_TEMP_...` with every backslash consumed; a path with a space split in
    all four. The live proof had passed only because OpenCode on that host runs
    PowerShell and the fixture path had no space.

    Each available shell here TYPES the printed route -- its arguments exactly
    as the refusal printed them, after an explicit interpreter in place of the
    `saipen` shim -- for a task file whose directories contain spaces, and the
    CLI must reach STARTED holding the operator's own bytes.
    """

    GIT_BASH = Path(r"C:\Program Files\Git\usr\bin\bash.exe")

    def shells(self) -> list[str]:
        import shutil

        found = ["bash"] if self.GIT_BASH.is_file() or shutil.which("bash") else []
        found += [name for name in ("powershell", "pwsh", "cmd") if shutil.which(name)]
        return found

    def refused_route(self) -> tuple[Path, Path, str]:
        import shutil
        import tempfile

        root = healthy(self)
        holder = Path(tempfile.mkdtemp(prefix="t1380 route "))
        self.addCleanup(lambda: shutil.rmtree(holder, ignore_errors=True))
        task_file = holder / "operator notes" / "launched task.txt"
        task_file.parent.mkdir()
        task_file.write_text(TASK, encoding="utf-8")
        code, payload, text = start(
            root, PARAPHRASE, **{operator_task.ENV_TASK_FILE: str(task_file)}
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], operator_task.CODE_MISMATCH, payload)
        route = payload["canonical_next_command"]
        self.assertTrue(route and route.startswith("saipen start --file "), payload)
        return root, task_file, route

    def command(self, shell: str, route: str, root: Path):
        import shutil
        import tempfile

        arguments = route[len("saipen ") :]
        py, cli = PYTHON, str(REPO / "tools" / "saipen.py")
        if shell == "bash":
            bash = str(self.GIT_BASH) if self.GIT_BASH.is_file() else shutil.which("bash")
            holder = Path(tempfile.mkdtemp(prefix="t1380-typed-"))
            self.addCleanup(lambda: shutil.rmtree(holder, ignore_errors=True))
            script = holder / "typed.sh"
            posix = lambda value: str(value).replace("\\", "/")  # noqa: E731
            script.write_text(
                f'"{posix(py)}" "{posix(cli)}" {arguments} '
                f'--json --project-root "{posix(root)}" --agent test-agent\n',
                encoding="utf-8",
                newline="\n",
            )
            return [bash, str(script)]
        if shell == "cmd":
            return (
                f'cmd /d /c ""{py}" "{cli}" {arguments} '
                f'--json --project-root "{root}" --agent test-agent"'
            )
        return [
            shell,
            "-NoProfile",
            "-Command",
            f"& '{py}' '{cli}' {arguments} --json --project-root '{root}' --agent test-agent",
        ]

    def test_the_route_is_double_quoted(self):
        _root, task_file, route = self.refused_route()
        self.assertEqual(route, f'saipen start --file "{task_file}"')

    def test_every_available_shell_types_it_to_started(self):
        shells = self.shells()
        if not shells:
            self.skipTest("no shell available to type the route into")
        for shell in shells:
            with self.subTest(shell=shell):
                root, task_file, route = self.refused_route()
                env = {**os.environ, operator_task.ENV_TASK_FILE: str(task_file)}
                for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT",
                            operator_task.ENV_TASK_SHA256):
                    env.pop(key, None)
                proc = subprocess.run(
                    self.command(shell, route, root),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=300,
                    env=env,
                )
                out = proc.stdout
                self.assertIn("{", out, f"{shell}: {out[-400:]} {proc.stderr[-400:]}")
                payload, _end = json.JSONDecoder().raw_decode(out[out.index("{"):])
                self.assertEqual(payload.get("code"), "STARTED", f"{shell}: {payload}")
                self.assertEqual(provenance_of(root)["witness"], operator_task.WITNESS_CARRIER)

    def test_a_path_no_quoted_argument_carries_gets_no_route(self):
        for hostile in (r"C:\tasks\$HOME\task.txt", 'C:\\tasks\\a"b.txt', "C:\\tasks\\"):
            with self.subTest(path=hostile):
                self.assertIsNone(operator_task.file_route(hostile))


if __name__ == "__main__":
    unittest.main()
