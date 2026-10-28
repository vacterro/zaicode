"""R011 structural tests: bounded authenticated conformance lineage.

Counters are structural (receipt files opened, content hashes, generation
reads), never wall-clock. The contract: latest lookup and normal append no
longer scale with the lifetime receipt population, while the explicit deep
validation still walks everything and exact receipt bytes stay the authority.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import conformance  # noqa: E402
from saipen_engine import conformance_lineage as CL  # noqa: E402
from saipen_engine import conformance_lineage  # noqa: E402

RECEIPTS = ".saipen/recovery/conformance"


def _receipt(rid: str, gate: str, ts: str, verdict: str = "PASS") -> dict:
    return {
        "schema_version": 2,
        "kind": "conformance_receipt",
        "validator_protocol_version": "test",
        "gate": gate,
        "exit_code": 0,
        "verdict": verdict,
        "timestamp_utc": ts,
        "receipt_id": rid,
        "content_hash": "x",
    }


def _write_receipt(root: Path, rid: str, gate: str, ts: str) -> Path:
    receipt_dir = root / RECEIPTS
    receipt_dir.mkdir(parents=True, exist_ok=True)
    path = receipt_dir / f"{rid}.json"
    path.write_text(json.dumps(_receipt(rid, gate, ts)), encoding="utf-8")
    return path


def _append_with_prior(
    root: Path, path: Path, rid: str, gate: str, ts: str, prior: int | None
) -> None:
    conformance._update_receipt_index(
        root,
        gate,
        rid,
        ts,
        receipt_path=path.relative_to(root).as_posix(),
        prior_receipt_dir_mtime_ns=prior,
    )


def _append(root: Path, path: Path, rid: str, gate: str, ts: str) -> None:
    """A DIRECT caller: the receipt file already exists when the pre-append
    token is captured, so the token cannot match the head. Used deliberately
    where the refusal contract (out-of-band sibling, no adoption) is the
    subject."""
    conformance._update_receipt_index(
        root,
        gate,
        rid,
        ts,
        receipt_path=path.relative_to(root).as_posix(),
        prior_receipt_dir_mtime_ns=(root / RECEIPTS).stat().st_mtime_ns,
    )


def _write_and_append(root: Path, rid: str, gate: str, ts: str) -> Path:
    """Mirror the canonical receipt-generation contract: the pre-append
    directory token is captured BEFORE the receipt file exists and handed to
    the lineage advance."""
    out_dir = root / RECEIPTS
    try:
        prior = out_dir.stat().st_mtime_ns
    except OSError:
        prior = -1
    path = _write_receipt(root, rid, gate, ts)
    _append_with_prior(root, path, rid, gate, ts, prior)
    return path


def _population_member(index: int) -> tuple[str, str, str]:
    """Receipt id, gate and timestamp of member ``index`` of a test population."""
    return (
        f"r{index:06d}",
        "core" if index % 3 else "crew",
        f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}Z",
    )


def _append_population(root: Path, population: int) -> None:
    """The population through the canonical append, one receipt at a time."""
    for index in range(population):
        _write_and_append(root, *_population_member(index))


def _rebuild_population(root: Path, population: int) -> None:
    """The same population written first and projected by ONE rebuild (T-1489).

    Same lineage as `_append_population` (proven by
    test_appended_and_rebuilt_preconditions_are_one_lineage) at a fraction of
    the cost: 10000 canonical appends took ~220 s of the declared family.
    """
    for index in range(population):
        _write_receipt(root, *_population_member(index))
    result = CL.rebuild_lineage(root)
    if not result.get("ok"):
        raise AssertionError(f"rebuild_lineage failed: {result}")


#: Head fields that record WHEN the receipt directory was last written, not
#: what the lineage holds: its mtime token, and the root digest that covers it.
_HEAD_TIME_FIELDS = ("receipt_dir_mtime_ns", "root")


def _lineage_content(root: Path) -> dict:
    """Every lineage index document, with the head's time fields left out."""
    base = root / CL.INDEX_DIR_REL
    documents = {}
    for path in sorted(base.rglob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        if path.name == Path(CL.HEAD_REL).name:
            document = {k: v for k, v in document.items() if k not in _HEAD_TIME_FIELDS}
        documents[path.relative_to(base).as_posix()] = document
    return documents


class ConformanceLineageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="r011_"))
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_rebuild_latest_uses_completion_order_across_generations(self) -> None:
        # Filename order is storage order, not completion authority.
        _write_receipt(self.root, "a-latest", "core", "2026-02-01T00:00:00Z")
        for index in range(CL.GEN_BOUND + 1):
            _write_receipt(self.root, f"z{index:04d}", "core", "2026-01-01T00:00:00Z")
        self.assertTrue(CL.rebuild_lineage(self.root)["ok"])
        handled, record = CL.latest_receipt_bounded(self.root, "core")
        self.assertTrue(handled)
        self.assertIsNotNone(record)
        self.assertEqual(record["receipt_id"], "a-latest")
        valid, errors = CL.validate_lineage_deep(self.root)
        self.assertTrue(valid, errors)

    def test_first_direct_caller_without_token_never_creates_lineage(self) -> None:
        path = _write_receipt(self.root, "r1", "core", "2026-01-01T00:00:00Z")
        before = {p.relative_to(self.root): p.read_bytes()
                  for p in self.root.rglob("*") if p.is_file()}
        advanced = CL.advance_append(
            self.root, "core", "r1", "2026-01-01T00:00:00Z",
            path.relative_to(self.root).as_posix(), prior_receipt_dir_mtime_ns=None,
        )
        self.assertFalse(advanced)
        self.assertEqual(before, {p.relative_to(self.root): p.read_bytes()
                                  for p in self.root.rglob("*") if p.is_file()})

    def test_canonical_append_never_enumerates_receipt_directory(self) -> None:
        """R011-A red control: the canonical append enumerates ZERO receipt
        directory entries, whatever the population.

        The 10000 precondition is rebuilt, not appended (T-1489): the measured
        append below is the subject, and the rebuilt lineage is the appended
        one (test_appended_and_rebuilt_preconditions_are_one_lineage)."""
        for population, build in (
            (100, _append_population),
            (1000, _append_population),
            (10000, _rebuild_population),
        ):
            with self.subTest(population=population):
                root = Path(tempfile.mkdtemp(prefix=f"r011a_{population}_"))
                try:
                    build(root, population)
                    enumerated = {"n": 0}
                    receipt_hashes = {"n": 0}
                    original_iterdir = Path.iterdir
                    original_read = Path.read_bytes
                    receipts_dir = root / RECEIPTS
                    receipts_abs = str(receipts_dir.resolve())

                    def counting_iterdir(path_self, *args, **kwargs):
                        if str(path_self.resolve()) == receipts_abs:
                            enumerated["n"] += 1
                        return original_iterdir(path_self, *args, **kwargs)

                    def counting_read(path_self, *args, **kwargs):
                        resolved = str(path_self.resolve())
                        if (
                            resolved.startswith(receipts_abs)
                            and str(path_self.parent.resolve()) == receipts_abs
                        ):
                            receipt_hashes["n"] += 1
                        return original_read(path_self, *args, **kwargs)

                    with mock.patch.object(
                        Path, "iterdir", counting_iterdir
                    ), mock.patch.object(Path, "read_bytes", counting_read):
                        _write_and_append(root, "r-final", "core", "2026-01-01T12:00:00Z")
                    # Zero directory enumeration (the passed pre-append token
                    # is the authority) and BOUNDED receipt hashing: the new
                    # receipt's own bytes plus the active-generation guard,
                    # never the sealed population.
                    self.assertEqual(enumerated["n"], 0)
                    self.assertLessEqual(receipt_hashes["n"], CL.GEN_BOUND)
                finally:
                    shutil.rmtree(root, ignore_errors=True)

    def test_appended_and_rebuilt_preconditions_are_one_lineage(self) -> None:
        """T-1489: the rebuilt precondition IS the appended one, so the cheap
        builder proves what the costly one proved. Two sealed generations and
        an active tail of both gates; the comparison sees a one-receipt
        difference, and the next canonical append treats both alike."""
        population = 2 * CL.GEN_BOUND + 44
        roots = {}
        for name in ("appended", "rebuilt", "rebuilt_plus_one"):
            roots[name] = Path(tempfile.mkdtemp(prefix=f"r011_{name}_"))
            self.addCleanup(shutil.rmtree, roots[name], True)
        _append_population(roots["appended"], population)
        _rebuild_population(roots["rebuilt"], population)
        _rebuild_population(roots["rebuilt_plus_one"], population + 1)

        appended = _lineage_content(roots["appended"])
        self.assertEqual(appended[Path(CL.HEAD_REL).name]["sealed_count"], 2)
        self.assertEqual(appended[Path(CL.HEAD_REL).name]["receipt_count"], population)
        self.assertEqual(_lineage_content(roots["rebuilt"]), appended)
        # Control: the comparison is not blind -- one receipt more is a
        # different lineage.
        self.assertNotEqual(_lineage_content(roots["rebuilt_plus_one"]), appended)

        for name in ("appended", "rebuilt"):
            _write_and_append(roots[name], "r-final", "core", "2026-01-01T12:00:00Z")
        self.assertEqual(
            _lineage_content(roots["rebuilt"]), _lineage_content(roots["appended"])
        )
        for name in ("appended", "rebuilt"):
            _handled, record = CL.latest_receipt_bounded(roots[name], "core")
            self.assertEqual(record["receipt_id"], "r-final")

    def test_prior_token_mismatch_refuses_bounded_advance(self) -> None:
        """A pre-append token that disagrees with the head (crash between
        receipt write and head publish, or out-of-band sibling) refuses the
        bounded advance with zero mutation."""
        _write_and_append(self.root, "r1", "core", "2026-01-01T00:00:00Z")
        head_before = CL._read_head(self.root)
        locator_before = CL._read_locator(self.root, "core")
        _write_receipt(self.root, "r2", "core", "2026-01-01T00:00:01Z")
        # A token captured AFTER the sibling landed cannot match the head.
        prior = (self.root / RECEIPTS).stat().st_mtime_ns
        advanced = conformance_lineage.advance_append(
            self.root,
            "core",
            "r2",
            "2026-01-01T00:00:01Z",
            f"{RECEIPTS}/r2.json",
            prior_receipt_dir_mtime_ns=prior,
        )
        self.assertFalse(advanced)
        self.assertEqual(CL._read_head(self.root), head_before)
        self.assertEqual(CL._read_locator(self.root, "core"), locator_before)
        # The strict scan still reports the true latest.
        latest = conformance.latest_receipt(self.root, "core")
        self.assertEqual(latest["receipt_id"], "r2")

    def test_direct_caller_without_token_refuses_bounded_advance(self) -> None:
        """A direct caller lacking a trustworthy pre-append token never
        drives the bounded fold; the strict path stays the truth."""
        _write_and_append(self.root, "r1", "core", "2026-01-01T00:00:00Z")
        head_before = CL._read_head(self.root)
        _write_receipt(self.root, "r2", "core", "2026-01-01T00:00:01Z")
        advanced = conformance_lineage.advance_append(
            self.root,
            "core",
            "r2",
            "2026-01-01T00:00:01Z",
            f"{RECEIPTS}/r2.json",
            prior_receipt_dir_mtime_ns=None,
        )
        self.assertFalse(advanced)
        self.assertEqual(CL._read_head(self.root), head_before)

    def test_old_gate_latest_in_old_sealed_generation_is_authenticated_by_current_head(
        self,
    ) -> None:
        """R011-B red control: gen-0000 + gen-0001 + active. The latest
        crew receipt lives in gen-0000 (old gate, old sealed generation) while
        later core receipts fill gen-0001/active. The bounded crew lookup must
        authenticate gen-0000 through the CURRENT head, and a generation the
        head does NOT bind must refuse."""
        # Fill one full generation with mixed gates so crew's latest lands
        # in gen-0000, then newer core-only receipts seal gen-0001 and fill
        # the active tail.
        for index in range(CL.GEN_BOUND):
            gate = "crew" if index == 5 else "core"
            _write_and_append(
                self.root,
                f"r{index:04d}",
                gate,
                f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}Z",
            )
        for index in range(CL.GEN_BOUND + 3):
            _write_and_append(
                self.root,
                f"s{index:04d}",
                "core",
                f"2026-01-02T00:{index // 60:02d}:{index % 60:02d}Z",
            )
        head = CL._read_head(self.root)
        self.assertIsNotNone(head)
        self.assertEqual(head[0]["sealed_count"], 2)
        binding = (head[0]["sealed_gate_bindings"] or {}).get("crew")
        self.assertIsNotNone(binding, "head must bind the old sealed gate")
        self.assertEqual(binding["generation_id"], "gen-0000")
        # Bounded crew lookup authenticates through the current head.
        handled, record = CL.latest_receipt_bounded(self.root, "crew")
        self.assertTrue(handled)
        self.assertIsNotNone(record)
        self.assertEqual(record["receipt_id"], "r0005")
        # Structural assertion: the referenced generation belongs to the
        # CURRENT lineage authority (head binding + locator + generation all
        # agree). Tampering the locator's generation to an UNBOUND generation
        # must refuse -- the locator is not a free-standing assertion.
        locator_path = self.root / CL.INDEX_DIR_REL / "crew.json"
        document = json.loads(locator_path.read_text())
        unbound = head[0]["sealed_gate_bindings"]
        self.assertNotIn("core", unbound, "core latest lives in active, not sealed")
        document["generation_id"] = "gen-0001"
        document["root"] = CL._content_root(
            b"saipen-conformance-locator-v2\0", document
        )
        locator_path.write_text(json.dumps(document))
        handled, record = CL.latest_receipt_bounded(self.root, "crew")
        self.assertTrue(handled)
        self.assertIsNone(record, "unbound generation must not authenticate")

    def test_deep_validation_proves_complete_generation_authority(self) -> None:
        """The deep path proves the COMPLETE sealed-generation authority:
        a head whose per-gate binding names a generation it does not actually
        authenticate goes deep red."""
        for index in range(CL.GEN_BOUND + 2):
            gate = "crew" if index == 5 else "core"
            _write_and_append(
                self.root,
                f"r{index:04d}",
                gate,
                f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}Z",
            )
        head_path = self.root / CL.HEAD_REL
        head_path_posix = self.root / CL.HEAD_REL.replace("/", "\\")
        document = json.loads(
            head_path.read_text() if head_path.exists() else head_path_posix.read_text()
        )
        # Forge a current-head binding for a gate whose generation the head
        # does not authenticate (locally re-hashed so the head self-hash
        # still passes: the deep authority is the subject, not the root).
        document["sealed_gate_bindings"]["forged-gate"] = {
            "generation_id": "gen-0000",
            "generation_root": "0" * 64,
        }
        payload = {
            key: document.get(key)
            for key in (
                "schema_version",
                "gen_bound",
                "receipt_count",
                "sealed_count",
                "active_root",
                "latest_sealed_id",
                "latest_sealed_root",
                "prev_root",
                "receipt_dir_mtime_ns",
                "sealed_gate_bindings",
            )
        }
        document["root"] = CL._content_root(CL._HEAD_DOMAIN, payload)
        head_path_posix.write_text(json.dumps(document))
        deep_ok, deep_errors = CL.validate_lineage_deep(self.root)
        self.assertFalse(deep_ok)
        self.assertTrue(
            any("forged-gate" in message for message in deep_errors), deep_errors
        )

    def test_append_below_bound_hashes_no_sealed_receipt_bodies(self) -> None:
        """An append below the bound never re-hashes sealed receipt bodies:
        receipt opens stay bounded by the active tail plus the new receipt,
        independent of the sealed population."""
        for index in range(CL.GEN_BOUND + 2):
            _write_and_append(self.root, f"r{index:04d}", "core", "2026-01-01T00:00:00Z")
        head = CL._read_head(self.root)
        self.assertEqual(head[0]["sealed_count"], 1)
        receipt_hashes = {"n": 0}
        original_read = Path.read_bytes
        receipts_abs = str((self.root / RECEIPTS).resolve())

        def counting_read(path_self, *args, **kwargs):
            resolved = str(path_self.resolve())
            if (
                resolved.startswith(receipts_abs)
                and str(path_self.parent.resolve()) == receipts_abs
            ):
                receipt_hashes["n"] += 1
            return original_read(path_self, *args, **kwargs)

        with mock.patch.object(Path, "read_bytes", counting_read):
            _write_and_append(self.root, "r-final", "core", "2026-01-01T00:01:00Z")
        # 131 sealed receipts; the append opened the new receipt plus the
        # bounded active-generation guard -- never the sealed history.
        self.assertLess(receipt_hashes["n"], CL.GEN_BOUND)
        self.assertGreater(receipt_hashes["n"], 0)

    def test_rebuild_then_bounded_latest_per_gate(self) -> None:
        for index in range(5):
            gate = "core" if index % 2 else "crew"
            _write_and_append(self.root, f"r{index}", gate, f"2026-01-01T00:00:0{index}Z")
        handled, core = CL.latest_receipt_bounded(self.root, "core")
        self.assertTrue(handled)
        self.assertIsNotNone(core)
        self.assertEqual(core["receipt_id"], "r3")
        _handled, crew = CL.latest_receipt_bounded(self.root, "crew")
        self.assertEqual(crew["receipt_id"], "r4")
        # Whole-history iteration stays available.
        self.assertEqual(len(conformance._iter_receipts(self.root)), 5)

    def test_bounded_lookup_cost_is_constant_in_population(self) -> None:
        for population in (100, 1000, 10000):
            with self.subTest(population=population):
                root = Path(tempfile.mkdtemp(prefix=f"r011_pop{population}_"))
                try:
                    for index in range(population):
                        gate = "core" if index % 3 else "crew"
                        _write_receipt(
                            root,
                            f"r{index:06d}",
                            gate,
                            f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}Z",
                        )
                    CL.rebuild_lineage(root)
                    opens = {"receipt": 0}
                    original_read_bytes = Path.read_bytes

                    def counting_read(self, *args, **kwargs):
                        text = str(self)
                        if text.replace("\\", "/").startswith(
                            str((root / RECEIPTS).resolve()).replace("\\", "/")
                        ):
                            opens["receipt"] += 1
                        return original_read_bytes(self, *args, **kwargs)

                    with mock.patch.object(Path, "read_bytes", counting_read):
                        _handled, record = CL.latest_receipt_bounded(root, "core")
                    self.assertTrue(_handled)
                    self.assertIsNotNone(record)
                    # Head + locator + one generation + one receipt: bounded,
                    # never the population.
                    self.assertLessEqual(opens["receipt"], 8)
                finally:
                    shutil.rmtree(root, ignore_errors=True)

    def test_append_does_not_rehash_sealed_history(self) -> None:
        for index in range(CL.GEN_BOUND):
            _write_and_append(self.root, f"r{index:04d}", "core", "2026-01-01T00:00:00Z")
        head = CL._read_head(self.root)
        self.assertIsNotNone(head)
        self.assertEqual(head[0]["receipt_count"], CL.GEN_BOUND)
        # One more receipt: the active generation is full, so this append
        # seals exactly once and opens a fresh tail.
        receipt_reads = {"n": 0}
        original_read = Path.read_bytes
        receipts_dir = str((self.root / RECEIPTS).resolve())
        # Canonical append: token captured BEFORE the receipt file lands.
        prior = (self.root / RECEIPTS).stat().st_mtime_ns
        path = _write_receipt(self.root, "r-final", "core", "2026-01-01T00:01:00Z")

        def counting_read(path_self, *args, **kwargs):
            resolved = str(path_self.resolve())
            parent = str(path_self.parent.resolve())
            if resolved.startswith(receipts_dir) and parent == receipts_dir:
                receipt_reads["n"] += 1
            return original_read(path_self, *args, **kwargs)

        with mock.patch.object(Path, "read_bytes", counting_read):
            _append_with_prior(
                self.root, path, "r-final", "core", "2026-01-01T00:01:00Z", prior
            )
        # After the seal the fresh active generation is empty, so the only
        # receipt bytes read are the new receipt's own; no sealed body is
        # re-read or re-hashed.
        self.assertEqual(receipt_reads["n"], 1)
        head = CL._read_head(self.root)
        self.assertEqual(head[0]["sealed_count"], 1)
        self.assertEqual(head[0]["receipt_count"], CL.GEN_BOUND + 1)
        _handled, record = CL.latest_receipt_bounded(self.root, "core")
        self.assertEqual(record["receipt_id"], "r-final")
        # The next no-op advance must not re-seal.
        CL.advance_append(
            self.root,
            "core",
            "r-final",
            "2026-01-01T00:01:00Z",
            path.relative_to(self.root).as_posix(),
            prior_receipt_dir_mtime_ns=(self.root / RECEIPTS).stat().st_mtime_ns,
        )
        head = CL._read_head(self.root)
        self.assertEqual(head[0]["sealed_count"], 1)

    def test_out_of_band_sibling_refuses_advance_and_never_becomes_indexed(self) -> None:
        for index in range(3):
            _write_and_append(self.root, f"r{index}", "core", f"2026-01-01T00:00:0{index}Z")
        locator_before = CL._read_locator(self.root, "core")
        head_before = CL._read_head(self.root)
        # A foreign writer lands a newer receipt WITHOUT telling the lineage.
        _write_receipt(self.root, "out-of-band", "core", "2026-01-01T00:00:59Z")
        _write_and_append(self.root, "r3", "core", "2026-01-01T00:00:04Z")
        locator_after = CL._read_locator(self.root, "core")
        self.assertEqual(locator_after, locator_before)
        self.assertEqual(CL._read_head(self.root), head_before)
        latest = conformance.latest_receipt(self.root, "core")
        self.assertEqual(latest["receipt_id"], "out-of-band")

    def test_tampered_referenced_receipt_refuses_bounded_trust(self) -> None:
        path = _write_and_append(self.root, "r1", "core", "2026-01-01T00:00:00Z")
        original = path.read_bytes()
        path.write_bytes(original.replace(b"PASS", b"FAIL"))
        handled, record = CL.latest_receipt_bounded(self.root, "core")
        self.assertTrue(handled)
        self.assertIsNone(record, "tampered referenced bytes must not authenticate")

    def test_tampered_locator_refuses(self) -> None:
        _write_and_append(self.root, "r1", "core", "2026-01-01T00:00:00Z")
        locator_path = self.root / CL.INDEX_DIR_REL / "core.json"
        document = json.loads(locator_path.read_text())
        document["receipt_id"] = "forged"
        locator_path.write_text(json.dumps(document))
        handled, record = CL.latest_receipt_bounded(self.root, "core")
        self.assertTrue(handled)
        self.assertIsNone(record)

    def test_tampered_generation_manifest_refuses(self) -> None:
        _write_and_append(self.root, "r1", "core", "2026-01-01T00:00:00Z")
        gen_path = self.root / CL.INDEX_DIR_REL / f"{CL.ACTIVE_ID}.json"
        document = json.loads(gen_path.read_text())
        document["members"] = []
        gen_path.write_text(json.dumps(document))
        handled, record = CL.latest_receipt_bounded(self.root, "core")
        self.assertTrue(handled)
        self.assertIsNone(record)

    def test_unrelated_sealed_tamper_leaves_latest_clean_and_deep_red(self) -> None:
        for index in range(CL.GEN_BOUND + 2):
            _write_and_append(self.root, f"r{index:04d}", "core", "2026-01-01T00:00:00Z")
        head = CL._read_head(self.root)
        self.assertEqual(head[0]["sealed_count"], 1)
        # Tamper the OLDEST sealed receipt (in gen-0000, not referenced by
        # the locator, not in the active generation).
        victim = self.root / RECEIPTS / "r0000.json"
        victim.write_text(victim.read_text().replace("PASS", "FAIL"))
        handled, record = CL.latest_receipt_bounded(self.root, "core")
        self.assertTrue(handled)
        self.assertIsNotNone(record)
        deep_ok, deep_errors = CL.validate_lineage_deep(self.root)
        self.assertFalse(deep_ok)
        self.assertTrue(any("r0000" in message for message in deep_errors))

    def test_deleted_and_duplicated_and_reordered_history_goes_deep_red(self) -> None:
        for index in range(4):
            _write_and_append(self.root, f"r{index}", "core", f"2026-01-01T00:00:0{index}Z")
        # Deletion.
        (self.root / RECEIPTS / "r1.json").unlink()
        deep_ok, deep_errors = CL.validate_lineage_deep(self.root)
        self.assertFalse(deep_ok)
        self.assertTrue(any("r1.json" in message for message in deep_errors))
        # Rebuild heals, then duplication.
        CL.rebuild_lineage(self.root)
        source = (self.root / RECEIPTS / "r2.json").read_text()
        (self.root / RECEIPTS / "r2-copy.json").write_text(
            source.replace('"r2"', '"r2-copy"'), encoding="utf-8"
        )
        CL.rebuild_lineage(self.root)
        deep_ok, deep_errors = CL.validate_lineage_deep(self.root)
        self.assertTrue(deep_ok, deep_errors)  # a distinct receipt_id is legal
        # Generation reorder (root no longer matches) must go red.
        gen_path = self.root / CL.INDEX_DIR_REL / f"{CL.ACTIVE_ID}.json"
        document = json.loads(gen_path.read_text())
        document["members"] = list(reversed(document["members"]))
        gen_path.write_text(json.dumps(document))
        deep_ok, deep_errors = CL.validate_lineage_deep(self.root)
        self.assertFalse(deep_ok)

    def test_rebuild_is_idempotent_and_never_rewrites_receipt_bytes(self) -> None:
        digests = {}
        for index in range(6):
            path = _write_receipt(self.root, f"r{index}", "core", f"2026-01-01T00:00:0{index}Z")
            digests[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        first = CL.rebuild_lineage(self.root)
        self.assertTrue(first["ok"])
        head_root_first = first["head_root"]
        second = CL.rebuild_lineage(self.root)
        self.assertEqual(second["head_root"], head_root_first)
        for name, digest in digests.items():
            path = self.root / RECEIPTS / name
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)

    def test_absent_lineage_falls_back_to_legacy_without_mutating(self) -> None:
        _write_receipt(self.root, "r1", "core", "2026-01-01T00:00:00Z")
        _handled, _record = CL.latest_receipt_bounded(self.root, "core")
        self.assertFalse(_handled)
        legacy = conformance.latest_receipt(self.root, "core")
        self.assertIsNotNone(legacy)
        self.assertFalse((self.root / CL.INDEX_DIR_REL / "lineage-head.json").exists())

    def test_update_receipt_index_creates_and_advances_v2(self) -> None:
        _write_and_append(self.root, "r1", "core", "2026-01-01T00:00:00Z")
        self.assertTrue((self.root / CL.HEAD_REL.replace("/", "\\")).exists() or
                        (self.root / CL.HEAD_REL).exists())
        latest = conformance.latest_receipt(self.root, "core")
        self.assertEqual(latest["receipt_id"], "r1")
        _write_and_append(self.root, "r2", "core", "2026-01-01T00:00:01Z")
        latest = conformance.latest_receipt(self.root, "core")
        self.assertEqual(latest["receipt_id"], "r2")


if __name__ == "__main__":
    unittest.main()
