"""T-1389: this repository owns and proves the adopted injector/runtime delta.

The delta was written 2026-09-17 18:04Z by a foreign agent under AUDAPACK
T-195 and classified LEGIT_FOREIGN_ABANDONED in
evidence/T-1385-foreign-delta-inquest-20260917/INQUEST.md. These tests are
the adoption proof the inquest demanded: the fail-closed authority branch,
the two provenance-writing injector surfaces, and a red control pinned to
the pre-delta injector blobs (ps1 edfb5db1, sh a291ad1d) proving those
surfaces were skipped before the delta.
"""

import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_hermetic_env import isolate_host_session
from test_runtime_bootstrap import (
    POWERSHELL,
    _assert_disposable,
    _disposable_env,
    _mkdir_temp,
    make_world,
)

import saipen_engine.runtime_bootstrap as rb

REPO = Path(__file__).resolve().parent.parent

#: The pre-delta injector blobs recorded by the inquest. If garbage
#: collection ever removes them, the red controls skip and point here
#: instead of silently passing on unproven bytes.
_PREDELTA_PS1_BLOB = "edfb5db1"
_PREDELTA_SH_BLOB = "a291ad1d"

def _resolve_bash() -> str | None:
    """A bash that actually executes; the System32 stub is WSL, not bash."""
    candidates = [shutil.which("bash")]
    for extra in (
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ):
        if os.path.isfile(extra):
            candidates.append(extra)
    for candidate in candidates:
        if not candidate:
            continue
        try:
            proc = subprocess.run(
                [candidate, "-c", "exit 0"], capture_output=True, timeout=30
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if proc.returncode == 0:
            return candidate
    return None


_BASH = _resolve_bash()


def _mini_source(script_bytes: bytes) -> Path:
    """A minimal canonical source tree whose bootstrap/inject.sh is pinned.

    The sh injector derives its source root from its own location, so a
    red control on pinned pre-delta bytes needs the script placed inside a
    real (small) source layout. The registry is the real one so the
    freebuff-backstop row is exactly what production parses.
    """
    from test_runtime_bootstrap import _ENGINE_FILES, _MINI_MANIFEST

    source = _mkdir_temp() / "source"
    (source / "saipen").mkdir(parents=True)
    (source / "tools" / "saipen_engine").mkdir(parents=True)
    (source / "extensions" / "adapters").mkdir(parents=True)
    (source / "bootstrap").mkdir(parents=True)
    (source / "saipen" / "phases").mkdir(parents=True)
    manifest = dict(_MINI_MANIFEST)
    manifest["managed_dirs"] = ["phases"]
    manifest["phase_docs"] = {"files": ["scout.md"]}
    manifest["copy_trees"] = [
        *_MINI_MANIFEST["copy_trees"],
        {"src": "saipen/phases", "dst": "phases"},
    ]
    (source / "saipen" / "MANIFEST.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    (source / "saipen" / "phases" / "scout.md").write_text(
        "marker phases/scout.md\n", encoding="utf-8"
    )
    shutil.copy2(
        REPO / "bootstrap" / "cli_launcher.py",
        source / "bootstrap" / "cli_launcher.py",
    )
    for rel in (
        "saipen/BOOT.md",
        "saipen/ACTIVATION_BLOCK.md",
        "VERSION",
        "tools/saipen.py",
    ):
        (source / rel).write_text(f"marker {rel}\n", encoding="utf-8")
    for name, body in _ENGINE_FILES.items():
        (source / "tools" / "saipen_engine" / name).write_text(body, encoding="utf-8")
    shutil.copy2(
        REPO / "extensions" / "adapters" / "registry.json",
        source / "extensions" / "adapters" / "registry.json",
    )
    (source / "bootstrap" / "inject.sh").write_bytes(script_bytes)
    return source


def _predelta_script(blob: str, suffix: str) -> Path | None:
    """Extract a pinned pre-delta injector blob to a temp file, or None."""
    try:
        proc = subprocess.run(
            ["git", "-C", str(REPO), "cat-file", "blob", blob],
            capture_output=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    out = _mkdir_temp() / f"predelta-injector{suffix}"
    out.write_bytes(proc.stdout)
    return out


def setUpModule() -> None:
    isolate_host_session()


class ResolveAuthorityAdoptionTests(unittest.TestCase):
    """The fail-closed branch for an unmarked installed projection."""

    def test_A_unmarked_installed_projection_is_refused_naming_marker_and_injector(self):
        _source, installed, _other = make_world()
        marker = installed / rb.PROVENANCE_FILENAME
        self.assertTrue(marker.is_file())
        marker.unlink()
        with self.assertRaises(rb.CanonicalSourceUnproven) as raised:
            rb.resolve_authority(skill_root=installed)
        message = str(raised.exception)
        self.assertIn(rb.PROVENANCE_FILENAME, message)
        self.assertIn("injector", message)

    def test_B_marked_installed_projection_resolves(self):
        source, installed, _other = make_world()
        resolved, host = rb.resolve_authority(skill_root=installed)
        self.assertEqual(Path(resolved).resolve(), source.resolve())
        self.assertEqual(host, "opencode")

    def test_C_source_tree_still_resolves_without_a_marker(self):
        source, _installed, _other = make_world()
        self.assertFalse((source / rb.PROVENANCE_FILENAME).exists())
        resolved, host = rb.resolve_authority(adapter_id="opencode", skill_root=source)
        self.assertEqual(Path(resolved).resolve(), source.resolve())
        self.assertEqual(host, "opencode")


class AgentsSurfaceTests(unittest.TestCase):
    """Both injectors write provenance beside the ~/.agents skill copy."""

    def _home(self) -> Path:
        base = _mkdir_temp()
        home = base / "home"
        (home / ".agents" / "skills").mkdir(parents=True)
        return home

    def _marker(self, home: Path) -> dict:
        path = home / ".agents" / "skills" / "saipen" / rb.PROVENANCE_FILENAME
        self.assertTrue(path.is_file())
        return json.loads(path.read_text(encoding="utf-8"))

    def _skill_copied(self, home: Path) -> None:
        boot = home / ".agents" / "skills" / "saipen" / "BOOT.md"
        self.assertTrue(boot.is_file())

    @unittest.skipUnless(POWERSHELL, "PowerShell runtime unavailable")
    def test_D_ps1_injector_marks_the_agents_skill_surface(self):
        home = self._home()
        _assert_disposable(home / ".agents" / "skills" / "saipen", home)
        proc = subprocess.run(
            [
                POWERSHELL, "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", str(REPO / "bootstrap" / "inject.ps1"),
                "-SkillHome", str(REPO / "saipen"),
                "-AdapterId", "freebuff",
            ],
            capture_output=True, text=True,
            env=_disposable_env(home), timeout=600,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self._skill_copied(home)
        marker = self._marker(home)
        self.assertEqual(marker["adapter_id"], "freebuff")

    @unittest.skipUnless(_BASH, "bash runtime unavailable")
    def test_D_sh_injector_marks_the_agents_skill_surface(self):
        home = self._home()
        env = _disposable_env(home)
        env["HOME"] = home.as_posix()
        proc = subprocess.run(
            [_BASH, str(REPO / "bootstrap" / "inject.sh"), "--adapter", "freebuff"],
            capture_output=True, text=True, env=env, timeout=600,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self._skill_copied(home)
        marker = self._marker(home)
        self.assertEqual(marker["adapter_id"], "freebuff")

    @unittest.skipUnless(POWERSHELL, "PowerShell runtime unavailable")
    def test_red_control_predelta_ps1_skipped_the_agents_surface(self):
        script = _predelta_script(_PREDELTA_PS1_BLOB, ".ps1")
        if script is None:
            self.skipTest(
                "pre-delta ps1 blob unavailable; see "
                "evidence/T-1385-foreign-delta-inquest-20260917"
            )
        home = self._home()
        proc = subprocess.run(
            [
                POWERSHELL, "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", str(script),
                "-SkillHome", str(REPO / "saipen"),
                "-AdapterId", "freebuff",
            ],
            capture_output=True, text=True,
            env=_disposable_env(home), timeout=600,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self._skill_copied(home)
        marker = home / ".agents" / "skills" / "saipen" / rb.PROVENANCE_FILENAME
        self.assertFalse(marker.exists())

    @unittest.skipUnless(_BASH, "bash runtime unavailable")
    def test_red_control_predelta_sh_skipped_the_agents_surface(self):
        script = _predelta_script(_PREDELTA_SH_BLOB, ".sh")
        if script is None:
            self.skipTest(
                "pre-delta sh blob unavailable; see "
                "evidence/T-1385-foreign-delta-inquest-20260917"
            )
        source = _mini_source(script.read_bytes())
        home = self._home()
        env = _disposable_env(home)
        env["HOME"] = home.as_posix()
        proc = subprocess.run(
            [_BASH, str(source / "bootstrap" / "inject.sh"), "--adapter", "freebuff"],
            capture_output=True, text=True, env=env, timeout=600,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self._skill_copied(home)
        marker = home / ".agents" / "skills" / "saipen" / rb.PROVENANCE_FILENAME
        self.assertFalse(marker.exists())


class AntigravitySurfaceTests(unittest.TestCase):
    """The ps1 injector marks each Antigravity plugin skill surface."""

    def _home(self) -> Path:
        base = _mkdir_temp()
        home = base / "home"
        (home / ".gemini" / "config" / "plugins" / "agtest" / "skills").mkdir(parents=True)
        return home

    def _marker_path(self, home: Path) -> Path:
        return (
            home / ".gemini" / "config" / "plugins" / "agtest"
            / "skills" / "saipen" / rb.PROVENANCE_FILENAME
        )

    @unittest.skipUnless(POWERSHELL, "PowerShell runtime unavailable")
    def test_D_ps1_injector_marks_the_antigravity_plugin_skill_surface(self):
        home = self._home()
        proc = subprocess.run(
            [
                POWERSHELL, "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", str(REPO / "bootstrap" / "inject.ps1"),
                "-SkillHome", str(REPO / "saipen"),
                "-AdapterId", "antigravity",
            ],
            capture_output=True, text=True,
            env=_disposable_env(home), timeout=600,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        boot = (
            home / ".gemini" / "config" / "plugins" / "agtest"
            / "skills" / "saipen" / "BOOT.md"
        )
        self.assertTrue(boot.is_file(), proc.stdout)
        marker = json.loads(self._marker_path(home).read_text(encoding="utf-8"))
        self.assertEqual(marker["adapter_id"], "antigravity")

    @unittest.skipUnless(POWERSHELL, "PowerShell runtime unavailable")
    def test_red_control_predelta_ps1_skipped_the_antigravity_surface(self):
        script = _predelta_script(_PREDELTA_PS1_BLOB, ".ps1")
        if script is None:
            self.skipTest(
                "pre-delta ps1 blob unavailable; see "
                "evidence/T-1385-foreign-delta-inquest-20260917"
            )
        home = self._home()
        proc = subprocess.run(
            [
                POWERSHELL, "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", str(script),
                "-SkillHome", str(REPO / "saipen"),
                "-AdapterId", "antigravity",
            ],
            capture_output=True, text=True,
            env=_disposable_env(home), timeout=600,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        boot = (
            home / ".gemini" / "config" / "plugins" / "agtest"
            / "skills" / "saipen" / "BOOT.md"
        )
        self.assertTrue(boot.is_file(), proc.stdout)
        self.assertFalse(self._marker_path(home).exists())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
