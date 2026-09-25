"""Injector freshness digest (T-1252, T-1253).

The digest is the ONLY witness that says whether an installed consumer copy is
current. Two things had to be true for it to work and neither was:

* it has to be WRITTEN by the injector that actually runs (T-1252), and
* it has to MATCH across the transports that produce the two sides of the
  comparison (T-1253) -- the clone holds LF, the snapshot git hands the
  scheduled injector holds CRLF, and hashing raw bytes made a home refreshed
  seconds ago report STALE forever.

A witness that always says "stale" is the same as no witness: nobody can tell
a current copy from one several releases behind, which is exactly the drift
the stamp was introduced to catch.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import autoinject  # noqa: E402


class ContentBytes(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-inject-digest-")
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write(self, name: str, payload: bytes) -> Path:
        path = self.dir / name
        path.write_bytes(payload)
        return path

    def test_crlf_and_lf_are_the_same_content(self) -> None:
        lf = self._write("lf.md", b"# BOOT\n\nrule one\nrule two\n")
        crlf = self._write("crlf.md", b"# BOOT\r\n\r\nrule one\r\nrule two\r\n")
        self.assertNotEqual(lf.read_bytes(), crlf.read_bytes())
        self.assertEqual(autoinject._content_bytes(lf), autoinject._content_bytes(crlf))

    def test_a_lone_cr_normalises_too(self) -> None:
        cr = self._write("cr.md", b"# BOOT\rrule\r")
        lf = self._write("lf2.md", b"# BOOT\nrule\n")
        self.assertEqual(autoinject._content_bytes(cr), autoinject._content_bytes(lf))

    def test_a_real_content_change_still_differs(self) -> None:
        one = self._write("a.md", b"rule one\r\n")
        two = self._write("b.md", b"rule two\n")
        self.assertNotEqual(autoinject._content_bytes(one), autoinject._content_bytes(two))

    def test_binary_content_is_hashed_byte_for_byte(self) -> None:
        # Not text, so there are no line endings to normalise and guessing
        # would corrupt the comparison.
        payload = b"\x89PNG\r\n\x1a\n\xff\xfe"
        blob = self._write("image.bin", payload)
        self.assertEqual(autoinject._content_bytes(blob), payload)


class StampRecord(unittest.TestCase):
    """The stamp has to say something a CONSUMER can read alone (T-1249)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-stamp-")
        self.target = Path(self.tmp.name) / "skills" / "saipen"
        self.target.mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write(self, text: str) -> None:
        (self.target / autoinject.STAMP).write_text(text, encoding="utf-8")

    def test_a_rich_stamp_is_parsed(self) -> None:
        self._write(
            '{"digest": "abc123", "installed_at": "2026-09-01T02:00:00Z",'
            ' "source_head": "deadbeef"}'
        )
        record = autoinject.read_stamp(self.target)
        self.assertEqual(record["digest"], "abc123")
        self.assertEqual(record["source_head"], "deadbeef")
        self.assertEqual(record["installed_at"], "2026-09-01T02:00:00Z")

    def test_a_legacy_bare_digest_still_reads(self) -> None:
        # Copies written by an older injector are on disk right now. Refusing
        # them would turn every pre-existing install into "no record at all",
        # which is the blindness the stamp exists to remove.
        self._write("abc123\n")
        self.assertEqual(autoinject.read_stamp(self.target), {"digest": "abc123"})
        self.assertEqual(autoinject._installed(self.target), "abc123")

    def test_an_absent_or_empty_or_corrupt_stamp_is_no_record(self) -> None:
        self.assertIsNone(autoinject.read_stamp(self.target))
        self._write("   \n")
        self.assertIsNone(autoinject.read_stamp(self.target))
        self._write("{not json")
        self.assertIsNone(autoinject.read_stamp(self.target))
        self._write('{"installed_at": "2026-09-01T02:00:00Z"}')
        self.assertIsNone(autoinject.read_stamp(self.target))

    def test_the_install_time_is_readable_without_the_clone(self) -> None:
        # The digest needs the source to mean anything; the timestamp and head
        # do not. A consumer machine that has no clone can still tell that its
        # copy was last refreshed days ago.
        self._write(
            '{"digest": "abc123", "installed_at": "2026-08-01T00:00:00Z",'
            ' "source_head": "deadbeef"}'
        )
        record = autoinject.read_stamp(self.target)
        self.assertIsNotNone(record["installed_at"])
        self.assertIsNotNone(record["source_head"])


class StampSourceHead(unittest.TestCase):
    """The revision must reach the stamp on the path that has no git (T-1255)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-stamp-head-")
        self.target = Path(self.tmp.name) / "skills" / "saipen"
        self.target.mkdir(parents=True)
        self._targets = autoinject.TARGETS
        autoinject.TARGETS = [self.target]

    def tearDown(self) -> None:
        autoinject.TARGETS = self._targets
        self.tmp.cleanup()

    def test_a_passed_head_is_recorded(self) -> None:
        # The scheduled injector runs from a `git archive` extraction, which is
        # not a repository. The runner proved the head before publishing that
        # snapshot, so it hands it over rather than letting the stamper ask a
        # tree that cannot answer.
        autoinject.stamp_targets("digest123", "abc123def456")
        record = autoinject.read_stamp(self.target)
        self.assertEqual(record["source_head"], "abc123def456")
        self.assertEqual(record["digest"], "digest123")

    def test_an_unavailable_head_is_omitted_not_guessed(self) -> None:
        import unittest.mock as mock

        with mock.patch.object(autoinject, "_source_head", return_value=None):
            autoinject.stamp_targets("digest123", None)
        record = autoinject.read_stamp(self.target)
        self.assertNotIn("source_head", record)
        self.assertEqual(record["digest"], "digest123")
        self.assertIn("installed_at", record)


class PruneRule(unittest.TestCase):
    """The copier and the digest must prune the same things (T-1254)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-inject-prune-")
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_the_prune_rule_has_one_owner(self) -> None:
        from saipen_engine import manifest

        self.assertIs(autoinject.CACHE_DIRS, manifest.CACHE_DIRS)
        self.assertIs(autoinject.GENERATED_SUFFIXES, manifest.GENERATED_SUFFIXES)

    def test_a_test_cache_is_pruned_like_a_bytecode_cache(self) -> None:
        # A clone that has run pytest carries tools/.pytest_cache; the snapshot
        # git hands the injector never does. Hashing it made the two sides
        # disagree permanently even with line endings already normalised.
        self.assertIn(".pytest_cache", autoinject.CACHE_DIRS)
        self.assertIn("__pycache__", autoinject.CACHE_DIRS)


class SurfaceDigest(unittest.TestCase):
    """The whole-surface digest, across the transport that broke it."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-inject-surface-")
        self.lf_home = Path(self.tmp.name) / "clone"
        self.crlf_home = Path(self.tmp.name) / "snapshot"
        skip = shutil.ignore_patterns("__pycache__")
        for home in (self.lf_home, self.crlf_home):
            shutil.copytree(ROOT / "saipen", home / "saipen")
            shutil.copytree(ROOT / "tools", home / "tools", ignore=skip)
            for name in ("bootstrap", "extensions", "tests"):
                source = ROOT / name
                if source.is_dir():
                    shutil.copytree(source, home / name, ignore=skip)
            (home / "VERSION").write_bytes((ROOT / "VERSION").read_bytes())
        # The snapshot side is what git hands the scheduled injector on this
        # platform: identical text, CRLF endings.
        for path in self.crlf_home.rglob("*"):
            if not path.is_file():
                continue
            raw = path.read_bytes()
            try:
                raw.decode("utf-8")
            except UnicodeDecodeError:
                continue
            path.write_bytes(raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n"))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _digest_at(self, home: Path) -> str:
        original = autoinject.HOME
        autoinject.HOME = home
        try:
            return autoinject._digest()
        finally:
            autoinject.HOME = original

    def test_the_two_transports_agree(self) -> None:
        self.assertNotEqual(
            (self.lf_home / "saipen" / "BOOT.md").read_bytes(),
            (self.crlf_home / "saipen" / "BOOT.md").read_bytes(),
        )
        self.assertEqual(self._digest_at(self.lf_home), self._digest_at(self.crlf_home))

    def test_a_real_edit_to_the_surface_still_moves_the_digest(self) -> None:
        before = self._digest_at(self.crlf_home)
        boot = self.crlf_home / "saipen" / "BOOT.md"
        boot.write_bytes(boot.read_bytes() + b"one more rule\r\n")
        self.assertNotEqual(before, self._digest_at(self.crlf_home))


if __name__ == "__main__":
    unittest.main()
