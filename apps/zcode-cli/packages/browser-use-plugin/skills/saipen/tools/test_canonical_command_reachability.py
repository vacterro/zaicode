"""T-1357: a command the engine prints must be one its own guard can admit.

Measured live on `__SAITULS`. `guard_events._saipen_cli_verb` refuses any
command containing a character in `_SHELL_SYNTAX_CHARS`, and both quote
characters are in that set -- deliberately, because quoting is how a compound
expression hides inside a line that looks canonical. The engine's own
`canonical_next_command` for a gated blocker was
`saipen recover resolve-blocker "<decision>"`, so the operator's only sanctioned
route classified as an ordinary SHELL effect and was refused under the very
invalid state it was printed to repair.

Widening the grammar would reopen the hole the grammar exists to close, so the
COMMAND was made to fit: `resolve-blocker` now reads its decision as the tokens
up to the next flag, and the printed form carries no quotes.

This test harvests the command literals out of the engine rather than restating
them, so a new unexecutable instruction fails here rather than in somebody's
frozen session. Placeholders are substituted first: a template is guidance, and
what has to classify is the command an operator actually types.
"""

from __future__ import annotations

import ast
import re
import sys
import unittest
import warnings
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import guard_events  # noqa: E402

ENGINE = TOOLS / "saipen_engine"
#: `<placeholder>` and `{interpolation}` both stand for a value the operator or
#: the engine supplies; neither is what gets typed.
_PLACEHOLDER = re.compile(r"<[^<>]{1,40}>|\{[^{}]{0,60}\}")
#: What a substituted placeholder becomes: inside the canonical argument
#: alphabet, so substitution itself never decides the verdict.
_FILLER = "T-1"
#: Literals that are prose or a bare prefix, not a command anyone runs.
_NOT_COMMANDS = frozenset({"saipen", "saipen ...", "saipen push + build ccc"})
#: The string prefix in front of a literal's first quote.
_PREFIX = re.compile(rb"""([A-Za-z]{0,2})["']""")


def _printed(node: ast.AST) -> str | None:
    """The text a string literal prints, or None for anything else.

    The parser has already joined implicit concatenation, so a command split
    over two source lines is one literal, and a quote of the other kind inside
    it is part of the command (T-1383: `'{text}'` payloads were cut off). Each
    f-string interpolation reads `{expression}`.
    """
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts = []
        for value in node.values:
            if isinstance(value, ast.Constant):
                parts.append(str(value.value))
            else:
                expression = ast.unparse(value.value)
                parts.append("{" + re.sub(r"[{}]", "", expression)[:60] + "}")
        return "".join(parts)
    return None


def _is_raw(node: ast.AST, lines: list[bytes]) -> bool:
    """A RAW literal is a pattern that RECOGNISES a command
    (`r"saipen improve reconcile [A-Za-z0-9_-]+"`), never one printed."""
    prefix = _PREFIX.match(lines[node.lineno - 1], node.col_offset)
    return bool(prefix) and b"r" in prefix.group(1).lower()


def harvested() -> dict[str, set[str]]:
    """Every `saipen ...` command literal in the engine, by source file."""
    found: dict[str, set[str]] = {}
    for path in sorted(ENGINE.glob("*.py")):
        source = path.read_bytes()
        # Compile-time warnings (an invalid escape) are the linter's finding,
        # not this control's, and would land inside the family's own stream.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            tree = ast.parse(source, filename=str(path))
        # AST column offsets count UTF-8 bytes.
        lines = source.splitlines()
        # An f-string's own constant parts are nodes too; only whole literals.
        parts = {
            id(value)
            for node in ast.walk(tree)
            if isinstance(node, ast.JoinedStr)
            for value in node.values
        }
        for node in ast.walk(tree):
            if id(node) in parts:
                continue
            text = _printed(node)
            if text is None or not text.startswith("saipen ") or "\n" in text:
                continue
            if _is_raw(node, lines):
                continue
            found.setdefault(text.strip(), set()).add(path.name)
    return found


class CanonicalCommandReachabilityTests(unittest.TestCase):
    def test_the_harvest_actually_finds_commands(self):
        """Guard: an empty harvest would pass this file silently."""
        found = harvested()
        self.assertGreater(len(found), 10, found)
        self.assertIn("saipen recover resolve-blocker <decision>", found)

    def test_a_literal_is_harvested_whole(self):
        """T-1383: the harvest read a literal only up to its first quote of
        either kind, so the `ticket add` route -- quoted payloads inside a
        double-quoted f-string -- was judged as `saipen ticket add {priority}`
        and its payloads never reached the guard. A command split over two
        source lines by implicit concatenation is one literal too."""
        found = harvested()
        self.assertIn(
            "saipen ticket add {priority} '{text}' --verify '<how DONE is proven>'", found
        )
        self.assertIn(
            'saipen checkpoint RUN {ticket_id} "verify -> PASS [target: {ticket_id}] '
            'conf: high -- <the command that ran and what it reported>"',
            found,
        )
        self.assertNotIn("saipen ticket add {priority}", found)

    def test_every_printed_command_classifies_as_canonical(self):
        unreachable = []
        for literal, sources in sorted(harvested().items()):
            if literal in _NOT_COMMANDS:
                continue
            typed = _PLACEHOLDER.sub(_FILLER, literal).strip()
            if guard_events._saipen_cli_verb(typed) is None:
                unreachable.append(f"{typed!r} (from {', '.join(sorted(sources))})")
        self.assertEqual(
            unreachable,
            [],
            "the engine prints commands its own guard refuses, so the route it "
            "names is unreachable from the state that names it: "
            + "; ".join(unreachable),
        )

    def test_the_blocker_decision_is_reachable_with_real_words(self):
        """The field shape: a multi-word decision, and the flag it combines with."""
        for command in (
            "saipen recover resolve-blocker operator approved the rebind",
            "saipen recover resolve-blocker approved --apply-approved-repair " + "a" * 64,
            "saipen recover normalize-log",
        ):
            with self.subTest(command=command):
                self.assertEqual(
                    guard_events._saipen_cli_verb(command),
                    "recover",
                    f"{command!r} is not reachable as a canonical operation",
                )

    def test_shell_syntax_outside_a_payload_still_disqualifies_the_line(self):
        """T-1386 moved ONE thing: a single quoted literal payload of a canonical
        verb is data, judged by the verb's own grammar. Shell syntax outside the
        payload still makes the whole line an ordinary shell effect."""
        for command in (
            "saipen recover && rm -rf .saipen",
            "saipen status | tee out.txt",
            "saipen recover resolve-blocker 'decision' && rm -rf .saipen",
            "saipen status > out.txt",
        ):
            with self.subTest(command=command):
                self.assertIsNone(guard_events._saipen_cli_verb(command), command)

    def test_a_quoted_payload_is_data_under_its_verb(self):
        for command in (
            'saipen recover resolve-blocker "quoted decision"',
            "saipen recover resolve-blocker 'quoted decision'",
            "saipen recover resolve-blocker 'a && b | c'",
        ):
            with self.subTest(command=command):
                self.assertEqual(guard_events._saipen_cli_verb(command), "recover", command)

    def test_a_shortcut_is_the_command_it_routes_to(self):
        """The CLI resolves a registry shortcut before any dispatch, and so
        must the guard: `saipen cc` is `saipen continue`."""
        for command, verb in (
            ("saipen cc", "cc"),
            ("saipen sss", "sss"),
            ("saipen hush status", "hush"),
            ("saipen continue", "continue"),
        ):
            with self.subTest(command=command):
                self.assertEqual(guard_events._saipen_cli_verb(command), verb, command)
        for command in ("saipen hush", "saipen bogus", "saipen hush bogus"):
            with self.subTest(command=command):
                self.assertIsNone(guard_events._saipen_cli_verb(command), command)

    def test_a_modifier_never_carries_an_ingress_payload_past_its_own_grammar(self):
        """start/user-request payloads are judged by the ingress grammar only
        (T-1398); `hush` in front must not route one through the generic
        quoted-payload path instead."""
        for command in (
            "saipen hush start 'fix the page'",
            "saipen hush user-request 'fix the page'",
        ):
            with self.subTest(command=command):
                self.assertIsNone(guard_events._saipen_cli_verb(command), command)


class BlockerDecisionParsingTests(unittest.TestCase):
    """The CLI reads what the printed form now tells an operator to type."""

    def parse(self, argv: list[str]) -> str | None:
        """Run `_recover`'s argument scan far enough to see the decision."""
        import saipen as cli

        captured: dict[str, object] = {}
        original = cli._emit
        cli._emit = lambda record, as_json: captured.setdefault("record", record)
        try:
            cli._recover(Path("."), argv, True, dry_run=True)
        except Exception as exc:  # pragma: no cover - the scan may refuse later
            captured.setdefault("raised", repr(exc))
        finally:
            cli._emit = original
        return str(captured.get("record", captured.get("raised", "")))

    def test_a_multi_word_decision_needs_no_quotes(self):
        reported = self.parse(["resolve-blocker", "operator", "approved", "the", "rebind"])
        self.assertNotIn("missing decision text", reported)
        self.assertNotIn("requires non-empty decision", reported)

    def test_a_missing_decision_still_refuses(self):
        reported = self.parse(["resolve-blocker"])
        self.assertIn("requires non-empty decision", reported)

    def test_a_following_flag_is_not_swallowed_into_the_decision(self):
        reported = self.parse(
            ["resolve-blocker", "approved", "--apply-approved-repair", "a" * 64]
        )
        self.assertNotIn("unknown recover argument", reported)


if __name__ == "__main__":
    unittest.main(verbosity=2)
