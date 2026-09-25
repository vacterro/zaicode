"""Focused global/effective USERPERSON regressions."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import userperson  # noqa: E402
from saipen_engine.paths import resolve_project_root  # noqa: E402
from saipen_engine import context  # noqa: E402
from saipen_engine import crew  # noqa: E402
from saipen_engine import subs  # noqa: E402
from saipen_engine.lock import file_writer_lock  # noqa: E402


class GlobalUserpersonTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.project = self.base / "project"
        (self.project / ".saipen").mkdir(parents=True)
        self.config = self.base / "config"
        self.context_project = self.base / "context-project"
        shutil.copytree(
            ROOT / "tests" / "scenarios" / "cold-handoff-continuity",
            self.context_project,
        )
        self.sub_project = self.base / "sub-project"
        shutil.copytree(ROOT / "tests" / "scenarios" / "saiui-adoption", self.sub_project)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_project(self, entries: list[dict]) -> None:
        userperson.profile_path(self.project).write_text(
            userperson.render_profile(entries), encoding="utf-8"
        )

    def _write_global(self, entries: list[dict]) -> None:
        self.config.mkdir(parents=True, exist_ok=True)
        userperson.global_profile_path(self.config).write_text(
            userperson.render_profile(entries), encoding="utf-8"
        )

    def _cli(self, cwd: Path, *args: str, dry_run: bool = False) -> subprocess.CompletedProcess:
        env = os.environ.copy()
        env[userperson.GLOBAL_CONFIG_ENV] = str(self.config)
        command = [sys.executable, str(ROOT / "tools" / "saipen.py"), *args, "--json"]
        if dry_run:
            command.append("--dry-run")
        return subprocess.run(
            command,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )

    def test_absence_is_inactive_and_creates_nothing(self) -> None:
        effective = userperson.effective_profile(self.project, self.config)
        self.assertFalse(effective["active"])
        self.assertEqual([], effective["preferences"])
        self.assertFalse(self.config.exists())

    def test_global_only_has_provenance(self) -> None:
        self._write_global([{"category": "UI", "text": "Golden"}])
        effective = userperson.effective_profile(self.project, self.config)
        self.assertTrue(effective["active"])
        self.assertTrue(effective["global"]["present"])
        self.assertFalse(effective["project"]["present"])
        self.assertEqual("global", effective["preferences"][0]["source"])

    def test_legacy_star_bullets_load_and_next_write_is_canonical(self) -> None:
        self.config.mkdir(parents=True)
        path = userperson.global_profile_path(self.config)
        path.write_text(
            "# USERPERSON\n\n"
            "* [UI] Golden\n\n"
            "* [Workflow] Small diffs\n",
            encoding="utf-8",
        )

        loaded = userperson.load_global_profile(self.config)
        self.assertEqual(["Golden", "Small diffs"], [p["text"] for p in loaded["preferences"]])

        result = userperson.mutate_global_profile(
            "add", text="Preserve data", category="Safety", user_config_home=self.config
        )
        self.assertTrue(result["ok"], result)
        rewritten = path.read_text(encoding="utf-8")
        self.assertNotIn("* [", rewritten)
        self.assertIn("- [UI] Golden", rewritten)
        self.assertIn("- [Safety] Preserve data", rewritten)

    def test_platform_path_resolution_is_deterministic_and_never_dot_saipen(self) -> None:
        windows = userperson.user_config_home(
            environ={"APPDATA": str(self.base / "roaming")},
            platform="nt",
            home=self.base / "home",
        )
        posix = userperson.user_config_home(
            environ={"XDG_CONFIG_HOME": str(self.base / "xdg")},
            platform="posix",
            home=self.base / "home",
        )
        fallback = userperson.user_config_home(
            environ={}, platform="posix", home=self.base / "home"
        )
        self.assertEqual((self.base / "roaming" / "SAIPEN").resolve(), windows)
        self.assertEqual((self.base / "xdg" / "saipen").resolve(), posix)
        self.assertEqual((self.base / "home" / ".config" / "saipen").resolve(), fallback)
        self.assertNotIn(".saipen", {windows.name, posix.name, fallback.name})

    def test_project_only_has_provenance(self) -> None:
        self._write_project([{"category": "Workflow", "text": "Small diffs"}])
        effective = userperson.effective_profile(self.project, self.config)
        self.assertEqual("project", effective["preferences"][0]["source"])

    def test_unrelated_layers_survive_project_first(self) -> None:
        self._write_global([{"category": "UI", "text": "Golden"}])
        self._write_project([{"category": "Workflow", "text": "Small diffs"}])
        effective = userperson.effective_profile(self.project, self.config)
        self.assertEqual(["project", "global"], [p["source"] for p in effective["preferences"]])

    def test_exact_duplicate_collapses_to_project(self) -> None:
        entry = {"category": "UI", "text": "Golden"}
        self._write_global([entry])
        self._write_project([entry])
        effective = userperson.effective_profile(self.project, self.config)
        self.assertEqual(1, len(effective["preferences"]))
        self.assertEqual("project", effective["preferences"][0]["source"])

    def test_lexical_conflict_is_not_semantically_deduplicated(self) -> None:
        self._write_global([{"category": "UI", "text": "Golden"}])
        self._write_project([{"category": "UI", "text": "Material"}])
        effective = userperson.effective_profile(self.project, self.config)
        self.assertEqual({"Golden", "Material"}, {p["text"] for p in effective["preferences"]})

    def test_effective_fingerprint_includes_layer_provenance(self) -> None:
        entry = {"category": "UI", "text": "Golden"}
        self._write_global([entry])
        global_only = userperson.effective_profile(self.project, self.config)[
            "effective_fingerprint"
        ]
        userperson.global_profile_path(self.config).unlink()
        self._write_project([entry])
        project_only = userperson.effective_profile(self.project, self.config)[
            "effective_fingerprint"
        ]
        self._write_global([entry])
        both = userperson.effective_profile(self.project, self.config)["effective_fingerprint"]
        self.assertEqual(3, len({global_only, project_only, both}))

    def test_malformed_global_refuses_before_mutation(self) -> None:
        self.config.mkdir(parents=True)
        path = userperson.global_profile_path(self.config)
        original = "# USERPERSON\nnot-a-bullet\n"
        path.write_text(original, encoding="utf-8")
        with self.assertRaises(userperson.UserpersonError):
            userperson.mutate_global_profile(
                "add", text="new", category="UI", user_config_home=self.config
            )
        self.assertEqual(original, path.read_text(encoding="utf-8"))
        self.assertFalse((self.config / "locks").exists())

    def test_empty_global_category_or_preference_is_malformed(self) -> None:
        self.config.mkdir(parents=True)
        path = userperson.global_profile_path(self.config)
        for body, expected in (
            ("- [ ] category missing", "category must not be empty"),
            ("- [UI]", "preference text must not be empty"),
        ):
            path.write_text(f"# USERPERSON\n\n{body}\n", encoding="utf-8")
            with self.subTest(body=body), self.assertRaises(
                userperson.UserpersonError
            ) as caught:
                userperson.load_global_profile(self.config)
            self.assertEqual("USERPERSON_MALFORMED", caught.exception.code)
            self.assertIn(expected, caught.exception.detail)

    def test_profile_directory_is_refused_as_external_content(self) -> None:
        userperson.global_profile_path(self.config).mkdir(parents=True)
        with self.assertRaises(userperson.UserpersonError) as caught:
            userperson.load_global_profile(self.config)
        self.assertEqual("USERPERSON_PATH_INVALID", caught.exception.code)

    def test_global_cli_works_outside_project(self) -> None:
        outside = self.base / "ordinary"
        outside.mkdir()
        added = self._cli(outside, "userperson", "add", "Golden", "--category", "UI", "--global")
        self.assertEqual(0, added.returncode, added.stderr + added.stdout)
        payload = json.loads(added.stdout)
        self.assertEqual("global", payload["scope"])
        shown = self._cli(outside, "userperson", "show", "--global")
        self.assertEqual(0, shown.returncode, shown.stderr + shown.stdout)
        self.assertEqual("Golden", json.loads(shown.stdout)["preferences"][0]["text"])
        self.assertFalse((outside / ".saipen").exists())

    def test_global_show_absent_creates_nothing(self) -> None:
        outside = self.base / "ordinary"
        outside.mkdir()
        shown = self._cli(outside, "userperson", "show", "--global")
        self.assertEqual(0, shown.returncode, shown.stderr + shown.stdout)
        self.assertEqual("EMPTY", json.loads(shown.stdout)["code"])
        self.assertFalse(self.config.exists())

    def test_global_text_show_redacts_manually_present_credential(self) -> None:
        self.config.mkdir(parents=True)
        secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ab"
        userperson.global_profile_path(self.config).write_text(
            f"# USERPERSON\n\n- [UI] never print {secret}\n", encoding="utf-8"
        )
        outside = self.base / "ordinary"
        outside.mkdir()
        env = os.environ.copy()
        env[userperson.GLOBAL_CONFIG_ENV] = str(self.config)
        shown = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "saipen.py"),
                "userperson",
                "show",
                "--global",
            ],
            cwd=outside,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        self.assertEqual(0, shown.returncode, shown.stderr + shown.stdout)
        self.assertNotIn(secret, shown.stdout)
        self.assertIn("ghp_***ab", shown.stdout)

    def test_global_credential_is_redacted_before_persistence(self) -> None:
        outside = self.base / "ordinary"
        outside.mkdir()
        secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ab"
        added = self._cli(
            outside,
            "userperson",
            "add",
            f"never print {secret}",
            "--global",
        )
        self.assertEqual(0, added.returncode, added.stderr + added.stdout)
        persisted = userperson.global_profile_path(self.config).read_text(encoding="utf-8")
        self.assertNotIn(secret, persisted)
        self.assertIn("ghp_***ab", persisted)

    def test_effective_outside_project_refuses(self) -> None:
        outside = self.base / "ordinary"
        outside.mkdir()
        result = self._cli(outside, "userperson", "show", "--effective")
        self.assertEqual(3, result.returncode)
        self.assertEqual("NOT_SAIPEN_PROJECT", json.loads(result.stdout)["code"])

    def test_scope_conflict_refuses_without_writes(self) -> None:
        outside = self.base / "ordinary"
        outside.mkdir()
        result = self._cli(
            outside, "userperson", "add", "Golden", "--global", "--project"
        )
        self.assertEqual(2, result.returncode)
        self.assertFalse(self.config.exists())
        self.assertFalse((outside / ".saipen").exists())

    def test_effective_mutation_refuses_without_writes(self) -> None:
        result = self._cli(
            self.project, "userperson", "add", "Golden", "--effective"
        )
        self.assertEqual(2, result.returncode)
        self.assertFalse(self.config.exists())
        self.assertFalse(userperson.profile_path(self.project).exists())

    def test_global_dry_run_creates_nothing(self) -> None:
        outside = self.base / "ordinary"
        outside.mkdir()
        result = self._cli(
            outside,
            "userperson",
            "add",
            "Golden",
            "--global",
            dry_run=True,
        )
        self.assertEqual(0, result.returncode, result.stderr + result.stdout)
        self.assertFalse(self.config.exists())

    def test_global_remove_absent_stays_off_and_creates_nothing(self) -> None:
        outside = self.base / "ordinary"
        outside.mkdir()
        result = self._cli(outside, "userperson", "remove", "missing", "--global")
        self.assertEqual(0, result.returncode, result.stderr + result.stdout)
        self.assertEqual("UNCHANGED", json.loads(result.stdout)["code"])
        self.assertFalse(self.config.exists())

    def test_global_reset_dry_run_changes_nothing_and_creates_no_lock(self) -> None:
        self._write_global([{"category": "UI", "text": "Global"}])
        path = userperson.global_profile_path(self.config)
        before = path.read_bytes()
        result = self._cli(
            self.project,
            "userperson",
            "reset",
            "--global",
            "--confirm",
            dry_run=True,
        )
        self.assertEqual(0, result.returncode, result.stderr + result.stdout)
        self.assertEqual(before, path.read_bytes())
        self.assertFalse((self.config / "locks").exists())

    def test_global_writer_busy_is_controlled(self) -> None:
        lock_path = self.config / "locks" / "userperson.lock"
        with file_writer_lock(lock_path, self.config):
            result = userperson.mutate_global_profile(
                "add", text="Golden", user_config_home=self.config
            )
        self.assertFalse(result["ok"])
        self.assertEqual("WRITER_BUSY", result["code"])
        self.assertFalse(userperson.global_profile_path(self.config).exists())

    def test_global_reset_does_not_touch_project(self) -> None:
        project_text = userperson.render_profile([{"category": "UI", "text": "Project"}])
        self._write_project([{"category": "UI", "text": "Project"}])
        self._write_global([{"category": "UI", "text": "Global"}])
        reset = self._cli(
            self.project, "userperson", "reset", "--global", "--confirm"
        )
        self.assertEqual(0, reset.returncode, reset.stderr + reset.stdout)
        self.assertFalse(userperson.global_profile_path(self.config).exists())
        self.assertEqual(
            project_text, userperson.profile_path(self.project).read_text(encoding="utf-8")
        )

    def test_global_reset_requires_confirmation(self) -> None:
        self._write_global([{"category": "UI", "text": "Global"}])
        result = self._cli(self.project, "userperson", "reset", "--global")
        self.assertEqual(1, result.returncode)
        self.assertEqual(
            "DESTRUCTIVE_CONFIRMATION_REQUIRED", json.loads(result.stdout)["code"]
        )
        self.assertTrue(userperson.global_profile_path(self.config).is_file())

    def test_malformed_global_cli_is_controlled_without_traceback(self) -> None:
        self.config.mkdir(parents=True)
        userperson.global_profile_path(self.config).write_text(
            "# USERPERSON\nnot-a-bullet\n", encoding="utf-8"
        )
        outside = self.base / "ordinary"
        outside.mkdir()
        result = self._cli(outside, "userperson", "show", "--global")
        self.assertEqual(1, result.returncode)
        payload = json.loads(result.stdout)
        self.assertEqual("USERPERSON_MALFORMED", payload["code"])
        self.assertNotIn("Traceback", result.stderr + result.stdout)

    def test_malformed_global_context_is_controlled_without_traceback(self) -> None:
        self.config.mkdir(parents=True)
        userperson.global_profile_path(self.config).write_text(
            "# USERPERSON\nnot-a-bullet\n", encoding="utf-8"
        )
        with mock.patch.dict(
            os.environ, {userperson.GLOBAL_CONFIG_ENV: str(self.config)}, clear=False
        ):
            result = context.context_cold(self.context_project)
        self.assertFalse(result.ok)
        self.assertEqual("VALIDATION_FAILED", result.code)
        self.assertEqual("USERPERSON_MALFORMED", result.get("userperson_code"))

    def test_project_validator_does_not_consume_global_profile(self) -> None:
        source = (ROOT / "tools" / "validate.py").read_text(encoding="utf-8")
        self.assertNotIn("load_global_profile", source)
        self.assertNotIn("effective_profile", source)
        self.assertNotIn(userperson.GLOBAL_CONFIG_ENV, source)

    def test_global_config_never_poison_project_root(self) -> None:
        self._write_global([{"category": "UI", "text": "Golden"}])
        ordinary = self.base / "home" / "work" / "plain"
        ordinary.mkdir(parents=True)
        root, _reason = resolve_project_root(ordinary)
        self.assertIsNone(root)
        self.assertNotEqual(self.config, root)

    def test_effective_projection_is_bounded_and_keeps_provenance(self) -> None:
        self._write_global(
            [
                {"category": "UI", "text": "Golden"},
                {"category": "Language", "text": "Estonian"},
                {"category": "Communication", "text": "Short prose"},
            ]
        )
        self._write_project(
            [
                {"category": "Workflow", "text": "Small diffs"},
                {"category": "Automation", "text": "Continue safely"},
                {"category": "Documentation", "text": "Exact examples"},
                {"category": "Localization", "text": "Keep Unicode"},
            ]
        )
        ui = userperson.effective_projection(self.project, "saiui", self.config)
        hunt = userperson.effective_projection(self.project, "saihunt", self.config)
        wiki = userperson.effective_projection(self.project, "saiwiki", self.config)
        translate = userperson.effective_projection(
            self.project, "saitranslate", self.config
        )
        self.assertEqual({"UI", "Workflow"}, {p["category"] for p in ui["preferences"]})
        self.assertEqual({"Automation"}, {p["category"] for p in hunt["preferences"]})
        self.assertEqual(
            {"Documentation", "Communication"},
            {p["category"] for p in wiki["preferences"]},
        )
        self.assertEqual(
            {"Localization", "Language"},
            {p["category"] for p in translate["preferences"]},
        )
        projected = (
            ui["preferences"]
            + hunt["preferences"]
            + wiki["preferences"]
            + translate["preferences"]
        )
        self.assertTrue(all("source" in p for p in projected))

    def test_context_absence_is_silent(self) -> None:
        with mock.patch.dict(
            os.environ, {userperson.GLOBAL_CONFIG_ENV: str(self.config)}, clear=False
        ):
            cold = context.context_cold(self.context_project)
        self.assertTrue(cold.ok, cold.to_dict())
        self.assertNotIn("## USERPERSON", cold.get("surface", ""))
        self.assertFalse(self.config.exists())

    def test_context_and_brief_expose_compact_activation_only(self) -> None:
        huge = "x" * 100_000
        self._write_global([{"category": "UI", "text": huge}])
        with mock.patch.dict(
            os.environ, {userperson.GLOBAL_CONFIG_ENV: str(self.config)}, clear=False
        ):
            cold = context.context_cold(self.context_project)
            hot = context.context_hot(self.context_project)
            brief = context.brief_projection(self.context_project)
        for surface in (cold.get("surface", ""), hot.get("surface", "")):
            self.assertIn("## USERPERSON", surface)
            self.assertIn("saipen userperson show --effective --json", surface)
            self.assertNotIn(huge, surface)
        self.assertTrue(brief.get("json")["userperson"]["active"])
        self.assertNotIn(huge, brief.get("surface", ""))

    def test_context_audit_accounts_each_active_source_once(self) -> None:
        self._write_global([{"category": "UI", "text": "Golden"}])
        userperson.profile_path(self.context_project).write_text(
            userperson.render_profile([{"category": "Workflow", "text": "Small diffs"}]),
            encoding="utf-8",
        )
        with mock.patch.dict(
            os.environ, {userperson.GLOBAL_CONFIG_ENV: str(self.config)}, clear=False
        ):
            audit = context.context_audit(self.context_project)
        self.assertTrue(audit.ok, audit.to_dict())
        rows = {row["source"]: row for row in audit.get("sources")}
        names = list(rows)
        self.assertEqual(1, names.count("global USERPERSON"))
        self.assertEqual(1, names.count("project USERPERSON"))
        self.assertEqual(
            userperson.global_profile_path(self.config).stat().st_size,
            rows["global USERPERSON"]["bytes"],
        )
        self.assertEqual(
            userperson.profile_path(self.context_project).stat().st_size,
            rows["project USERPERSON"]["bytes"],
        )

    def test_real_sub_status_carries_bounded_effective_projection(self) -> None:
        self._write_global(
            [
                {"category": "UI", "text": "Golden"},
                {"category": "Language", "text": "Estonian"},
            ]
        )
        userperson.profile_path(self.sub_project).write_text(
            userperson.render_profile(
                [
                    {"category": "Workflow", "text": "Small diffs"},
                    {"category": "Automation", "text": "Continue safely"},
                ]
            ),
            encoding="utf-8",
        )
        with mock.patch.dict(
            os.environ, {userperson.GLOBAL_CONFIG_ENV: str(self.config)}, clear=False
        ):
            result = subs.sub_status(self.sub_project, "saiui")
        self.assertTrue(result.ok, result.to_dict())
        projection = result.get("userperson_projection")
        self.assertEqual({"UI", "Workflow"}, {p["category"] for p in projection["preferences"]})
        self.assertTrue(all("source" in p for p in projection["preferences"]))
        self.assertNotIn("Language", {p["category"] for p in projection["preferences"]})

    def test_inactive_sub_status_keeps_legacy_surface(self) -> None:
        with mock.patch.dict(
            os.environ, {userperson.GLOBAL_CONFIG_ENV: str(self.config)}, clear=False
        ):
            result = subs.sub_status(self.sub_project, "saiui")
        self.assertTrue(result.ok, result.to_dict())
        self.assertNotIn("userperson_projection", result.to_dict())

    def test_malformed_global_sub_status_is_controlled(self) -> None:
        self.config.mkdir(parents=True)
        userperson.global_profile_path(self.config).write_text(
            "# USERPERSON\nnot-a-bullet\n", encoding="utf-8"
        )
        with mock.patch.dict(
            os.environ, {userperson.GLOBAL_CONFIG_ENV: str(self.config)}, clear=False
        ):
            result = subs.sub_status(self.sub_project, "saiui")
        self.assertFalse(result.ok)
        self.assertEqual("VALIDATION_FAILED", result.code)
        self.assertEqual("USERPERSON_MALFORMED", result.get("userperson_code"))

    def test_malformed_global_refuses_crew_before_project_mutation(self) -> None:
        self.config.mkdir(parents=True)
        userperson.global_profile_path(self.config).write_text(
            "# USERPERSON\nnot-a-bullet\n", encoding="utf-8"
        )
        canonical = [
            self.context_project / ".saipen" / name
            for name in ("STATE.md", "BOARD.md", "LOG.md")
        ]
        before = {path: path.read_bytes() for path in canonical}
        with mock.patch.dict(
            os.environ, {userperson.GLOBAL_CONFIG_ENV: str(self.config)}, clear=False
        ):
            result = crew.crew_apply(
                self.context_project,
                current_capability="full",
                current_agent="test",
            )
        self.assertFalse(result.ok)
        self.assertEqual("VALIDATION_FAILED", result.code)
        self.assertEqual("USERPERSON_MALFORMED", result.get("userperson_code"))
        self.assertEqual(before, {path: path.read_bytes() for path in canonical})


if __name__ == "__main__":
    unittest.main()
