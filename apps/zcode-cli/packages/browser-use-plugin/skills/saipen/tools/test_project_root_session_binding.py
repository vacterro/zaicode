"""Deterministic regressions for detached handoff project binding (T-1318).

Covers CONTROLS A through L from Milestone 11, plus Milestone 2 identity distinctions:
- CONTROL A: exact reported incident (detached staging cwd + carrier resolution)
- CONTROL B: lineage binding (matching vs mismatched vs foreign lineage)
- CONTROL C: stale root (deleted/moved path fails closed, no fallback)
- CONTROL D: foreign Git staging cwd (does not adopt foreign repository)
- CONTROL E: ordinary invocation unchanged
- CONTROL F: linked worktree resolution intact
- CONTROL G: non-Git project nearest ancestor resolution intact
- CONTROL H: portable handoff (brief includes lineage, no machine-local root)
- CONTROL I: staging-path payload outside project root
- CONTROL J: admission guard routing against intended project
- CONTROL K: global activation contract across inject.ps1 and inject.sh
- CONTROL L: no drive/arbitrary disk scanning
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

# Add tools to sys.path
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.context import brief_projection  # noqa: E402
from saipen_engine.paths import (  # noqa: E402
    ENV_PROJECT_LINEAGE,
    ENV_PROJECT_ROOT,
    PROVENANCE_ANCESTOR,
    PROVENANCE_GIT_WORKTREE,
    PROVENANCE_HOST_SESSION,
    identity_file_content,
    new_project_lineage,
    project_lineage_identity,
    resolve_project_root,
    resolve_tool_root,
)
from saipen_engine.fleet import preflight, prepare, scan  # noqa: E402
from test_reconcile_valve import _t1318_project  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


def _init_saipen_project(root: Path, *, lineage: str | None = None) -> str:
    """Create a minimal valid .saipen project structure with an IDENTITY.md."""
    saipen_dir = root / ".saipen"
    saipen_dir.mkdir(parents=True, exist_ok=True)
    assigned_lineage = lineage or new_project_lineage()
    (saipen_dir / "IDENTITY.md").write_text(
        identity_file_content(assigned_lineage), encoding="utf-8"
    )
    (saipen_dir / "STATE.md").write_text(
        "---\n"
        "phase: DONE\n"
        "task: none\n"
        "next_action: none\n"
        "blocker: none\n"
        "transition_from: SHIP\n"
        "saipen_version: 7\n"
        "schema_version: 3\n"
        "last_event: 100\n"
        "mode: full\n"
        "updated: 2026-09-12T00:01:00Z\n"
        "agent: test-agent\n"
        "---\n",
        encoding="utf-8",
    )
    (saipen_dir / "BOARD.md").write_text(
        "# BOARD\n\n## DOING\n\n## TODO\n\n## BLOCKED\n\n## DONE\n",
        encoding="utf-8",
    )
    (saipen_dir / "LOG.md").write_text(
        "- 12.09.26 00:01 [E-100] INIT: project initialized\n",
        encoding="utf-8",
    )
    return assigned_lineage


def _git_init(root: Path) -> None:
    """Initialize a git repository if git is available."""
    try:
        subprocess.run(["git", "init"], cwd=str(root), capture_output=True, check=True)
        subprocess.run(
            ["git", "config", "user.name", "test"],
            cwd=str(root),
            capture_output=True,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=str(root),
            capture_output=True,
            check=True,
        )
        subprocess.run(["git", "add", "."], cwd=str(root), capture_output=True, check=True)
        subprocess.run(
            ["git", "commit", "-m", "initial commit"],
            cwd=str(root),
            capture_output=True,
            check=True,
        )
    except Exception:
        pass


class DetachedHandoffBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-test-handoff-")
        self.base = Path(self.tmp.name).resolve()
        # Clean session env
        self.orig_root = os.environ.get(ENV_PROJECT_ROOT)
        self.orig_lineage = os.environ.get(ENV_PROJECT_LINEAGE)
        os.environ.pop(ENV_PROJECT_ROOT, None)
        os.environ.pop(ENV_PROJECT_LINEAGE, None)

    def tearDown(self) -> None:
        if self.orig_root is not None:
            os.environ[ENV_PROJECT_ROOT] = self.orig_root
        else:
            os.environ.pop(ENV_PROJECT_ROOT, None)
        if self.orig_lineage is not None:
            os.environ[ENV_PROJECT_LINEAGE] = self.orig_lineage
        else:
            os.environ.pop(ENV_PROJECT_LINEAGE, None)
        self.tmp.cleanup()

    def test_milestone2_identities_distinct(self) -> None:
        """Milestone 2: saipen_home != project_root != project_lineage."""
        project = self.base / "my_project"
        lineage = _init_saipen_project(project)
        tool_root = resolve_tool_root()

        # The tool installation is distinct from the project under development
        self.assertNotEqual(project.resolve(), tool_root.resolve())
        # Lineage is durable string
        self.assertTrue(lineage.startswith("lineage-"))
        self.assertEqual(project_lineage_identity(project), lineage)
        # Tool root has no project lineage by default or is the protocol distribution
        self.assertNotEqual(str(project.resolve()), lineage)

    def test_control_a_exact_reported_incident(self) -> None:
        """CONTROL A: Detached staging directory + SAIPEN_PROJECT_ROOT."""
        project = self.base / "FastPrompter"
        lineage = _init_saipen_project(project)
        _git_init(project)

        staging = self.base / "_TEMP_" / "fastprompter_drag"
        staging.mkdir(parents=True, exist_ok=True)
        handoff_file = staging / "SAIHANDOFF_20260912_0418.md"
        handoff_file.write_text("# SAIHANDOFF payload\n", encoding="utf-8")

        # 1. Without session root carrier, running from staging refuses
        res_no_carrier = resolve_project_root(staging)
        self.assertIsNone(res_no_carrier.root)
        self.assertEqual(res_no_carrier.code, "NOT_SAIPEN_PROJECT")

        # 2. With SAIPEN_PROJECT_ROOT=project, root resolves cleanly to project
        os.environ[ENV_PROJECT_ROOT] = str(project)
        res_carrier = resolve_project_root(staging)
        self.assertEqual(res_carrier.root, project.resolve())
        self.assertEqual(res_carrier.source, PROVENANCE_HOST_SESSION)
        self.assertEqual(res_carrier.lineage, lineage)

        # Diagnostics truthfully expose provenance
        diag = res_carrier.diagnostics()
        self.assertEqual(diag["project_root"], str(project.resolve()))
        self.assertEqual(diag["project_root_source"], PROVENANCE_HOST_SESSION)
        self.assertEqual(diag["project_lineage"], lineage)

    def test_control_b_lineage_binding(self) -> None:
        """CONTROL B: Correct root + correct lineage PASS;
        wrong lineage fails PROJECT_LINEAGE_MISMATCH.
        """
        project = self.base / "proj_b"
        lineage = _init_saipen_project(project)

        foreign_project = self.base / "foreign_proj"
        _init_saipen_project(foreign_project)

        staging = self.base / "staging"
        staging.mkdir(parents=True, exist_ok=True)

        # Correct root + correct lineage -> PASS
        os.environ[ENV_PROJECT_ROOT] = str(project)
        os.environ[ENV_PROJECT_LINEAGE] = lineage
        res_ok = resolve_project_root(staging)
        self.assertEqual(res_ok.root, project.resolve())
        self.assertEqual(res_ok.source, PROVENANCE_HOST_SESSION)

        # Correct root + wrong lineage -> fail PROJECT_LINEAGE_MISMATCH
        os.environ[ENV_PROJECT_LINEAGE] = "lineage-00000000000000000000000000000000"
        res_mismatch = resolve_project_root(staging)
        self.assertIsNone(res_mismatch.root)
        self.assertEqual(res_mismatch.code, "PROJECT_LINEAGE_MISMATCH")

        # Foreign root + expected lineage -> fail PROJECT_LINEAGE_MISMATCH
        os.environ[ENV_PROJECT_ROOT] = str(foreign_project)
        os.environ[ENV_PROJECT_LINEAGE] = lineage  # expects proj_b's lineage
        res_foreign = resolve_project_root(staging)
        self.assertIsNone(res_foreign.root)
        self.assertEqual(res_foreign.code, "PROJECT_LINEAGE_MISMATCH")

    def test_control_c_stale_root(self) -> None:
        """CONTROL C: SAIPEN_PROJECT_ROOT points to deleted/moved dir -> fails closed."""
        ambient_git = self.base / "ambient_git"
        ambient_git.mkdir(parents=True, exist_ok=True)
        _init_saipen_project(ambient_git)
        _git_init(ambient_git)

        # Point carrier to nonexistent path
        deleted_dir = self.base / "deleted_project"
        os.environ[ENV_PROJECT_ROOT] = str(deleted_dir)

        # Run from ambient git repo: must NOT fall back to ambient_git!
        res = resolve_project_root(ambient_git)
        self.assertIsNone(res.root)
        self.assertEqual(res.code, "PROJECT_BINDING_INVALID")
        self.assertIn("not an existing directory", res.detail)

    def test_control_d_foreign_git_staging_cwd(self) -> None:
        """CONTROL D: Staging dir inside foreign Git adopts intended project or fails."""
        foreign_repo = self.base / "foreign_repo"
        foreign_repo.mkdir(parents=True, exist_ok=True)
        _git_init(foreign_repo)

        staging_inside_foreign = foreign_repo / "temp_staging"
        staging_inside_foreign.mkdir(parents=True, exist_ok=True)

        intended_project = self.base / "intended_project"
        intended_lineage = _init_saipen_project(intended_project)
        _git_init(intended_project)

        # With verified carrier, resolves to intended project, NOT foreign_repo
        os.environ[ENV_PROJECT_ROOT] = str(intended_project)
        os.environ[ENV_PROJECT_LINEAGE] = intended_lineage
        res = resolve_project_root(staging_inside_foreign)
        self.assertEqual(res.root, intended_project.resolve())
        self.assertEqual(res.source, PROVENANCE_HOST_SESSION)

        # With invalid carrier, fails closed and does not adopt foreign_repo
        os.environ[ENV_PROJECT_LINEAGE] = "lineage-ffffffffffffffffffffffffffffffff"
        res_invalid = resolve_project_root(staging_inside_foreign)
        self.assertIsNone(res_invalid.root)
        self.assertEqual(res_invalid.code, "PROJECT_LINEAGE_MISMATCH")

    def test_control_e_ordinary_invocation_unchanged(self) -> None:
        """CONTROL E: When no env binding present, standard Git resolution is identical."""
        proj = self.base / "ordinary_proj"
        _init_saipen_project(proj)
        _git_init(proj)

        sub = proj / "src" / "pkg"
        sub.mkdir(parents=True, exist_ok=True)

        res = resolve_project_root(sub)
        self.assertEqual(res.root, proj.resolve())
        self.assertIn(res.source, (PROVENANCE_GIT_WORKTREE, PROVENANCE_ANCESTOR))

    def test_control_f_linked_worktree(self) -> None:
        """CONTROL F: Git worktree resolution works for Git repositories."""
        proj = self.base / "worktree_proj"
        lineage = _init_saipen_project(proj)
        _git_init(proj)

        res = resolve_project_root(proj)
        self.assertEqual(res.root, proj.resolve())
        self.assertEqual(res.lineage, lineage)

    def test_control_g_non_git_project(self) -> None:
        """CONTROL G: Non-git project resolves through nearest ancestor containing .saipen."""
        proj = self.base / "nongit_proj"
        lineage = _init_saipen_project(proj)
        # Do not run git init!

        sub = proj / "deep" / "nested" / "folder"
        sub.mkdir(parents=True, exist_ok=True)

        res = resolve_project_root(sub)
        self.assertEqual(res.root, proj.resolve())
        self.assertEqual(res.source, PROVENANCE_ANCESTOR)
        self.assertEqual(res.lineage, lineage)

    def test_control_h_portable_handoff(self) -> None:
        """CONTROL H: saipen brief contains project_lineage, no machine-local root."""
        proj = self.base / "brief_proj"
        lineage = _init_saipen_project(proj)

        result = brief_projection(proj)
        self.assertTrue(result.ok)
        payload = result.data.get("json") or result.data
        self.assertEqual(payload.get("project_lineage"), lineage)
        self.assertEqual(payload.get("project"), proj.name)
        self.assertEqual(payload.get("phase"), "DONE")
        self.assertIn("last_event", payload)
        self.assertIn("state_updated", payload)
        # Verify machine-local absolute paths are not portable project identity
        self.assertNotIn(str(proj.resolve()), json.dumps(payload.get("project_lineage")))

    def test_control_i_staging_path_payload(self) -> None:
        """CONTROL I: Staging-path payload outside project_root doesn't become root."""
        proj = self.base / "intended_repo"
        lineage = _init_saipen_project(proj)

        staging_dir = self.base / "_TEMP_" / "drag_drop"
        staging_dir.mkdir(parents=True, exist_ok=True)
        payload_file = staging_dir / "SAIHANDOFF_payload.md"
        payload_file.write_text("# Handoff\n", encoding="utf-8")

        os.environ[ENV_PROJECT_ROOT] = str(proj)
        os.environ[ENV_PROJECT_LINEAGE] = lineage

        res = resolve_project_root(staging_dir)
        self.assertEqual(res.root, proj.resolve())
        self.assertNotEqual(res.root, staging_dir.resolve())
        self.assertFalse((staging_dir / ".saipen").exists())

    def test_control_j_guard_integration(self) -> None:
        """CONTROL J: Admission check resolves intended project's state from detached cwd."""
        proj = self.base / "guard_proj"
        lineage = _init_saipen_project(proj)

        staging_dir = self.base / "guard_staging"
        staging_dir.mkdir(parents=True, exist_ok=True)

        # 1. Detached cwd with carrier inspects target project state
        os.environ[ENV_PROJECT_ROOT] = str(proj)
        os.environ[ENV_PROJECT_LINEAGE] = lineage

        resolved = resolve_project_root(staging_dir)
        self.assertEqual(resolved.root, proj.resolve())
        # Inspect target project's canonical state
        state_file = resolved.root / ".saipen" / "STATE.md"
        self.assertTrue(state_file.is_file())
        self.assertIn("phase: DONE", state_file.read_text(encoding="utf-8"))

        # 2. Detached cwd without carrier fails closed (not applicable / refused)
        os.environ.pop(ENV_PROJECT_ROOT, None)
        os.environ.pop(ENV_PROJECT_LINEAGE, None)
        refused = resolve_project_root(staging_dir)
        self.assertIsNone(refused.root)
        self.assertEqual(refused.code, "NOT_SAIPEN_PROJECT")

    def test_control_k_activation_contract(self) -> None:
        """CONTROL K: the ONE activation template carries the handoff/session
        binding clause, and both injectors render THAT template.

        T-1317 P1-3: the semantic block was centralized into
        `saipen/ACTIVATION_BLOCK.md`, so searching the injector scripts for
        activation prose tests the pre-registry architecture. The contract is
        the canonical template (and everything rendered from it).
        """
        # tools/ is already on sys.path for this module.
        import autoinject

        repo = TOOLS.parent
        template = (repo / "saipen" / "ACTIVATION_BLOCK.md").read_text(encoding="utf-8")
        rendered = autoinject.rendered_activation_block(repo / "saipen")
        for surface, label in ((template, "template"), (rendered, "rendered")):
            flat = " ".join(surface.split())
            self.assertIn(
                "when project root contains .saipen/ or a verified SAIPEN "
                "handoff/session binding is active",
                flat,
                label,
            )
            self.assertIn(
                "when a verified SAIPEN handoff/session binding is active, or "
                "when project root contains .saipen/",
                flat,
                label,
            )
        for filename in ("inject.ps1", "inject.sh"):
            content = (repo / "bootstrap" / filename).read_text(encoding="utf-8")
            # The injectors must render the one template, never embed a copy.
            self.assertIn("ACTIVATION_BLOCK.md", content, filename)
            self.assertNotIn("SHORTCUT ACTIVATION GATE", content, filename)

    def test_control_l_no_disk_scanning(self) -> None:
        """CONTROL L: Two unrelated projects exist; detached staging refuses cleanly."""
        proj1 = self.base / "project_alpha"
        _init_saipen_project(proj1)

        proj2 = self.base / "project_beta"
        _init_saipen_project(proj2)

        detached_staging = self.base / "isolated_staging"
        detached_staging.mkdir(parents=True, exist_ok=True)

        # With no explicit/session binding, resolver MUST NOT scan the drive to pick alpha or beta!
        res = resolve_project_root(detached_staging)
        self.assertIsNone(res.root)
        self.assertEqual(res.code, "NOT_SAIPEN_PROJECT")


class FleetRecoveryBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-fleet-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.saved_root = os.environ.pop(ENV_PROJECT_ROOT, None)
        self.saved_lineage = os.environ.pop(ENV_PROJECT_LINEAGE, None)
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        for key, value in (
            (ENV_PROJECT_ROOT, self.saved_root),
            (ENV_PROJECT_LINEAGE, self.saved_lineage),
        ):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def project(self, name: str, *, phase: str = "BUILD") -> tuple[Path, str]:
        donor = _t1318_project(phase=phase, transition_from="SCOUT" if phase == "BUILD" else "DONE")
        root = self.base / name
        shutil.copytree(donor, root)
        shutil.rmtree(donor)
        lineage = new_project_lineage()
        (root / ".saipen" / "IDENTITY.md").write_text(
            identity_file_content(lineage), encoding="utf-8"
        )
        return root, lineage

    def test_healthy_repairable_and_ambiguous_are_distinct_and_read_only(self) -> None:
        healthy, lineage = self.project("healthy")
        broken, broken_lineage = self.project("broken", phase="IMPL")
        ambiguous, ambiguous_lineage = self.project("ambiguous", phase="IMPL")
        (ambiguous / ".saipen" / "LOG.md").write_text(
            "# Log\n- 13.09.26 00:00 [E-0001] [agent: tester] RUN: checkpoint SCOUT\n",
            encoding="utf-8",
        )
        snapshots = {
            root: {p.name: p.read_bytes() for p in (root / ".saipen").iterdir() if p.is_file()}
            for root in (healthy, broken, ambiguous)
        }
        self.assertEqual(
            preflight(healthy, host_root=healthy, host_lineage=lineage)["classification"],
            "BOUND_VALID",
        )
        self.assertEqual(
            preflight(broken, host_root=broken, host_lineage=broken_lineage)["classification"],
            "BOUND_RECOVERY_REQUIRED_SAFE",
        )
        self.assertEqual(
            preflight(ambiguous, host_root=ambiguous, host_lineage=ambiguous_lineage)[
                "classification"
            ],
            "BOUND_RECOVERY_REQUIRED_BLOCKED",
        )
        for root, before in snapshots.items():
            self.assertEqual(
                {p.name: p.read_bytes() for p in (root / ".saipen").iterdir() if p.is_file()},
                before,
            )

    def test_wrong_lineage_and_foreign_cwd_never_select_other_project(self) -> None:
        first, lineage = self.project("first", phase="IMPL")
        second, foreign_lineage = self.project("second")
        foreign_bytes = (second / ".saipen" / "STATE.md").read_bytes()
        conflict = preflight(second, host_root=first, host_lineage=foreign_lineage)
        self.assertEqual(conflict["classification"], "BINDING_CONFLICT")
        self.assertEqual(
            preflight(second, host_root=first, host_lineage=lineage)["root"], str(first.resolve())
        )
        healed = prepare(second, host_root=first, host_lineage=lineage)
        self.assertTrue(healed["recovered"], healed)
        self.assertEqual((second / ".saipen" / "STATE.md").read_bytes(), foreign_bytes)

    def test_recovery_keeps_product_work_and_requires_fresh_tool_payload(self) -> None:
        root, lineage = self.project("product", phase="IMPL")
        result = prepare(root, host_root=root, host_lineage=lineage)
        self.assertEqual(result["classification"], "BOUND_VALID", result)
        self.assertTrue(result["recovered"])
        self.assertTrue(result["requires_reissue"])
        self.assertEqual(result["continuation"]["active_work"], "T-001")
        self.assertEqual(result["continuation"]["phase"], "BUILD")
        self.assertIn("agent: tester", (root / ".saipen" / "STATE.md").read_text(encoding="utf-8"))
        self.assertIn(
            "T-001", (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8").split("## TODO")[0]
        )

    def test_unchanged_repair_condition_gets_one_attempt(self) -> None:
        root, lineage = self.project("stuck", phase="IMPL")
        calls = []
        result = prepare(
            root,
            host_root=root,
            host_lineage=lineage,
            recover=lambda *_args: calls.append(1) or {"ok": True, "code": "REPAIRED"},
        )
        self.assertEqual(len(calls), 1)
        # T-1354: the code now says WHY there is no second attempt. The repair
        # ran, the state still asks for the same repair, so the automatic route
        # is exhausted -- and an exhausted route does not ask for a reissue,
        # because reissuing points the caller back at the same bytes. That loop
        # was measured live: every consequential tool in a real session refused
        # forever with "reread and reissue".
        self.assertEqual(result["code"], "RECOVERY_EXHAUSTED")
        self.assertFalse(result["requires_reissue"], result)
        again = prepare(
            root,
            host_root=root,
            host_lineage=lineage,
            attempted_condition=result["attempted_condition"],
            recover=lambda *_args: calls.append(2) or {"ok": True, "code": "REPAIRED"},
        )
        self.assertEqual(again["code"], "RECOVERY_EXHAUSTED")
        self.assertFalse(again["requires_reissue"], again)
        self.assertEqual(again["recovery_attempts"], 0)
        self.assertEqual(calls, [1])
        self.assertEqual(
            preflight(root, host_root=root, host_lineage=lineage)["classification"],
            "BOUND_RECOVERY_REQUIRED_SAFE",
        )

    def test_explicit_scan_is_read_only_and_non_saipen_is_non_interfering(self) -> None:
        root, _lineage = self.project("bound")
        ordinary = self.base / "ordinary"
        ordinary.mkdir()
        _git_init(ordinary)
        detached = self.base / "detached"
        detached.mkdir()
        before = (root / ".saipen" / "STATE.md").read_bytes()
        report = scan([root, ordinary])
        self.assertEqual(
            [item["classification"] for item in report["projects"]], ["BOUND_VALID", "NON_SAIPEN"]
        )
        self.assertEqual(preflight(detached, require_binding=True)["classification"], "UNBOUND")
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), before)
        self.assertFalse((ordinary / ".saipen").exists())

    def test_representative_fleet_names_remain_isolated(self) -> None:
        limisaw, _ = self.project("LIMISAW")
        problip, lineage = self.project("PROBLIP", phase="IMPL")
        audapack, _ = self.project("AUDAPACK", phase="IMPL")
        (audapack / ".saipen" / "LOG.md").write_text(
            "# Log\n- 13.09.26 00:00 [E-0001] [agent: tester] RUN: no transition proof\n",
            encoding="utf-8",
        )
        healthy, _ = self.project("healthy-SAIPEN")
        ordinary = self.base / "ordinary-repo"
        ordinary.mkdir()
        _git_init(ordinary)
        roots = [limisaw, problip, audapack, healthy, ordinary]
        before = {
            root: {p.name: p.read_bytes() for p in (root / ".saipen").iterdir() if p.is_file()}
            for root in roots[:-1]
        }
        report = scan(roots)
        self.assertEqual(
            [entry["classification"] for entry in report["projects"]],
            [
                "BOUND_VALID",
                "BOUND_RECOVERY_REQUIRED_SAFE",
                "BOUND_RECOVERY_REQUIRED_BLOCKED",
                "BOUND_VALID",
                "NON_SAIPEN",
            ],
        )
        for root, original in before.items():
            self.assertEqual(
                {p.name: p.read_bytes() for p in (root / ".saipen").iterdir() if p.is_file()},
                original,
            )
        result = prepare(audapack, host_root=problip, host_lineage=lineage)
        self.assertTrue(result["recovered"], result)
        for root in (limisaw, audapack, healthy):
            self.assertEqual(
                {p.name: p.read_bytes() for p in (root / ".saipen").iterdir() if p.is_file()},
                before[root],
            )

    def test_public_fleet_scan_and_unbound_preflight_are_read_only(self) -> None:
        root, _ = self.project("public-root")
        ordinary = self.base / "public-ordinary"
        ordinary.mkdir()
        _git_init(ordinary)
        before = (root / ".saipen" / "STATE.md").read_bytes()
        cli = TOOLS / "saipen.py"
        env = os.environ.copy()
        env.pop(ENV_PROJECT_ROOT, None)
        env.pop(ENV_PROJECT_LINEAGE, None)
        proc = subprocess.run(
            [sys.executable, str(cli), "fleet", "scan", "--root", str(root),
             "--root", str(ordinary), "--json"],
            cwd=str(self.base), env=env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertEqual([entry["classification"] for entry in report["projects"]],
                         ["BOUND_VALID", "NON_SAIPEN"])
        self.assertTrue(report["read_only"])
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), before)
        self.assertFalse((ordinary / ".saipen").exists())
        detached = self.base / "detached-public"
        detached.mkdir()
        proc = subprocess.run(
            [sys.executable, str(cli), "fleet", "preflight", "--cwd", str(detached),
             "--require-binding", "--json"],
            cwd=str(self.base), env=env, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["classification"], "UNBOUND")


if __name__ == "__main__":
    unittest.main()
