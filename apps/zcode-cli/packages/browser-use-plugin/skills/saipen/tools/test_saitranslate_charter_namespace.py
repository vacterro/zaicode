"""Regression tests for the saitranslate charter/engine namespace contract.

T-1396 adopted the saitranslate charter revision that declares the runtime
namespace the engine already special-cases. These tests pin the invariant in
both directions so neither side can silently drift back:

  - the shipped source charter's declared write_scope IS the namespace the
    engine's resolvers return for the role (producer_namespace,
    crew._role_paths_for, the CrewRole registry OUTBOX);
  - the generic `.saipen/extensions/subs/saitranslate/` namespace that the
    pre-adoption charter declared is NOT any engine-visible runtime surface,
    so a mis-spawned copy there can never become a second live identity;
  - the charter's declared role_revision is the canonical digest of its own
    bytes, and the project-local projection agrees with the source charter
    so `saipen sub sync` has no drift to hide.

Run standalone:
    python tools/test_saitranslate_charter_namespace.py

Exit code 0 when every test passes; 1 on failure.
"""

from __future__ import annotations

import re
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(TOOLS))

from saipen_engine import crew as C  # noqa: E402
from saipen_engine import producer as P  # noqa: E402
from saipen_engine.subs import ROLE_REGISTRY, SUBS_REL  # noqa: E402
from freshness import compute_role_revision  # noqa: E402

REPO_ROOT = TOOLS.parent
SOURCE_CHARTER = REPO_ROOT / "extensions" / "subs" / "saitranslate.md"
PROJECTED_CHARTER = REPO_ROOT / SUBS_REL / "saitranslate.md"

SPECIAL_RUNTIME = ".saipen/saitranslate"
GENERIC_RUNTIME = f"{SUBS_REL}/saitranslate"


def _charter_text() -> str:
    raw = SOURCE_CHARTER.read_bytes()
    return raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n").decode("utf-8")


def _charter_field(name: str) -> str:
    """One scalar field from the charter's ```yaml block, engine idiom."""
    text = _charter_text()
    block = re.search(r"(?ms)^```yaml\n(.*?)^```\s*$", text)
    if block is None:
        raise AssertionError("saitranslate charter has no ```yaml block")
    values = re.findall(rf"(?m)^{name}:\s*(.+?)\s*$", block.group(1))
    if len(values) != 1:
        raise AssertionError(f"charter must declare exactly one {name}; found {len(values)}")
    return values[0].strip().strip('"')


class SaitranslateCharterNamespaceTests(unittest.TestCase):
    def test_adopted_write_scope_is_the_engine_namespace(self) -> None:
        """GREEN: charter write_scope == every engine resolver for the role."""
        declared = _charter_field("write_scope").rstrip("/")
        self.assertEqual(declared, SPECIAL_RUNTIME)

        with tempfile.TemporaryDirectory(prefix="sait-charter-ns-") as tmp:
            root = Path(tmp)
            namespace = P.producer_namespace(root, "saitranslate")
            self.assertEqual(namespace, root / ".saipen" / "saitranslate")
            self.assertEqual(
                namespace.relative_to(root).as_posix(), declared
            )  # producer Namespace == charter write_scope

            paths = C._role_paths_for(root, "saitranslate")
            self.assertEqual(
                paths,
                (
                    f"{SPECIAL_RUNTIME}/STATE.md",
                    f"{SPECIAL_RUNTIME}/BOARD.md",
                    f"{SPECIAL_RUNTIME}/LOG.md",
                    f"{SPECIAL_RUNTIME}/kitchen/OUTBOX.md",
                    f"{SUBS_REL}/saitranslate.md",
                ),
            )

    def test_generic_namespace_is_not_an_engine_runtime_surface(self) -> None:
        """RED stays red: the pre-adoption generic namespace contradicts every
        engine resolver, so a copy living there is invisible to crew/collect
        and can never become a second live saitranslate identity."""
        with tempfile.TemporaryDirectory(prefix="sait-charter-red-") as tmp:
            root = Path(tmp)
            self.assertNotEqual(
                P.producer_namespace(root, "saitranslate"), root / GENERIC_RUNTIME
            )
            paths = C._role_paths_for(root, "saitranslate")
            for path in paths:
                self.assertFalse(path.startswith(f"{GENERIC_RUNTIME}/"))
            # The charter file itself stays under extensions/subs/ by design:
            # charter location != runtime namespace.
            self.assertIn(f"{SUBS_REL}/saitranslate.md", paths)

        role = ROLE_REGISTRY["saitranslate"]
        self.assertEqual(role.outbox_path, f"{SPECIAL_RUNTIME}/kitchen/OUTBOX.md")
        self.assertNotEqual(role.outbox_path, f"{GENERIC_RUNTIME}/kitchen/OUTBOX.md")

    def test_declared_role_revision_is_the_canonical_digest(self) -> None:
        declared = _charter_field("role_revision")
        computed = compute_role_revision(SOURCE_CHARTER)
        self.assertEqual(declared, computed)

    def test_projected_charter_agrees_with_source(self) -> None:
        """The project-local projection is the sub-sync image of the source:
        equal normalized bytes and an equal declared revision, so sync has no
        charter drift to hide."""
        if not PROJECTED_CHARTER.is_file():
            self.skipTest("project-local charter projection not present")
        source_raw = SOURCE_CHARTER.read_bytes()
        projected_raw = PROJECTED_CHARTER.read_bytes()
        self.assertEqual(
            projected_raw.replace(b"\r\n", b"\n"), source_raw.replace(b"\r\n", b"\n")
        )
        self.assertEqual(
            compute_role_revision(PROJECTED_CHARTER), compute_role_revision(SOURCE_CHARTER)
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
