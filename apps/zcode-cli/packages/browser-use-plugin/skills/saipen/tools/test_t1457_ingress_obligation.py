"""T-1457: the obligation a transport refusal creates must be dischargeable.

Reproduced byte-for-byte from a live consumer session on 2026-09-22.

    saipen start '<task>' --json 2>&1 | Out-String -Width 600
    -> INGRESS_TRANSPORT_UNSAFE, next: saipen start --file <path>

    saipen start --file V:\\_TEMP_\\saipen_task.txt
    -> INGRESS_PARAPHRASE_REFUSED: owes 128 bytes, sha256 1e5ce478...
       supplied digest 8d4abf8a...

    saipen start --hex <the same task, hex-encoded>
    -> INGRESS_PARAPHRASE_REFUSED: same 128 bytes owed, same 8d4abf8a supplied

The session did everything the refusal told it to, three times, and stopped at
``NEXT EXACT ACTION: NONE``. It was right to: the owed 128 bytes are the task
(90) plus the literal ``' --json 2>&1 | Out-String -Width 600``, because the
recorder kept the whole shell remainder. Those bytes are not the request, so no
transport carrying the request could ever match them. Three documented ways out
became two, and the refusal's own advice named the impossible one.

The shape was never exotic. ``saipen start '<task>' --json`` is the ordinary
invocation, and ANY token after the closing quote produced the same dead end.
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

from saipen_engine import guard_events, pending_ingress  # noqa: E402

#: The operator's actual words, and the digest the refused session kept
#: supplying. Both taken from the field trace, unaltered.
TASK = "Close T-1201 order-dependent Qt lifetime regression then resume T-1307 -> T-1306 -> T-1299"
TASK_DIGEST = "8d4abf8a12c982879334763ab82c06e3119b76e1a12e55b5e4734e72049ca096"
#: What the recorder stored instead: the same words wearing the shell.
RECORDED_LINE = f"'{TASK}' --json 2>&1 | Out-String -Width 600"
RECORDED_DIGEST = "1e5ce4787472259edd030aa93617d2e1f7d5fc387cc5ea156b2489c88e590143"

#: Every trailing shape that used to poison the record.
TRAILING_SHAPES = (
    "",
    " --json",
    " --json 2>&1",
    " --json 2>&1 | Out-String -Width 600",
    " --dry-run --json",
    " > out.txt",
)


class FieldTraceTests(unittest.TestCase):
    """The exact numbers from the trace, so the case cannot be re-argued."""

    def test_the_task_and_the_recorded_line_are_the_reported_digests(self):
        self.assertEqual(pending_ingress.ingress_digest(TASK), TASK_DIGEST)
        self.assertEqual(pending_ingress.ingress_digest(RECORDED_LINE), RECORDED_DIGEST)
        self.assertEqual(len(TASK.encode("utf-8")), 90)
        self.assertEqual(len(RECORDED_LINE.encode("utf-8")), 128)

    def test_the_difference_is_exactly_the_shell_tail(self):
        self.assertEqual(RECORDED_LINE, f"'{TASK}' --json 2>&1 | Out-String -Width 600")


class PayloadBoundaryTests(unittest.TestCase):
    def test_a_quoted_request_ends_at_its_closing_quote(self):
        for tail in TRAILING_SHAPES:
            with self.subTest(tail=tail or "(none)"):
                line = f"saipen start '{TASK}'{tail}"
                self.assertEqual(guard_events.ingress_payload(line), TASK)

    def test_both_quote_styles_and_both_ingress_verbs(self):
        for verb in ("start", "user-request"):
            for quote in ("'", '"'):
                with self.subTest(verb=verb, quote=quote):
                    line = f"saipen {verb} {quote}{TASK}{quote} --json"
                    self.assertEqual(guard_events.ingress_payload(line), TASK)

    def test_an_unquoted_request_is_unchanged(self):
        self.assertEqual(
            guard_events.ingress_payload("saipen start fix the login bug"),
            "fix the login bug",
        )

    def test_apostrophes_inside_a_double_quoted_request_survive(self):
        text = "fix the user's login bug"
        self.assertEqual(
            guard_events.ingress_payload(f'saipen start "{text}" --json'), text
        )

    def test_an_apostrophe_inside_a_single_quoted_request_survives(self):
        # T-1459: the first matching quote is not the closing quote. Ending
        # there recorded "fix the user" and built a transport carrying only
        # those bytes -- the operator's request silently truncated.
        text = "fix the user's profile page"
        for tail in TRAILING_SHAPES:
            with self.subTest(tail=tail or "(none)"):
                line = f"saipen start '{text}'{tail}"
                self.assertEqual(guard_events.ingress_payload(line), text)

    def test_a_flag_glued_to_the_closing_quote_is_part_of_the_word(self):
        # `'a'-b` is ONE shell word, "a-b"; splitting it at the quote would
        # record less than the operator typed.
        for line in ("'fix the parser'-now", "'fix the parser'2>&1"):
            with self.subTest(line=line):
                self.assertEqual(pending_ingress.split_request(line), (line, ""))
        self.assertEqual(
            pending_ingress.split_request("'fix the parser' -now"),
            ("fix the parser", "-now"),
        )

    def test_a_quote_inside_the_tail_does_not_extend_the_request(self):
        self.assertEqual(
            guard_events.ingress_payload(f"saipen start '{TASK}' | Select-String 'x'"),
            TASK,
        )

    def test_the_recorded_payload_is_what_a_transport_can_carry(self):
        # The whole point: what gets recorded must be re-suppliable through
        # --file or --hex. A payload with a pipe in it is neither.
        payload = guard_events.ingress_payload(
            f"saipen start '{TASK}' --json 2>&1 | Out-String -Width 600"
        )
        self.assertNotIn("|", payload)
        self.assertNotIn("2>&1", payload)
        self.assertEqual(pending_ingress.ingress_digest(payload), TASK_DIGEST)


class ObligationDischargeTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="saipen-t1457-"))
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.project = self.base / "project"
        (self.project / ".saipen" / "recovery").mkdir(parents=True)

    def _store(self, *, digest, size, preview):
        pending_ingress.pending_path(self.project).write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "digest": digest,
                    "bytes": size,
                    "route": "saipen start --file <path>",
                    "recorded": pending_ingress._now(),
                    "preview": preview,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    def _store_field_record(self):
        self._store(digest=RECORDED_DIGEST, size=128, preview=RECORDED_LINE)

    def test_the_field_obligation_accepts_the_request_it_always_owed(self):
        self._store_field_record()
        self.assertIsNone(pending_ingress.enforce(self.project, TASK, commit=True))
        self.assertFalse(pending_ingress.pending_path(self.project).exists())

    def test_a_real_paraphrase_is_still_refused(self):
        self._store_field_record()
        refusal = pending_ingress.enforce(
            self.project, "Fix the Qt lifetime bug and carry on", commit=True
        )
        self.assertIsNotNone(refusal)
        self.assertEqual(refusal["code"], pending_ingress.CODE_PARAPHRASE)
        self.assertTrue(
            pending_ingress.pending_path(self.project).exists(),
            "a refused paraphrase never discharges the obligation",
        )

    def test_the_refusal_publishes_the_digest_it_would_accept(self):
        self._store_field_record()
        refusal = pending_ingress.enforce(self.project, "something else", commit=False)
        self.assertEqual(refusal["accepted_request_digest"], TASK_DIGEST)

    def test_a_dry_run_never_spends_the_obligation(self):
        self._store_field_record()
        self.assertIsNone(pending_ingress.enforce(self.project, TASK, commit=False))
        self.assertTrue(pending_ingress.pending_path(self.project).exists())

    def test_a_truncated_record_refuses_to_guess(self):
        # `preview` keeps 160 characters. A longer payload is NOT stored in
        # full, so the request cannot be re-derived and must not be invented.
        long_task = "x" * 400
        self._store(
            digest=pending_ingress.ingress_digest(f"'{long_task}' --json"),
            size=len(f"'{long_task}' --json".encode("utf-8")),
            preview=f"'{long_task}' --json"[:160],
        )
        refusal = pending_ingress.enforce(self.project, long_task, commit=False)
        self.assertIsNotNone(refusal, "half a request is not a request")
        self.assertEqual(refusal["accepted_request_digest"], "")

    def test_a_request_that_opens_with_a_quote_is_not_shortened(self):
        # The one way this migration path could weaken the gate: a request
        # whose OWN first character is a quote. Stripping to the closing quote
        # would accept less text than the operator wrote, so the tail has to
        # actually be transport before the legacy digest is offered at all.
        quoted_request = "'fix the parser' and then ship the result"
        self._store(
            digest=pending_ingress.ingress_digest(quoted_request),
            size=len(quoted_request.encode("utf-8")),
            preview=quoted_request,
        )
        refusal = pending_ingress.enforce(self.project, "'fix the parser'", commit=True)
        self.assertIsNotNone(refusal, "a shorter text is not the request")
        self.assertEqual(refusal["accepted_request_digest"], "")
        self.assertIsNone(pending_ingress.enforce(self.project, quoted_request, commit=True))

    def test_only_a_transport_tail_opens_the_legacy_path(self):
        for tail, opens in ((" --json", True), (" 2>&1 | more", True), (" > out", True),
                            (" and then ship it", False), ("", False),
                            # T-1459: words BEFORE a shell mark are the
                            # operator's, so they never open the legacy path.
                            (" and then ship it | more", False)):
            with self.subTest(tail=tail or "(none)"):
                line = f"'{TASK}'{tail}"
                self._store(
                    digest=pending_ingress.ingress_digest(line),
                    size=len(line.encode("utf-8")),
                    preview=line,
                )
                found = pending_ingress.pending(self.project)
                self.assertEqual(
                    bool(pending_ingress.recorded_request_digest(found)), opens
                )

    def test_a_correctly_recorded_obligation_still_matches_exactly(self):
        self._store(digest=TASK_DIGEST, size=90, preview=TASK)
        self.assertIsNone(pending_ingress.enforce(self.project, TASK, commit=True))

    def test_supersede_still_ends_it(self):
        self._store_field_record()
        self.assertIsNone(
            pending_ingress.enforce(self.project, "a changed request", supersede=True)
        )
        self.assertFalse(pending_ingress.pending_path(self.project).exists())


class ObligationVisibilityTests(unittest.TestCase):
    """An obligation discoverable only by violating it is not discoverable."""

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="saipen-t1457v-"))
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.project = self.base / "project"
        (self.project / ".saipen" / "recovery").mkdir(parents=True)

    def test_nothing_owed_says_so(self):
        self.assertEqual(pending_ingress.obligation(self.project), {"owed": False})

    def test_a_standing_obligation_names_everything_needed_to_end_it(self):
        pending_ingress.pending_path(self.project).write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "digest": RECORDED_DIGEST,
                    "bytes": 128,
                    "route": "saipen start --file <path>",
                    "recorded": pending_ingress._now(),
                    "preview": RECORDED_LINE,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        owed = pending_ingress.obligation(self.project)
        self.assertTrue(owed["owed"])
        self.assertEqual(owed["state"], "PENDING")
        self.assertEqual(owed["digest"], RECORDED_DIGEST)
        self.assertEqual(owed["request_digest"], TASK_DIGEST)
        self.assertEqual(owed["bytes"], 128)
        self.assertIn(TASK[:40], owed["preview"])
        self.assertTrue(owed["canonical_next_command"].startswith("saipen "))
        self.assertIn(pending_ingress.SUPERSEDE_FLAG, owed["supersede_command"])
        self.assertGreater(owed["expires_in_seconds"], 0)
        self.assertLessEqual(owed["expires_in_seconds"], pending_ingress.MAX_AGE_SECONDS)

    def test_an_unreadable_obligation_still_names_its_ways_out(self):
        pending_ingress.pending_path(self.project).write_text("{ broken", encoding="utf-8")
        owed = pending_ingress.obligation(self.project)
        self.assertTrue(owed["owed"])
        self.assertEqual(owed["state"], "UNREADABLE")
        self.assertEqual(owed["code"], pending_ingress.CODE_UNREADABLE)
        self.assertIn(pending_ingress.SUPERSEDE_FLAG, owed["supersede_command"])

    def test_reading_the_obligation_writes_nothing(self):
        pending_ingress.pending_path(self.project).write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "digest": RECORDED_DIGEST,
                    "bytes": 128,
                    "route": "saipen start --file <path>",
                    "recorded": pending_ingress._now(),
                    "preview": RECORDED_LINE,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        before = pending_ingress.pending_path(self.project).read_bytes()
        pending_ingress.obligation(self.project)
        self.assertEqual(pending_ingress.pending_path(self.project).read_bytes(), before)


class StatusSurfaceTests(unittest.TestCase):
    """The operator-facing surface is `saipen status`, not the module.

    `obligation()` being correct proves nothing about what a session reads:
    the defect was that the obligation had no read-only surface at all, so
    the check runs the real CLI against a disposable project.
    """

    SCENARIO = TOOLS.parent / "tests" / "scenarios" / "userperson-valid" / ".saipen"

    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="saipen-t1457s-"))
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.project = self.base / "project"
        self.project.mkdir()
        shutil.copytree(self.SCENARIO, self.project / ".saipen")
        (self.project / ".saipen" / "USERPERSON.md").unlink(missing_ok=True)
        (self.project / ".saipen" / "recovery").mkdir(parents=True, exist_ok=True)

    def _status(self) -> dict:
        import subprocess

        done = subprocess.run(
            [sys.executable, str(TOOLS / "saipen.py"), "status", "--json",
             "--project-root", str(self.project)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        return json.loads(done.stdout)

    def test_nothing_owed_publishes_no_obligation(self):
        self.assertNotIn("pending_ingress", self._status())

    def test_status_names_the_obligation_without_attempting_the_ingress(self):
        pending_ingress.pending_path(self.project).write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "digest": RECORDED_DIGEST,
                    "bytes": 128,
                    "route": "saipen start --file <path>",
                    "recorded": pending_ingress._now(),
                    "preview": RECORDED_LINE,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        before = pending_ingress.pending_path(self.project).read_bytes()
        payload = self._status()
        owed = payload.get("pending_ingress")
        self.assertIsInstance(owed, dict, "status must carry the obligation")
        self.assertEqual(owed["digest"], RECORDED_DIGEST)
        self.assertEqual(owed["request_digest"], TASK_DIGEST)
        self.assertIn(TASK[:40], owed["preview"])
        self.assertEqual(owed["canonical_next_command"], "saipen start --file <path>")
        self.assertIn(pending_ingress.SUPERSEDE_FLAG, owed["supersede_command"])
        self.assertTrue(
            any(pending_ingress.CODE_PARAPHRASE in line
                for line in payload.get("waiting_on_you", [])),
            "the human-facing list must name the obligation too",
        )
        self.assertEqual(
            pending_ingress.pending_path(self.project).read_bytes(),
            before,
            "reading status never spends or rewrites the obligation",
        )


if __name__ == "__main__":
    unittest.main()
