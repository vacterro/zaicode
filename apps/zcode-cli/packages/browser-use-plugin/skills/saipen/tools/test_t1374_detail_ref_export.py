"""T-1374: an exported snapshot resolves every detail_ref it carries.

An event over the live LOG cap keeps its full text under
`.saipen/recovery/log-detail/` and LOG cites it as `detail_ref: ...`. The audit
contract declared `recovery/` non-exportable and named only `evidence` as a
citation surface, so archives of SAIPEN (63 such events) and ProTrail (4)
carried dangling pointers while reporting COMPLETE. The log-detail store is now
a declared durable directory, and both detail stores are citation surfaces: a
contract-faithful consumer either packs the cited detail or reports the
snapshot incomplete naming it.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import audit_manifest  # noqa: E402
from saipen_engine.operations import checkpoint  # noqa: E402
from test_audit_manifest import _pack_declared_evidence  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import healthy  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


def unresolved_citations(project: Path, archive: Path) -> list[str]:
    """A consumer that knows only the published manifest: every citation a
    carrier makes into a declared surface must be inside the archive."""
    manifest = json.loads(audit_manifest.manifest_path(project).read_text(encoding="utf-8"))
    memory = manifest["memory_root"]
    with zipfile.ZipFile(archive) as zf:
        members = set(zf.namelist())
    surfaces = "|".join(re.escape(surface) for surface in manifest["references"]["surfaces"])
    pattern = re.compile(rf"{re.escape(memory)}/(?:{surfaces})/[A-Za-z0-9_.\-/]+")
    missing: list[str] = []
    for carrier in manifest["references"]["carriers"]:
        if carrier["kind"] != "file":
            continue
        path = project / memory / carrier["path"]
        if not path.is_file():
            continue
        for cited in pattern.findall(path.read_text(encoding="utf-8")):
            if cited.rstrip(".") not in members:
                missing.append(cited)
    return sorted(set(missing))


class DetailRefExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(healthy(self))
        text = "oversized proof " + "x" * 1500
        written = checkpoint(self.project, "tester", "DEC", None, text)
        self.assertTrue(written.ok, written.to_dict())
        log = (self.project / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        found = re.search(r"detail_ref: (\.saipen/recovery/log-detail/\S+\.json)", log)
        self.assertIsNotNone(found, "the oversized event was not externalized")
        self.detail = found.group(1)
        self.assertTrue((self.project / self.detail).is_file())
        audit_manifest.write(self.project, force=True)
        self.archive_dir = Path(tempfile.mkdtemp(prefix="saipen-t1374-"))
        self.addCleanup(shutil.rmtree, self.archive_dir, True)

    def test_the_cited_detail_is_declared_durable_and_a_citation_surface(self):
        manifest = audit_manifest.build(self.project)
        conditional = {rule["path"] for rule in manifest["evidence"]["conditional"]}
        self.assertIn("recovery/log-detail", conditional)
        self.assertIn("recovery/log-detail", manifest["references"]["surfaces"])
        self.assertIn("recovery/board-compaction", manifest["references"]["surfaces"])
        rel = self.detail.split("/", 1)[1]
        self.assertTrue(audit_manifest.is_exportable(rel))
        self.assertFalse(audit_manifest.is_exportable("recovery/settled/op-1.json"))

    def test_the_archive_carries_the_detail_its_log_cites(self):
        archive = self.archive_dir / "snapshot.zip"
        _pack_declared_evidence(self.project, archive)
        with zipfile.ZipFile(archive) as zf:
            members = set(zf.namelist())
        self.assertIn(self.detail, members)
        self.assertIn(self.detail[: -len(".json")] + ".LOG.md", members)
        self.assertEqual(unresolved_citations(self.project, archive), [])

    def test_a_missing_detail_is_reported_by_name_not_as_complete(self):
        (self.project / self.detail).unlink()
        archive = self.archive_dir / "snapshot.zip"
        _pack_declared_evidence(self.project, archive)
        self.assertEqual(unresolved_citations(self.project, archive), [self.detail])


if __name__ == "__main__":
    unittest.main()
