#!/usr/bin/env python
"""Remove the saipen pre-commit hook installed by tools/install_hook.py.

Stdlib only. Run from the same project root install_hook.py was run in:

    python <saipen-home>/tools/uninstall_hook.py

Only ever touches a hook this repo's own install_hook.py wrote (detected by
MARKER below) -- never removes or overwrites a hook it doesn't recognize.
If install_hook.py backed up a pre-existing hook before overwriting it
(`pre-commit.pre-saipen.bak`), that backup is restored; otherwise the file
is simply removed.
"""

import sys
from pathlib import Path

MARKER = "# saipen pre-commit hook"

git_path = Path(".git")
if git_path.is_file():
    # Linked worktree: .git is a pointer file, hooks live in the MAIN repo,
    # shared -- the naive relative path below would silently look in the
    # wrong place and report "clean" even if the shared hook is still active.
    print(
        "note: this is a linked git worktree (.git is a file) -- the "
        "shared hook lives in the main checkout; run this from there "
        "instead if you need to remove it"
    )
    sys.exit(0)
if not git_path.is_dir():
    print("clean: no .git here -- nothing to uninstall")
    sys.exit(0)

hooks_dir = git_path / "hooks"
hook = hooks_dir / "pre-commit"
backup = hooks_dir / "pre-commit.pre-saipen.bak"

if not hook.exists():
    print("clean: no .git/hooks/pre-commit here")
    sys.exit(0)

existing = hook.read_text(encoding="utf-8", errors="replace")
if MARKER not in existing:
    print("skip: .git/hooks/pre-commit exists but isn't saipen's -- left alone")
    sys.exit(0)

hook.unlink()
if backup.exists():
    backup.replace(hook)
    print(f"Removed: {hook} (restored pre-existing hook from {backup.name})")
else:
    print(f"Removed: {hook} (no prior hook to restore)")
