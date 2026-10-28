#!/usr/bin/env python
"""Install the saipen pre-commit validation hook into the current repo.

Stdlib only. Run from a project root that has both .git/ and .saipen/:

    python <saipen-home>/tools/install_hook.py

The hook runs tools/validate.py before every commit and blocks the commit
on structural corruption -- the checkpoint files can't rot silently
between ships. Bypass a false positive with `git commit --no-verify`.

The validator is found in this order: the SAIPEN home baked in at install
time, then STATE.md's saipen_home field (survives the home moving), then
the frozen shell floor for hosts without Python.

To remove: python <saipen-home>/tools/uninstall_hook.py
"""

import contextlib
import sys
from pathlib import Path

MARKER = "# saipen pre-commit hook"
# Bumped whenever the hook BODY changes. The hook text is baked into
# .git/hooks/pre-commit at install time and never updates itself, so without a
# stamp an installed hook silently stays whatever generation it was born in --
# the same failure KNOWLEDGE/traps.md already records for the injector's skill
# copies ("re-run inject after every git pull"), and nothing guarded this one.
# tools/validate.py reads this number out of THIS file and compares it against
# the number in the installed hook.
# Generation 4 added the CI-status line: before every commit the hook asks
# GitHub what the last completed workflow run for the branch was, and says so
# out loud when it is red -- the failure mode where this repo's own CI sat red
# for 30+ commits while every local gate stayed green (the badge is passive;
# nothing in the commit loop ever looked at it). Warn-only, never blocks.
HOOK_VERSION = 7

home = Path(__file__).resolve().parent.parent
hooks_dir = Path(".git/hooks")

git_path = Path(".git")
if git_path.is_file():
    # Linked worktree: .git is a pointer file and hooks live in the MAIN repo, shared by every
    # worktree -- installing from here is neither possible nor needed.
    print(
        "FAIL: this is a linked git worktree (.git is a file) -- run "
        "from the main checkout instead; worktrees share its hooks "
        "automatically"
    )
    sys.exit(1)
if not git_path.is_dir():
    print("FAIL: no .git here -- run from the project root of a git repo")
    sys.exit(1)
if not Path(".saipen").is_dir():
    print("FAIL: no .saipen here -- nothing for the hook to validate")
    sys.exit(1)

# sh handles Windows drive paths fine under git's shell; forward slashes
# keep it out of escaping trouble on every platform.
home_sh = str(home).replace("\\", "/")

hook = f"""#!/bin/sh
{MARKER}
# saipen-hook-version: {HOOK_VERSION}
# Validates .saipen/ before every commit; installed by tools/install_hook.py.
# Bypass a false positive with: git commit --no-verify
[ -d .saipen ] || exit 0

SAIPEN_HOME="{home_sh}"
if [ ! -f "$SAIPEN_HOME/tools/validate.py" ]; then
  # Home moved since install -- fall back to STATE.md's saipen_home field.
  SAIPEN_HOME=$(sed -n 's/^saipen_home:[ \\t]*"\\{{0,1\\}}\\([^"]*\\)"\\{{0,1\\}}[ \\t]*$/\\1/p' .saipen/STATE.md | head -1 | tr '\\\\' '/')
fi

# Generation 5: purity guard. Validation and pre-commit MUST be read-only.
# Capture tree state before and after; any mutation is a defect.
_before=$(git status --porcelain=v1 -uall 2>/dev/null || true)

# CI status: if the last completed workflow run for this branch is red, say
# so out loud BEFORE this commit buries it further. Warn-only and fail-open:
# a red CI must never block the very commit that fixes it, and a network
# hiccup must never block any commit. tools/ci_status.py handles both -- exit
# 0 on green/in-progress/no-remote/offline, a loud line on red. (Generation 4.)
if [ -f "$SAIPEN_HOME/tools/ci_status.py" ] && command -v python >/dev/null 2>&1; then
  python "$SAIPEN_HOME/tools/ci_status.py" --hook || true
fi

if [ -f "$SAIPEN_HOME/tools/validate.py" ]; then
  if command -v python >/dev/null 2>&1; then
    python "$SAIPEN_HOME/tools/validate.py"
    _validate_rc=$?
  elif command -v py >/dev/null 2>&1; then
    py "$SAIPEN_HOME/tools/validate.py"
    _validate_rc=$?
  fi
fi
if [ -f "$SAIPEN_HOME/tests/validate.sh" ]; then
  if ! command -v bash >/dev/null 2>&1; then
    echo "saipen: validation failed -- Bash is required to run $SAIPEN_HOME/tests/validate.sh" >&2
    exit 1
  fi
  bash "$SAIPEN_HOME/tests/validate.sh"
  _validate_rc=$?
fi

# Purity check: the gate MUST NOT mutate any tracked or untracked file.
# Runs BEFORE any success exit so a mutating validator cannot slip through
# the && exit short-circuit that used to skip straight past this guard.
_after=$(git status --porcelain=v1 -uall 2>/dev/null || true)
if [ "$_before" != "$_after" ]; then
  echo "saipen: VALIDATION MUTATED THE TREE -- the pre-commit gate is not read-only" >&2
  echo "Before:" >&2
  echo "$_before" >&2
  echo "After:" >&2
  echo "$_after" >&2
  exit 1
fi

# A validator that ran and failed blocks the commit -- the purity guard has
# already been passed, so a mutating failure exits here with the mutation
# diagnosed, and a clean validation failure exits with its own message.
if [ -n "${{_validate_rc:-}}" ] && [ "$_validate_rc" != 0 ]; then
  echo "saipen: validation failed -- fix .saipen/ or commit with --no-verify" >&2
  exit 1
fi

# Generation 7: a validator ran and passed, so the gate is done -- exit quietly.
# Generation 6 removed `validate.py && exit 0` so the purity guard could no
# longer be short-circuited past, and put nothing in its place, so every
# healthy commit fell into the NOT VALIDATED line below and was told it had
# not been validated. Exiting here is safe now precisely because the guard
# above already ran. Keep this exit gated on `_validate_rc` being SET: an
# unreachable validator leaves it unset and must still reach the diagnostic.
if [ -n "${{_validate_rc:-}}" ]; then
  exit 0
fi

# No validator reachable -- never block commits on a broken install, but never
# stay quiet about it either. Usually a moved saipen_home; if STATE.md is UTF-16
# the sed above recovers nothing either. An unvalidated commit that LOOKS
# validated is the silent PASS this protocol keeps digging out.
echo "saipen: NOT VALIDATED -- no validator found at $SAIPEN_HOME. Check saipen_home in .saipen/STATE.md, then re-run tools/install_hook.py" >&2
exit 0
"""

hooks_dir.mkdir(parents=True, exist_ok=True)
target = hooks_dir / "pre-commit"
if target.exists():
    existing = target.read_text(encoding="utf-8", errors="replace")
    if MARKER not in existing:
        backup = hooks_dir / "pre-commit.pre-saipen.bak"
        backup.write_text(existing, encoding="utf-8")
        print(f"note: existing non-saipen pre-commit hook backed up to {backup}")

target.write_text(hook, encoding="utf-8", newline="\n")
# Windows: git runs hooks through sh regardless of mode bits, so a failed
# chmod is not a failed install.
with contextlib.suppress(OSError):
    target.chmod(0o755)
print(f"Installed: {target} (validator home: {home_sh})")
