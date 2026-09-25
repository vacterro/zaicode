"""Terminal recovered-source attribution proof (SAIPEN T-1315 / AUDAPACK T-183).

THE DEFECT: a terminal TOMBSTONE_AUTHORITATIVE recovery leaves an
INTENTIONALLY PRESERVED INVALID original Contract as durable residue. Strict
Core correctly reports it forever (the archive is immutable; fabricating 16
clauses would be forgery). Work-delta could not attribute the residue to its
proven historical linked Work, so it stayed GLOBAL and permanently blocked
unrelated Work.

THE FIX, AND ITS LIMITS: `intake.evaluate_terminal_recovered_source_attribution`
is a READ-ONLY fail-closed proof. It returns ATTRIBUTABLE only when every
provenance condition holds, NOT_ATTRIBUTABLE otherwise -- never an exception,
never a project mutation, never a contract repair. The Work-delta branch that
consumes it is attribution, NOT a waiver: the strict finding keeps its
rule_id, its severity, its subject and its key, and every refused condition
still blocks.

These tests are the red-first matrix: the exact SRC-038-shaped fixture
attributes to T-160, and every integrity/provenance negative stays GLOBAL.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import debt as debt_mod  # noqa: E402
from saipen_engine import findings as findings_mod  # noqa: E402
from saipen_engine import intake  # noqa: E402

SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"

RECEIPT = "SRC-038"
WORK = "T-160"
TARGET_WORK = "T-158"
TARGET_SOURCE = "SRC-036"
SOURCE_SHA = "9a32a6e55a39add61c197f026d3eca932b950608d1d5627283299c589c3224cb"
REQUIREMENTS = 16
CLOSED_AT = "2026-09-06T18:00:00Z"
RECOVERED_AT = "2026-09-07T14:32:00Z"
RUN = "acb-mto9cetk-8776967d9bc24cb7a4c6 (quick3, 3 waves)"

CURRENT_TOMBSTONE = {
    "actionable": 16,
    "archive_ref": ".saipen/archive/source/SRC-038.md",
    "closed_at": CLOSED_AT,
    "closure_event": RUN,
    "linked_work": WORK,
    "receipt_id": RECEIPT,
    "recovery": {
        "method": "TOMBSTONE_AUTHORITATIVE",
        "record": ".saipen/archive/source/SRC-038.recovery.json",
        "recovered_at": RECOVERED_AT,
    },
    "requirements": 16,
    "schema_version": 1,
    "source_sha256": SOURCE_SHA,
    "status": "CLOSED",
    "unresolved": 0,
}

ORIGINAL_TOMBSTONE = {
    "captured_at": "2026-09-05T13:54:24Z",
    "closed_at": CLOSED_AT,
    "closure": {
        "actionable_clauses": 16,
        "contract_bound": True,
        "coverage": ".saipen/intake/coverage/SRC-038.json",
        "digest_pass": True,
        "run": RUN,
        "terminal_clauses": 16,
        "work_done": WORK,
    },
    "consumption": {
        "deleted": True,
        "deleted_at": CLOSED_AT,
        "file": "audit/7.md",
        "file_sha256": SOURCE_SHA,
        "generation": 1,
        "size_bytes": 58593,
    },
    "kind": "external_audit",
    "layer": "audit/7.md",
    "linked_work": WORK,
    "receipt_id": RECEIPT,
    "schema_version": 1,
    "source_sha256": SOURCE_SHA,
    "transport": "audit_inbox",
}


def _zero_clause_contract() -> dict:
    """The preserved ORIGINAL: zero clauses, structurally invalid, never fixed."""
    return {
        "clauses": {},
        "derived_at": None,
        "derived_from": RECEIPT,
        "interpretation_revision": 0,
        "schema_version": 1,
        "source_sha256": SOURCE_SHA,
    }


def _coverage(count: int = REQUIREMENTS, work: str = WORK, rids: list[str] | None = None) -> dict:
    requirements = {}
    for index in range(1, count + 1):
        rid = f"{RECEIPT}:R{index:03d}"
        if rids and rid in rids:
            continue
        requirements[rid] = {
            "disposition": "IMPLEMENTED",
            "evidence": f".saipen/kitchen/{WORK}-build.md clause CORE-{index:03d}",
            "linked_work": work,
            "source_ticket": f"CORE-{index:03d}",
            "verification": "python -m pytest -q (1116 PASS, 2 skip); ruff clean",
        }
    if rids:
        requirements = {k: v for k, v in requirements.items() if k not in set(rids)}
    return {"requirements": requirements}


def _b64(doc: dict) -> str:
    return base64.b64encode(
        json.dumps(doc, indent=2).encode("utf-8"),
    ).decode("ascii")


def _embedded(doc: dict) -> dict:
    raw = _b64(doc)
    return {"bytes": raw, "sha256": hashlib.sha256(base64.b64decode(raw)).hexdigest()}


def _recovery_record(
    *,
    contract: dict | None = None,
    coverage: dict | None = None,
    tombstone: dict | None = None,
    method: str = "TOMBSTONE_AUTHORITATIVE",
    receipt_id: str = RECEIPT,
    source_sha: str = SOURCE_SHA,
    schema_version: int = 1,
    drop: tuple[str, ...] = (),
) -> dict:
    record = {
        "active_contract_state": "seeded-empty-invalid-residue",
        "closure_proof": "existing terminal tombstone + terminal coverage; the stale "
        "active Contract was never-developed invalid residue and is preserved "
        "verbatim below -- no clause text was fabricated",
        "method": method,
        "original_contract": _embedded(_zero_clause_contract() if contract is None else contract),
        "original_coverage": _embedded(_coverage() if coverage is None else coverage),
        "original_tombstone": _embedded(ORIGINAL_TOMBSTONE if tombstone is None else tombstone),
        "receipt_id": receipt_id,
        "recovered_at": RECOVERED_AT,
        "schema_version": schema_version,
        "source_sha256": source_sha,
        "terminal_requirements": REQUIREMENTS,
    }
    for field in drop:
        record.pop(field, None)
    return record


class RecoveredSourceFixture(unittest.TestCase):
    """Builds an exact SRC-038-shaped project: tombstone, archive, recovery."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-recovered-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        board = self.root / ".saipen/BOARD.md"
        text = board.read_text(encoding="utf-8")
        text = text.replace("## DOING\n- [/] T-001 DOING task", "## DOING")
        text = text.replace(
            "## DONE\n",
            f"## DONE\n- [x] {WORK} DONE work | verify: proof exists | "
            f"source_receipts: {RECEIPT}\n",
        )
        board.write_text(text, encoding="utf-8")
        self.build()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    # -- fixture construction -------------------------------------------

    def build(
        self,
        *,
        tombstone: dict | None = None,
        record: dict | None = None,
        contract: dict | None = None,
        coverage: dict | None = None,
        meta: dict | None = None,
        body_sha: str | None = None,
        write_record: bool = True,
        write_contract: bool = True,
        write_coverage: bool = True,
    ) -> None:
        archive = self.root / ".saipen" / "archive" / "source"
        archive.mkdir(parents=True, exist_ok=True)
        body = "audit body\n"
        # Binary write: text-mode newline translation would rebind every
        # recorded digest the surfaces carry.
        (archive / f"{RECEIPT}.md").write_bytes(body.encode("utf-8"))
        # The archived body digest is real by default; every other surface
        # binds to it, and a test that wants a mismatch declares it.
        real_sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
        bound_sha = real_sha if body_sha is None else body_sha

        def _rebind(doc: dict) -> dict:
            return json.loads(json.dumps(doc).replace(SOURCE_SHA, bound_sha))

        def _rebind_embedded(record: dict) -> dict:
            """Bind the embedded originals to the fixture's real body digest.

            Only UNTAMPERED embedded blocks are rebound: a test that wants a
            digest mismatch keeps its tampered bytes.
            """
            for field, builder in (
                ("original_tombstone", lambda: ORIGINAL_TOMBSTONE),
                ("original_contract", _zero_clause_contract),
            ):
                block = record.get(field)
                if not isinstance(block, dict) or not isinstance(block.get("bytes"), str):
                    continue
                try:
                    doc = json.loads(base64.b64decode(block["bytes"]))
                except (ValueError, TypeError):
                    continue
                if _embedded(doc) != {"bytes": block["bytes"], "sha256": block["sha256"]}:
                    continue
                if SOURCE_SHA not in json.dumps(doc):
                    continue
                rebound = _embedded(_rebind(doc))
                block["bytes"] = rebound["bytes"]
                block["sha256"] = rebound["sha256"]
            return record

        self.tombstone = _rebind(CURRENT_TOMBSTONE if tombstone is None else tombstone)
        self.contract = copy.deepcopy(_zero_clause_contract() if contract is None else contract)
        self.coverage = copy.deepcopy(_coverage() if coverage is None else coverage)
        if record is None:
            record = _recovery_record(
                contract=_rebind(_zero_clause_contract()),
                coverage=self.coverage,
                tombstone=_rebind(ORIGINAL_TOMBSTONE),
            )
            record["source_sha256"] = bound_sha
        else:
            if record.get("source_sha256") == SOURCE_SHA:
                record["source_sha256"] = bound_sha
            record = _rebind_embedded(record)
        self.record = record
        default_meta = {
            "archive_ref": f".saipen/archive/source/{RECEIPT}.md",
            "closed_at": CLOSED_AT,
            "linked_work": WORK,
            "receipt_id": RECEIPT,
            "received_at": "2026-09-05T13:54:23Z",
            "reread_at": RECOVERED_AT,
            "recovery": {
                "method": "TOMBSTONE_AUTHORITATIVE",
                "record": f".saipen/archive/source/{RECEIPT}.recovery.json",
            },
            "schema_version": 1,
            "sensitive": False,
            "source_kind": "external_audit",
            "source_sha256": bound_sha,
            "status": "CLOSED",
            "storage_status": "ARCHIVED",
        }
        self.meta = default_meta if meta is None else meta
        (archive / f"{RECEIPT}.meta.json").write_text(
            json.dumps(self.meta, indent=2), encoding="utf-8"
        )
        if write_contract:
            (archive / f"{RECEIPT}.contract.json").write_text(
                json.dumps(self.contract, indent=2), encoding="utf-8"
            )
        if write_coverage:
            (archive / f"{RECEIPT}.coverage.json").write_text(
                json.dumps(self.coverage, indent=2), encoding="utf-8"
            )
        if write_record:
            (archive / f"{RECEIPT}.recovery.json").write_text(
                json.dumps(self.record, indent=2), encoding="utf-8"
            )
        tombs = self.root / ".saipen" / "intake" / "tombstones"
        tombs.mkdir(parents=True, exist_ok=True)
        (tombs / f"{RECEIPT}.json").write_text(
            json.dumps(self.tombstone, indent=2), encoding="utf-8"
        )
        index_path = self.root / ".saipen" / "intake" / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
        index.setdefault("schema_version", 1)
        index.setdefault("active", {})
        index.setdefault("tombstones", {})
        index["tombstones"][RECEIPT] = self.tombstone
        index.setdefault("next_id", 39)
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")

    def proof(self) -> dict:
        return intake.evaluate_terminal_recovered_source_attribution(self.root, RECEIPT)

    def finding(self) -> dict:
        return findings_mod.classify(
            "problem",
            f"closed receipt {RECEIPT} archive bundle invalid: source {RECEIPT} "
            "Contract/coverage clause identities differ",
        )

    def legacy(self, findings_list=None, *, target_work=TARGET_WORK, target_source=TARGET_SOURCE):
        problems = [self.finding()] if findings_list is None else findings_list
        with patch.object(
            debt_mod,
            "capture_findings",
            return_value={
                "ok": True,
                "exit_code": 1,
                "gate": "core",
                "problems": problems,
                "warnings": [],
            },
        ):
            return debt_mod.work_delta(
                self.root,
                target_work,
                agent="probe",
                claim_boundary="E-816",
                target_source=target_source,
                verification=[{"command": "regression_t158.py", "result": "PASS"}],
            )

    def add_boundary(self) -> None:
        log_path = self.root / ".saipen" / "LOG.md"
        log_path.write_text(
            log_path.read_text(encoding="utf-8")
            + "- 05.09.26 00:19 [E-815] [parent: E-814] [T-050] [agent: probe] [op: op-a] "
            "DEC: pre-claim\n"
            "- 05.09.26 00:20 [E-816] [parent: E-815] [T-158] [agent: probe] [op: op-b] "
            "DEC: claimed via SAIOPS -- owner probe\n",
            encoding="utf-8",
        )


class AttributionPositiveTests(RecoveredSourceFixture):
    """K1..K13: the exact SRC-038-shaped fixture attributes to T-160."""

    def setUp(self) -> None:
        super().setUp()
        self.add_boundary()

    def test_positive_fixture_attributes_to_linked_work(self) -> None:
        result = self.proof()
        self.assertTrue(result["attributable"], result)
        self.assertEqual(result["linked_work"], WORK)
        self.assertEqual(result["recovery_class"], "terminal_recovered_source_residue")
        self.assertEqual(result["recovery_method"], "TOMBSTONE_AUTHORITATIVE")
        self.assertEqual(result["requirements"], 16)
        self.assertEqual(result["terminal"], 16)
        self.assertEqual(result["source_sha256"], SOURCE_SHA)

    def test_current_tombstone_is_not_byte_identical_to_original(self) -> None:
        """C3: the additive recovery block is expected, never corruption."""
        raw_original = base64.b64decode(self.record["original_tombstone"]["bytes"])
        current = (self.root / ".saipen/intake/tombstones/SRC-038.json").read_bytes()
        self.assertNotEqual(hashlib.sha256(raw_original).hexdigest(),
                            hashlib.sha256(current).hexdigest())
        self.assertTrue(self.proof()["attributable"])

    def test_finding_is_classified_source_before_attribution(self) -> None:
        finding = self.finding()
        self.assertEqual(finding["rule_id"], "source_receipt_closed_archive_invalid")
        self.assertEqual(finding["subject_kind"], "source")
        self.assertEqual(finding["subject_id"], RECEIPT)

    def test_work_delta_carries_residue_through_t160(self) -> None:
        report = self.legacy()
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["code"], "WORK_DELTA_PASS")
        self.assertEqual(report["carried_problems"], 1)
        carried = report["carried"][0]
        self.assertEqual(carried["subject_id"], RECEIPT)
        self.assertEqual(carried["attributed_work"], WORK)
        self.assertEqual(carried["recovery_class"], "terminal_recovered_source_residue")

    def test_strict_finding_identity_is_unchanged_by_attribution(self) -> None:
        """Phase I: ownership metadata never mints a new finding key."""
        before = self.finding()["finding_key"]
        after = self.finding()["finding_key"]
        self.assertEqual(before, after)
        report = self.legacy()
        self.assertEqual(report["carried"][0]["finding_key"], before)
        self.assertEqual(report["carried"][0]["rule_id"], "source_receipt_closed_archive_invalid")
        self.assertEqual(report["carried"][0]["severity"], "problem")

    def test_release_stays_blocked_with_carried_residue(self) -> None:
        report = self.legacy()
        self.assertEqual(report["code"], "WORK_DELTA_PASS")
        self.assertFalse(report["release_ready"])
        self.assertFalse(report["strict_core"]["ok"])

    def test_evaluation_mutates_zero_project_files(self) -> None:
        before = {
            str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(self.root.rglob("*"))
            if p.is_file()
        }
        self.proof()
        self.legacy()
        after = {
            str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(self.root.rglob("*"))
            if p.is_file()
        }
        self.assertEqual(before, after)

    def test_zero_clause_contract_survives_byte_identical(self) -> None:
        path = self.root / ".saipen/archive/source/SRC-038.contract.json"
        before = path.read_bytes()
        self.proof()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(json.loads(before)["clauses"], {})

    def test_unknown_receipt_refuses_cleanly(self) -> None:
        result = intake.evaluate_terminal_recovered_source_attribution(self.root, "SRC-999")
        self.assertFalse(result["attributable"])
        self.assertEqual(result["reason"], "NO_TOMBSTONE")

    def test_invalid_receipt_id_refuses_cleanly(self) -> None:
        result = intake.evaluate_terminal_recovered_source_attribution(self.root, "nope")
        self.assertFalse(result["attributable"])
        self.assertEqual(result["reason"], "INVALID_RECEIPT_ID")


class AttributionNegativeTests(RecoveredSourceFixture):
    """K14..K38: every unproven condition stays GLOBAL/blocking."""

    def setUp(self) -> None:
        super().setUp()
        self.add_boundary()

    def _refuse(self, result: dict, reason: str) -> None:
        self.assertFalse(result["attributable"], result)
        self.assertEqual(result["reason"], reason)

    def _blocked_global(self) -> None:
        report = self.legacy()
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertEqual(report["carried_problems"], 0)
        self.assertTrue(
            any("attribution refused" in entry["reason"] for entry in report["blocking"]),
            report["blocking"],
        )

    # -- 14..17 record / method / sha / receipt -------------------------

    def test_missing_recovery_record_refuses(self) -> None:
        self.build(write_record=False)
        self._refuse(self.proof(), "RECOVERY_RECORD_MISSING")
        self._blocked_global()

    def test_unsupported_recovery_method_refuses(self) -> None:
        self.build(record=_recovery_record(method="CONTRACT_AUTHORITATIVE"))
        self._refuse(self.proof(), "RECOVERY_INTEGRITY_INVALID")
        self._blocked_global()

    def test_source_sha_mismatch_refuses(self) -> None:
        self.build(record=_recovery_record(source_sha="0" * 64))
        self._refuse(self.proof(), "RECOVERY_INTEGRITY_INVALID")
        self._blocked_global()

    def test_receipt_id_mismatch_refuses(self) -> None:
        self.build(record=_recovery_record(receipt_id="SRC-039"))
        self._refuse(self.proof(), "RECOVERY_INTEGRITY_INVALID")
        self._blocked_global()

    def test_body_digest_mismatch_refuses(self) -> None:
        self.build(body_sha="1" * 64)
        self._refuse(self.proof(), "ARCHIVE_BODY_SHA_MISMATCH")
        self._blocked_global()

    def test_archive_meta_work_mismatch_refuses(self) -> None:
        meta = json.loads(
            (self.root / ".saipen/archive/source/SRC-038.meta.json").read_text(encoding="utf-8")
        )
        meta["linked_work"] = "T-161"
        self.build(meta=meta)
        self._refuse(self.proof(), "ARCHIVE_WORK_MISMATCH")
        self._blocked_global()

    def test_tombstone_not_closed_refuses(self) -> None:
        tombstone = copy.deepcopy(CURRENT_TOMBSTONE)
        tombstone["status"] = "ACTIVE"
        self.build(tombstone=tombstone)
        self._refuse(self.proof(), "TOMBSTONE_NOT_CLOSED")
        self._blocked_global()

    # -- 18..22 embedded digest / preserved originals --------------------

    def test_original_contract_digest_mismatch_refuses(self) -> None:
        record = _recovery_record()
        record["original_contract"]["sha256"] = "2" * 64
        self.build(record=record)
        self._refuse(self.proof(), "RECOVERY_EMBEDDED_DIGEST_MISMATCH")
        self._blocked_global()

    def test_original_coverage_digest_mismatch_refuses(self) -> None:
        record = _recovery_record()
        record["original_coverage"]["sha256"] = "3" * 64
        self.build(record=record)
        self._refuse(self.proof(), "RECOVERY_EMBEDDED_DIGEST_MISMATCH")
        self._blocked_global()

    def test_original_tombstone_digest_mismatch_refuses(self) -> None:
        record = _recovery_record()
        record["original_tombstone"]["sha256"] = "4" * 64
        self.build(record=record)
        self._refuse(self.proof(), "RECOVERY_EMBEDDED_DIGEST_MISMATCH")
        self._blocked_global()

    def test_current_contract_differs_from_preserved_original(self) -> None:
        fabricated = _zero_clause_contract()
        fabricated["clauses"] = {f"{RECEIPT}:R001": {"class": "requirement", "text": "x"}}
        self.build(contract=fabricated)
        self._refuse(self.proof(), "PRESERVED_ORIGINAL_REPLACED")
        self._blocked_global()

    def test_current_coverage_differs_from_preserved_original(self) -> None:
        self.build(coverage=_coverage(count=15))
        self._refuse(self.proof(), "PRESERVED_ORIGINAL_REPLACED")
        self._blocked_global()

    def test_malformed_recovery_schema_refuses(self) -> None:
        record = _recovery_record(drop=("method",))
        self.build(record=record)
        self._refuse(self.proof(), "RECOVERY_INTEGRITY_INVALID")
        self._blocked_global()

    def test_unsupported_recovery_schema_version_refuses(self) -> None:
        self.build(record=_recovery_record(schema_version=99))
        self._refuse(self.proof(), "RECOVERY_INTEGRITY_INVALID")
        self._blocked_global()

    # -- 23..26 tombstone closure identity -------------------------------

    def test_tombstone_linked_work_change_refuses(self) -> None:
        tombstone = copy.deepcopy(CURRENT_TOMBSTONE)
        tombstone["linked_work"] = "T-161"
        self.build(tombstone=tombstone)
        self._refuse(self.proof(), "TOMBSTONE_CLOSURE_IDENTITY_CHANGED")
        self._blocked_global()

    def test_tombstone_source_sha_change_refuses(self) -> None:
        tombstone = copy.deepcopy(CURRENT_TOMBSTONE)
        tombstone["source_sha256"] = "5" * 64
        self.build(tombstone=tombstone)
        self._refuse(self.proof(), "TOMBSTONE_CLOSURE_IDENTITY_CHANGED")
        self._blocked_global()

    def test_tombstone_closure_counts_change_refuses(self) -> None:
        tombstone = copy.deepcopy(CURRENT_TOMBSTONE)
        tombstone["requirements"] = 15
        tombstone["actionable"] = 15
        self.build(tombstone=tombstone)
        self._refuse(self.proof(), "COVERAGE_COUNT_MISMATCH")
        self._blocked_global()

    def test_tombstone_closed_at_change_refuses(self) -> None:
        tombstone = copy.deepcopy(CURRENT_TOMBSTONE)
        tombstone["closed_at"] = "2026-09-07T00:00:00Z"
        self.build(tombstone=tombstone)
        self._refuse(self.proof(), "TOMBSTONE_CLOSURE_IDENTITY_CHANGED")
        self._blocked_global()

    def test_undocumented_tombstone_field_refuses(self) -> None:
        tombstone = copy.deepcopy(CURRENT_TOMBSTONE)
        tombstone["invented_field"] = "surprise"
        self.build(tombstone=tombstone)
        self._refuse(self.proof(), "TOMBSTONE_CLOSURE_IDENTITY_CHANGED")
        self._blocked_global()

    # -- 27..34 coverage truth -------------------------------------------

    def test_coverage_count_mismatch_refuses(self) -> None:
        """15 requirements against a tombstone claiming 16 never attributes."""
        self.build(record=_recovery_record(coverage=_coverage(count=15)))
        self._refuse(self.proof(), "COVERAGE_COUNT_MISMATCH")
        self._blocked_global()

    def test_one_unknown_actionable_requirement_refuses(self) -> None:
        coverage = _coverage()
        coverage["requirements"][f"{RECEIPT}:R016"]["disposition"] = "UNKNOWN"
        self.build(record=_recovery_record(coverage=coverage))
        self._refuse(self.proof(), "COVERAGE_TERMINAL_MISMATCH")
        self._blocked_global()

    def test_missing_verification_on_implemented_refuses(self) -> None:
        coverage = _coverage()
        coverage["requirements"][f"{RECEIPT}:R016"]["verification"] = ""
        self.build(record=_recovery_record(coverage=coverage))
        self._refuse(self.proof(), "COVERAGE_TERMINAL_MISMATCH")
        self._blocked_global()

    def test_split_linked_work_refuses(self) -> None:
        coverage = _coverage()
        coverage["requirements"][f"{RECEIPT}:R016"]["linked_work"] = "T-161"
        self.build(record=_recovery_record(coverage=coverage))
        self._refuse(self.proof(), "COVERAGE_SPLIT_WORK")
        self._blocked_global()

    def test_coverage_work_disagrees_with_tombstone_refuses(self) -> None:
        self.build(record=_recovery_record(coverage=_coverage(work="T-161")))
        self._refuse(self.proof(), "COVERAGE_SPLIT_WORK")
        self._blocked_global()

    def test_non_requirement_requirement_id_refuses(self) -> None:
        coverage = _coverage()
        coverage["requirements"]["BOGUS"] = coverage["requirements"].pop(f"{RECEIPT}:R016")
        self.build(record=_recovery_record(coverage=coverage))
        self._refuse(self.proof(), "COVERAGE_UNINTERPRETABLE")
        self._blocked_global()

    def test_requirement_without_linked_work_refuses(self) -> None:
        coverage = _coverage()
        coverage["requirements"][f"{RECEIPT}:R016"].pop("linked_work")
        self.build(record=_recovery_record(coverage=coverage))
        self._refuse(self.proof(), "COVERAGE_UNINTERPRETABLE")
        self._blocked_global()

    def test_linked_work_not_done_refuses(self) -> None:
        board = self.root / ".saipen" / "BOARD.md"
        text = board.read_text(encoding="utf-8")
        text = text.replace(
            f"## DONE\n- [x] {WORK} DONE work", f"## DOING\n- [/] {WORK} DONE work"
        )
        board.write_text(text, encoding="utf-8")
        self._refuse(self.proof(), "LINKED_WORK_NOT_DONE")
        self._blocked_global()

    # -- 31..32 active surface / newer generation ------------------------

    def test_source_still_active_refuses(self) -> None:
        """An active projection for a tombstoned receipt corrupts the index;
        the decoder refuses it fail-closed and attribution stays refused."""
        index_path = self.root / ".saipen" / "intake" / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        index["active"][RECEIPT] = {"source_sha256": self.tombstone["source_sha256"]}
        index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
        self._refuse(self.proof(), "INDEX_UNREADABLE")
        self._blocked_global()

    def test_active_artifact_present_refuses(self) -> None:
        active = self.root / ".saipen" / "intake" / "active"
        active.mkdir(parents=True, exist_ok=True)
        (active / f"{RECEIPT}.md").write_text("live body", encoding="utf-8")
        self._refuse(self.proof(), "ACTIVE_ARTIFACT_PRESENT")
        self._blocked_global()

    def test_newer_generation_refuses(self) -> None:
        index_path = self.root / ".saipen" / "intake" / "index.json"
        index = json.loads(index_path.read_text(encoding="utf-8"))
        index["tombstones"]["SRC-039"] = {
            "receipt_id": "SRC-039",
            "amends": RECEIPT,
            "status": "CLOSED",
            "linked_work": WORK,
        }
        index_path.write_text(json.dumps(index, indent=2), encoding="utf-8")
        self._refuse(self.proof(), "NEWER_GENERATION_EXISTS")
        self._blocked_global()

    # -- 35..36 target-owned safety --------------------------------------

    def test_target_owned_recovered_source_stays_blocking(self) -> None:
        """Recovered source linked to the TARGET Work is never carried."""
        tombstone = copy.deepcopy(CURRENT_TOMBSTONE)
        tombstone["linked_work"] = TARGET_WORK
        self.build(tombstone=tombstone)
        # the proof itself still proves provenance -- T-158 is DONE on this
        # board? no: it is not on the board at all, so the proof refuses.
        self.assertFalse(self.proof()["attributable"])

    def test_target_source_receipt_never_carried(self) -> None:
        report = self.legacy(target_source=RECEIPT)
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertTrue(
            any("target Work's source receipt" in entry["reason"] for entry in report["blocking"]),
            report["blocking"],
        )

    # -- 37..38 strict core untouched ------------------------------------

    def test_unrelated_families_are_not_attributed(self) -> None:
        """Phase F: attribution never generalizes to every source finding."""
        others = [
            "ORPHAN_RECEIPT SRC-038",
            "active receipt SRC-038 contract/coverage invalid: broken",
            "source credential gate: SOURCE_CREDENTIALS_UNSAFE credential pattern in "
            "exact archive source SRC-038",
            "active receipt SRC-038 contract/coverage clause drift: contract=0 coverage=16",
        ]
        for message in others:
            finding = findings_mod.classify("problem", message)
            self.assertNotEqual(
                finding["rule_id"], "source_receipt_closed_archive_invalid", message
            )

    def test_unclassified_global_still_blocks(self) -> None:
        report = self.legacy([findings_mod.classify("problem", "completely novel failure")])
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertTrue(
            any("unattributed" in entry["reason"] for entry in report["blocking"]),
            report["blocking"],
        )


if __name__ == "__main__":
    unittest.main()
