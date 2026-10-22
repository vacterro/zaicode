#!/usr/bin/env python3
"""Check the ZAICODE publication boundary (T-410).

The workspace repository tracks `.saipen/` -- the SAIPEN protocol's own memory.
That tree must never reach a public branch tip. The boundary is:

  * the published branch carries no `.saipen/` and no operator host path;
  * the published tree still carries the installer surface;
  * a fresh install clone (the installer's own sparse checkout) holds no
    protocol files at all;
  * the local checkout keeps its memory tracked, so the protocol can still
    commit its own state;
  * the pre-push guard refuses a tree that carries the memory.

    python tools/verify-publication-boundary.py
    python tools/verify-publication-boundary.py --clone     # fresh install clone
    python tools/verify-publication-boundary.py --tip <ref>  # any published tip

Exit code 0 = the boundary holds. The script prints the identity of the
verifier and of the evaluated subject, so a RED/GREEN pair can be anchored:

    verifier:<hex> subject:<hex>
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import sys
import tempfile

MEMORY_DIR = ".saipen"
# The host-path rules are derived at run time from this machine's own
# environment, so the check itself never carries the operator's identity into
# a published tree.
FILE_URL_RE = re.compile(r"file:///[A-Za-z]:/")
INSTALLER_SURFACE = (
    "install/Install-ZAICODE.ps1",
    "install/ZaicodeChecks.ps1",
    "install/ZaicodeInstallLib.ps1",
    "tools/launcher/build.cmd",
)
PROTOCOL_STATE = (".saipen/STATE.md", ".saipen/BOARD.md", ".saipen/LOG.md")

PUBLISHED_TIPS = (
    "gitlab/master",
    "gitlab/release/0.0.3",
    "gitlab/saipen-live",
    "gitlab/saipen-T-266-checkpoint",
    "origin/release-0.0.3",
    "origin/saipen-live",
    "origin/saipen-T-266-checkpoint",
)


def git(*args: str) -> str:
    proc = subprocess.run(
        ["git", *args], capture_output=True, text=True, errors="replace"
    )
    return proc.stdout


def git_ok(*args: str) -> bool:
    return subprocess.run(["git", *args], capture_output=True).returncode == 0


def tree_listing(tip: str) -> list[tuple[str, str]]:
    out = git("ls-tree", "-r", tip)
    entries = []
    for line in out.splitlines():
        meta, path = line.split("\t", 1)
        _mode, kind, oid = meta.split()
        entries.append((path, oid))
    return entries


def subject_digest(tip: str) -> str:
    """Content identity of a published tree: every path with its blob hash."""
    digest = hashlib.sha256()
    for path, oid in tree_listing(tip):
        digest.update(f"{path}={oid}\n".encode("utf-8"))
    return digest.hexdigest()[:16]


def verifier_digest() -> str:
    """Identity of the check itself: the command plus the bytes that define it."""
    script = os.path.abspath(__file__)
    body = hashlib.sha256(open(script, "rb").read()).hexdigest()
    command = f"python {os.path.basename(script)}"
    return hashlib.sha256(f"command={command}\noracle={body}".encode("utf-8")).hexdigest()[:16]


def check_tip(tip: str) -> list[str]:
    problems: list[str] = []
    entries = tree_listing(tip)
    paths = [path for path, _ in entries]
    memory = [path for path in paths if path.startswith(MEMORY_DIR + "/")]
    if memory:
        problems.append(f"{tip}: carries {len(memory)} {MEMORY_DIR}/ files")
    identity = identity_path_files(tip)
    if identity:
        problems.append(
            f"{tip}: {len(identity)} file(s) carry an operator host path: {identity[:3]}"
        )
    missing = [path for path in INSTALLER_SURFACE if path not in paths]
    if missing:
        problems.append(f"{tip}: installer surface missing: {missing}")
    ignore = git("show", f"{tip}:.gitignore")
    if f"/{MEMORY_DIR}/" not in [line.strip() for line in ignore.splitlines()]:
        problems.append(f"{tip}: .gitignore does not ignore /{MEMORY_DIR}/")
    return problems


def identity_path_files(tip: str) -> list[str]:
    """Files in the tree that carry a host path of THIS machine's operator.

    Three rules, none of them naming the operator: a file URL to a local
    drive, the operator's own profile directory, and the operator's login
    name as a word. The rules are derived from the environment, so the check
    stays publishable.
    """
    found: set[str] = set()
    found.update(_grep_files(tip, ["-E", FILE_URL_RE.pattern]))
    for value in _profile_paths():
        found.update(_grep_files(tip, ["-F", "-e", value]))
        found.update(_grep_files(tip, ["-F", "-e", value.replace("\\", "/")]))
    for name in _login_names():
        found.update(_grep_files(tip, ["-E", rf"\b{re.escape(name)}\b"]))
    return sorted(found)


def _grep_files(tip: str, args: list[str]) -> list[str]:
    proc = subprocess.run(
        ["git", "grep", "-l", "-I", *args, tip, "--", "."],
        capture_output=True,
        text=True,
        errors="replace",
    )
    return [line for line in proc.stdout.splitlines() if line.strip()]


def _profile_paths() -> list[str]:
    """The operator's own profile directory, both separator spellings."""
    paths = []
    for name in ("USERPROFILE", "HOME"):
        value = os.environ.get(name, "")
        if len(value) > 3:
            paths.append(value)
    return paths


def _login_names() -> list[str]:
    names = []
    for name in ("USERNAME", "LOGNAME", "USER"):
        value = os.environ.get(name, "")
        if len(value) >= 4 and value.lower() != "user":
            names.append(value)
    return names


def check_local() -> list[str]:
    problems: list[str] = []
    tracked = git("ls-files", "--", MEMORY_DIR).splitlines()
    if not tracked:
        problems.append("local: the memory tree is not tracked any more (the protocol cannot commit it)")
    for path in PROTOCOL_STATE:
        if path not in tracked:
            problems.append(f"local: {path} is not tracked (the closure staging would fail)")
    for path in ("tools/publish-workspace-mirror.py", "tools/hooks/pre-push", "docs/PUBLICATION_BOUNDARY.md"):
        if not os.path.isfile(path):
            problems.append(f"local: {path} is missing")
    hook = "tools/hooks/pre-push"
    if os.path.isfile(hook):
        head = git("rev-parse", "HEAD").strip()
        if git_ok("cat-file", "-e", f"{head}^{{commit}}"):
            probe = subprocess.run(
                ["sh", hook],
                input=f"refs/heads/master {head} refs/heads/master {head}\n",
                capture_output=True,
                text=True,
            )
            if probe.returncode == 0:
                problems.append("local: the pre-push guard accepted a tree that carries the memory")
    return problems


def check_clone() -> list[str]:
    """The installer's own clone: sparse checkout, shallow fetch, checkout."""
    problems: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        steps = (
            ["init", "--quiet"],
            ["remote", "add", "origin", "https://gitlab.com/vacuum34/zaicode.git"],
            ["sparse-checkout", "set", "--no-cone", "/*", f"!/{MEMORY_DIR}/", "!/stats/", "!/_mycustompics/"],
            ["fetch", "--quiet", "--depth", "1", "origin", "master"],
            ["checkout", "--quiet", "-f", "-B", "master", "origin/master"],
        )
        for step in steps:
            proc = subprocess.run(["git", "-C", tmp, *step], capture_output=True, text=True)
            if proc.returncode != 0:
                return [f"clone: git {' '.join(step)} failed: {proc.stderr.strip()}"]
        protocol = []
        stats = []
        for root, _dirs, files in os.walk(tmp):
            if ".git" in root.split(os.sep):
                continue
            for name in files:
                rel = os.path.relpath(os.path.join(root, name), tmp).replace("\\", "/")
                if rel.startswith(MEMORY_DIR + "/"):
                    protocol.append(rel)
                if rel.startswith("stats/"):
                    stats.append(rel)
        if protocol:
            problems.append(f"clone: {len(protocol)} protocol file(s) in a fresh install")
        if stats:
            problems.append(f"clone: {len(stats)} stats file(s) in a fresh install")
        for path in INSTALLER_SURFACE:
            if not os.path.isfile(os.path.join(tmp, *path.split("/"))):
                problems.append(f"clone: {path} missing from the fresh install")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tip", action="append", help="a published tip to check (repeatable)")
    parser.add_argument("--clone", action="store_true", help="also reproduce a fresh install clone")
    parser.add_argument("--skip-local", action="store_true", help="do not check the local checkout")
    args = parser.parse_args()

    tips = args.tip or list(PUBLISHED_TIPS)
    problems: list[str] = []
    for tip in tips:
        if not git_ok("rev-parse", "--verify", f"{tip}^{{commit}}"):
            problems.append(f"{tip}: no such tip (fetch the remote first)")
            continue
        problems.extend(check_tip(tip))
    if not args.skip_local:
        problems.extend(check_local())
    if args.clone:
        problems.extend(check_clone())

    subject = subject_digest(tips[0]) if git_ok("rev-parse", "--verify", f"{tips[0]}^{{commit}}") else "(none)"
    print(f"verifier:{verifier_digest()} subject:{subject}")
    if problems:
        print("FAIL")
        for problem in problems:
            print(f"  - {problem}")
        return 1
    print(f"PASS: {len(tips)} published tip(s) clean, the local memory intact")
    return 0


if __name__ == "__main__":
    sys.exit(main())
