"""Continuation handoff and host diagnostic liveness, independent of model prose."""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import test_continue_improve_fallthrough as fixtures  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


PLUGIN = REPO / "extensions/adapters/opencode/saipen-guard.js"
NODE = shutil.which("node")


class ContinueEntryTests(unittest.TestCase):
    def setUp(self):
        fixtures.ContinueImproveFallthroughTests.setUp(self)

    def test_resume_aliases_name_the_routed_phase_in_both_install_layouts(self):
        flat = tempfile.TemporaryDirectory(prefix="saipen-flat-")
        self.addCleanup(flat.cleanup)
        flat_home = Path(flat.name)
        shutil.copytree(REPO / "saipen", flat_home, dirs_exist_ok=True)
        (flat_home / "extensions/subs").mkdir(parents=True)
        shutil.copy2(
            REPO / "extensions/subs/PROTOCOL.md", flat_home / "extensions/subs/PROTOCOL.md"
        )
        for home in (REPO, flat_home):
            for command in ("continue", "cc", ""):
                with self.subTest(home=home, command=command):
                    root = fixtures.ContinueImproveFallthroughTests._make(
                        self, "queued", board=fixtures.ContinueImproveFallthroughTests._board(
                            todo="- [ ] T-001 [P1] queued | verify: test\n"
                        ), state_overrides={"saipen_home": json.dumps(str(home))},
                    )
                    before = {p.name: p.read_bytes() for p in (root / ".saipen").iterdir()}
                    args = [command] if command else []
                    rc, out = fixtures._invoke_cli(root, *args, "--dry-run")
                    self.assertEqual(rc, 0, out)
                    self.assertEqual(out["action"], "PHASE SCOUT T-001")
                    protocol = REPO / "saipen" if home == REPO else flat_home
                    self.assertEqual(out.get("load_path"), str(protocol / "phases/scout.md"))
                    self.assertEqual(out["cold_route"]["project_root"], str(root.resolve()))
                    self.assertFalse(out["cold_route"]["search_required"])
                    self.assertIn("not completion evidence", out["execution_instruction"])
                    self.assertEqual(before, {
                        p.name: p.read_bytes() for p in (root / ".saipen").iterdir()
                    })

    def test_text_route_also_tells_agent_what_to_open_and_execute(self):
        root = fixtures.ContinueImproveFallthroughTests._make(
            self, "text", board=fixtures.ContinueImproveFallthroughTests._board(
                todo="- [ ] T-001 [P1] queued | verify: test\n"
            ), state_overrides={"saipen_home": json.dumps(str(REPO))},
        )
        rc, out = fixtures._invoke_cli(root, "continue", "--dry-run", as_json=False)
        self.assertEqual(rc, 0, out)
        self.assertIn("load_path:", out)
        self.assertIn("execution_instruction:", out)


@unittest.skipUnless(NODE, "node runtime unavailable")
class OpenCodeEntryTests(unittest.TestCase):
    def _probe(self, script: str, *, stale: bool = False):
        with tempfile.TemporaryDirectory(prefix="saipen-entry-") as temp:
            root = Path(temp)
            plugin = root / "guard.mjs"
            shutil.copy2(PLUGIN, plugin)
            skill = root / "skill"
            (skill / "tools").mkdir(parents=True)
            (skill / "tools/saipen.py").write_text(
                'import json, sys\n'
                'print(json.dumps({"code": "NOT_SAIPEN_PROJECT"}) '
                'if "guard" in sys.argv else "CURRENT_CLI")\n', encoding="utf-8",
            )
            current_bin = skill / "bin"
            current_bin.mkdir()
            cli = skill / "tools/saipen.py"

            def dq(value):
                return '"' + str(value) + '"'

            (current_bin / "saipen.cmd").write_text(
                "@echo off\r\n" + dq(sys.executable) + " " + dq(cli) + " %*\r\n",
                encoding="utf-8", newline="",
            )
            posix = current_bin / "saipen"
            posix.write_text(
                "#!/bin/sh\nexec " + dq(sys.executable) + " " + dq(cli) + ' "$@"\n',
                encoding="utf-8", newline="",
            )
            posix.chmod(0o755)
            competing = root / "old"
            competing.mkdir()
            (competing / "saipen.cmd").write_text("@echo STALE_CLI\n", encoding="utf-8")
            old_posix = competing / "saipen"
            old_posix.write_text("#!/bin/sh\necho STALE_CLI\n", encoding="utf-8")
            old_posix.chmod(0o755)
            env = {**os.environ, "SAIPEN_SKILL_ROOT": str(skill), "SAIPEN_PYTHON": sys.executable}
            for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT",
                        "SAIPEN_GUARD_STARTUP_PROBE"):
                env.pop(key, None)
            env["PATH"] = os.pathsep.join((str(competing), env.get("PATH", ""), str(current_bin)))
            driver = r'''
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { default: factory } = await import(pathToFileURL(process.argv[1]).href);
const hooks = await factory({ directory: process.cwd() });
''' + ('fs.appendFileSync(process.argv[1], "// replacement");\n' if stale else "") + script
            proc = subprocess.run(
                [NODE, "--input-type=module", "-e", driver, str(plugin)],
                cwd=root, env=env, capture_output=True, text=True, timeout=40,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            return json.loads(proc.stdout)

    def test_replaced_plugin_keeps_diagnostics_but_refuses_consequential_tools(self):
        out = self._probe(r'''
const results = {};
for (const tool of ["read", "skill", "grep", "question", "todowrite",
                    "edit", "bash", "task", "mcp__x__read", "plugin.skill"]) {
  try {
    await hooks["tool.execute.before"]({ tool }, { args: {} });
    results[tool] = "ALLOWED";
  } catch (e) { results[tool] = e.message; }
}
process.stdout.write(JSON.stringify(results));
''', stale=True)
        for tool in ("read", "skill", "grep", "question", "todowrite"):
            self.assertEqual(out[tool], "ALLOWED", out)
        for tool in ("edit", "bash", "task", "mcp__x__read", "plugin.skill"):
            self.assertIn("PLUGIN_RESTART_REQUIRED", out[tool], out)

    def test_current_launcher_precedes_competing_command_and_preserves_path(self):
        out = self._probe(r'''
const result = spawnSync(process.platform === "win32" ? process.env.ComSpec : "/bin/sh",
  process.platform === "win32"
    ? ["/d", "/s", "/c", "saipen --version"] : ["-c", "saipen --version"],
  { encoding: "utf8" });
const entries = process.env.PATH.split(path.delimiter);
process.stdout.write(JSON.stringify({ stdout: result.stdout, status: result.status,
  first: entries[0], expected: path.join(process.env.SAIPEN_SKILL_ROOT, "bin"),
  oldPreserved: entries.includes(path.join(process.cwd(), "old")) }));
''')
        self.assertEqual(out["status"], 0, out)
        self.assertEqual(out["stdout"].strip(), "CURRENT_CLI", out)
        self.assertEqual(out["first"], out["expected"], out)
        self.assertTrue(out["oldPreserved"], out)


if __name__ == "__main__":
    unittest.main()
