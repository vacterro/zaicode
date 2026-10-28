"""T-1362: a verdict long enough to be compacted must still be evidence.

`log_compaction` replaces any event over `MAX_NEW_EVENT_BYTES` with the single
line `detail_ref: <metadata>` and keeps the original bytes beside it. That is
lossless on disk and was lossless for nobody else: `verification_evidence`,
`regression_evidence` and `structural_marker_events` all classify on event
TEXT, so a compacted VERIFY verdict carried no `PASS` token and no
`conf: high`, and the ticket read `unproven/failed`.

Measured live on this repository: T-1354 E-6594 and T-1360 E-6607 were both
VERIFY PASS verdicts with regression pairs beside them, both compacted, and
both `VERIFY -> REVIEW` transitions refused `INCOMPLETE_TICKET`. The trap was
silent in the worst way -- the agent rewrites prose hunting for the phrasing
the gate wants, when length alone decided, and a terse unproven verdict passes
where a thorough proven one does not.

The decode is proof, not trust. These tests write through the REAL compactor so
they cannot drift from the writer, and every tampering case must leave the
compacted text standing: a detail file that was edited, one that points outside
the compaction directory, and one that carries another event's line all fail
the way they already failed rather than inventing a verdict.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import log as L  # noqa: E402
from saipen_engine import log_compaction  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


STATE = """---
phase: VERIFY
task: T-1
next_action: "PHASE VERIFY T-1"
blocker: ""
transition_from: BUILD
saipen_version: 8
schema_version: 3
last_event: 100
style_contract: ded-4ae736e4
mode: full
updated: 2026-09-16T00:00:00Z
agent: test-agent
---
"""
BOARD = (
    "## DOING\n- [/] T-1 [P1] compaction fixture | verify: the verdict is read "
    "| owner: test-agent | claim_time: 2026-09-16T00:00:00Z\n"
    "## TODO\n## DONE\n## BLOCKED\n"
)
BOUNDARY = (
    "- 16.09.26 00:00 [E-100] [T-1] [agent: test-agent] [op: transition-fixture] "
    "RUN: transition to VERIFY -- fixture\n"
)
LOG = (
    "- 16.09.26 00:00 [E-99] [T-1] [agent: test-agent] [op: ticket-fixture] "
    "DEC: ticket added via SAIOPS\n" + BOUNDARY
)
#: Long enough to be compacted, and a real verdict shape.
VERDICT = (
    "VERIFY PASS T-1 -- every gate green. " + "Measured detail. " * 70 + "conf: high"
)


class CompactedVerdictTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1362-")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name).resolve() / "project"
        saipen = self.root / ".saipen"
        saipen.mkdir(parents=True)
        (saipen / "STATE.md").write_text(STATE, encoding="utf-8")
        (saipen / "BOARD.md").write_text(BOARD, encoding="utf-8")
        (saipen / "LOG.md").write_text(LOG, encoding="utf-8")
        (saipen / "IDENTITY.md").write_text(
            identity_file_content(new_project_lineage()), encoding="utf-8"
        )
        L._DETAIL_CACHE.clear()
        self.addCleanup(L._DETAIL_CACHE.clear)

    def append(self, message: str, *, tail: int = 100) -> log_compaction.LogEventResult:
        """Append one event exactly as the canonical writer would."""
        result = log_compaction.prepare_event(
            self.root,
            tail,
            "RUN",
            message,
            ticket="T-1",
            agent="test-agent",
            now="16.09.26 00:01",
            op_id="checkpoint-fixture",
        )
        for target in result.targets:
            path = self.root / target.path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(target.content)
        log = self.root / ".saipen" / "LOG.md"
        log.write_text(log.read_text(encoding="utf-8") + result.line + "\n", encoding="utf-8")
        L._DETAIL_CACHE.clear()
        return result

    def evidence(self) -> tuple[bool, str]:
        return L.verification_evidence("T-1", L.read_history_events(self.root))

    def metadata_path(self, result: log_compaction.LogEventResult) -> Path:
        return self.root / result.detail_ref

    def test_the_fixture_verdict_really_is_compacted(self):
        """Guard: a short verdict would prove nothing about compaction."""
        result = self.append(VERDICT)
        self.assertTrue(result.detail_ref, "the fixture verdict fits inline; it must not")
        self.assertIn("detail_ref:", result.line)
        self.assertNotIn("conf: high", result.line)

    def test_a_compacted_verdict_is_still_evidence(self):
        self.append(VERDICT)
        ok, why = self.evidence()
        self.assertTrue(
            ok,
            "a VERIFY PASS was written, stored losslessly, and read as unproven, "
            f"so recording more evidence made the ticket count for less: {why}",
        )

    def test_a_short_verdict_is_unchanged(self):
        self.append("VERIFY PASS T-1 -- short and inline. conf: high")
        ok, _why = self.evidence()
        self.assertTrue(ok)

    def test_a_compacted_failure_claim_still_refuses(self):
        """Decoding restores the real text, whatever it says."""
        self.append(VERDICT.replace("every gate green", "failures=3 in the gate"))
        ok, why = self.evidence()
        self.assertFalse(ok, f"a compacted failure claim was read as a pass: {why}")

    def test_edited_detail_bytes_restore_nothing(self):
        result = self.append(VERDICT)
        original = self.root / json.loads(
            self.metadata_path(result).read_text(encoding="utf-8")
        )["original_event_path"]
        original.write_bytes(original.read_bytes().replace(b"PASS", b"pass"))
        ok, _why = self.evidence()
        self.assertFalse(ok, "edited detail bytes were accepted as the original verdict")

    def test_a_reference_outside_the_compaction_directory_restores_nothing(self):
        result = self.append(VERDICT)
        metadata = self.metadata_path(result)
        record = json.loads(metadata.read_text(encoding="utf-8"))
        elsewhere = self.root / ".saipen" / "smuggled.LOG.md"
        elsewhere.write_bytes(
            (self.root / record["original_event_path"]).read_bytes()
        )
        record["original_event_path"] = ".saipen/smuggled.LOG.md"
        metadata.write_text(json.dumps(record), encoding="utf-8")
        L._DETAIL_CACHE.clear()
        ok, _why = self.evidence()
        self.assertFalse(ok, "detail was read from outside the compaction directory")

    def test_another_events_line_restores_nothing(self):
        """A swapped detail file must not lend its text to this event."""
        first = self.append(VERDICT)
        second = self.append(VERDICT.replace("T-1 --", "T-1 -- second"), tail=101)
        metadata = self.metadata_path(second)
        record = json.loads(metadata.read_text(encoding="utf-8"))
        borrowed = json.loads(self.metadata_path(first).read_text(encoding="utf-8"))
        record["original_event_path"] = borrowed["original_event_path"]
        record["original_event_sha256"] = borrowed["original_event_sha256"]
        metadata.write_text(json.dumps(record), encoding="utf-8")
        L._DETAIL_CACHE.clear()
        events = L.read_history_events(self.root)
        swapped = [event for event in events if event["event"] == 102]
        self.assertEqual(len(swapped), 1, events)
        self.assertIn(
            "detail_ref:",
            swapped[0]["text"],
            "one event's detail file was accepted as another event's text",
        )

    def test_a_symlinked_detail_node_restores_nothing(self):
        """The bytes are perfect; the node points out of the project.

        Containment bounds the path's SPELLING and the digest bounds its
        CONTENT. Neither says where the node resolves to, which is why every
        LOG segment is lstat-checked before a byte is read.
        """
        result = self.append(VERDICT)
        record = json.loads(self.metadata_path(result).read_text(encoding="utf-8"))
        inside = self.root / record["original_event_path"]
        outside = Path(self._tmp.name) / "outside.LOG.md"
        outside.write_bytes(inside.read_bytes())
        inside.unlink()
        try:
            os.symlink(outside, inside)
        except OSError as exc:  # pragma: no cover - unprivileged host
            self.skipTest(f"this host cannot create a symlink: {exc}")
        L._DETAIL_CACHE.clear()
        self.assertEqual(
            inside.read_bytes(),
            outside.read_bytes(),
            "the fixture must smuggle the RIGHT bytes, or it proves nothing",
        )
        ok, _why = self.evidence()
        self.assertFalse(ok, "detail was read through a link that leaves the project")

    def test_a_non_regular_detail_node_restores_nothing(self):
        """Detail is history, so it obeys the rule every LOG segment obeys.

        Containment bounds what the path may say and the digest bounds what it
        must contain; neither says where the node resolves to.
        """
        result = self.append(VERDICT)
        metadata = self.metadata_path(result)
        metadata.unlink()
        metadata.mkdir()
        L._DETAIL_CACHE.clear()
        ok, _why = self.evidence()
        self.assertFalse(ok, "a directory standing in for a detail file was read")

    def test_two_projects_spelled_alike_do_not_share_the_cache(self):
        """A shared entry is a WRONG answer, not a stale one.

        The digest is verified when the file is read, never when the cache is
        hit. Two projects that produce the identical compacted line -- same
        event, same message, same stamp -- therefore name the identical
        reference, and `read_history_events(".")` from two working directories
        in one process spells both roots the same. The second project's detail
        is tampered, so it must read unproven on its own bytes rather than
        inherit the first project's verdict.
        """
        import os as _os

        mine = self.append(VERDICT)
        second = self.__class__()
        second._tmp = self._tmp
        second.root = Path(self._tmp.name) / "twin"
        saipen = second.root / ".saipen"
        saipen.mkdir(parents=True)
        for name, body in (("STATE.md", STATE), ("BOARD.md", BOARD), ("LOG.md", LOG)):
            (saipen / name).write_text(body, encoding="utf-8")
        (saipen / "IDENTITY.md").write_text(
            identity_file_content(new_project_lineage()), encoding="utf-8"
        )
        twin = second.append(VERDICT)
        self.assertEqual(
            twin.detail_ref,
            mine.detail_ref,
            "the fixture must name the SAME reference in both projects, or the "
            "keys differ for a reason that has nothing to do with the root",
        )
        original = second.root / json.loads(
            (second.root / twin.detail_ref).read_text(encoding="utf-8")
        )["original_event_path"]
        original.write_bytes(original.read_bytes().replace(b"PASS", b"pass"))

        cwd = Path.cwd()
        self.addCleanup(_os.chdir, cwd)
        L._DETAIL_CACHE.clear()
        _os.chdir(self.root)
        self.assertTrue(
            L.verification_evidence("T-1", L.read_history_events("."))[0],
            "the untampered project must read as proven first, or the cache is "
            "never populated and this measures nothing",
        )
        _os.chdir(second.root)
        ok, _why = L.verification_evidence("T-1", L.read_history_events("."))
        self.assertFalse(
            ok,
            "a second project addressed as '.' inherited the first one's verdict "
            "over its own tampered bytes",
        )

    def test_a_missing_detail_file_leaves_the_compacted_text(self):
        result = self.append(VERDICT)
        self.metadata_path(result).unlink()
        L._DETAIL_CACHE.clear()
        ok, _why = self.evidence()
        self.assertFalse(ok, "a missing detail file invented a verdict")
        texts = [event["text"] for event in L.read_history_events(self.root)]
        self.assertTrue(
            any(text.startswith("detail_ref:") for text in texts),
            f"the compacted line should stand unchanged when it cannot be proved: {texts}",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
