"""Install native Kiro/Gemini hooks without replacing unrelated user hooks.

Reports artifact/config freshness separately from runtime health. Installation
cannot prove host execution; health and effective enforcement remain UNKNOWN.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

from saipen_engine.runtime_surface import (
    identity_session,
    normalize_content as content_bytes,
    runtime_generation_identity,  # noqa: F401  (re-exported for parity tests)
    same_runtime_generation,
)

ROOT = Path(__file__).resolve().parent.parent
NAME = "saipen-guard"


def saipen_root_of(invocation: str) -> str | None:
    """The SAIPEN root a configured hook command names, or None.

    `--saipen-root` is the LAST argument `command` emits, so everything after
    the flag is the path -- quoted by `list2cmdline`/`shlex.join` exactly the
    way they quoted it on the way in.
    """
    if not invocation:
        return None
    marker = "--saipen-root"
    index = invocation.rfind(marker)
    if index < 0:
        return None
    tail = invocation[index + len(marker) :].strip()
    if not tail:
        return None
    if tail[0] == '"' and tail.endswith('"') and len(tail) > 1:
        return tail[1:-1]
    if tail[0] == "'" and tail.endswith("'") and len(tail) > 1:
        return tail[1:-1]
    return tail


def root_resolves(root: str | None, expected: Path | str | None = None) -> bool:
    """Does the named SAIPEN root prove the SAME accepted generation?

    T-1342: `BOOT.md exists` is NOT identity. Any directory can hold a
    `BOOT.md`, and the hook delegates enforcement to `<root>/tools/saipen.py`,
    so a root that merely "looks like SAIPEN" can run an engine from another
    release while the wrapper bytes look current. A different PATH is fine; a
    different GENERATION is not. The named root is accepted only when its
    bounded generation fingerprint matches the distribution/source authority
    (`ROOT`, or `expected` when supplied). Missing, unreadable and
    BOOT.md-only roots are STALE/UNKNOWN, never CURRENT.
    """
    if not root or not root.strip():
        return False
    try:
        return same_runtime_generation(ROOT if expected is None else expected, Path(root.strip()))
    except OSError:
        return False


def _named_root_is_current(command: str) -> bool:
    """Must the hook command's `--saipen-root` name the ACCEPTED generation?

    T-1342: an exact command-string match only proves the wrapper bytes were
    written once. The hook executes `<root>/tools/saipen.py guard`, so a
    byte-current entry that delegates to a root carrying a stale engine is
    still not current. This check is unconditional; the T-1338 soft compare
    exists for a different root SPELLING, never for a different generation.
    """
    root = saipen_root_of(command)
    return root is not None and root_resolves(root)


def _same_invocation(configured: str, expected: str) -> bool:
    """Same hook command, with the SAIPEN root treated as the variable it is.

    The supported scheduled injector installs from its published snapshot while
    `autoinject.hook_status` checks against the repository clone. Comparing the
    embedded root as contract makes those two spellings permanently unequal, so
    a correct, enforcing hook reported stale on every run and the freshness
    surface became noise. Everything EXCEPT the root must still match exactly.
    """
    root = saipen_root_of(configured)
    if root is None or not root_resolves(root):
        return False
    marker = "--saipen-root"
    return (
        configured[: configured.rfind(marker)] == expected[: expected.rfind(marker)]
        if marker in expected
        else False
    )


def command(host: str, artifact: Path, root: Path) -> str:
    argv = [sys.executable, str(artifact), "--host", host, "--saipen-root", str(root)]
    if os.name == "nt":
        # Hook commands are interpreted by cmd.exe on this platform. Refuse
        # expansion/control characters rather than invent shell escaping.
        if any(any(c in arg for c in "%!&|<>^\r\n") for arg in argv):
            raise ValueError("hook command path contains Windows shell control characters")
        return subprocess.list2cmdline(argv)
    return shlex.join(argv)


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() == data:
        return
    fd, temp = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def install(host: str, home: Path, root: Path = ROOT, *, check: bool = False) -> dict:
    """Install (or with `check`, only observe) one native guard hook.

    The result names the SAIPEN root the configured hook delegates to
    (`saipen_root`) and whether that root proves the accepted generation
    (`root_current`): the wrapper executes `<saipen_root>/tools/saipen.py`, so a
    current wrapper over a stale delegated engine is not a current hook.
    """
    with identity_session():
        return _install(host, home, root, check=check)


def _install(host: str, home: Path, root: Path, *, check: bool) -> dict:
    registry = json.loads((root / "extensions/adapters/registry.json").read_text())
    entry = next(item for item in registry["adapters"] if item["id"] == host)
    artifact = home / entry["hook_install_surface"].removeprefix("~/")
    config = home / entry["hook_config_surface"].removeprefix("~/")
    invocation = command(host, artifact, root)
    original = config.read_bytes() if config.exists() else None
    data = json.loads(original.decode("utf-8-sig")) if original is not None else {}
    if not isinstance(data, dict):
        raise ValueError("hook config must be a JSON object")
    if host == "gemini":
        hooks = data.setdefault("hooks", {})
        if not isinstance(hooks, dict):
            raise ValueError("hooks must be an object")
        groups = hooks.setdefault("BeforeTool", [])
        if not isinstance(groups, list):
            raise ValueError("BeforeTool must be an array")
        expected = {
            "matcher": ".*",
            "hooks": [
                {
                    "name": NAME,
                    "type": "command",
                    "command": invocation,
                    "timeout": 30000,
                }
            ],
        }
        preserved = []
        owned = []
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks"), list):
                raise ValueError("malformed BeforeTool hook group")
            remaining = []
            for hook in group["hooks"]:
                if not isinstance(hook, dict):
                    raise ValueError("malformed hook entry")
                if hook.get("name") == NAME:
                    owned.append((group.get("matcher"), hook))
                else:
                    remaining.append(hook)
            if remaining or not group["hooks"]:
                preserved.append({**group, "hooks": remaining})
        named = str(owned[0][1].get("command", "")) if len(owned) == 1 else ""
        named_root = saipen_root_of(named)
        configured = (
            len(owned) == 1
            and owned[0][0] == ".*"
            and (
                (
                    owned == [(".*", expected["hooks"][0])]
                    and _named_root_is_current(named)
                )
                or (
                    {k: v for k, v in owned[0][1].items() if k != "command"}
                    == {k: v for k, v in expected["hooks"][0].items() if k != "command"}
                    and _same_invocation(named, expected["hooks"][0]["command"])
                )
            )
        )
        hooks["BeforeTool"] = [*preserved, expected]
    else:
        expected = {
            "version": "v1",
            "hooks": [
                {
                    "name": NAME,
                    "trigger": "PreToolUse",
                    "matcher": ".*",
                    "action": {"type": "command", "command": invocation},
                    "timeout": 30,
                }
            ],
        }
        if data and (
            data.get("version") != "v1" or any(h.get("name") != NAME for h in data.get("hooks", []))
        ):
            raise ValueError("reserved SAIPEN hook file contains unrelated configuration")
        configured = False
        named_root = None
        if isinstance(data, dict) and len(data.get("hooks") or []) == 1:
            # Same rule as the Gemini branch: the SAIPEN root is a variable,
            # everything else is contract (T-1338) -- and the generation it
            # names is contract too (T-1342).
            entry_now = data["hooks"][0]
            entry_want = expected["hooks"][0]
            action_now = entry_now.get("action") or {}
            action_want = entry_want["action"]
            named_command = str(action_now.get("command", ""))
            named_root = saipen_root_of(named_command)
            configured = (
                data == expected and _named_root_is_current(named_command)
            ) or (
                data.get("version") == expected["version"]
                and {k: v for k, v in entry_now.items() if k != "action"}
                == {k: v for k, v in entry_want.items() if k != "action"}
                and {k: v for k, v in action_now.items() if k != "command"}
                == {k: v for k, v in action_want.items() if k != "command"}
                and _same_invocation(named_command, action_want["command"])
            )
        data = expected
    shipped = (root / entry["hook_artifact"]).read_bytes()
    installed = artifact.is_file()
    root_current = named_root is not None and root_resolves(named_root)
    current = (
        installed
        and content_bytes(artifact.read_bytes()) == content_bytes(shipped)
        and configured
    )
    if not check:
        # Preserve original settings once by content identity; never overwrite
        # a user's earlier backup. Malformed config is refused before writes.
        encoded = (json.dumps(data, indent=2) + "\n").encode("utf-8")
        if original is not None and original != encoded:
            import hashlib

            backup = config.with_name(
                config.name + "." + hashlib.sha256(original).hexdigest()[:16] + ".bak"
            )
            if not backup.exists():
                atomic_write(backup, original)
        atomic_write(artifact, shipped)
        atomic_write(config, encoded)
        installed = current = configured = True
        named_root = str(root)
        root_current = root_resolves(named_root)
    return {
        "host": host,
        "capability": True,
        "installed": installed,
        "current": current,
        "configured": configured,
        "saipen_root": named_root,
        "root_current": root_current,
        "health": None,
        "effective": "UNKNOWN" if current else "ENFORCEMENT_GAP",
        "artifact": str(artifact),
        "config": str(config),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host", choices=("kiro", "gemini"))
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.host, args.home, check=args.check), indent=2))
        return 0
    except (OSError, ValueError) as exc:
        print(json.dumps({"effective": "UNKNOWN", "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
