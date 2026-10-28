"""T-1372: a paraphrase cannot buy the receipt the operator's own words own.

The field transcript this exists for. On 2026-09-16 the T-1367 polygon ran
`sairoute/SAIFREN` against fixture `V:/_TEMP_/t1363-qha52ype` with an ordinary
operator request: 520 bytes over 12 lines, four explicit constraints. The
payload cannot survive one quoted shell argument, so the guard refused it and
named the transport that carries it -- `saipen start --file <path>`. The
session then ran `saipen start` with a 179-byte paraphrase it wrote itself.
Every operator constraint vanished, and `.saipen/intake/active/SRC-001.md` held
the model's words with meta asserting mode `exact`, `original_available` true
and a body digest matching its own meta: internally consistent, so BOARD title,
coverage, closure and every downstream gate read green over text the operator
never wrote.

`BOOT.md` says "Never reword the user's task to get past a refusal" and nothing
measured it. These controls are that measurement: what the refusal refused is
recorded, and the next ingress either carries those exact bytes or says out
loud that the operator changed the request.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import guard_events, pending_ingress  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import cli, healthy, receipts_of  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


#: The measured field payload's shape: multi-line, quote-hostile, and far past
#: the hex ceiling, so the guard answers `--file` exactly as it did live.
OPERATOR_REQUEST = (
    "Rewrite the greeting in src/app.py so it reads as one paragraph.\n"
    "\n"
    "Constraints, all four of them:\n"
    "1. one paragraph, no bullet list;\n"
    "2. plain wording, no marketing adjectives;\n"
    "3. write it from the file own text, do not invent product claims;\n"
    "4. report the exact line number you changed when you are done.\n"
    "\n"
    "Do not touch any other file, do not reformat the module, and do not\n"
    "add a docstring where there was none. If the file cannot be read,\n"
    "say so and stop instead of guessing what it probably said.\n"
)

#: What the model actually started with. Shorter, quotable, and missing every
#: constraint -- the exact failure this ticket exists for.
PARAPHRASE = "Rewrite the greeting in src/app.py to read better and report the line."


def shell_event(command: str, cwd: Path) -> dict:
    return {
        "event": "PreToolUse",
        "host": "opencode",
        "tool_name": "bash",
        "tool_input": {"command": command},
        "cwd": str(cwd),
        "actor": "test-agent",
    }


def refuse_the_request(root: Path) -> dict:
    """The guard refusal the field session got, against THIS project."""
    return guard_events.evaluate_event(
        shell_event("saipen start '" + OPERATOR_REQUEST + "'", root),
        project_root=str(root),
    )


class RefusedIngressIsRecordedTests(unittest.TestCase):
    """(1) The refusal that names a transport records WHICH bytes it refused."""

    def test_oversized_literal_ingress_records_its_digest(self):
        root = healthy(self)
        verdict = refuse_the_request(root)
        self.assertFalse(verdict["admitted"])
        self.assertEqual(verdict["code"], "INGRESS_TRANSPORT_UNSAFE")
        self.assertEqual(verdict["canonical_next_command"], "saipen start --file <path>")

        found = pending_ingress.pending(root)
        self.assertIsNotNone(found, "the refusal recorded nothing to compare against")
        self.assertEqual(found["digest"], pending_ingress.ingress_digest(OPERATOR_REQUEST))
        self.assertEqual(found["route"], "saipen start --file <path>")
        self.assertEqual(found["bytes"], len(OPERATOR_REQUEST.strip().encode("utf-8")))

    def test_a_quotable_ingress_records_nothing(self):
        """No false pending: only a refused transport opens this obligation."""
        root = healthy(self)
        verdict = guard_events.evaluate_event(
            shell_event("saipen start 'fix the login bug'", root), project_root=str(root)
        )
        self.assertIsNone(verdict.get("canonical_next_command"))
        self.assertIsNone(pending_ingress.pending(root))

    def test_digest_is_stable_across_transport_spelling(self):
        """The same words written to a file are the same request.

        A host write tool ends lines with CRLF and adds a trailing newline; the
        shell payload had neither. A digest that disagreed over that would
        refuse the operator's own bytes for arriving by the route the refusal
        itself demanded.
        """
        crlf = OPERATOR_REQUEST.replace("\n", "\r\n") + "\r\n"
        self.assertEqual(
            pending_ingress.ingress_digest(crlf),
            pending_ingress.ingress_digest(OPERATOR_REQUEST),
        )
        self.assertNotEqual(
            pending_ingress.ingress_digest(PARAPHRASE),
            pending_ingress.ingress_digest(OPERATOR_REQUEST),
        )


class ParaphraseIsRefusedTests(unittest.TestCase):
    """(2) Different text while an ingress is pending is refused, with the route."""

    def setUp(self):
        self.root = healthy(self)
        refuse_the_request(self.root)
        self.assertIsNotNone(pending_ingress.pending(self.root))

    def test_a_different_payload_is_refused_naming_digest_and_command(self):
        code, payload, output = cli(self.root, "start", PARAPHRASE, "--json")
        self.assertNotEqual(code, 0, output)
        self.assertIsNotNone(payload, output)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "INGRESS_PARAPHRASE_REFUSED")
        digest = pending_ingress.ingress_digest(OPERATOR_REQUEST)
        self.assertIn(digest[:16], json.dumps(payload))
        self.assertEqual(payload["canonical_next_command"], "saipen start --file <path>")
        self.assertIn("--supersede-ingress", json.dumps(payload))

    def test_the_refusal_captures_nothing(self):
        """A refused paraphrase must not leave a receipt to be believed later."""
        cli(self.root, "start", PARAPHRASE, "--json")
        self.assertEqual(receipts_of(self.root), [])
        self.assertIsNotNone(pending_ingress.pending(self.root))


class OriginalBytesClearTheObligationTests(unittest.TestCase):
    """(3) The refusal's own transport, carrying the operator's bytes, works."""

    def test_file_transport_starts_and_clears_the_pending_record(self):
        root = healthy(self)
        refuse_the_request(root)
        task = root / "task.txt"
        task.write_text(OPERATOR_REQUEST, encoding="utf-8")

        code, payload, output = cli(root, "start", "--file", str(task), "--json")
        self.assertEqual(code, 0, output)
        self.assertEqual(payload["code"], "STARTED", output)
        self.assertIsNone(pending_ingress.pending(root), "the obligation outlived its answer")

        receipts = receipts_of(root)
        self.assertEqual(len(receipts), 1, receipts)
        body = (root / ".saipen" / "intake" / "active" / (receipts[0] + ".md")).read_text(
            encoding="utf-8"
        )
        self.assertIn("report the exact line number you changed", body)


class OperatorSupersedeTests(unittest.TestCase):
    """(4) A person who genuinely changed the request can say so."""

    def test_supersede_starts_the_new_text_and_clears_the_record(self):
        root = healthy(self)
        refuse_the_request(root)
        code, payload, output = cli(root, "start", PARAPHRASE, "--supersede-ingress", "--json")
        self.assertEqual(code, 0, output)
        self.assertEqual(payload["code"], "STARTED", output)
        self.assertIsNone(pending_ingress.pending(root))
        self.assertEqual(len(receipts_of(root)), 1)

    def test_supersede_without_a_pending_record_is_not_an_error(self):
        root = healthy(self)
        code, payload, output = cli(
            root, "start", "fix the login bug", "--supersede-ingress", "--json"
        )
        self.assertEqual(code, 0, output)
        self.assertEqual(payload["code"], "STARTED", output)


class MalformedRecordFailsClosedTests(unittest.TestCase):
    """An unreadable obligation is not an absent one."""

    def test_unreadable_pending_record_refuses_with_a_route_out(self):
        root = healthy(self)
        path = pending_ingress.pending_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        code, payload, output = cli(root, "start", PARAPHRASE, "--json")
        self.assertNotEqual(code, 0, output)
        self.assertEqual(payload["code"], "INGRESS_PENDING_UNREADABLE")
        self.assertIn("--supersede-ingress", json.dumps(payload))


class BothIngressDoorsTests(unittest.TestCase):
    """`start` and `user-request` are the two ingress verbs; both owe the bytes.

    Closing one door and leaving the other open would have made the fix a
    rename of the route a paraphrase takes, not a rule about the operator's
    words.
    """

    def test_user_request_is_refused_while_the_ingress_is_owed(self):
        root = healthy(self)
        refuse_the_request(root)
        code, payload, output = cli(root, "user-request", PARAPHRASE, "--json")
        self.assertNotEqual(code, 0, output)
        self.assertEqual(payload["code"], "INGRESS_PARAPHRASE_REFUSED")
        self.assertEqual(receipts_of(root), [])

    def test_user_request_carrying_the_original_bytes_succeeds(self):
        root = healthy(self)
        refuse_the_request(root)
        code, _payload, output = cli(root, "user-request", OPERATOR_REQUEST, "--json")
        self.assertEqual(code, 0, output)
        self.assertIsNone(pending_ingress.pending(root))
        self.assertEqual(len(receipts_of(root)), 1)


class StaleObligationTests(unittest.TestCase):
    """An obligation nobody remembers earning cannot hold a later operator."""

    def test_an_expired_record_is_not_enforced(self):
        root = healthy(self)
        refuse_the_request(root)
        path = pending_ingress.pending_path(root)
        entry = json.loads(path.read_text(encoding="utf-8"))
        entry["recorded"] = "2020-01-01T00:00:00Z"
        path.write_text(json.dumps(entry), encoding="utf-8")

        self.assertIsNone(pending_ingress.pending(root))
        code, payload, output = cli(root, "start", PARAPHRASE, "--json")
        self.assertEqual(code, 0, output)
        self.assertEqual(payload["code"], "STARTED", output)


class TheObligationCannotBeDeletedAwayTests(unittest.TestCase):
    """A gate a session can simply erase is a suggestion.

    The record lives under the protected canonical namespace, so the guard
    answers every attempt to remove it the way it answers any other write into
    `.saipen/` -- refused before execution, whatever shell dialect spells it.
    """

    def test_shell_deletion_of_the_record_is_not_admitted(self):
        root = healthy(self)
        refuse_the_request(root)
        for command in (
            "rm .saipen/recovery/pending-ingress.json",
            "del .saipen\\recovery\\pending-ingress.json",
            "python -c \"import os; os.remove('.saipen/recovery/pending-ingress.json')\"",
        ):
            verdict = guard_events.evaluate_event(
                shell_event(command, root), project_root=str(root)
            )
            self.assertFalse(verdict["admitted"], command)
            self.assertEqual(verdict["code"], "PROTECTED_CANONICAL_NAMESPACE", command)
        self.assertIsNotNone(pending_ingress.pending(root))


class PlanPurityTests(unittest.TestCase):
    """A preview cannot spend the obligation it is previewing."""

    def test_dry_run_answers_without_discharging_the_record(self):
        root = healthy(self)
        refuse_the_request(root)
        task = root / "task.txt"
        task.write_text(OPERATOR_REQUEST, encoding="utf-8")

        code, payload, output = cli(root, "start", "--file", str(task), "--dry-run", "--json")
        self.assertEqual(code, 0, output)
        self.assertEqual(payload["code"], "PLAN", output)
        self.assertIsNotNone(
            pending_ingress.pending(root), "a dry run discharged the operator's guarantee"
        )

        code, payload, output = cli(root, "start", "--file", str(task), "--json")
        self.assertEqual(payload["code"], "STARTED", output)
        self.assertIsNone(pending_ingress.pending(root))

    def test_dry_run_still_refuses_a_paraphrase(self):
        root = healthy(self)
        refuse_the_request(root)
        code, payload, output = cli(root, "start", PARAPHRASE, "--dry-run", "--json")
        self.assertNotEqual(code, 0, output)
        self.assertEqual(payload["code"], "INGRESS_PARAPHRASE_REFUSED")
        self.assertIsNotNone(pending_ingress.pending(root))


class InstrumentControlTests(unittest.TestCase):
    """The gate can fail: without the record, the same paraphrase is admitted."""

    def test_pre_fix_engine_admits_the_paraphrase(self):
        from saipen_engine import entry

        root = healthy(self)
        refuse_the_request(root)
        self.assertIsNotNone(pending_ingress.pending(root))

        # Patch the module OBJECT the engine itself holds, not the one this
        # test imported: `unittest discover -s tools` imports the package as
        # `saipen_engine.*` and `python -m unittest tools.test_pending_ingress`
        # imports it as `tools.saipen_engine.*`, so a control that patches its
        # own copy silently stops reverting anything under one of the two and
        # reports the gate green for the wrong reason.
        module = entry.pending_ingress
        original = module.pending
        module.pending = lambda _root: None  # the engine before this ticket
        try:
            result = entry.start_work(root, "test-agent", actor_source="explicit", text=PARAPHRASE)
        finally:
            module.pending = original
        self.assertEqual(result.get("code"), "STARTED", result)
        self.assertEqual(len(receipts_of(root)), 1)


if __name__ == "__main__":
    unittest.main()
