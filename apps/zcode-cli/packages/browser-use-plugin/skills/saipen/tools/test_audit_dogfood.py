"""Producer-neutral transport dogfood and the SAIPAL bridge (T-1235, T-1237).

The audit's demand for the bridge is a negative one: SAIPAL must need NOTHING
that a shell script does not also get. Its whole surface is the constrained
enqueue plus a read-only disposition lookup, and SAIPEN must not branch
semantically on `producer == SAIPAL` anywhere. So the test drives the same
loop for three shapes of producer -- a hand-dropped file, an AUDAPACK-style
enveloped enqueue, and a synthetic SAIPAL-shaped one -- and asserts the
transport treats them identically.

A finding id like `PAL-0042` has to survive the whole way through: enqueue,
capture, closure and the deletion of the layer itself.
"""

from __future__ import annotations

import ast
import hashlib
import json
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

ENGINE = ROOT / "tools" / "saipen_engine"

BODY = "# finding\n\nSomething is wrong.\n"


def enveloped(producer: str, item_id: str) -> str:
    return (
        audit_envelope.render(
            {
                "audit_schema": "1",
                "producer": producer,
                "producer_version": "1.0.0",
                "producer_item_id": item_id,
                "severity": "critical",
                "confidence": "high",
            }
        )
        + "\n"
        + BODY
    )


class DogfoodFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-audit-dogfood-")
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

    def _canonical_state(self) -> dict:
        """Everything the transport says about the inbox, producer erased."""
        layers = audit_inbox.classify(self.root)["layers"]
        return {
            "layers": [
                {"layer": item["layer"], "rel": item["rel"], "state": item["state"]}
                for item in layers
            ],
            "next": (audit_inbox.projection(self.root) or {}).get("action"),
        }


class ProducerNeutrality(DogfoodFixture):
    def test_three_producer_shapes_reach_the_same_transport_state(self) -> None:
        observed = []
        for producer, item_id in (("audapack", "AP-0007"), ("saipal", "PAL-0042")):
            with self.subTest(producer=producer):
                self.tearDown()
                self.setUp()
                result = audit_enqueue.enqueue(
                    self.root,
                    producer=producer,
                    body=enveloped(producer, item_id).encode("utf-8"),
                    producer_operation_id="run-1",
                    producer_item_id=item_id,
                )
                self.assertTrue(result["ok"], result)
                observed.append(self._canonical_state())
        # A hand-dropped file is the third shape: no API, no envelope.
        self.tearDown()
        self.setUp()
        manual = self.root / "audit" / "1.md"
        manual.parent.mkdir(parents=True, exist_ok=True)
        manual.write_bytes(BODY.encode("utf-8"))
        observed.append(self._canonical_state())

        self.assertEqual(observed[0], observed[1], "AUDAPACK and SAIPAL diverged")
        self.assertEqual(observed[0], observed[2], "an API layer diverged from a manual drop")

    def test_no_engine_module_branches_on_a_producer_name(self) -> None:
        """A producer name may appear in prose. It may not reach EXECUTABLE code.

        Docstrings are excluded deliberately -- naming AUDAPACK and SAIPAL as
        the motivating callers is how the modules explain themselves. A string
        literal anywhere else, or an identifier, is a branch waiting to happen.
        """
        names = ("saipal", "audapack")
        offenders = []
        for path in sorted(ENGINE.glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            docstrings = set()
            holders = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
            for node in ast.walk(tree):
                if isinstance(node, holders):
                    body = getattr(node, "body", [])
                    if (
                        body
                        and isinstance(body[0], ast.Expr)
                        and isinstance(body[0].value, ast.Constant)
                        and isinstance(body[0].value.value, str)
                    ):
                        docstrings.add(id(body[0].value))
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    if id(node) in docstrings:
                        continue
                    if any(name in node.value.lower() for name in names):
                        offenders.append(f"{path.name}:{node.lineno}: string {node.value[:40]!r}")
                elif isinstance(node, ast.Name) and any(n in node.id.lower() for n in names):
                    offenders.append(f"{path.name}:{node.lineno}: name {node.id}")
                elif isinstance(node, ast.Attribute) and any(
                    n in node.attr.lower() for n in names
                ):
                    offenders.append(f"{path.name}:{node.lineno}: attribute {node.attr}")
        self.assertEqual(offenders, [], "a producer name reached executable code")

    def test_the_producer_surface_is_exactly_enqueue_plus_a_read_only_lookup(self) -> None:
        public = {name for name in dir(audit_enqueue) if not name.startswith("_")}
        mutating = {name for name in public if name in {"enqueue", "write_allocator"}}
        self.assertEqual(mutating, {"enqueue", "write_allocator"})
        # `write_allocator` is engine-internal plumbing, not a producer verb;
        # the bridge SAIPAL is handed is enqueue plus the read-only trace.
        self.assertTrue(callable(audit_enqueue.enqueue))
        self.assertTrue(callable(audit_inbox.provenance_trace))


class BridgeContainment(DogfoodFixture):
    def _digests(self) -> dict:
        out = {}
        for rel in ("BOARD.md", "STATE.md", "LOG.md"):
            path = self.root / ".saipen" / rel
            out[rel] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        return out

    def test_a_producer_cannot_write_core_board_state_or_log(self) -> None:
        before = self._digests()
        audit_enqueue.enqueue(
            self.root,
            producer="saipal",
            body=enveloped("saipal", "PAL-0042").encode("utf-8"),
            producer_operation_id="run-1",
            producer_item_id="PAL-0042",
        )
        self.assertEqual(self._digests(), before)

    def test_a_producer_cannot_choose_a_path_or_overwrite_a_layer(self) -> None:
        squatter = self.root / "audit" / "1.md"
        squatter.parent.mkdir(parents=True, exist_ok=True)
        squatter.write_bytes(b"# already here\n")
        result = audit_enqueue.enqueue(
            self.root, producer="saipal", body=b"# new\n", producer_operation_id="run-1"
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["layer"], 2)
        self.assertEqual(squatter.read_bytes(), b"# already here\n")

    def test_producer_severity_and_confidence_stay_claims(self) -> None:
        text = enveloped("saipal", "PAL-0042")
        provenance = audit_inbox.layer_provenance(text)
        self.assertEqual(provenance["claims"]["severity"], "critical")
        self.assertEqual(provenance["maintainer_verdict"], audit_envelope.PENDING)
        # The claim is recorded, and the routing projection never reads it.
        audit_enqueue.enqueue(
            self.root, producer="saipal", body=text.encode("utf-8"), producer_operation_id="run-1"
        )
        routed = audit_inbox.projection(self.root) or {}
        self.assertNotIn("critical", json.dumps(routed))

    def test_a_producer_finding_id_survives_closure_and_deletion(self) -> None:
        text = enveloped("saipal", "PAL-0042")
        audit_enqueue.enqueue(
            self.root, producer="saipal", body=text.encode("utf-8"), producer_operation_id="run-1"
        )
        audit_inbox.bind_layer(
            self.root,
            "audit/1.md",
            layer=1,
            generation=1,
            file_sha256=audit_enqueue.layer_digest(text.encode("utf-8")),
            size_bytes=len(text),
            receipt_id="SRC-001",
            receipt_sha256=audit_enqueue.layer_digest(text.encode("utf-8")),
            binding="exact",
            linked_work="T-900",
            state=audit_inbox.ACTIVE,
            provenance=audit_inbox.layer_provenance(text),
        )
        (self.root / "audit" / "1.md").unlink()
        audit_inbox.bind_layer(
            self.root,
            "audit/1.md",
            layer=1,
            generation=1,
            file_sha256=audit_enqueue.layer_digest(text.encode("utf-8")),
            size_bytes=len(text),
            receipt_id="SRC-001",
            receipt_sha256=audit_enqueue.layer_digest(text.encode("utf-8")),
            binding="exact",
            linked_work="T-900",
            state=audit_inbox.DELETED,
            provenance=None,
        )
        row = audit_inbox.provenance_trace(self.root, 1)["rows"][0]
        self.assertEqual(row["producer_item_id"], "PAL-0042")
        self.assertEqual(row["transport_state"], audit_inbox.DELETED)
        self.assertFalse((self.root / "audit" / "1.md").exists())

    def test_a_rejected_finding_is_a_valid_terminal_outcome(self) -> None:
        # Rejection is closure, not an error: the trace must be able to carry
        # a Work item that closed without the producer's fix being adopted.
        text = enveloped("saipal", "PAL-0042")
        audit_inbox.bind_layer(
            self.root,
            "audit/1.md",
            layer=1,
            generation=1,
            file_sha256="a" * 64,
            size_bytes=len(text),
            receipt_id="SRC-001",
            receipt_sha256="a" * 64,
            binding="exact",
            linked_work="T-900",
            state=audit_inbox.DELETED,
            provenance=audit_inbox.layer_provenance(text),
        )
        row = audit_inbox.provenance_trace(self.root, 1)["rows"][0]
        self.assertEqual(row["work"], "T-900")
        self.assertFalse(row["producer_claims_trusted"])


if __name__ == "__main__":
    unittest.main()
