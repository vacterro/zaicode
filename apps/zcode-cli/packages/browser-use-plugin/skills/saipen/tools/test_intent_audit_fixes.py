"""Regression tests for the SAIPEN AUDIT CORE fixes (CORE-001..CORE-010).

These pin the CORE_DONE_WHEN VERIFY sections to deterministic, side-effect-free
assertions so the autonomous command-family repairs are machine-checkable on a
full checkout.

Run standalone:
    python tools/test_intent_audit_fixes.py

Exit code 0 when every test passes; 1 on the first failure batch.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(TOOLS))

from saipen_engine import intent  # noqa: E402
from saipen_engine import operations  # noqa: E402
from saipen_engine import paths as PATHS  # noqa: E402
from saipen_engine import producer as P  # noqa: E402
from saipen_engine import capability as CAP  # noqa: E402
from saipen_engine import crew as C  # noqa: E402
from saipen_engine import state as S  # noqa: E402
from saipen_engine.conformance import _validate_conformance_containment  # noqa: E402
from saipen_engine.reconcile import reconcile_protocol_state  # noqa: E402
from saipen_engine.subs import SUBS_REL  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
import saipen as CLI  # noqa: E402

AGENT = "test"


def setUpModule() -> None:
    """An outer host session must never bind this module's fixtures."""
    isolate_host_session()


def _canonicalize_legacy_done(root: Path) -> None:
    """Answer the legacy-closure decision the current gate asks for.

    `done-wait-deadlock-goal-mode` is a legacy-generation fixture: T-001 was
    closed before the closure contract existed, so the reconcile preflight
    refuses with RECONCILE_REAUTH_REQUIRED and names the one sanctioned
    operator decision, `saipen recover --attest-legacy-done T-001`. The fixture
    takes that exact decision once through the same canonical writer, so the
    intent-routing semantics under test are reachable; the legacy refusal keeps
    its own coverage in `test_legacy_lifecycle_compat.py`.
    """
    plan = reconcile_protocol_state(
        root, AGENT, dry_run=True, attest_legacy_done=["T-001"]
    )
    if plan.get("code") == "CLEAN":
        return
    repair_id = plan.get("repair_id")
    if not repair_id:
        raise AssertionError(f"legacy fixture is not reconcilable: {plan}")
    applied = reconcile_protocol_state(
        root, AGENT, attest_legacy_done=["T-001"], approved_repair_id=repair_id
    )
    if not applied.get("ok"):
        raise AssertionError(f"legacy attestation failed: {applied}")


def _hash_tree(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(Path(root).rglob("*")):
        if ".git" in p.parts or "__pycache__" in p.parts or ".pytest_cache" in p.parts:
            continue
        if p.is_file():
            h.update(str(p.relative_to(root)).encode("utf-8"))
            h.update(p.read_bytes())
    return h.hexdigest()


class IntentAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        """Every runtime test gets an isolated optional global profile home."""
        config = tempfile.TemporaryDirectory(prefix="saipen-test-user-config-")
        self.addCleanup(config.cleanup)
        patcher = mock.patch.dict(
            os.environ, {"SAIPEN_USER_CONFIG_HOME": config.name}, clear=False
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _scaffold_prepare_project(root: Path) -> None:
        fixture = TOOLS.parent / "tests/scenarios/done-wait-deadlock-goal-mode/.saipen"
        shutil.copytree(fixture, root / ".saipen", dirs_exist_ok=True)
        state_path = root / ".saipen/STATE.md"
        state_path.write_text(
            S.patch_state(
                state_path.read_text(encoding="utf-8"),
                {"saipen_home": str(TOOLS.parent.resolve())},
            ),
            encoding="utf-8",
            newline="\n",
        )

    def _resume_fixture(self) -> Path:
        temporary = tempfile.TemporaryDirectory(prefix="saipen-continue-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / "project"
        shutil.copytree(TOOLS.parent / "tests/scenarios/done-wait-deadlock-goal-mode", root)
        _canonicalize_legacy_done(root)
        return root

    @staticmethod
    def _invoke_cli(root: Path, *args: str, as_json: bool = True):
        argv = [*args, "--project-root", str(root)]
        if as_json:
            argv.append("--json")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rc = CLI.main(argv)
        raw = output.getvalue().strip()
        return rc, (json.loads(raw) if as_json else raw)

    @staticmethod
    def _set_fixture_intent(root: Path, execution_intent: str, target: str | None = None):
        state_path = root / ".saipen" / "STATE.md"
        text = S.transition_execution_intent(
            state_path.read_text(encoding="utf-8"), execution_intent, target
        )
        next_action = {
            "crew": "saipen crew",
            "ship": "saipen ship",
        }.get(target, "saipen continue")
        text = S.patch_state(text, {"next_action": next_action})
        state_path.write_text(text, encoding="utf-8", newline="\n")

    @staticmethod
    def _publish_old_ready(
        root: Path,
        role: str,
        *,
        head_suffix: str = "",
        tree_suffix: str = "",
        role_suffix: str = "",
    ):
        from freshness import compute_source_identity

        if not (root / ".saipen/STATE.md").is_file():
            IntentAuditTests._scaffold_prepare_project(root)
        source = root / "source.txt"
        source.write_text("producer input\n", encoding="utf-8")
        identity = compute_source_identity(root)
        namespace = P.producer_namespace(root, role)
        epoch = P.ProducerEpoch.claim(namespace)
        package = P.build_package(
            producer=role,
            role_revision="role-current" + role_suffix,
            base_source_head=identity.source_head + head_suffix,
            base_source_tree_fingerprint=identity.source_tree_fingerprint + tree_suffix,
            base_discovery_model=identity.discovery_model,
            scope="old ready handoff",
            read_set=P.read_set_from(root, ["source.txt"]),
            write_set={},
            epoch=epoch,
        )
        generation = P.StagingGeneration(namespace, role).begin()
        generation.set_package(package)
        published = generation.publish()
        if not published.get("ok"):
            raise AssertionError(published)
        return namespace, package

    # ── CORE-001: capability boundary is negotiated, never hard-coded ──────
    def test_core001_readonly_refuses_mutation(self):
        root = Path(tempfile.mkdtemp())
        # A non-producer role with no instance: read-only must refuse the
        # spawn/prepare mutation WITHOUT invoking any writer.
        res = intent.ensure_producer_ready(root, "saihunt", current_capability="read-only")
        self.assertEqual(res["code"], "CAPABILITY_READ_ONLY")
        # Internal hard-coded resolver is gone.
        self.assertFalse(hasattr(intent, "_negotiate_capability_resolver_active"))
        with self.assertRaises(RuntimeError):
            intent._negotiate_capability(root)

    def test_core001_capability_default_is_full_when_unset(self):
        saved = os.environ.pop("SAIPEN_CAPABILITY", None)
        try:
            self.assertEqual(CAP.negotiate_capability(), "full")
        finally:
            if saved is not None:
                os.environ["SAIPEN_CAPABILITY"] = saved

    # ── CORE-002: --dry-run is a zero-write plan ───────────────────────────
    def test_core002_dryrun_zero_write(self):
        # Hash an isolated project surface, never the shared checkout. Other
        # conformance suites legitimately create fixture/recovery evidence in
        # parallel; treating their writes as this dry-run's writes makes the
        # assertion scheduler-dependent and produced a false CORE-002 failure.
        temporary = tempfile.TemporaryDirectory(prefix="saipen-dryrun-zero-write-")
        self.addCleanup(temporary.cleanup)
        repo_root = TOOLS.parent
        root = Path(temporary.name) / "project"
        shutil.copytree(
            repo_root / ".saipen",
            root / ".saipen",
            ignore=shutil.ignore_patterns("recovery", "__pycache__"),
        )
        state_path = root / ".saipen" / "STATE.md"
        state_path.write_text(
            S.patch_state(
                state_path.read_text(encoding="utf-8-sig"),
                {"saipen_home": str(repo_root.resolve())},
            ),
            encoding="utf-8",
            newline="\n",
        )
        before = _hash_tree(root)
        res = intent.autonomous_crew_loop(root, dry_run=True, current_capability="full")
        after = _hash_tree(root)
        self.assertEqual(before, after, "dry-run mutated the filesystem")
        self.assertIn(
            res["code"], ("CREW_DRY_PLAN", "CREW_COMPLETE", "CREW_IDLE", "CREW_FINALIZED")
        )

    # ── CORE-003: no fabricated verified:PASS packages ─────────────────────
    def test_core003_no_fabrication_sub_role(self):
        root = Path(tempfile.mkdtemp())
        role_dir = root / SUBS_REL / "saihunt"
        role_dir.mkdir(parents=True)
        res = intent._prepare_role(root, "saihunt")
        self.assertEqual(res["code"], "ROLE_NOT_RUN")
        self.assertFalse((role_dir / "kitchen" / "OUTBOX.md").exists())

    def test_core003_no_fabrication_producer(self):
        root = Path(tempfile.mkdtemp())
        res = intent._prepare_role(root, "saitranslate")
        self.assertEqual(res["code"], "ROLE_NOT_RUN")
        ns = P.producer_namespace(root, "saitranslate")
        self.assertFalse((ns / "kitchen" / "OUTBOX.md").exists())
        # The real producer prepare refuses when the role emitted no evidence.
        res2 = intent._prepare_producer_role(root, "saitranslate")
        self.assertEqual(res2["code"], "ROLE_NOT_RUN")

    def test_core003_existing_outbox_is_not_fresh_execution(self):
        # File existence is not proof that the role ran in this request.
        root = Path(tempfile.mkdtemp())
        (root / ".saipen").mkdir()
        ns = P.producer_namespace(root, "saitranslate")
        outbox = ns / "kitchen" / "OUTBOX.md"
        outbox.parent.mkdir(parents=True)
        real_evidence = (
            "# OUTBOX\n## PKG-REAL-1\n"
            "status: ready\nrole_revision: r13\n"
            "source_head: abc123\n"
            "this is the actual emitted preparation evidence\n"
        )
        outbox.write_text(real_evidence, encoding="utf-8")

        res = intent._prepare_producer_role(root, "saitranslate")
        self.assertFalse(res["ok"], res)
        self.assertEqual(res["code"], "ROLE_NOT_RUN")
        self.assertEqual(P.StagingGeneration.list_ready(ns), [])

    def test_audit_core004_matching_ready_never_bypasses_named_prepare(self):
        for role in ("saitranslate", "saiwiki"):
            with self.subTest(role=role):
                root = Path(tempfile.mkdtemp(prefix="saipen-force-fresh-"))
                self.addCleanup(shutil.rmtree, root, True)
                namespace, package = self._publish_old_ready(root, role)
                ready, errors = P.StagingGeneration.scan_ready(namespace)
                self.assertEqual(errors, [])
                self.assertEqual(
                    [item.package_identity for item in ready], [package.package_identity]
                )
                with mock.patch(
                    "saipen_engine.subs.sub_sync",
                    return_value={"ok": True, "code": "SYNCED"},
                ), mock.patch(
                    "saipen_engine.subs.current_local_role_revision",
                    return_value="role-current",
                ), mock.patch.object(
                    intent,
                    "_prepare_producer_role",
                    return_value={"ok": False, "code": "ROLE_NOT_RUN"},
                ) as runner:
                    result = intent.ensure_producer_ready(
                        root, role, current_capability="full"
                    )
                self.assertEqual(result["code"], "ROLE_NOT_RUN")
                runner.assert_called_once_with(root, role)

    def test_audit_core004_each_stale_dimension_still_reaches_prepare(self):
        dimensions = {
            "source_head": {"head_suffix": "-stale"},
            "source_tree_fingerprint": {"tree_suffix": "-stale"},
            "role_revision": {"role_suffix": "-stale"},
        }
        for dimension, changes in dimensions.items():
            with self.subTest(dimension=dimension):
                root = Path(tempfile.mkdtemp(prefix="saipen-force-fresh-"))
                self.addCleanup(shutil.rmtree, root, True)
                self._publish_old_ready(root, "saitranslate", **changes)
                with mock.patch(
                    "saipen_engine.subs.sub_sync",
                    return_value={"ok": True, "code": "SYNCED"},
                ), mock.patch.object(
                    intent,
                    "_prepare_producer_role",
                    return_value={"ok": False, "code": "ROLE_NOT_RUN"},
                ) as runner:
                    result = intent.ensure_producer_ready(
                        root, "saitranslate", current_capability="full"
                    )
                self.assertEqual(result["code"], "ROLE_NOT_RUN")
                runner.assert_called_once_with(root, "saitranslate")

    def test_audit_core004_matching_ready_dry_run_plans_fresh_execution(self):
        root = Path(tempfile.mkdtemp(prefix="saipen-force-fresh-"))
        self.addCleanup(shutil.rmtree, root, True)
        self._publish_old_ready(root, "saiwiki")
        before = _hash_tree(root)
        result = intent.ensure_producer_ready(
            root, "saiwiki", dry_run=True, current_capability="full"
        )
        self.assertEqual(result["code"], "PREPARE_PLAN")
        self.assertEqual(_hash_tree(root), before)

    def test_cli_prepare_dry_run_keeps_existing_producer_trees_byte_identical(self):
        forbidden = (".prepare-staging", "SETTLED", "SUPERSEDED", "producer_epoch.json")
        for command, role in (("qq", "saiwiki"), ("ee", "saitranslate")):
            with self.subTest(command=command, role=role):
                temporary = tempfile.TemporaryDirectory(
                    prefix=f"saipen-{role}-dryrun-zero-write-"
                )
                self.addCleanup(temporary.cleanup)
                root = Path(temporary.name) / "project"
                self._scaffold_prepare_project(root)
                namespace = P.producer_namespace(root, role)
                sentinel = namespace / "kitchen" / "sentinel.txt"
                sentinel.parent.mkdir(parents=True, exist_ok=True)
                sentinel.write_text("owned producer bytes\n", encoding="utf-8")

                before = _hash_tree(root)
                rc, result = self._invoke_cli(root, command, "--dry-run")

                self.assertEqual(rc, 0, result)
                self.assertEqual(result["code"], "PREPARE_PLAN")
                self.assertEqual(result["route"], command)
                self.assertEqual(_hash_tree(root), before)
                for name in forbidden:
                    self.assertFalse((namespace / name).exists(), name)

    def test_audit_core005_malformed_producer_commands_are_zero_write(self):
        cases = (
            ("qq", "ensure_producer_ready"),
            ("ee", "ensure_producer_ready"),
            ("prepare-translate", "ensure_producer_ready"),
            ("qqq", "collect_and_ship_producer"),
            ("eee", "collect_and_ship_producer"),
            ("ship-wiki", "collect_and_ship_producer"),
            ("ship-translate", "collect_and_ship_producer"),
        )
        for command, handler_name in cases:
            with self.subTest(command=command):
                root = self._resume_fixture()
                before = _hash_tree(root)
                with mock.patch.object(
                    intent,
                    handler_name,
                    side_effect=AssertionError("malformed command reached handler"),
                ) as handler:
                    rc, result = self._invoke_cli(root, command, "SURPLUS")
                self.assertEqual(rc, 2)
                self.assertEqual(result["code"], "VALIDATION_FAILED")
                self.assertEqual(_hash_tree(root), before)
                handler.assert_not_called()

        for tail in (("saiwiki", "SURPLUS"), ("--unknown",)):
            with self.subTest(command="prepare " + " ".join(tail)):
                root = self._resume_fixture()
                before = _hash_tree(root)
                with mock.patch.object(
                    intent,
                    "ensure_producer_ready",
                    side_effect=AssertionError("malformed generic prepare reached handler"),
                ) as handler:
                    rc, result = self._invoke_cli(root, "prepare", *tail)
                self.assertEqual(rc, 2)
                self.assertEqual(result["code"], "VALIDATION_FAILED")
                self.assertEqual(_hash_tree(root), before)
                handler.assert_not_called()

    def test_audit_core005_exact_prepare_commands_keep_fixed_bindings(self):
        cases = (
            (("qq",), "saiwiki"),
            (("ee",), "saitranslate"),
            (("prepare-translate",), "saitranslate"),
            (("prepare",), "saiwiki"),
            (("prepare", "saitranslate"), "saitranslate"),
        )
        root = self._resume_fixture()
        before = _hash_tree(root)
        for command_args, expected_role in cases:
            with self.subTest(command=" ".join(command_args)):
                with mock.patch.object(
                    intent,
                    "ensure_producer_ready",
                    return_value={"ok": True, "code": "PREPARE_PROBE"},
                ) as handler:
                    rc, result = self._invoke_cli(root, *command_args, "--dry-run")
                self.assertEqual(rc, 0)
                self.assertEqual(result["code"], "PREPARE_PROBE")
                self.assertEqual(handler.call_args.args[:2], (root, expected_role))
        self.assertEqual(_hash_tree(root), before)

    def test_audit_core005_exact_ship_commands_keep_fixed_bindings(self):
        cases = (
            ("qqq", "saiwiki"),
            ("ship-wiki", "saiwiki"),
            ("eee", "saitranslate"),
            ("ship-translate", "saitranslate"),
        )
        root = self._resume_fixture()
        before = _hash_tree(root)
        for command, expected_role in cases:
            with self.subTest(command=command):
                with mock.patch.object(
                    intent,
                    "collect_and_ship_producer",
                    return_value={"ok": True, "code": "SHIP_PROBE"},
                ) as handler:
                    rc, result = self._invoke_cli(root, command, "--dry-run")
                self.assertEqual(rc, 0)
                self.assertEqual(result["code"], "SHIP_PROBE")
                self.assertEqual(handler.call_args.args[:2], (root, expected_role))
        self.assertEqual(_hash_tree(root), before)

    # AUDIT CORE-003: continue and crew are distinct persisted-intent routes.
    def test_audit_core003_goal_cc_and_continue_route_identically_without_writes(self):
        root = self._resume_fixture()
        before = _hash_tree(root)
        cc_rc, cc = self._invoke_cli(root, "cc", "--dry-run")
        continue_rc, continued = self._invoke_cli(root, "continue", "--dry-run")
        self.assertEqual(_hash_tree(root), before)
        self.assertEqual((cc_rc, continue_rc), (0, 0))
        self.assertEqual(cc["route"], "cc")
        self.assertNotIn("route", continued)
        self.assertEqual(
            {key: value for key, value in cc.items() if key != "route"},
            continued,
        )
        self.assertEqual(cc["execution_intent"], "goal")
        self.assertNotEqual(cc.get("code"), "CREW_DRY_PLAN")

    def test_audit_core003_converge_target_controls_resume_without_writes(self):
        for target, expected_action in (("ship", "saipen ship"), ("crew", "saipen crew")):
            with self.subTest(target=target):
                root = self._resume_fixture()
                self._set_fixture_intent(root, "converge", target)
                if target == "crew":
                    # `crew` convergence refuses while conformance is UNKNOWN,
                    # and absent is never assumed PASS: the fixture takes the
                    # canonical receipt through the front door the refusal
                    # names, after the intent makes its STATE legal.
                    rc, result = self._invoke_cli(root, "validate")
                    self.assertEqual(rc, 0, result)
                before = _hash_tree(root)
                rc, result = self._invoke_cli(root, "continue", "--dry-run")
                self.assertEqual(_hash_tree(root), before)
                self.assertEqual(rc, 0)
                self.assertEqual(result["execution_intent"], "converge")
                self.assertEqual(result["converge_target"], target)
                self.assertEqual(result["action"], expected_action)
                self.assertNotEqual(result.get("code"), "CREW_DRY_PLAN")

    def test_audit_core003_normal_cc_enters_done_convergence(self):
        root = self._resume_fixture()
        self._set_fixture_intent(root, "normal")
        rc, result = self._invoke_cli(root, "cc")
        state = S.parse_state((root / ".saipen" / "STATE.md").read_text(encoding="utf-8"))
        self.assertEqual(rc, 0, result)
        self.assertEqual(state["execution_intent"], "converge")
        self.assertEqual(state["converge_target"], "done")
        self.assertNotIn("goal_waves", state)
        self.assertNotIn("goal_tickets", state)
        # T-20260830_0842: normal cc on an empty actionable queue falls
        # through to the improvement-discovery path (bare `saipen improve`).
        # The result payload is the IMPROVE_AUDIT_ASSIGNMENT, not a
        # converge/done echo.  The state on disk IS converge/done (the
        # normal-intent convergence targets were committed before the
        # fallthrough), and the next cc would resume that improve seat.
        self.assertEqual(result.get("code"), "IMPROVE_AUDIT_ASSIGNMENT")
        self.assertIn("cycle_id", result)

    def test_audit_core003_normal_entry_refuses_intent_race_without_writes(self):
        root = self._resume_fixture()
        live_state = S.parse_state(
            (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        )
        stale_normal = dict(live_state)
        stale_normal["execution_intent"] = "normal"
        stale_normal.pop("goal_waves", None)
        stale_normal.pop("goal_tickets", None)
        before = _hash_tree(root)
        with mock.patch.object(CLI, "parse_state_or_error", return_value=(stale_normal, None)):
            rc, result = self._invoke_cli(root, "cc")
        self.assertEqual(rc, 1)
        self.assertEqual(result["code"], "STALE_STATE")
        self.assertEqual(_hash_tree(root), before)
        state = S.parse_state((root / ".saipen" / "STATE.md").read_text(encoding="utf-8"))
        self.assertEqual(state["execution_intent"], "goal")

    def test_audit_core003_tripped_goal_cc_reauthorizes_and_clears_wait(self):
        root = self._resume_fixture()
        state_path = root / ".saipen" / "STATE.md"
        text = S.patch_state(
            state_path.read_text(encoding="utf-8"),
            {
                "goal_waves": 3,
                "goal_tickets": 4,
                "next_action": (
                    "WAIT: safety valve reached (3 waves / 4 tickets) -- "
                    "run 'cc' to continue"
                ),
            },
        )
        state_path.write_text(text, encoding="utf-8", newline="\n")
        rc, result = self._invoke_cli(root, "cc")
        state = S.parse_state(state_path.read_text(encoding="utf-8"))
        self.assertEqual(rc, 0, result)
        self.assertEqual((state["goal_waves"], state["goal_tickets"]), (0, 0))
        self.assertFalse(state["next_action"].startswith("WAIT:"))
        self.assertEqual(result["execution_intent"], "goal")

    def test_audit_core003_cc_surplus_exact_and_sc_surplus_zero_write(self):
        for command, expected in (("cc", "Use: gg <objective>"), ("sc", None)):
            with self.subTest(command=command):
                root = self._resume_fixture()
                before = _hash_tree(root)
                rc, output = self._invoke_cli(root, command, "SURPLUS", as_json=False)
                self.assertEqual(rc, 2)
                self.assertEqual(_hash_tree(root), before)
                if expected is not None:
                    self.assertEqual(output, expected)

    def test_audit_core003_sc_and_crew_establish_equivalent_crew_intent(self):
        states = []
        for command in ("sc", "crew"):
            with self.subTest(command=command):
                root = self._resume_fixture()
                self._set_fixture_intent(root, "normal")
                state_path = root / ".saipen" / "STATE.md"
                state_path.write_text(
                    S.patch_state(
                        state_path.read_text(encoding="utf-8"),
                        {"saipen_home": str(TOOLS.parent)},
                    ),
                    encoding="utf-8",
                    newline="\n",
                )
                rc, result = self._invoke_cli(root, command)
                self.assertEqual(rc, 0, result)
                self.assertEqual(result["code"], "CREW_INTENT_SET")
                state = S.parse_state(state_path.read_text(encoding="utf-8"))
                states.append(
                    (state["execution_intent"], state["converge_target"], state["next_action"])
                )
        self.assertEqual(states, [("converge", "crew", "saipen crew")] * 2)

    # ── CORE-004: pending worker tickets survive failure ──────────────────
    def test_core004_no_destruction(self):
        root = Path(tempfile.mkdtemp())
        board = root / ".saipen" / "extensions" / "subs" / "saihunt" / "BOARD.md"
        board.parent.mkdir(parents=True)
        original = "# BOARD\n## TODO\n- [ ] HUNT-777 preserve this work\n## DONE\n- [x] old work\n"
        board.write_text(original, encoding="utf-8")
        fixed = intent._auto_repair_role(root, "saihunt")
        self.assertFalse(fixed)
        after = board.read_text(encoding="utf-8")
        self.assertEqual(original, after)
        self.assertIn("HUNT-777", after)
        self.assertIn("## TODO", after)

    # ── CORE-005: recovery locks the canonical ProducerLock ────────────────
    def test_core005_recover_live_writer_no_delete(self):
        for producer in ("saitranslate", "saiwiki"):
            with self.subTest(producer=producer):
                root = Path(tempfile.mkdtemp())
                (root / ".saipen").mkdir()
                ns = P.producer_namespace(root, producer)
                ns.mkdir(parents=True)
                gen = P.StagingGeneration(ns, producer).begin()
                # Live writer holds the CANONICAL producer lock.
                with P.ProducerLock(root, producer):
                    report = P.StagingGeneration.recover(ns)
                    self.assertTrue(report["busy"], "recovery must no-op while writer holds lock")
                    self.assertTrue(gen.staging_dir.is_dir(), "live generation must survive")
                # Writer released; a takeover advances the epoch -> generation stale.
                P.ProducerEpoch.claim(ns)
                report = P.StagingGeneration.recover(ns)
                self.assertFalse(report["busy"])
                self.assertIn(gen.generation_id, report["removed_staging"])
                self.assertFalse(gen.staging_dir.is_dir())

    # ── CORE-006: saitranslate uses the canonical namespace ───────────────
    def test_core006_saitranslate_namespace(self):
        root = Path(tempfile.mkdtemp())
        self.assertEqual(intent._role_dir(root, "saitranslate"), root / ".saipen" / "saitranslate")
        self.assertEqual(intent._role_dir(root, "saiwiki"), P.producer_namespace(root, "saiwiki"))
        self.assertEqual(intent._role_dir(root, "saihunt"), root / SUBS_REL / "saihunt")
        self._scaffold_prepare_project(root)
        # Dry-run ensure for a missing saitranslate instance must plan via the
        # canonical branch and NEVER hit the outdated sub_spawn signature.
        res = intent.ensure_producer_ready(root, "saitranslate", dry_run=True)
        self.assertEqual(res["code"], "PRODUCER_SPAWN_PLAN")

    # ── CORE-007: every planner action maps to one executor/refusal ─────────
    def test_core007_no_unknown_action(self):
        root = Path(tempfile.mkdtemp())
        agent = "tester"
        home = str(root)
        safe = {
            "RUN_ROLE": "saihunt",
            "COLLECT_ROLE": "saihunt",
            "CONVERGE_CORE": None,
            "RECOVER": None,
            "REVIEW_CORE": "saihunt",
            "PREPARE_TRANSLATE": None,
            "PREPARE_TRANSLATE_FINAL": None,
            "PREPARE_WIKI": None,
            "PREPARE_WIKI_FINAL": None,
            "INTEGRATE_TRANSLATE": None,
            "INTEGRATE_WIKI": None,
            "SYNC_SHARED": None,
            "SPAWN_ROLE": "saihunt",
            "ADOPT_ROLE": "saihunt",
            "FINALIZE": None,
            "DEFER_FOR_CREW": None,
            "CLEAR_WAIT_ROLE": None,
            "DISPOSE_REVIEW": None,
            "REVERIFY_FIXED_POINT": None,
            "SHIP": None,
            "CONTINUE_CORE": None,
        }
        for at, role in safe.items():
            r = intent._execute_crew_action(root, at, role, "full", agent, home, dry_run=False)
            code = r.code if hasattr(r, "code") else r.get("code")
            self.assertNotEqual(code, "UNKNOWN_ACTION", f"{at} must not be UNKNOWN_ACTION")
            self.assertNotEqual(code, "UNHANDLED_ACTION", f"{at} must be handled")
        # A genuinely unknown action fails closed as UNHANDLED_ACTION, never
        # as UNKNOWN_ACTION (which would silently stall the loop).
        r = intent._execute_crew_action(root, "NONSENSE_X", None, "full", agent, home)
        code = r.code if hasattr(r, "code") else r.get("code")
        self.assertEqual(code, "UNHANDLED_ACTION")

    def test_core007_targeted_shortcuts_are_ready_only(self):
        root = Path(tempfile.mkdtemp())
        (root / ".saipen").mkdir()
        wiki = intent.collect_and_ship_producer(
            root, "saiwiki", dry_run=True, current_capability="full"
        )
        translate = intent.collect_and_ship_producer(
            root, "saitranslate", dry_run=True, current_capability="full"
        )
        self.assertEqual(wiki["message"], "Not ready: run qq first.")
        self.assertEqual(translate["message"], "Not ready: run ee first.")
        self.assertFalse((root / ".saipen" / "extensions").exists())

    def test_review_durable_epoch_corruption_never_downgrades_to_legacy(self):
        root = Path(tempfile.mkdtemp())
        legacy_op = "converge_intent-" + "a" * 32
        records = (
            {
                "operation": "converge_intent",
                "status": "COMMITTED",
                "created_at": "2026-08-21T00:00:00Z",
                "op_id": legacy_op,
                "receipt_metadata": {
                    "operation": "converge_intent",
                    "target": "crew",
                    "status": "COMMITTED",
                },
            },
        )
        history = SimpleNamespace(events=())
        legacy = C._crew_epoch(root, history, records)
        self.assertIsNotNone(legacy)
        self.assertEqual(legacy.op_id, legacy_op)

        carrier = root / ".saipen" / "kitchen" / "crew_epoch.json"
        carrier.parent.mkdir(parents=True)
        carrier.write_text("{}\n", encoding="utf-8")
        self.assertIsNone(C._crew_epoch(root, history, records))

    def test_review_durable_epoch_carrier_is_strict_project_authority(self):
        root = Path(tempfile.mkdtemp())
        saipen = root / ".saipen"
        carrier = saipen / "kitchen" / "crew_epoch.json"
        carrier.parent.mkdir(parents=True)
        lineage = "lineage-" + "1" * 32
        (saipen / "IDENTITY.md").write_text(
            f"---\nproject_lineage: {lineage}\n---\n", encoding="utf-8"
        )
        canonical = {
            "schema_version": 1,
            "operation": "crew_epoch",
            "op_id": "converge_intent-" + "b" * 32,
            "target": "crew",
            "status": "COMMITTED",
            "created_at": "2026-08-21T00:00:00Z",
            "project_lineage": lineage,
            "ticket_id": "T-9",
        }
        carrier.write_text(json.dumps(canonical) + "\n", encoding="utf-8")
        self.assertEqual(C.read_durable_crew_epoch(root), canonical)

        duplicate = json.dumps(canonical)[:-1] + ', "op_id": "duplicate"}\n'
        carrier.write_text(duplicate, encoding="utf-8")
        with self.assertRaisesRegex(C.CrewEpochCarrierError, "repeats field"):
            C.read_durable_crew_epoch(root)

        foreign = {**canonical, "project_lineage": "lineage-" + "2" * 32}
        carrier.write_text(json.dumps(foreign) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(C.CrewEpochCarrierError, "does not match"):
            C.read_durable_crew_epoch(root)

    def test_review_durable_epoch_refuses_symlinked_ancestor(self):
        temporary = tempfile.TemporaryDirectory(prefix="saipen-epoch-link-")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        root = base / "project"
        outside = base / "outside"
        (root / ".saipen").mkdir(parents=True)
        outside.mkdir()
        (outside / "crew_epoch.json").write_text("{}\n", encoding="utf-8")
        try:
            os.symlink(outside, root / ".saipen" / "kitchen", target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"directory symlinks unavailable: {exc}")
        with self.assertRaisesRegex(C.CrewEpochCarrierError, "ancestor"):
            C.read_durable_crew_epoch(root)

    def test_review_durable_epoch_refuses_symlinked_project_identity(self):
        temporary = tempfile.TemporaryDirectory(prefix="saipen-identity-link-")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        root = base / "project"
        saipen = root / ".saipen"
        carrier = saipen / "kitchen" / "crew_epoch.json"
        carrier.parent.mkdir(parents=True)
        lineage = "lineage-" + "3" * 32
        outside_identity = base / "outside-identity.md"
        outside_identity.write_text(
            f"---\nproject_lineage: {lineage}\n---\n", encoding="utf-8"
        )
        try:
            os.symlink(outside_identity, saipen / "IDENTITY.md")
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"file symlinks unavailable: {exc}")
        carrier.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "operation": "crew_epoch",
                    "op_id": "converge_intent-" + "c" * 32,
                    "target": "crew",
                    "status": "COMMITTED",
                    "created_at": "2026-08-21T00:00:00Z",
                    "project_lineage": lineage,
                }
            )
            + "\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(C.CrewEpochCarrierError, "project_lineage"):
            C.read_durable_crew_epoch(root)

    def test_review_project_identity_descriptor_rejects_lstat_open_pivot(self):
        temporary = tempfile.TemporaryDirectory(prefix="saipen-identity-race-")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        root = base / "project"
        identity = root / ".saipen" / "IDENTITY.md"
        identity.parent.mkdir(parents=True)
        original_lineage = "lineage-" + "4" * 32
        external_lineage = "lineage-" + "5" * 32
        identity.write_text(
            f"---\nproject_lineage: {original_lineage}\n---\n", encoding="utf-8"
        )
        external = base / "external-identity.md"
        external.write_text(
            f"---\nproject_lineage: {external_lineage}\n---\n", encoding="utf-8"
        )
        real_open = os.open
        pivoted = False

        def pivot_before_open(path, flags, *args, **kwargs):
            nonlocal pivoted
            if not pivoted and Path(path) == identity:
                pivoted = True
                identity.unlink()
                os.symlink(external, identity)
            return real_open(path, flags, *args, **kwargs)

        try:
            with mock.patch.object(PATHS.os, "open", side_effect=pivot_before_open):
                self.assertIsNone(PATHS.project_lineage_identity(root))
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"file symlinks unavailable: {exc}")
        self.assertTrue(pivoted)

    def test_review_descriptor_reader_rejects_short_concurrent_snapshot(self):
        temporary = tempfile.TemporaryDirectory(prefix="saipen-authority-short-read-")
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "authority.json"
        path.write_bytes(b"0123456789")
        expected = path.lstat()
        chunks = iter((b"0123", b""))

        read_patch = mock.patch.object(
            PATHS.os, "read", side_effect=lambda *_args: next(chunks)
        )
        with read_patch, self.assertRaisesRegex(ValueError, "changed while reading"):
            PATHS.read_bound_regular_bytes(path, expected, max_bytes=32)

    def test_review_targeted_collect_refuses_corrupt_epoch_before_any_write(self):
        root = Path(tempfile.mkdtemp())
        carrier = root / ".saipen" / "kitchen" / "crew_epoch.json"
        carrier.parent.mkdir(parents=True)
        carrier.write_text("{}\n", encoding="utf-8")
        package = mock.Mock(
            base_source_head="head",
            base_source_tree_fingerprint="tree",
            role_revision="role-rev",
            epoch=3,
            package_identity="sha256:" + "d" * 64,
        )
        source = mock.Mock(source_head="head", source_tree_fingerprint="tree")
        before = _hash_tree(root)
        with mock.patch.object(
            intent, "_targeted_producer_release_context", return_value=None
        ), mock.patch.object(
            P.StagingGeneration, "scan_ready", return_value=([package], [])
        ), mock.patch(
            "freshness.compute_source_identity", return_value=source
        ), mock.patch(
            "saipen_engine.subs.current_local_role_revision", return_value="role-rev"
        ), mock.patch(
            "saipen_engine.operations.ticket_add"
        ) as ticket_add, mock.patch.object(
            P, "integrate_packages_core"
        ) as integrate:
            result = intent.collect_and_ship_producer(
                root, "saitranslate", current_capability="full"
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "VALIDATION_FAILED")
        self.assertIn("durable crew epoch is corrupt", result["message"])
        ticket_add.assert_not_called()
        integrate.assert_not_called()
        self.assertEqual(_hash_tree(root), before)

    def test_review_crew_integrator_refuses_corrupt_epoch_before_payload(self):
        root = Path(tempfile.mkdtemp())
        carrier = root / ".saipen" / "kitchen" / "crew_epoch.json"
        carrier.parent.mkdir(parents=True)
        carrier.write_text("{}\n", encoding="utf-8")
        package = mock.Mock()
        before = _hash_tree(root)
        with mock.patch.object(
            P.StagingGeneration, "scan_ready", return_value=([package], [])
        ), mock.patch.object(P, "integrate_packages_core") as integrate:
            result = intent._integrate_producer(root, "saitranslate")
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "VALIDATION_FAILED")
        integrate.assert_not_called()
        self.assertEqual(_hash_tree(root), before)

    def test_core007_targeted_shortcuts_resume_own_ticket_not_crew(self):
        root = Path(tempfile.mkdtemp())
        context = {
            "ticket": "T-9",
            "package_identity": "sha256:" + "a" * 64,
            "integration_op_id": "producer-integrate-" + "a" * 32,
        }
        release_result = {"ok": True, "code": "RELEASED", "detail": "landed"}
        for role in ("saiwiki", "saitranslate"):
            with mock.patch.object(
                intent, "_targeted_producer_release_context", return_value=context
            ), mock.patch(
                "saipen_engine.release.plan_release", return_value="plan"
            ) as planner, mock.patch(
                "saipen_engine.release.execute_release", return_value=release_result
            ):
                result = intent.collect_and_ship_producer(
                    root, role, current_capability="full"
                )
            self.assertTrue(result["ok"])
            self.assertEqual(result["ticket"], "T-9")
            self.assertTrue(planner.call_args.kwargs["targeted_ticket"])
            self.assertEqual(planner.call_args.args[1], f"ship-{role}")

    def test_core007_targeted_collect_creates_ticket_before_review(self):
        root = Path(tempfile.mkdtemp())
        package = mock.Mock(
            base_source_head="head",
            base_source_tree_fingerprint="tree",
            role_revision="role-rev",
            epoch=3,
            package_identity="sha256:" + "c" * 64,
        )
        source = mock.Mock(source_head="head", source_tree_fingerprint="tree")
        integrated = {"results": [{"result": "INTEGRATED", "code": "CLEAN"}]}
        with mock.patch.object(
            intent, "_targeted_producer_release_context", return_value=None
        ), mock.patch.object(
            intent, "_active_core_ticket", return_value=None
        ), mock.patch.object(
            P.StagingGeneration, "scan_ready", return_value=([package], [])
        ), mock.patch(
            "freshness.compute_source_identity", return_value=source
        ), mock.patch(
            "saipen_engine.subs.current_local_role_revision", return_value="role-rev"
        ), mock.patch(
            "saipen_engine.operations.ticket_add",
            return_value={"ok": True, "code": "TICKET_ADDED", "ticket": "T-9"},
        ), mock.patch(
            "saipen_engine.operations.apply_claim",
            return_value={"ok": True, "code": "CLAIMED"},
        ), mock.patch(
            "saipen_engine.operations.transition_phase",
            return_value={"ok": True, "code": "TRANSITIONED"},
        ), mock.patch.object(
            P, "integrate_packages_core", return_value=integrated
        ) as integrate:
            result = intent.collect_and_ship_producer(
                root, "saitranslate", current_capability="full"
            )
        self.assertEqual(result["code"], "PRODUCER_REVIEW_REQUIRED")
        self.assertEqual(result["ticket"], "T-9")
        self.assertEqual(integrate.call_args.kwargs["ticket_id"], "T-9")

    def test_core007_targeted_release_context_requires_ticket_bound_receipt(self):
        root = Path(tempfile.mkdtemp())
        state_dir = root / ".saipen"
        state_dir.mkdir()
        state_dir.joinpath("STATE.md").write_text(
            "---\n"
            "phase: SHIP\n"
            "task: T-9\n"
            "next_action: PHASE SHIP T-9\n"
            "blocker: \"\"\n"
            "transition_from: REVIEW\n"
            "saipen_version: 7\n"
            "agent: test\n"
            "mode: full\n"
            "updated: 2026-08-21T00:00:00Z\n"
            "---\n",
            encoding="utf-8",
        )
        valid = {
            "status": "COMMITTED",
            "created_at": "2026-08-21T00:00:00Z",
            "op_id": "producer-integrate-" + "a" * 32,
            "receipt_metadata": {
                "producer": "saitranslate",
                "ticket_id": "T-9",
                "package_identity": "sha256:" + "b" * 64,
            },
        }
        with mock.patch(
            "saipen_engine.journal.semantic_receipts_for_operation", return_value=[valid]
        ):
            context = intent._targeted_producer_release_context(root, "saitranslate")
            wrong_role = intent._targeted_producer_release_context(root, "saiwiki")
        self.assertEqual(context["ticket"], "T-9")
        self.assertIsNone(wrong_role)

    def test_core007_crew_defer_accepts_canonical_epoch_shape(self):
        canonical = "converge_intent-" + "a" * 32
        self.assertTrue(operations._is_converge_intent_epoch(canonical))
        self.assertFalse(operations._is_converge_intent_epoch("crew-defer-" + "a" * 32))
        self.assertFalse(operations._is_converge_intent_epoch("converge_intent-" + "a" * 8))

    # ── CORE-008: producer dependency paths cannot escape the project ──────
    def test_core008_path_containment(self):
        root = Path(tempfile.mkdtemp())
        (root / "a.txt").write_text("hello", encoding="utf-8")
        # valid relative path
        self.assertEqual(P.read_set_from(root, ["a.txt"]), {"a.txt": P.file_sha256(root / "a.txt")})
        # POSIX absolute
        with self.assertRaises(P.ProducerError):
            P.read_set_from(root, ["/etc/passwd"])
        # parent traversal
        with self.assertRaises(P.ProducerError):
            P.read_set_from(root, ["../escape.txt"])
        # Windows drive (host-independent)
        with self.assertRaises(P.ProducerError):
            P.read_set_from(root, ["C:\\Windows\\win.ini"])
        # UNC
        with self.assertRaises(P.ProducerError):
            P.read_set_from(root, ["\\\\server\\share\\x"])
        # write_set_before shares the same gate
        with self.assertRaises(P.ProducerError):
            P.write_set_before(root, ["/abs"])
        # deserialization validates keys
        with self.assertRaises(P.ProducerError):
            P.ProducerPackage.from_dict(
                {
                    "producer": "saitranslate",
                    "role_revision": "r",
                    "base_source_head": "h",
                    "base_source_tree_fingerprint": "t",
                    "scope": "s",
                    "read_set": {"../x": "y"},
                    "write_set": {},
                }
            )
        # _live_hashes rejects escaping write_set
        pkg = P.build_package(
            producer="saitranslate",
            role_revision="r",
            base_source_head="h",
            base_source_tree_fingerprint="t",
            base_discovery_model="",
            scope="s",
            read_set={},
            write_set={"/abs": "z"},
        )
        with self.assertRaises(P.ProducerError):
            P._live_hashes(root, pkg)

    def test_perf001_progress_tracker_bounds_all_sequences(self):
        from saipen_engine.autonomy import ProgressTracker

        unchanged = ProgressTracker(max_iterations=20)
        self.assertTrue(unchanged.record("A", "RUN", "same", "OK"))
        self.assertTrue(unchanged.record("A", "RUN", "same", "OK"))
        self.assertFalse(unchanged.record("A", "RUN", "same", "OK"))
        self.assertEqual(unchanged.iterations, 3)

        alternating = ProgressTracker(max_iterations=20)
        outcomes = [
            alternating.record(label, "RUN", "cycle", "OK")
            for label in ("A", "B", "A", "B", "A", "B")
        ]
        self.assertFalse(outcomes[-1])
        self.assertEqual(alternating.iterations, 6)

        unique = ProgressTracker(max_iterations=5)
        outcomes = [unique.record(str(index), "RUN", "advance", "OK") for index in range(5)]
        self.assertEqual(outcomes, [True, True, True, True, False])
        self.assertEqual(unique.iterations, 5)

    def test_legacy_autonomous_loop_contract_is_crew_only(self):
        import saipen_engine.autonomy as autonomy

        loop_contract = intent.autonomous_crew_loop.__doc__ or ""
        tracker_contract = autonomy.__doc__ or ""
        self.assertIn("crew-only", loop_contract)
        # CORE-007: assert the semantic ownership invariant, not exact
        # whitespace. A harmless docstring reflow must not make the suite red;
        # a deliberate removal/reversal of the crew-only ownership statement
        # still fails.
        normalized = " ".join(loop_contract.split())
        self.assertIn(
            "does not own canonical continue/converge routing "
            "or targeted producer execution",
            normalized,
        )
        self.assertIn("legacy crew-only intent loop", tracker_contract)

    # ── CORE-010: conformance containment fails closed, no NameError ────────
    def test_core010_conformance_containment(self):
        root = Path(tempfile.mkdtemp())
        (root / ".saipen").mkdir()
        (root / ".saipen" / "recovery").mkdir()
        # No conformance dir at all: must be a no-op (returns None).
        self.assertIsNone(_validate_conformance_containment(root))
        # A regular (in-root) conformance dir: no error.
        (root / ".saipen" / "recovery" / "conformance").mkdir()
        self.assertIsNone(_validate_conformance_containment(root))
        # A symlinked conformance dir pointing OUTSIDE the root: must raise a
        # deterministic ValueError, never an unrelated NameError.
        outside = Path(tempfile.mkdtemp())
        link = root / ".saipen" / "recovery" / "conformance"
        try:
            if link.is_dir():
                link.rmdir()
            link.symlink_to(outside)
        except (OSError, NotImplementedError, PermissionError):
            self.skipTest("symlinks not supported on this host")
        with self.assertRaises(ValueError):
            _validate_conformance_containment(root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
