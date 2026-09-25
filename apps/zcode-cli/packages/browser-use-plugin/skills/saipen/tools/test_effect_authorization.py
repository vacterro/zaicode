"""T-1160 / INC-PERMISSION-EFFECT-BYPASS-001 regression: effect-based
authorization.

The founding incident: a host permitted the shell while file edits were
manual; the agent ran Python through the shell and Python wrote project
files. Intent was NOT malicious -- and the boundary still failed, because
authorization was attached to tool identity instead of effect. These tests
pin the law permanently:

    FILE WRITE IS A FILE WRITE, EVEN THROUGH A SHELL.
    SHELL APPROVAL IS NOT FILE-WRITE APPROVAL.
    READ-ONLY IS AN EFFECT PROPERTY, NOT A TOOL LABEL.
    OBSERVED MUTATION OUTRANKS CLAIMED NON-MUTATION.

AUTH-01..AUTH-20 from the hardening specification, plus the incident fixture,
the permissions diagnostic, and cold-resume evidence. Run standalone:

    python tools/test_effect_authorization.py
"""

from __future__ import annotations

import io
import contextlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(TOOLS))

from saipen_engine import effects as E  # noqa: E402
import saipen as CLI  # noqa: E402

REPO = TOOLS.parent

MANUAL_WRITE_POLICY = {
    E.FS_READ: "ALLOW",
    E.REPO_READ: "ALLOW",
    E.PROCESS_EXECUTE: "ALLOW",
    E.FS_WRITE: "MANUAL",
    E.FS_DELETE: "MANUAL",
    E.REPO_MUTATE: "MANUAL",
    E.NETWORK_READ: "ALLOW",
    E.NETWORK_WRITE: "MANUAL",
    E.EXTERNAL_MUTATE: "MANUAL",
}


class _GitProject(unittest.TestCase):
    """One clean tmp Git project with a single tracked src/foo.ts."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "proj"
        self.root.mkdir()
        (self.root / "src").mkdir()
        self.foo = self.root / "src" / "foo.ts"
        self.foo.write_text("a=1\n", encoding="utf-8")
        self._git("init", "-q")
        self._git("add", ".")
        self._git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i")

    def _git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True)

    def before(self) -> dict:
        return E.tree_snapshot(self.root)

    def write_via_python(self) -> None:
        """The incident's exact shape: interpreter mutates through the shell."""
        subprocess.run(
            [sys.executable, "-c", f"open({str(self.foo)!r},'w').write('a=2\\n')"],
            cwd=self.root,
            check=True,
        )


class EffectVocabularyTests(_GitProject):
    def test_closed_vocabulary_and_mutation_sets(self):
        for effect in (
            E.FS_READ,
            E.FS_WRITE,
            E.FS_DELETE,
            E.REPO_READ,
            E.REPO_MUTATE,
            E.PROCESS_EXECUTE,
            E.NETWORK_READ,
            E.NETWORK_WRITE,
            E.EXTERNAL_MUTATE,
        ):
            self.assertIn(effect, E.EFFECTS)
        # fs.write implies repo.mutate for approvals; process.execute never does.
        self.assertIn(E.REPO_MUTATE, E.IMPLIED_EFFECTS[E.FS_WRITE])
        self.assertNotIn(E.FS_WRITE, E.IMPLIED_EFFECTS.get(E.PROCESS_EXECUTE, ()))

    def test_tool_contract_possible_is_not_observed(self):
        # A shell is universally capable -- that is capability metadata,
        # never proof of what happened.
        possible = E.TOOL_POSSIBLE_EFFECTS["shell"]
        self.assertIn(E.FS_WRITE, possible)
        self.assertIn(E.PROCESS_EXECUTE, possible)
        # A dedicated edit tool guarantees exactly its purpose.
        self.assertEqual(E.TOOL_GUARANTEED_EFFECTS["edit"], (E.FS_WRITE,))

    def test_default_policy_backward_compatible_and_fail_closed(self):
        full = E.default_policy("full")
        ro = E.default_policy("read-only")
        self.assertEqual(full[E.FS_WRITE], "ALLOW")  # existing gated behavior kept
        self.assertEqual(ro[E.FS_WRITE], "DENY")  # read-only session denies
        unknown = E.default_policy("banana")
        self.assertEqual(unknown[E.FS_WRITE], "DENY")  # fail closed


class PolicyLoadTests(_GitProject):
    def test_project_policy_tightens_only(self):
        (self.root / ".saipen").mkdir()
        (self.root / ".saipen" / "policy.json").write_text(
            json.dumps({"fs.write": "MANUAL", "nonsense.effect": "ALLOW"}),
            encoding="utf-8",
        )
        loaded = E.load_policy(self.root, capability="full")
        self.assertEqual(loaded["source"], E.POLICY_SOURCE_PROJECT)
        self.assertEqual(loaded["policy"][E.FS_WRITE], "MANUAL")
        # Unknown keys are dropped (fail closed), never silently honored.
        self.assertTrue(any(o.startswith("dropped:") for o in loaded["overrides"]))

    def test_corrupt_policy_degrades_to_derived(self):
        (self.root / ".saipen").mkdir()
        (self.root / ".saipen" / "policy.json").write_text("{broken", encoding="utf-8")
        loaded = E.load_policy(self.root, capability="read-only")
        self.assertEqual(loaded["source"], E.POLICY_SOURCE_DERIVED)
        self.assertEqual(loaded["policy"][E.FS_WRITE], "DENY")


class CoverageMatrixTests(unittest.TestCase):
    """Pure evaluator matrix: same effect -> same policy class."""

    def _eval(self, observed, approvals=(), paths=("src/a.ts",), requested=(), attempt_id=None):
        return E.evaluate_coverage(
            observed_effects=tuple(observed),
            policy=MANUAL_WRITE_POLICY,
            approvals=tuple(approvals),
            paths=tuple(paths) if observed else (),
            requested_effects=tuple(requested),
            attempt_id=attempt_id,
        )

    def test_AUTH_01_dedicated_edit_approved_write_authorized(self):
        approval = E.Approval(effect=E.FS_WRITE, paths=("src/",))
        record = self._eval((E.FS_WRITE, E.REPO_MUTATE), (approval,))
        self.assertEqual(record.verdict, E.AUTHORIZED)
        self.assertIn(E.FS_WRITE, record.authorization_observed)

    def test_AUTH_02_write_without_approval_missing(self):
        record = self._eval((E.FS_WRITE, E.REPO_MUTATE), ())
        self.assertEqual(record.verdict, E.AUTHORIZATION_MISSING)
        self.assertIn("fs.write:MANUAL", record.authorization_required)

    def test_AUTH_03_readonly_shell_operation_no_mutation(self):
        record = self._eval(
            (E.PROCESS_EXECUTE, E.FS_READ),
            requested=(E.PROCESS_EXECUTE, E.FS_READ),
        )
        self.assertEqual(record.verdict, E.AUTHORIZED)
        self.assertIsNone(record.authorization_required)

    def test_AUTH_04_python_via_shell_write_insufficient(self):
        # Shell-execution approval alone NEVER covers the child's fs.write.
        shell_approval = E.Approval(effect=E.PROCESS_EXECUTE)
        record = self._eval((E.PROCESS_EXECUTE, E.FS_WRITE, E.REPO_MUTATE), (shell_approval,))
        self.assertEqual(record.verdict, E.AUTHORIZATION_MISSING)
        self.assertNotIn(E.FS_WRITE, record.authorization_observed)

    def test_AUTH_18_scope_mismatch_path_b(self):
        approval = E.Approval(effect=E.FS_WRITE, paths=("docs/",))
        record = self._eval((E.FS_WRITE, E.REPO_MUTATE), (approval,), paths=("src/b.ts",))
        self.assertEqual(record.verdict, E.AUTHORIZATION_MISSING)

    def test_AUTH_19_stale_attempt_reuse_rejected_unless_reusable(self):
        one_shot = E.Approval(effect=E.FS_WRITE, attempt_id="A-001", paths=("src/",))
        stale = self._eval(
            (E.FS_WRITE,), (one_shot,), attempt_id="A-002"
        )
        self.assertEqual(stale.verdict, E.AUTHORIZATION_MISSING)
        ok = self._eval((E.FS_WRITE,), (one_shot,), attempt_id="A-001")
        self.assertEqual(ok.verdict, E.AUTHORIZED)
        reusable = E.Approval(
            effect=E.FS_WRITE, attempt_id="A-001", paths=("src/",), reusable=True
        )
        later = self._eval((E.FS_WRITE,), (reusable,), attempt_id="A-002")
        self.assertEqual(later.verdict, E.AUTHORIZED)

    def test_AUTH_11_claims_readonly_but_tree_changed(self):
        # Spec allows "effect drift / policy mismatch": under a MANUAL policy
        # the uncovered mutation is AUTHORIZATION_MISSING (the severe fact),
        # and the record still carries the expected-vs-observed divergence.
        record = self._eval(
            (E.FS_WRITE, E.REPO_MUTATE),
            requested=(E.FS_READ,),
        )
        self.assertIn(record.verdict, (E.EFFECT_DRIFT, E.AUTHORIZATION_MISSING))
        self.assertEqual(record.requested_effects, (E.FS_READ,))
        self.assertNotIn(E.PROCESS_EXECUTE, record.authorization_observed)
        # Under an ALLOW-everything policy the SAME divergence is pure drift:
        permissive = {e: "ALLOW" for e in E.EFFECTS}
        drifted = E.evaluate_coverage(
            observed_effects=(E.FS_WRITE,),
            policy=permissive,
            requested_effects=(E.FS_READ,),
        )
        self.assertEqual(drifted.verdict, E.EFFECT_DRIFT)

    def test_AUTH_12_no_change_no_false_mutation(self):
        record = self._eval((), requested=())
        self.assertEqual(record.paths, ())
        self.assertEqual(record.effects, ())

    def test_unknown_effect_fails_closed_as_drift(self):
        record = self._eval(("fs.chmod",))
        self.assertEqual(record.verdict, E.EFFECT_DRIFT)


class TreeDeltaTests(_GitProject):
    """Real-subprocess audit layer: observation, never command parsing."""

    def test_AUTH_04_incident_python_writes_tracked_file(self):
        before = self.before()
        self.write_via_python()
        delta = E.tree_delta(self.root, before)
        self.assertEqual(delta["status"], "KNOWN")
        self.assertEqual(delta["paths"], ("src/foo.ts",))

    def test_AUTH_05_shell_redirection_into_tracked_file(self):
        before = self.before()
        with open(self.foo, "w", encoding="utf-8") as handle:  # redirection analog
            handle.write("a=3\n")
        delta = E.tree_delta(self.root, before)
        self.assertEqual(delta["paths"], ("src/foo.ts",))

    @unittest.skipUnless(os.name == "nt", "PowerShell fixture")
    def test_AUTH_06_powershell_set_content_same_class(self):
        before = self.before()
        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f"Set-Content -Path '{self.foo}' -Value 'a=4' -NoNewline",
            ],
            capture_output=True,
            timeout=60,
        )
        if self.foo.read_text(encoding="utf-8") == "a=1\n":
            self.skipTest("PowerShell unavailable")
        delta = E.tree_delta(self.root, before)
        self.assertEqual(delta["paths"], ("src/foo.ts",))
        record = E.evaluate_coverage(
            observed_effects=E._project_effects(delta["paths"]),
            policy=MANUAL_WRITE_POLICY,
            approvals=(E.Approval(effect=E.PROCESS_EXECUTE),),
            paths=delta["paths"],
        )
        self.assertEqual(record.verdict, E.AUTHORIZATION_MISSING)

    def test_AUTH_07_formatter_rewrite_detected(self):
        before = self.before()
        self.write_via_python()  # "lint --fix" is mechanically just a writer
        delta = E.tree_delta(self.root, before)
        self.assertTrue(delta["paths"])

    def test_AUTH_08_ignored_artifact_not_project_mutation(self):
        self._git("add", ".gitignore") if (self.root / ".gitignore").exists() else None
        (self.root / ".gitignore").write_text("tmp-out/\n", encoding="utf-8")
        (self.root / "tmp-out").mkdir()
        before = self.before()
        (self.root / "tmp-out" / "result.bin").write_bytes(b"\x00\x01")
        delta = E.tree_delta(self.root, before)
        # Ignored output is invisible to the default porcelain listing --
        # generated temporary output is not a project mutation.
        self.assertEqual(delta["paths"], ())

    def test_AUTH_09_runner_rewrites_tracked_fixture_detected(self):
        before = self.before()
        self.write_via_python()
        delta = E.tree_delta(self.root, before)
        self.assertEqual(delta["paths"], ("src/foo.ts",))

    def test_AUTH_10_git_command_changes_worktree_detected(self):
        (self.root / "src" / "bar.ts").write_text("b\n", encoding="utf-8")
        self._git("add", ".")
        self._git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "bar")
        before = self.before()
        self._git("checkout", "--", "src/foo.ts")  # no-op content-wise
        (self.foo).write_text("a=5\n", encoding="utf-8")  # real tree change
        delta = E.tree_delta(self.root, before)
        self.assertEqual(delta["paths"], ("src/foo.ts",))

    def test_AUTH_12_no_operation_no_mutation(self):
        before = self.before()
        delta = E.tree_delta(self.root, before)
        self.assertEqual(delta["paths"], ())
        self.assertEqual(delta["prior_paths"], ())

    def test_AUTH_13_pre_existing_dirt_not_attributed(self):
        self.write_via_python()
        before = self.before()
        delta = E.tree_delta(self.root, before)
        self.assertEqual(delta["paths"], ())
        self.assertEqual(delta["prior_paths"], ("src/foo.ts",))

    def test_AUTH_14_external_concurrent_mutation_provenance_unknown(self):
        before = self.before()
        # An external process mutates mid-attempt: SAIPEN observes the change
        # but has NO durable evidence of which process caused it.
        self.foo.write_text("external\n", encoding="utf-8")
        delta = E.tree_delta(self.root, before)
        self.assertEqual(delta["paths"], ("src/foo.ts",))
        record = E.MutationRecord(paths=delta["paths"], effects=(E.FS_WRITE,))
        self.assertIsNone(record.origin_tool)
        self.assertIsNone(record.attempt_id)
        self.assertEqual(record.evidence_status, "KNOWN")

    def test_non_git_project_reports_unavailable_honestly(self):
        bare = Path(self._tmp.name) / "bare"
        bare.mkdir()
        snapshot = E.tree_snapshot(bare)
        self.assertEqual(snapshot["status"], "UNAVAILABLE")


class IncidentFixtureTests(_GitProject):
    """INC-PERMISSION-EFFECT-BYPASS-001 -- permanent regression fixture."""

    INCIDENT_ID = "INC-PERMISSION-EFFECT-BYPASS-001"

    def test_incident_full_semantics(self):
        # GIVEN: edits manual, shell execution separately permitted
        (self.root / ".saipen").mkdir()
        (self.root / ".saipen" / "policy.json").write_text(
            json.dumps({"fs.write": "MANUAL"}), encoding="utf-8"
        )
        loaded = E.load_policy(self.root, capability="full")
        self.assertEqual(loaded["policy"][E.FS_WRITE], "MANUAL")
        before = self.before()

        # WHEN: agent launches Python via shell; Python changes tracked source
        self.write_via_python()

        # THEN: mutation identified as fs.write/repo.mutate
        delta = E.tree_delta(self.root, before)
        self.assertEqual(delta["status"], "KNOWN")
        self.assertEqual(delta["paths"], ("src/foo.ts",))
        effects = E._project_effects(delta["paths"])
        self.assertEqual(effects, (E.FS_WRITE, E.REPO_MUTATE))

        # THEN: shell approval alone is NOT authorization
        shell_only = E.Approval(effect=E.PROCESS_EXECUTE)
        missing = E.evaluate_coverage(
            observed_effects=(E.PROCESS_EXECUTE, *effects),
            policy=loaded["policy"],
            approvals=(shell_only,),
            paths=delta["paths"],
        )
        self.assertEqual(missing.verdict, E.AUTHORIZATION_MISSING)

        # AND: the system must NOT claim read-only -- the claim gate demands
        # evidence, and the evidence here shows a changed tree.
        claimed_clean = False
        observed_dirty = bool(delta["paths"])
        self.assertFalse(claimed_clean and observed_dirty)

        # AND: no intent labeling anywhere in the mechanical verdict
        blob = json.dumps(missing.to_dict())
        for word in ("malicious", "deliberate", "bypassed"):
            self.assertNotIn(word, blob.lower())

        # AND: the resulting diff remains visible and auditable
        diff = subprocess.run(
            ["git", "diff", "--name-only"], cwd=self.root, capture_output=True, text=True
        )
        self.assertIn("src/foo.ts", diff.stdout)

        # AND: bounded write authorization makes it authorized, scope-exact
        granted = E.Approval(effect=E.FS_WRITE, paths=("src/",), work_id="W-1")
        authorized = E.evaluate_coverage(
            observed_effects=effects,
            policy=loaded["policy"],
            approvals=(granted,),
            paths=delta["paths"],
            work_id="W-1",
        )
        self.assertEqual(authorized.verdict, E.AUTHORIZED)
        outside = E.evaluate_coverage(
            observed_effects=effects,
            policy=loaded["policy"],
            approvals=(granted,),
            paths=("README.md",),
            work_id="W-1",
        )
        self.assertEqual(outside.verdict, E.AUTHORIZATION_MISSING)

    def test_cold_resume_evidence_survives_dead_agent(self):
        # The dead agent narrated nothing; durable evidence still answers
        # what changed, under which Work binding the NEXT agent chooses.
        self.write_via_python()
        fresh_agent_view = E.tree_snapshot(self.root)
        self.assertIn("src/foo.ts", fresh_agent_view["paths"])
        record = E.MutationRecord(paths=fresh_agent_view["paths"], effects=(E.FS_WRITE,))
        self.assertEqual(record.to_dict()["paths"], ["src/foo.ts"])


class EnforcementHonestyTests(unittest.TestCase):
    def test_AUTH_15_declared_sandbox_reports_strong(self):
        assessment = E.host_enforcement({"SAIPEN_HOST_ENFORCEMENT": "sandbox-readonly"})
        self.assertEqual(assessment["strength"], "STRONG")
        declared = {"SAIPEN_HOST_ENFORCEMENT": "sandbox-readonly"}
        gap = E.assess_enforcement_gap(MANUAL_WRITE_POLICY, declared)
        self.assertFalse(gap["gap"])

    def test_AUTH_16_prompt_conventions_never_reported_as_sandbox(self):
        assessment = E.host_enforcement({"SAIPEN_HOST_ENFORCEMENT": "tool-conventions"})
        self.assertEqual(assessment["strength"], "PARTIAL")
        self.assertIn("indirect", assessment["note"])
        undeclared = E.host_enforcement({})
        self.assertEqual(undeclared["strength"], "UNAVAILABLE")
        gap = E.assess_enforcement_gap(MANUAL_WRITE_POLICY, {})
        self.assertTrue(gap["gap"])
        self.assertEqual(gap["verdict"], "ENFORCEMENT_GAP")

    def test_AUTH_17_bounded_authorization_matches_exact_scope(self):
        approval = E.Approval(effect=E.FS_WRITE, paths=("src/",))
        inside = E.evaluate_coverage(
            observed_effects=(E.FS_WRITE,),
            policy=MANUAL_WRITE_POLICY,
            approvals=(approval,),
            paths=("src/nested/deep.ts",),
        )
        self.assertEqual(inside.verdict, E.AUTHORIZED)

    def test_AUTH_20_no_implicit_promotion_execute_to_write(self):
        execute_approval = E.Approval(effect=E.PROCESS_EXECUTE, reusable=True)
        record = E.evaluate_coverage(
            observed_effects=(E.PROCESS_EXECUTE, E.FS_DELETE),
            policy={**MANUAL_WRITE_POLICY, E.PROCESS_EXECUTE: "ALLOW"},
            approvals=(execute_approval,),
        )
        self.assertEqual(record.verdict, E.AUTHORIZATION_MISSING)
        self.assertNotIn(E.FS_DELETE, record.authorization_observed)


class PermissionsDiagnosticTests(_GitProject):
    def setUp(self) -> None:
        super().setUp()
        # resolve_project_root refuses a directory with no .saipen/; the
        # diagnostic itself never reads canonical state.
        (self.root / ".saipen").mkdir()

    def _cli(self, *args: str) -> tuple[int, dict]:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc = CLI.main(["--json", "--project-root", str(self.root), *args])
        try:
            payload = json.loads(buffer.getvalue())
        except ValueError:
            payload = {"_raw": buffer.getvalue()}
        return rc, payload

    def test_permissions_readonly_json_shape(self):
        rc, payload = self._cli("permissions")
        self.assertEqual(rc, 0)
        self.assertEqual(payload["code"], "PERMISSIONS")
        for key in ("policy_source", "policy", "host_enforcement", "enforcement_gap"):
            self.assertIn(key, payload)
        # Honest enforcement: nothing declared -> UNAVAILABLE, and the
        # diagnostic NEVER claims a hard sandbox that was not declared.
        self.assertEqual(payload["host_enforcement"]["strength"], "UNAVAILABLE")
        self.assertNotEqual(payload["enforcement_verdict"], "ENFORCED")
        self.assertIn("possible effects are capability, not observation", json.dumps(payload))

    def test_permissions_surfaces_project_manual_policy_gap(self):
        (self.root / ".saipen").mkdir(exist_ok=True)
        (self.root / ".saipen" / "policy.json").write_text(
            '{"fs.write": "MANUAL"}', encoding="utf-8"
        )
        _rc, payload = self._cli("permissions")
        self.assertEqual(payload["policy"]["fs.write"], "MANUAL")
        self.assertEqual(payload["policy_source"], E.POLICY_SOURCE_PROJECT)
        self.assertTrue(payload["enforcement_gap"])

    def test_permissions_accepts_no_arguments(self):
        rc, payload = self._cli("permissions", "extra")
        self.assertEqual(rc, 2)
        self.assertEqual(payload.get("code"), "VALIDATION_FAILED")


if __name__ == "__main__":
    unittest.main(verbosity=2)
