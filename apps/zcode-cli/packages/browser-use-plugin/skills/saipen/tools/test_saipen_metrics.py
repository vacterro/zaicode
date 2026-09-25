"""Cover the parts of saipen_metrics.py that could quietly lie.

The report is only worth anything if its inputs cannot be flattered. What is
tested here is every way it could quietly read better than reality: a LOG line
shape that stops matching (the report silently sees zero), an unreadable date
that gets guessed instead of dropped, a backward transition that stops counting
as rework, a same-phase retry inflating rework instead, a product path misfiled
as protocol self-surface, and a transcript directory that cannot be read coming
back as no cost rather than as no data.
"""

import unittest
from pathlib import Path

import saipen_metrics as m


class LogParsingTests(unittest.TestCase):
    def test_live_log_parses(self):
        """The real journal must parse; a shape change must not read as silence."""
        log = Path(m.REPO) / ".saipen" / "LOG.md"
        events = m.parse_log(log)
        body_lines = sum(
            1
            for line in log.read_text(encoding="utf-8", errors="replace").splitlines()
            if line.startswith("- ") and "[E-" in line
        )
        self.assertGreater(len(events), 0)
        self.assertEqual(len(events), body_lines)

    def test_optional_brackets(self):
        line = "- 01.09.26 22:04 [E-5241] [parent: E-5240] [op: transition-x] DEC: counters"
        events = m.parse_log_lines([line])
        self.assertEqual(len(events), 1)
        self.assertIsNone(events[0]["ticket"])
        self.assertEqual(events[0]["body"], "DEC: counters")

    def test_missing_log_is_empty_not_crash(self):
        self.assertEqual(m.parse_log(Path("does-not-exist.md")), [])

    def test_event_date_normalised_and_unparseable_is_empty(self):
        """A window filter that cannot read a stamp must drop it, never guess it."""
        events = m.parse_log_lines(
            ["- 02.09.26 10:00 [E-1] [T-1] [agent: a] [op: t] RUN: x"]
        )
        self.assertEqual(m.log_event_date(events[0]), "2026-09-02")
        self.assertEqual(m.log_event_date({"date": "nonsense"}), "")


class SignalTests(unittest.TestCase):
    def _events(self, lines):
        return m.parse_log_lines(lines)

    def test_backward_transition_counts_as_rework(self):
        lines = [
            "- 01.09.26 10:00 [E-1] [T-1] [agent: a] [op: t] RUN: transition to BUILD -- x",
            "- 01.09.26 11:00 [E-2] [T-1] [agent: a] [op: t] RUN: transition to VERIFY -- x",
            "- 01.09.26 12:00 [E-3] [T-1] [agent: a] [op: t] RUN: transition to BUILD -- redo",
        ]
        signals = m.log_signals(self._events(lines))
        self.assertEqual(signals["backward_transitions"], 1)
        self.assertEqual(signals["backward_detail"], ["T-1 -> BUILD"])

    def test_forward_only_is_not_rework(self):
        lines = [
            "- 01.09.26 10:00 [E-1] [T-1] [agent: a] [op: t] RUN: transition to BUILD -- x",
            "- 01.09.26 11:00 [E-2] [T-1] [agent: a] [op: t] RUN: transition to VERIFY -- x",
            "- 01.09.26 12:00 [E-3] [T-1] [agent: a] [op: t] RUN: transition to SHIP -- x",
        ]
        self.assertEqual(m.log_signals(self._events(lines))["backward_transitions"], 0)

    def test_same_phase_reentry_is_not_counted_as_backward(self):
        """A retry or a duplicate journal event is not a phase that went backwards."""
        lines = [
            "- 01.09.26 10:00 [E-1] [T-1] [agent: a] [op: t] RUN: transition to BUILD -- x",
            "- 01.09.26 11:00 [E-2] [T-1] [agent: a] [op: t] RUN: transition to BUILD -- again",
        ]
        signals = m.log_signals(self._events(lines))
        self.assertEqual(signals["backward_transitions"], 0)
        self.assertEqual(signals["same_phase_reentries"], 1)

    def test_handoff_counted_once_per_change(self):
        lines = [
            "- 01.09.26 10:00 [E-1] [T-1] [agent: a] [op: t] RUN: work",
            "- 01.09.26 11:00 [E-2] [T-1] [agent: a] [op: t] RUN: work",
            "- 01.09.26 12:00 [E-3] [T-1] [agent: b] [op: t] RUN: resumed",
        ]
        self.assertEqual(m.log_signals(self._events(lines))["agent_handoffs_mid_ticket"], 1)


class SurfaceTests(unittest.TestCase):
    def test_protocol_paths_are_self_surface(self):
        for path in (
            "tools/validate.py",
            "saipen/CORE.md",
            ".saipen/BOARD.md",
            "tests/fixtures/x.md",
            "README.ja.md",
            "VERSION",
        ):
            self.assertTrue(m.is_self_surface(path), path)

    def test_product_paths_are_not(self):
        for path in ("src/app.py", "web/index.html", "product/README.md"):
            self.assertFalse(m.is_self_surface(path), path)


class TranscriptTests(unittest.TestCase):
    def _write(self, tmp, rows):
        import json

        path = Path(tmp) / "session.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(row if isinstance(row, str) else json.dumps(row))
                handle.write("\n")
        return path

    def test_missing_directory_is_not_free(self):
        """An unreadable transcript store must never read as zero cost."""
        scan = m.scan_transcripts(Path("no-such-transcript-dir"))
        self.assertEqual(scan["files"], 0)
        self.assertIsNone(scan["cost_units"])

    def test_usage_summed_and_priced(self):
        import tempfile

        rows = [
            {
                "timestamp": "2026-08-10T00:00:00Z",
                "message": {"usage": {"input_tokens": 100, "output_tokens": 10}},
            },
            {"timestamp": "2026-08-11T00:00:00Z", "usage": {"cache_read_input_tokens": 1000}},
            {
                "timestamp": "2026-08-12T00:00:00Z",
                "message": {"usage": {"cache_creation_input_tokens": 40}},
            },
            {"timestamp": "2026-08-12T00:00:00Z", "no": "usage"},
            "not json",
        ]
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, rows)
            scan = m.scan_transcripts(Path(tmp), "2026-08-01")

        self.assertEqual(scan["files"], 1)
        self.assertEqual(scan["messages"], 3)
        self.assertEqual(scan["raw_tokens"]["cache_read_input_tokens"], 1000)
        # 100 + 10 + 40*1.25 + 1000*0.1 == 260 cost units, over 1150 raw tokens
        self.assertEqual(scan["cost_units"], 260)
        self.assertEqual(scan["undated"], 0)

    def test_records_before_the_window_are_excluded(self):
        """A wider sample divided by a windowed ticket count would overstate cost."""
        import tempfile

        rows = [
            {"timestamp": "2026-07-01T00:00:00Z", "usage": {"input_tokens": 500}},
            {"timestamp": "2026-08-10T00:00:00Z", "usage": {"input_tokens": 7}},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, rows)
            scan = m.scan_transcripts(Path(tmp), "2026-08-01")

        self.assertEqual(scan["messages"], 1)
        self.assertEqual(scan["outside_window"], 1)
        self.assertEqual(scan["cost_units"], 7)

    def test_undated_usage_is_counted_not_silently_windowed(self):
        import tempfile

        rows = [
            {"usage": {"input_tokens": 5}},
            {"timestamp": "nonsense", "usage": {"input_tokens": 5}},
            {"timestamp": "2026-08-10T00:00:00Z", "usage": {"input_tokens": 5}},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, rows)
            scan = m.scan_transcripts(Path(tmp), "2026-08-01")

        self.assertEqual(scan["undated"], 2)
        self.assertEqual(scan["messages"], 1)

    def test_ratio_is_withheld_when_the_sample_cannot_be_aligned(self):
        """"Not attributable from existing evidence" must beat an attractive ratio."""
        import tempfile

        rows = [
            {"usage": {"input_tokens": 1000}},
            {"timestamp": "2026-08-10T00:00:00Z", "usage": {"input_tokens": 1000}},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, rows)
            data = m.collect("2026-08-01", Path(tmp))

        cost = data["token_cost"]
        self.assertIsNone(cost["window_units_per_ticket_closed"])
        self.assertIn("cannot be aligned", cost["window_ratio_withheld"])
        self.assertEqual(cost["normalized_units"], 1000)
        # The renderer must survive the withheld case rather than concatenate None.
        self.assertIn("withheld", m.render(data))

    def test_zero_closures_withholds_with_a_reason_and_still_renders(self):
        """A window that closed nothing has no denominator; say so, do not crash."""
        import tempfile

        rows = [{"timestamp": "2030-01-02T00:00:00Z", "usage": {"input_tokens": 900}}]
        with tempfile.TemporaryDirectory() as tmp:
            self._write(tmp, rows)
            data = m.collect("2030-01-01", Path(tmp))

        cost = data["token_cost"]
        self.assertEqual(data["throughput"]["tickets_closed"], 0)
        self.assertIsNone(cost["window_units_per_ticket_closed"])
        self.assertEqual(cost["window_ratio_withheld"], "no tickets closed in the report window")
        self.assertIn("no tickets closed in the report window", m.render(data))


class ReportTests(unittest.TestCase):
    def test_collect_and_render(self):
        data = m.collect("2026-08-01")
        text = m.render(data)
        self.assertIn("SAIPEN production metrics", text)
        self.assertIn("not measured here:", text)
        self.assertGreater(data["surface"]["machinery_lines_now"], 0)
        # The unmeasurables must never quietly disappear from the report.
        self.assertEqual(
            data["not_measured"],
            ["outcome quality vs a plain agent", "human wall-clock saved"],
        )

class WindowAnchorTests(unittest.TestCase):
    """Both halves of one window must mean the same instant.

    `git log --since=2026-09-02` does not mean midnight: approxidate resolves a
    dateless day using the current time of day, so on a day carrying ten
    releases that argument returned zero commits while the day before returned
    twenty-eight. The LOG side compares date strings and was always
    midnight-anchored, so the report silently lost a day.
    """

    def test_a_bare_date_is_spelled_out_to_midnight(self):
        self.assertEqual(m.git_since("2026-09-02"), "2026-09-02 00:00:00")

    def test_today_is_not_an_empty_window(self):
        """The regression itself: a window naming today must see today."""
        import datetime
        import subprocess

        today = datetime.date.today().isoformat()
        anchored = subprocess.run(
            ["git", "-C", str(m.REPO), "log", "--since=" + m.git_since(today), "--oneline"],
            capture_output=True,
            text=True,
        ).stdout
        bare = subprocess.run(
            ["git", "-C", str(m.REPO), "log", "--since=" + today, "--oneline"],
            capture_output=True,
            text=True,
        ).stdout
        if not anchored.strip():
            self.skipTest("no commits today in this clone")
        self.assertGreaterEqual(len(anchored.splitlines()), len(bare.splitlines()))
        self.assertEqual(m.window_commits(today) and True, True)


class EmptyWindowReportingTests(unittest.TestCase):
    """A directory that was read and held nothing is not a directory nobody opened."""

    def test_no_directory_reads_as_not_scanned(self):
        data = m.collect("2026-08-01")
        self.assertIn("not scanned", m.render(data))

    def test_scanned_but_empty_window_says_so_and_keeps_the_file_count(self):
        import tempfile

        rows = [{"timestamp": "2020-01-01T00:00:00Z", "usage": {"input_tokens": 500}}]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.jsonl"
            with path.open("w", encoding="utf-8") as handle:
                import json

                handle.write(json.dumps(rows[0]) + "\n")
            data = m.collect("2026-08-01", Path(tmp))

        text = m.render(data)
        self.assertNotIn("not scanned", text)
        self.assertIn("scanned 1 transcript file(s)", text)
        self.assertIn("1 before it", text)
        self.assertEqual(data["token_cost"]["transcript_files"], 1)
        self.assertEqual(data["token_cost"]["usage_records_in_window"], 0)


class UnitHonestyTests(unittest.TestCase):
    def test_unit_basis_denies_a_monetary_reading(self):
        """Output is weighted 1.0 while real output pricing is several times input."""
        self.assertEqual(m.USAGE_WEIGHTS["output_tokens"], 1.0)
        self.assertIn("not money", m.UNIT_BASIS)
        self.assertIn("face value", m.UNIT_BASIS)

    def test_basis_is_printed_beside_the_number(self):
        import tempfile

        rows = {"timestamp": "2026-08-10T00:00:00Z", "usage": {"input_tokens": 10}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "s.jsonl"
            with path.open("w", encoding="utf-8") as handle:
                import json

                handle.write(json.dumps(rows) + "\n")
            text = m.render(m.collect("2026-08-01", Path(tmp)))
        self.assertIn("normalized units in window", text)
        self.assertIn("not money", text)


if __name__ == "__main__":
    unittest.main()
