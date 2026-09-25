"""Producer-neutral audit envelope (T-1231, SOURCE-AUDIT-ENQUEUE-01).

The bar: plain Markdown still captures, a valid envelope is parsed into
metadata, a malformed one never makes a layer unsafe, producer claims stay
claims, and parsing cannot move the file digest.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import audit_enqueue, audit_envelope, audit_inbox  # noqa: E402

SCENARIO = ROOT / "tests" / "scenarios" / "userperson-valid" / ".saipen"

VALID = (
    "<!-- saipen-audit-envelope\n"
    "audit_schema: 1\n"
    "producer: saipal\n"
    "producer_version: 0.4.1\n"
    "producer_item_id: PAL-0042\n"
    "created_at: 2026-08-31T12:00:00Z\n"
    "severity: critical\n"
    "confidence: high\n"
    "observed_project: saipen\n"
    "-->\n"
    "\n# finding\n\nThe body.\n"
)

PLAIN = "# finding\n\nNo envelope at all.\n"


class Parsing(unittest.TestCase):
    def test_plain_markdown_has_no_envelope_and_is_not_an_error(self) -> None:
        result = audit_envelope.parse(PLAIN)
        self.assertFalse(result["present"])
        self.assertTrue(result["ok"])
        self.assertEqual(result["fields"], {})

    def test_valid_envelope_is_parsed_into_fields(self) -> None:
        result = audit_envelope.parse(VALID)
        self.assertTrue(result["present"])
        self.assertTrue(result["ok"])
        self.assertEqual(result["fields"]["producer"], "saipal")
        self.assertEqual(result["fields"]["producer_item_id"], "PAL-0042")
        self.assertEqual(result["fields"]["severity"], "critical")

    def test_producer_cannot_set_its_own_maintainer_verdict(self) -> None:
        forged = VALID.replace("severity: critical", "maintainer_verdict: CONFIRMED")
        result = audit_envelope.parse(forged)
        self.assertTrue(result["ok"])
        self.assertEqual(result["maintainer_verdict"], audit_envelope.PENDING)
        self.assertNotIn("maintainer_verdict", result["fields"])

    def test_unknown_keys_are_ignored_rather_than_rejected(self) -> None:
        newer = VALID.replace("severity: critical", "future_field: whatever")
        result = audit_envelope.parse(newer)
        self.assertTrue(result["ok"])
        self.assertNotIn("future_field", result["fields"])
        self.assertEqual(result["fields"]["producer"], "saipal")

    def test_malformed_envelopes_downgrade_and_never_raise(self) -> None:
        cases = {
            "unclosed": "<!-- saipen-audit-envelope\nproducer: x\n\n# body\n",
            "not-key-value": "<!-- saipen-audit-envelope\nnonsense line\n-->\n# body\n",
            "repeated-key": "<!-- saipen-audit-envelope\nproducer: a\nproducer: b\n-->\n# b\n",
            "oversize-value": "<!-- saipen-audit-envelope\nproducer: "
            + "x" * 400
            + "\n-->\n# body\n",
        }
        for name, text in cases.items():
            result = audit_envelope.parse(text)
            self.assertTrue(result["present"], name)
            self.assertFalse(result["ok"], name)
            self.assertEqual(result["fields"], {}, name)

    def test_an_envelope_below_prose_is_not_an_envelope(self) -> None:
        buried = "# body\n\n" + VALID
        self.assertFalse(audit_envelope.parse(buried)["present"])

    def test_parsing_is_pure_and_cannot_move_the_digest(self) -> None:
        before = hashlib.sha256(VALID.encode("utf-8")).hexdigest()
        audit_envelope.parse(VALID)
        after = hashlib.sha256(VALID.encode("utf-8")).hexdigest()
        self.assertEqual(before, after)

    def test_render_round_trips_the_known_fields(self) -> None:
        block = audit_envelope.render({"producer": "audapack", "producer_item_id": "AP-7"})
        parsed = audit_envelope.parse(block + "\n# body\n")
        self.assertTrue(parsed["ok"])
        self.assertEqual(parsed["fields"], {"producer": "audapack", "producer_item_id": "AP-7"})


class Transport(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-audit-envelope-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        (self.root / ".saipen" / "USERPERSON.md").unlink(missing_ok=True)
        self.config = Path(self.tmp.name) / "user-config"
        self.env = patch.dict(os.environ, {"SAIPEN_USER_CONFIG_HOME": str(self.config)})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.tmp.cleanup()

    def _enqueue(self, body: str, op: str = "op-1") -> dict:
        return audit_enqueue.enqueue(
            self.root,
            producer="saipal",
            body=body.encode("utf-8"),
            producer_operation_id=op,
        )

    def test_the_digest_covers_the_envelope_bytes(self) -> None:
        result = self._enqueue(VALID)
        self.assertEqual(result["sha256"], hashlib.sha256(VALID.encode("utf-8")).hexdigest())
        classified = audit_inbox.classify(self.root)["layers"][0]
        self.assertEqual(classified["sha256"], result["sha256"])

    def test_a_malformed_envelope_still_produces_a_normal_workable_layer(self) -> None:
        broken = "<!-- saipen-audit-envelope\nproducer: x\n\n# real finding\n"
        self._enqueue(broken)
        classified = audit_inbox.classify(self.root)["layers"][0]
        self.assertEqual(classified["state"], audit_inbox.NEW)
        self.assertEqual((self.root / "audit" / "1.md").read_text("utf-8"), broken)


if __name__ == "__main__":
    unittest.main()
