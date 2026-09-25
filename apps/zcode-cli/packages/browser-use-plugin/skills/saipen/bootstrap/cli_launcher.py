#!/usr/bin/env python3
"""Canonical installed-CLI launcher renderer (T-1319 launcher ownership).

ONE source owner for the ``saipen`` / ``saipen.cmd`` bytes the canonical
installer writes into an installed skill's ``bin/``. Both
``bootstrap/inject.ps1`` and ``bootstrap/inject.sh`` call this; the OpenCode
guard only VERIFIES the result and never writes launcher bytes itself.

Installed launchers MUST point at the INSTALLED engine
(``<skill>/tools/saipen.py``) with the selected Python executable -- never at
the source checkout. That is why the repository's own ``bin/`` files are not
copied verbatim: they name the clone.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

WINDOWS_NAME = "saipen.cmd"
POSIX_NAME = "saipen"


def _dq(value: str) -> str:
    return '"' + str(value).replace('"', '\\"') + '"'


def render_launchers(python_bin: str, cli_path: str) -> dict[str, bytes]:
    """Return the exact bytes for both launcher families."""
    windows = "@echo off\r\n" + _dq(python_bin) + " " + _dq(cli_path) + " %*\r\n"
    posix = "#!/bin/sh\nexec " + _dq(python_bin) + " " + _dq(cli_path) + ' "$@"\n'
    return {WINDOWS_NAME: windows.encode("utf-8"), POSIX_NAME: posix.encode("utf-8")}


def write_launchers(python_bin: str, cli_path: str, out_dir: Path) -> list[Path]:
    """Write both launchers into ``out_dir``; return the written paths."""
    if not python_bin or not cli_path or not str(out_dir).strip():
        raise ValueError("python, cli and out-dir are required")
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for name, payload in render_launchers(python_bin, cli_path).items():
        target = out_dir / name
        target.write_bytes(payload)
        written.append(target)
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="render saipen CLI launchers")
    parser.add_argument("--python", required=True, help="selected Python executable")
    parser.add_argument("--cli", required=True, help="installed tools/saipen.py path")
    parser.add_argument("--out-dir", required=True, help="directory to write bin/ into")
    args = parser.parse_args(argv)
    try:
        written = write_launchers(args.python, args.cli, Path(args.out_dir))
    except (OSError, ValueError) as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    for path in written:
        if not path.is_file():
            print(f"FAILED: launcher not written: {path}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
