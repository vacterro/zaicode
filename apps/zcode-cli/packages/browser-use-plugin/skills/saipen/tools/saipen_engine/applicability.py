"""Does this capability have anything to apply to? (T-1279, `CREW-APPLICABILITY-01`)

The crew roster was static. `CrewRole.ensure_instance` is a bool on a frozen
dataclass, `crew.py` iterates it, and nothing anywhere in `subs.py`, `crew.py`
or `producer.py` could express that a project has no UI. So every crew cycle
ran a mandatory UI stage against a surface that does not exist, and the honest
report of that fact -- "there is nothing to scan" -- was written eleven times
in a row, each one becoming a Core review ticket with a claim, a verify clause
and a disposition.

The cost was never the empty package. A scanner that honestly finds nothing has
done its job, and six-signal coverage is real coverage. The cost is that
**absence of a surface and correctness of a surface reported identically**: a
reader of the crew record could not tell "UI was audited and is fine" from
"there is no UI", and every release carried a green UI certification either way.
That is a missing applicability model, not a misbehaving sensor.

This module is the DECISION only, kept pure so the promise is provable without
copying a tree and running the whole circuit. `collect_facts` is the single
impure function and it is deliberately at the bottom, separated by a banner:
everything above it is a function of its arguments.

Two rules carry the weight:

* **Undecidable is APPLICABLE.** A probe that cannot answer -- no Git, an
  unreadable tree, a probe name the registry does not know -- resolves to
  `APPLICABLE`. A capability that runs when it did not need to costs a pass; a
  capability silently skipped costs the coverage it was there to provide, and
  nothing reports the difference. The model fails toward doing the work.
* **A verdict always names the deciding fact.** `NOT_APPLICABLE` with no reason
  is indistinguishable from a stage nobody ran, which is the exact confusion
  this module exists to remove.
* **"Not found" is not "proved absent" (SRC-019:R3).** The first version of the
  Python probe was a line regex anchored to the first module token after
  `import`, so `import os, tkinter as tk` -- valid Python naming a toolkit the
  probe claims to recognize -- produced the same empty answer as a project with
  no UI at all, and a file the probe could not open or finish reading produced
  it too. A negative may only be reported when the whole candidate was
  inspected and understood; anything else is `indeterminate_paths`, and that
  resolves APPLICABLE under the first rule.
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field

APPLICABLE = "APPLICABLE"
NOT_APPLICABLE = "NOT_APPLICABLE"

#: Probe names a `CrewRole` may declare. Closed set: an unknown name is not a
#: silent skip, it resolves APPLICABLE and says so.
ALWAYS = "always"
VISUAL_SURFACE = "visual-surface"
PROBES = (ALWAYS, VISUAL_SURFACE)

#: A visual implementation file by extension. This is the same surface saiui's
#: own charter scans by hand every cycle and reports as its evidence; it is
#: written down here so the answer is machine-decidable instead of re-derived
#: in prose each time.
VISUAL_SUFFIXES = frozenset(
    {
        ".html",
        ".htm",
        ".css",
        ".scss",
        ".sass",
        ".less",
        ".tsx",
        ".jsx",
        ".vue",
        ".svelte",
        ".qml",
        ".ui",
        ".xaml",
        ".storyboard",
        ".xib",
    }
)

#: A desktop-UI toolkit, by import root. Extension alone misses a Tk or Qt
#: application, which is a `.py` file like any other, so the probe reads imports
#: too. Closed set on purpose: widening it is a product decision, not something
#: a detector should guess at.
GUI_TOOLKIT_ROOTS = frozenset(
    {
        "tkinter",
        "PyQt4",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "textual",
        "wx",
        "kivy",
        "gi",
    }
)

#: The cheap first pass: a module that never mentions any toolkit root cannot
#: import one, because `import tkinter` requires the literal name in the source.
#: A file with no hint is therefore a PROVEN negative and is never parsed --
#: which is what keeps a grammar-aware probe affordable on a large tree. Two
#: roots are short enough to appear inside ordinary words (`gi` in `begin`, `wx`
#: in an identifier), so those two are matched on word boundaries.
_TOOLKIT_HINT_RE = re.compile(rb"tkinter|PyQt[456]|PySide[26]|textual|\bwx\b|\bkivy\b|\bgi\b")

#: Files the import probe opens. Anything else is judged by extension only.
_IMPORT_SUFFIXES = frozenset({".py", ".pyw"})

#: Never walked: runtime state, VCS internals, dependency forests and caches.
#: `.saipen/` is excluded for the same reason `PROTOCOL.md` section 6 excludes
#: it from the source fingerprint -- a worker's own kitchen is not the project,
#: and a producer's staged copy of a page must not make the project look like
#: it grew a UI.
EXCLUDED_DIRS = frozenset(
    {
        ".git",
        ".saipen",
        ".venv",
        "venv",
        "node_modules",
        "__pycache__",
        ".mypy_cache",
        ".ruff_cache",
        ".pytest_cache",
        "dist",
        "build",
        ".freebuff",
        ".claude",
    }
)

#: A single candidate module is parsed no further than this. A grammar-aware
#: answer needs the whole file -- an import may sit under a conditional halfway
#: down -- so the old 64 KiB prefix is gone: it converted "I stopped reading" into
#: "there is no UI here". Above this bound the file is INDETERMINATE, never a
#: negative, so the cost ceiling can never buy a silent skip.
PARSE_LIMIT_BYTES = 4 * 1024 * 1024

#: `_probe_gui_imports` answers with exactly one of these.
_GUI_IMPORT = "gui"
_NO_GUI = "clean"
_INDETERMINATE = "indeterminate"


@dataclass(frozen=True)
class ProjectFacts:
    """Deterministic, cheap, read-only facts a capability can be judged against.

    Every field is derived from the project tree. Nothing here reads STATE,
    BOARD, a charter or an agent's claim: an applicability answer that could be
    changed by writing prose would be the same narrative-authority leak the
    protocol already names.

    `readable` is False when the tree could not be enumerated at all. It is kept
    as a field rather than signalled by an exception because "I could not look"
    is an answer callers must be able to carry into a verdict, and the verdict
    for it is APPLICABLE.
    """

    visual_paths: tuple[str, ...] = ()
    gui_module_paths: tuple[str, ...] = ()
    readable: bool = True
    unreadable_reason: str = ""
    #: Files enumerated. Zero on a readable but genuinely empty tree, which is
    #: why it is carried separately from `readable`.
    scanned: int = 0
    #: Candidate modules whose imports could NOT be determined -- unreadable,
    #: unparseable, or larger than the parse window. Carried as a fact rather
    #: than dropped because "I could not tell" is the one input that must not
    #: look like "there is nothing here" (SRC-019:R3).
    indeterminate_paths: tuple[str, ...] = ()
    _evidence: tuple[str, ...] = field(default=(), compare=False, repr=False)

    @property
    def visual_surface(self) -> bool:
        """Does a visual implementation exist anywhere in the project?"""
        return bool(self.visual_paths or self.gui_module_paths)

    def visual_evidence(self, limit: int = 3) -> tuple[str, ...]:
        """A bounded sample of the paths that decided `visual_surface`.

        Bounded on purpose: a verdict reason is read by a human in a plan
        listing, and a reason that pastes four thousand paths is not evidence,
        it is a denial of service on the reader.
        """
        return tuple((*self.visual_paths, *self.gui_module_paths))[:limit]

    def indeterminate_evidence(self, limit: int = 3) -> tuple[str, ...]:
        """A bounded sample of the candidates that could not be decided."""
        return tuple(self.indeterminate_paths)[:limit]


def verdict(probe: str, facts: ProjectFacts | None) -> tuple[str, str]:
    """`(verdict, reason)` for one probe against one set of facts.

    The reason is never empty, including for `APPLICABLE`, because a plan that
    prints a bare verdict makes the two failure directions -- ran when it need
    not have, skipped when it must not have -- look the same from outside.
    """
    if facts is None:
        return APPLICABLE, "project facts unavailable; applicability fails closed to APPLICABLE"
    if not facts.readable:
        reason = facts.unreadable_reason or "project tree could not be enumerated"
        return APPLICABLE, f"{reason}; applicability fails closed to APPLICABLE"
    if probe == ALWAYS:
        return APPLICABLE, "role declares no applicability condition"
    if probe == VISUAL_SURFACE:
        if facts.visual_surface:
            sample = ", ".join(facts.visual_evidence())
            return APPLICABLE, f"visual surface present: {sample}"
        if facts.indeterminate_paths:
            sample = ", ".join(facts.indeterminate_evidence())
            return (
                APPLICABLE,
                f"no visual implementation file found, but "
                f"{len(facts.indeterminate_paths)} Python candidate(s) could not be "
                f"proven free of a UI toolkit import ({sample}); "
                "applicability fails closed to APPLICABLE",
            )
        return (
            NOT_APPLICABLE,
            f"no visual implementation file in {facts.scanned} scanned project "
            f"files (extensions {_suffix_list()}; no desktop UI toolkit import)",
        )
    return (
        APPLICABLE,
        f"unknown applicability probe {probe!r}; applicability fails closed to APPLICABLE",
    )


def _suffix_list() -> str:
    return " ".join(sorted(VISUAL_SUFFIXES))


def is_applicable(probe: str, facts: ProjectFacts | None) -> bool:
    """Convenience predicate. Callers that report to a human want `verdict`."""
    return verdict(probe, facts)[0] == APPLICABLE


# ---------------------------------------------------------------------------
# THE ONLY IMPURE FUNCTION BELOW THIS LINE.
#
# Everything above is a function of its arguments and is tested without a
# filesystem. `collect_facts` walks a tree, so it is quarantined here and
# returns the same frozen `ProjectFacts` the pure half consumes.
# ---------------------------------------------------------------------------


def collect_facts(project_root) -> ProjectFacts:
    """Enumerate the project's visual surface, once, cheaply, read-only.

    Prefers Git's own idea of the project (`git ls-files`), because a tracked
    file is what the repository claims to own and it inherits `.gitignore` for
    free. Falls back to a bounded walk when Git cannot answer, and reports
    `readable=False` only when neither route produced a listing -- at which
    point every verdict is APPLICABLE, so an unreadable tree can never silently
    retire a capability.
    """
    import os
    import subprocess
    from pathlib import Path

    root = Path(project_root)
    paths: list[str] = []
    try:
        completed = subprocess.run(
            ["git", "-C", os.fspath(root), "ls-files", "-z", "--cached", "--others",
             "--exclude-standard"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if completed.returncode == 0:
            paths = [p for p in completed.stdout.decode("utf-8", "replace").split("\0") if p]
    except (OSError, ValueError):
        paths = []

    if not paths:
        try:
            for base, dirs, files in os.walk(root):
                dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_DIRS)
                for name in sorted(files):
                    rel = (Path(base) / name).relative_to(root).as_posix()
                    paths.append(rel)
        except OSError as exc:
            return ProjectFacts(readable=False, unreadable_reason=f"tree walk failed: {exc}")

    visual: list[str] = []
    gui: list[str] = []
    unknown: list[str] = []
    for rel in paths:
        parts = rel.split("/")
        if any(part in EXCLUDED_DIRS for part in parts[:-1]):
            continue
        suffix = ("." + parts[-1].rsplit(".", 1)[1].lower()) if "." in parts[-1] else ""
        if suffix in VISUAL_SUFFIXES:
            visual.append(rel)
            continue
        if suffix in _IMPORT_SUFFIXES:
            state, detail = _probe_gui_imports(root / rel)
            if state == _GUI_IMPORT:
                gui.append(rel)
            elif state == _INDETERMINATE:
                unknown.append(f"{rel} ({detail})" if detail else rel)

    return ProjectFacts(
        visual_paths=tuple(visual),
        gui_module_paths=tuple(gui),
        readable=True,
        scanned=len(paths),
        indeterminate_paths=tuple(unknown),
    )


def _probe_gui_imports(path) -> tuple[str, str]:
    """`(state, detail)` for one Python module: `gui`, `clean` or `indeterminate`.

    `clean` is a CLAIM, so it is only made when the whole file was read and
    either mentions no toolkit root anywhere -- which no real import of one can
    avoid -- or parses cleanly and imports none of them. Everything else is
    `indeterminate` and carries the reason: an unreadable file, a file above the
    parse window, or source Python itself cannot parse. The old probe answered
    False for all three, which is how an unopenable module became proof that a
    project has no UI (SRC-019:R3).

    The `ast` walk covers every statement, not the first line of the file, so a
    comma-separated `import os, tkinter as tk`, an aliased submodule import and a
    toolkit imported inside a function or a conditional are all found.
    """
    try:
        size = path.stat().st_size
    except OSError as exc:
        return _INDETERMINATE, f"unreadable: {exc.strerror or exc}"
    if size > PARSE_LIMIT_BYTES:
        return _INDETERMINATE, f"{size} bytes exceeds the {PARSE_LIMIT_BYTES}-byte parse window"
    try:
        raw = path.read_bytes()
    except OSError as exc:
        return _INDETERMINATE, f"unreadable: {exc.strerror or exc}"
    if not _TOOLKIT_HINT_RE.search(raw):
        return _NO_GUI, ""
    try:
        tree = ast.parse(raw)
    except (SyntaxError, ValueError) as exc:
        return _INDETERMINATE, f"unparseable: {type(exc).__name__}"
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _import_root(alias.name) in GUI_TOOLKIT_ROOTS:
                    return _GUI_IMPORT, alias.name
        elif isinstance(node, ast.ImportFrom):
            if not node.level and _import_root(node.module or "") in GUI_TOOLKIT_ROOTS:
                return _GUI_IMPORT, node.module or ""
    return _NO_GUI, ""


def _import_root(dotted: str) -> str:
    return dotted.split(".", 1)[0]
