"""T-1452: an authoritative audit manifest must be true in BOTH directions.

SRC-103 defect A, measured live by SAIPENVIEW on 2026-09-21 at HEAD
654916e35a4c: the artifact reported ``authoritative_state = true``,
``required_evidence_omitted = false`` and ``mandatory_missing = []`` while
exporting ``saitranslate/.prepare-staging/<id>/.in-flight``, staged payloads,
producer/crew epoch markers and live nested SubSaipen checkpoints -- all of it
reachable only because the optional roots ``extensions``, ``kitchen`` and
``saitranslate`` were declared recursively broad. Same class as T-850.

Found with it, pointing the other way: ``recovery/`` is non-exportable as a
whole, but ``saipen ticket compact`` moves a BOARD row's full text into
``recovery/board-compaction/T-###/…json`` and leaves ``detail_ref:`` pointing
at it. The "authoritative" snapshot dropped text BOARD itself cites.

Both are one question -- "may this path enter the snapshot" -- so both are
answered by one owner, in one declared precedence, and this suite is the red
control for each direction.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import audit_manifest as am  # noqa: E402

#: The exact leak shapes the SAIPENVIEW artifact carried.
TRANSIENT = (
    "saitranslate/.prepare-staging/d3c28e8f/.in-flight",
    "saitranslate/.prepare-staging/d3c28e8f/payload/kitchen/OUTBOX.md",
    "saitranslate/.prepare-staging/d3c28e8f/payload/.saipen/STATE.md",
    "saitranslate/producer_epoch.json",
    "saitranslate/.translation-cache/Arabic/pack.json",
    "kitchen/crew_epoch.json",
    "extensions/subs/saihunt/STATE.md",
    "extensions/subs/saihunt/BOARD.md",
    "extensions/subs/saihunt/LOG.md",
    "locks/writer.lock",
    "LOCAL_STATE.json",
    "quarantine/SRC-009.md",
    "intake/active/SRC-001.md.tmp",
)

#: Durable material living under the very same roots. A repair that excludes
#: `extensions`, `kitchen` or `saitranslate` wholesale loses all of this.
DURABLE = (
    "STATE.md",
    "BOARD.md",
    "LOG.md",
    "IDENTITY.md",
    "intake/active/SRC-001.md",
    "intake/coverage/SRC-001.json",
    "evidence/T-1426/GATE.md",
    "KNOWLEDGE/INDEX.md",
    "extensions/subs/PROTOCOL.md",
    "extensions/subs/saihunt/kitchen/OUTBOX.md",
    "kitchen/digest.md",
    "recovery/board-compaction/T-1430/T-1430-6ad7ad05.json",
)


class ExportClassificationTests(unittest.TestCase):
    def test_every_measured_transient_shape_is_excluded(self):
        for rel in TRANSIENT:
            with self.subTest(path=rel):
                self.assertFalse(am.is_exportable(rel))

    def test_every_durable_shape_survives(self):
        for rel in DURABLE:
            with self.subTest(path=rel):
                self.assertTrue(am.is_exportable(rel))

    def test_board_cited_compaction_detail_is_exportable(self):
        # The positive durable declaration must outrank the `recovery/` prefix,
        # or BOARD keeps citing a path the snapshot deliberately dropped.
        self.assertTrue(
            am.is_exportable("recovery/board-compaction/T-1277/T-1277-b7a417f2.json")
        )
        self.assertFalse(am.is_exportable("recovery/settled/op-1.json"))

    def test_transient_class_beats_nesting_depth(self):
        # Red control for "just list the private ROOTS": the same file name is
        # durable at one place and transient under a staging segment.
        self.assertTrue(am.is_exportable("kitchen/OUTBOX.md"))
        self.assertFalse(
            am.is_exportable("kitchen/.prepare-staging/a/b/c/d/e/OUTBOX.md")
        )

    def test_a_new_transient_directory_needs_no_new_rule(self):
        # The contract must survive a staging directory nobody has written yet.
        self.assertFalse(am.is_exportable("extensions/.staging/x/payload/thing.md"))
        self.assertFalse(am.is_exportable("KNOWLEDGE/__pycache__/card.pyc"))

    def test_nested_instance_state_is_not_this_projects_evidence(self):
        self.assertFalse(am.is_exportable("extensions/subs/saitest/STATE.md"))
        self.assertTrue(am.is_exportable("STATE.md"), "the root checkpoint is evidence")

    def test_whole_family_exclusion_would_fail_this_suite(self):
        # The banned shortcut, asserted explicitly: excluding the three roots
        # outright is a "green" transient result that destroys durable
        # evidence, so it must be visibly wrong, not merely discouraged.
        blunt = tuple(
            rel
            for rel in DURABLE
            if rel.split("/", 1)[0] in ("extensions", "kitchen", "saitranslate")
        )
        self.assertTrue(blunt, "the fixture must contain durable material there")
        for rel in blunt:
            with self.subTest(path=rel):
                self.assertTrue(am.is_exportable(rel))

    def test_precedence_is_declared_not_invented(self):
        self.assertEqual(am.EXPORT_PRECEDENCE[0], "transient_segment_or_filename")
        self.assertIn("declared_durable_path", am.EXPORT_PRECEDENCE)
        self.assertIn("non_exportable_prefix", am.EXPORT_PRECEDENCE)


def _declared_exportable(evidence: dict, relative_path: str) -> bool:
    """A consumer that reads ONLY the published manifest JSON.

    The defect was consumer-visible: SAIPENVIEW exported what the declaration
    allowed. `is_exportable` being right proves nothing unless the declaration
    alone carries enough to reach the same answer, so this re-derives the
    verdict from the manifest's own fields in its own declared precedence.
    """
    parts = [part for part in relative_path.split("/") if part]
    last, joined = parts[-1], "/".join(parts)
    if any(part in evidence["non_exportable_segments"] for part in parts):
        return False
    if last in evidence["non_exportable_filenames"]:
        return False
    if last.endswith(tuple(evidence["non_exportable_suffixes"])):
        return False
    if len(parts) > 1 and last in evidence["nested_instance_files"]:
        return False
    if len(parts) == 1 and joined in {item["path"] for item in evidence["mandatory"]}:
        return True
    for item in evidence["conditional"]:
        path = item["path"]
        if joined == path:
            return True
        if joined.startswith(path + "/"):
            if item.get("recursive") or "/" not in joined[len(path) + 1 :]:
                return True
            break
    for prefix in evidence["non_exportable"]:
        if prefix.endswith("/"):
            if joined == prefix.rstrip("/") or joined.startswith(prefix):
                return False
        elif joined == prefix:
            return False
    return True


class DeclaredFixtureTests(unittest.TestCase):
    """The acceptance fixture: real files, transient and durable side by side
    under the same allowed optional roots, judged from the manifest alone."""

    DEEP = (
        "kitchen/.prepare-staging/a/b/c/d/e/OUTBOX.md",
        "extensions/subs/saihunt/kitchen/.in-flight",
        "saitranslate/pack/Arabic/notes.md.partial",
    )

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="saipen-t1452f-"))
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.memory = self.base / "project" / ".saipen"
        for rel in TRANSIENT + DURABLE + self.DEEP:
            path = self.memory / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture\n", encoding="utf-8")

    def _walk(self) -> list[str]:
        return sorted(
            path.relative_to(self.memory).as_posix()
            for path in self.memory.rglob("*")
            if path.is_file()
        )

    def test_the_declaration_alone_reproduces_the_owner_for_every_file(self):
        evidence = am.build(self.memory.parent)["evidence"]
        for rel in self._walk():
            with self.subTest(path=rel):
                self.assertEqual(_declared_exportable(evidence, rel), am.is_exportable(rel))

    def test_the_declared_export_keeps_durable_and_drops_transient(self):
        evidence = am.build(self.memory.parent)["evidence"]
        exported = {rel for rel in self._walk() if _declared_exportable(evidence, rel)}
        for rel in TRANSIENT + self.DEEP:
            with self.subTest(transient=rel):
                self.assertNotIn(rel, exported)
        for rel in DURABLE:
            with self.subTest(durable=rel):
                self.assertIn(rel, exported)


class ManifestContractTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="saipen-t1452-"))
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.project = self.base / "project"
        (self.project / ".saipen").mkdir(parents=True)
        for name in ("STATE.md", "BOARD.md", "LOG.md", "IDENTITY.md"):
            (self.project / ".saipen" / name).write_text("fixture\n", encoding="utf-8")

    def test_manifest_publishes_the_structural_classes(self):
        manifest = am.build(self.project)
        evidence = manifest["evidence"]
        self.assertEqual(manifest["contract_version"], 3)
        self.assertIn(".prepare-staging", evidence["non_exportable_segments"])
        self.assertIn("producer_epoch.json", evidence["non_exportable_filenames"])
        self.assertIn("crew_epoch.json", evidence["non_exportable_filenames"])
        self.assertEqual(evidence["precedence"], list(am.EXPORT_PRECEDENCE))
        self.assertIn("authoritative_state=true", evidence["authority_note"])

    def test_manifest_declares_the_compaction_surface(self):
        conditional = {item["path"] for item in am.build(self.project)["evidence"]["conditional"]}
        self.assertIn("recovery/board-compaction", conditional)

    def test_mandatory_evidence_is_unchanged(self):
        manifest = am.build(self.project)
        self.assertEqual(manifest["required"], list(am.MANDATORY_FILES))
        for item in manifest["evidence"]["mandatory"]:
            self.assertTrue((self.project / ".saipen" / item["path"]).is_file())

    def test_a_contract_2_manifest_is_stale_and_upgrades(self):
        old = am.build(self.project)
        old["contract_version"] = 2
        old["generator"] = "saipen-audit-manifest/2"
        old["evidence"].pop("non_exportable_segments", None)
        old["evidence"].pop("precedence", None)
        am.manifest_path(self.project).write_text(
            json.dumps(old, indent=2), encoding="utf-8"
        )
        self.assertEqual(am.declared(self.project)["state"], am.DECLARED_STALE)
        result = am.ensure(self.project)
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(am.declared(self.project)["state"], am.DECLARED_CURRENT)
        written = json.loads(am.manifest_path(self.project).read_text(encoding="utf-8"))
        self.assertEqual(written["contract_version"], 3)
        self.assertIn(".prepare-staging", written["evidence"]["non_exportable_segments"])

    def test_a_newer_contract_is_still_refused(self):
        newer = am.build(self.project)
        newer["contract_version"] = 99
        am.manifest_path(self.project).write_text(
            json.dumps(newer, indent=2), encoding="utf-8"
        )
        self.assertEqual(am.declared(self.project)["state"], am.DECLARED_UNSUPPORTED)


if __name__ == "__main__":
    unittest.main()
