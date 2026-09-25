"""T-1454: a blocked distributor has to name its blocker and the way out.

Measured on 2026-09-22. `saipen status` reported "6 of 6 home(s) stale" and
"last scheduled injection: skipped DIRTY_SOURCE", and stopped there. Nothing
said WHICH paths block the injector or WHAT clears them, so the repairs that
were already green in this working tree reached no clone and no installed
home -- and two downstream sessions (SRC-102 SAITULS, SRC-103 SAIPENVIEW) filed
protocol defects that had been fixed here days earlier.

The guard's scope is the other half of the contract: T-1251 already proved
that blocking on ANY dirty file means blocking forever on translation caches
and local notes, so the question stays scoped to the injected surface that
`saipen/MANIFEST.json` declares.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import autoinject as ai  # noqa: E402

MANIFEST = """{
  "copy_trees": [{"src": "saipen", "dst": "saipen"}],
  "files": [{"src": "tools/saipen.py", "dst": "tools/saipen.py"}]
}
"""


def _git(root: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    )


class InjectionBlockerTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="saipen-t1454-"))
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.repo = self.base / "source"
        (self.repo / "saipen").mkdir(parents=True)
        (self.repo / "tools").mkdir()
        (self.repo / ".saipen").mkdir()
        (self.repo / "saipen" / "MANIFEST.json").write_text(MANIFEST, encoding="utf-8")
        (self.repo / "saipen" / "CORE.md").write_text("# core\n", encoding="utf-8")
        (self.repo / "tools" / "saipen.py").write_text("# cli\n", encoding="utf-8")
        (self.repo / ".saipen" / "NOTES.md").write_text("local note\n", encoding="utf-8")
        _git(self.repo, "init", "-q")
        _git(self.repo, "-c", "user.name=fixture", "-c", "user.email=f@x", "add", "-A")
        _git(
            self.repo,
            "-c",
            "user.name=fixture",
            "-c",
            "user.email=f@x",
            "commit",
            "-q",
            "-m",
            "fixture",
        )

    def test_a_clean_surface_is_not_blocked(self):
        blocker = ai.injection_blockers(self.repo)
        self.assertEqual(blocker["condition"], ai.BLOCK_NONE)
        self.assertFalse(blocker["blocked"])
        self.assertEqual(blocker["path_count"], 0)

    def test_an_edited_protocol_file_blocks_and_is_named(self):
        (self.repo / "saipen" / "CORE.md").write_text("# core edited\n", encoding="utf-8")
        blocker = ai.injection_blockers(self.repo)
        self.assertEqual(blocker["condition"], ai.BLOCK_DIRTY_SOURCE)
        self.assertTrue(blocker["blocked"])
        self.assertIn("saipen/CORE.md", blocker["paths"])
        self.assertIn("saipen/CORE.md", blocker["canonical_next_command"])

    def test_the_first_reported_path_survives_parsing(self):
        # Red control for the exact defect this owner shipped with: the
        # captured porcelain output is stripped, so the first line loses the
        # leading space of a ` M` status and a fixed column slice ate the
        # first character of its path ("bootstrap/..." -> "ootstrap/...").
        (self.repo / "saipen" / "CORE.md").write_text("# edited\n", encoding="utf-8")
        blocker = ai.injection_blockers(self.repo)
        for path in blocker["paths"]:
            with self.subTest(path=path):
                self.assertTrue(
                    (self.repo / path).exists(), f"{path!r} is not a real path"
                )

    def test_an_untracked_file_inside_the_surface_blocks(self):
        (self.repo / "saipen" / "NEW.md").write_text("new\n", encoding="utf-8")
        blocker = ai.injection_blockers(self.repo)
        self.assertEqual(blocker["condition"], ai.BLOCK_DIRTY_SOURCE)
        self.assertIn("saipen/NEW.md", blocker["paths"])

    def test_work_outside_the_injected_surface_never_blocks(self):
        # T-1251's property, kept: an ordinary dirty project is not a reason
        # to freeze publication, or the feature ships inert again.
        (self.repo / ".saipen" / "NOTES.md").write_text("edited note\n", encoding="utf-8")
        (self.repo / "scratch.txt").write_text("scratch\n", encoding="utf-8")
        blocker = ai.injection_blockers(self.repo)
        self.assertEqual(blocker["condition"], ai.BLOCK_NONE, blocker)

    def test_a_rename_reports_the_path_that_ships(self):
        _git(self.repo, "mv", "saipen/CORE.md", "saipen/CORE2.md")
        blocker = ai.injection_blockers(self.repo)
        self.assertIn("saipen/CORE2.md", blocker["paths"])

    def test_a_non_git_source_says_so_instead_of_reading_clean(self):
        plain = self.base / "plain"
        (plain / "saipen").mkdir(parents=True)
        (plain / "saipen" / "MANIFEST.json").write_text(MANIFEST, encoding="utf-8")
        blocker = ai.injection_blockers(plain)
        self.assertEqual(blocker["condition"], ai.BLOCK_NO_GIT)
        self.assertTrue(blocker["blocked"])

    def test_the_surface_comes_from_the_manifest_not_a_second_copy(self):
        surface = ai.injected_surface(self.repo)
        self.assertEqual(surface, ["saipen", "saipen/MANIFEST.json", "tools/saipen.py"])

    def test_a_blocked_report_tells_the_operator_what_clears_it(self):
        (self.repo / "saipen" / "CORE.md").write_text("# edited\n", encoding="utf-8")
        blocker = ai.injection_blockers(self.repo)
        command = blocker["canonical_next_command"]
        self.assertTrue(command.startswith("git add "), command)
        self.assertIn("commit", command)


if __name__ == "__main__":
    unittest.main()
