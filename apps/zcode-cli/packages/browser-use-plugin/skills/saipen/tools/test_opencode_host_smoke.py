"""Real OpenCode end-to-end smoke (T-1317 P0-3 / P1-4).

Every other adapter control proves the guard's DECISIONS. This one proves the
CHAIN against the installed host runtime:

    host tool -> installed host hook -> native payload -> effect translation
              -> protocol admission -> actual host refusal

Steps:

1. the real injector places the plugin on the surface the target OpenCode
   runtime actually loads (and clears the legacy singular surface);
2. a NEW process after installation DISCOVERS exactly one global origin via
   `opencode debug config`, invokes its factory, and reports a loaded module
   fingerprint equal to the installed artifact;
3. the installed artifact initializes without exception and receives the
   native `input`/`output.args` shape;
4. ordinary reads stay usable, ordinary admitted writes proceed, and every
   protected/compound/unbound case is refused before the host tool runs.

Skips cleanly when the host runtime, a working bash or a python runtime is
absent: an audit machine without OpenCode is an environment fact, never a
product regression.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_adapter_parity import BASH  # noqa: E402
from test_guard_hostile_matrix import (  # noqa: E402
    active_project,
    fresh_project,
    project_with_doing_owner,
    recovery_debt_project,
)
from test_opencode_adapter import PYTHON, run_cases  # noqa: E402
from test_reconcile_valve import _t1318_project  # noqa: E402
from saipen_engine.evidence import EvidenceRun, HARD_BYTES_PER_TICKET  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


OPENCODE = shutil.which("opencode")
POWERSHELL = shutil.which("pwsh")
INSTALL_RELATIVE = Path(".config") / "opencode" / "plugins" / "saipen-guard.js"
LEGACY_RELATIVE = Path(".config") / "opencode" / "plugin" / "saipen-guard.js"
SHIPPED_ARTIFACT = REPO / "extensions" / "adapters" / "opencode" / "saipen-guard.js"
BUILD_ID_RE = re.compile(r'^const BUILD_ID = "([^"]+)";$', re.MULTILINE)


def shipped_build_id() -> str:
    """The generation id of the artifact on disk, never a hand-copied literal.

    P0-2: an evidence record that names a build id the artifact does not carry
    proves nothing about the code that actually ran, so the id is READ from the
    shipped bytes in every control that asserts on it.
    """
    match = BUILD_ID_RE.search(SHIPPED_ARTIFACT.read_text(encoding="utf-8"))
    assert match, "shipped adapter carries no parsable BUILD_ID"
    return match.group(1)


def smoke_evidence_target(
    build_id: str, *, evidence_root: Path | None = None, run_id: str | None = None,
) -> tuple[str, Path]:
    """Bind one host smoke to its artifact's ticket and a unique evidence run.

    Native smoke is reused by later tickets, so a literal historical ticket
    directory would silently replace the proof and timestamp of an earlier run.
    """
    if not re.fullmatch(r"T-\d+-[A-Za-z0-9._-]+", build_id):
        raise ValueError("invalid shipped OpenCode build id")
    ticket = build_id.split("-", 2)[0] + "-" + build_id.split("-", 2)[1]
    run_id = run_id or uuid.uuid4().hex
    if not re.fullmatch(r"[A-Za-z0-9_-]+", run_id):
        raise ValueError("invalid smoke evidence run id")
    root = evidence_root or REPO / ".saipen" / "evidence"
    return ticket, root / f"{ticket}-opencode-native-smoke" / f"{build_id}-{run_id}"


def new_smoke_evidence_run(
    build_id: str, *, evidence_root: Path | None = None, run_id: str | None = None,
) -> EvidenceRun:
    ticket, target = smoke_evidence_target(
        build_id, evidence_root=evidence_root, run_id=run_id,
    )
    return EvidenceRun("opencode-native-smoke", ticket, durable_dir=target)


class OpenCodeSmokeEvidenceOwnership(unittest.TestCase):
    def test_later_ticket_smoke_preserves_earlier_durable_proof(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            historical = root / "T-1317-opencode-native-smoke"
            historical.mkdir()
            old_proof = historical / "native-smoke-proof.json"
            old_manifest = historical / "MANIFEST-opencode-native-smoke-T-1317.json"
            old_proof.write_bytes(b'original T-1317 proof')
            old_manifest.write_bytes(b'original T-1317 manifest')
            before = (old_proof.read_bytes(), old_manifest.read_bytes())

            run = new_smoke_evidence_run(
                "T-1320-opencode-fleet-recovery-20260913.2",
                evidence_root=root, run_id="later-run",
            )
            target = run.durable_dir
            proof = run.temp_root / "native-smoke-proof.json"
            proof.write_bytes(b'later T-1320 proof')
            run.retain(proof)
            run.finalize(verdict="VERIFIED")

            self.assertEqual(
                before, (old_proof.read_bytes(), old_manifest.read_bytes()),
            )
            self.assertEqual(run.ticket, "T-1320")
            self.assertEqual(
                (target / "native-smoke-proof.json").read_bytes(),
                b'later T-1320 proof',
            )
            self.assertTrue(
                (target / "MANIFEST-opencode-native-smoke-T-1320.json").is_file(),
            )

    def test_same_generation_gets_a_new_run_directory(self):
        build = "T-1320-opencode-fleet-recovery-20260913.2"
        ticket_a, target_a = smoke_evidence_target(build)
        ticket_b, target_b = smoke_evidence_target(build)
        self.assertEqual((ticket_a, ticket_b), ("T-1320", "T-1320"))
        self.assertNotEqual(target_a, target_b)


def _native(path: Path) -> str:
    """The Windows-native spelling the host binary expects, POSIX elsewhere."""
    return str(path)


@unittest.skipUnless(OPENCODE, "opencode runtime unavailable")
@unittest.skipUnless(BASH, "working bash runtime unavailable")
@unittest.skipUnless(PYTHON, "no python runtime for the guard round trip")
class OpenCodeHostSmoke(unittest.TestCase):
    #: P0-2 active-generation record, populated by test_2 and retained as
    #: durable evidence even when a later method fails.
    _generation = None

    @classmethod
    def setUpClass(cls):
        cls.evidence_run = new_smoke_evidence_run(shipped_build_id())
        cls._passed = set()
        cls._case_outcomes = []
        cls.install_rc = None
        try:
            cls.home, cls.cache, cls.workdir = cls.evidence_run.register_ephemeral(
                "home", "cache", "workdir"
            )
            cls.home.mkdir()
            cls.cache.mkdir()
            cls.workdir.mkdir()
            (cls.home / ".config" / "opencode").mkdir(parents=True)
            # The runtime also discovers the legacy singular surface.
            legacy = cls.home / LEGACY_RELATIVE
            legacy.parent.mkdir(parents=True)
            legacy.write_text("// stale singular copy\n", encoding="utf-8")
            proc = subprocess.run(
                [BASH, str(REPO / "bootstrap" / "inject.sh")],
                capture_output=True,
                text=True,
                env=cls._host_env(),
                timeout=600,
            )
            cls.install_stdout = proc.stdout + proc.stderr
            cls.install_rc = proc.returncode
            cls.install_completed_ms = int(time.time() * 1000)
            cls.installed = cls.home / INSTALL_RELATIVE
            cls.closeup = active_project()
            cls.debt = recovery_debt_project()
            cls.owned = project_with_doing_owner("codex", agent="codex")
            # A real SAIPEN project directory the fresh host process can start
            # in, so the generation proof carries a resolved root/lineage/
            # provenance and not just a module fingerprint.
            cls.generation_project = fresh_project()
        except BaseException as exc:
            cls._finalize_evidence("FAILED", setup_error=type(exc).__name__)
            raise

    @classmethod
    def _finalize_evidence(cls, verdict: str, **details):
        proof = cls.evidence_run.temp_root / "native-smoke-proof.json"
        proof.write_text(json.dumps({
            "passed_methods": sorted(cls._passed),
            "install_rc": cls.install_rc,
            "generation": cls._generation,
            "case_outcomes": cls._case_outcomes,
            **details,
        }, indent=1), encoding="utf-8")
        cls.evidence_run.retain(proof)
        manifest = cls.evidence_run.finalize(verdict=verdict)
        assert not cls.evidence_run.temp_root.exists()
        assert manifest["retained_bytes"] < HARD_BYTES_PER_TICKET
        assert (cls.evidence_run.durable_dir / "native-smoke-proof.json").is_file()

    @classmethod
    def tearDownClass(cls):
        cls._finalize_evidence("VERIFIED" if len(cls._passed) == 5 else "UNRESOLVED")

    @classmethod
    def _host_env(cls, **overrides):
        """Environment that makes the host binary and node see the fake home.

        The ambient environment is preserved on purpose: on Windows a child
        process launched without PATH/SYSTEMROOT aborts inside the host's own
        runtime, which would be an environment bug masquerading as a smoke
        failure. Only the home binding is redirected.
        """
        env = {
            **os.environ,
            "HOME": str(cls.home),
            "USERPROFILE": _native(cls.home),
            "XDG_CACHE_HOME": str(cls.cache),
            "npm_config_cache": str(cls.cache / "npm"),
            "BUN_INSTALL_CACHE_DIR": str(cls.cache / "bun"),
        }
        # Measured host fact: OpenCode takes the session directory from the
        # shell's PWD when it is set, NOT from the child's working directory.
        env.pop("PWD", None)
        env.pop("OLDPWD", None)
        env.update(overrides)
        return env

    def _debug_config(self, probe: Path | None = None, cwd: Path | None = None) -> dict:
        env = self._host_env()
        if probe is not None:
            env["SAIPEN_GUARD_STARTUP_PROBE"] = str(probe)
        else:
            env.pop("SAIPEN_GUARD_STARTUP_PROBE", None)
        proc = subprocess.run(
            [OPENCODE, "debug", "config"],
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(cwd or self.home),
            env=env,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return json.loads(proc.stdout.lstrip("\ufeff"))

    def test_1_the_injector_installs_one_hook_on_the_loaded_surface(self):
        self.assertEqual(self.install_rc, 0, self.install_stdout)
        self.assertTrue(self.installed.is_file(), self.install_stdout)
        self.assertEqual(self.installed.read_bytes(), SHIPPED_ARTIFACT.read_bytes())
        digest = hashlib.sha256(self.installed.read_bytes()).hexdigest()
        self.assertIn(f"sha256={digest}", self.install_stdout)
        self.assertIn("already-running OpenCode processes require restart", self.install_stdout)
        self.assertFalse(
            (self.home / LEGACY_RELATIVE).exists(),
            "legacy singular plugin/ copy would load the same hook twice",
        )
        self._passed.add(1)

    def test_2_the_runtime_discovers_and_loads_the_installed_artifact(self):
        """P0-2: the ACTIVE GENERATION, identified by its byte identity.

        Behavioral outcomes alone cannot tell a repaired generation from the
        one it replaced, so this control binds the running code to its bytes:
        source artifact = installed artifact = loaded module, same BUILD_ID.
        """
        probe = self.workdir / "startup-probe.jsonl"
        if probe.exists():
            probe.unlink()
        started_ms = int(time.time() * 1000)
        config = self._debug_config(probe, cwd=self.generation_project)
        origins = [str(entry.get("spec") or "") for entry in config.get("plugin_origins") or []]
        ours = [origin for origin in origins if "saipen-guard.js" in origin.lower()]
        self.assertEqual(len(ours), 1, origins)
        self.assertIn(str(self.installed).replace("\\", "/"), ours[0], ours)
        # It must come from that home's GLOBAL config directory, not from the
        # project tree: the install surface is the global local plugin dir.
        entry = next(
            item
            for item in config.get("plugin_origins") or []
            if str(item.get("spec") or "").endswith("saipen-guard.js")
        )
        source = str(entry.get("source") or "").replace("\\", "/").lower()
        self.assertIn(str(self.home).replace("\\", "/").lower(), source, source)
        self.assertIn(".config/opencode", source, source)
        # Discovery is not load: the factory must actually have been invoked.
        self.assertTrue(probe.is_file(), "the host did not instantiate the installed plugin")
        diagnostics = [json.loads(line) for line in probe.read_text(encoding="utf-8").splitlines()]
        self.assertTrue(diagnostics)
        diagnostic = diagnostics[-1]

        source_sha = hashlib.sha256(SHIPPED_ARTIFACT.read_bytes()).hexdigest()
        installed_sha = hashlib.sha256(self.installed.read_bytes()).hexdigest()
        loaded_sha = diagnostic["module_sha256"]
        build_id = shipped_build_id()
        # THE INVARIANT (T-1317 P0-2): a stale installed copy, a stale loaded
        # module or a mislabeled BUILD_ID each break this equality, so no
        # behavioral smoke can be carried forward as proof of another
        # generation.
        self.assertEqual(source_sha, installed_sha, "installed artifact is not the shipped source")
        self.assertEqual(installed_sha, loaded_sha, "loaded module is not the installed artifact")

        for item in diagnostics:
            self.assertEqual(item["module_sha256"], installed_sha, item)
            self.assertEqual(item["build_id"], build_id, item)
            self.assertEqual(Path(item["module_path"]).resolve(), self.installed.resolve())
            self.assertEqual(Path(item["skill_root"]).resolve(),
                             (self.home / ".config" / "opencode" / "skills" / "saipen").resolve())
            self.assertEqual(Path(item["guard_runtime_path"]).resolve(),
                             (self.home / ".config" / "opencode" / "skills" / "saipen" /
                              "tools" / "saipen.py").resolve())
            self.assertGreaterEqual(item["factory_started_ms"], self.install_completed_ms)
            self.assertGreaterEqual(item["factory_started_ms"], started_ms)
            self.assertIsInstance(item["pid"], int)

        # The factory ran for a REAL project start, so the generation record
        # carries the canonical resolution, not only a module fingerprint.
        self.assertEqual(diagnostic["binding_code"], "ADMITTED", diagnostic)
        self.assertEqual(
            Path(diagnostic["project_root"]).resolve(),
            self.generation_project.resolve(),
            diagnostic,
        )
        self.assertTrue(str(diagnostic["project_lineage"] or "").startswith("lineage-"),
                        diagnostic)
        self.assertIn(diagnostic["root_resolution_provenance"],
                      {"git-worktree", "git-common", "ancestor", "host-session", "explicit"},
                      diagnostic)
        # OpenCode supplied the project through one of its context carriers and
        # the adapter resolved the binding from it, even though the factory
        # worktree placeholder ("/") names no project at all.
        supplied = [Path(item).resolve() for item in diagnostic["host_candidates"]]
        self.assertIn(self.generation_project.resolve(), supplied, diagnostic)
        self.assertEqual(Path(diagnostic["resolved_from"]).resolve(),
                         self.generation_project.resolve(), diagnostic)
        self.assertNotEqual(Path(diagnostic["context_worktree"]).resolve(),
                            self.generation_project.resolve(),
                            "this control exists because worktree is a placeholder")

        type(self)._generation = {
            "build_id": build_id,
            "source_artifact_path": str(SHIPPED_ARTIFACT),
            "source_sha256": source_sha,
            "installed_artifact_path": str(self.installed),
            "installed_sha256": installed_sha,
            "loaded_module_path": diagnostic["module_path"],
            "loaded_module_sha256": loaded_sha,
            "sha_triplet_equal": (source_sha == installed_sha == loaded_sha),
            "factory_count": len(diagnostics),
            "opencode_pid": diagnostic["pid"],
            "factory_started_ms": diagnostic["factory_started_ms"],
            "install_completed_ms": self.install_completed_ms,
            "context_directory": diagnostic["context_directory"],
            "context_worktree": diagnostic["context_worktree"],
            "resolved_project_root": diagnostic["project_root"],
            "resolved_project_lineage": diagnostic["project_lineage"],
            "resolution_provenance": diagnostic["root_resolution_provenance"],
            "binding_code": diagnostic["binding_code"],
            "fresh_process_after_install": diagnostic["factory_started_ms"]
            >= self.install_completed_ms,
        }
        self._passed.add(2)

    def test_3_the_installed_artifact_carries_the_whole_chain(self):
        cases = [
            {
                "id": "read",
                "project": str(self.closeup),
                "env": {"SAIPEN_AGENT": "test-agent"},
                "input": {"tool": "read", "sessionID": "ses_smoke"},
                "output": {"args": {"filePath": ".saipen/STATE.md"}},
            },
            {
                "id": "admitted_write",
                "project": str(self.closeup),
                "env": {"SAIPEN_AGENT": "test-agent"},
                "input": {"tool": "write", "sessionID": "ses_smoke"},
                "output": {"args": {"filePath": "src/app.py", "content": "print('ok')\n"}},
            },
            {
                "id": "question",
                "project": str(self.closeup),
                "env": {"SAIPEN_AGENT": None},
                "input": {"tool": "question", "sessionID": "ses_smoke"},
                "output": {"args": {"questions": []}},
            },
            *[
                {
                    "id": case_id,
                    "project": str(self.closeup),
                    "env": {"SAIPEN_AGENT": None},
                    "input": {"tool": "bash", "sessionID": "ses_smoke"},
                    "output": {"args": {"command": command}},
                }
                for case_id, command in (
                    ("ordinary_shell", "python --version"),
                    ("source_shell", "python -m compileall src"),
                    (
                        "protected_shell_state",
                        "python -c \"from pathlib import Path; "
                        "Path('.saipen/STATE.md').write_text('boom')\"",
                    ),
                    ("protected_shell_board", "rm -f .saipen/BOARD.md"),
                    ("protected_shell_windows", r"del .saipen\STATE.md"),
                    ("protected_shell_traversal", "rm -f src/../.saipen/STATE.md"),
                )
            ],
            {
                "id": "protected_write",
                "project": str(self.closeup),
                "env": {"SAIPEN_AGENT": "test-agent"},
                "input": {"tool": "write", "sessionID": "ses_smoke"},
                "output": {"args": {"filePath": ".saipen/STATE.md", "content": "owned\n"}},
            },
            {
                "id": "unknown_tool",
                "project": str(self.closeup),
                "env": {"SAIPEN_AGENT": "test-agent"},
                "input": {"tool": "mystery_tool", "sessionID": "ses_smoke"},
                "output": {"args": {}},
            },
            {
                "id": "board_patch",
                "project": str(self.closeup),
                "env": {"SAIPEN_AGENT": "test-agent"},
                "input": {"tool": "apply_patch", "sessionID": "ses_smoke"},
                "output": {
                    "args": {
                        "patchText": (
                            "*** Begin Patch\n"
                            "*** Update File: src/app.py\n"
                            "@@\n-code\n+hacked\n"
                            "*** Update File: .saipen/BOARD.md\n"
                            "@@\n-a\n+b\n"
                            "*** End Patch\n"
                        )
                    }
                },
            },
            {
                "id": "compound_recover",
                "project": str(self.debt),
                "env": {"SAIPEN_AGENT": "test-agent"},
                "input": {"tool": "bash", "sessionID": "ses_smoke"},
                "output": {"args": {"command": "saipen recover && rm -f .saipen/STATE.md"}},
            },
            {
                "id": "exact_recover",
                "project": str(self.debt),
                "env": {"SAIPEN_AGENT": "test-agent"},
                "input": {"tool": "bash", "sessionID": "ses_smoke"},
                "output": {"args": {"command": "saipen recover"}},
            },
            {
                "id": "bare_canonical_actor",
                "project": str(self.owned),
                "env": {"SAIPEN_AGENT": None},
                "input": {"tool": "write", "sessionID": "ses_smoke"},
                "output": {"args": {"filePath": "src/app.py", "content": "x\n"}},
            },
            {
                "id": "wrong_actor",
                "project": str(self.owned),
                "env": {"SAIPEN_AGENT": "test-agent"},
                "input": {"tool": "write", "sessionID": "ses_smoke"},
                "output": {"args": {"filePath": "src/app.py", "content": "x\n"}},
            },
            {
                "id": "explicit_owner",
                "project": str(self.owned),
                "env": {"SAIPEN_AGENT": "codex"},
                "input": {"tool": "write", "sessionID": "ses_smoke"},
                "output": {"args": {"filePath": "src/app.py", "content": "x\n"}},
            },
        ]
        for case in cases:
            case["env"] = {**case["env"], "SAIPEN_PYTHON": PYTHON}
        results = run_cases(
            self.installed,
            cases,
            self.workdir / "chain",
            extra_env=self._host_env(SAIPEN_SKILL_ROOT=""),
        )
        by_id = {item["id"]: item for item in results}
        type(self)._case_outcomes = [
            {"id": item["id"], "outcome": item["outcome"], "message": item["message"][:180]}
            for item in results
        ]
        self.assertEqual(len(results), len(cases))

        for record in results:
            # 3. plugin initializes without exception and exposes the hook.
            self.assertIn("tool.execute.before", record["hooks"], record)
            self.assertNotEqual(record["outcome"], "no_hook", record)

        # 4. ordinary read remains usable and an admitted write proceeds.
        self.assertEqual(by_id["read"]["outcome"], "allowed", by_id["read"])
        self.assertEqual(by_id["admitted_write"]["outcome"], "allowed", by_id["admitted_write"])
        for case_id in ("question", "ordinary_shell", "source_shell"):
            self.assertEqual(by_id[case_id]["outcome"], "allowed", by_id[case_id])
        for case_id in (
            "protected_shell_state", "protected_shell_board",
            "protected_shell_windows", "protected_shell_traversal",
        ):
            self.assertIn("PROTECTED_CANONICAL_NAMESPACE", by_id[case_id]["message"])
        # 6. direct write to protected canonical state is blocked.
        self.assertIn("PROTECTED_CANONICAL_NAMESPACE", by_id["protected_write"]["message"])
        # 7. a patch touching .saipen/BOARD.md is blocked as one host tool.
        self.assertIn("PROTECTED_CANONICAL_NAMESPACE", by_id["board_patch"]["message"])
        # 8. compound `saipen recover && <mutation>` is blocked.
        self.assertIn("PROTECTED_CANONICAL_NAMESPACE", by_id["compound_recover"]["message"])
        # 9. exact `saipen recover` stays allowed while recovery debt exists.
        self.assertEqual(by_id["exact_recover"]["outcome"], "allowed", by_id["exact_recover"])
        # 10. bare continuation inherits canonical ownership; a wrong explicit
        # actor remains refused and the correct explicit actor remains usable.
        self.assertEqual(
            by_id["bare_canonical_actor"]["outcome"],
            "allowed",
            by_id["bare_canonical_actor"],
        )
        self.assertIn("OWNERSHIP_CONFLICT", by_id["wrong_actor"]["message"])
        self.assertEqual(
            by_id["explicit_owner"]["outcome"], "allowed", by_id["explicit_owner"]
        )

        # T-1317 CLOSE-3 step 3: the multi-file patch carrying an ordinary
        # file AND .saipen/BOARD.md is prevented before ANY of it executes.
        self.assertIn("PROTECTED_CANONICAL_NAMESPACE", by_id["board_patch"]["message"])
        # CLOSE-3 (T-1317 Target A): an unknown consequential tool is refused
        # by the real installed hook, never admitted as a targetless unknown.
        self.assertIn("TARGET_UNRESOLVED", by_id["unknown_tool"]["message"])
        self.assertEqual(by_id["unknown_tool"]["outcome"], "blocked", by_id["unknown_tool"])
        self._passed.add(3)

    def test_4_chain_bytes_prove_prevention_and_a_bypass_changes_them(self):
        """CLOSE-3 red control: refusal is observationally meaningful.

        The refused effects must NOT have modified the protected bytes; the
        same writes applied WITHOUT the guard (bypass/misbinding control)
        must change exactly those bytes, proving the smoke would detect an
        ineffective guard.
        """
        state = self.closeup / ".saipen" / "STATE.md"
        board = self.closeup / ".saipen" / "BOARD.md"
        app = self.closeup / "src" / "app.py"
        state_before = state.read_bytes()
        board_before = board.read_bytes()
        app_before = app.read_bytes()

        # Direct evidence runs (test_3) refused the protected write, the
        # multi-file patch, the compound recovery and the unknown tool.
        # Re-drive only the exact recover (allowed) and re-check bytes: the
        # allowed case may touch nothing protected either.
        cases = [
            {
                "id": "allowed_recover_rerun",
                "project": str(self.debt),
                "env": {"SAIPEN_AGENT": "test-agent", "SAIPEN_PYTHON": PYTHON},
                "input": {"tool": "bash", "sessionID": "ses_red"},
                "output": {"args": {"command": "saipen recover"}},
            }
        ]
        results = run_cases(
            self.installed,
            cases,
            self.workdir / "red-control-rerun",
            extra_env=self._host_env(SAIPEN_SKILL_ROOT=""),
        )
        self.assertEqual(results[0]["outcome"], "allowed", results[0])

        self.assertEqual(state.read_bytes(), state_before, "protected STATE.md changed")
        self.assertEqual(board.read_bytes(), board_before, "protected BOARD.md changed")
        self.assertEqual(app.read_bytes(), app_before, "ordinary src/app.py changed")

        # Bypass red control: with the guard removed from the path (direct
        # writes, no hook), the same protected and ordinary effects DO land.
        # This proves the bytes are writable at all and that the earlier
        # refusals -- not filesystem permissions -- kept them unchanged.
        state.write_bytes(state_before + b"\n<!-- BYPASS-PROOF -->\n")
        board.write_bytes(board_before + b"\n<!-- BYPASS-PROOF -->\n")
        try:
            self.assertNotEqual(state.read_bytes(), state_before)
            self.assertNotEqual(board.read_bytes(), board_before)
        finally:
            state.write_bytes(state_before)
            board.write_bytes(board_before)
            app.write_bytes(app_before)
        self.assertEqual(state.read_bytes(), state_before)
        self.assertEqual(board.read_bytes(), board_before)
        self._passed.add(4)

    def test_5_fresh_installed_fleet_recovers_and_refuses_old_payload(self):
        donor = _t1318_project()
        root = self.workdir / "fleet-product"
        shutil.copytree(donor, root)
        shutil.rmtree(donor)
        lineage = new_project_lineage()
        (root / ".saipen" / "IDENTITY.md").write_text(
            identity_file_content(lineage), encoding="utf-8"
        )
        product = root / "product.txt"
        product.write_text("original", encoding="utf-8")
        base = {
            "project": str(root),
            "env": {"SAIPEN_AGENT": "tester", "SAIPEN_PYTHON": PYTHON},
            "input": {"tool": "write", "sessionID": "ses_fleet_smoke"},
            "output": {"args": {"filePath": str(product), "content": "old payload"}},
        }
        results = run_cases(
            self.installed,
            [
                {**base, "id": "fleet_old", "simulate_effect":
                 {"path": str(product), "contents": "OLD PAYLOAD"}},
                {**base, "id": "fleet_fresh", "simulate_effect":
                 {"path": str(product), "contents": "FRESH PAYLOAD"}},
            ],
            self.workdir / "fleet-chain",
            extra_env=self._host_env(SAIPEN_SKILL_ROOT=""),
        )
        self.assertEqual(results[0]["outcome"], "blocked", results)
        self.assertIn("RECOVERED_REISSUE_REQUIRED", results[0]["message"])
        self.assertEqual(results[1]["outcome"], "allowed", results)
        self.assertEqual(product.read_text(encoding="utf-8"), "FRESH PAYLOAD")
        state = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        self.assertIn("phase: BUILD", state)
        self.assertIn("task: T-001", state)
        self.assertIn("agent: tester", state)
        self.assertIn("T-001", (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        type(self)._case_outcomes.extend(
            {"id": item["id"], "outcome": item["outcome"], "message": item["message"][:180]}
            for item in results
        )
        self._passed.add(5)


@unittest.skipUnless(POWERSHELL, "PowerShell 7 unavailable")
class OpenCodeWindowsInjector(unittest.TestCase):
    def test_powershell_injector_overwrites_and_verifies_one_canonical_hook(self):
        with tempfile.TemporaryDirectory(prefix="saipen-pwsh-inject-") as temp:
            home = Path(temp) / "home"
            (home / ".config" / "opencode").mkdir(parents=True)
            canonical = home / INSTALL_RELATIVE
            legacy = home / LEGACY_RELATIVE
            canonical.parent.mkdir(parents=True, exist_ok=True)
            legacy.parent.mkdir(parents=True, exist_ok=True)
            canonical.write_text("// old plural generation\n", encoding="utf-8")
            legacy.write_text("// old singular generation\n", encoding="utf-8")
            proc = subprocess.run(
                [POWERSHELL, "-NoProfile", "-File", str(REPO / "bootstrap" / "inject.ps1")],
                capture_output=True, text=True, timeout=600,
                env={**os.environ, "USERPROFILE": str(home), "HOME": str(home)},
            )
            output = proc.stdout + proc.stderr
            self.assertEqual(proc.returncode, 0, output)
            digest = hashlib.sha256(SHIPPED_ARTIFACT.read_bytes()).hexdigest()
            self.assertEqual(hashlib.sha256(canonical.read_bytes()).hexdigest(), digest)
            self.assertFalse(legacy.exists())
            self.assertIn(f"sha256={digest}", output)
            self.assertIn("already-running OpenCode processes require restart", output)


@unittest.skipUnless(OPENCODE, "opencode runtime unavailable")
class OpenCodeRealInstalledGeneration(unittest.TestCase):
    def test_fresh_process_loads_the_installed_generation_from_one_origin(self):
        home = Path(os.environ["USERPROFILE"])
        installed = home / INSTALL_RELATIVE
        legacy = home / LEGACY_RELATIVE
        self.assertTrue(installed.is_file(), installed)
        self.assertFalse(legacy.exists(), legacy)
        digest = hashlib.sha256(SHIPPED_ARTIFACT.read_bytes()).hexdigest()
        self.assertEqual(hashlib.sha256(installed.read_bytes()).hexdigest(), digest)
        installed_mtime_ms = installed.stat().st_mtime_ns // 1_000_000
        with tempfile.TemporaryDirectory(prefix="saipen-real-opencode-gen-") as temp:
            probe = Path(temp) / "factory.jsonl"
            started_ms = int(time.time() * 1000)
            proc = subprocess.run(
                [OPENCODE, "debug", "config"], cwd=temp,
                env={**os.environ, "SAIPEN_GUARD_STARTUP_PROBE": str(probe)},
                capture_output=True, text=True, timeout=300,
            )
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            config = json.loads(proc.stdout.lstrip("\ufeff"))
            origins = [str(item.get("spec") or "") for item in
                       config.get("plugin_origins") or []]
            ours = [origin for origin in origins if "saipen-guard.js" in origin.lower()]
            self.assertEqual(len(ours), 1, origins)
            self.assertIn(str(installed).replace("\\", "/"), ours[0])
            self.assertTrue(probe.is_file())
            diagnostics = [json.loads(line) for line in
                           probe.read_text(encoding="utf-8").splitlines()]
            self.assertTrue(diagnostics)
            for item in diagnostics:
                self.assertEqual(item["module_sha256"], digest)
                self.assertEqual(Path(item["module_path"]).resolve(), installed.resolve())
                self.assertEqual(item["build_id"], shipped_build_id())
                self.assertGreaterEqual(item["factory_started_ms"], started_ms)
                self.assertGreaterEqual(item["factory_started_ms"], installed_mtime_ms)
                self.assertEqual(Path(item["skill_root"]).resolve(),
                                 (home / ".config" / "opencode" / "skills" / "saipen").resolve())
                self.assertEqual(Path(item["guard_runtime_path"]).resolve(),
                                 (home / ".config" / "opencode" / "skills" / "saipen" /
                                  "tools" / "saipen.py").resolve())

    def test_installed_fastpaths_and_bash_use_the_current_generation(self):
        home = Path(os.environ["USERPROFILE"])
        installed = home / INSTALL_RELATIVE
        skill = home / ".config" / "opencode" / "skills" / "saipen"
        project = active_project()
        cases = [
            {
                "id": name,
                "project": str(project),
                "env": {
                    "SAIPEN_SKILL_ROOT": str(skill),
                    "SAIPEN_PYTHON": "missing-python-for-fastpath-proof",
                    "PATH": "",
                },
                "input": {"tool": name},
                "output": {"args": args},
            }
            for name, args in (
                ("question", {"questions": []}),
                ("skill", {"name": "saipen"}),
                ("read", {"filePath": ".saipen/STATE.md"}),
            )
        ]
        cases.extend([
            {
                "id": "ordinary_bash",
                "project": str(project),
                "env": {"SAIPEN_SKILL_ROOT": str(skill), "SAIPEN_PYTHON": sys.executable},
                "input": {"tool": "bash"},
                "output": {"args": {"command": "python --version"}},
            },
            {
                "id": "protected_bash",
                "project": str(project),
                "env": {"SAIPEN_SKILL_ROOT": str(skill), "SAIPEN_PYTHON": sys.executable},
                "input": {"tool": "bash"},
                "output": {"args": {"command": "rm -f .saipen/STATE.md"}},
            },
        ])
        with tempfile.TemporaryDirectory(prefix="saipen-real-opencode-chain-") as temp:
            results = run_cases(installed, cases, Path(temp))
        by_id = {item["id"]: item for item in results}
        for name in ("question", "skill", "read", "ordinary_bash"):
            self.assertEqual(by_id[name]["outcome"], "allowed", by_id[name])
        self.assertEqual(by_id["protected_bash"]["outcome"], "blocked")
        self.assertIn("PROTECTED_CANONICAL_NAMESPACE", by_id["protected_bash"]["message"])


if __name__ == "__main__":
    unittest.main()
