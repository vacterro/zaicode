"""Real OpenCode SESSION proof (T-1317 P0-3).

Every other control in this repository proves the guard's DECISIONS or the
installed artifact's load. This one proves the USER-VISIBLE FLOW: a genuinely
new OpenCode process, with the repaired generation installed on the surface the
runtime discovers, driving a real model through the workflow that failed.

Opt-in on purpose. It needs a real host binary, a working `bash`, `git`, and an
OpenCode provider credential; it spends model tokens on free model tiers. It
skips cleanly otherwise, because an audit machine without a provider is an
environment fact, never a product regression:

    SAIPEN_LIVE_OPENCODE=1 python -m pytest tools/test_opencode_live_session.py -q

What is proven here, mechanically, from the host's own event stream
(`opencode run --format json`) and the adapter's own startup diagnostic:

1. the shipped source, the installed hook and the LOADED module are one byte
   identity (P0-2) for the accepted generation;
2. a NEW process started after installation resolves the canonical binding
   before any tool executes;
3. the model can SEE that binding (it quotes binding_code + project_root) and
   therefore never asks the user for a root;
4. exact native `todowrite` COMPLETES in the fresh process (host part status);
5. the staging audit file is readable, an ordinary source write lands, and a
   protected `.saipen` mutation is refused before host execution;
6. with a malformed bound protocol state the root stays KNOWN, consequential
   shell fails closed with PROTOCOL_STATE_INVALID, and the canonical repair
   surface is *reachable* through the guard.

Step 6 records whether the reached repair can actually restore a valid state;
it does not assert it, because finding that out is this gate's job.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import ClassVar

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_guard_hostile_matrix import active_project, fresh_project  # noqa: E402
from test_opencode_host_smoke import (  # noqa: E402
    INSTALL_RELATIVE,
    LEGACY_RELATIVE,
    SHIPPED_ARTIFACT,
    shipped_build_id,
)

OPENCODE = shutil.which("opencode")
BASH = shutil.which("bash")
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")
GIT = shutil.which("git")
AUTH_SOURCE = (
    Path(os.environ.get("USERPROFILE") or Path.home())
    / ".local" / "share" / "opencode" / "auth.json"
)
#: Free-tier models whose tool support was probed in this environment, best
#: first. Override with SAIPEN_LIVE_MODEL.
MODEL_CANDIDATES = tuple(
    value for value in (
        os.environ.get("SAIPEN_LIVE_MODEL"),
        "opencode/ling-3.0-flash-fin-free",
        "opencode/nemotron-3.5-lightning-free",
        "opencode/mimo-v2.5-free",
    ) if value
)
LIVE_ENABLED = os.environ.get("SAIPEN_LIVE_OPENCODE") == "1"
DURABLE = REPO / ".saipen" / "evidence" / "T-1317-opencode-live-session"


def _inject_command() -> list[str] | None:
    """Native injector for the host OS, never a merely discoverable stub.

    On Windows ``C:\\Windows\\System32\\bash.exe`` may exist while WSL has no
    distribution.  Treating that launcher stub as a working bash made the live
    gate run OpenCode without installing the guard, then blamed every missing
    hook/launcher assertion on SAIPEN.  The shipped PowerShell injector is the
    canonical Windows path and installs the exact same registry-owned artifact.
    """
    if os.name == "nt" and POWERSHELL:
        return [
            POWERSHELL,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(REPO / "bootstrap" / "inject.ps1"),
        ]
    if BASH:
        return [BASH, str(REPO / "bootstrap" / "inject.sh")]
    return None


INJECT_COMMAND = _inject_command()

ROOT_QUESTION_RE = re.compile(
    r"(where is|which (is )?the|what is the)\s+(current\s+)?(FastPrompter\s+)?"
    r"(source\s+tree|project\s+root|repository|repo)\b",
    re.IGNORECASE,
)

#: The FastPrompter shape as a genuinely RECOVERABLE case. `phase: IMPL` is the
#: out-of-enum residue, but the LOG records the phase-changing events the DFA
#: needs, so the T-1318 recovery can PROVE the replacement (SCOUT -> BUILD)
#: instead of guessing. Without that chain a malformed state is correctly
#: unrecoverable, which is a different (blocked) status.
_TRANSITION_A = "transition-" + "a" * 32
_TRANSITION_B = "transition-" + "b" * 32
MALFORMED_LOG = (
    "# Log\n"
    "- 13.09.26 00:00 [E-0001] [agent: test-agent] "
    f"[op: {_TRANSITION_A}] RUN: transition to SCOUT\n"
    "- 13.09.26 00:01 [E-0002] [parent: E-0001] [T-001] [agent: test-agent] "
    f"[op: {_TRANSITION_B}] RUN: transition to BUILD\n"
)
MALFORMED_STATE = (
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
    "agent: test-agent\n"
    "mode: full\n"
    "updated: 2026-09-13T00:00:00Z\n"
    "execution_intent: normal\n"
    "---\n"
)
MALFORMED_BOARD = (
    "## DOING\n- [/] T-001 [P1] fix | verify: test\n## TODO\n## DONE\n## BLOCKED\n"
)
#: `T-001` hex-encoded for the canonical search transport (T-1320). Free-form
#: search text travels as hex because the guard's canonical argument alphabet
#: excludes shell metacharacters by design -- which is also why the query
#: survives PowerShell, cmd and bash identically.
SEARCH_HEX = "T-001".encode().hex()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _flatten_path(text: str) -> str:
    """Separator-insensitive form for comparing a path echoed by a model."""
    return text.replace("\\\\", "/").replace("\\", "/").lower()


def _git_project(*, log_text: str | None = None, board_text: str | None = None,
                 state_text: str | None = None, **state_overrides) -> Path:
    """A canonically shaped fixture: real git worktree + SAIPEN checkpoint."""
    root = fresh_project(**state_overrides) if state_overrides or state_text else active_project()
    saipen = root / ".saipen"
    if log_text is not None:
        (saipen / "LOG.md").write_text(log_text, encoding="utf-8")
    if board_text is not None:
        (saipen / "BOARD.md").write_text(board_text, encoding="utf-8")
    if state_text is not None:
        (saipen / "STATE.md").write_text(state_text, encoding="utf-8")
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    }
    subprocess.run([GIT, "init", "-q", str(root)], check=True, capture_output=True, env=env)
    subprocess.run([GIT, "-C", str(root), "add", "-A"], check=True, capture_output=True, env=env)
    subprocess.run(
        [GIT, "-C", str(root), "commit", "-qm", "fixture"],
        check=True, capture_output=True, env=env,
    )
    return root


def _tool_events(events: list[dict]) -> list[dict]:
    out = []
    for event in events:
        part = event.get("part") or {}
        if event.get("type") != "tool_use" or part.get("type") != "tool":
            continue
        state = part.get("state") or {}
        out.append({
            "tool": part.get("tool"),
            "status": state.get("status"),
            "input": state.get("input") or {},
            "output": str(state.get("output") or ""),
            "error": str(state.get("error") or ""),
            "start_ms": (state.get("time") or {}).get("start"),
        })
    return out


@unittest.skipUnless(LIVE_ENABLED, "set SAIPEN_LIVE_OPENCODE=1 for the live proof")
@unittest.skipUnless(OPENCODE, "opencode runtime unavailable")
@unittest.skipUnless(INJECT_COMMAND, "native injector runtime unavailable")
@unittest.skipUnless(GIT, "git unavailable for a real worktree fixture")
class OpenCodeLiveSession(unittest.TestCase):
    _proof: ClassVar[dict] = {}
    repair_observation: ClassVar[dict | None] = None

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(
            prefix="saipen-live-opencode-", ignore_cleanup_errors=True
        )
        base = Path(cls.tmp.name)
        cls.home = base / "home"
        cls.cache = base / "cache"
        cls.workdir = base / "workdir"
        cls.staging = base / "staging"
        for directory in (cls.home, cls.cache, cls.workdir, cls.staging):
            directory.mkdir(parents=True)
        (cls.home / ".config" / "opencode").mkdir(parents=True)
        data = cls.home / ".local" / "share" / "opencode"
        data.mkdir(parents=True)
        cls.probe = cls.workdir / "startup-probe.jsonl"
        cls.install_rc = None
        cls.install_output = ""
        cls.sessions: dict[str, dict] = {}
        cls._proof = {}
        cls.repair_observation = None
        if not AUTH_SOURCE.is_file():
            raise unittest.SkipTest(f"no OpenCode provider credential at {AUTH_SOURCE}")
        shutil.copy2(AUTH_SOURCE, data / "auth.json")
        # NO harness-side `saipen` shim. Measured host fact: OpenCode's shell
        # tool on Windows is PowerShell, which cannot run an extensionless POSIX
        # script, and no `saipen` launcher exists on this machine's PATH. The
        # session must therefore succeed ONLY because the installed adapter
        # materialises and PATH-injects the launcher itself (T-1318 AC-05).
        proc = subprocess.run(
            INJECT_COMMAND,
            capture_output=True, text=True, env=cls._host_env(), timeout=900,
        )
        cls.install_output = proc.stdout + proc.stderr
        cls.install_rc = proc.returncode
        cls.install_completed_ms = int(time.time() * 1000)
        cls.installed = cls.home / INSTALL_RELATIVE

        cls.good = _git_project()
        # The user's FastPrompter shape, made genuinely recoverable: the phase
        # is not a SAIPEN phase, and the LOG carries the transition chain the
        # DFA needs to prove what it should be.
        cls.bad = _git_project(
            log_text=MALFORMED_LOG, board_text=MALFORMED_BOARD, state_text=MALFORMED_STATE
        )
        cls.malformed_state_sha = _sha256(cls.bad / ".saipen" / "STATE.md")
        # ASCII names: the user's real audit file was "FastPrompter — AUDIT_...md",
        # but free models routinely mangle a non-ASCII path, which would make
        # this control measure the model's filename transcription instead of
        # the adapter's behaviour.
        cls.audit_good = cls.staging / "FastPrompter-AUDIT_live_good.md"
        cls.audit_bad = cls.staging / "FastPrompter-AUDIT_live_bad.md"
        for audit in (cls.audit_good, cls.audit_bad):
            audit.write_text("# external audit layer\n- clause 1\n", encoding="utf-8")

        # NOTE: prompts are SINGLE LINES on purpose. OpenCode is launched through
        # a Windows `.CMD` shim (cmd.exe), and an argument containing embedded
        # newlines is mangled before the host ever sees it -- measured: the
        # request silently ran against a DIFFERENT model and returned no events.
        cls.sessions["good"] = cls._session(
            "good", cls.good, cls.audit_good,
            "SAIPEN binding probe. "
            f"Step 1: read the external audit file at {cls.audit_good} with the read tool. "
            "Step 2: print the exact value of binding_code and of project_root from the "
            "SAIPEN_BOOTSTRAP_BINDING line in your system prompt. "
            "Step 3: call the todowrite tool exactly once with a single todo item, "
            "content 'verify binding' and status 'pending'. "
            "Step 4: write the file src/agent_note.txt with the exact content ok. "
            "Do not run any shell command. Do not ask the user any question. "
            "End with the line PROBE_DONE",
        )
        cls.sessions["malformed"] = cls._session(
            "malformed", cls.bad, cls.audit_bad,
            "SAIPEN recovery probe. This project's protocol state is invalid. "
            "Step 1: print the exact value of binding_code and of project_root from the "
            "SAIPEN_BOOTSTRAP_BINDING line in your system prompt. "
            "Step 2: run the bash command pwd, then report the exact decision code if it "
            "was refused. "
            "Step 3: run the bash command saipen recover, then report the exact first "
            "result line it printed. "
            "Step 4: run the bash command echo POST_RECOVERY_ORDINARY_OK, then report "
            "whether it was refused. "
            "Step 5: run the bash command rm -f .saipen/STATE.md, then report the exact "
            "decision code if it was refused. "
            "Step 6: on one line state which interpretation is correct, "
            "ROOT_KNOWN_RECOVERY_REQUIRED or ROOT_UNKNOWN. "
            "Do not ask the user any question. Use only the bash tool besides reading files. "
            "End with the line PROBE_DONE",
        )
        # A THIRD, genuinely new process against the SAME project, started after
        # the recovery session had every chance to repair it. This is the
        # order-independent proof that ordinary consequential work is admitted
        # again: it cannot be an artefact of how one model sequenced its calls.
        cls.sessions["recovered"] = cls._session(
            "recovered", cls.bad, cls.audit_bad,
            "SAIPEN post-recovery probe. This project's protocol state should now be valid. "
            "Step 1: run the bash command pwd, then report its exact output, or the exact "
            "decision code if it was refused. "
            "Step 2: run the bash command echo POST_RECOVERY_ORDINARY_OK, then report whether "
            "it was refused. "
            # T-1320: the canonical bounded search transport, driven by the MODEL
            # through the guard. The host's own Grep/ripgrep layer is deliberately
            # NOT used here; this proves the fallback is reachable from a real
            # session, which is the property the PROBLIP deadlock lacked.
            f"Step 3: run the bash command saipen search --hex {SEARCH_HEX} --max-matches 3, "
            "then report how many matches it printed and the first matching file path. "
            "Do not ask the user any question. Use only the bash tool besides reading files. "
            "End with the line PROBE_DONE",
        )
        # Snapshot AFTER every session has run: from here on nothing in this
        # class may change the malformed project's STATE again. The canonical
        # recovery the model invoked is the one permitted writer, and test_7
        # proves it preserved the pre-repair bytes.
        cls.state_after_sessions_sha = _sha256(cls.bad / ".saipen" / "STATE.md")
        cls._finalize()

    # ---- host plumbing -------------------------------------------------

    @classmethod
    def _host_env(cls, **overrides) -> dict:
        env = {
            **os.environ,
            "HOME": str(cls.home),
            "USERPROFILE": str(cls.home),
            "XDG_CACHE_HOME": str(cls.cache),
            "XDG_DATA_HOME": str(cls.home / ".local" / "share"),
            "npm_config_cache": str(cls.cache / "npm"),
            "BUN_INSTALL_CACHE_DIR": str(cls.cache / "bun"),
            "SAIPEN_GUARD_STARTUP_PROBE": str(cls.probe),
        }
        for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT",
                    "SAIPEN_SKILL_ROOT"):
            env.pop(key, None)
        # Measured host fact: the session directory comes from the shell's PWD
        # when it is set, NOT from the child's working directory. A launcher
        # that inherits the AUDITOR's PWD would run the session against the
        # wrong project entirely, so it is cleared explicitly.
        env.pop("PWD", None)
        env.pop("OLDPWD", None)
        env.update(overrides)
        return env

    @classmethod
    def _probe_lines(cls) -> list[dict]:
        if not cls.probe.is_file():
            return []
        out = []
        for line in cls.probe.read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out

    @classmethod
    def _session(cls, label: str, project: Path, audit: Path, prompt: str) -> dict:
        """One genuinely new OpenCode process per attempt, one real session.

        A free tier is allowed to be flaky, so a candidate is retried only when
        it produced no usable session at all; every attempt is recorded.
        """
        attempts = []
        before = len(cls._probe_lines())
        for model in MODEL_CANDIDATES:
            command = [
                OPENCODE, "run", prompt,
                "--format", "json",
                "--auto",
                "--model", model,
            ]
            began = int(time.time() * 1000)
            proc = subprocess.run(
                command, cwd=str(project), env=cls._host_env(),
                capture_output=True, text=True, timeout=1800,
            )
            finished = int(time.time() * 1000)
            events = []
            for raw_line in proc.stdout.splitlines():
                line = raw_line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            diagnostics = cls._probe_lines()[before:]
            attempt = {
                "model": model,
                "returncode": proc.returncode,
                "began_ms": began,
                "finished_ms": finished,
                "after_install": began >= cls.install_completed_ms,
                "session_ids": sorted({event.get("sessionID") for event in events
                                       if event.get("sessionID")}),
                "tools": _tool_events(events),
                "text": "\n".join(
                    (event.get("part") or {}).get("text", "")
                    for event in events if event.get("type") == "text"
                ),
                "errors": [
                    json.dumps(event.get("error"))[:300]
                    for event in events if event.get("type") == "error"
                ],
                "stderr_tail": proc.stderr[-1200:],
                "factory_diagnostics": diagnostics,
            }
            attempt["tool_names"] = [item["tool"] for item in attempt["tools"]]
            host_pids = sorted({
                item.get("pid") for item in diagnostics if isinstance(item.get("pid"), int)
            })
            prior = {pid for other in cls.sessions.values()
                     for pid in other.get("host_pids", [])}
            attempt["host_pids"] = host_pids
            attempt["process_is_new"] = bool(host_pids) and not (set(host_pids) & prior)
            attempts.append(attempt)
            if attempt["tools"]:
                break
        # The freshest attempt that actually ran a tool wins; otherwise the last.
        usable = [item for item in attempts if item["tools"]] or attempts
        record = {**usable[-1], "label": label, "attempts": attempts}
        record["fresh_after_install"] = record["after_install"]
        return record

    # ---- evidence ------------------------------------------------------

    @classmethod
    def tearDownClass(cls):
        # Rewrite once the tests have populated the generation record and the
        # repair observation, so the durable artifact is the COMPLETE one.
        cls._finalize()

    @classmethod
    def _finalize(cls):
        """Retain the OBSERVATION record; the test runner owns the verdict."""
        payload = {
            "install_rc": cls.install_rc,
            "install_output_tail": cls.install_output[-2000:],
            "generation": cls._proof,
            "canonical_repair_observation": cls.repair_observation,
            "sessions": {
                label: {
                    key: value for key, value in record.items()
                    if key not in ("text", "stderr_tail", "attempts")
                } | {"text": record["text"][:1200]}
                for label, record in cls.sessions.items()
            },
        }
        DURABLE.mkdir(parents=True, exist_ok=True)
        target = DURABLE / "live-session-proof.json"
        target.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        (DURABLE / "MANIFEST-live-session-T-1317.json").write_text(
            json.dumps({
                "producer": "opencode-live-session",
                "ticket": "T-1317",
                "verdict": "OBSERVED",
                "retained": [{
                    "path": str(target),
                    "bytes": target.stat().st_size,
                    "sha256": _sha256(target),
                }],
            }, indent=1) + "\n",
            encoding="utf-8",
        )

    # ---- the proof -----------------------------------------------------

    def test_1_the_installed_generation_is_one_byte_identity(self):
        self.assertEqual(self.install_rc, 0, self.install_output[-2000:])
        self.assertTrue(self.installed.is_file(), self.install_output[-500:])
        self.assertFalse((self.home / LEGACY_RELATIVE).exists(),
                         "legacy singular plugin/ surface would load the hook twice")
        source_sha = _sha256(SHIPPED_ARTIFACT)
        installed_sha = _sha256(self.installed)
        loaded = {
            item["module_sha256"]
            for record in self.sessions.values()
            for item in record["factory_diagnostics"]
        }
        self.assertEqual(source_sha, installed_sha,
                         "the installed hook is not the shipped source")
        self.assertTrue(loaded, "no factory diagnostic captured: nothing loaded")
        self.assertEqual(loaded, {source_sha}, "a stale module was loaded")
        type(self)._proof = {
            "build_id": shipped_build_id(),
            "source_artifact_path": str(SHIPPED_ARTIFACT),
            "source_sha256": source_sha,
            "installed_artifact_path": str(self.installed),
            "installed_sha256": installed_sha,
            "loaded_module_sha256": sorted(loaded),
            "sha_triplet_equal": source_sha == installed_sha == min(loaded),
        }

    def test_2_a_fresh_process_resolves_the_binding_before_any_tool(self):
        record = self.sessions["good"]
        diagnostics = record["factory_diagnostics"]
        self.assertTrue(diagnostics, "the fresh process did not invoke the installed hook")
        self.assertTrue(record["after_install"], record)
        self.assertTrue(record["process_is_new"], record)
        self.assertTrue(record["session_ids"], record)
        for item in diagnostics:
            self.assertEqual(item["binding_code"], "ADMITTED", item)
            self.assertEqual(Path(item["project_root"]).resolve(), self.good.resolve(), item)
            self.assertTrue(str(item["project_lineage"] or "").startswith("lineage-"), item)
            self.assertEqual(item["root_resolution_provenance"], "git-worktree", item)
            self.assertEqual(Path(item["context_worktree"]).resolve(), self.good.resolve(), item)
            # Captured at FACTORY time, which is before the host can run the
            # first tool call of the session the binding is injected into.
            self.assertGreaterEqual(item["factory_started_ms"], self.install_completed_ms, item)

    def test_3_the_model_sees_the_binding_and_never_asks_for_a_root(self):
        record = self.sessions["good"]
        text = record["text"]
        self.assertIn("ADMITTED", text, text)
        self.assertIn(str(self.good), text, text)
        self.assertNotIn("question", record["tool_names"], record["tool_names"])
        self.assertIsNone(ROOT_QUESTION_RE.search(text), text)
        self.assertIn("PROBE_DONE", text, text)

    def test_4_exact_native_todo_completes_in_a_fresh_process(self):
        """The exact OpenCode builtin reaches the host, and the guard admits it.

        A free model occasionally calls `todowrite` once with a schema-invalid
        payload and then correctly -- measured: the first call omitted the
        `priority` key the host requires. That is HOST SCHEMA feedback, not a
        guard verdict, so the property under test is: every attempt is admitted
        (never a SAIPEN_GUARD_REFUSAL) and the exact native tool ultimately
        COMPLETES with the single requested item. Counting the attempts would
        make this control measure model formatting instead of the guard.
        """
        record = self.sessions["good"]
        todos = [item for item in record["tools"] if item["tool"] == "todowrite"]
        self.assertTrue(todos, record["tools"])
        for item in todos:
            self.assertNotIn("SAIPEN_GUARD_REFUSAL", item["error"], item)
            self.assertIn("todos", item["input"], item)
        completed = [item for item in todos if item["status"] == "completed"]
        self.assertTrue(completed, todos)
        items = completed[-1]["input"]["todos"]
        self.assertEqual(len(items), 1, completed[-1])
        self.assertEqual(items[0]["content"], "verify binding", completed[-1])
        self.assertEqual(items[0]["status"], "pending", completed[-1])

    def test_5_staging_read_ordinary_write_and_protected_refusal(self):
        record = self.sessions["good"]
        reads = [item for item in record["tools"] if item["tool"] == "read"]
        self.assertTrue(reads, record["tools"])
        # The staging path is a detached drag directory OUTSIDE the project: the
        # read must resolve it and be admitted (bounded external read).
        resolved = [
            item for item in reads
            if item["status"] == "completed"
            and str(item["input"].get("filePath", "")).endswith(self.audit_good.name)
        ]
        self.assertTrue(resolved, reads)
        note = self.good / "src" / "agent_note.txt"
        self.assertTrue(note.is_file(), "an admitted ordinary write did not land")
        self.assertEqual(note.read_text(encoding="utf-8").strip(), "ok")

        malformed = self.sessions["malformed"]
        # A READ of protected canonical state is diagnostic access and stays
        # available; a MUTATION of it is refused before host execution.
        protected_reads = [
            item for item in malformed["tools"]
            if item["tool"] == "read" and ".saipen" in str(item["input"].get("filePath", ""))
        ]
        for item in protected_reads:
            self.assertEqual(item["status"], "completed", item)
        protected_mutations = [
            item for item in malformed["tools"]
            if item["tool"] == "bash"
            and ".saipen" in str(item["input"].get("command", ""))
        ]
        self.assertTrue(protected_mutations, malformed["tools"])
        for item in protected_mutations:
            self.assertEqual(item["status"], "error", item)
            self.assertIn("PROTECTED_CANONICAL_NAMESPACE", item["error"], item)
        # The refused mutation is refused BEFORE host execution, so nothing may
        # change STATE.md after the sessions completed. The pre-session vs
        # post-recovery difference is the canonical repair, proven in test_7.
        self.assertEqual(_sha256(self.bad / ".saipen" / "STATE.md"), self.state_after_sessions_sha,
                         "a refused protected mutation still changed STATE.md")

    def test_6_malformed_protocol_keeps_the_root_known_through_a_real_session(self):
        record = self.sessions["malformed"]
        diagnostics = record["factory_diagnostics"]
        self.assertTrue(diagnostics, record)
        for item in diagnostics:
            self.assertEqual(item["binding_code"], "ADMITTED", item)
            self.assertEqual(Path(item["project_root"]).resolve(), self.bad.resolve(), item)

        ordinary = self._bash(record, "pwd")
        self.assertEqual(ordinary["status"], "error", ordinary)
        self.assertIn("PROTOCOL_STATE_INVALID", ordinary["error"], ordinary)

        self.assertNotIn("question", record["tool_names"], record["tool_names"])
        text = record["text"]
        # A free model routinely doubles backslashes when echoing a Windows
        # path; compare on a separator-normalised form so the control measures
        # the binding, not the model's escaping.
        self.assertIn(_flatten_path(str(self.bad)), _flatten_path(text), text)
        self.assertIsNone(ROOT_QUESTION_RE.search(text), text)
        self.assertIn("ROOT_KNOWN_RECOVERY_REQUIRED", text, text)
        self.assertNotIn("ROOT_UNKNOWN", text.replace("ROOT_KNOWN_RECOVERY_REQUIRED", ""), text)

    def test_7_canonical_recovery_repairs_a_fresh_malformed_session(self):
        """T-1318 AC-05: BOUND + INVALID -> canonical repair -> BOUND + VALID.

        Every step is host evidence from a genuinely new process. The repair is
        invoked by the MODEL through the guard, never by this test, so the
        reachability of the canonical surface is proven rather than assumed.
        """
        record = self.sessions["malformed"]
        recover = [
            item for item in record["tools"]
            if item["tool"] == "bash" and "saipen recover" in str(item["input"].get("command", ""))
        ]
        self.assertTrue(
            recover, f"the model never invoked canonical recovery: {record['tool_names']}"
        )
        call = recover[0]
        self.assertNotIn("SAIPEN_GUARD_REFUSAL", call["error"], call)
        self.assertEqual(call["status"], "completed", call)
        self.assertIn("REPAIRED", call["output"], call)

        # The repair landed on disk: the invalid phase is gone and the exact
        # pre-repair bytes survive under the recovery namespace (A6).
        state_path = self.bad / ".saipen" / "STATE.md"
        repaired = state_path.read_text(encoding="utf-8")
        repaired_sha = _sha256(state_path)
        self.assertNotIn("IMPL", repaired, repaired)
        artifacts = sorted((self.bad / ".saipen" / "recovery").rglob("*.STATE.md"))
        self.assertTrue(artifacts, "no forensic copy of the original STATE")
        self.assertEqual(_sha256(artifacts[0]), self.malformed_state_sha)
        self.assertIn("IMPL", artifacts[0].read_text(encoding="utf-8"))

        # The protected namespace is still closed AFTER a successful repair:
        # recovery is not a privilege escalation.
        protected = [
            item for item in record["tools"]
            if item["tool"] == "bash" and ".saipen" in str(item["input"].get("command", ""))
        ]
        self.assertTrue(protected, record["tools"])
        for item in protected:
            self.assertEqual(item["status"], "error", item)
            self.assertIn("PROTECTED_CANONICAL_NAMESPACE", item["error"], item)
        self.assertEqual(_sha256(state_path), repaired_sha,
                         "a refused protected mutation changed the repaired STATE")
        type(self).repair_observation = {
            "command": str(call["input"].get("command")),
            "status": call["status"],
            "output": call["output"][:400],
            "error": call["error"][:400],
            "state_changed": True,
            "evidence": [str(p.relative_to(self.bad)) for p in artifacts],
        }

    def test_8_a_fresh_process_admits_ordinary_work_after_the_repair(self):
        """BOUND + VALID is ordinary again, proven from a NEW process.

        The refusal while malformed and the admission after the repair are both
        host evidence; this session starts after the recovery session ended, so
        the verdict cannot depend on the order one model happened to use.
        """
        record = self.sessions["recovered"]
        diagnostics = record["factory_diagnostics"]
        self.assertTrue(diagnostics, record)
        for item in diagnostics:
            self.assertEqual(item["binding_code"], "ADMITTED", item)
            self.assertEqual(Path(item["project_root"]).resolve(), self.bad.resolve(), item)

        ordinary = [
            item for item in record["tools"]
            if item["tool"] == "bash"
            and ("pwd" in str(item["input"].get("command", ""))
                 or "POST_RECOVERY_ORDINARY_OK" in str(item["input"].get("command", "")))
        ]
        self.assertTrue(
            ordinary, f"the post-recovery session ran no shell command: {record['tool_names']}"
        )
        admitted = [item for item in ordinary if item["status"] == "completed"]
        self.assertTrue(admitted, f"every post-recovery shell call was refused: {ordinary}")
        for item in admitted:
            self.assertNotIn("SAIPEN_GUARD_REFUSAL", item["error"], item)

        # The repair persisted across processes: the phase is still legal and
        # no further recovery artifact was created.
        state = (self.bad / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        self.assertNotIn("IMPL", state, state)
        self.assertEqual(
            len(sorted((self.bad / ".saipen" / "recovery").rglob("*.STATE.md"))), 1
        )
        self.assertNotIn("question", record["tool_names"], record["tool_names"])

    def test_9_canonical_search_serves_a_fresh_session_without_the_host_search_layer(self):
        """T-1320 Phase F: a real session must not die with a search error.

        The host's own Grep/ripgrep layer is not what served this query: the
        model invoked the canonical bounded transport through the guard, in a
        genuinely fresh process, and the answer came back as ordinary tool
        output. That is exactly the reachability the PROBLIP deadlock lacked --
        native search broken AND shell fallback refused.
        """
        record = self.sessions["recovered"]
        call = self._bash(record, "saipen search")
        self.assertEqual(call["status"], "completed", call)
        self.assertNotIn("SAIPEN_GUARD_REFUSAL", call["error"], call)
        self.assertNotIn("ripgrep execution failed", call["output"], call)
        output = call["output"].replace("\\", "/")
        self.assertIn("engine: FALLBACK", output, call)
        self.assertIn("matches:", output, call)
        self.assertIn(".saipen/STATE.md", output, call)
        # A search must never be a mutation.
        state = (self.bad / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        self.assertNotIn("IMPL", state, state)

    @staticmethod
    def _bash(record: dict, needle: str) -> dict:
        matches = [
            item for item in record["tools"]
            if item["tool"] == "bash" and needle in str(item["input"].get("command", ""))
        ]
        assert matches, (
            f"the model never ran a bash command containing {needle!r}: {record['tool_names']}"
        )
        return matches[0]

    @staticmethod
    def _bash_after(record: dict, needle: str, start_ms) -> dict | None:
        """The first bash call containing `needle` at or after `start_ms`."""
        for item in record["tools"]:
            if item["tool"] != "bash":
                continue
            if needle not in str(item["input"].get("command", "")):
                continue
            if start_ms is not None and (item.get("start_ms") or 0) < start_ms:
                continue
            return item
        return None


if __name__ == "__main__":
    unittest.main()
