"""T-1337: the instruction block's SAIPEN_HOME is a variable, not a contract.

`instruction_status` used to compare the installed `SAIPEN:BEGIN..END` block
byte-for-byte against `rendered_activation_block(skill_install_dir)`, which
substitutes exactly one home: the installed skill directory. A block pointing
at any other valid SAIPEN home -- most usefully the source clone, where the
agent reads live protocol documents and can never fall behind -- differs in the
substitution and nowhere else, so it reported STALE on every run, forever, and
no re-injection could change that without changing the operator's deliberate
configuration.

Observed on the machine this was written on: four homes reported
`instruction: stale` while `autoinject --check` reported `fresh: 6 agent
home(s)`. Two surfaces, one machine, opposite answers. The cost is not the
wrong line -- it is that the operator learns to ignore the freshness surface,
and then ignores a real staleness with it.

The contract this suite pins has two halves, both of which matter:

  * the block's PROSE is this generation's template;
  * the home it NAMES resolves to real protocol documents.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import autoinject  # noqa: E402

_TEMP: list[tempfile.TemporaryDirectory] = []

#: T-1342: the accepted generation is the manifest-declared shipped runtime
#: surface, so a fixture carries its own small manifest. A directory holding a
#: `BOOT.md` is not a home, and neither is one at another generation.
_MINI_MANIFEST = {
    "copy_trees": [{"src": "extensions/adapters", "dst": "extensions/adapters"}],
    "files": [
        {"src": "saipen/MANIFEST.json", "required": True},
        {"src": "saipen/BOOT.md", "required": True},
        {"src": "saipen/CORE.md", "required": True},
        {"src": "saipen/ACTIVATION_BLOCK.md", "required": True},
        {"src": "VERSION", "required": True},
    ],
}


def _tempdir(prefix: str) -> Path:
    tmp = tempfile.TemporaryDirectory(prefix=prefix)
    _TEMP.append(tmp)
    return Path(tmp.name)


def _authority(base: Path) -> Path:
    """A source-layout authority that answers every autoinject lookup."""
    (base / "saipen").mkdir(parents=True, exist_ok=True)
    (base / "saipen" / "MANIFEST.json").write_text(
        json.dumps(_MINI_MANIFEST, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    (base / "saipen" / "BOOT.md").write_text("# BOOT\n", encoding="utf-8")
    (base / "saipen" / "CORE.md").write_text("# CORE\n", encoding="utf-8")
    (base / "saipen" / "ACTIVATION_BLOCK.md").write_bytes(
        (REPO / "saipen" / "ACTIVATION_BLOCK.md").read_bytes()
    )
    (base / "VERSION").write_text("7.t\n", encoding="utf-8")
    (base / "extensions" / "adapters").mkdir(parents=True, exist_ok=True)
    (base / "extensions" / "adapters" / "registry.json").write_bytes(
        (REPO / "extensions" / "adapters" / "registry.json").read_bytes()
    )
    return base


AUTHORITY = _authority(_tempdir("saipen-instr-authority-"))


class AuthorityPatch:
    def setUp(self):
        super().setUp()
        patch = unittest.mock.patch.object(autoinject, "HOME", AUTHORITY)
        patch.start()
        self.addCleanup(patch.stop)


def _template_block() -> str:
    raw = autoinject.activation_template_path().read_text(encoding="utf-8")
    return autoinject._extract_block(raw).replace("\r\n", "\n").strip()


def _home(root: Path) -> Path:
    """A flattened installed home at the SAME accepted generation.

    T-1342: freshness binds to generation, so a fixture must carry the
    manifest-declared surface (flattened layout) -- a bare `BOOT.md` is not a
    home.
    """
    root.mkdir(parents=True, exist_ok=True)
    for name in ("MANIFEST.json", "BOOT.md", "CORE.md", "ACTIVATION_BLOCK.md", "VERSION"):
        source = AUTHORITY / "saipen" / name if name != "VERSION" else AUTHORITY / name
        if source.is_file():
            shutil.copyfile(source, root / name)
    shutil.copytree(
        AUTHORITY / "extensions" / "adapters",
        root / "extensions" / "adapters",
        dirs_exist_ok=True,
    )
    return root


class ActivationHomeExtractionTests(AuthorityPatch, unittest.TestCase):
    def test_the_home_is_recovered_from_a_rendered_block(self):
        block = _template_block()
        rendered = block.replace("{{SAIPEN_HOME}}", r"X:\some\where\saipen")
        self.assertEqual(
            autoinject._activation_home(block, rendered), r"X:\some\where\saipen"
        )

    def test_changed_prose_is_not_this_template(self):
        block = _template_block()
        rendered = block.replace("{{SAIPEN_HOME}}", "/home/x")
        mangled = rendered.replace("BOOT.md", "BOOTT.md", 1)
        self.assertIsNone(autoinject._activation_home(block, mangled))

    def test_two_different_homes_in_one_block_do_not_match(self):
        block = _template_block()
        self.assertGreater(block.count("{{SAIPEN_HOME}}"), 1, "fixture assumption")
        segments = block.split("{{SAIPEN_HOME}}")
        mixed = segments[0] + "/home/a" + segments[1] + "/home/b"
        mixed += "".join(
            "/home/a" + segment for segment in segments[2:]
        ) if len(segments) > 2 else ""
        self.assertIsNone(autoinject._activation_home(block, mixed))

    def test_a_home_needs_the_accepted_generation_not_just_boot(self):
        with tempfile.TemporaryDirectory(prefix="saipen-instr-home-") as tmp:
            root = Path(tmp)
            self.assertFalse(autoinject._names_a_real_home(str(root / "nope")))
            self.assertFalse(autoinject._names_a_real_home(""))
            boot_only = root / "bootonly"
            boot_only.mkdir()
            (boot_only / "BOOT.md").write_text("# BOOT\n", encoding="utf-8")
            self.assertFalse(autoinject._names_a_real_home(str(boot_only)))
            self.assertTrue(autoinject._names_a_real_home(str(_home(root / "skill"))))

    def test_a_stale_generation_is_not_a_real_home(self):
        with tempfile.TemporaryDirectory(prefix="saipen-instr-gen-") as tmp:
            root = Path(tmp)
            stale = _home(root / "stale")
            self.assertTrue(autoinject._names_a_real_home(str(stale)))
            (stale / "CORE.md").write_text("different generation\n", encoding="utf-8")
            self.assertFalse(autoinject._names_a_real_home(str(stale)))


class InstructionStatusTests(AuthorityPatch, unittest.TestCase):
    def _surface(self, tmp: Path, block_home: str) -> tuple[dict, Path]:
        target = tmp / "INSTR.md"
        rendered = _template_block().replace("{{SAIPEN_HOME}}", block_home)
        target.write_text(
            "# operator notes\n\n" + rendered + "\n\ntrailing user text\n",
            encoding="utf-8",
        )
        return {"instruction_surfaces": [str(target)]}, target

    def test_the_injectors_own_home_is_current(self):
        with tempfile.TemporaryDirectory(prefix="saipen-instr-own-") as tmp:
            root = Path(tmp)
            skill = _home(root / "skill")
            adapter, _ = self._surface(root, str(skill))
            self.assertEqual(autoinject.instruction_status(adapter, skill), "current")

    def test_a_different_but_real_home_is_current(self):
        """The defect, stated positively."""
        with tempfile.TemporaryDirectory(prefix="saipen-instr-other-") as tmp:
            root = Path(tmp)
            skill = _home(root / "skill")
            clone = _home(root / "clone" / "saipen")
            adapter, _ = self._surface(root, str(clone))
            self.assertEqual(autoinject.instruction_status(adapter, skill), "current")

    def test_a_home_that_does_not_resolve_is_stale(self):
        """The half the byte comparison never checked."""
        with tempfile.TemporaryDirectory(prefix="saipen-instr-dead-") as tmp:
            root = Path(tmp)
            skill = _home(root / "skill")
            adapter, _ = self._surface(root, str(root / "moved-away" / "saipen"))
            self.assertEqual(autoinject.instruction_status(adapter, skill), "stale")

    def test_a_stale_generation_home_is_stale(self):
        """T-1342: a DIFFERENT generation is never CURRENT, however real."""
        with tempfile.TemporaryDirectory(prefix="saipen-instr-stale-") as tmp:
            root = Path(tmp)
            skill = _home(root / "skill")
            clone = _home(root / "clone" / "saipen")
            (clone / "CORE.md").write_text("older generation\n", encoding="utf-8")
            adapter, _ = self._surface(root, str(clone))
            self.assertEqual(autoinject.instruction_status(adapter, skill), "stale")

    def test_changed_block_prose_is_still_stale(self):
        with tempfile.TemporaryDirectory(prefix="saipen-instr-mangled-") as tmp:
            root = Path(tmp)
            skill = _home(root / "skill")
            adapter, target = self._surface(root, str(skill))
            target.write_text(
                target.read_text(encoding="utf-8").replace(
                    "SHORTCUT ACTIVATION GATE", "SHORTCUT GATE"
                ),
                encoding="utf-8",
            )
            self.assertEqual(autoinject.instruction_status(adapter, skill), "stale")

    def test_no_block_at_all_is_stale_and_no_file_is_absent(self):
        with tempfile.TemporaryDirectory(prefix="saipen-instr-none-") as tmp:
            root = Path(tmp)
            skill = _home(root / "skill")
            adapter, target = self._surface(root, str(skill))
            target.write_text("just my own notes\n", encoding="utf-8")
            self.assertEqual(autoinject.instruction_status(adapter, skill), "stale")
            target.unlink()
            self.assertEqual(autoinject.instruction_status(adapter, skill), "absent")


if __name__ == "__main__":
    unittest.main(verbosity=2)
