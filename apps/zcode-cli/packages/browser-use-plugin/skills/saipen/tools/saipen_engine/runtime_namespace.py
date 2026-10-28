"""Machine-local runtime namespace policy (T-1435 M6 / SRC-090 section 16-19).

SAIPEN writes machine-local mechanics beside durable protocol history: OS
writer locks, liveness caches, per-operation journal scratch and rebuildable
snapshot generations. In the measured FastPrompter incident ~255 per-operation
recovery directories, two writer locks and a liveness cache were ELIGIBLE to
enter a public release cohort until that project added its own local
exclusions. A release-inventory guarantee that every consumer has to
rediscover is not a guarantee.

This module is the ONE owner of the classification:

  NON-RELEASE (machine-local mechanics; never source, never release input)
      .saipen/locks/**, .saipen/cache/**, .saipen/recovery/ops/**,
      .saipen/snapshots/**

  DURABLE (protocol/evidence history the contract requires to survive)
      .saipen/evidence/**, .saipen/archive/**, .saipen/intake/**,
      .saipen/recovery/log-detail/**, .saipen/recovery/board-compaction/**,
      .saipen/recovery/conformance/**, .saipen/recovery/settled/**,
      .saipen/extensions/**, and the canonical checkpoint files themselves.

The policy is deliberately NOT `.saipen/**`: a blanket exclusion would drop
the durable half. `.gitignore` is also not a repair -- it does not untrack a
file Git already follows, so a tracked runtime path gets a finite,
OPERATOR_AUTHORIZED_COMMAND (`git rm -r --cached ...`) instead of an
instruction that keeps failing forever.
"""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

#: (repo-relative prefix, class id) in declaration order. First match wins.
NON_RELEASE_PATTERNS: tuple[tuple[str, str], ...] = (
    (".saipen/locks/", "os-writer-lock"),
    (".saipen/cache/", "liveness-cache"),
    (".saipen/recovery/ops/", "operation-journal-scratch"),
    (".saipen/snapshots/", "rebuildable-snapshot"),
)

#: Durable history the policy must never classify as runtime debris.
DURABLE_PROTECTED: tuple[str, ...] = (
    ".saipen/evidence/",
    ".saipen/archive/",
    ".saipen/intake/",
    ".saipen/recovery/log-detail/",
    ".saipen/recovery/board-compaction/",
    ".saipen/recovery/conformance/",
    ".saipen/recovery/settled/",
    ".saipen/extensions/",
)

#: The one marker the canonical ignore block carries; its presence means the
#: policy is established (idempotent application, never a duplicate block).
IGNORE_MARKER = "# SAIPEN runtime namespace (machine-local; never release source)"

#: The closed remediation classification for a tracked runtime artifact.
OPERATOR_AUTHORIZED_COMMAND = "OPERATOR_AUTHORIZED_COMMAND"


def _rel(path: str) -> str:
    rel = str(path or "").replace("\\", "/")
    while rel.startswith("./"):
        rel = rel[2:]
    return rel


def runtime_class(path: str) -> str | None:
    """The non-release class of `path`, or None when it is not runtime debris."""
    rel = _rel(path)
    for prefix, class_id in NON_RELEASE_PATTERNS:
        if rel == prefix.rstrip("/") or rel.startswith(prefix):
            return class_id
    return None


def is_durable_protected(path: str) -> bool:
    rel = _rel(path)
    return any(rel.startswith(prefix) for prefix in DURABLE_PROTECTED)


def ignore_block() -> str:
    """The canonical `.gitignore` block, marker first, classes after."""
    lines = [
        IGNORE_MARKER + " -- T-1435.",
        "# Durable protocol/evidence history (.saipen/evidence, archive, intake,",
        "# recovery/log-detail, recovery/board-compaction, recovery/conformance,",
        "# extensions) stays versioned; only the mechanics below are excluded.",
    ]
    lines.extend(prefix for prefix, _class in NON_RELEASE_PATTERNS)
    return "\n".join(lines) + "\n"


def ignore_policy_state(project_root: Path | str) -> str:
    """CURRENT when the canonical block is present, ABSENT otherwise."""
    path = Path(project_root) / ".gitignore"
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return "ABSENT"
    return "CURRENT" if IGNORE_MARKER in text else "ABSENT"


def ensure_gitignore_policy(project_root: Path | str) -> dict:
    """Establish the canonical runtime-ignore policy on adoption (idempotent).

    A new project (or an adopted one with no policy) gets the block appended
    once; an existing block is never duplicated and never rewritten. This is a
    project-file policy, not canonical protocol state, so it is applied
    directly and its failure is reported rather than raised.
    """
    root = Path(project_root)
    state = ignore_policy_state(root)
    if state == "CURRENT":
        return {"ok": True, "code": "IGNORE_POLICY_CURRENT"}
    path = root / ".gitignore"
    try:
        if path.is_file():
            text = path.read_text(encoding="utf-8-sig")
            if text and not text.endswith("\n"):
                text += "\n"
            text += "\n" + ignore_block()
        else:
            text = ignore_block()
        path.write_text(text, encoding="utf-8", newline="\n")
    except OSError as exc:
        return {
            "ok": False,
            "code": "IGNORE_POLICY_UNAVAILABLE",
            "detail": f"cannot establish the runtime ignore policy: {exc}",
        }
    return {"ok": True, "code": "IGNORE_POLICY_ADDED"}


def tracked_runtime_paths(project_root: Path | str) -> dict:
    """Runtime artifacts Git ALREADY follows in this project.

    Returns ``{"ok": True, "paths": [...]}`` or ``{"ok": False, "code":
    "GIT_UNAVAILABLE"}`` when Git cannot answer (a gitless export must never
    turn this check into a crash). `.gitignore` cannot hide these: Git
    tracking beats ignore status, which is exactly why the remediation is a
    `git rm --cached`, not another ignore line.
    """
    root = Path(project_root)
    directories = sorted({prefix for prefix, _class in NON_RELEASE_PATTERNS})
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--", *directories],
            capture_output=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {"ok": False, "code": "GIT_UNAVAILABLE", "detail": str(exc)}
    if proc.returncode != 0:
        return {
            "ok": False,
            "code": "GIT_UNAVAILABLE",
            "detail": proc.stderr.decode("utf-8", errors="replace").strip()[:240],
        }
    paths = [
        part.replace("\\", "/")
        for part in proc.stdout.decode("utf-8", errors="replace").split("\0")
        if part and runtime_class(part)
    ]
    return {"ok": True, "paths": sorted(set(paths))}


def remediation_command(paths) -> str:
    """The exact authorized maintenance command for tracked runtime paths.

    SAIPEN does not mutate the Git index; the operator runs this. It removes
    the paths from tracking WITHOUT deleting the live runtime state on disk
    (`--cached`), so the protocol can recreate them normally.
    """
    quoted = " ".join(shlex.quote(str(path)) for path in paths)
    return f"git rm -r --cached -- {quoted}".strip()


def release_problems(project_root: Path | str) -> dict:
    """The one verdict a release/validator consumer reads.

    ``{"ok": True, "code": "RUNTIME_NAMESPACE_CLEAN"}`` or a structured
    problem carrying the tracked identities, their classes and the exact
    OPERATOR_AUTHORIZED_COMMAND remediation.
    """
    tracked = tracked_runtime_paths(project_root)
    if not tracked.get("ok"):
        return {"ok": True, "code": "RUNTIME_NAMESPACE_UNPROVEN", "detail": tracked.get("detail")}
    paths = tracked.get("paths") or []
    if not paths:
        return {"ok": True, "code": "RUNTIME_NAMESPACE_CLEAN"}
    classes = {path: runtime_class(path) for path in paths}
    return {
        "ok": False,
        "code": "RUNTIME_NAMESPACE_TRACKED",
        "paths": paths,
        "classes": classes,
        "remediation_kind": OPERATOR_AUTHORIZED_COMMAND,
        "remediation_command": remediation_command(paths),
        "detail": (
            "machine-local SAIPEN runtime artifacts are tracked by Git and would "
            "enter the release cohort; `.gitignore` cannot untrack them"
        ),
    }