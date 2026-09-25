"""T-1383: `ticket add` names the move, not only the rule.

Measured 2026-09-17 in REVIEW of T-1380: the usage line read
`ticket add <PRIORITY> <text>` while every empty verify is refused, and the
INCOMPLETE_TICKET refusal carried no route and never mentioned --verify. A
session that had already read the board grammar needed three attempts and the
CLI source to create one ticket.

The same door also took any first word as the priority: `ticket add fix the
bug ...` wrote `[fix]`, a ticket cold recovery (`[P\\d]`) and entry never see.

These controls run the printed route itself: a route that does not create the
ticket is prose with a colon in it.
"""

from __future__ import annotations

import shlex
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import board_of, cli, healthy  # noqa: E402

PROOF = "<how DONE is proven>"


def setUpModule() -> None:
    isolate_host_session()


def run_route(case: unittest.TestCase, root: Path, route: str, proof: str) -> dict:
    """Type the printed route back, with only its DONE proof written in."""
    case.assertIn(PROOF, route)
    argv = shlex.split(route.replace(PROOF, proof))
    case.assertEqual(argv[0], "saipen", route)
    code, payload, text = cli(root, *argv[1:], "--json")
    case.assertEqual(code, 0, text)
    return payload


def board_line(root: Path, ticket: str) -> str:
    return board_of(root)["tickets"][ticket]["raw"]


class MissingVerifyTests(unittest.TestCase):
    def test_the_refusal_prints_the_same_ticket_with_verify(self):
        root = healthy(self)
        code, payload, text = cli(root, "ticket", "add", "P2", "add a docstring", "--json")
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], "INCOMPLETE_TICKET")
        self.assertIn("--verify", payload["detail"])
        self.assertEqual(
            payload["canonical_next_command"],
            f"saipen ticket add P2 'add a docstring' --verify '{PROOF}'",
        )

    def test_running_the_route_creates_that_ticket(self):
        root = healthy(self)
        _code, payload, _text = cli(root, "ticket", "add", "P2", "add a docstring", "--json")
        added = run_route(self, root, payload["canonical_next_command"], "the doc test passes")
        self.assertEqual(added["code"], "TICKET_ADDED")
        line = board_line(root, added["ticket"])
        self.assertIn("[P2] add a docstring | verify: the doc test passes", line)

    def test_a_placeholder_verify_gets_the_same_route(self):
        root = healthy(self)
        code, payload, text = cli(
            root, "ticket", "add", "P1", "wire the importer", "--verify", "TBD", "--json"
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(
            payload["canonical_next_command"],
            f"saipen ticket add P1 'wire the importer' --verify '{PROOF}'",
        )

    def test_text_that_cannot_be_typed_back_stays_a_placeholder(self):
        root = healthy(self)
        _code, payload, _text = cli(root, "ticket", "add", "P1", "fix the user's page", "--json")
        self.assertEqual(
            payload["canonical_next_command"],
            f"saipen ticket add P1 '<the ticket, one line>' --verify '{PROOF}'",
        )


class PriorityTests(unittest.TestCase):
    def test_a_word_in_the_priority_slot_is_refused_with_the_text_kept(self):
        root = healthy(self)
        before = board_of(root)["tickets"]
        code, payload, text = cli(
            root, "ticket", "add", "fix", "the", "bug", "--verify", "the bug test passes",
            "--json",
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], "VALIDATION_FAILED")
        self.assertIn("not P0-P9", payload["detail"])
        self.assertEqual(
            payload["canonical_next_command"],
            f"saipen ticket add <PRIORITY> 'fix the bug' --verify '{PROOF}'",
        )
        self.assertEqual(board_of(root)["tickets"], before, "nothing was written")

    def test_a_lowercase_priority_is_the_same_priority(self):
        root = healthy(self)
        code, payload, text = cli(
            root, "ticket", "add", "p1", "wire the importer", "--verify", "import test passes",
            "--json",
        )
        self.assertEqual(code, 0, text)
        self.assertIn("[P1] wire the importer", board_line(root, payload["ticket"]))

    def test_too_few_arguments_print_the_grammar_with_verify(self):
        root = healthy(self)
        code, payload, text = cli(root, "ticket", "add", "P1", "--json")
        self.assertNotEqual(code, 0, text)
        self.assertIn("--verify <proof>", payload["detail"])
        self.assertEqual(
            payload["canonical_next_command"],
            f"saipen ticket add P1 '<the ticket, one line>' --verify '{PROOF}'",
        )


class UsageTests(unittest.TestCase):
    def test_the_printed_grammar_names_verify_as_part_of_ticket_add(self):
        root = healthy(self)
        _code, _payload, text = cli(root, "--help")
        self.assertIn("ticket add <PRIORITY> <text> --verify <proof>", text)


if __name__ == "__main__":
    unittest.main()
