"""T-1319 stale-runtime bootstrap regressions.

Focused controls for the mechanism that lets an installed (possibly stale)
runtime refresh itself without trusting project parsing:

A  stale board parser, same saipen.py      -> HOST_RUNTIME_STALE
B  current OpenCode, stale Claude install   -> current RUNTIME_CURRENT
C  provenance names an invalid source       -> CANONICAL_RUNTIME_SOURCE_UNPROVEN,
                                               zero writes
D  arbitrary shell while project is invalid -> refused
E  arbitrary PowerShell installer           -> refused
F  arbitrary Python path                    -> refused
G  exact `saipen runtime --check-freshness` -> admitted
H  exact `saipen runtime --bootstrap`       -> admitted
I  bootstrap + tail / pipe / redirect       -> refused
J  OpenCode-scoped install                  -> only OpenCode surfaces change

K/L/M (project bytes unchanged, fresh-process identity, unchanged BOARD parse)
are proven live by the canonical migration run recorded in LOG.
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

from saipen_engine import guard_events  # noqa: E402
from saipen_engine import runtime_bootstrap as rb  # noqa: E402
from saipen_engine.admission import evaluate_admission  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


_TEMP: list[tempfile.TemporaryDirectory] = []

_RUNTIME_FILES = (
    "saipen/MANIFEST.json",
    "saipen/BOOT.md",
    "VERSION",
    "tools/saipen.py",
    "extensions/adapters/registry.json",
)
_ENGINE_FILES = {"board.py": "BOARD PARSER V1", "state.py": "STATE PARSER V1"}
#: T-1342: the freshness inventory IS the manifest-declared shipped surface.
#: These fixtures declare a small manifest so the same rules can be exercised
#: with the same owner as the real repository.
_MINI_MANIFEST = {
    "copy_trees": [{"src": "tools/saipen_engine", "dst": "tools/saipen_engine"}],
    "files": [
        {"src": "saipen/MANIFEST.json", "required": True},
        {"src": "saipen/BOOT.md", "required": True},
        {"src": "VERSION", "required": True},
        {"src": "tools/saipen.py", "required": True},
        {"src": "extensions/adapters/registry.json", "required": True},
    ],
}


def _find_powershell() -> str | None:
    for name in ("pwsh", "powershell"):
        found = shutil.which(name)
        if found:
            return found
    if os.name == "nt":
        system_root = os.environ.get("SYSTEMROOT") or r"C:\Windows"
        candidate = (
            Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        )
        if candidate.is_file():
            return str(candidate)
    return None


POWERSHELL = _find_powershell()


def _mkdir_temp() -> Path:
    tmp = tempfile.TemporaryDirectory()
    _TEMP.append(tmp)
    return Path(tmp.name)


def _write_source(root: Path) -> None:
    (root / "saipen").mkdir(parents=True, exist_ok=True)
    (root / "tools" / "saipen_engine").mkdir(parents=True, exist_ok=True)
    (root / "extensions" / "adapters").mkdir(parents=True, exist_ok=True)
    (root / "bootstrap").mkdir(parents=True, exist_ok=True)
    (root / "saipen" / "MANIFEST.json").write_text(
        json.dumps(_MINI_MANIFEST, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    for rel in ("saipen/BOOT.md", "VERSION", "tools/saipen.py"):
        (root / rel).write_text(f"marker {rel}\n", encoding="utf-8")
    for name, body in _ENGINE_FILES.items():
        (root / "tools" / "saipen_engine" / name).write_text(body, encoding="utf-8")


def _copy_runtime(source: Path, dst: Path) -> None:
    for rel in _RUNTIME_FILES:
        target = dst / rb._installed_relpath(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / rel, target)
    engine_src = source / "tools" / "saipen_engine"
    engine_dst = dst / "tools" / "saipen_engine"
    engine_dst.mkdir(parents=True, exist_ok=True)
    for path in engine_src.glob("*.py"):
        shutil.copy2(path, engine_dst / path.name)


def make_world(
    *, installed_stale: bool = False, other_stale: bool = False, broken_source: bool = False
) -> tuple[Path, Path, Path]:
    """(source, installed-skill, other-skill) with an installer marker."""
    base = _mkdir_temp()
    source = base / "source"
    installed = base / "installed"
    other = base / "other"
    _write_source(source)
    registry = {
        "adapters": [
            {"id": "opencode", "install": {"skill": str(installed)}},
            {"id": "claude", "install": {"skill": str(other)}},
        ]
    }
    (source / "extensions" / "adapters" / "registry.json").write_text(
        json.dumps(registry), encoding="utf-8"
    )
    _copy_runtime(source, installed)
    _copy_runtime(source, other)

    marker_root = source
    if broken_source:
        marker_root = base / "does-not-exist"
    (installed / rb.PROVENANCE_FILENAME).write_text(
        json.dumps(
            {
                "schema_version": 1,
                "adapter_id": "opencode",
                "canonical_source_root": str(marker_root),
                "installer_generation": rb.GENERATION,
            }
        ),
        encoding="utf-8",
    )
    if installed_stale:
        (installed / "tools" / "saipen_engine" / "board.py").write_text(
            "STALE BOARD PARSER", encoding="utf-8"
        )
    if other_stale:
        (other / "tools" / "saipen_engine" / "board.py").write_text(
            "STALE BOARD PARSER", encoding="utf-8"
        )
    return source, installed, other


class _PatchSkillRoot:
    def __init__(self, skill_root: Path):
        self.skill_root = skill_root

    def __enter__(self):
        self._patch = unittest.mock.patch.object(
            rb, "_skill_root", return_value=self.skill_root
        )
        self._patch.start()
        return self

    def __exit__(self, *exc):
        self._patch.stop()
        return False


class FreshnessScopeTests(unittest.TestCase):
    def test_surface_diff_accepts_flattened_saipen_manifest(self):
        source, installed, _other = make_world()
        self.assertTrue((installed / "MANIFEST.json").is_file())
        self.assertFalse((installed / "saipen" / "MANIFEST.json").exists())
        self.assertEqual(rb.surface_diff(source, installed), [])

    def test_surface_diff_reports_mutated_flattened_manifest(self):
        source, installed, _other = make_world()
        (installed / "MANIFEST.json").write_bytes(
            (source / "saipen" / "MANIFEST.json").read_bytes() + b"x"
        )
        self.assertIn("saipen/MANIFEST.json", rb.surface_diff(source, installed))

    def test_surface_diff_rejects_nested_manifest_without_flattened_manifest(self):
        source, installed, _other = make_world()
        flattened = installed / "MANIFEST.json"
        nested = installed / "saipen" / "MANIFEST.json"
        nested.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(flattened, nested)
        self.assertIn("saipen/MANIFEST.json", rb.surface_diff(source, installed))

    def test_A_stale_board_parser_same_cli_is_stale(self):
        source, installed, _other = make_world(installed_stale=True)
        self.assertEqual(
            (installed / "tools" / "saipen.py").read_bytes(),
            (source / "tools" / "saipen.py").read_bytes(),
        )
        with _PatchSkillRoot(installed):
            report = rb.check_freshness()
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["code"], "HOST_RUNTIME_STALE")
        self.assertTrue(report["current_host"]["stale"])
        self.assertIn("tools/saipen_engine/board.py", report["current_host"]["diff"])

    def test_B_stale_other_host_does_not_stale_current_host(self):
        _source, installed, _other = make_world(other_stale=True)
        with _PatchSkillRoot(installed):
            report = rb.check_freshness()
        self.assertEqual(report["code"], "RUNTIME_CURRENT")
        self.assertFalse(report["current_host"]["stale"])
        fleet = {entry["adapter"]: entry for entry in report["fleet"]}
        self.assertIn("claude", fleet)
        self.assertTrue(fleet["claude"]["stale"])
        self.assertFalse(fleet["opencode"]["stale"])

    def test_C_unproven_source_fails_closed_with_zero_writes(self):
        _source, installed, _other = make_world(broken_source=True)
        with _PatchSkillRoot(installed):
            report = rb.check_freshness()
            self.assertFalse(report["ok"])
            self.assertEqual(report["code"], "CANONICAL_RUNTIME_SOURCE_UNPROVEN")
            before = {
                p: p.read_bytes()
                for p in installed.rglob("*")
                if p.is_file()
            }
            with unittest.mock.patch.object(
                rb, "_invoke_installer"
            ) as installer, self.assertRaises(rb.CanonicalSourceUnproven):
                rb.run_bootstrap()
            installer.assert_not_called()
            after = {p: p.read_bytes() for p in installed.rglob("*") if p.is_file()}
            self.assertEqual(before, after)


def _invalid_project() -> Path:
    root = _mkdir_temp()
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    (saipen / "STATE.md").write_text(
        "---\nphase: DONE\nphase: BUILD\nbroken\n---\n", encoding="utf-8"
    )
    (saipen / "BOARD.md").write_text("## DOING\n## TODO\n## DONE\n", encoding="utf-8")
    (saipen / "LOG.md").write_text(
        "- 12.09.26 00:00 [E-100] [agent: test-agent] RUN: bootstrap fixture\n",
        encoding="utf-8",
    )
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text("code", encoding="utf-8")
    return root


def _admit(root: Path, tool: str, tool_input: dict) -> dict:
    event = {
        "event": "before_tool",
        "host": "opencode",
        "cwd": str(root),
        "tool_name": tool,
        "tool_input": tool_input,
        "actor": "test-agent",
    }
    mapped = guard_events.map_event(event)
    return evaluate_admission(
        root,
        target_path=mapped["target_path"],
        action=mapped["action"],
        agent="test-agent",
        target_paths=mapped["target_paths"],
        targets_unresolved=mapped["targets_unresolved"],
        shell_protected_namespace=mapped["shell_protected_namespace"],
        shell_effects=mapped["shell_effects"],
        shell_effects_unresolved=mapped["shell_effects_unresolved"],
    )


class BootstrapAuthorityTests(unittest.TestCase):
    """Rows D-I: only the exact canonical bootstrap is reachable under debt."""

    def test_D_arbitrary_shell_refused(self):
        root = _invalid_project()
        res = _admit(root, "bash", {"command": "npm install"})
        self.assertFalse(res["admitted"], res)
        self.assertEqual(res["code"], "PROTOCOL_STATE_INVALID")

    def test_D_a_provably_read_only_probe_still_answers(self):
        """T-1363: an invalid protocol state must not blind the agent.

        `read` of the same file was always ADMITTED_READ_ONLY here; the shell
        spelling of the same question was refused, so a model that had to look
        before it could repair spent its turn working around the guard. The
        refusal above is what still matters: an effect nothing can prove
        read-only stays closed.
        """
        root = _invalid_project()
        res = _admit(root, "bash", {"command": "ls -la"})
        self.assertTrue(res["admitted"], res)
        self.assertEqual(res["action"], "read", res)

    def test_E_arbitrary_powershell_installer_refused(self):
        root = _invalid_project()
        res = _admit(
            root,
            "bash",
            {"command": "powershell -ExecutionPolicy Bypass -File bootstrap/inject.ps1"},
        )
        self.assertFalse(res["admitted"], res)

    def test_F_arbitrary_python_path_refused(self):
        root = _invalid_project()
        res = _admit(root, "bash", {"command": "python tools/other.py runtime --bootstrap"})
        self.assertFalse(res["admitted"], res)

    def test_G_exact_check_freshness_admitted(self):
        root = _invalid_project()
        res = _admit(root, "bash", {"command": "saipen runtime --check-freshness"})
        self.assertTrue(res["admitted"], res)

    def test_H_exact_bootstrap_admitted(self):
        root = _invalid_project()
        res = _admit(root, "bash", {"command": "saipen runtime --bootstrap"})
        self.assertTrue(res["admitted"], res)

    def test_I_bootstrap_with_tail_pipe_redirect_refused(self):
        root = _invalid_project()
        for command in (
            "saipen runtime --bootstrap && rm -rf src",
            "saipen runtime --bootstrap; rm src/app.py",
            "saipen runtime --bootstrap | tee out.txt",
            "saipen runtime --bootstrap > out.txt",
        ):
            with self.subTest(command=command):
                res = _admit(root, "bash", {"command": command})
                self.assertFalse(res["admitted"], (command, res))


def _installer_result(returncode: int):
    return subprocess.CompletedProcess(
        args=["installer"], returncode=returncode, stdout="", stderr=""
    )


def _write_valid_marker(
    skill: Path, source: Path, adapter: str = "opencode", fingerprint: str | None = None
) -> None:
    # T-1342: a valid marker names the canonical generation it installed --
    # the one runtime identity, not an arbitrary non-empty token.
    (skill / rb.PROVENANCE_FILENAME).write_text(
        json.dumps(
            {
                "schema_version": 1,
                "adapter_id": adapter,
                "canonical_source_root": str(source),
                "installer_generation": rb.GENERATION,
                "runtime_fingerprint": fingerprint or rb.surface_fingerprint(source),
            }
        ),
        encoding="utf-8",
    )


class BootstrapSuccessGateTests(unittest.TestCase):
    """RUNTIME_BOOTSTRAPPED requires installer success AND valid provenance."""

    def test_provenance_write_readback_failure_is_never_success(self):
        _source, installed, _other = make_world()
        # make_world's marker omits runtime_fingerprint: a malformed marker.
        with _PatchSkillRoot(installed), unittest.mock.patch.object(
            rb, "_invoke_installer", return_value=_installer_result(0)
        ):
            result = rb.run_bootstrap()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "BOOTSTRAP_PROVENANCE_INVALID")
        self.assertIn("runtime_fingerprint", result["provenance_problems"])
        self.assertNotEqual(result["code"], "RUNTIME_BOOTSTRAPPED")

    def test_installer_nonzero_is_install_failed_with_empty_diff(self):
        source, installed, _other = make_world()
        _write_valid_marker(installed, source)
        with _PatchSkillRoot(installed), unittest.mock.patch.object(
            rb, "_invoke_installer", return_value=_installer_result(1)
        ):
            result = rb.run_bootstrap()
        self.assertEqual(result["diff"], [])
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "BOOTSTRAP_INSTALL_FAILED")
        self.assertNotEqual(result["code"], "RUNTIME_BOOTSTRAPPED")

    def test_all_conditions_true_is_runtime_bootstrapped(self):
        source, installed, _other = make_world()
        _write_valid_marker(installed, source)
        with _PatchSkillRoot(installed), unittest.mock.patch.object(
            rb, "_invoke_installer", return_value=_installer_result(0)
        ):
            result = rb.run_bootstrap()
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "RUNTIME_BOOTSTRAPPED")
        self.assertEqual(result["provenance_problems"], [])

    def test_a_marker_naming_another_generation_is_not_success(self):
        """T-1342: provenance must describe the tree it sits in."""
        source, installed, _other = make_world()
        _write_valid_marker(installed, source, fingerprint="gen-sha256:" + "0" * 64)
        with _PatchSkillRoot(installed), unittest.mock.patch.object(
            rb, "_invoke_installer", return_value=_installer_result(0)
        ):
            result = rb.run_bootstrap()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "BOOTSTRAP_PROVENANCE_INVALID")
        self.assertIn("runtime_fingerprint", result["provenance_problems"])

    def test_an_extra_installed_module_is_not_success(self):
        """The diff walk used the canonical inventory; the identity does not."""
        source, installed, _other = make_world()
        _write_valid_marker(installed, source)
        (installed / "tools" / "saipen_engine" / "leftover.py").write_text(
            "LEFTOVER MODULE", encoding="utf-8"
        )
        with _PatchSkillRoot(installed), unittest.mock.patch.object(
            rb, "_invoke_installer", return_value=_installer_result(0)
        ):
            result = rb.run_bootstrap()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "BOOTSTRAP_INCOMPLETE")
        self.assertIn("tools/saipen_engine/leftover.py", result["diff"])


_LAUNCHER_BLOCK_RE = re.compile(
    r"(?ms)^[^\n]*SAIPEN-CLI-LAUNCHER-OWNERSHIP:BEGIN.*?"
    r"^[^\n]*SAIPEN-CLI-LAUNCHER-OWNERSHIP:END[^\n]*\n"
)


def _strip_launcher_blocks(text: str) -> str:
    """Remove the installer's launcher-ownership blocks (red-control subject)."""
    return _LAUNCHER_BLOCK_RE.sub("", text)


def _real_opencode_skill() -> Path:
    return Path(os.path.expanduser("~")) / ".config" / "opencode" / "skills" / "saipen"


def _disposable_env(home: Path) -> dict[str, str]:
    """A child environment that can only write inside ``home``."""
    env = dict(os.environ)
    env["USERPROFILE"] = str(home)
    env["HOME"] = str(home)
    env["SAIPEN_PYTHON"] = sys.executable
    for key in (
        "SAIPEN_PROJECT_ROOT",
        "SAIPEN_PROJECT_LINEAGE",
        "SAIPEN_AGENT",
        "SAIPEN_SKILL_ROOT",
    ):
        env.pop(key, None)
    return env


def _assert_disposable(destination: Path, home: Path) -> None:
    """Fail closed if a disposable install could resolve to the real user home.

    This is the guard the T-1319 accident lacked: a probe that silently fell
    back to the real USERPROFILE would mutate the operator's live skill.
    """
    dest = Path(destination).resolve()
    real = _real_opencode_skill().resolve()
    if dest == real:
        raise AssertionError(
            f"disposable install target resolved to the real user skill home: {dest}"
        )
    try:
        dest.relative_to(Path(home).resolve())
    except ValueError as exc:
        raise AssertionError(
            f"install target {dest} is not inside the disposable home {home}"
        ) from exc


class HostScopedInstallTests(unittest.TestCase):
    def _run_injector(self, script: Path, home: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                POWERSHELL,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script),
                "-SkillHome",
                str(REPO / "saipen"),
                "-AdapterId",
                "opencode",
            ],
            capture_output=True,
            text=True,
            env=_disposable_env(home),
            timeout=600,
        )

    @unittest.skipUnless(POWERSHELL, "PowerShell runtime unavailable")
    def test_J_opencode_scoped_install_only_touches_opencode(self):
        base = _mkdir_temp()
        home = base / "home"
        (home / ".config" / "opencode").mkdir(parents=True)
        (home / ".claude").mkdir()
        _assert_disposable(home / ".config" / "opencode" / "skills" / "saipen", home)
        proc = self._run_injector(REPO / "bootstrap" / "inject.ps1", home)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        opencode_skill = home / ".config" / "opencode" / "skills" / "saipen"
        self.assertTrue(opencode_skill.is_dir(), proc.stdout)
        marker = json.loads(
            (opencode_skill / rb.PROVENANCE_FILENAME).read_text(encoding="utf-8")
        )
        self.assertEqual(marker["adapter_id"], "opencode")
        self.assertTrue(Path(marker["canonical_source_root"]).is_dir())
        self.assertEqual(marker["installer_generation"], rb.GENERATION)
        # The registry declares a Claude skill surface; it must stay untouched.
        self.assertFalse((home / ".claude" / "skills" / "saipen").exists())

    @unittest.skipUnless(POWERSHELL, "PowerShell runtime unavailable")
    def test_K_installer_owns_and_repairs_cli_launcher_surface(self):
        base = _mkdir_temp()
        home = base / "home"
        (home / ".config" / "opencode").mkdir(parents=True)
        skill = home / ".config" / "opencode" / "skills" / "saipen"
        _assert_disposable(skill, home)
        proc = self._run_injector(REPO / "bootstrap" / "inject.ps1", home)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        cmd = skill / "bin" / "saipen.cmd"
        posix = skill / "bin" / "saipen"
        self.assertTrue(cmd.is_file(), proc.stdout)
        self.assertTrue(posix.is_file(), proc.stdout)
        installed_cli = skill / "tools" / "saipen.py"
        self.assertTrue(installed_cli.is_file(), proc.stdout)
        cli_slash = installed_cli.as_posix().lower()
        source_slash = str(REPO).replace("\\", "/").lower()
        for launcher in (cmd, posix):
            text = launcher.read_text(encoding="utf-8", errors="replace")
            normalized = text.replace("\\", "/").lower()
            self.assertIn("saipen.py", text)
            self.assertIn(cli_slash, normalized)
            # Installed launchers must never point at the source checkout.
            self.assertNotIn(source_slash, normalized)
        # Stale launcher bytes are replaced, not preserved.
        cmd.write_text("@echo STALE\r\n", encoding="utf-8", newline="")
        posix.write_text("#!/bin/sh\necho STALE\n", encoding="utf-8", newline="")
        proc = self._run_injector(REPO / "bootstrap" / "inject.ps1", home)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("STALE", cmd.read_text(encoding="utf-8", errors="replace"))
        self.assertNotIn("STALE", posix.read_text(encoding="utf-8", errors="replace"))
        # Host-scoped install leaves other adapters untouched.
        self.assertFalse((home / ".claude" / "skills" / "saipen").exists())

    @unittest.skipUnless(POWERSHELL, "PowerShell runtime unavailable")
    def test_K_red_control_legacy_installer_drops_launchers(self):
        base = _mkdir_temp()
        home = base / "home"
        (home / ".config" / "opencode").mkdir(parents=True)
        skill = home / ".config" / "opencode" / "skills" / "saipen"
        _assert_disposable(skill, home)
        # The canonical installer persists the launcher surface ...
        proc = self._run_injector(REPO / "bootstrap" / "inject.ps1", home)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertTrue((skill / "bin" / "saipen.cmd").is_file(), proc.stdout)
        # ... and the pre-fix installer (launcher ownership block stripped)
        # removes it. RED is the whole point: this test FAILS before the fix.
        legacy = base / "legacy-inject.ps1"
        legacy.write_text(
            _strip_launcher_blocks(
                (REPO / "bootstrap" / "inject.ps1").read_text(encoding="utf-8-sig")
            ),
            encoding="utf-8",
            newline="\n",
        )
        proc = self._run_injector(legacy, home)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertFalse(
            (skill / "bin").exists(),
            "the pre-fix installer must drop the pre-seeded launcher directory",
        )

    def test_L_disposable_install_target_guard_fails_closed(self):
        base = _mkdir_temp()
        home = base / "home"
        _assert_disposable(home / ".config" / "opencode" / "skills" / "saipen", home)
        with self.assertRaises(AssertionError):
            _assert_disposable(_real_opencode_skill(), home)

    @unittest.skipUnless(POWERSHELL, "PowerShell runtime unavailable")
    def test_unknown_adapter_id_is_a_hard_failure(self):
        base = _mkdir_temp()
        home = base / "home"
        (home / ".config" / "opencode").mkdir(parents=True)
        proc = subprocess.run(
            [
                POWERSHELL,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(REPO / "bootstrap" / "inject.ps1"),
                "-AdapterId",
                "not-a-host",
            ],
            capture_output=True,
            text=True,
            env=_disposable_env(home),
            timeout=300,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("unknown adapter id", (proc.stdout + proc.stderr))


if __name__ == "__main__":
    unittest.main()
