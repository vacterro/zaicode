"""Distribution freshness regressions (T-1271).

Every installed home already carried a stamp naming the source head it was
built from, and the scheduled runner already logged why a run published
nothing. Neither was readable from the project: `saipen status` said nothing
about injection, so "does an installed agent home run current SAIPEN" could be
answered only by opening a log under LOCALAPPDATA. Measured when the ticket
was written: all four homes held 7.241.1 while HEAD was two releases ahead,
and every scheduled run since 18:31 had skipped with SKIP DIRTY_SOURCE.

The guard that stalls distribution on a dirty source is correct. The defect was
that one uncommitted edit could stall it indefinitely and only a log file knew.

T-1371: that same log was then read as the CURRENT verdict -- `fresh` required
`not blocked`, where `blocked` was the newest run's skip or rc -- so after a
clean manual injection made every home current, one historical SKIP:
DIRTY_SOURCE still held the report red until an unrelated actor ran again.
The newest run is now `last_run` provenance; freshness comes from current bytes
alone, and each direction is pinned below: old failure cannot poison current
green, old success cannot hide current red.

T-1342: a stamp and a head are provenance. Every fixture home here holds a real
(miniature) shipped runtime, because `fresh` now means the bytes an agent would
execute ARE the accepted generation -- a directory holding only a stamp is not
an installed home at all.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import autoinject as A  # noqa: E402
from saipen_engine.runtime_surface import (  # noqa: E402
    installed_relpath,
    runtime_generation_identity,
    runtime_surface_items,
)

HEAD = "a" * 40
OLD = "b" * 40

RUN = "=== saipen scheduled inject run=deadbeef ==="

#: A miniature manifest: the identity is derived from the manifest in the root
#: under test, so a small declared surface exercises every rule.
MINI_MANIFEST = {
    "copy_trees": [{"src": "tools", "dst": "tools"}],
    "files": [
        {"src": "saipen/MANIFEST.json", "required": True},
        {"src": "saipen/BOOT.md", "required": True},
        {"src": "VERSION", "required": True},
    ],
}


def mini_source(root: Path) -> Path:
    """A source-layout SAIPEN home with a complete miniature runtime."""
    (root / "saipen").mkdir(parents=True)
    (root / "saipen" / "MANIFEST.json").write_text(
        json.dumps(MINI_MANIFEST), encoding="utf-8", newline="\n"
    )
    (root / "saipen" / "BOOT.md").write_text("# BOOT\n", encoding="utf-8", newline="\n")
    (root / "VERSION").write_text("9.9.9\n", encoding="utf-8", newline="\n")
    (root / "tools" / "saipen_engine").mkdir(parents=True)
    (root / "tools" / "saipen.py").write_text("# engine v1\n", encoding="utf-8", newline="\n")
    (root / "tools" / "saipen_engine" / "board.py").write_text(
        "# parser v1\n", encoding="utf-8", newline="\n"
    )
    return root


def install_copy(source: Path, target: Path) -> Path:
    """What the injector lands: flattened surface plus rendered launchers."""
    for declared, member in runtime_surface_items(source):
        landed = target / installed_relpath(declared)
        landed.parent.mkdir(parents=True, exist_ok=True)
        landed.write_bytes(member.read_bytes())
    cli = (target / "tools" / "saipen.py").resolve()
    (target / "bin").mkdir(parents=True, exist_ok=True)
    (target / "bin" / "saipen").write_text(f'#!/bin/sh\nexec python "{cli}" "$@"\n', "utf-8")
    (target / "bin" / "saipen.cmd").write_text(f'@echo off\r\npython "{cli}" %*\r\n', "utf-8")
    return target


class DistributionFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-distribution-")
        self.base = Path(self.tmp.name)
        self.appdata = self.base / "appdata"
        (self.appdata / "saipen").mkdir(parents=True)
        self.env = patch.dict(os.environ, {"LOCALAPPDATA": str(self.appdata)})
        self.env.start()
        self.source = mini_source(self.base / "source")
        self.home_patch = patch.object(A, "HOME", self.source)
        self.home_patch.start()

    def tearDown(self) -> None:
        self.home_patch.stop()
        self.env.stop()
        self.tmp.cleanup()

    # helpers -------------------------------------------------------------

    def home(self, name: str, head: str | None, at: str = "2026-09-03T00:00:00Z") -> Path:
        target = install_copy(self.source, self.base / name / "skills" / "saipen")
        record: dict = {"digest": runtime_generation_identity(self.source)}
        if head:
            record["source_head"] = head
        if at:
            record["installed_at"] = at
        (target / A.STAMP).write_text(json.dumps(record), encoding="utf-8")
        return target

    def absent(self, name: str) -> Path:
        return self.base / name / "skills" / "saipen"

    def log(self, *lines: str) -> Path:
        path = self.appdata / "saipen" / "inject.log"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def report(self, targets: list[Path], head: str | None = HEAD) -> dict:
        with patch.object(A, "TARGETS", targets):
            return A.distribution_report(source_head=head)

    def tree(self) -> dict[str, str]:
        out = {}
        for path in sorted(self.base.rglob("*")):
            if path.is_file():
                out[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
        return out


# ---------------------------------------------------------------------------
# AC-01 -- how many homes are stale, and the newest head they carry
# ---------------------------------------------------------------------------


class StaleCountTests(DistributionFixture):
    def test_a_stale_home_is_counted_and_named(self) -> None:
        targets = [self.home(".claude", OLD), self.home(".codex", HEAD)]
        report = self.report(targets)
        self.assertEqual(report["installed"], 2)
        self.assertEqual(report["stale"], 1)
        self.assertEqual(report["stale_homes"], [".claude"])

    def test_the_newest_installed_head_is_the_most_recently_stamped(self) -> None:
        targets = [
            self.home(".claude", OLD, at="2026-09-01T00:00:00Z"),
            self.home(".codex", HEAD, at="2026-09-03T00:00:00Z"),
        ]
        self.assertEqual(self.report(targets)["newest_installed_head"], HEAD)

    def test_all_stale_still_reports_the_newest_head_they_carry(self) -> None:
        targets = [
            self.home(".claude", OLD, at="2026-09-01T00:00:00Z"),
            self.home(".codex", OLD, at="2026-09-02T00:00:00Z"),
        ]
        report = self.report(targets)
        self.assertEqual(report["stale"], 2)
        self.assertEqual(report["newest_installed_head"], OLD)
        self.assertNotEqual(report["newest_installed_head"], report["source_head"])

    def test_an_absent_home_is_not_stale_it_is_simply_not_installed(self) -> None:
        targets = [self.home(".claude", HEAD), self.absent(".codex")]
        report = self.report(targets)
        self.assertEqual(report["installed"], 1)
        self.assertEqual(report["stale"], 0)

    def test_a_home_with_no_head_is_unknown_and_never_counted_fresh(self) -> None:
        # A copy that cannot say what it was built from is the case the stamp
        # exists to expose; counting it current would hide exactly that.
        report = self.report([self.home(".claude", None)])
        self.assertEqual(report["unknown"], 1)
        self.assertEqual(report["stale"], 1)
        self.assertFalse(report["fresh"])

    def test_the_summary_names_both_numbers(self) -> None:
        targets = [self.home(".claude", OLD), self.home(".codex", HEAD)]
        line = A.distribution_line(self.report(targets))
        self.assertIn("1 of 2 home(s) stale", line)
        self.assertIn(HEAD[:12], line)


# ---------------------------------------------------------------------------
# AC-02 -- the newest scheduler run is provenance, never the current verdict
# ---------------------------------------------------------------------------


class LastScheduledRunTests(DistributionFixture):
    def test_a_skipped_run_keeps_its_reason_and_dirty_paths_as_history(self) -> None:
        self.log(
            f"2026-09-03 09:46:00 {RUN}",
            "2026-09-03 09:46:00 dirty:  M saipen/CORE.md",
            "2026-09-03 09:46:00 dirty:  M tools/saipen.py",
            "2026-09-03 09:46:00 SKIP: DIRTY_SOURCE",
            "2026-09-03 09:46:00 === end rc=2 ===",
        )
        report = self.report([self.home(".claude", OLD)])
        self.assertEqual(report["last_run"]["status"], "skipped")
        self.assertEqual(report["last_run"]["skip"], "DIRTY_SOURCE")
        self.assertEqual(report["last_run"]["rc"], 2)
        self.assertEqual(
            report["last_run"]["dirty"], ["M saipen/CORE.md", "M tools/saipen.py"]
        )
        line = A.distribution_line(report)
        self.assertIn("last scheduled injection: skipped DIRTY_SOURCE", line)
        self.assertNotIn("injection blocked", line)

    def test_a_nonzero_run_with_no_skip_line_is_history_not_a_verdict(self) -> None:
        self.log(f"2026-09-03 09:46:00 {RUN}", "2026-09-03 09:46:00 === end rc=9 ===")
        report = self.report([self.home(".claude", OLD)])
        self.assertEqual(report["last_run"]["status"], "failed")
        self.assertEqual(report["last_run"]["rc"], 9)
        self.assertEqual(report["stale"], 1)

    def test_a_successful_run_is_history_too(self) -> None:
        self.log(
            f"2026-09-03 12:46:00 {RUN}",
            f"2026-09-03 12:46:12 inject: head={HEAD} exit=0",
            "2026-09-03 12:46:12 === end rc=0 ===",
        )
        report = self.report([self.home(".claude", HEAD)])
        self.assertEqual(report["last_run"]["status"], "success")
        self.assertTrue(report["fresh"])
        self.assertIn("last scheduled injection: success", A.distribution_line(report))

    def test_only_the_newest_run_is_provenance(self) -> None:
        self.log(
            f"2026-09-03 09:00:00 {RUN}",
            "2026-09-03 09:00:00 SKIP: DIRTY_SOURCE",
            "2026-09-03 09:00:00 === end rc=2 ===",
            f"2026-09-03 12:00:00 {RUN}",
            "2026-09-03 12:00:00 === end rc=0 ===",
        )
        report = self.report([self.home(".claude", HEAD)])
        self.assertEqual(report["last_run"]["status"], "success")

    def test_a_run_still_in_flight_is_provenance_and_never_a_success(self) -> None:
        self.log(f"2026-09-03 12:00:00 {RUN}", "2026-09-03 12:00:00 inject: working")
        run = A.last_inject_run()
        self.assertIsNotNone(run)
        self.assertIsNone(run["rc"])
        report = self.report([self.home(".claude", HEAD)])
        self.assertEqual(report["last_run"]["status"], "in_flight")
        self.assertTrue(report["last_run"]["in_flight"])
        self.assertNotIn("success", A.distribution_line(report))
        self.assertTrue(report["fresh"])

    def test_no_scheduler_log_is_a_normal_answer(self) -> None:
        self.assertIsNone(A.scheduler_log())
        self.assertIsNone(A.last_inject_run())
        report = self.report([self.home(".claude", HEAD)])
        self.assertIsNone(report["last_run"])
        self.assertTrue(report["fresh"])

    def test_a_historical_skip_no_longer_poisons_current_homes(self) -> None:
        # The T-1371 defect specimen, transformed (was: a blocked run makes a
        # current-looking set not fresh). A scheduler log whose newest run
        # skipped DIRTY_SOURCE, over homes that currently match the source
        # generation, must read fresh -- while the skip stays visible as
        # history. RED before the fix: fresh False with blocked=DIRTY_SOURCE.
        self.log(
            f"2026-09-03 09:46:00 {RUN}",
            "2026-09-03 09:46:00 dirty:  M saipen/CORE.md",
            "2026-09-03 09:46:00 SKIP: DIRTY_SOURCE",
            "2026-09-03 09:46:00 === end rc=2 ===",
        )
        report = self.report([self.home(".claude", HEAD)])
        self.assertEqual(report["stale"], 0)
        self.assertEqual(report["unknown"], 0)
        self.assertEqual(report["surface_unknown"], 0)
        self.assertTrue(report["fresh"])
        self.assertEqual(report["last_run"]["skip"], "DIRTY_SOURCE")
        self.assertEqual(report["last_run"]["dirty"], ["M saipen/CORE.md"])
        line = A.distribution_line(report)
        self.assertIn("current", line)
        self.assertIn("last scheduled injection: skipped DIRTY_SOURCE", line)
        self.assertNotIn("injection blocked", line)

    def test_a_successful_history_cannot_hide_currently_stale_bytes(self) -> None:
        # The symmetric direction: reassuring history must not mask current
        # red any more than old failure may poison current green.
        self.log(f"2026-09-03 12:46:00 {RUN}", "2026-09-03 12:46:12 === end rc=0 ===")
        target = self.home(".opencode", HEAD)
        (target / "tools" / "saipen_engine" / "board.py").write_text(
            "# parser v0 -- an older generation\n", encoding="utf-8"
        )
        report = self.report([target])
        self.assertEqual(report["last_run"]["status"], "success")
        self.assertEqual(report["stale"], 1)
        self.assertFalse(report["fresh"])

    def test_a_reassuring_history_cannot_make_an_unknown_surface_fresh(self) -> None:
        self.log(f"2026-09-03 12:46:00 {RUN}", "2026-09-03 12:46:12 === end rc=0 ===")
        report = self.report([self.home(".claude", None)])
        self.assertEqual(report["last_run"]["status"], "success")
        self.assertEqual(report["unknown"], 1)
        self.assertFalse(report["fresh"])


# ---------------------------------------------------------------------------
# AC-03 -- it reads, and stores nothing
# ---------------------------------------------------------------------------


class ReadOnlyTests(DistributionFixture):
    def test_the_report_writes_nothing(self) -> None:
        targets = [self.home(".claude", OLD), self.home(".codex", HEAD)]
        self.log(f"2026-09-03 09:46:00 {RUN}", "2026-09-03 09:46:00 === end rc=0 ===")
        before = self.tree()
        report = self.report(targets)
        A.distribution_line(report)
        self.assertEqual(before, self.tree())

    def test_it_never_creates_an_absent_home(self) -> None:
        target = self.absent(".codex")
        self.report([self.home(".claude", HEAD), target])
        self.assertFalse(target.exists())

    def test_it_never_writes_a_stamp_into_an_unstamped_home(self) -> None:
        target = self.base / ".codex" / "skills" / "saipen"
        target.mkdir(parents=True)
        report = self.report([target])
        self.assertEqual(report["unknown"], 1)
        self.assertFalse((target / A.STAMP).exists())


# ---------------------------------------------------------------------------
# AC-04 -- a current set answers, it does not go quiet
# ---------------------------------------------------------------------------


class FreshIsAnAnswerTests(DistributionFixture):
    def test_a_fully_current_set_reports_fresh_with_a_sentence(self) -> None:
        targets = [self.home(".claude", HEAD), self.home(".codex", HEAD)]
        report = self.report(targets)
        self.assertTrue(report["fresh"])
        line = A.distribution_line(report)
        self.assertTrue(line.strip())
        self.assertIn("2 home(s) current", line)
        self.assertIn(HEAD[:12], line)

    def test_no_installed_home_says_so_rather_than_printing_nothing(self) -> None:
        report = self.report([self.absent(".claude")])
        self.assertEqual(report["installed"], 0)
        self.assertFalse(report["fresh"])
        self.assertIn("no installed agent home", A.distribution_line(report))

    def test_fresh_and_stale_produce_different_sentences(self) -> None:
        fresh = A.distribution_line(self.report([self.home(".claude", HEAD)]))
        stale = A.distribution_line(self.report([self.home(".codex", OLD)]))
        self.assertNotEqual(fresh, stale)
        self.assertIn("current", fresh)
        self.assertIn("stale", stale)


# ---------------------------------------------------------------------------
# T-1342 -- fresh means the executed bytes, not the stamp or the head
# ---------------------------------------------------------------------------


class RuntimeContentTests(DistributionFixture):
    def test_a_current_stamp_and_head_over_a_stale_engine_is_stale(self) -> None:
        target = self.home(".opencode", HEAD)
        (target / "tools" / "saipen_engine" / "board.py").write_text(
            "# parser v0 -- an older generation\n", encoding="utf-8"
        )
        report = self.report([target])
        home = report["homes"][0]
        self.assertEqual(home["source_head"], HEAD)
        self.assertFalse(home["generation_current"], home)
        self.assertNotEqual(home["runtime_generation"], home["expected_generation"])
        self.assertEqual(report["stale"], 1)
        self.assertFalse(report["fresh"])

    def test_a_stamp_without_a_runtime_is_never_fresh(self) -> None:
        target = self.base / ".claude" / "skills" / "saipen"
        target.mkdir(parents=True)
        (target / A.STAMP).write_text(
            json.dumps(
                {
                    "digest": runtime_generation_identity(self.source),
                    "source_head": HEAD,
                    "installed_at": "2026-09-03T00:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        report = self.report([target])
        self.assertIsNone(report["homes"][0]["runtime_generation"])
        self.assertEqual(report["stale"], 1)
        self.assertFalse(report["fresh"])

    def test_a_dirty_source_with_the_same_head_is_not_fresh(self) -> None:
        target = self.home(".codex", HEAD)
        self.assertTrue(self.report([target])["fresh"])
        (self.source / "tools" / "saipen.py").write_text("# engine v2 (uncommitted)\n", "utf-8")
        report = self.report([target], head=HEAD)
        self.assertFalse(report["fresh"])
        self.assertEqual(report["stale_homes"], [".codex"])

    def test_an_extra_installed_module_is_a_different_generation(self) -> None:
        target = self.home(".gemini", HEAD)
        (target / "tools" / "saipen_engine" / "leftover.py").write_text("# stray\n", "utf-8")
        self.assertFalse(self.report([target])["fresh"])

    def test_a_launcher_that_does_not_run_the_installed_engine_is_stale(self) -> None:
        target = self.home(".kiro", HEAD)
        (target / "bin" / "saipen.cmd").write_text(
            '@echo off\r\npython "V:\\elsewhere\\tools\\saipen.py" %*\r\n', encoding="utf-8"
        )
        report = self.report([target])
        self.assertIn("wrong-target:bin/saipen.cmd", report["homes"][0]["launcher_problems"])
        self.assertFalse(report["fresh"])

    def test_crlf_transport_of_the_same_runtime_stays_fresh(self) -> None:
        target = self.home(".agents", HEAD)
        boot = target / "BOOT.md"
        boot.write_bytes(boot.read_bytes().replace(b"\n", b"\r\n"))
        self.assertTrue(self.report([target])["fresh"])


if __name__ == "__main__":
    unittest.main()
