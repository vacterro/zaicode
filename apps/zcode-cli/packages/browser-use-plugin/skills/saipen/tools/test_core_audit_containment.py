"""CORE-001 hostile regressions: liveness cache must never escape the project.

The continuation-liveness cache is a disposable projection stored under
``.saipen/cache/``. A hostile or accidental symlink/junction/reparse topology
must never make ``record_actionable``/``clear`` create, overwrite or delete a
file outside the project root under the invoking user's permissions.

The cache is best-effort: an unsafe carrier degrades to the documented
first-observation result and ``clear`` no-ops -- it must never mutate outside
the root.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from saipen_engine import liveness as L

CACHE_REL = L.CACHE_REL


class _Fixture(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / ".saipen" / "cache").mkdir(parents=True, exist_ok=True)
        self.fp = L.action_fingerprint(stage="SC-2", role="saihunt", reason="stale")

    def tearDown(self):
        self._tmp.cleanup()

    def _cache_file(self):
        return self.root / CACHE_REL

    def _link(self, target, link_path, *, target_is_directory=False):
        try:
            link_path.symlink_to(target, target_is_directory=target_is_directory)
        except (OSError, NotImplementedError, PermissionError) as exc:
            self.skipTest(f"symlinks unavailable: {exc}")

    def _external_file(self, body: bytes = b"EXTERNAL SENTINEL"):
        ext = self.root.parent / ("ext_" + os.urandom(4).hex())
        ext.write_bytes(body)
        return ext


class NormalCacheTests(_Fixture):
    def test_normal_in_project_cache(self):
        first = L.record_actionable(self.root, self.fp)
        self.assertFalse(first["stalled"])
        second = L.record_actionable(self.root, self.fp)
        self.assertTrue(second["stalled"])
        data = json.loads(self._cache_file().read_text(encoding="utf-8"))
        self.assertEqual(data["fingerprint"], self.fp)
        L.clear(self.root)
        self.assertFalse(self._cache_file().exists())


class FinalFileSymlinkTests(_Fixture):
    def test_record_actionable_does_not_follow_final_symlink(self):
        ext = self._external_file()
        self._link(ext, self._cache_file())
        verdict = L.record_actionable(self.root, self.fp)
        self.assertFalse(verdict["stalled"])
        self.assertEqual(ext.read_bytes(), b"EXTERNAL SENTINEL")
        self.assertTrue(self._cache_file().is_symlink())

    def test_clear_does_not_delete_final_symlink_target(self):
        ext = self._external_file()
        self._link(ext, self._cache_file())
        L.clear(self.root)
        self.assertTrue(ext.exists())
        self.assertEqual(ext.read_bytes(), b"EXTERNAL SENTINEL")


class CacheDirSymlinkTests(_Fixture):
    def _redirect_cache_dir(self):
        outside = self.root.parent / ("extdir_" + os.urandom(4).hex())
        outside.mkdir(parents=True, exist_ok=True)
        (outside / "continuation-liveness.json").write_text(
            "{}", encoding="utf-8"
        )
        cache_dir = self.root / ".saipen" / "cache"
        cache_dir.rmdir()
        self._link(outside, cache_dir, target_is_directory=True)
        return outside

    def test_record_actionable_refuses_symlinked_cache_dir(self):
        outside = self._redirect_cache_dir()
        verdict = L.record_actionable(self.root, self.fp)
        self.assertFalse(verdict["stalled"])
        self.assertEqual(
            (outside / "continuation-liveness.json").read_text(encoding="utf-8"),
            "{}",
        )

    def test_clear_refuses_symlinked_cache_dir(self):
        outside = self._redirect_cache_dir()
        L.clear(self.root)
        self.assertTrue((outside / "continuation-liveness.json").exists())


if __name__ == "__main__":
    unittest.main()
