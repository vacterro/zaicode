"""Focused tests for the canonical bounded search transport (T-1320).

Why this file exists
--------------------

Real operator evidence, several projects at once: the host's native `Grep`
tool failed with ``ripgrep execution failed``; the worker then reached for the
deterministic shell fallback (``grep -n "CommitSnapshot|..."``); the guard
correctly refused it (``PROTOCOL_STATE_INVALID``) because the protocol state
was invalid. Result: **native search broken + shell fallback blocked = search
deadlock**, and the only command the guard still admitted as canonical
(``saipen``) had no search verb at all.

These tests pin the properties that remove that deadlock, and pin them
structurally rather than by prose:

* the fallback is pure Python -- provably no subprocess of any kind;
* it is read-only and root-bounded, and refuses a scope that escapes the root;
* zero matches is a NORMAL result, distinct from a transport failure;
* it works while the protocol state is invalid (the state that caused it);
* lookalike tools inherit no privilege.
"""

from __future__ import annotations

import binascii
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from saipen_engine import search as search_engine  # noqa: E402
from saipen_engine.guard_events import map_event  # noqa: E402

SAIPEN_CLI = REPO / "saipen.py"

#: The canonical transition chain that makes an out-of-enum phase
#: REPAIRABLE rather than merely broken (T-1318). Same shape the reconcile-valve
#: suite uses, so this file exercises the real proof model, not a stand-in.
_T1318_LOG = (
    "# Log\n"
    "- 13.09.26 00:00 [E-0001] [agent: tester] "
    f"[op: transition-{'a' * 32}] RUN: transition to SCOUT\n"
    "- 13.09.26 00:01 [E-0002] [parent: E-0001] [T-001] [agent: tester] "
    f"[op: transition-{'1' * 32}] RUN: transition to BUILD\n"
)


def hexify(text: str) -> str:
    return binascii.hexlify(text.encode("utf-8")).decode("ascii")


def make_tree(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp(prefix="t1320-"))
    for rel, text in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
    return root


def shell_event(command: str, tool: str = "bash") -> dict:
    return {
        "tool_name": tool,
        "host": "opencode",
        "tool_input": {"command": command},
        "actor": "tester",
        "event": 1,
        "cwd": ".",
    }


class PrimitiveBoundaryTests(unittest.TestCase):
    """Phase D CASEs 1-8 and Phase T negatives, at the primitive boundary."""

    def setUp(self) -> None:
        self.root = make_tree(
            {
                "src/app.py": "alpha = 1\nCommitSnapshot = 2\nbeta = 3\n",
                "src/other.py": "gamma = 4\n",
                "README.md": "no match here\n",
            }
        )
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))

    # CASE 1 -- healthy fast path is not this module's job, but the primitive
    # must still answer exactly.
    def test_case1_a_plain_match_is_returned_with_path_and_line(self):
        out = search_engine.search(self.root, "CommitSnapshot")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["engine"], "FALLBACK")
        self.assertEqual(out["matches_returned"], 1, out)
        self.assertEqual(out["matches"][0]["path"], "src/app.py")
        self.assertEqual(out["matches"][0]["line"], 2)

    # CASE 2/3 -- ripgrep absent, or the launch throwing "executable not
    # found", is IRRELEVANT: nothing here launches anything.
    def test_case2_and_3_no_external_executable_is_ever_launched(self):
        def explode(*_a, **_k):  # pragma: no cover - must never run
            raise AssertionError("the search fallback must never spawn a process")

        patches = [
            mock.patch("subprocess.run", explode),
            mock.patch("subprocess.Popen", explode),
            mock.patch("subprocess.check_output", explode),
            mock.patch("shutil.which", explode),
            mock.patch("os.system", explode),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        out = search_engine.search(self.root, "CommitSnapshot")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["matches_returned"], 1, out)

    # CASE 4 -- zero matches is a NORMAL result. This is the exact
    # distinction the host transport fails to make ("ripgrep execution
    # failed" for both).
    def test_case4_zero_matches_is_ok_not_a_failure(self):
        out = search_engine.search(self.root, "definitely_absent_symbol")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["status"], "OK", out)
        self.assertEqual(out["diagnostic"], "SEARCH_OK", out)
        self.assertEqual(out["matches_returned"], 0, out)

    # CASE 5 -- a real caller error is reported precisely, and never
    # silently reinterpreted as literal text.
    def test_case5_an_invalid_regex_is_the_callers_error(self):
        out = search_engine.search(self.root, "(")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["status"], search_engine.STATUS_INVALID_PATTERN, out)
        self.assertEqual(out["matches_returned"], 0, out)

    def test_case5b_literal_mode_never_compiles_a_regex(self):
        out = search_engine.search(self.root, "(", literal=True)
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["mode"], "literal", out)

    # CASE 6/10 -- a recoverable/malformed project still gets a safe, purely
    # read-only answer, and nothing canonical is touched.
    def test_case6_malformed_protocol_state_does_not_block_search(self):
        root = make_tree({"src/app.py": "CommitSnapshot = 1\n"})
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir()
        state = root / ".saipen" / "STATE.md"
        state.write_text("---\nphase: IMPL\n---\n", encoding="utf-8")
        before = state.read_bytes()
        out = search_engine.search(root, "CommitSnapshot")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["matches_returned"], 1, out)
        self.assertEqual(state.read_bytes(), before)
        self.assertFalse((root / ".saipen" / "recovery").exists())

    # CASE 7 -- a non-SAIPEN tree is not interfered with (read-only).
    def test_case7_a_non_saipen_tree_is_plainly_searchable(self):
        root = make_tree({"lib/mod.py": "CommitSnapshot = 1\n"})
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        out = search_engine.search(root, "CommitSnapshot")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["matches_returned"], 1, out)
        self.assertFalse((root / ".saipen").exists())

    # CASE 8 -- the read-only fallback cannot become a write bypass.
    def test_case8_the_fallback_writes_nothing(self):
        root = make_tree({"a.txt": "CommitSnapshot\n"})
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
        search_engine.search(root, "CommitSnapshot")
        after = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)

    # ---- Phase T negatives -------------------------------------------------

    def test_t2_a_missing_scope_inside_the_root_is_path_not_found(self):
        out = search_engine.search(self.root, "x", scope="src/absent")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["status"], search_engine.STATUS_PATH_NOT_FOUND, out)

    def test_t3_a_scope_escaping_the_root_is_refused(self):
        outside = make_tree({"secret.txt": "CommitSnapshot\n"})
        self.addCleanup(lambda: shutil.rmtree(outside, ignore_errors=True))
        out = search_engine.search(self.root, "CommitSnapshot", scope="../")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["status"], search_engine.STATUS_PATH_OUTSIDE_ROOT, out)
        out2 = search_engine.search(self.root, "CommitSnapshot", scope=str(outside))
        self.assertFalse(out2["ok"], out2)
        self.assertEqual(out2["status"], search_engine.STATUS_PATH_OUTSIDE_ROOT, out2)

    def test_t4_truncation_is_explicit_never_silently_exhaustive(self):
        files = {f"gen/f{i}.py": "CommitSnapshot\n" for i in range(30)}
        root = make_tree(files)
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        out = search_engine.search(root, "CommitSnapshot", max_matches=5)
        self.assertEqual(out["matches_returned"], 5, out)
        self.assertTrue(out["truncated"], out)
        self.assertIn("max_matches", out["truncation_reasons"], out)
        self.assertEqual(out["status"], "TRUNCATED", out)

    def test_t5_binary_files_are_skipped_not_erased_from_the_walk(self):
        root = make_tree({"good.py": "CommitSnapshot\n"})
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / "blob.bin").write_bytes(b"\x00\x01\x02CommitSnapshot\x00")
        out = search_engine.search(root, "CommitSnapshot")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["skipped"]["binary"], 1, out)
        self.assertEqual([m["path"] for m in out["matches"]], ["good.py"], out)

    def test_t9_a_bound_root_that_is_gone_is_unavailable_not_empty(self):
        gone = self.root / "not-there"
        out = search_engine.search(gone, "CommitSnapshot")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["status"], search_engine.STATUS_UNAVAILABLE, out)

    def test_t10_security_flags_come_from_the_bound_root_alone(self):
        # A file that merely *looks* like another project cannot redirect the
        # search: only the root argument decides scope.
        root = make_tree({".saipen/STATE.md": "phase: BUILD\n", "x.py": "CommitSnapshot\n"})
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        out = search_engine.search(root, "phase")
        self.assertTrue(out["ok"], out)
        self.assertEqual({m["path"] for m in out["matches"]}, {".saipen/STATE.md"}, out)

    def test_engine_identity_is_reported_for_every_result(self):
        for pattern in ("CommitSnapshot", "(", "nope_absent"):
            out = search_engine.search(self.root, pattern)
            self.assertEqual(out["engine"], "FALLBACK", out)
            self.assertIn("status", out, out)


class CanonicalClassificationTests(unittest.TestCase):
    """The guard must recognise `saipen search` -- and only the exact form."""

    def test_the_search_verb_is_canonical(self):
        mapped = map_event(shell_event("saipen search --hex 616263"))
        self.assertEqual(mapped["action"], "saipen_op", mapped)
        self.assertEqual(mapped["saipen_verb"], "search", mapped)

    def test_the_verb_is_in_the_closed_canonical_vocabulary(self):
        from saipen_engine.admission import SAIPEN_CLI_VERBS

        self.assertIn("search", SAIPEN_CLI_VERBS)

    def test_a_compound_line_never_inherits_canonical_authority(self):
        for command in (
            "saipen search --hex 6162 && rm -f .saipen/STATE.md",
            "saipen search --hex 6162 | head",
            "saipen search --hex 6162; rm -f .saipen/BOARD.md",
            "saipen search $(echo 6162)",
        ):
            mapped = map_event(shell_event(command))
            self.assertNotEqual(mapped["action"], "saipen_op", (command, mapped))

    def test_a_foreign_or_path_routed_launcher_gains_no_authority(self):
        for command in (
            "foo-saipen search --hex 6162",
            "saipen-malicious search --hex 6162",
            "./saipen search --hex 6162",
            "bash -lc saipen search --hex 6162",
            "SAIPEN=1 saipen search --hex 6162",
        ):
            mapped = map_event(shell_event(command))
            self.assertNotEqual(mapped["action"], "saipen_op", (command, mapped))

    def test_generic_shell_search_is_not_canonical(self):
        # T-1363: a shell `grep` is a PROVABLY read-only probe and now earns
        # the read class, which is exactly what the native search tool gets.
        # The property this control owns is unchanged and is asserted below:
        # it is never a CANONICAL saipen operation, so it never inherits the
        # bounded-transport exemption `saipen search` carries.
        mapped = map_event(shell_event('grep -n "CommitSnapshot" src/app.py'))
        self.assertNotEqual(mapped["action"], "saipen_op", mapped)
        self.assertIsNone(mapped["saipen_verb"], mapped)
        self.assertEqual(mapped["action"], "read", mapped)
        # A search that writes its output is not a probe at all.
        written = map_event(shell_event('grep -n "x" src/app.py > /tmp/hits'))
        self.assertEqual(written["action"], "shell", written)

    def test_lookalike_search_tools_inherit_no_privilege(self):
        for tool in ("foo.grep", "plugin.search", "mcp__x__grep", "fake-rg", "rg"):
            mapped = map_event(
                {
                    "tool_name": tool,
                    "host": "opencode",
                    "tool_input": {"pattern": "CommitSnapshot"},
                    "actor": "tester",
                    "event": 1,
                    "cwd": ".",
                }
            )
            self.assertNotEqual(mapped["action"], "read", (tool, mapped))


class ProjectShapeRegressionTests(unittest.TestCase):
    """Phase L/M/N: the three real operator shapes, end to end at the CLI."""

    def _cli(self, root: Path, *args: str) -> subprocess.CompletedProcess:
        env = {**os.environ}
        env.pop("PWD", None)
        env.pop("OLDPWD", None)
        return subprocess.run(
            [sys.executable, str(SAIPEN_CLI), "--project-root", str(root), *args],
            cwd=str(root),
            capture_output=True,
            text=True,
            env=env,
            timeout=600,
        )

    def _malformed_project(self, files: dict[str, str]) -> Path:
        root = make_tree(files)
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir()
        (root / ".saipen" / "LOG.md").write_text(_T1318_LOG, encoding="utf-8")
        (root / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: IMPL\n"
            "task: T-001\n"
            'next_action: "PHASE BUILD T-001"\n'
            "blocker: none\n"
            "transition_from: DONE\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 2\n"
            "style_contract: ded-4ae736e4\n"
            "agent: tester\n"
            "mode: full\n"
            "updated: 2026-09-13T00:00:00Z\n"
            "execution_intent: normal\n"
            "---\n",
            encoding="utf-8",
        )
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n- [/] T-001 [P1] fix | verify: test\n## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        return root

    # Phase L -- the PROBLIP deadlock, inverted.
    def test_problip_shape_search_is_no_longer_dead(self):
        root = self._malformed_project(
            {
                "src/engine.py": "CommitSnapshot = 1\nFlushSyncUnderGate = 2\n",
                "src/other.py": "CommitSnapshot = 3\n",
            }
        )
        result = self._cli(
            root,
            "search",
            "--json",
            "--native-failed",
            "--hex",
            hexify("CommitSnapshot|FlushSyncUnderGate"),
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["native_search"], search_engine.DEGRADED, payload)
        self.assertEqual(payload["matches_returned"], 3, payload)
        self.assertEqual(
            {m["path"] for m in payload["matches"]}, {"src/engine.py", "src/other.py"}, payload
        )
        # The transport is read-only: the malformed checkpoint is untouched.
        self.assertIn(
            "phase: IMPL", (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        )

    # Phase L/N -- the canonical recovery path stays reachable in the SAME
    # session that served the search.
    def test_limisaw_shape_search_and_recovery_are_both_reachable(self):
        root = self._malformed_project({"src/validate.py": "CommitSnapshot = 1\n"})
        searched = self._cli(root, "search", "--hex", hexify("CommitSnapshot"))
        self.assertEqual(searched.returncode, 0, searched.stdout + searched.stderr)
        self.assertIn("CommitSnapshot", searched.stdout)
        repaired = self._cli(root, "recover")
        self.assertEqual(repaired.returncode, 0, repaired.stdout + repaired.stderr)
        self.assertIn("code: REPAIRED", repaired.stdout + repaired.stderr)
        self.assertIn(
            "phase: BUILD", (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        )
        # And the original implementation investigation is still answerable.
        again = self._cli(root, "search", "--hex", hexify("CommitSnapshot"))
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertIn("src/validate.py", again.stdout)

    # Phase M -- AUDAPACK shape: startup and search both work with the host
    # search layer dead, because neither needs it.
    def test_audapack_shape_startup_and_search_survive_a_dead_host_transport(self):
        root = self._malformed_project({"src/app.py": "CommitSnapshot = 1\n"})
        status = self._cli(root, "status", "--json")
        payload = json.loads(status.stdout)
        self.assertFalse(payload["ok"], payload)  # malformed state is truthful
        # The cold route is nameable without any host search.
        self.assertIn("cold_route", payload, payload)
        self.assertFalse(payload["cold_route"]["search_required"], payload)
        searched = self._cli(root, "search", "--json", "--hex", hexify("CommitSnapshot"))
        self.assertEqual(searched.returncode, 0, searched.stdout + searched.stderr)
        self.assertTrue(json.loads(searched.stdout)["ok"])

    # CLI grammar guards: the transport refuses to guess.
    def test_cli_requires_a_pattern_and_valid_hex(self):
        root = self._malformed_project({"a.py": "x\n"})
        empty = self._cli(root, "search", "--json")
        self.assertEqual(empty.returncode, 2, empty.stdout + empty.stderr)
        self.assertEqual(json.loads(empty.stdout)["code"], "VALIDATION_FAILED")
        odd = self._cli(root, "search", "--json", "--hex", "abc")
        self.assertEqual(odd.returncode, 2, odd.stdout + odd.stderr)
        self.assertEqual(json.loads(odd.stdout)["code"], "VALIDATION_FAILED")

    def test_cli_scope_escape_is_refused(self):
        root = self._malformed_project({"a.py": "x\n"})
        out = self._cli(root, "search", "--json", "--scope", "..", "x")
        self.assertEqual(out.returncode, 2, out.stdout + out.stderr)
        self.assertEqual(json.loads(out.stdout)["status"], search_engine.STATUS_PATH_OUTSIDE_ROOT)


if __name__ == "__main__":
    unittest.main()
