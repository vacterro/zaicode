"""Canonical installed-runtime reconcile for ``saipen runtime --bootstrap``.

Project- and schema-independent by design (T-1319 stale-runtime gap): the
engine that serves this command is whichever tree ran it -- usually a STALE
installed parser that blocked ordinary mutation with ``PROTOCOL_STATE_INVALID``
before it could parse the current BOARD.

Safety, in order:

1. Host-scoped. Self-recovery refreshes ONLY the executing host's runtime,
   discovered from the installer-owned provenance marker, never from directory
   names. A stale *other* host never makes a healthy current host report stale.
2. Provenance-proven source. A stale installed runtime cannot discover the
   canonical clone from ``__file__`` -- that IS the installed tree. The runtime
   reads the marker written by the canonical installer, then PROVES the
   referenced source root by its architecture markers. Missing, unreadable or
   inconsistent provenance fails closed with ``CANONICAL_RUNTIME_SOURCE_UNPROVEN``
   and mutates nothing.
3. One installer owner. File-copy semantics live in ``bootstrap/inject.ps1``
   (Windows) / ``bootstrap/inject.sh`` (POSIX); this module only invokes them
   with an exact ``-AdapterId`` / ``--adapter`` filter and verifies the result.
4. No project semantics. Bootstrap never parses STATE/BOARD/LOG: a schema or
   runtime mismatch is exactly the condition being repaired.

No arbitrary command tail, no arbitrary script path, no ``--source`` override,
no project mutation.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from .runtime_surface import (
    RuntimeSurfaceError,
    content_bytes,
    identity_session,
    installed_relpath as _installed_relpath,  # noqa: F401  (re-exported for fixtures)
    runtime_generation_identity as surface_fingerprint,
    runtime_surface_items as _surface_paths,  # noqa: F401  (re-exported for fixtures)
    surface_delta,
)

#: Installer generation LABEL. Bumped whenever the bootstrap/guard contract
#: changes so a marker written by an older installer reads as such. It is
#: provenance, never content identity: the generation a runtime actually runs
#: is `surface_fingerprint` (the one manifest-derived identity), and both
#: injectors read this label from here instead of carrying their own copy.
GENERATION = "T-1342-runtime-surface-identity-20260915.1"

#: The installer-owned provenance record, one per installed skill home.
PROVENANCE_FILENAME = ".saipen_runtime.json"

#: The installed CLI launcher surface the canonical installer OWNS
#: (bootstrap/cli_launcher.py renders it into the staged skill). The runtime
#: only VERIFIES these bytes; it never writes them.
_LAUNCHER_FILES = ("bin/saipen", "bin/saipen.cmd")

#: Architecture markers a canonical source root must carry. cwd is never proof.
_SOURCE_MARKERS = (
    "saipen/MANIFEST.json",
    "saipen/BOOT.md",
    "VERSION",
    "tools/saipen.py",
    "tools/saipen_engine/board.py",
    "extensions/adapters/registry.json",
)


class CanonicalSourceUnproven(RuntimeError):
    """The provenance marker names no provable canonical source; mutate nothing."""


def _skill_root() -> Path:
    """The skill home this module was loaded from (installed OR canonical)."""
    return Path(__file__).resolve().parents[2]


def _expand(surface: str) -> Path:
    value = str(surface).strip()
    if not value:
        raise ValueError("empty install surface")
    return Path(os.path.expandvars(os.path.expanduser(value)))


def _norm(path: Path | str) -> str:
    text = os.path.normcase(str(Path(path).resolve()))
    return text


def read_provenance(skill_root: Path | str | None = None) -> dict | None:
    """The installer-owned provenance record for a skill home, or None."""
    root = Path(skill_root) if skill_root is not None else _skill_root()
    try:
        doc = json.loads((root / PROVENANCE_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def prove_canonical_root(root: Path | str) -> Path:
    """Prove a candidate root by its shipped architecture markers, not cwd."""
    candidate = Path(os.path.expandvars(os.path.expanduser(str(root)))).resolve()
    if not candidate.is_dir():
        raise CanonicalSourceUnproven(f"canonical source root unreadable: {candidate}")
    missing = [rel for rel in _SOURCE_MARKERS if not (candidate / rel).is_file()]
    if missing:
        raise CanonicalSourceUnproven(
            "canonical source root fails architecture proof; missing: " + "; ".join(missing)
        )
    return candidate


def canonical_source_root(skill_root: Path | str | None = None) -> Path:
    """Resolve the canonical clone from the installed provenance marker."""
    root = Path(skill_root) if skill_root is not None else _skill_root()
    record = read_provenance(root)
    if record is None:
        raise CanonicalSourceUnproven(
            f"no installer provenance marker at {root / PROVENANCE_FILENAME}; "
            "run the canonical injector once (LEGACY_BOOTSTRAP_MIGRATION)"
        )
    raw = record.get("canonical_source_root")
    if not isinstance(raw, str) or not raw.strip():
        raise CanonicalSourceUnproven("provenance marker names no canonical_source_root")
    return prove_canonical_root(raw)


def _registry(source: Path) -> dict:
    return json.loads((source / "extensions/adapters/registry.json").read_text(encoding="utf-8"))


def _adapter_skill(adapter: dict) -> str | None:
    install = adapter.get("install")
    if not isinstance(install, dict):
        return None
    skill = install.get("skill")
    return skill if isinstance(skill, str) and skill.strip() else None


def surface_diff(canonical: Path, installed: Path, limit: int = 20) -> list[str]:
    """Declared runtime names that differ between canonical and installed homes.

    T-1342: naming only -- the verdict is the generation identity comparison
    (`surface_fingerprint` on both sides). The inventory AND the comparison
    belong to `runtime_surface.surface_delta`, which also names a file present
    on one side only: a leftover module in an installed engine is a difference
    a canonical-inventory walk could never see.
    """
    try:
        delta = surface_delta(canonical, installed, limit=limit)
    except (RuntimeSurfaceError, OSError) as exc:
        return [f"canonical-runtime-surface-unproven: {exc}"]
    return [name for name, _expected, _candidate in delta]


def _current_adapter(registry: dict, skill_root: Path | None = None) -> str | None:
    """Mechanically identify the executing host.

    The provenance marker's ``adapter_id`` is the primary authority; a path
    match against the registry's declared skill surfaces is the fallback. Host
    identity is NEVER derived from a directory name.
    """
    record = read_provenance(skill_root)
    if record is not None:
        adapter = record.get("adapter_id")
        if isinstance(adapter, str) and adapter.strip():
            return adapter.strip()
    target = _norm(skill_root if skill_root is not None else _skill_root())
    for adapter in registry.get("adapters", []):
        skill = _adapter_skill(adapter)
        if skill and _norm(_expand(skill)) == target:
            return str(adapter.get("id"))
    return None


def marker_problems(
    record: dict | None, host: str, source: Path, expected_fingerprint: str | None = None
) -> list[str]:
    """Fields an installer-owned marker MUST carry for a legal success.

    Provenance is REQUIRED recovery state, not optional diagnostics: a missing
    or malformed marker makes a host-scoped migration non-successful even when
    the file surface happens to match. When the canonical generation is known,
    the marker must name THAT generation: the fingerprint an installer records
    is the one runtime identity, so a marker from an older installer (or one
    naming another generation) is provenance that no longer describes the tree.
    """
    if not isinstance(record, dict):
        return ["marker-missing"]
    problems: list[str] = []
    if str(record.get("adapter_id", "")) != host:
        problems.append("adapter_id")
    raw_root = record.get("canonical_source_root")
    if not isinstance(raw_root, str) or not raw_root.strip() or _norm(raw_root) != _norm(source):
        problems.append("canonical_source_root")
    if str(record.get("installer_generation", "")) != GENERATION:
        problems.append("installer_generation")
    recorded = str(record.get("runtime_fingerprint", "")).strip()
    if not recorded or (expected_fingerprint is not None and recorded != expected_fingerprint):
        problems.append("runtime_fingerprint")
    return problems


def _freshness(installed: Path, canonical: Path, expected: str | None) -> dict:
    """One home's freshness: the identity decides, the diff only names files."""
    actual = surface_fingerprint(installed)
    diff = surface_diff(canonical, installed)
    return {
        "surface": str(installed),
        "stale": expected is None or actual != expected or bool(diff),
        "diff": diff,
        "runtime_generation": actual,
        "expected_generation": expected,
    }


def check_freshness() -> dict:
    """Read-only freshness verdict, host-scoped plus a fleet report.

    ``current_host`` is the executing host's freshness (the only verdict that
    gates self-recovery); ``fleet`` is the informational all-adapter report.
    A stale Claude install never makes a current OpenCode runtime stale.
    """
    try:
        source = canonical_source_root()
    except CanonicalSourceUnproven as exc:
        return {
            "ok": False,
            "code": "CANONICAL_RUNTIME_SOURCE_UNPROVEN",
            "detail": str(exc),
            "current_host": None,
            "fleet": [],
        }
    try:
        registry = _registry(source)
    except (OSError, ValueError) as exc:
        return {
            "ok": False,
            "code": "CANONICAL_RUNTIME_SOURCE_UNPROVEN",
            "detail": f"canonical registry unreadable: {exc}",
            "current_host": None,
            "fleet": [],
        }

    host = _current_adapter(registry)
    current = None
    with identity_session():
        expected = surface_fingerprint(source)
        if host:
            adapter = next(
                (a for a in registry.get("adapters", []) if str(a.get("id")) == host), None
            )
            skill = _adapter_skill(adapter) if adapter else None
            if skill:
                current = {"adapter": host, **_freshness(_expand(skill), source, expected)}

        fleet: list[dict] = []
        for adapter in registry.get("adapters", []):
            skill = _adapter_skill(adapter)
            if not skill:
                continue
            installed = _expand(skill)
            if not installed.is_dir():
                continue
            fleet.append({"adapter": adapter.get("id"), **_freshness(installed, source, expected)})

    if current is None:
        code = "HOST_UNIDENTIFIED"
    elif current["stale"]:
        code = "HOST_RUNTIME_STALE"
    else:
        code = "RUNTIME_CURRENT"
    return {
        "ok": True,
        "code": code,
        "source": str(source),
        "current_host": current,
        "fleet": fleet,
    }


def _powershell() -> str | None:
    """Resolve PowerShell even when the host shell PATH is minimal."""
    for name in ("pwsh", "powershell"):
        found = shutil.which(name)
        if found:
            return found
    if os.name == "nt":
        system_root = os.environ.get("SYSTEMROOT") or r"C:\Windows"
        candidate = (
            Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        )
        if candidate.is_file():
            return str(candidate)
    return None


def _invoke_installer(source: Path, adapter_id: str) -> subprocess.CompletedProcess | None:
    """Run the ONE canonical installer, host-scoped. No caller-supplied paths."""
    if os.name == "nt":
        shell = _powershell()
        if not shell:
            return None
        cmd = [
            shell,
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(source / "bootstrap" / "inject.ps1"),
            "-AdapterId",
            adapter_id,
        ]
    else:
        cmd = ["bash", str(source / "bootstrap" / "inject.sh"), "--adapter", adapter_id]
    kwargs: dict = dict(capture_output=True, text=True, errors="replace", timeout=600)
    # The installer renders the installed launcher with the SELECTED Python.
    # Pass the interpreter actually running this runtime so the installed
    # `bin/saipen` names a real interpreter instead of guessing from PATH.
    env = dict(os.environ)
    env["SAIPEN_PYTHON"] = sys.executable
    kwargs["env"] = env
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        return subprocess.run(cmd, **kwargs)
    except (OSError, subprocess.SubprocessError):
        return None


def run_bootstrap() -> dict:
    """Refresh ONLY the executing host's runtime via the canonical installer."""
    source = canonical_source_root()
    try:
        registry = _registry(source)
    except (OSError, ValueError) as exc:
        raise CanonicalSourceUnproven(f"canonical registry unreadable: {exc}") from exc

    host = _current_adapter(registry)
    if not host:
        return {
            "ok": False,
            "code": "HOST_UNIDENTIFIED",
            "detail": "installer provenance names no adapter_id and no skill surface matched",
            "generation": GENERATION,
        }
    adapter = next((a for a in registry.get("adapters", []) if str(a.get("id")) == host), None)
    skill = _adapter_skill(adapter) if adapter else None
    if not skill:
        return {
            "ok": False,
            "code": "HOST_UNIDENTIFIED",
            "detail": f"adapter {host} declares no install.skill surface",
            "generation": GENERATION,
        }

    proc = _invoke_installer(source, host)
    installed = _expand(skill)
    diff = surface_diff(source, installed)
    expected = surface_fingerprint(source)
    actual = surface_fingerprint(installed)
    marker = read_provenance(installed)
    problems = marker_problems(marker, host, source, expected)

    started = proc is not None
    rc = proc.returncode if proc is not None else None
    result: dict = {
        "source": str(source),
        "host": host,
        "surface": str(installed),
        "generation": GENERATION,
        "diff": diff,
        "canonical_fingerprint": expected,
        "installed_fingerprint": actual,
        "installer_rc": rc,
        "provenance_problems": problems,
    }
    if proc is not None and rc != 0:
        result["installer_tail"] = "\n".join((proc.stdout or "").splitlines()[-12:])

    # RUNTIME_BOOTSTRAPPED is legal ONLY when the installer actually ran, exited
    # 0, left no semantic surface diff, AND wrote a readable, host-matched,
    # source-matched, generation-matched provenance marker. A nonzero installer
    # is BOOTSTRAP_INSTALL_FAILED even when the pre-existing bytes already match.
    if not started:
        code = "BOOTSTRAP_INSTALL_FAILED"
        detail = "installer process did not start"
    elif rc != 0:
        code = "BOOTSTRAP_INSTALL_FAILED"
        detail = f"installer returned {rc}"
    elif diff or expected is None or actual != expected:
        code = "BOOTSTRAP_INCOMPLETE"
        detail = "installed runtime generation is not the canonical generation"
    elif problems:
        code = "BOOTSTRAP_PROVENANCE_INVALID"
        detail = "installer provenance marker invalid: " + ",".join(problems)
    else:
        code = "RUNTIME_BOOTSTRAPPED"
        detail = "host runtime refreshed and provenance verified"

    result["ok"] = code == "RUNTIME_BOOTSTRAPPED"
    result["code"] = code
    result["detail"] = detail
    return result


# ---------------------------------------------------------------------------
# T-1327 TARGET C: prelaunch freshness as a protocol operation
#
# Writing install provenance proved insufficient in production: a stale
# installed OpenCode runtime stayed active until the operator ran inject.ps1 by
# hand. The ownership boundary that actually removes that chore is PRELAUNCH:
# the canonical launcher validates (and, when stale, resyncs) the installed
# generation BEFORE a new host process loads the plugin. A loaded plugin is
# never hot-replaced and never claimed to have changed generation -- the only
# honest moment to change what a process will load is before it starts.
# ---------------------------------------------------------------------------

#: Stable machine-readable prelaunch codes. A consumer branches on these.
PRELAUNCH_CURRENT = "RUNTIME_CURRENT"
PRELAUNCH_RESYNCED = "RUNTIME_RESYNCED"
PRELAUNCH_STALE = "RUNTIME_STALE"
PRELAUNCH_FAILED = "RUNTIME_RESYNC_FAILED"
PRELAUNCH_UNPROVEN = "CANONICAL_RUNTIME_SOURCE_UNPROVEN"
PRELAUNCH_HOST_UNIDENTIFIED = "HOST_UNIDENTIFIED"


#: T-1342: `surface_fingerprint` is the ONE shipped-runtime identity from
#: `runtime_surface` (imported above as an alias), never a second framing. BOTH
#: sides are digested over their OWN declared inventory: a flattened correct
#: install and its source clone are one identity, and an installed tree that
#: carries a file the canonical tree does not is a different one. (Digesting the
#: installed tree over the CANONICAL inventory made an extra installed module
#: invisible to the verdict.)


def adapter_entry(registry: dict, adapter_id: str) -> dict | None:
    for adapter in registry.get("adapters", []):
        if str(adapter.get("id")) == str(adapter_id):
            return adapter
    return None


def resolve_authority(
    adapter_id: str | None = None, skill_root: Path | str | None = None
) -> tuple[Path, str | None]:
    """Prove the canonical source and the host this call is about.

    Two legal authorities, in order, and PATH is neither of them:

    1. an installer-written provenance marker in the executing skill home --
       the stale-installed-runtime case, where `__file__` is the installed tree;
    2. the executing tree itself when it passes the architecture proof -- the
       launcher case, where SAIPEN runs from the canonical clone. A clone serves
       every host, so it cannot guess which one is starting: the adapter id is
       then required input, not an inference.
    """
    root = Path(skill_root) if skill_root is not None else _skill_root()
    record = read_provenance(root)
    if record is not None:
        source = canonical_source_root(root)
        marked = record.get("adapter_id")
        host = adapter_id or (marked if isinstance(marked, str) and marked.strip() else None)
        return source, (host.strip() if isinstance(host, str) else None)
    if (root / "MANIFEST.json").is_file() and not (root / "saipen" / "MANIFEST.json").is_file():
        raise CanonicalSourceUnproven(
            f"installed runtime projection at {root} has no provenance marker "
            f"({PROVENANCE_FILENAME}); run the canonical injector once to "
            "establish provenance"
        )
    source = prove_canonical_root(root)
    named = adapter_id.strip() if isinstance(adapter_id, str) else ""
    return source, (named or None)


def hook_problems(adapter: dict, source: Path) -> list[str]:
    """Guard-plugin fingerprint check for adapters that install a blocking hook."""
    artifact = adapter.get("hook_artifact")
    install = adapter.get("install") if isinstance(adapter.get("install"), dict) else {}
    surface = install.get("hook")
    if not artifact or not surface:
        return []
    shipped = source / str(artifact)
    installed = _expand(str(surface))
    if not shipped.is_file():
        return ["hook-artifact-missing"]
    if not installed.is_file():
        return ["hook-not-installed"]
    try:
        # The one content policy (runtime_surface.content_bytes), the same one
        # autoinject.hook_status and install_host_guard apply to this artifact:
        # a CRLF transport of identical source is not a stale hook.
        current = content_bytes(installed) == content_bytes(shipped)
    except OSError:
        return ["hook-unreadable"]
    if not current:
        return ["hook-stale"]
    problems: list[str] = []
    for legacy in adapter.get("legacy_hook_surfaces") or []:
        if _expand(str(legacy)).is_file():
            # A second discoverable copy loads the guard twice; the injectors
            # remove it, so its presence means the install did not complete.
            problems.append("legacy-hook-present")
    return problems


def _comparable(text: str) -> str:
    """Case/separator-insensitive form for matching a path inside script bytes."""
    return os.path.normcase(str(text)).replace("\\", "/")


def launcher_problems(skill_dir: Path) -> list[str]:
    """The installed launchers must exist AND name the INSTALLED engine."""
    problems: list[str] = []
    expected = _comparable(str((skill_dir / "tools" / "saipen.py").resolve()))
    for rel in _LAUNCHER_FILES:
        path = skill_dir / rel
        if not path.is_file():
            problems.append(f"missing:{rel}")
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            problems.append(f"unreadable:{rel}")
            continue
        if expected not in _comparable(text):
            # A launcher that still names the clone is exactly how a "current"
            # install keeps serving the source tree's engine by accident.
            problems.append(f"wrong-target:{rel}")
    return problems


def prelaunch(
    adapter_id: str | None = None,
    *,
    skill_root: Path | str | None = None,
    resync: bool = True,
) -> dict:
    """Prove -- and when necessary restore -- the installed generation.

    ONE stable machine-readable operation. The canonical host launcher calls it
    before starting the host; `saipen runtime --prelaunch --adapter <id>` is the
    same operation for any other consumer. It mutates nothing when the installed
    runtime already matches (no install churn), and on failure it reports exact
    evidence instead of letting a host start against unproven bytes.
    """
    result: dict = {
        "ok": False,
        "code": PRELAUNCH_UNPROVEN,
        "generation": GENERATION,
        "adapter": adapter_id,
        "source": None,
        "surface": None,
        "stale_before": None,
        "resynced": False,
        "requires_host_restart": False,
        "canonical_fingerprint": None,
        "installed_fingerprint": None,
        "fingerprint_match": False,
        "marker_fingerprint": None,
        "engine_diff": [],
        "hook_problems": [],
        "launcher_problems": [],
        "provenance_problems": [],
        "detail": "",
    }
    try:
        source, host = resolve_authority(adapter_id, skill_root)
    except CanonicalSourceUnproven as exc:
        result["detail"] = str(exc)
        return result
    result["source"] = str(source)
    result["adapter"] = host
    try:
        registry = _registry(source)
    except (OSError, ValueError) as exc:
        result["detail"] = f"canonical registry unreadable: {exc}"
        return result
    adapter = adapter_entry(registry, host) if host else None
    skill = _adapter_skill(adapter) if adapter else None
    if adapter is None or not skill:
        result["code"] = PRELAUNCH_HOST_UNIDENTIFIED
        result["detail"] = (
            f"no installable adapter surface for host {host!r}; "
            "supply --adapter with a registry id"
        )
        return result
    installed = _expand(skill)
    result["surface"] = str(installed)
    canonical = surface_fingerprint(source)
    result["canonical_fingerprint"] = canonical
    if canonical is None:
        # Never install FROM a source whose shipped surface cannot be proven:
        # the installer would copy an unprovable tree and every later identity
        # check would compare against nothing.
        result["detail"] = "canonical runtime surface cannot be proven; nothing was installed"
        result["engine_diff"] = surface_diff(source, installed)
        return result

    def _measure() -> dict:
        marker = read_provenance(installed)
        installed_fp = surface_fingerprint(installed)
        return {
            "installed_fingerprint": installed_fp,
            # The rolled-up scalar the operator no longer has to compute by
            # hand, and the VERDICT: both sides are digested by the one owner
            # over their own declared inventories, so a match is an identity,
            # not an estimate.
            "fingerprint_match": bool(installed_fp is not None and installed_fp == canonical),
            "marker_fingerprint": (
                str(marker.get("runtime_fingerprint")) if isinstance(marker, dict) else None
            ),
            "engine_diff": surface_diff(source, installed),
            "hook_problems": hook_problems(adapter, source),
            "launcher_problems": launcher_problems(installed),
            "provenance_problems": marker_problems(marker, host, source, canonical),
        }

    def _stale(measured: dict) -> bool:
        return bool(
            not measured["fingerprint_match"]
            or measured["engine_diff"]
            or measured["hook_problems"]
            or measured["launcher_problems"]
            or measured["provenance_problems"]
        )

    observed = _measure()
    result.update(observed)
    stale = _stale(observed)
    result["stale_before"] = stale
    if not stale:
        # TARGET C requirement 11: an already-current runtime performs NO
        # mutation. Reinstalling "just in case" is install churn that rewrites
        # provenance and defeats the point of a deterministic check.
        result["ok"] = True
        result["code"] = PRELAUNCH_CURRENT
        result["detail"] = "installed runtime matches the canonical generation"
        return result
    if not resync:
        result["code"] = PRELAUNCH_STALE
        result["detail"] = "installed runtime is stale and resync was not requested"
        return result

    proc = _invoke_installer(source, host)
    after = _measure()
    result.update(after)
    rc = proc.returncode if proc is not None else None
    result["installer_rc"] = rc
    if proc is not None and rc != 0:
        result["installer_tail"] = "\n".join((proc.stdout or "").splitlines()[-12:])
    if proc is None:
        result["code"] = PRELAUNCH_FAILED
        result["detail"] = "canonical installer process did not start"
        return result
    if rc != 0:
        result["code"] = PRELAUNCH_FAILED
        result["detail"] = f"canonical installer returned {rc}"
        return result
    if _stale(after):
        result["code"] = PRELAUNCH_FAILED
        result["detail"] = "installed runtime still differs from canonical after resync"
        return result
    result["ok"] = True
    result["code"] = PRELAUNCH_RESYNCED
    result["resynced"] = True
    # An ALREADY-RUNNING host still holds the previous module bytes. This flag
    # is the honest statement of that fact; the supported launch path consumes
    # it by starting the host AFTER this call, which is why it never has to ask
    # the operator to restart anything.
    result["requires_host_restart"] = True
    result["detail"] = (
        "installed runtime resynced to the canonical generation and verified "
        "(engine, guard hook, launcher surface, provenance marker)"
    )
    return result
