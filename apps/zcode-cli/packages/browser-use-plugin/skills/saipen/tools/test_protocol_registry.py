"""Semantic-baseline and machine-registry regressions (SRC-010)."""

from __future__ import annotations

import json
import re
import shutil
import statistics
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import commands, errors, phases, state  # noqa: E402
from saipen_engine.registry import load_registry  # noqa: E402
import protocol_budget  # noqa: E402


ROOT = TOOLS.parent
PROTOCOL = ROOT / "saipen"
GOLDEN = ROOT / "tests" / "protocol_semantic_golden.json"
OWNER_RE = re.compile(r"<!-- RULE-OWNER: ([A-Z][A-Z0-9-]+) -->")


class ProtocolRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = load_registry(PROTOCOL)

    def test_runtime_closed_sets_derive_from_registry(self):
        reg = self.registry
        self.assertEqual(commands.load_shortcut_table(PROTOCOL), reg["shortcuts"])
        self.assertEqual(commands.CYRILLIC_CONFUSABLE_MAP, reg["cyrillic_confusables"])
        self.assertEqual(phases.VALID_TRANSITIONS, reg["phases"]["valid_transitions"])
        self.assertEqual(set(phases.ALL_PHASES), set(reg["phases"]["all"]))
        self.assertEqual(set(errors.CODES), set(reg["error_codes"]))
        self.assertEqual(tuple(state.STATE_REQUIRED_FIELDS), tuple(reg["state"]["required_fields"]))
        self.assertEqual(set(state.STATE_KNOWN_FIELDS), set(reg["state"]["known_fields"]))
        self.assertEqual(tuple(state.WAIT_CATEGORIES), tuple(reg["wait_categories"]))

    def test_prose_rewrite_cannot_change_shortcut_behavior(self):
        expected = commands.load_shortcut_table(PROTOCOL)
        with tempfile.TemporaryDirectory(prefix="saipen-registry-prose-") as td:
            root = Path(td)
            (root / "REGISTRY.json").write_text(
                json.dumps(self.registry, ensure_ascii=False), encoding="utf-8"
            )
            (root / "CORE.md").write_text("entirely rewritten prose\n", encoding="utf-8")
            (root / "COMMANDS.md").write_text("different words\n", encoding="utf-8")
            self.assertEqual(commands.load_shortcut_table(root), expected)

    def test_registry_fixture_drives_resolver(self):
        # W3B.7#3: REGISTRY shortcut fixture change MUST change resolution --
        # the registry is the authority, not a mirror of the prose.
        mutated = dict(self.registry)
        mutated["shortcuts"] = dict(self.registry["shortcuts"])
        mutated["shortcuts"]["qq"] = "saipen translate"
        with tempfile.TemporaryDirectory(prefix="saipen-registry-drive-") as td:
            root = Path(td)
            (root / "REGISTRY.json").write_text(
                json.dumps(mutated, ensure_ascii=False), encoding="utf-8"
            )
            table = commands.load_shortcut_table(root)
            self.assertEqual(table["qq"], "saipen translate")
            resolved = commands.resolve_shortcut("qq", table=table)
            self.assertEqual(resolved, "qq")

    def test_registry_confusable_fixture_drives_normalizer(self):
        # W3B.7#4: changing the confusable map in an isolated registry fixture
        # must change normalization -- no second hand-maintained map. The map
        # is import-time state, so reload the module under the fixture.
        mutated = dict(self.registry)
        mutated["cyrillic_confusables"] = dict(self.registry["cyrillic_confusables"])
        # Drop the Cyrillic es->c fold so Cyrillic es-es can no longer reach cc.
        mutated["cyrillic_confusables"].pop("\u0441")
        with tempfile.TemporaryDirectory(prefix="saipen-registry-conf-") as td:
            root = Path(td)
            (root / "REGISTRY.json").write_text(
                json.dumps(mutated, ensure_ascii=False), encoding="utf-8"
            )
            import importlib

            from saipen_engine import commands as _cmds

            # Point the loader at the fixture, reload, then restore.
            import saipen_engine.registry as _reg_mod

            _orig_registry_path = _reg_mod.registry_path

            def _fixture_path(protocol_dir=None, **kw):
                return _orig_registry_path(root)

            _reg_mod.registry_path = _fixture_path
            try:
                _cmds_re = importlib.reload(_cmds)
                table = _cmds_re.load_shortcut_table(root)
                self.assertNotIn("\u0441", _cmds_re.CYRILLIC_CONFUSABLE_MAP)
                self.assertIsNone(_cmds_re.resolve_shortcut("\u0441\u0441", table=table))
            finally:
                _reg_mod.registry_path = _orig_registry_path
                importlib.reload(_cmds)

    def test_registry_absent_fails_closed(self):
        # W3B.7#5: registry-era installation with a missing REGISTRY must fail
        # closed -- no fallback to parsing CORE.md prose.
        with tempfile.TemporaryDirectory(prefix="saipen-registry-absent-") as td:
            root = Path(td)
            (root / "CORE.md").write_text(
                "| `cc` | `saipen continue` |\n", encoding="utf-8"
            )
            (root / "COMMANDS.md").write_text("words\n", encoding="utf-8")
            table = commands.load_shortcut_table(root)
            self.assertEqual(table, {})
            self.assertIsNone(commands.resolve_shortcut("cc", table=table))

    def test_registry_malformed_fails_closed(self):
        # W3B.7#6: malformed REGISTRY must fail closed, never guess a
        # shortcut from prose or a partial table.
        with tempfile.TemporaryDirectory(prefix="saipen-registry-bad-") as td:
            root = Path(td)
            (root / "REGISTRY.json").write_text("{ not json", encoding="utf-8")
            (root / "CORE.md").write_text(
                "| `cc` | `saipen continue` |\n", encoding="utf-8"
            )
            table = commands.load_shortcut_table(root)
            self.assertEqual(table, {})
            self.assertIsNone(commands.resolve_shortcut("cc", table=table))

    def test_golden_command_and_chain_snapshots(self):
        golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
        table = commands.load_shortcut_table(PROTOCOL)
        for raw, expected in golden["command_resolution"].items():
            actual = commands.resolve_compound_command(raw, table=table)
            projection = [
                {"kind": item["kind"], "command": item["command"]}
                for item in actual
            ]
            self.assertEqual(projection, expected, raw)
        for key, entry in golden["chain_disposition"].items():
            actual = commands.chain_disposition(
                entry["input"], policy=entry["policy"]
            )
            self.assertEqual(actual, entry["output"], key)
        for edge, legal in golden["phase_transitions"].items():
            src, dst = edge.split("->")
            self.assertEqual(phases.transition_legal(src, dst), legal, edge)
        derived = commands.derive_cyrillic_twins(list(table))
        self.assertEqual(derived, golden["cyrillic_twins"])
        # No Cyrillic input may ever fold to ss/sss (STOP/STATUS).
        for inp, projection in golden["no_cyrillic_to_ss"].items():
            self.assertEqual(
                [
                    {"kind": i["kind"], "command": i["command"]}
                    for i in commands.resolve_compound_command(inp, table=table)
                ],
                projection,
                inp,
            )
            self.assertNotIn("saipen stop", projection[0]["command"])
            self.assertNotIn("saipen status", projection[0]["command"])
        # Dry-run contract: plan with concrete targets, zero bytes, same
        # refusal class as apply (documented semantics; mutation side proven
        # by the audit-dry-run suite).
        self.assertEqual(golden["dry_run"]["writes"], "zero_bytes")
        self.assertEqual(golden["dry_run"]["refusal_class"], "same_as_apply")
        # Continue fallback semantics frozen.
        fb = golden["continue_fallback"]
        self.assertEqual(fb["new_cycle_per_invocation"], 1)
        self.assertFalse(fb["recursive_carousel"])
        self.assertEqual(fb["ambiguous_improve"], "refusal_not_idle")
        self.assertEqual(fb["no_worthwhile_improvement"], "CONTINUE_IDLE")

    def test_semantic_facts_name_owner_and_test(self):
        facts = self.registry["semantic_baseline"]["facts"]
        owners = self.registry["rule_owners"]
        self.assertEqual(set(facts), set(owners))
        for rule_id, fact in facts.items():
            self.assertEqual(fact["owner"], owners[rule_id], rule_id)
            self.assertTrue(fact["test"], rule_id)
            self.assertTrue(fact["subject"], rule_id)

    def test_every_declared_load_budget_is_measured_from_registry(self):
        graph = self.registry["load_profiles"]
        self.assertEqual(set(graph["budgets"]), set(graph["profiles"]))
        self.assertEqual(graph["budgets"]["cold"], 25 * 1024)
        measured = protocol_budget.load_profiles(PROTOCOL)
        for name, limit in graph["budgets"].items():
            self.assertIn(name, measured)
            self.assertLessEqual(measured[name], limit, name)
            self.assertTrue(measured["profiles"][name], name)
        self.assertLessEqual(measured["human_markdown_total"], 300 * 1024)

    def test_phase_metrics_measure_all_registry_phases_and_actual_bytes(self):
        phase_names = self.registry["phases"]["all"]
        measured = protocol_budget.load_profiles(PROTOCOL)
        # T-1465: content bytes with LF line ends, whatever the checkout wrote.
        actual = {
            name: len(
                (PROTOCOL / "phases" / f"{name.lower()}.md").read_bytes().replace(b"\r\n", b"\n")
            )
            for name in phase_names
        }
        self.assertEqual(len(phase_names), 16)
        self.assertEqual(measured["phases_count"], 16)
        self.assertEqual(measured["bytes_by_phase"], actual)
        self.assertEqual(measured["phases_total"], sum(actual.values()))

    def test_phase_max_median_and_tie_break_are_deterministic(self):
        measured = protocol_budget.load_profiles(PROTOCOL)
        sizes = measured["bytes_by_phase"]
        expected_largest = min(sizes, key=lambda name: (-sizes[name], name))
        self.assertEqual(measured["phases_median"], statistics.median(sizes.values()))
        self.assertEqual(measured["largest_phase"], expected_largest)
        self.assertEqual(measured["phases_max"], sizes[expected_largest])

    def test_missing_registry_phase_fails_instead_of_disappearing(self):
        with tempfile.TemporaryDirectory(prefix="saipen-phase-budget-") as td:
            protocol = Path(td) / "saipen"
            shutil.copytree(PROTOCOL, protocol)
            (protocol / "phases" / "verify.md").unlink()
            with self.assertRaisesRegex(
                ValueError, r"phase document does not exist: phases/verify\.md"
            ):
                protocol_budget.load_profiles(protocol)

    def test_phase_metrics_do_not_change_load_profile_measurement(self):
        measured = protocol_budget.load_profiles(PROTOCOL)
        for name, routes in measured["profiles"].items():
            self.assertEqual(measured[name], max(route["bytes"] for route in routes))
            for route in routes:
                self.assertEqual(route["bytes"], sum(route["must"].values()))

    def test_phase_preferences_are_registry_owned_and_not_hard_failures(self):
        preferences = self.registry["load_profiles"]["phase_preferences"]
        measured = protocol_budget.load_profiles(PROTOCOL)
        self.assertFalse(preferences["enforced"])
        self.assertEqual(measured["preferred_phase_bands"], preferences["bands"])
        self.assertNotIn("preferred_phase_bands", measured["budgets"])

    def test_one_rule_one_owner(self):
        declared: dict[str, list[str]] = {}
        for path in sorted(PROTOCOL.rglob("*.md")):
            text = path.read_text(encoding="utf-8-sig")
            rel = path.relative_to(ROOT).as_posix()
            for rule_id in OWNER_RE.findall(text):
                declared.setdefault(rule_id, []).append(rel)
        corpus = ROOT / "tests" / "conformance_cases.jsonl"
        if corpus.is_file():
            declared.setdefault("CONFORMANCE-CORPUS-01", []).append(
                corpus.relative_to(ROOT).as_posix()
            )
        expected = self.registry["rule_owners"]
        self.assertEqual(set(declared), set(expected))
        for rule_id, owner in expected.items():
            self.assertEqual(declared[rule_id], [owner], rule_id)

    def test_all_16_phase_documents_exist(self):
        expected = set(self.registry["phases"]["all"])
        actual = {path.stem.upper() for path in (PROTOCOL / "phases").glob("*.md")}
        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
