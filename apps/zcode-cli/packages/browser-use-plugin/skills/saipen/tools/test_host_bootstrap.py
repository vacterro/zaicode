# ruff: noqa: RUF001 - the Cyrillic-twin assertions require real Cyrillic.
"""T-1424/T-1425 host bootstrap / runtime binding / FreeBuff regressions.

The field failure: a SAIPEN-managed project (`.saipen/` present) was opened in
an isolated host whose shell could not resolve the `saipen` executable or the
Python engine. The protocol commands were not recognised and the host went on
editing product bytes as an ordinary writable session -- SAIPEN silently
disappeared with no third state.

T-1424 built the resolver; this suite pins the repaired acceptance surface
(T-1425). Every test asserts ONE terminal verdict -- no `A or B` assertions,
and no monkeypatched core resolver standing in for a filesystem fixture:

  * BOUND          -- a canonical runtime is reachable and the host is
                      registered, so the lifecycle continues;
  * HOST_UNSUPPORTED -- a runtime may be discovered for DIAGNOSTICS, but an
                      explicitly unregistered host is never green and never
                      grants writable admission;
  * UNAVAILABLE    -- no canonical runtime is reachable; ONE stable diagnostic
                      names the exact unsupported boundary;
  * HOME_REQUIRED  -- a dead persisted home with NO proven replacement fails
                      closed; with a proven replacement the canonical automatic
                      convergence (`saipen rebind-home --auto`) commits and
                      admission re-evaluates green.

The `engine_root` keyword is a first-class fixture knob (not a monkeypatch):
it models a host whose executing engine is not itself a usable install, which
is the only way the UNAVAILABLE branch legitimately occurs.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import host_bootstrap as hb  # noqa: E402
from saipen_engine.admission import evaluate_admission  # noqa: E402
from saipen_engine.paths import (  # noqa: E402
    identity_file_content,
    new_project_lineage,
)
from saipen_engine.state import running_style_token  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


_TEMP: list[tempfile.TemporaryDirectory] = []


def _temp() -> Path:
    tmp = tempfile.TemporaryDirectory()
    _TEMP.append(tmp)
    return Path(tmp.name)


def _not_an_install() -> Path:
    """A directory that is NOT a usable SAIPEN install (the fixture knob)."""
    root = _temp() / "no-engine-here"
    root.mkdir(parents=True)
    return root


def _install(
    home: Path,
    *,
    activation: bool = True,
    engine: bool = True,
    version: str = "v8.0.0",
) -> Path:
    """A minimal flattened SAIPEN install (BOOT.md + VERSION + engine).

    Carries every marker the automatic-rebind proof (`_candidate_home_errors`)
    and the pointer liveness proof (`persisted_home_error`) require, so a
    fixture that POINTS at it binds while a dead pointer does not -- the two
    differ by exactly one variable.
    """
    (home / "tools").mkdir(parents=True, exist_ok=True)
    (home / "extensions" / "adapters").mkdir(parents=True, exist_ok=True)
    (home / "extensions" / "subs").mkdir(parents=True, exist_ok=True)
    (home / "BOOT.md").write_text("# saipen BOOT\n", encoding="utf-8")
    (home / "VERSION").write_text(version + "\n", encoding="utf-8")
    (home / "extensions" / "subs" / "PROTOCOL.md").write_text(
        "# sub protocol\n", encoding="utf-8"
    )
    if activation:
        (home / "ACTIVATION_BLOCK.md").write_text(
            "<!-- SAIPEN:BEGIN -->\nsaipen protocol\n<!-- SAIPEN:END -->\n",
            encoding="utf-8",
        )
    if engine:
        (home / "tools" / "saipen.py").write_text("# engine\n", encoding="utf-8")
    (home / "extensions" / "adapters" / "registry.json").write_text(
        json.dumps({"adapters": [{"id": "opencode"}, {"id": "freebuff"}]}),
        encoding="utf-8",
    )
    return home


def _launcher(home: Path, *, executable: bool) -> Path:
    """Install a launcher surface, executable or not, per THIS host's rules."""
    (home / "bin").mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        if executable:
            (home / "bin" / "saipen.cmd").write_text("@echo off\n", encoding="utf-8")
            return home / "bin" / "saipen.cmd"
        bare = home / "bin" / "saipen"
        bare.write_text("#!/bin/sh\n", encoding="utf-8")
        return bare
    posix = home / "bin" / "saipen"
    posix.write_text("#!/bin/sh\n", encoding="utf-8")
    os.chmod(posix, 0o755 if executable else 0o644)
    return posix


def _project(*, home: str | None) -> Path:
    """A managed project valid enough for canonical mutation planning."""
    root = _temp()
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    style_token = running_style_token()
    fields = [
        "---",
        "phase: BUILD",
        "task: T-1",
        "next_action: PHASE BUILD T-1",
        'blocker: ""',
        "transition_from: SCOUT",
        "saipen_version: 8",
        "schema_version: 3",
        "last_event: 2",
        f"style_contract: {style_token}",
        "agent: test-agent",
        "mode: full",
        'updated: "2026-09-20T00:00:00Z"',
    ]
    if home is not None:
        fields.append(f'saipen_home: "{home}"')
    fields.append("---")
    (saipen / "STATE.md").write_text("\n".join(fields) + "\n", encoding="utf-8")
    (saipen / "BOARD.md").write_text(
        "## DOING\n"
        "- [/] T-1 [P1] work | verify: the fixture change is demonstrated\n"
        "\n## TODO\n\n## DONE\n\n## BLOCKED\n",
        encoding="utf-8",
    )
    (saipen / "LOG.md").write_text(
        "- 20.09.26 00:00 [E-001] [T-1] [op: ticket-00000000000000000000000000000000] "
        "DEC: ticket added via SAIOPS\n"
        "- 20.09.26 00:00 [E-002] [parent: E-001] [T-none] DEC: base\n",
        encoding="utf-8",
    )
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text("code\n", encoding="utf-8")
    return root


DEAD_HOME = r"Z:\does\not\exist\saipen"


def _resolve(
    root: Path,
    env: dict,
    host: str | None = None,
    *,
    engine_root: Path | str | None = None,
) -> dict:
    return hb.resolve_bootstrap(
        root,
        host=host,
        env=env,
        honor_environment=False,
        engine_root=engine_root,
    )


def _admit(root: Path, target: str, action: str = "write") -> dict:
    return evaluate_admission(root, target_path=target, action=action, agent="test-agent")


def _state_fields(root: Path) -> dict:
    from saipen_engine.state import parse_frontmatter

    fields, error = parse_frontmatter(
        (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
    )
    assert error is None, error
    return fields


def _cli_env() -> dict:
    return {k: v for k, v in os.environ.items() if not k.startswith("SAIPEN_")}


def _run_cli(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(TOOLS / "saipen.py"), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=_cli_env(),
        timeout=300,
        cwd=str(REPO),
    )


class BootstrapResolverTests(unittest.TestCase):
    def test_01_runtime_on_path_is_bound(self):
        home = _install(_temp())
        root = _project(home=str(home))
        env = {"PATH": str(home)}
        result = _resolve(root, env, host="opencode")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], hb.BOUND)
        self.assertEqual(result["saipen_home"], str(home.resolve()))
        self.assertTrue(result["runtime_discovered"])

    def test_02_missing_from_path_recovered_via_state_pointer(self):
        home = _install(_temp())
        root = _project(home=str(home))
        # PATH deliberately empty: the executable is not resolvable. The
        # project's own SAIPEN-controlled STATE pointer is the recovery source.
        result = _resolve(root, {"PATH": ""}, host="opencode")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], hb.BOUND)
        self.assertEqual(result["saipen_home"], str(home.resolve()))
        sources = {row["source"] for row in result["attempted"] if row.get("ok")}
        self.assertIn("state-saipen-home", sources)
        self.assertFalse(result["binding"]["persisted_home_dead"])

    def test_03_isolated_env_external_home_via_carrier(self):
        home = _install(_temp())
        # STATE carries NO pointer: the install is reachable only through the
        # environment carrier a verified launch exports.
        root = _project(home=None)
        env = {"PATH": "", "SAIPEN_SKILL_ROOT": str(home)}
        result = _resolve(root, env, host="freebuff")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], hb.BOUND)
        self.assertEqual(result["saipen_home"], str(home.resolve()))

    def test_04_no_proven_candidate_is_unavailable(self):
        # A dead absolute pointer, no carrier, and an executing engine that is
        # NOT an install (filesystem fixture, no monkeypatch): the ONE verdict
        # is UNAVAILABLE naming the canonical-runtime boundary.
        root = _project(home=DEAD_HOME)
        env = {"PATH": ""}
        result = _resolve(root, env, host="freebuff", engine_root=_not_an_install())
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], hb.UNAVAILABLE)
        self.assertEqual(result["boundary"], hb.BOUNDARY_RUNTIME)
        self.assertTrue(result["remediation"])
        self.assertTrue(result["fingerprint"])
        self.assertFalse(result["runtime_discovered"])
        self.assertFalse(result["bridge"]["cross_boundary"])

    def test_04b_dead_foreign_home_with_proven_engine_names_convergence(self):
        # The measured contradiction: dead foreign-host pointer + a proven
        # repository runtime. Bootstrap is BOUND and hands the canonical
        # automatic convergence command -- it never demands a path back.
        root = _project(home=DEAD_HOME)
        result = _resolve(root, {"PATH": ""}, host="freebuff")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], hb.BOUND)
        self.assertEqual(result["saipen_home"], str(REPO.resolve()))
        self.assertTrue(result["binding"]["persisted_home_dead"])
        self.assertEqual(
            result["binding"]["convergence_command"], "saipen rebind-home --auto"
        )

    def test_05_missing_activation_names_the_activation_boundary(self):
        # Filesystem fixture again: the pointer resolves, the layout exists,
        # but the install carries no ACTIVATION_BLOCK.md and the executing
        # engine is not an install -- so the ONE boundary is activation.
        home = _install(_temp(), activation=False)
        root = _project(home=str(home))
        result = _resolve(root, {"PATH": ""}, host="freebuff", engine_root=_not_an_install())
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], hb.UNAVAILABLE)
        self.assertEqual(result["boundary"], hb.BOUNDARY_ACTIVATION)

    def test_06_unregistered_explicit_host_is_never_green(self):
        home = _install(_temp())
        root = _project(home=str(home))
        result = _resolve(root, {"PATH": str(home)}, host="not-a-host")
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], hb.HOST_UNSUPPORTED)
        self.assertNotEqual(result["code"], hb.BOUND)
        self.assertEqual(result["boundary"], hb.BOUNDARY_HOST)
        self.assertFalse(result["host_supported"])
        self.assertEqual(result["host_record"]["strength"], "ENFORCEMENT_GAP")
        # Discovery is diagnostic data and must NOT be read as admission.
        self.assertTrue(result["runtime_discovered"])
        self.assertEqual(result["saipen_home"], str(home.resolve()))
        self.assertTrue(result["remediation"])

    def test_07_launcher_transport_is_separate_from_discovery(self):
        # RED control: the launcher file exists but cannot execute on this
        # host. It is inventory, not a transport, and `bridge_required` is set.
        home = _install(_temp())
        _launcher(home, executable=False)
        root = _project(home=str(home))
        result = _resolve(root, {"PATH": ""}, host="freebuff")
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["launcher"]["discovered"], result["launcher"])
        self.assertFalse(result["launcher"]["executable"], result["launcher"])
        self.assertFalse(result["launcher"]["ok"], result["launcher"])
        self.assertEqual(result["launcher"]["transport"], "none")
        self.assertEqual(result["bridge"]["transport"], "none")
        self.assertTrue(result["bridge"]["required"], result["bridge"])
        self.assertFalse(result["bridge"]["cross_boundary"])
        # The binding itself is still green: the ENGINE is reachable.
        self.assertEqual(result["code"], hb.BOUND)

        # GREEN control: the same install with a launcher this host can run.
        home2 = _install(_temp())
        _launcher(home2, executable=True)
        root2 = _project(home=str(home2))
        result2 = _resolve(root2, {"PATH": ""}, host="freebuff")
        self.assertTrue(result2["launcher"]["ok"], result2["launcher"])
        self.assertEqual(result2["launcher"]["transport"], "direct_launcher")
        self.assertFalse(result2["bridge"]["required"])

    def test_08_registered_hosts_share_one_resolver_verdict(self):
        home = _install(_temp())
        root = _project(home=str(home))
        opencode = _resolve(root, {"PATH": str(home)}, host="opencode")
        freebuff = _resolve(root, {"PATH": str(home)}, host="freebuff")
        for key in ("code", "saipen_home", "protocol_dir", "engine", "boundary"):
            self.assertEqual(opencode[key], freebuff[key], key)


class CliContractTests(unittest.TestCase):
    """The CLI branch is the tested contract, not only the Python helper."""

    def test_10_unknown_host_exits_nonzero_and_is_not_bound(self):
        home = _install(_temp())
        root = _project(home=str(home))
        proc = _run_cli(
            [
                "host", "bootstrap",
                "--host", "not-a-host",
                "--project-root", str(root),
                "--json",
            ]
        )
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertFalse(payload["ok"], payload)
        self.assertEqual(payload["code"], hb.HOST_UNSUPPORTED)
        self.assertNotEqual(payload["code"], hb.BOUND)
        self.assertFalse(payload["host_supported"])

    def test_11_activation_works_for_an_installed_home_without_saipen_dir(self):
        # The install home has BOOT.md, engine and ACTIVATION_BLOCK.md and NO
        # `.saipen/` of its own -- exactly the flattened install the old
        # argument contract refused.
        home = _install(_temp())
        root = _project(home=str(home))
        proc = _run_cli(
            ["host", "activation", "--project-root", str(root), "--json"]
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["code"], "ACTIVATION_PRESENT")
        self.assertEqual(payload["saipen_home"], str(home.resolve()))
        self.assertTrue(Path(payload["activation"]).is_file())

    def test_12_activation_on_a_non_managed_dir_exits_nonzero(self):
        bare = _temp() / "not-a-project"
        bare.mkdir()
        proc = _run_cli(["host", "activation", "--project-root", str(bare), "--json"])
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertFalse(payload["ok"], payload)
        self.assertEqual(payload["code"], hb.NOT_SAIPEN)

    def test_13_rebind_home_auto_confirms_through_the_cli(self):
        home = _install(_temp())
        root = _project(home=str(home))
        proc = _run_cli(["rebind-home", "--auto", "--project-root", str(root), "--json"])
        # A LIVE pointer: nothing to converge, zero writes, idempotent answer.
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["code"], "HOME_ALREADY_BOUND")
        self.assertEqual(_state_fields(root)["saipen_home"], str(home.resolve()))


class AutoRebindTests(unittest.TestCase):
    def test_20_auto_rebind_converges_dead_home_and_is_idempotent(self):
        from saipen_engine.admission import protocol_snapshot
        from saipen_engine.operations import rebind_home_auto

        root = _project(home=DEAD_HOME)
        before = _state_fields(root)
        self.assertEqual(before["saipen_home"], DEAD_HOME)

        result = rebind_home_auto(root, "test-agent")
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "HOST_BINDING_CONVERGED")
        self.assertTrue(result.data.get("auto"))
        self.assertEqual(result.data.get("previous_home"), DEAD_HOME)

        after = _state_fields(root)
        self.assertEqual(after["saipen_home"], REPO.resolve().as_posix())
        # The dead pointer no longer brakes admission.
        self.assertNotEqual(protocol_snapshot(root, actor="test-agent")["block"], "HOME_REQUIRED")
        log_text = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertIn("automatically converged", log_text)
        self.assertIn("[op: rebind_home-", log_text)
        self.assertIn("previous pointer", log_text)

        # Idempotent: a second run is a zero-write ALREADY answer.
        again = rebind_home_auto(root, "test-agent")
        self.assertTrue(again.ok, again.to_dict())
        self.assertEqual(again.code, "HOME_ALREADY_BOUND")
        self.assertEqual(_state_fields(root)["saipen_home"], REPO.resolve().as_posix())

    def test_21_dead_home_with_no_proven_replacement_stays_refused(self):
        from saipen_engine.admission import protocol_snapshot
        from saipen_engine.operations import rebind_home_auto

        root = _project(home=DEAD_HOME)
        result = rebind_home_auto(
            root, "test-agent", engine_root=_not_an_install()
        )
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "HOME_REQUIRED")
        self.assertEqual(_state_fields(root)["saipen_home"], DEAD_HOME)

        snapshot = protocol_snapshot(root, actor="test-agent")
        self.assertEqual(snapshot["block"], "HOME_REQUIRED")
        self.assertEqual(snapshot["route"], "saipen rebind-home --auto")
        verdict = _admit(root, "src/app.py")
        self.assertFalse(verdict["admitted"], verdict)
        self.assertEqual(verdict["code"], "HOME_REQUIRED")
        self.assertEqual(
            verdict.get("canonical_next_command"), "saipen rebind-home --auto"
        )

    def test_22_cc_converges_a_dead_home_without_a_supplied_path(self):
        root = _project(home=DEAD_HOME)
        proc = _run_cli(["continue", "--project-root", str(root), "--json"])
        payload = json.loads(proc.stdout)
        self.assertNotEqual(payload.get("code"), "HOME_REQUIRED", payload)
        self.assertEqual(_state_fields(root)["saipen_home"], REPO.resolve().as_posix())

    def test_23_bootstrap_admission_contradiction_is_gone_end_to_end(self):
        # The exact success condition: BOUND (dead binding, proven runtime)
        # -> canonical automatic convergence -> BOUND (live binding) ->
        # admission of a product edit is no longer HOME_REQUIRED.
        root = _project(home=DEAD_HOME)
        first = _resolve(root, {"PATH": ""}, host="freebuff")
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["code"], hb.BOUND)
        self.assertTrue(first["binding"]["persisted_home_dead"])
        self.assertEqual(
            first["binding"]["convergence_command"], "saipen rebind-home --auto"
        )
        blocked = _admit(root, "src/app.py")
        self.assertEqual(blocked["code"], "HOME_REQUIRED", blocked)

        converged = _run_cli(
            ["rebind-home", "--auto", "--project-root", str(root), "--json"]
        )
        self.assertEqual(converged.returncode, 0, converged.stdout + converged.stderr)
        self.assertEqual(json.loads(converged.stdout)["code"], "HOST_BINDING_CONVERGED")

        second = _resolve(root, {"PATH": ""}, host="freebuff")
        self.assertEqual(second["code"], hb.BOUND)
        self.assertFalse(second["binding"]["persisted_home_dead"])
        verdict = _admit(root, "src/app.py")
        self.assertTrue(verdict["admitted"], verdict)
        self.assertEqual(verdict["code"], "ADMITTED")


# The two FreeBuff home-knowledge loader contracts the activation backstop
# must satisfy. Provenance: T-1426 live RED (2026-09-20) -- a fresh desktop
# session sent exactly `cc` and the model, with zero command semantics in its
# prompt, went on repository archaeology. Measured from the host's OWN code:
#   * freebuff CLI (freebuff.exe 0.0.115, manicode) reads the FIRST existing
#     of ~/.knowledge.md, ~/.AGENTS.md, ~/.claude.md;
#   * FreeBuff Desktop (installed orchestrator `loadUserKnowledgeFiles`)
#     scans the home for DOT-prefixed entries only and reads the FIRST of
#     .AGENTS.md, .CLAUDE.md -- ~/.knowledge.md is not a home surface for it.
FREEBUFF_CLI_HOME_SURFACES = (".knowledge.md", ".AGENTS.md", ".claude.md")
FREEBUFF_DESKTOP_HOME_SURFACES = (".AGENTS.md", ".CLAUDE.md")

#: The pinned pre-fix bootstrap/inject.ps1 blob (git object) whose FreeBuff
#: backstop chose ONE surface (`~/.knowledge.md`, fallback `~/.AGENTS.md`).
#: test_33 runs it as the red control for the desktop loader contract.
_PREFIX_INJECT_PS1_BLOB = "7fdcdacae6eecbd96a560dd1294305d397896435"


def _block_on_first_surface(home: Path, names: tuple[str, ...]) -> str | None:
    """The activation text a loader contract actually DELIVERS, or None.

    A loader reads the FIRST existing file of its list; a block in any other
    file is invisible to it. This is the prompt-assembly rule, not a file
    inventory -- the pre-fix host carried the block in ~/.knowledge.md, the
    old file-presence check passed, and the desktop prompt still got nothing
    (LIVE_FREEBUFF_CC_RED). Strict UTF-8 decode: mojibake is a failure.
    """
    for name in names:
        path = home / name
        if path.is_file():
            text = path.read_bytes().decode("utf-8")
            return text if "<!-- SAIPEN:BEGIN -->" in text else None
    return None


def _desktop_orchestrator() -> Path | None:
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        return None
    path = (
        Path(local)
        / "Programs"
        / "@codebufffreebuff-desktop"
        / "resources"
        / "orchestrator"
        / "orchestrator.js"
    )
    return path if path.is_file() else None


class ActivationDeliveryTests(unittest.TestCase):
    """The FreeBuff activation block must reach BOTH host loaders' prompts.

    FreeBuff ships two loaders with different home knowledge contracts, and
    the regression asserts the contract each one actually executes (the first
    existing file of its own list), not that some file exists on disk. The
    injector must leave the canonical block byte-correct on every
    registry-declared surface; the red control pins the exact pre-fix shape
    (~/.knowledge.md alone) that the desktop loader cannot see.
    """

    def _home(self) -> Path:
        home = _temp() / "home"
        (home / ".agents" / "skills").mkdir(parents=True)
        return home

    def _assert_block(self, home: Path) -> None:
        for label, surfaces in (
            ("CLI", FREEBUFF_CLI_HOME_SURFACES),
            ("desktop", FREEBUFF_DESKTOP_HOME_SURFACES),
        ):
            text = _block_on_first_surface(home, surfaces)
            self.assertIsNotNone(
                text, f"{label} loader contract delivers no activation block"
            )
            self.assertIn("<!-- SAIPEN:END -->", text)
            self.assertIn("cc", text)
            self.assertIn("сс", text)
            self.assertNotIn("{{SAIPEN_HOME}}", text)
            self.assertIn("BOOT.md", text)
        skill = home / ".agents" / "skills" / "saipen" / "SKILL.md"
        self.assertTrue(skill.is_file(), "~/.agents skill surface not installed")

    @unittest.skipUnless(
        __import__("shutil").which("powershell") or __import__("shutil").which("pwsh"),
        "PowerShell runtime unavailable",
    )
    def test_30_ps1_injector_leaves_an_exact_utf8_block(self):
        from test_runtime_bootstrap import POWERSHELL, _disposable_env

        home = self._home()
        proc = subprocess.run(
            [
                POWERSHELL, "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", str(REPO / "bootstrap" / "inject.ps1"),
                "-SkillHome", str(REPO / "saipen"),
                "-AdapterId", "freebuff",
            ],
            capture_output=True, text=True,
            env=_disposable_env(home), timeout=900,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self._assert_block(home)

    def test_31_knowledge_md_alone_is_invisible_to_the_desktop_loader(self):
        # The exact live pre-fix shape. The old file-presence check passed on
        # this home; the desktop prompt still carried no command semantics.
        home = self._home()
        (home / ".knowledge.md").write_text(
            "<!-- SAIPEN:BEGIN -->\n## saipen protocol\n"
            "`cc` and `сс` mean resume.\n<!-- SAIPEN:END -->\n",
            encoding="utf-8",
        )
        self.assertIsNotNone(
            _block_on_first_surface(home, FREEBUFF_CLI_HOME_SURFACES)
        )
        self.assertIsNone(
            _block_on_first_surface(home, FREEBUFF_DESKTOP_HOME_SURFACES),
            "desktop contract must not be satisfied by ~/.knowledge.md alone",
        )

    @unittest.skipUnless(
        __import__("shutil").which("node") and _desktop_orchestrator() is not None,
        "FreeBuff Desktop orchestrator or node not installed",
    )
    def test_32_installed_desktop_loader_reads_the_injected_block(self):
        # Executes the HOST's own loadUserKnowledgeFiles (extracted from the
        # installed orchestrator bundle) against hermetic fixture homes: the
        # layer that builds the first-turn prompt must deliver the block.
        import autoinject

        node = shutil.which("node")
        assert node is not None
        orchestrator = _desktop_orchestrator()
        assert orchestrator is not None
        block = autoinject.rendered_activation_block(REPO / "saipen")

        red = self._home()
        (red / ".knowledge.md").write_text(block + "\n", encoding="utf-8")
        green = self._home()
        (green / ".knowledge.md").write_text(block + "\n", encoding="utf-8")
        (green / ".AGENTS.md").write_text(
            "# existing user file\n\n" + block + "\n", encoding="utf-8"
        )

        script = _temp() / "desktop_knowledge_probe.js"
        script.write_text(
            """
const fs = require("fs");
const path13 = require("path");
const os6 = require("os");
const [orchestratorPath, homeDir] = process.argv.slice(2);
const source = fs.readFileSync(orchestratorPath, "utf8");
const names = source.match(/var KNOWLEDGE_FILE_NAMES = \\[[^\\]]*\\]/);
const start = source.indexOf("async function loadUserKnowledgeFiles(params) {");
const end = source.indexOf("function selectKnowledgeFilePaths(", start);
if (!names || start < 0 || end < 0) {
  console.error("EXTRACT_FAILED");
  process.exit(3);
}
const factory = new Function(
  "fs", "path13", "os6", "getErrorObject",
  names[0] +
    "\\nconst KNOWLEDGE_FILE_NAMES_LOWERCASE = " +
    "KNOWLEDGE_FILE_NAMES.map((n) => n.toLowerCase());\\n" +
    source.slice(start, end) +
    "\\nreturn loadUserKnowledgeFiles;"
);
const load = factory(fs, path13, os6, (error) => error);
const logger = { debug() {}, info() {}, warn() {}, error() {} };
load({ homeDir, fs: fs.promises, logger })
  .then((files) => { process.stdout.write(JSON.stringify(files)); })
  .catch((error) => { console.error(String((error && error.stack) || error)); process.exit(4); });
""",
            encoding="utf-8",
        )

        def probe(home: Path) -> dict:
            proc = subprocess.run(
                [node, str(script), str(orchestrator), str(home)],
                capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            return json.loads(proc.stdout)

        self.assertEqual(probe(red), {}, "desktop loader saw ~/.knowledge.md")
        delivered = probe(green)
        self.assertIn("~/.AGENTS.md", delivered)
        self.assertIn("<!-- SAIPEN:BEGIN -->", delivered["~/.AGENTS.md"])
        self.assertIn("cc", delivered["~/.AGENTS.md"])

    @unittest.skipUnless(
        __import__("shutil").which("powershell") or __import__("shutil").which("pwsh"),
        "PowerShell runtime unavailable",
    )
    def test_33_pre_fix_injector_is_a_red_control(self):
        # The pinned pre-fix installer left ~/.AGENTS.md untouched whenever
        # ~/.knowledge.md existed -- the exact live RED shape. The desktop
        # contract assertion must fail on the home that installer produces.
        from test_runtime_bootstrap import POWERSHELL, _disposable_env

        blob = subprocess.run(
            ["git", "-C", str(REPO), "cat-file", "blob", _PREFIX_INJECT_PS1_BLOB],
            capture_output=True, timeout=60,
        )
        if blob.returncode != 0:
            self.skipTest("pinned pre-fix injector blob not in this clone")
        script = _temp() / "inject_prefix.ps1"
        script.write_bytes(blob.stdout)
        home = self._home()
        run = subprocess.run(
            [
                POWERSHELL, "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", str(script),
                "-SkillHome", str(REPO / "saipen"),
                "-AdapterId", "freebuff",
            ],
            capture_output=True, text=True,
            env=_disposable_env(home), timeout=900,
        )
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIsNotNone(
            _block_on_first_surface(home, FREEBUFF_CLI_HOME_SURFACES)
        )
        self.assertIsNone(
            _block_on_first_surface(home, FREEBUFF_DESKTOP_HOME_SURFACES),
            "pre-fix injector must fail the desktop contract",
        )



class CCCommandRecognitionTests(unittest.TestCase):
    """The engine shortcut table knows `cc`; this is table evidence only.

    It does NOT prove host delivery -- that is `ActivationDeliveryTests` plus
    the live acceptance evidence. Recognition is table-driven, so it never
    depends on the `saipen` executable resolving from PATH.
    """

    def test_40_cc_resolves_to_continue(self):
        from saipen_engine.commands import load_shortcut_table, resolve_shortcut

        table = load_shortcut_table(REPO / "saipen")
        self.assertEqual(resolve_shortcut("cc", table=table), "cc")
        self.assertEqual(table["cc"], "saipen continue")

    def test_41_cyrillic_twin_resolves_identically(self):
        from saipen_engine.commands import load_shortcut_table, resolve_shortcut

        table = load_shortcut_table(REPO / "saipen")
        self.assertEqual(resolve_shortcut("\u0441\u0441", table=table), "cc")


class StaleHandoffTests(unittest.TestCase):
    def test_50_canonical_state_wins_over_stale_handoff_ticket(self):
        # A handoff naming an already-DONE ticket must not roll the project
        # back: the canonical BOARD is the authority.
        root = _project(home=None)
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n\n## TODO\n\n## DONE\n- [x] T-1 [P1] finished\n",
            encoding="utf-8",
        )
        from saipen_engine.board import parse_board

        board = parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        self.assertEqual(board["tickets"]["T-1"]["section"], "## DONE")

    def test_51_resolver_never_rewrites_board_bytes(self):
        home = _install(_temp())
        root = _project(home=str(home))
        before = (root / ".saipen" / "BOARD.md").read_bytes()
        _resolve(root, {"PATH": str(home)}, host="opencode")
        self.assertEqual((root / ".saipen" / "BOARD.md").read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
