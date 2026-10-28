"""Adapter registry parity, one-template and freshness tests (SRC-028:R008/R009,
SRC-028:R014, SRC-030 Parts 7, 8 and 12).

Every consumer of host identity -- admission.py, autoinject.py, inject.ps1,
inject.sh -- must see the SAME host set from ONE shipped authority, and both
injectors must render the ONE activation template. These tests fail when a
second handwritten host inventory appears anywhere.
"""

from __future__ import annotations

import json
import os
import re
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

import autoinject  # noqa: E402
from saipen_engine.admission import ADAPTER_REGISTRY  # noqa: E402

REGISTRY_PATH = REPO / "extensions" / "adapters" / "registry.json"
PS1 = REPO / "bootstrap" / "inject.ps1"
SH = REPO / "bootstrap" / "inject.sh"
UNINSTALL_PS1 = REPO / "bootstrap" / "uninstall.ps1"
UNINSTALL_SH = REPO / "bootstrap" / "uninstall.sh"
TEMPLATE = REPO / "saipen" / "ACTIVATION_BLOCK.md"


def _find_bash() -> str | None:
    """A WORKING bash (T-1317 P1-3).

    From Python on Windows a plain `bash` resolves to the WSL stub, which
    without an installed distro prints a UTF-16 error and runs nothing; on a
    Linux audit box bash may be absent entirely. Explicit Git-for-Windows paths
    first, then `bash` from PATH when it is not the system32 stub, and only
    then the skip -- a missing shell runtime is an environment fact, never a
    product regression.
    """
    for candidate in (
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        shutil.which("bash"),
    ):
        if not candidate or not os.path.exists(candidate):
            continue
        if "system32" in candidate.lower():
            continue
        return candidate
    return None


def _find_powershell() -> str | None:
    for name in ("pwsh", "powershell"):
        found = shutil.which(name)
        if found:
            return found
    return None


BASH = _find_bash()
POWERSHELL = _find_powershell()


#: Dotted host-home tokens the installers and uninstallers may name.
_HOST_HOME_PATTERN = re.compile(
    r"\.(?:claude|codex|gemini|codebuddy|agents|config[/\\]opencode"
    r"|knowledge\.md|AGENTS\.md|aider\.conf\.yml)"
)


def registry() -> dict:
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))


def registry_home_tokens() -> set[str]:
    """Dotted home tokens (`.claude`, `.config/opencode`, ...) the registry declares."""
    tokens: set[str] = set()
    for adapter in registry()["adapters"]:
        surfaces = list(adapter.get("instruction_surfaces") or [])
        surfaces += list(adapter.get("skill_surfaces") or [])
        for surface in surfaces:
            parts = Path(surface).parts  # ('~', '.claude', 'skills', ...)
            for index, part in enumerate(parts):
                if part.startswith("~"):
                    continue
                if part.startswith("."):
                    rest = "/".join(parts[index : index + 2])
                    tokens.add(rest.replace("\\", "/"))
    install_homes = {
        (adapter.get("install") or {}).get("home")
        for adapter in registry()["adapters"]
        if adapter.get("install")
    }
    for home in install_homes:
        if isinstance(home, str) and home.startswith("~/"):
            tokens.add(home[2:].rstrip("/"))
    return tokens


class RegistryParityTests(unittest.TestCase):
    def test_python_runtime_sees_the_registry_host_set(self):
        declared = {entry["id"] for entry in registry()["adapters"]}
        self.assertEqual(set(ADAPTER_REGISTRY.keys()), declared)

    def test_autoinject_sees_the_registry_host_set(self):
        loaded = autoinject.load_adapter_registry()
        self.assertEqual(
            {entry["id"] for entry in loaded["adapters"]},
            {entry["id"] for entry in registry()["adapters"]},
        )

    def test_autoinject_targets_are_registry_skill_surfaces(self):
        expected = sorted(
            {
                str(Path(surface).expanduser().resolve())
                for adapter in registry()["adapters"]
                for surface in (adapter.get("skill_surfaces") or [])
            }
        )
        self.assertEqual(sorted(str(Path(t).resolve()) for t in autoinject.TARGETS), expected)

    def test_installers_and_uninstallers_declare_no_undeclared_host_home(self):
        for path in (PS1, SH, UNINSTALL_PS1, UNINSTALL_SH):
            text = path.read_text(encoding="utf-8")
            found = set(_HOST_HOME_PATTERN.findall(text))
            known = registry_home_tokens()
            unknown = {
                token.replace("\\", "/").lower()
                for token in found
                if token.replace("\\", "/").lower() not in {k.lower() for k in known}
            }
            self.assertEqual(
                unknown,
                set(),
                f"{path.name} references host surfaces absent from the registry: {unknown}",
            )

    def test_bespoke_installers_must_be_declared_in_the_registry(self):
        declared = {
            (adapter.get("install") or {}).get("bespoke")
            for adapter in registry()["adapters"]
            if adapter.get("install")
        }
        for path in (PS1, SH):
            text = path.read_text(encoding="utf-8")
            for name in re.findall(
                r"'([a-z-]+-backstop[a-z-]*|aider-conf|antigravity-plugins)'", text
            ):
                self.assertIn(
                    name, declared, f"{path.name} wires undeclared bespoke installer {name}"
                )

    def test_opencode_hook_artifact_is_registered_and_shipped(self):
        adapter = ADAPTER_REGISTRY["opencode"]
        artifact = REPO / adapter["hook_artifact"]
        self.assertTrue(artifact.is_file())
        # The supported runtime's global local plugin directory is the PLURAL
        # `plugins/` (T-1317 P0-3, verified against OpenCode 1.18.x with
        # `opencode debug config`).
        self.assertEqual(
            adapter["hook_install_surface"], "~/.config/opencode/plugins/saipen-guard.js"
        )
        self.assertEqual(
            adapter["launch_command"],
            "python ~/.config/opencode/skills/saipen/tools/saipen.py --agent <seat> "
            "launch opencode -- [arguments]",
        )
        self.assertEqual(
            adapter["launch_implementation"], "tools/saipen_engine/host_launch.py"
        )
        self.assertEqual(adapter["launch_requirement"], "optional_explicit_actor")
        self.assertEqual(
            adapter["routine_launch"],
            "generic OpenCode launch; no SAIPEN seat required",
        )
        self.assertEqual(
            adapter["install"]["hook"], "~/.config/opencode/plugins/saipen-guard.js"
        )
        # ...and the singular `plugin/` directory is ALSO discovered by that
        # runtime, so it must be declared as a legacy surface the injector
        # clears and the freshness report flags: never two hook loads.
        self.assertIn(
            "~/.config/opencode/plugin/saipen-guard.js",
            adapter.get("legacy_hook_surfaces") or [],
        )
        self.assertIn("hook", adapter["freshness_surfaces"])

    def test_a_stale_legacy_hook_surface_makes_the_home_stale(self):
        install_dir = Path(tempfile.mkdtemp())
        legacy = install_dir / "plugin" / "saipen-guard.js"
        legacy.parent.mkdir(parents=True)
        adapter = {
            "id": "opencode",
            "hook_install_surface": str(install_dir / "plugins" / "saipen-guard.js"),
            "hook_artifact": "extensions/adapters/opencode/saipen-guard.js",
            "legacy_hook_surfaces": [str(legacy)],
            # T-1342: the plugin executes this skill's engine; here the
            # repository itself, which IS the accepted generation.
            "install": {"skill": str(REPO)},
        }
        self.assertEqual(autoinject.hook_status(adapter), "absent")
        legacy.write_bytes(b"// stale singular copy\n")
        self.assertEqual(autoinject.hook_status(adapter), "stale")
        legacy.unlink()
        current = install_dir / "plugins" / "saipen-guard.js"
        current.parent.mkdir(parents=True)
        current.write_bytes((REPO / adapter["hook_artifact"]).read_bytes())
        self.assertEqual(autoinject.hook_status(adapter), "current")


class OneTemplateTests(unittest.TestCase):
    def test_template_exists_and_carries_the_semantics(self):
        text = TEMPLATE.read_text(encoding="utf-8")
        self.assertIn("SHORTCUT ACTIVATION GATE", text)
        # T-1466: cf5102eb (EXEC-RESPONSE-01) renamed the gate FIRST-OUTPUT GATE
        # when it came to own response structure beside language; the language
        # pin it always carried is asserted by meaning, not by the old title.
        self.assertIn("FIRST-OUTPUT GATE", text)
        flat = " ".join(text.split())
        self.assertIn(
            "is the absolute chat language for EVERY response including the first, "
            "and incoming user language MUST NOT override it",
            flat,
        )
        # T-1317 P1-3: a placeholder COUNT is not the contract -- the template
        # legitimately points at BOOT.md, STYLE.md and UI.md, so the contract is
        # that every placeholder renders to the installed home with none left
        # behind, and that each required semantic pointer survives the render.
        home = REPO / "saipen"
        rendered = autoinject.rendered_activation_block(home)
        self.assertNotIn("{{SAIPEN_HOME}}", rendered)
        self.assertIn("{{SAIPEN_HOME}}", text)
        self.assertEqual(rendered.count(str(home)), text.count("{{SAIPEN_HOME}}"))
        normalized = rendered.replace("\\", "/")
        for pointer in ("BOOT.md", "STYLE.md", "UI.md"):
            self.assertIn(f"{str(home).replace(chr(92), '/')}/{pointer}", normalized)

    def test_injectors_no_longer_embed_the_block(self):
        for path in (PS1, SH):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("SHORTCUT ACTIVATION GATE", text, f"{path.name} embeds a block copy")
            marker = "activation_template" if path.suffix == ".json" else "ACTIVATION_BLOCK.md"
            self.assertIn(marker, text, f"{path.name} does not render the activation template")

    @unittest.skipUnless(POWERSHELL, "PowerShell runtime unavailable")
    @unittest.skipUnless(BASH, "working bash runtime unavailable")
    def test_both_injectors_install_identical_normalized_blocks(self):
        """Run BOTH injectors against a fake home and compare the installed
        blocks byte-normalized (SRC-030 Part 8). Slow but real.

        Skips cleanly when either required runtime is absent: a Linux audit
        environment without PowerShell is an environment fact, never a product
        regression (T-1317 P1-3).
        """
        template = TEMPLATE.read_text(encoding="utf-8")
        skill_home = (REPO / "saipen").resolve()
        expected = (
            template.replace("{{SAIPEN_HOME}}", str(skill_home)).replace("\r\n", "\n").strip()
        )

        ps1_home = Path(tempfile.mkdtemp())
        (ps1_home / ".claude").mkdir()
        proc = subprocess.run(
            [
                POWERSHELL,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(PS1),
            ],
            capture_output=True,
            text=True,
            env={**os.environ, "USERPROFILE": str(ps1_home)},
            timeout=300,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        ps1_block = self._block((ps1_home / ".claude" / "CLAUDE.md").read_text(encoding="utf-8"))

        sh_home = Path(tempfile.mkdtemp())
        (sh_home / ".claude").mkdir()
        (sh_home / ".config" / "opencode").mkdir(parents=True)
        proc = subprocess.run(
            [BASH, str(SH)],
            capture_output=True,
            text=True,
            env={**os.environ, "HOME": str(sh_home).replace("\\", "/")},
            timeout=300,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        sh_block = self._block((sh_home / ".claude" / "CLAUDE.md").read_text(encoding="utf-8"))

        def norm(block: str) -> str:
            return block.replace("\\", "/").replace("\r\n", "\n").strip()

        self.assertEqual(norm(ps1_block), norm(sh_block))
        self.assertEqual(norm(ps1_block), norm(expected))

    @staticmethod
    def _block(text: str) -> str:
        match = re.search(r"<!-- SAIPEN:BEGIN -->.*?<!-- SAIPEN:END -->", text, re.DOTALL)
        assert match, "no SAIPEN block in installed instructions"
        return match.group(0)


class GuardHookInstallTests(unittest.TestCase):
    """T-1317 P0-3: exactly ONE installed guard hook surface."""

    @unittest.skipUnless(BASH, "working bash runtime unavailable")
    def test_the_injector_installs_one_hook_and_clears_the_legacy_surface(self):
        home = Path(tempfile.mkdtemp())
        (home / ".config" / "opencode").mkdir(parents=True)
        legacy = home / ".config" / "opencode" / "plugin" / "saipen-guard.js"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("// stale singular copy\n", encoding="utf-8")
        proc = subprocess.run(
            [BASH, str(SH)],
            capture_output=True,
            text=True,
            env={**os.environ, "HOME": str(home).replace("\\", "/")},
            timeout=300,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        installed = home / ".config" / "opencode" / "plugins" / "saipen-guard.js"
        self.assertTrue(installed.is_file(), proc.stdout)
        self.assertEqual(
            installed.read_bytes(),
            (REPO / "extensions" / "adapters" / "opencode" / "saipen-guard.js").read_bytes(),
        )
        # This is the duplicate-load control: the runtime discovers BOTH
        # directories, so the stale singular copy must be gone after install.
        self.assertFalse(legacy.exists(), "legacy singular plugin/ copy would load twice")


class FreshnessTests(unittest.TestCase):
    def test_instruction_surface_states(self):
        # T-1342: the home a current block names must prove the accepted
        # generation; the repository's own protocol directory does.
        skill_dir = REPO / "saipen"
        target = Path(tempfile.mkdtemp()) / "INSTR.md"
        current = autoinject.rendered_activation_block(skill_dir)
        adapter = {"instruction_surfaces": [str(target)]}
        target.write_text(current, encoding="utf-8")
        self.assertEqual(autoinject.instruction_status(adapter, skill_dir), "current")
        # T-1317 P1-3: the managed BLOCK is the contract. User text outside
        # BEGIN..END is theirs and must never read as SAIPEN staleness...
        target.write_text(
            "# my own notes\n\n" + current + "\n\nuser text after the block\n",
            encoding="utf-8",
        )
        self.assertEqual(autoinject.instruction_status(adapter, skill_dir), "current")
        # ...while a changed block itself IS staleness.
        mangled = current.replace("SHORTCUT ACTIVATION GATE", "SHORTCUT GATE")
        self.assertNotEqual(mangled, current)
        target.write_text(mangled, encoding="utf-8")
        self.assertEqual(autoinject.instruction_status(adapter, skill_dir), "stale")
        target.unlink()
        self.assertEqual(autoinject.instruction_status(adapter, skill_dir), "absent")

    def test_hook_surface_states(self):
        artifact = "extensions/adapters/opencode/saipen-guard.js"
        shipped = (REPO / artifact).read_bytes()
        install_dir = Path(tempfile.mkdtemp())
        hook = install_dir / "saipen-guard.js"
        adapter = {
            "hook_install_surface": str(hook),
            "hook_artifact": artifact,
            "install": {"skill": str(REPO)},
        }
        self.assertEqual(autoinject.hook_status(adapter), "absent")
        hook.write_bytes(shipped)
        self.assertEqual(autoinject.hook_status(adapter), "current")
        hook.write_bytes(b"// stale")
        self.assertEqual(autoinject.hook_status(adapter), "stale")
        missing = dict(adapter, hook_artifact="extensions/adapters/opencode/does-not-exist.js")
        self.assertEqual(autoinject.hook_status(missing), "unknown")

    def test_a_current_plugin_over_a_stale_delegated_engine_is_stale(self):
        """T-1342: the wrapper bytes are current; the engine it runs is not."""
        from test_distribution_report import install_copy, mini_source

        artifact = "extensions/adapters/opencode/saipen-guard.js"
        base = Path(tempfile.mkdtemp())
        hook = base / "plugins" / "saipen-guard.js"
        hook.parent.mkdir(parents=True)
        hook.write_bytes((REPO / artifact).read_bytes())
        source = mini_source(base / "source")
        skill = install_copy(source, base / "skills" / "saipen")
        adapter = {
            "hook_install_surface": str(hook),
            "hook_artifact": artifact,
            "install": {"skill": str(skill)},
        }
        shipped = (REPO / artifact).read_bytes()
        (source / artifact).parent.mkdir(parents=True, exist_ok=True)
        (source / artifact).write_bytes(shipped)
        with unittest.mock.patch.object(autoinject, "HOME", source):
            self.assertEqual(autoinject.hook_status(adapter), "current")
            (skill / "tools" / "saipen.py").write_text("# stale engine\n", encoding="utf-8")
            state = autoinject._hook_state(adapter)
        self.assertEqual(state["status"], "stale", state)
        self.assertFalse(state["delegated_current"], state)
        self.assertEqual(state["delegated_root"], str(skill))

    def test_an_unobservable_hook_makes_a_stamped_home_not_fresh(self):
        skill_dir = Path(tempfile.mkdtemp())
        (skill_dir / autoinject.STAMP).write_text(
            json.dumps(
                {"digest": "x", "source_head": "head", "installed_at": "2026-09-12T00:00:00Z"}
            ),
            encoding="utf-8",
        )
        adapter = {
            "id": "opencode",
            "skill_surfaces": [str(skill_dir)],
            "instruction_surfaces": [],
            "hook_install_surface": str(skill_dir / "hook.js"),
            "hook_artifact": "extensions/adapters/opencode/saipen-guard.js",
            "freshness_surfaces": ["hook"],
        }
        (skill_dir / "hook.js").write_bytes(b"installed but unreadable payload mismatch")
        self.addCleanup(lambda: None)
        fake_adapter = dict(adapter, hook_artifact="extensions/adapters/opencode/none.js")
        with unittest.mock.patch.object(autoinject, "TARGETS", [skill_dir]), \
                unittest.mock.patch.object(
                    autoinject, "_HOME_ADAPTERS", {str(skill_dir.resolve()): fake_adapter}
                ):
            report = autoinject.distribution_report(source_head="head")
        self.assertFalse(report["fresh"])
        self.assertEqual(report["surface_unknown"], 1)
        self.assertEqual(report["homes"][0]["surfaces"]["hook"], "unknown")

    def test_a_fully_absent_surface_set_stays_fresh(self):
        # T-1317 P1-3: "fully absent" means the declared surface is a path that
        # was never created -- a fixture that mkdir()s the target is testing an
        # installed-but-empty surface, not an absent one. T-1342: the skill copy
        # itself must hold the accepted runtime; a stamp alone is not a home.
        from test_distribution_report import install_copy, mini_source

        base = Path(tempfile.mkdtemp())
        source = mini_source(base / "source")
        (source / "saipen" / "ACTIVATION_BLOCK.md").write_bytes(TEMPLATE.read_bytes())
        skill_dir = install_copy(source, base / "installed-skill")
        (skill_dir / autoinject.STAMP).write_text(
            json.dumps(
                {"digest": "x", "source_head": "head", "installed_at": "2026-09-12T00:00:00Z"}
            ),
            encoding="utf-8",
        )
        absent = base / "never-created" / "AGENTS.md"
        adapter = {
            "id": "codex",
            "skill_surfaces": [str(skill_dir)],
            "instruction_surfaces": [str(absent)],
            "hook_install_surface": None,
            "hook_artifact": None,
            "freshness_surfaces": ["instruction"],
        }
        self.assertFalse(absent.exists())
        with unittest.mock.patch.object(autoinject, "TARGETS", [skill_dir]), \
                unittest.mock.patch.object(
                    autoinject, "_HOME_ADAPTERS", {str(skill_dir.resolve()): adapter}
                ), \
                unittest.mock.patch.object(autoinject, "HOME", source), \
                unittest.mock.patch.object(autoinject, "last_inject_run", return_value=None):
            report = autoinject.distribution_report(source_head="head")
        self.assertEqual(report["homes"][0]["surfaces"]["instruction"], "absent")
        self.assertEqual(report["surface_unknown"], 0)
        self.assertTrue(report["fresh"], report)

    def test_an_absent_home_is_not_counted_as_installed(self):
        missing = Path(tempfile.mkdtemp()) / "never-installed"
        with unittest.mock.patch.object(autoinject, "TARGETS", [missing]):
            report = autoinject.distribution_report(source_head="head")
        self.assertEqual(report["installed"], 0)
        self.assertEqual(report["stale"], 0)
        self.assertFalse(report["fresh"])


if __name__ == "__main__":
    unittest.main()
