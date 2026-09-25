"""Cover the drift report that says WHAT an installed protocol copy is reading.

The incident behind this (T-1249): an agent on another harness read its
installed `CORE.md`, grepped for a rule that W4 had moved elsewhere, found
nothing, and answered from the older generation. The staleness machinery caught
up afterwards and could only say the home was stale -- a 16-hex digest against
another 16-hex digest, naming no file. "Stale" with no file name does not tell
a stranded agent what it is holding.

Two properties are asserted. The report must name a real divergence with byte
counts, and it must NOT invent one: a line-ending difference is transport, not
content, and reporting it would make the whole surface look divergent across
the boundary T-1253 closed. Plus the surface itself must still contain the four
routing documents, because a file dropped from the manifest is one the injector
silently stops refreshing and no digest would ever notice.
"""

import tempfile
import unittest
from pathlib import Path

import autoinject
from saipen_engine.runtime_surface import runtime_surface_items


def _shipped() -> list[tuple[str, Path]]:
    """The declared shipped surface, from the ONE owner the drift report uses."""
    return runtime_surface_items(autoinject.HOME)


class InstalledPathTests(unittest.TestCase):
    def test_saipen_prefix_is_stripped_once(self):
        self.assertEqual(autoinject.installed_relpath("saipen/BOOT.md"), "BOOT.md")
        self.assertEqual(autoinject.installed_relpath("saipen/phases/ship.md"), "phases/ship.md")

    def test_other_trees_keep_their_names(self):
        self.assertEqual(autoinject.installed_relpath("tools/validate.py"), "tools/validate.py")
        self.assertEqual(
            autoinject.installed_relpath("bootstrap/inject.ps1"), "bootstrap/inject.ps1"
        )
        self.assertEqual(autoinject.installed_relpath("VERSION"), "VERSION")


class SurfaceMembershipTests(unittest.TestCase):
    def test_the_routing_documents_are_on_the_shipped_surface(self):
        """A document off the manifest is one the injector never refreshes."""
        shipped = {declared for declared, _path in _shipped()}
        for required in (
            "saipen/BOOT.md",
            "saipen/INDEX.md",
            "saipen/STYLE.md",
            "saipen/CORE.md",
        ):
            self.assertIn(required, shipped)


class DriftReportTests(unittest.TestCase):
    def _home(self, overrides=None, seed_all=True):
        """A fake installed home; `overrides` maps installed path -> bytes."""
        tmp = tempfile.mkdtemp()
        target = Path(tmp)
        if seed_all:
            for declared, member in _shipped():
                landed = target / autoinject.installed_relpath(declared)
                landed.parent.mkdir(parents=True, exist_ok=True)
                landed.write_bytes(member.read_bytes())
        for relative, payload in (overrides or {}).items():
            landed = target / relative
            landed.parent.mkdir(parents=True, exist_ok=True)
            if payload is None:
                if landed.exists():
                    landed.unlink()
            else:
                landed.write_bytes(payload)
        return target

    def test_a_faithful_copy_reports_no_drift(self):
        self.assertEqual(autoinject.surface_drift(self._home()), [])

    def test_line_endings_alone_are_not_drift(self):
        """The T-1253 boundary: the snapshot ships CRLF, the clone holds LF."""
        source = (autoinject.HOME / "saipen" / "BOOT.md").read_bytes()
        crlf = source.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        target = self._home({"BOOT.md": crlf})
        self.assertNotEqual(crlf, source)
        self.assertEqual(autoinject.surface_drift(target), [])

    def test_an_older_generation_is_named_with_both_byte_counts(self):
        target = self._home({"CORE.md": b"# an older generation of the constitution\n"})
        drift = autoinject.surface_drift(target)
        named = {row[0]: row for row in drift}
        self.assertIn("saipen/CORE.md", named)
        _, source_size, installed_size = named["saipen/CORE.md"]
        self.assertTrue(source_size.endswith("B"))
        self.assertEqual(installed_size, "42B")

    def test_an_extra_installed_module_is_named(self):
        """T-1342: a file the home carries but the source does not ship is drift."""
        target = self._home({"tools/saipen_engine/leftover.py": b"# not shipped\n"})
        named = {row[0]: row for row in autoinject.surface_drift(target)}
        self.assertEqual(named["tools/saipen_engine/leftover.py"][1:], ("absent", "14B"))

    def test_a_missing_file_is_named_as_missing(self):
        target = self._home({"INDEX.md": None})
        named = {row[0]: row[2] for row in autoinject.surface_drift(target)}
        self.assertEqual(named.get("saipen/INDEX.md"), "missing")

    def test_a_never_installed_home_is_bounded_by_the_limit(self):
        target = self._home(seed_all=False)
        drift = autoinject.surface_drift(target, limit=autoinject.DRIFT_REPORT_LIMIT + 1)
        self.assertEqual(len(drift), autoinject.DRIFT_REPORT_LIMIT + 1)
        self.assertTrue(all(row[2] == "missing" for row in drift))

    def test_every_routing_document_is_caught_when_all_four_go_stale(self):
        target = self._home(
            {
                "BOOT.md": b"old router\n",
                "INDEX.md": b"old index\n",
                "STYLE.md": b"old style\n",
                "CORE.md": b"old core\n",
            }
        )
        named = {row[0] for row in autoinject.surface_drift(target)}
        for required in (
            "saipen/BOOT.md",
            "saipen/INDEX.md",
            "saipen/STYLE.md",
            "saipen/CORE.md",
        ):
            self.assertIn(required, named)


if __name__ == "__main__":
    unittest.main()
