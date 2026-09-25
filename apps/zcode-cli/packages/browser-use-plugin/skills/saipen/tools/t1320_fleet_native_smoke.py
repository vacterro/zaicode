"""One fresh OpenCode host proof with a deterministic local model transport.

The local server supplies only model choices. OpenCode, its installed plugin,
native tool hook, guard subprocess, recovery CLI and write executor are real.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from test_adapter_parity import BASH  # noqa: E402
from test_reconcile_valve import _t1318_project  # noqa: E402


def run() -> dict:
    if not BASH or not shutil.which("opencode"):
        return {"ok": False, "code": "HOST_UNAVAILABLE"}
    with tempfile.TemporaryDirectory(prefix="t1320-opencode-fleet-") as temp:
        base = Path(temp)
        home = base / "home"
        cache = base / "cache"
        root = base / "FastPrompter-product"
        home.mkdir()
        cache.mkdir()
        (home / ".config" / "opencode").mkdir(parents=True)
        donor = _t1318_project()
        shutil.copytree(donor, root)
        shutil.rmtree(donor)
        lineage = new_project_lineage()
        (root / ".saipen" / "IDENTITY.md").write_text(
            identity_file_content(lineage), encoding="utf-8"
        )
        product = root / "product.txt"
        product.write_text("original", encoding="utf-8")
        env = {
            **os.environ,
            "HOME": str(home),
            "USERPROFILE": str(home),
            "XDG_CACHE_HOME": str(cache),
            "npm_config_cache": str(cache / "npm"),
            "BUN_INSTALL_CACHE_DIR": str(cache / "bun"),
        }
        for key in (
            "PWD",
            "OLDPWD",
            "SAIPEN_SKILL_ROOT",
            "SAIPEN_PROJECT_ROOT",
            "SAIPEN_PROJECT_LINEAGE",
        ):
            env.pop(key, None)
        install = subprocess.run(
            [BASH, str(ROOT / "bootstrap" / "inject.sh")],
            cwd=str(root),
            env=env,
            capture_output=True,
            text=True,
            timeout=300,
        )
        installed = home / ".config" / "opencode" / "plugins" / "saipen-guard.js"
        source = ROOT / "extensions" / "adapters" / "opencode" / "saipen-guard.js"
        if install.returncode != 0 or not installed.is_file():
            return {"ok": False, "code": "INSTALL_FAILED", "exit": install.returncode,
                    "stdout_tail": install.stdout[-1000:], "stderr_tail": install.stderr[-1000:],
                    "installed_exists": installed.is_file()}
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        installed_hash = hashlib.sha256(installed.read_bytes()).hexdigest()
        if source_hash != installed_hash:
            return {"ok": False, "code": "INSTALL_MISMATCH"}

        requests: list[dict] = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                names = [tool.get("function", {}).get("name") for tool in request.get("tools", [])]
                prior = [
                    message
                    for message in request.get("messages", [])
                    if message.get("role") == "tool"
                ]
                content = str(prior[-1].get("content", "")) if prior else ""
                requests.append(
                    {
                        "tools": names,
                        "prior_count": len(prior),
                        "prior_recovery_refusal": "RECOVERED_REISSUE_REQUIRED" in content,
                        "prior_tool_error": content[:180],
                    }
                )
                message = {"role": "assistant", "content": "Fleet smoke complete."}
                finish = "stop"
                if "write" in names and len(prior) < 2:
                    payload = "STALE" if not prior else "FRESH"
                    message = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": f"call_fleet_{len(prior)}",
                                "type": "function",
                                "function": {
                                    "name": "write",
                                    "arguments": json.dumps(
                                        {
                                            "filePath": "product.txt",
                                            "content": payload,
                                        }
                                    ),
                                },
                            }
                        ],
                    }
                    finish = "tool_calls"
                base_response = {
                    "id": "chatcmpl-fleet",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "fleet-smoke",
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
                self.send_response(200)
                if request.get("stream"):
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    chunks = [
                        {
                            **base_response,
                            "object": "chat.completion.chunk",
                            "choices": [{"index": 0, "delta": message, "finish_reason": None}],
                        },
                        {
                            **base_response,
                            "object": "chat.completion.chunk",
                            "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                        },
                    ]
                    for chunk in chunks:
                        self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                else:
                    data = json.dumps(
                        {
                            **base_response,
                            "choices": [
                                {
                                    "index": 0,
                                    "message": message,
                                    "finish_reason": finish,
                                }
                            ],
                        }
                    ).encode()
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        config = {
            "provider": {
                "saipen-fleet-smoke": {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "Local Fleet proof",
                    "options": {
                        "baseURL": f"http://127.0.0.1:{server.server_port}/v1",
                        "apiKey": "local-fixture",
                    },
                    "models": {"smoke": {"name": "smoke"}},
                }
            },
            "permission": "allow",
            "mcp": {"codebase-memory-mcp": {"enabled": False}},
        }
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
        env["SAIPEN_AGENT"] = "tester"
        env["SAIPEN_GUARD_STARTUP_PROBE"] = str(base / "startup.jsonl")
        binary = Path(shutil.which("opencode"))
        native = binary.parent / "node_modules" / "opencode-ai" / "bin" / "opencode.exe"
        if native.is_file():
            binary = native
        try:
            process = subprocess.run(
                [
                    str(binary),
                    "run",
                    "--agent",
                    "build",
                    "--model",
                    "saipen-fleet-smoke/smoke",
                    "--format",
                    "json",
                    "Execute the Fleet recovery fixture.",
                ],
                cwd=str(root),
                env=env,
                capture_output=True,
                text=True,
                timeout=150,
            )
            exit_code = process.returncode
            stdout = process.stdout
            stderr = process.stderr
        except subprocess.TimeoutExpired as exc:
            exit_code = "TIMEOUT"
            stdout = (exc.stdout or b"").decode("utf-8", errors="replace")
            stderr = (exc.stderr or b"").decode("utf-8", errors="replace")
        finally:
            server.shutdown()
            thread.join(timeout=5)
        events = []
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            part = event.get("part") or {}
            if event.get("type") == "tool_use" and part.get("type") == "tool":
                state = part.get("state") or {}
                events.append(
                    {
                        "tool": part.get("tool"),
                        "status": state.get("status"),
                        "output": str(state.get("output") or "")[:220],
                        "error": str(state.get("error") or "")[:220],
                    }
                )
        state = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        probe = base / "startup.jsonl"
        startup = (
            [json.loads(line) for line in probe.read_text(encoding="utf-8").splitlines()]
            if probe.is_file()
            else []
        )
        loaded_hashes = [item.get("module_sha256") for item in startup]
        passed = (
            exit_code == 0
            and product.read_text(encoding="utf-8") == "FRESH"
            and "phase: BUILD" in state
            and "task: T-001" in state
            and "agent: tester" in state
            and len(events) >= 2
            and events[0]["status"] == "error"
            and events[1]["status"] == "completed"
            and any(item["prior_recovery_refusal"] for item in requests)
            and bool(loaded_hashes)
            and all(value == installed_hash for value in loaded_hashes)
        )
        result = {
            "ok": passed,
            "code": "PASS" if passed else "HOST_CHAIN_FAILED",
            "exit": exit_code,
            "source_hash": source_hash,
            "installed_hash": installed_hash,
            "loaded_hashes": loaded_hashes,
            "binding_roots": [item.get("project_root") for item in startup],
            "requests": requests[:8],
            "tool_events": events[:8],
            "product_final": product.read_text(encoding="utf-8"),
            "product_work_active": "task: T-001" in state
            and "T-001"
            in (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8").split("## TODO")[0],
            "stderr_tail": stderr[-500:],
        }
        output = ROOT / ".saipen" / "evidence" / "T-1320-fleet-native-smoke.json"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2), encoding="utf-8")
        return result


if __name__ == "__main__":
    report = run()
    print(
        json.dumps(
            {
                key: value
                for key, value in report.items()
                if key not in ("requests", "tool_events", "stderr_tail")
            },
            indent=2,
        )
    )
    raise SystemExit(0 if report.get("ok") else 1)
