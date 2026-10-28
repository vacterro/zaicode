"""T-1342 hostile matrix: PATH is variable, the EXECUTED generation is not.

The document-only `generation_identity` this suite replaces hashed a bounded
protocol-DOCUMENT surface, so a root could carry byte-identical docs and a
DIFFERENT `tools/saipen.py` and still classify CURRENT. The guard hook does not
execute the documents: it executes `<root>/tools/saipen.py`, and the freshness
surfaces (skill stamp, instruction block home, guard `--saipen-root`,
distribution report, runtime prelaunch) all decide whether an agent will
execute the accepted generation.

The identity under test is ONE manifest-driven shipped-runtime surface digest:
every `copy_trees` member and every required `files` entry of
`saipen/MANIFEST.json`, with the SAME content normalisation the injector ships
(LF-normalised text, byte-exact binary), SOURCE and FLATTENED layouts resolved
to the same logical names, and caches / bytecode / `.git` excluded.

Matrix cases (handoff SAIPEN_20260915_1626, Target C):

  1 same docs, stale `tools/saipen.py`                     -> STALE
  2 same docs, stale `tools/saipen_engine/fleet.py`        -> STALE
  3 same docs, stale `tools/validate.py`                   -> STALE
  4 same shipped bytes under another root                  -> CURRENT
  5 source vs flattened layout, identical content          -> same identity
  6 CRLF vs LF text; binary byte-exact                     -> same / exact
  7 BOOT/CORE only, or a truncated surface                 -> UNKNOWN
  8 current wrapper bytes + stale delegated root           -> hook surface STALE
  9 current home stamp + stale delegated root              -> distribution not fresh
 10 dirty tree, one shipped file changed                   -> generation differs

Completion wave (T-1342 BUILD, second executor): fail-closed inventory
semantics (duplicate/colliding names, destination drift, empty trees, phase
documents, ambiguous layouts, links and junctions anywhere in the chain,
unreadable directories), self-declared stamps and copied provenance markers
never overriding content, the installed side proven over its OWN inventory
(an extra installed module is a different generation), protocol-directory
homes, and the REAL manifest's coverage of every enforcement-critical file.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import autoinject as A  # noqa: E402
import install_host_guard as G  # noqa: E402
import saipen_engine.manifest as M  # noqa: E402
import saipen_engine.runtime_bootstrap as RB  # noqa: E402
import saipen_engine.runtime_surface as RS  # noqa: E402
from saipen_engine.paths import generation_identity as paths_generation_identity  # noqa: E402

_TEMP: list[tempfile.TemporaryDirectory] = []


def _tempdir(prefix: str) -> Path:
    tmp = tempfile.TemporaryDirectory(prefix=prefix)
    _TEMP.append(tmp)
    return Path(tmp.name)


#: A deliberately small stand-in for the real runtime manifest. The identity
#: must be derived from the manifest in the root under test, so a fixture can
#: declare a small surface and still exercise every rule the real one has.
MINI_MANIFEST = {
    "copy_trees": [
        {"src": "saipen/phases", "dst": "phases"},
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

HEAD = "b" * 40


def authority(base: Path) -> Path:
    """A source-layout root with a complete miniature shipped runtime."""
    base.mkdir(parents=True, exist_ok=True)
    (base / "saipen").mkdir(parents=True, exist_ok=True)
    (base / "saipen" / "MANIFEST.json").write_text(
        json.dumps(MINI_MANIFEST, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    (base / "saipen" / "BOOT.md").write_text("# BOOT\n", encoding="utf-8", newline="\n")
    (base / "saipen" / "CORE.md").write_text("# CORE\n", encoding="utf-8", newline="\n")
    (base / "saipen" / "phases").mkdir(parents=True, exist_ok=True)
    (base / "saipen" / "phases" / "done.md").write_text("# DONE\n", encoding="utf-8", newline="\n")
    (base / "VERSION").write_text("9.9.9\n", encoding="utf-8", newline="\n")
    engine = base / "tools" / "saipen_engine"
    engine.mkdir(parents=True, exist_ok=True)
    (base / "tools" / "saipen.py").write_text("# engine v1\n", encoding="utf-8", newline="\n")
    (base / "tools" / "validate.py").write_text("# validator v1\n", encoding="utf-8", newline="\n")
    (engine / "fleet.py").write_text("# fleet v1\n", encoding="utf-8", newline="\n")
    # An architecture marker `runtime_bootstrap.prove_canonical_root` requires.
    (engine / "board.py").write_text("# board v1\n", encoding="utf-8", newline="\n")
    # Real registry + real guard artifact bytes: the hook-adapter cases need a
    # registry the guard installer can actually read.
    (base / "tools" / "host_guard.py").write_bytes((REPO / "tools" / "host_guard.py").read_bytes())
    (base / "extensions" / "adapters").mkdir(parents=True, exist_ok=True)
    (base / "extensions" / "adapters" / "registry.json").write_bytes(
        (REPO / "extensions" / "adapters" / "registry.json").read_bytes()
    )
    # Regenerable junk that must never move the identity.
    (base / "tools" / "__pycache__").mkdir(parents=True, exist_ok=True)
    (base / "tools" / "__pycache__" / "noise.pyc").write_bytes(b"pyc v1")
    (base / "tools" / ".pytest_cache").mkdir(parents=True, exist_ok=True)
    (base / "tools" / ".pytest_cache" / "state.json").write_text("{}\n", encoding="utf-8")
    # Repository metadata is not runtime content.
    (base / ".git").mkdir(parents=True, exist_ok=True)
    (base / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    return base


def clone(source: Path, target: Path) -> Path:
    shutil.copytree(source, target)
    return target


def flatten(source: Path, target: Path) -> Path:
    """The install landing: `saipen/x` becomes `<root>/x`, other trees keep theirs."""
    shutil.copytree(source, target)
    for member in sorted((target / "saipen").iterdir()):
        landed = target / member.name
        if landed.exists():
            shutil.rmtree(landed) if landed.is_dir() else landed.unlink()
        member.replace(landed)
    (target / "saipen").rmdir()
    return target


def with_launchers(home: Path) -> Path:
    """The installer-rendered launchers, naming THIS home's engine."""
    cli = (home / "tools" / "saipen.py").resolve()
    (home / "bin").mkdir(parents=True, exist_ok=True)
    (home / "bin" / "saipen").write_text(f'#!/bin/sh\nexec python "{cli}" "$@"\n', "utf-8")
    (home / "bin" / "saipen.cmd").write_text(f'@echo off\r\npython "{cli}" %*\r\n', "utf-8")
    return home


def write_manifest(root: Path, manifest: dict) -> None:
    (root / "saipen" / "MANIFEST.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


def _definition_file(func) -> Path:
    """The source file that defines `func`, independent of import spelling.

    The repository supports two engine import spellings by design (`tools/
    __init__.py` T-1341 alias), so two live module objects may wrap the SAME
    definition file. Delegation is what must be proven, not object identity in
    one particular namespace.
    """
    return Path(func.__code__.co_filename).resolve()


def _junction(link: Path, target: Path) -> None:
    """A Windows directory junction, or skip where the host cannot make one."""
    if os.name != "nt":
        raise unittest.SkipTest("directory junctions are a Windows host feature")
    try:
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    except (ImportError, AttributeError, OSError) as exc:
        raise unittest.SkipTest(f"this host cannot create a junction: {exc}") from exc


class OneOwnerTests(unittest.TestCase):
    def test_the_guard_and_injector_use_the_one_owner(self):
        owner = _definition_file(RS.require_runtime_generation_identity)
        self.assertEqual(_definition_file(A.require_runtime_generation_identity), owner)
        self.assertEqual(_definition_file(G.runtime_generation_identity), owner)
        self.assertEqual(_definition_file(RB.surface_fingerprint), owner)

    def test_paths_no_longer_owns_a_second_generation_definition(self):
        self.assertEqual(
            _definition_file(paths_generation_identity),
            _definition_file(RS.runtime_generation_identity),
        )
        # The document-only fingerprint and its private surface tuple are gone;
        # this asserts absence of the retired implementation, not a rename.
        import saipen_engine.paths as P

        self.assertFalse(hasattr(P, "LOGICAL_SURFACE"))
        self.assertFalse(hasattr(P, "_locate_logical"))

    def test_the_drift_report_and_landing_path_have_one_owner(self):
        # A second enumeration of the surface (autoinject._manifest_surface with
        # its own cache filter) and a second landing-path rule were retired.
        self.assertFalse(hasattr(A, "_manifest_surface"))
        self.assertEqual(
            _definition_file(A.installed_relpath), _definition_file(RS.installed_relpath)
        )
        self.assertFalse(hasattr(RB, "_installed_fingerprint"))

    def test_neither_injector_defines_its_own_fingerprint(self):
        """The provenance fingerprint is asked of the owner, never re-derived."""
        ps1 = (REPO / "bootstrap" / "inject.ps1").read_text(encoding="utf-8-sig")
        sh = (REPO / "bootstrap" / "inject.sh").read_text(encoding="utf-8")
        for name, text in (("inject.ps1", ps1), ("inject.sh", sh)):
            with self.subTest(injector=name):
                self.assertIn("require_runtime_generation_identity", text)
                self.assertIn("saipen_engine.runtime_bootstrap import GENERATION", text)
                self.assertNotIn("T-1327-runtime-prelaunch", text)
                self.assertNotIn("Get-RuntimeFingerprint", text)
                self.assertNotIn('rglob("*.py")', text)


class HostileMatrix(unittest.TestCase):
    def setUp(self) -> None:
        self.base = _tempdir("saipen-gen-matrix-")
        self.source = authority(self.base / "authority")

    def _identity(self, root: Path) -> str | None:
        return RS.runtime_generation_identity(root)

    # 1 -- same docs, stale engine -----------------------------------------
    def test_case1_same_docs_stale_engine_is_stale(self):
        alternate = clone(self.source, self.base / "alt1")
        (alternate / "tools" / "saipen.py").write_text("# engine v2\n", encoding="utf-8")
        self.assertNotEqual(self._identity(self.source), self._identity(alternate))
        self.assertFalse(RS.same_runtime_generation(self.source, alternate))

    # 2 -- same docs, stale engine module ----------------------------------
    def test_case2_same_docs_stale_engine_module_is_stale(self):
        alternate = clone(self.source, self.base / "alt2")
        (alternate / "tools" / "saipen_engine" / "fleet.py").write_text(
            "# fleet v2\n", encoding="utf-8"
        )
        self.assertNotEqual(self._identity(self.source), self._identity(alternate))

    # 3 -- same docs, stale validator --------------------------------------
    def test_case3_same_docs_stale_validator_is_stale(self):
        alternate = clone(self.source, self.base / "alt3")
        (alternate / "tools" / "validate.py").write_text("# validator v2\n", encoding="utf-8")
        self.assertNotEqual(self._identity(self.source), self._identity(alternate))

    # 4 -- same executables, different path --------------------------------
    def test_case4_same_bytes_another_path_is_current(self):
        alternate = clone(self.source, self.base / "alt4")
        self.assertIsNotNone(self._identity(self.source))
        self.assertEqual(self._identity(self.source), self._identity(alternate))
        self.assertTrue(RS.same_runtime_generation(self.source, alternate))

    # 5 -- source vs flattened ---------------------------------------------
    def test_case5_source_and_flattened_layout_share_one_identity(self):
        installed = flatten(self.source, self.base / "flat5")
        self.assertFalse((installed / "saipen" / "MANIFEST.json").exists())
        self.assertTrue((installed / "MANIFEST.json").is_file())
        self.assertEqual(self._identity(self.source), self._identity(installed))

    # 6 -- line endings vs binary ------------------------------------------
    def test_case6_crlf_text_is_transport_and_binary_is_exact(self):
        alternate = clone(self.source, self.base / "alt6")
        boot = alternate / "saipen" / "BOOT.md"
        boot.write_bytes(boot.read_bytes().replace(b"\n", b"\r\n"))
        self.assertNotEqual(
            boot.read_bytes(), (self.source / "saipen" / "BOOT.md").read_bytes()
        )
        self.assertEqual(self._identity(self.source), self._identity(alternate))

        binary = alternate / "tools" / "blob.bin"
        binary.write_bytes(b"\x89PNG\r\n\x1a\npayload")
        # Declare the binary as a shipped file so byte-exactness is exercised
        # through the same framing path as every other member.
        manifest = json.loads((alternate / "saipen" / "MANIFEST.json").read_text(encoding="utf-8"))
        manifest["files"].append({"src": "tools/blob.bin", "required": True})
        (alternate / "saipen" / "MANIFEST.json").write_text(
            json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n"
        )
        changed = self._identity(alternate)
        self.assertIsNotNone(changed)
        binary.write_bytes(b"\x89PNG\r\n\x1a\npayloa\x00")
        self.assertNotEqual(changed, self._identity(alternate))

    def test_case6_nul_bearing_utf8_is_binary_and_never_normalised(self):
        """Valid UTF-8 is not text when it carries NUL: git's own test."""
        crlf = b"structured\x00record\r\n"
        lf = b"structured\x00record\n"
        self.assertEqual(RS.normalize_content(crlf), crlf)
        self.assertNotEqual(RS.normalize_content(crlf), RS.normalize_content(lf))
        one = clone(self.source, self.base / "nul-one")
        two = clone(self.source, self.base / "nul-two")
        (one / "tools" / "record.dat").write_bytes(crlf)
        (two / "tools" / "record.dat").write_bytes(lf)
        self.assertNotEqual(self._identity(one), self._identity(two))

    # 7 -- looks protocol-like, lacks the runtime --------------------------
    def test_case7_boot_and_core_only_is_unknown(self):
        boot_only = self.base / "bootonly"
        boot_only.mkdir()
        (boot_only / "BOOT.md").write_text("# BOOT\n", encoding="utf-8")
        (boot_only / "CORE.md").write_text("# CORE\n", encoding="utf-8")
        self.assertIsNone(self._identity(boot_only))
        self.assertFalse(RS.same_runtime_generation(self.source, boot_only))

    def test_case7_truncated_surface_is_unknown(self):
        truncated = clone(self.source, self.base / "truncated")
        shutil.rmtree(truncated / "tools")
        self.assertIsNone(self._identity(truncated))

    # 8 -- current wrapper + stale delegated root --------------------------
    def test_case8_current_wrapper_stale_delegated_root_reads_stale(self):
        delegated = clone(self.source, self.base / "delegated8")
        (delegated / "tools" / "saipen.py").write_text("# stale engine\n", encoding="utf-8")
        home = self.base / "home8"
        home.mkdir()
        control_home = self.base / "home8-control"
        control_home.mkdir()
        with unittest.mock.patch.object(G, "ROOT", self.source):
            G.install("gemini", home, delegated)
            status = G.install("gemini", home, delegated, check=True)
            sibling = clone(self.source, self.base / "sib8")
            G.install("gemini", control_home, sibling)
            control = G.install("gemini", control_home, sibling, check=True)
        artifact = home / ".gemini" / "hooks" / "saipen-guard.py"
        self.assertEqual(
            artifact.read_bytes(), (delegated / "tools" / "host_guard.py").read_bytes()
        )
        self.assertFalse(status["configured"], status)
        self.assertFalse(status["current"], status)
        self.assertFalse(status["root_current"], status)
        self.assertEqual(status["saipen_root"], str(delegated))
        self.assertTrue(control["current"], control)
        self.assertTrue(control["root_current"], control)

    # 9 -- current home stamp + stale delegated root -----------------------
    def test_case9_current_stamp_stale_hook_root_is_not_fresh(self):
        delegated = clone(self.source, self.base / "delegated9")
        (delegated / "tools" / "saipen.py").write_text("# stale engine\n", encoding="utf-8")
        home = self.base / "home9"
        hook_file = home / ".gemini" / "hooks" / "saipen-guard.py"
        adapter = {
            "id": "gemini",
            "skill_surfaces": [],
            "instruction_surfaces": [],
            "hook_install_surface": str(hook_file),
            "hook_config_surface": str(home / ".gemini" / "settings.json"),
            "hook_artifact": "tools/host_guard.py",
            "legacy_hook_surfaces": [],
            "hook_installer": "tools/install_host_guard.py",
            "freshness_surfaces": ["hook"],
        }
        # The skill copy itself holds the accepted runtime and a current stamp:
        # only the ENGINE THE HOOK DELEGATES TO is stale.
        skill = with_launchers(flatten(self.source, self.base / "skill9"))
        (skill / A.STAMP).write_text(
            json.dumps(
                {
                    "digest": RS.runtime_generation_identity(self.source),
                    "source_head": HEAD,
                    "installed_at": "2026-09-15T00:00:00Z",
                }
            ),
            encoding="utf-8",
        )

        def _expand(surface: str) -> Path:
            return home if surface == "~" else Path(surface).expanduser()

        with unittest.mock.patch.object(G, "ROOT", self.source), \
                unittest.mock.patch.object(A, "HOME", self.source), \
                unittest.mock.patch.object(A, "TARGETS", [skill]), \
                unittest.mock.patch.object(A, "_HOME_ADAPTERS", {str(skill.resolve()): adapter}), \
                unittest.mock.patch.object(A, "_expand_home", side_effect=_expand), \
                unittest.mock.patch.object(A, "last_inject_run", return_value=None):
            G.install("gemini", home, delegated)
            report = A.distribution_report(source_head=HEAD)
            G.install("gemini", home, clone(self.source, self.base / "sib9"))
            control = A.distribution_report(source_head=HEAD)
        self.assertEqual(report["homes"][0]["surfaces"]["hook"], "stale", report)
        self.assertTrue(report["homes"][0]["generation_current"], report)
        self.assertEqual(report["homes"][0]["delegated_root"], str(delegated))
        self.assertFalse(report["homes"][0]["delegated_current"], report)
        self.assertFalse(report["fresh"])
        self.assertTrue(control["fresh"], control)

    # 10 -- dirty tree, same HEAD ------------------------------------------
    def test_case10_a_dirty_shipped_file_moves_the_generation(self):
        dirty = clone(self.source, self.base / "dirty10")
        (dirty / ".git" / "HEAD").write_text("ref: refs/heads/other\n", encoding="utf-8")
        os.utime(dirty / "saipen" / "CORE.md", (1, 1))
        self.assertEqual(self._identity(self.source), self._identity(dirty))
        (dirty / "extensions" / "adapters" / "registry.json").write_bytes(
            (self.source / "extensions" / "adapters" / "registry.json").read_bytes() + b" "
        )
        self.assertNotEqual(self._identity(self.source), self._identity(dirty))

    def test_caches_never_move_the_identity(self):
        cached = clone(self.source, self.base / "cached")
        (cached / "tools" / "__pycache__" / "noise.pyc").write_bytes(b"pyc v2")
        (cached / "tools" / ".pytest_cache" / "state.json").write_text(
            '{"other": 1}\n', encoding="utf-8"
        )
        (cached / "tools" / "stray.pyo").write_bytes(b"bytecode")
        self.assertEqual(self._identity(self.source), self._identity(cached))


class FailClosed(unittest.TestCase):
    """A stamp may accelerate diagnosis, never override content."""

    def setUp(self) -> None:
        self.base = _tempdir("saipen-gen-failclosed-")
        self.source = authority(self.base / "authority")

    def _manifest(self, root: Path) -> dict:
        return json.loads((root / "saipen" / "MANIFEST.json").read_text(encoding="utf-8"))

    def test_missing_declared_runtime_file_is_unknown(self):
        broken = clone(self.source, self.base / "missing")
        (broken / "VERSION").unlink()
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_unreadable_declared_runtime_file_is_unknown(self):
        broken = clone(self.source, self.base / "unreadable")
        target = broken / "VERSION"
        target.unlink()
        target.mkdir()
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_unsupported_symlink_in_the_surface_is_unknown(self):
        broken = clone(self.source, self.base / "symlink")
        target = broken / "VERSION"
        target.unlink()
        try:
            os.symlink(self.source / "VERSION", target)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"this host cannot create a symlink: {exc}")
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_a_junction_inside_a_declared_tree_is_unknown(self):
        broken = clone(self.source, self.base / "junction-member")
        outside = self.base / "outside-engine"
        outside.mkdir()
        (outside / "fleet.py").write_text("# fleet v1\n", encoding="utf-8")
        _junction(broken / "tools" / "linked_engine", outside)
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_a_junction_as_the_declared_tree_root_is_unknown(self):
        """A resolved path is no longer a link, so the UNRESOLVED chain is checked."""
        broken = clone(self.source, self.base / "junction-root")
        real = broken / "adapters-real"
        shutil.move(str(broken / "extensions" / "adapters"), str(real))
        _junction(broken / "extensions" / "adapters", real)
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_a_junction_above_a_declared_file_is_unknown(self):
        broken = clone(self.source, self.base / "junction-parent")
        real = broken / "saipen-real"
        shutil.move(str(broken / "saipen"), str(real))
        _junction(broken / "saipen", real)
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_an_unreadable_directory_inside_a_tree_is_unknown(self):
        """os.walk skips unlistable directories unless told otherwise."""
        real_walk = os.walk

        def walk(top, onerror=None, **kwargs):
            if onerror is not None:
                onerror(PermissionError(13, "listing denied", str(top)))
            yield from real_walk(top, onerror=onerror, **kwargs)

        with unittest.mock.patch.object(M.os, "walk", side_effect=walk):
            self.assertIsNone(RS.runtime_generation_identity(self.source))

    def test_absent_manifest_is_unknown(self):
        self.assertIsNone(RS.runtime_generation_identity(self.base / "nowhere"))

    def test_malformed_manifest_is_unknown(self):
        broken = clone(self.source, self.base / "malformed")
        (broken / "saipen" / "MANIFEST.json").write_text("{not json", encoding="utf-8")
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_a_non_object_file_entry_is_unknown(self):
        broken = clone(self.source, self.base / "entry")
        manifest = self._manifest(broken)
        manifest["files"].append("VERSION")
        write_manifest(broken, manifest)
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_traversal_manifest_source_is_unknown(self):
        broken = clone(self.source, self.base / "traversal")
        manifest = json.loads((broken / "saipen" / "MANIFEST.json").read_text(encoding="utf-8"))
        manifest["copy_trees"][0]["src"] = "../outside"
        (broken / "saipen" / "MANIFEST.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )
        self.assertIsNone(RS.runtime_generation_identity(broken))
        with self.assertRaises(RuntimeError) as caught:
            RS.require_runtime_generation_identity(broken)
        self.assertIn("unsafe runtime manifest source", str(caught.exception))

    def test_an_empty_declared_surface_is_unknown(self):
        broken = clone(self.source, self.base / "empty")
        (broken / "saipen" / "MANIFEST.json").write_text(
            json.dumps({"copy_trees": [], "files": []}), encoding="utf-8"
        )
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_an_empty_declared_tree_is_unknown(self):
        broken = clone(self.source, self.base / "empty-tree")
        shutil.rmtree(broken / "saipen" / "phases")
        (broken / "saipen" / "phases").mkdir()
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_a_tree_destination_that_disagrees_with_its_landing_is_unknown(self):
        broken = clone(self.source, self.base / "dst")
        manifest = self._manifest(broken)
        manifest["copy_trees"][1]["dst"] = "engine"
        write_manifest(broken, manifest)
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_a_missing_required_phase_document_is_unknown(self):
        broken = clone(self.source, self.base / "phase-docs")
        manifest = self._manifest(broken)
        manifest["phase_docs"] = {
            "src_dir": "saipen/phases",
            "required": True,
            "files": ["done.md", "build.md"],
        }
        write_manifest(broken, manifest)
        self.assertIsNone(RS.runtime_generation_identity(broken))
        (broken / "saipen" / "phases" / "build.md").write_text("# BUILD\n", encoding="utf-8")
        self.assertIsNotNone(RS.runtime_generation_identity(broken))

    def test_both_layout_manifests_are_ambiguous_and_unknown(self):
        broken = clone(self.source, self.base / "ambiguous")
        shutil.copyfile(broken / "saipen" / "MANIFEST.json", broken / "MANIFEST.json")
        self.assertIsNone(RS.runtime_generation_identity(broken))

    def test_a_file_declared_twice_is_counted_once(self):
        doubled = clone(self.source, self.base / "doubled")
        manifest = self._manifest(doubled)
        manifest["files"].append({"src": "tools/saipen.py", "required": True})
        write_manifest(doubled, manifest)
        names = [name for name, _path in RS.runtime_surface_items(doubled)]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(names.count("tools/saipen.py"), 1)

    def test_two_declared_names_landing_on_one_installed_path_are_unknown(self):
        colliding = clone(self.source, self.base / "colliding")
        (colliding / "saipen" / "VERSION").write_text("0.0.0\n", encoding="utf-8")
        manifest = self._manifest(colliding)
        manifest["files"].append({"src": "saipen/VERSION", "required": True})
        write_manifest(colliding, manifest)
        with self.assertRaises(RS.RuntimeSurfaceError) as caught:
            RS.runtime_surface_items(colliding)
        self.assertIn("land on one installed path", str(caught.exception))

    def test_a_case_only_collision_is_unknown(self):
        colliding = clone(self.source, self.base / "case")
        manifest = self._manifest(colliding)
        manifest["files"].append({"src": "version", "required": True})
        write_manifest(colliding, manifest)
        self.assertIsNone(RS.runtime_generation_identity(colliding))

    def test_require_raises_where_none_is_unknown(self):
        with self.assertRaises(RuntimeError):
            RS.require_runtime_generation_identity(self.base / "nowhere")


class SelfDeclaredProofTests(unittest.TestCase):
    """A stamp or marker written INTO the candidate never proves the candidate."""

    def setUp(self) -> None:
        self.base = _tempdir("saipen-gen-selfdeclared-")
        self.source = authority(self.base / "authority")

    def _check(self, targets: list[Path]) -> tuple[int, str]:
        out = io.StringIO()
        with unittest.mock.patch.object(A, "HOME", self.source), \
                unittest.mock.patch.object(A, "TARGETS", targets), \
                contextlib.redirect_stdout(out):
            rc = A.main(["--check"])
        return rc, out.getvalue()

    def _stamp(self, home: Path, digest: str | None) -> None:
        (home / A.STAMP).write_text(
            json.dumps(
                {"digest": digest, "source_head": HEAD, "installed_at": "2026-09-15T00:00:00Z"}
            ),
            encoding="utf-8",
        )

    def test_a_copied_current_stamp_over_stale_bytes_is_stale(self):
        home = flatten(self.source, self.base / "stale-home")
        self._stamp(home, RS.runtime_generation_identity(self.source))
        (home / "tools" / "saipen.py").write_text("# stale engine\n", encoding="utf-8")
        rc, output = self._check([home])
        self.assertEqual(rc, 1, output)
        self.assertIn("STALE:", output)
        self.assertIn("tools/saipen.py", output)

    def test_current_bytes_under_an_old_stamp_are_fresh_and_named_unstamped(self):
        home = flatten(self.source, self.base / "old-stamp")
        self._stamp(home, "0123456789abcdef")
        rc, output = self._check([home])
        self.assertEqual(rc, 0, output)
        self.assertIn("UNSTAMPED:", output)
        self.assertIn("fresh: 1", output)

    def test_a_copied_provenance_marker_never_makes_a_stale_install_current(self):
        installed = with_launchers(flatten(self.source, self.base / "marker-home"))
        (installed / RB.PROVENANCE_FILENAME).write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "adapter_id": "t1342",
                    "canonical_source_root": str(self.source),
                    "installer_generation": RB.GENERATION,
                    "runtime_fingerprint": RB.surface_fingerprint(self.source),
                }
            ),
            encoding="utf-8",
        )
        registry = {"adapters": [{"id": "t1342", "install": {"skill": str(installed)}}]}
        with unittest.mock.patch.object(RB, "_registry", return_value=registry):
            current = RB.prelaunch("t1342", skill_root=installed, resync=False)
            (installed / "tools" / "saipen_engine" / "fleet.py").write_text("# stale\n", "utf-8")
            stale = RB.prelaunch("t1342", skill_root=installed, resync=False)
        self.assertEqual(current["code"], RB.PRELAUNCH_CURRENT, current)
        self.assertEqual(stale["code"], RB.PRELAUNCH_STALE, stale)
        self.assertEqual(stale["marker_fingerprint"], stale["canonical_fingerprint"])
        self.assertFalse(stale["fingerprint_match"])


class PrelaunchIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = _tempdir("saipen-gen-prelaunch-")
        self.source = authority(self.base / "authority")

    def _registry(self, installed: Path) -> dict:
        return {"adapters": [{"id": "t1342", "install": {"skill": str(installed)}}]}

    def test_surface_fingerprint_is_the_one_runtime_identity(self):
        self.assertEqual(
            RB.surface_fingerprint(self.source), RS.runtime_generation_identity(self.source)
        )

    def test_the_installed_side_is_proven_over_its_own_inventory(self):
        installed = flatten(self.source, self.base / "flat")
        self.assertEqual(RB.surface_fingerprint(installed), RB.surface_fingerprint(self.source))
        self.assertEqual(RB.surface_diff(self.source, installed), [])
        target = installed / "tools" / "saipen_engine" / "fleet.py"
        target.write_text("# stale\n", encoding="utf-8")
        self.assertNotEqual(RB.surface_fingerprint(installed), RB.surface_fingerprint(self.source))
        self.assertIn("tools/saipen_engine/fleet.py", RB.surface_diff(self.source, installed))

    def test_an_extra_installed_module_is_a_different_generation(self):
        """Digesting the install over the CANONICAL inventory could not see this."""
        installed = flatten(self.source, self.base / "extra")
        (installed / "tools" / "saipen_engine" / "leftover.py").write_text("# stray\n", "utf-8")
        self.assertNotEqual(RB.surface_fingerprint(installed), RB.surface_fingerprint(self.source))
        self.assertIn("tools/saipen_engine/leftover.py", RB.surface_diff(self.source, installed))

    def test_prelaunch_calls_an_extra_installed_module_stale(self):
        installed = with_launchers(flatten(self.source, self.base / "extra-prelaunch"))
        (installed / RB.PROVENANCE_FILENAME).write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "adapter_id": "t1342",
                    "canonical_source_root": str(self.source),
                    "installer_generation": RB.GENERATION,
                    "runtime_fingerprint": RB.surface_fingerprint(self.source),
                }
            ),
            encoding="utf-8",
        )
        registry = self._registry(installed)
        with unittest.mock.patch.object(RB, "_registry", return_value=registry):
            current = RB.prelaunch("t1342", skill_root=self.source, resync=False)
            (installed / "tools" / "saipen_engine" / "leftover.py").write_text("# stray\n", "utf-8")
            report = RB.prelaunch("t1342", skill_root=self.source, resync=False)
        # Every OTHER freshness input is clean: only the identity can tell.
        self.assertEqual(current["code"], RB.PRELAUNCH_CURRENT, current)
        self.assertEqual(report["provenance_problems"], [])
        self.assertEqual(report["launcher_problems"], [])
        self.assertEqual(report["code"], RB.PRELAUNCH_STALE, report)
        self.assertFalse(report["fingerprint_match"])
        self.assertIn("tools/saipen_engine/leftover.py", report["engine_diff"])

    def test_an_unprovable_canonical_surface_never_reaches_the_installer(self):
        installed = with_launchers(flatten(self.source, self.base / "unproven"))
        write_manifest(self.source, {**MINI_MANIFEST, "copy_trees": [{"src": "tools", "dst": "x"}]})
        calls: list[tuple] = []
        with unittest.mock.patch.object(RB, "_registry", return_value=self._registry(installed)), \
                unittest.mock.patch.object(
                    RB, "_invoke_installer", side_effect=lambda *a: calls.append(a)
                ):
            report = RB.prelaunch("t1342", skill_root=self.source, resync=True)
        self.assertFalse(report["ok"])
        self.assertEqual(report["code"], RB.PRELAUNCH_UNPROVEN)
        self.assertIsNone(report["canonical_fingerprint"])
        self.assertEqual(calls, [])

    def test_a_crlf_transport_of_the_same_hook_is_not_a_stale_hook(self):
        shipped = self.source / "extensions" / "adapters" / "opencode" / "saipen-guard.js"
        shipped.parent.mkdir(parents=True, exist_ok=True)
        shipped.write_bytes(b"// guard\nexport default 1;\n")
        installed = self.base / "plugins" / "saipen-guard.js"
        installed.parent.mkdir(parents=True)
        installed.write_bytes(b"// guard\r\nexport default 1;\r\n")
        adapter = {
            "hook_artifact": "extensions/adapters/opencode/saipen-guard.js",
            "install": {"hook": str(installed)},
        }
        self.assertEqual(RB.hook_problems(adapter, self.source), [])
        installed.write_bytes(b"// guard\r\nexport default 2;\r\n")
        self.assertEqual(RB.hook_problems(adapter, self.source), ["hook-stale"])


class ProtocolHomeTests(unittest.TestCase):
    """The activation block names a PROTOCOL directory; it proves its root."""

    def setUp(self) -> None:
        self.base = _tempdir("saipen-gen-protocol-home-")
        self.source = authority(self.base / "authority")

    def test_a_source_protocol_directory_resolves_to_its_runtime_root(self):
        snapshot = clone(self.source, self.base / "scheduled-source")
        protocol_dir = snapshot / "saipen"
        self.assertIsNone(RS.runtime_generation_identity(protocol_dir))
        self.assertEqual(RS.protocol_home_runtime_root(protocol_dir), snapshot)
        with unittest.mock.patch.object(A, "HOME", self.source):
            self.assertTrue(A._names_a_real_home(str(protocol_dir)))
            (snapshot / "tools" / "saipen.py").write_text("# older engine\n", encoding="utf-8")
            self.assertFalse(A._names_a_real_home(str(protocol_dir)))

    def test_a_flattened_home_named_saipen_is_its_own_root(self):
        home = flatten(self.source, self.base / "skills" / "saipen")
        self.assertEqual(RS.protocol_home_runtime_root(home), home)

    def test_a_stranger_saipen_directory_is_never_rerooted_into_a_match(self):
        stranger = self.base / "elsewhere" / "saipen"
        stranger.mkdir(parents=True)
        (stranger / "MANIFEST.json").write_text("{}", encoding="utf-8")
        with unittest.mock.patch.object(A, "HOME", self.source):
            self.assertFalse(A._names_a_real_home(str(stranger)))

    def test_the_exact_rendering_still_needs_the_generation(self):
        skill = self.base / "not-a-home"
        skill.mkdir()
        target = self.base / "INSTR.md"
        with unittest.mock.patch.object(A, "HOME", REPO):
            target.write_text(A.rendered_activation_block(skill), encoding="utf-8")
            self.assertEqual(
                A.instruction_status({"instruction_surfaces": [str(target)]}, skill), "stale"
            )


class RealSurfaceCoverageTests(unittest.TestCase):
    """Target B: the REAL manifest covers the code an installed agent executes."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.items = dict(RS.runtime_surface_items(REPO))
        cls.registry = json.loads(
            (REPO / "extensions" / "adapters" / "registry.json").read_text(encoding="utf-8")
        )

    def test_every_executed_runtime_file_is_declared(self):
        executed = {
            "tools/saipen.py",
            "tools/validate.py",
            "tools/host_guard.py",
            "tools/install_host_guard.py",
            "tools/autoinject.py",
            "tools/install_hook.py",
            "tools/freshness.py",
            "bootstrap/inject.ps1",
            "bootstrap/inject.sh",
            "bootstrap/cli_launcher.py",
            "saipen/REGISTRY.json",
            "saipen/MANIFEST.json",
            "saipen/ACTIVATION_BLOCK.md",
            "extensions/adapters/registry.json",
            "extensions/schemas/state.schema.json",
            "VERSION",
        }
        for adapter in self.registry["adapters"]:
            for key in ("hook_artifact", "hook_installer", "launch_implementation"):
                value = adapter.get(key)
                if isinstance(value, str) and value:
                    executed.add(value)
        for path in (REPO / "tools" / "saipen_engine").rglob("*.py"):
            if "__pycache__" not in path.parts:
                executed.add(path.relative_to(REPO).as_posix())
        for path in (REPO / "saipen" / "phases").glob("*.md"):
            executed.add(path.relative_to(REPO).as_posix())
        missing = sorted(name for name in executed if name not in self.items)
        self.assertEqual(missing, [], "executed runtime files outside the generation identity")

    def test_every_protocol_document_beside_boot_is_declared(self):
        undeclared = sorted(
            path.relative_to(REPO).as_posix()
            for path in (REPO / "saipen").iterdir()
            if path.is_file() and path.relative_to(REPO).as_posix() not in self.items
        )
        self.assertEqual(undeclared, [])

    def test_one_enforcement_critical_file_at_a_time_moves_the_generation(self):
        """Mutate each critical shipped file in an installed copy; restore it."""
        critical = [
            "tools/saipen.py",
            "tools/validate.py",
            "tools/host_guard.py",
            "tools/install_host_guard.py",
            "tools/saipen_engine/admission.py",
            "tools/saipen_engine/guard_events.py",
            "tools/saipen_engine/runtime_bootstrap.py",
            "tools/saipen_engine/runtime_surface.py",
            "tools/saipen_engine/manifest.py",
            "tools/saipen_engine/state.py",
            "tools/saipen_engine/board.py",
            "bootstrap/inject.ps1",
            "bootstrap/cli_launcher.py",
            "extensions/adapters/registry.json",
            "extensions/adapters/opencode/saipen-guard.js",
            "saipen/REGISTRY.json",
            "saipen/MANIFEST.json",
            "saipen/phases/build.md",
            "saipen/BOOT.md",
            "extensions/schemas/state.schema.json",
            "VERSION",
        ]
        for name in critical:
            self.assertIn(name, self.items, name)
        home = _tempdir("saipen-gen-real-") / "saipen"
        for declared, path in self.items.items():
            landed = home / RS.installed_relpath(declared)
            landed.parent.mkdir(parents=True, exist_ok=True)
            landed.write_bytes(path.read_bytes())
        baseline = RS.runtime_generation_identity(home)
        self.assertIsNotNone(baseline)
        self.assertEqual(baseline, RS.runtime_generation_identity(REPO))
        for name in critical:
            landed = home / RS.installed_relpath(name)
            original = landed.read_bytes()
            with self.subTest(file=name):
                if name.endswith(".json"):
                    # Keep JSON parseable: the manifest must stay readable so
                    # the change is a CONTENT change, not an unprovable one.
                    landed.write_bytes(original.rstrip() + b"\n\n")
                else:
                    landed.write_bytes(original + b"\n# drift\n")
                moved = RS.runtime_generation_identity(home)
                self.assertIsNotNone(moved)
                self.assertNotEqual(moved, baseline)
            landed.write_bytes(original)
        self.assertEqual(RS.runtime_generation_identity(home), baseline)


class IdentitySessionTests(unittest.TestCase):
    def test_the_memo_lives_only_inside_the_session(self):
        base = _tempdir("saipen-gen-session-")
        source = authority(base / "authority")
        with RS.identity_session():
            first = RS.runtime_generation_identity(source)
            (source / "tools" / "saipen.py").write_text("# changed\n", encoding="utf-8")
            self.assertEqual(RS.runtime_generation_identity(source), first)
        self.assertNotEqual(RS.runtime_generation_identity(source), first)


class InjectorIdentityTests(unittest.TestCase):
    """The installer asks the owner through the source tree's own engine."""

    def test_the_shell_identity_probe_matches_the_owner(self):
        from test_adapter_parity import BASH

        if not BASH:
            self.skipTest("working bash runtime unavailable")
        script = (REPO / "bootstrap" / "inject.sh").read_text(encoding="utf-8")
        start = script.index("runtime_identity() {")
        end = script.index("\n}\n", start) + 3
        probe = (
            f'ROOT="{REPO.as_posix()}"\nPYTHON_BIN="{Path(sys.executable).as_posix()}"\n'
            + script[start:end]
            + '\nruntime_identity "$ROOT"\n'
        )
        completed = subprocess.run(
            [BASH, "-c", probe], capture_output=True, text=True, timeout=120
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-800:])
        generation, _, fingerprint = completed.stdout.strip().partition(" ")
        self.assertEqual(generation, RB.GENERATION)
        self.assertEqual(fingerprint, RS.runtime_generation_identity(REPO))


if __name__ == "__main__":
    unittest.main(verbosity=2)
