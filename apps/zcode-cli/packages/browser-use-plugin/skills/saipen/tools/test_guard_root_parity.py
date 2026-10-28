"""T-1338: the guard hook's SAIPEN root is a variable, its shape is contract.

`install_host_guard.install(check=True)` compared the configured hook entry
against an expected entry whose command embeds the root it was called with, and
compared the artifact by RAW bytes. Two consequences, both false staleness:

  * `autoinject.hook_status` checks against the repository clone while the
    supported scheduled injector installs from its published snapshot
    (`%LOCALAPPDATA%/saipen/scheduled-source`), so the two root spellings could
    never be equal and a correct, enforcing hook read stale on every run;
  * the clone holds LF and the git snapshot holds CRLF, so `host_guard.py` was
    3971 bytes in one and 4079 in the other with not one character of
    difference -- exactly the class T-1253 already fixed for `autoinject`, on
    a path that fix never reached.

Observed here: `.gemini` reported `hook: stale` with the artifact correct and
the configuration correct, right after a successful scheduled injection, which
held distribution at "1 of 6 stale" with nothing wrong.

What stays contract: the hook's name, matcher, trigger, timeout, the command
up to the root, and that the root it names actually holds protocol documents.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import install_host_guard as G  # noqa: E402

_TEMP: list[tempfile.TemporaryDirectory] = []

#: T-1342: generation identity is the manifest-declared shipped runtime
#: surface, so a fixture brings its own (small) manifest instead of copying
#: documents only. PATH is the variable; these bytes are the generation.
_MINI_MANIFEST = {
    "copy_trees": [
        {"src": "tools", "dst": "tools"},
        {"src": "extensions/adapters", "dst": "extensions/adapters"},
    ],
    "files": [
        {"src": "saipen/MANIFEST.json", "required": True},
        {"src": "saipen/BOOT.md", "required": True},
        {"src": "saipen/CORE.md", "required": True},
        {"src": "VERSION", "required": True},
    ],
}


def _tempdir(prefix: str) -> Path:
    tmp = tempfile.TemporaryDirectory(prefix=prefix)
    _TEMP.append(tmp)
    return Path(tmp.name)


def _fake_root(base: Path) -> Path:
    """A directory that proves a COMPLETE accepted generation to the resolver.

    T-1342: freshness binds to the runtime generation, not to existence, so a
    fixture carries the manifest-declared surface (docs, engine artifact, host
    registry) -- a bare `BOOT.md` is not a home.
    """
    (base / "saipen").mkdir(parents=True, exist_ok=True)
    (base / "saipen" / "MANIFEST.json").write_text(
        json.dumps(_MINI_MANIFEST, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    (base / "saipen" / "BOOT.md").write_text("# BOOT\n", encoding="utf-8")
    (base / "saipen" / "CORE.md").write_text("# CORE\n", encoding="utf-8")
    (base / "VERSION").write_text("7.t\n", encoding="utf-8")
    (base / "extensions" / "adapters").mkdir(parents=True, exist_ok=True)
    (base / "extensions" / "adapters" / "registry.json").write_bytes(
        (REPO / "extensions" / "adapters" / "registry.json").read_bytes()
    )
    (base / "tools").mkdir(parents=True, exist_ok=True)
    (base / "tools" / "host_guard.py").write_bytes(
        (REPO / "tools" / "host_guard.py").read_bytes()
    )
    return base


#: The distribution/source authority these tests compare against. `G.ROOT` is
#: patched to it so the real repository's (much larger) surface is not needed.
AUTHORITY = _fake_root(_tempdir("saipen-guard-authority-"))


class AuthorityPatch:
    """Patch the guard's accepted-generation authority for one test."""

    def setUp(self):
        super().setUp()
        patch = unittest.mock.patch.object(G, "ROOT", AUTHORITY)
        patch.start()
        self.addCleanup(patch.stop)


def _flatten(home: Path) -> Path:
    """Move a fake root's `saipen/` surface to the flattened install layout."""
    for member in sorted((home / "saipen").iterdir()):
        if member.is_file():
            member.replace(home / member.name)
    return home


class RootExtractionTests(AuthorityPatch, unittest.TestCase):
    def test_a_plain_root_is_recovered(self):
        self.assertEqual(
            G.saipen_root_of("python guard.py --host gemini --saipen-root /opt/saipen"),
            "/opt/saipen",
        )

    def test_a_quoted_root_is_unquoted(self):
        self.assertEqual(
            G.saipen_root_of('py g.py --host gemini --saipen-root "C:\\Program Files\\s"'),
            "C:\\Program Files\\s",
        )

    def test_a_command_without_the_flag_has_no_root(self):
        self.assertIsNone(G.saipen_root_of("python guard.py --host gemini"))
        self.assertIsNone(G.saipen_root_of(""))

    def test_a_root_resolves_only_with_the_accepted_generation(self):
        with tempfile.TemporaryDirectory(prefix="saipen-guardroot-") as tmp:
            base = Path(tmp)
            self.assertFalse(G.root_resolves(str(base)))
            self.assertFalse(G.root_resolves(""))
            self.assertFalse(G.root_resolves(None))
            self.assertTrue(G.root_resolves(str(_fake_root(base / "src"))))
            self.assertTrue(G.root_resolves(str(_flatten(_fake_root(base / "flat")))))
            # A bare BOOT.md is NOT a generation proof (T-1342).
            boot_only = base / "bootonly"
            boot_only.mkdir()
            (boot_only / "BOOT.md").write_text("# BOOT\n", encoding="utf-8")
            self.assertFalse(G.root_resolves(str(boot_only)))

    def test_a_different_generation_does_not_resolve(self):
        with tempfile.TemporaryDirectory(prefix="saipen-guardgen-") as tmp:
            base = Path(tmp)
            clone = _fake_root(base / "clone")
            self.assertTrue(G.root_resolves(str(clone)))
            (clone / "saipen" / "CORE.md").write_text("stale generation\n", encoding="utf-8")
            self.assertFalse(G.root_resolves(str(clone)))


class ContentBytesTests(unittest.TestCase):
    def test_line_endings_are_transport_not_content(self):
        self.assertEqual(G.content_bytes(b"a\r\nb\r\n"), G.content_bytes(b"a\nb\n"))
        self.assertNotEqual(G.content_bytes(b"a\nb\n"), G.content_bytes(b"a\nc\n"))

    def test_a_non_utf8_artifact_is_compared_verbatim(self):
        blob = b"\xff\xfe\r\n\x00"
        self.assertEqual(G.content_bytes(blob), blob)


class GeminiCheckTests(AuthorityPatch, unittest.TestCase):
    """The whole check, driven through a temp HOME and a temp SAIPEN root."""

    def _install_from(self, home: Path, root: Path) -> dict:
        return G.install("gemini", home, root)

    def _check_against(self, home: Path, root: Path) -> dict:
        return G.install("gemini", home, root, check=True)

    def test_a_hook_installed_from_another_real_root_reads_current(self):
        """The defect, stated positively."""
        with tempfile.TemporaryDirectory(prefix="saipen-guard-two-roots-") as tmp:
            base = Path(tmp)
            home = base / "home"
            home.mkdir()
            snapshot = _fake_root(base / "snapshot")
            clone = _fake_root(base / "clone")
            self._install_from(home, snapshot)
            status = self._check_against(home, clone)
            self.assertTrue(status["configured"], status)
            self.assertTrue(status["current"], status)

    def test_a_stale_delegated_engine_reads_stale_with_a_current_artifact(self):
        """T-1342 matrix #8: the wrapper bytes are not the enforcement.

        The hook executes `<configured-root>/tools/saipen.py guard`, so a
        current artifact delegating to a DIFFERENT generation must never read
        fresh. Only the artifact bytes match here; the engine generation does
        not, and the install check must say so.
        """
        with tempfile.TemporaryDirectory(prefix="saipen-guard-engine-") as tmp:
            base = Path(tmp)
            home = base / "home"
            home.mkdir()
            snapshot = _fake_root(base / "snapshot")
            clone = _fake_root(base / "clone")
            self._install_from(home, snapshot)
            # The artifact bytes are untouched; only the engine under the NAMED
            # root moves to a different generation.
            (snapshot / "saipen" / "CORE.md").write_text("stale engine\n", encoding="utf-8")
            status = self._check_against(home, clone)
            self.assertFalse(status["configured"], status)
            self.assertFalse(status["current"], status)

    def test_a_hook_naming_a_root_that_does_not_resolve_reads_stale(self):
        with tempfile.TemporaryDirectory(prefix="saipen-guard-dead-root-") as tmp:
            base = Path(tmp)
            home = base / "home"
            home.mkdir()
            gone = _fake_root(base / "gone")
            clone = _fake_root(base / "clone")
            self._install_from(home, gone)
            (gone / "saipen" / "BOOT.md").unlink()
            status = self._check_against(home, clone)
            self.assertFalse(status["configured"], status)
            self.assertFalse(status["current"], status)

    def test_a_changed_hook_shape_still_reads_stale(self):
        with tempfile.TemporaryDirectory(prefix="saipen-guard-shape-") as tmp:
            base = Path(tmp)
            home = base / "home"
            home.mkdir()
            clone = _fake_root(base / "clone")
            self._install_from(home, clone)
            config = home / ".gemini" / "settings.json"
            data = json.loads(config.read_text(encoding="utf-8"))
            for group in data["hooks"]["BeforeTool"]:
                for hook in group["hooks"]:
                    if hook.get("name") == G.NAME:
                        hook["timeout"] = 5
            config.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
            self.assertFalse(self._check_against(home, clone)["configured"])

    def test_a_crlf_artifact_is_the_same_artifact(self):
        with tempfile.TemporaryDirectory(prefix="saipen-guard-crlf-") as tmp:
            base = Path(tmp)
            home = base / "home"
            home.mkdir()
            clone = _fake_root(base / "clone")
            self._install_from(home, clone)
            artifact = home / ".gemini" / "hooks" / "saipen-guard.py"
            artifact.write_bytes(artifact.read_bytes().replace(b"\n", b"\r\n"))
            self.assertTrue(self._check_against(home, clone)["current"])

    def test_a_genuinely_different_artifact_still_reads_stale(self):
        with tempfile.TemporaryDirectory(prefix="saipen-guard-drift-") as tmp:
            base = Path(tmp)
            home = base / "home"
            home.mkdir()
            clone = _fake_root(base / "clone")
            self._install_from(home, clone)
            artifact = home / ".gemini" / "hooks" / "saipen-guard.py"
            artifact.write_bytes(b"# not the guard\n")
            self.assertFalse(self._check_against(home, clone)["current"])

    def test_an_unrelated_user_hook_group_is_preserved(self):
        with tempfile.TemporaryDirectory(prefix="saipen-guard-preserve-") as tmp:
            base = Path(tmp)
            home = base / "home"
            (home / ".gemini").mkdir(parents=True)
            config = home / ".gemini" / "settings.json"
            config.write_text(
                json.dumps(
                    {
                        "hooks": {
                            "BeforeTool": [
                                {"matcher": "grep_search", "hooks": [{"command": "echo hi"}]}
                            ]
                        }
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            clone = _fake_root(base / "clone")
            self._install_from(home, clone)
            data = json.loads(config.read_text(encoding="utf-8"))
            commands = [
                hook.get("command")
                for group in data["hooks"]["BeforeTool"]
                for hook in group["hooks"]
            ]
            self.assertIn("echo hi", commands)
            self.assertTrue(self._check_against(home, clone)["configured"])


class KiroCheckTests(AuthorityPatch, unittest.TestCase):
    def test_the_reserved_file_branch_follows_the_same_rule(self):
        with tempfile.TemporaryDirectory(prefix="saipen-guard-kiro-") as tmp:
            base = Path(tmp)
            home = base / "home"
            home.mkdir()
            snapshot = _fake_root(base / "snapshot")
            clone = _fake_root(base / "clone")
            G.install("kiro", home, snapshot)
            status = G.install("kiro", home, clone, check=True)
            self.assertTrue(status["configured"], status)
            self.assertTrue(status["current"], status)

    def test_a_kiro_hook_with_a_dead_root_reads_stale(self):
        with tempfile.TemporaryDirectory(prefix="saipen-guard-kiro-dead-") as tmp:
            base = Path(tmp)
            home = base / "home"
            home.mkdir()
            gone = _fake_root(base / "gone")
            clone = _fake_root(base / "clone")
            G.install("kiro", home, gone)
            (gone / "saipen" / "BOOT.md").unlink()
            self.assertFalse(G.install("kiro", home, clone, check=True)["configured"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
