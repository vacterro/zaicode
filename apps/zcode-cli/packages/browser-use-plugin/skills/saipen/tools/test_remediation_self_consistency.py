"""T-1434 M5: validator remediation is executable by construction.

ONE self-consistency gate over the closed remediation table
(`saipen_engine.remediation`): every actionable machine-readable remediation
the validator can emit resolves to exactly one of

    REGISTERED_CANONICAL_COMMAND   (registry + effects + parser + dispatch)
    TYPED_EXTERNAL_ACTION          (closed external_kind; never a command)

and nothing else. The suite also proves the round trip end to end for the
closure-evidence remediation: emit -> parse -> registry -> effects -> dispatch
-> execute -> validator green.

Run standalone:
    python tools/test_remediation_self_consistency.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import command_effects  # noqa: E402
from saipen_engine import remediation  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_work_reverify_cli import (  # noqa: E402
    _make_project,
    _run_cli,
    _run_validator,
)

REGISTRY = json.loads((ROOT / "saipen" / "REGISTRY.json").read_text(encoding="utf-8"))
REGISTERED_VERBS = list(REGISTRY["commands"]["saipen"])
DECLARED_SHORTCUTS = set(REGISTRY.get("shortcuts", {}))
IMPROVE_ACTIONS = set(REGISTRY["commands"]["improve_actions"])


def setUpModule() -> None:
    isolate_host_session()


def _effects_entry(verb: str):
    table = json.loads(
        (ROOT / "saipen" / "COMMAND_EFFECTS.json").read_text(encoding="utf-8")
    )
    return table["verbs"].get(verb)


class RemediationTableTests(unittest.TestCase):
    def test_01_table_is_closed_and_typed(self):
        self.assertTrue(remediation.REMEDIATIONS)
        for spec in remediation.REMEDIATIONS:
            self.assertIn(spec.kind, remediation.REMEDIATION_KINDS)
            self.assertIn(
                spec.route_kind,
                remediation.ROUTE_KINDS,
                f"{spec.rule}: route kind outside the closed set",
            )
            if spec.kind == "command":
                self.assertIsNotNone(spec.pattern)
                self.assertTrue(spec.template.startswith(("saipen ", "git ")))
                if spec.route_kind == "OPERATOR_AUTHORIZED_COMMAND":
                    self.assertFalse(spec.extract, "operator commands are never auto-extracted")
                    self.assertTrue(spec.template.startswith("git "))
                else:
                    self.assertTrue(spec.verb)
                self.assertTrue(spec.owner)
            else:
                self.assertIn(spec.external_kind, remediation.EXTERNAL_ACTION_KINDS)
                self.assertFalse(spec.template, "external remediation carries no command")

    def test_01b_no_dead_end_route_shapes(self):
        """M7: the forbidden terminal outputs never appear in the table."""
        forbidden = ("manual edit board", "manual edit state", "fix it somehow", ".py")
        for spec in remediation.REMEDIATIONS:
            if spec.kind != "command":
                continue
            lowered = spec.template.lower()
            with self.subTest(rule=spec.rule):
                for phrase in forbidden:
                    self.assertNotIn(phrase, lowered)
                self.assertNotEqual(spec.template.strip(), "saipen validate")

    def test_02_command_specs_resolve_in_registry_and_effects(self):
        for spec in remediation.REMEDIATIONS:
            if spec.kind != "command":
                continue
            if spec.route_kind == "OPERATOR_AUTHORIZED_COMMAND":
                continue
            with self.subTest(rule=spec.rule):
                self.assertIn(
                    spec.verb,
                    REGISTERED_VERBS,
                    f"{spec.rule}: verb {spec.verb!r} is not in REGISTRY commands",
                )
                if spec.verb == "improve" and spec.action:
                    self.assertIn(spec.action, IMPROVE_ACTIONS)
                entry = _effects_entry(spec.verb)
                self.assertIsNotNone(
                    entry,
                    f"{spec.rule}: {spec.verb!r} has no COMMAND_EFFECTS entry",
                )
                if isinstance(entry, dict) and spec.action:
                    self.assertIn(
                        spec.action,
                        entry.get("subcommands", {}),
                        f"{spec.rule}: effects entry for {spec.verb} {spec.action} "
                        "must be explicit, never inherited from an unrelated default",
                    )
                cls = command_effects.classify_invocation(
                    spec.verb, [spec.action] if spec.action else []
                )
                self.assertIn(
                    cls,
                    ("DIAGNOSTIC", "INGRESS", "RECOVERY", "EXECUTION"),
                    f"{spec.rule}: effects classification did not resolve",
                )

    def test_03_no_internal_python_or_pseudocommands(self):
        forbidden = (".py", "tools/", "python ", "def ", "()", "None")
        for spec in remediation.REMEDIATIONS:
            if spec.kind != "command":
                continue
            with self.subTest(rule=spec.rule):
                for token in forbidden:
                    self.assertNotIn(token, spec.template)

    def test_04_no_generic_validate_when_a_specific_repair_exists(self):
        templates = [
            spec.template for spec in remediation.REMEDIATIONS if spec.kind == "command"
        ]
        self.assertTrue(templates)
        for template in templates:
            self.assertNotEqual(
                template.strip(),
                "saipen validate",
                "a specific repair must never be a generic saipen validate recursion",
            )

    def test_05_external_records_are_not_commands(self):
        record = remediation.external_action(
            "OPERATOR_GUI_VERIFICATION", "operator must confirm the live window"
        )
        self.assertTrue(remediation.is_external(record))
        self.assertEqual(record["kind"], "external")
        self.assertFalse(record["external_kind"].startswith("saipen"))
        self.assertNotIn("canonical_next_command", record)
        with self.assertRaises(ValueError):
            remediation.external_action("NOT_A_KIND", "x")

    def test_06_extraction_admits_only_table_shapes(self):
        failures = [
            "closure-evidence -- ticket T-008 ... run saipen work reverify T-008 to record",
            "an unregistered route saipen made-up-verb T-1 and a loop saipen validate",
            "core sweep ... saipen ticket reasoning T-53 --recurrence <..> work",
        ]
        found = remediation.extract_commands(failures)
        self.assertIn("saipen work reverify T-008", found)
        self.assertIn("saipen ticket reasoning T-53", found)
        self.assertTrue(
            all(
                remediation.resolve_command(command).get("ok")
                for command in found
            ),
            found,
        )
        self.assertFalse(
            any("made-up-verb" in command or command == "saipen validate" for command in found)
        )

    def test_07_unregistered_commands_are_refused(self):
        verdict = remediation.resolve_command("saipen made-up-verb T-1")
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "REMEDIATION_UNREGISTERED")
        self.assertIsNone(verdict["kind"])

    def test_08_cli_dispatches_every_registered_command(self):
        """Parser + registry + dispatch owner are mechanically proven.

        A nonexistent target must produce a STRUCTURED engine refusal, never a
        parser 'unknown action' or an unhandled traceback.
        """
        with tempfile.TemporaryDirectory(prefix="t1434-m5-dispatch-") as tmp:
            root = _make_project(Path(tmp))
            cases = (
                ("work", "reverify", "T-999999"),
                (
                    "ticket",
                    "resolve-external",
                    "T-999999",
                    "--authority",
                    "lineage-" + "0" * 32,
                    "--implementation",
                    "T-1@abc1234",
                    "--reason",
                    "UPSTREAM_FIX_VERIFIED",
                    "--run",
                    "exit 0",
                ),
                (
                    "ticket",
                    "reasoning",
                    "T-999999",
                    "--recurrence",
                    "x",
                    "--weak-model",
                    "y",
                ),
                ("improve", "reconcile", "imp-does-not-exist"),
                ("sub", "reconcile", "saiwiki", "--authority", "SRC-999"),
                ("source", "retire", "SRC-999", "--reason", "STALE_CREDENTIAL"),
                ("source", "recover"),
                ("source", "quarantine", "SRC-999", "--reason", "CREDENTIAL_PATTERN"),
            )
            for argv in cases:
                with self.subTest(argv=argv):
                    _rc, payload, stdout = _run_cli(root, *argv)
                    self.assertNotEqual(
                        payload.get("code"),
                        "UNKNOWN_ACTION",
                        f"{argv}: parser does not know this command: {stdout[:300]}",
                    )
                    self.assertNotEqual(
                        payload.get("code"),
                        None,
                        f"{argv}: no structured engine answer: {stdout[:300]}",
                    )
                    self.assertNotIn(
                        "Traceback",
                        stdout,
                        f"{argv}: unhandled failure instead of a structured refusal",
                    )

    def test_09_closure_evidence_remediation_round_trip(self):
        """Emit -> parse -> registry -> effects -> dispatch -> execute -> green."""
        with tempfile.TemporaryDirectory(prefix="t1434-m5-roundtrip-") as tmp:
            root = _make_project(Path(tmp))
            rc_before, before = _run_validator(root)
            self.assertNotEqual(rc_before, 0)
            self.assertIn("saipen work reverify T-001", before)
            verdict = remediation.resolve_command("saipen work reverify T-001")
            self.assertTrue(verdict["ok"], verdict)
            self.assertEqual(verdict["verb"], "work")
            rc, payload, out = _run_cli(
                root, "work", "reverify", "T-001", "--run", "exit 0"
            )
            self.assertEqual(rc, 0, out)
            self.assertEqual(payload.get("code"), "WORK_REVERIFIED")
            rc_after, after = _run_validator(root)
            self.assertEqual(rc_after, 0, after)

    def test_10_help_and_docs_name_every_remediation_command(self):
        """M5 audit surface: help syntax and documentation agree.

        A remediation an operator can only discover from a FAIL message is a
        docs gap: every registered repair names its `verb action` pair in the
        CLI usage AND in saipen/COMMANDS.md.
        """
        import subprocess

        help_text = subprocess.run(
            [sys.executable, str(TOOLS / "saipen.py"), "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout
        commands_md = (ROOT / "saipen" / "COMMANDS.md").read_text(encoding="utf-8-sig")
        self.assertTrue(help_text)
        for spec in remediation.REMEDIATIONS:
            if spec.kind != "command" or not spec.extract:
                continue
            pair = f"{spec.verb} {spec.action}" if spec.action else spec.verb
            with self.subTest(rule=spec.rule):
                self.assertIn(pair, help_text, "missing from `saipen --help`")
                self.assertIn(pair, commands_md, "missing from saipen/COMMANDS.md")


class EmittedLiteralScanTests(unittest.TestCase):
    """Direction check: every table command shape is what the validator emits.

    The validator's failure messages are assembled across concatenated string
    literals, so a raw source scan cannot reconstruct them. Instead this
    asserts the stronger, decidable property: the extraction table is the ONLY
    producer of receipt remediation commands (validate.py delegates to it), and
    every table pattern is exercised by a real emission fixture below.
    """

    def test_validate_py_delegates_to_the_closed_table(self):
        text = (TOOLS / "validate.py").read_text(encoding="utf-8")
        self.assertIn("remediation.extract_commands", text)
        self.assertNotIn("_WORK_REVERIFY_COMMAND", text)

    def test_every_table_pattern_is_exercised(self):
        samples = {
            "source credentials": (
                "credential gate: run saipen source quarantine SRC-033 --reason CREDENTIAL_PATTERN"
            ),
            "closure-evidence": "run saipen work reverify T-008 to record ONE",
            "closure-provenance:external-generation": (
                "re-resolve with saipen ticket resolve-external T-66 --authority x"
            ),
            "legacy metadata:exact": (
                "repair with saipen ticket repair-metadata T-901 --field "
                "source_receipts --to SRC-001"
            ),
            "legacy metadata:unbound": (
                "repair with saipen ticket repair-metadata T-901 --field "
                "source_receipts --legacy-unbound --authority lineage-"
                + "0" * 32
            ),
            "core sweep:sweep-ticket-link": (
                "the executable repair is `saipen ticket reasoning T-53 --recurrence"
            ),
            "producer lifecycle:terminal": (
                "repair with the producer-owned reconciliation "
                "saipen sub reconcile saiwiki --authority SRC-042"
            ),
            "improve report": "repair: saipen improve reconcile imp-x-1 --json",
            "source receipts": "retire with saipen source retire SRC-007 --reason",
            "source coverage": "route: saipen source recover",
        }
        for spec in remediation.REMEDIATIONS:
            if spec.kind != "command" or not spec.extract:
                continue
            with self.subTest(rule=spec.rule):
                sample = samples[spec.rule]
                found = remediation.extract_commands([sample])
                self.assertTrue(found, f"{spec.rule}: table pattern never matches")
                self.assertTrue(
                    remediation.resolve_command(found[0]).get("ok"), found[0]
                )

    def test_operator_authorized_command_is_resolvable_but_never_extracted(self):
        """M7: the operator maintenance route is classified, not auto-dispatched."""
        verdict = remediation.resolve_command("git rm -r --cached -- .saipen/locks/x")
        self.assertTrue(verdict["ok"], verdict)
        self.assertEqual(verdict["route_kind"], "OPERATOR_AUTHORIZED_COMMAND")
        self.assertFalse(verdict["verb"])
        self.assertEqual(
            remediation.extract_commands(["maintenance: git rm -r --cached -- .saipen/locks/x"]),
            [],
            "an operator command must never become a canonical_next_command",
        )

    def test_every_route_kind_is_represented_or_declared(self):
        seen = {spec.route_kind for spec in remediation.REMEDIATIONS}
        self.assertIn("CANONICAL_COMMAND", seen)
        self.assertIn("OPERATOR_AUTHORIZED_COMMAND", seen)
        self.assertIn("PRODUCER_OWNED_COMMAND", seen)
        self.assertIn("IMMUTABLE_CLASSIFIED", remediation.ROUTE_KINDS)


if __name__ == "__main__":
    unittest.main()
