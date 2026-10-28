from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine.context import context_cold  # noqa: E402
from saipen_engine.knowledge import (  # noqa: E402
    CARD_MARKER,
    build_index,
    evaluate_promotion,
    parse_card,
    parse_index,
    read_cards,
    retrieve,
    validate_knowledge,
    write_index,
)

SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"


def card_text(
    *,
    scope: str = "utilities, architecture, host",
    trigger: str = "adding a substantial utility to a utility host",
    status: str = "active",
    evidence: str = "T-101, tests/repro.py",
    supersedes: str = "none",
    kind: str = "lesson",
    title: str = "Keep substantial utilities standalone",
    claim: str = "Prefer a standalone subtool with thin host integration.",
    why: str = "A prior embedded utility increased coupling and made extraction expensive.",
) -> str:
    return (
        f"{CARD_MARKER}\n"
        f"kind: {kind}\n"
        f"scope: {scope}\n"
        f"trigger: {trigger}\n"
        f"status: {status}\n"
        f"evidence: {evidence}\n"
        f"supersedes: {supersedes}\n\n"
        f"# {title}\n\n{claim}\n\nWhy:\n{why}\n"
    )


class KnowledgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-knowledge-")
        self.root = Path(self.tmp.name) / "project"
        self.cards = self.root / ".saipen" / "KNOWLEDGE" / "cards"
        self.cards.mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def add(self, slug: str, **kwargs) -> Path:
        path = self.cards / f"{slug}.md"
        path.write_text(card_text(**kwargs), encoding="utf-8")
        return path

    def index(self) -> Path:
        result = write_index(self.root)
        self.assertTrue(result["ok"], result)
        return self.root / ".saipen" / "KNOWLEDGE" / "INDEX.md"

    def cold_context_for_utility_ticket(self) -> dict:
        """Cold fixture: fresh agent, no chat history, utility-host ticket."""
        shutil.rmtree(self.root / ".saipen")
        shutil.copytree(SCENARIO, self.root / ".saipen")
        board = self.root / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "DOING task", "add a substantial utility to the utility host"
            ),
            encoding="utf-8",
        )
        self.cards.mkdir(parents=True)
        self.add("standalone-utilities")
        self.add("unrelated", scope="css, colors", trigger="changing color contrast")
        self.index()
        return context_cold(self.root, current_agent="old-agent")

    # A. Backward compatibility
    def test_01_no_knowledge_directory_is_silent(self) -> None:
        shutil.rmtree(self.root / ".saipen" / "KNOWLEDGE")
        self.assertEqual(
            validate_knowledge(self.root),
            {"errors": [], "cards": 0, "active": 0, "index": "absent"},
        )

    def test_02_legacy_documents_need_no_cards(self) -> None:
        knowledge = self.root / ".saipen" / "KNOWLEDGE"
        (knowledge / "decisions.md").write_text(
            "# Decisions\n\nStill authoritative.\n", encoding="utf-8"
        )
        self.assertEqual(validate_knowledge(self.root)["cards"], 0)
        self.assertEqual(validate_knowledge(self.root)["errors"], [])

    def test_03_missing_index_is_not_an_error(self) -> None:
        self.add("standalone-utilities")
        self.assertEqual(validate_knowledge(self.root)["index"], "absent")
        self.assertEqual(validate_knowledge(self.root)["errors"], [])

    def test_04_deleting_index_loses_no_authority(self) -> None:
        self.add("standalone-utilities")
        index = self.index()
        index.unlink()
        result = retrieve(self.root, "substantial utility host architecture")
        self.assertEqual(result["index"], "absent")
        self.assertEqual(result["loaded_paths"], ["cards/standalone-utilities.md"])

    # B. Card validation
    def test_05_valid_card_parses(self) -> None:
        card = parse_card(card_text(), "cards/standalone-utilities.md")
        self.assertEqual(card.kind, "lesson")
        self.assertIn("coupling", card.why)

    def test_06_missing_evidence_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "evidence"):
            parse_card(card_text(evidence=""), "cards/no-evidence.md")

    def test_07_invalid_kind_and_status_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid kind"):
            parse_card(card_text(kind="memo"), "cards/bad-kind.md")
        with self.assertRaisesRegex(ValueError, "invalid status"):
            parse_card(card_text(status="retired"), "cards/bad-status.md")

    def test_08_self_supersession_is_rejected(self) -> None:
        self.add("self", status="active", supersedes="cards/self.md")
        self.assertTrue(any("itself" in item for item in validate_knowledge(self.root)["errors"]))

    def test_09_missing_supersession_target_is_rejected(self) -> None:
        self.add("replacement", supersedes="cards/missing.md")
        self.assertTrue(
            any("missing target" in item for item in validate_knowledge(self.root)["errors"])
        )

    def test_10_path_traversal_in_card_link_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "escapes KNOWLEDGE"):
            parse_card(card_text(supersedes="../outside.md"), "cards/traversal.md")

    def test_11_duplicate_retrieval_identity_fails_safely(self) -> None:
        self.add("first")
        self.add("second")
        self.assertTrue(
            any("two active cards" in item for item in validate_knowledge(self.root)["errors"])
        )

    # C. Index
    def test_12_same_tree_generates_byte_identical_index(self) -> None:
        self.add("standalone-utilities")
        self.assertEqual(build_index(self.root), build_index(self.root))

    def test_13_changed_card_makes_index_stale(self) -> None:
        path = self.add("standalone-utilities")
        self.index()
        path.write_text(card_text(why="New verified causal explanation."), encoding="utf-8")
        status = validate_knowledge(self.root)
        self.assertEqual(status["index"], "stale")
        self.assertTrue(any("stale" in item for item in status["errors"]))

    def test_14_regeneration_restores_exact_projection(self) -> None:
        path = self.add("standalone-utilities")
        self.index()
        path.write_text(card_text(why="New verified causal explanation."), encoding="utf-8")
        self.assertTrue(write_index(self.root)["ok"])
        self.assertEqual(validate_knowledge(self.root)["index"], "fresh")

    def test_15_index_contains_metadata_not_body(self) -> None:
        self.add("standalone-utilities", claim="BODY-CLAIM", why="BODY-CAUSE")
        text = build_index(self.root)
        self.assertNotIn("BODY-CLAIM", text)
        self.assertNotIn("BODY-CAUSE", text)
        self.assertIn("scope: utilities", text)

    def test_16_superseded_card_is_visibly_non_active(self) -> None:
        self.add("old", status="superseded")
        self.add("new", supersedes="cards/old.md", trigger="replacing an embedded utility")
        text = build_index(self.root)
        self.assertIn("cards/old.md | lesson", text)
        self.assertIn("| superseded", text)

    # D. Retrieval
    def test_17_unrelated_task_loads_no_cards(self) -> None:
        self.add("standalone-utilities")
        self.index()
        result = retrieve(self.root, "repair CSS colour contrast")
        self.assertEqual(result["retrieved"], [])
        self.assertEqual(result["loaded_paths"], [])

    def test_18_scope_and_trigger_select_relevant_card(self) -> None:
        self.add("standalone-utilities")
        self.index()
        result = retrieve(self.root, "add a substantial utility to the host architecture")
        self.assertEqual(result["loaded_paths"], ["cards/standalone-utilities.md"])

    def test_19_multiple_ties_expand_only_to_limit(self) -> None:
        self.add("one", scope="alpha, beta", trigger="handling alpha beta")
        self.add("two", scope="alpha, gamma", trigger="handling alpha gamma")
        self.add("three", scope="alpha, delta", trigger="handling alpha delta")
        self.index()
        result = retrieve(self.root, "alpha", limit=2)
        self.assertEqual(result["loaded_paths"], ["cards/one.md", "cards/three.md"])

    def test_20_stale_index_falls_back_without_authority(self) -> None:
        self.add("standalone-utilities")
        index = self.index()
        tampered = index.read_text(encoding="utf-8").replace(
            "scope: utilities, architecture", "scope: queues, concurrency"
        )
        index.write_text(tampered, encoding="utf-8")
        result = retrieve(self.root, "substantial utility host architecture")
        self.assertEqual(result["index"], "stale")
        self.assertEqual(result["loaded_paths"], ["cards/standalone-utilities.md"])

    # E. Promotion
    def test_21_completion_alone_does_not_promote(self) -> None:
        result = evaluate_promotion({"verified": True})
        self.assertFalse(result["eligible"])
        self.assertEqual(result["action"], "reject")

    def test_22_verified_reusable_decision_lesson_qualifies(self) -> None:
        facts = {
            name: True
            for name in (
                "verified",
                "reusable",
                "decision_bearing",
                "not_cheaply_derivable",
                "non_duplicate",
                "non_transient",
                "safe",
            )
        }
        self.assertEqual(evaluate_promotion(facts)["action"], "promote")

    def test_23_guess_does_not_qualify(self) -> None:
        facts = {
            name: True
            for name in (
                "verified",
                "reusable",
                "decision_bearing",
                "not_cheaply_derivable",
                "non_duplicate",
                "non_transient",
                "safe",
            )
        }
        facts["verified"] = False
        self.assertIn("verified", evaluate_promotion(facts)["failed"])

    def test_24_duplicate_lesson_reuses_existing_card(self) -> None:
        self.add("standalone-utilities")
        card = read_cards(self.root)[0]
        facts = {
            name: True
            for name in (
                "verified",
                "reusable",
                "decision_bearing",
                "not_cheaply_derivable",
                "non_duplicate",
                "non_transient",
                "safe",
            )
        }
        result = evaluate_promotion(facts, scope=card.scope, trigger=card.trigger, existing=[card])
        self.assertEqual(result["action"], "reuse")

    def test_25_new_truth_requires_explicit_supersession(self) -> None:
        old = self.add("old")
        self.add("new")
        self.assertTrue(validate_knowledge(self.root)["errors"])
        old.write_text(card_text(status="superseded"), encoding="utf-8")
        (self.cards / "new.md").write_text(card_text(supersedes="cards/old.md"), encoding="utf-8")
        self.assertEqual(validate_knowledge(self.root)["errors"], [])

    # F. Security
    def test_26_secret_like_value_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "secret-like"):
            parse_card(
                card_text(why="api_key=0123456789abcdef"),
                "cards/secret.md",
            )

    def test_27_index_never_copies_secret_or_body(self) -> None:
        self.add("standalone-utilities", why="PRIVATE-BODY-MARKER")
        self.assertNotIn("PRIVATE-BODY-MARKER", build_index(self.root))

    # G. Protocol/context size and behavioral acceptance
    def test_28_cold_context_loads_relevant_card_only(self) -> None:
        result = self.cold_context_for_utility_ticket()
        self.assertIn("Prefer a standalone subtool", result.get("surface"))
        self.assertEqual(result.get("knowledge")["loaded_paths"], ["cards/standalone-utilities.md"])

    def test_29_hundreds_of_unrelated_cards_load_one_body(self) -> None:
        self.add("target", scope="queues, workers", trigger="adding a queue worker")
        for number in range(200):
            self.add(
                f"unrelated-{number}",
                scope=f"domain-{number}, topic-{number}",
                trigger=f"handling unrelated-{number}",
            )
        self.index()
        result = retrieve(self.root, "add queue workers")
        self.assertEqual(result["index"], "fresh")
        self.assertEqual(result["loaded_paths"], ["cards/target.md"])

    def test_30_index_requires_no_state_field_or_phase(self) -> None:
        shutil.rmtree(self.root / ".saipen")
        shutil.copytree(SCENARIO, self.root / ".saipen")
        before = (self.root / ".saipen" / "STATE.md").read_bytes()
        self.cards.mkdir(parents=True)
        self.add("standalone-utilities")
        self.assertTrue(write_index(self.root)["ok"])
        self.assertEqual((self.root / ".saipen" / "STATE.md").read_bytes(), before)

    # H. Legacy projection rows (SRC-020:R4)
    def test_31_legacy_documents_project_path_and_title_only(self) -> None:
        knowledge = self.root / ".saipen" / "KNOWLEDGE"
        (knowledge / "decisions.md").write_text(
            "# Recorded decisions\n\nLEGACY-BODY-MARKER\n", encoding="utf-8"
        )
        (knowledge / "notes").mkdir()
        (knowledge / "notes" / "untitled.md").write_text("no heading here\n", encoding="utf-8")
        self.add("standalone-utilities")
        text = build_index(self.root)
        self.assertIn("legacy: 2", text)
        self.assertIn("- decisions.md | legacy | title: Recorded decisions", text)
        self.assertIn("- notes/untitled.md | legacy | title: (untitled)", text)
        self.assertNotIn("LEGACY-BODY-MARKER", text)
        parsed = parse_index(text)
        self.assertEqual(len(parsed["records"]), 1)
        self.assertEqual(len(parsed["legacy"]), 2)

    def test_32_changed_legacy_title_makes_index_stale(self) -> None:
        legacy = self.root / ".saipen" / "KNOWLEDGE" / "decisions.md"
        legacy.write_text("# Recorded decisions\n", encoding="utf-8")
        self.add("standalone-utilities")
        self.index()
        self.assertEqual(validate_knowledge(self.root)["index"], "fresh")
        legacy.write_text("# Recorded decisions, revised\n", encoding="utf-8")
        self.assertEqual(validate_knowledge(self.root)["index"], "stale")

    def test_33_legacy_rows_are_not_retrieval_candidates(self) -> None:
        (self.root / ".saipen" / "KNOWLEDGE" / "queues.md").write_text(
            "# Queue workers\n", encoding="utf-8"
        )
        self.add("standalone-utilities")
        self.index()
        result = retrieve(self.root, "queue workers")
        self.assertEqual(result["retrieved"], [])
        self.assertEqual(result["loaded_paths"], [])

    # I. Behavioral acceptance controls (SRC-020:R6, R9)
    def test_34_cold_surface_carries_why_and_evidence(self) -> None:
        result = self.cold_context_for_utility_ticket()
        self.assertIn("A prior embedded utility increased coupling", result["surface"])
        self.assertIn("T-101", result["surface"])

    def test_35_removing_the_card_removes_the_influence(self) -> None:
        result = self.cold_context_for_utility_ticket()
        self.assertIn("Prefer a standalone subtool", result["surface"])
        (self.cards / "standalone-utilities.md").unlink()
        self.assertTrue(write_index(self.root)["ok"])
        after = context_cold(self.root, current_agent="old-agent")
        self.assertNotIn("Prefer a standalone subtool", after["surface"])
        self.assertEqual(after["knowledge"]["loaded_paths"], [])

    def test_legacy_index_remains_valid_and_cannot_be_overwritten(self) -> None:
        index = self.root / ".saipen" / "KNOWLEDGE" / "INDEX.md"
        original = b"# Existing project index\n\nHuman-authored knowledge.\n"
        index.write_bytes(original)
        self.assertEqual(validate_knowledge(self.root)["errors"], [])
        self.assertEqual(validate_knowledge(self.root)["index"], "legacy")
        for dry_run in (True, False):
            result = write_index(self.root, dry_run=dry_run)
            self.assertFalse(result["ok"], result)
            self.assertIn("legacy", result["detail"])
            self.assertEqual(index.read_bytes(), original)

    def test_retrieval_refuses_incoherent_supersession_without_index(self) -> None:
        self.add("replacement", supersedes="cards/missing.md")
        result = retrieve(self.root, "utility architecture")
        self.assertEqual(result["retrieved"], [])
        self.assertIn("missing target", result["error"])

    def test_retrieval_refuses_incoherent_supersession_with_stale_index(self) -> None:
        self.add("replacement")
        self.index()
        self.add("replacement", supersedes="cards/missing.md")
        result = retrieve(self.root, "utility architecture")
        self.assertEqual(result["retrieved"], [])
        self.assertIn("missing target", result["error"])

    def test_cli_retrieval_error_returns_failure(self) -> None:
        import saipen

        self.add("invalid", kind="notakind")
        with patch.object(saipen, "_emit") as emit:
            code = saipen._knowledge(self.root, ["retrieve", "utilities"], True, False)
        self.assertNotEqual(code, 0)
        payload = emit.call_args.args[0]
        self.assertFalse(payload["ok"])
        self.assertIn("notakind", payload["error"])


if __name__ == "__main__":
    unittest.main()
