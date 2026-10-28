"""ONE canonical host bootstrap / runtime-binding resolver (T-1424).

The field failure this exists for: a SAIPEN-managed project (root carrying
`.saipen/`) was opened in an isolated host whose shell could not resolve the
`saipen` executable or the Python engine. Nothing recognised the protocol
commands, nothing proved the canonical runtime, and the host went on editing
product bytes as if it were an ordinary writable session -- SAIPEN silently
disappeared with no third state and no refusal.

This module is the single owner of the question "can THIS host reach a
canonical SAIPEN runtime for THIS project, and if not, exactly where did the
chain break?". It is read-only: it never installs, never mutates, and never
scans arbitrary disks or guesses an installation path. Every candidate it
examines comes from SAIPEN-controlled state -- the project's own
`.saipen/STATE.md` pointer, the executing engine itself, or the environment
carrier a verified launch wrote.

Resolution order (the message the operator/model receives is derived from it):

  A. project binding   -- `.saipen/` present / asserted binding verifies
  B. activation        -- the canonical activation contract is loadable
  C. P A T H           -- a canonical `saipen` command already resolves
  D. controlled home   -- a SAIPEN-controlled pointer names the install
  E. direct entrypoint -- the named home carries the engine + a Python
  F. launcher          -- the named home carries an EXECUTABLE launcher (bin/)
  G. unavailable       -- none of the above: structured refusal, no product writes

`SAIPEN_HOST_RUNTIME_UNAVAILABLE` is the ONE stable diagnostic. It carries the
attempted candidate list, the exact unsupported boundary, and the remediation,
so an adapter or operator can recover without being told a path by hand.

Three verdicts are NOT the same thing and are never merged (T-1425):

  * runtime discovered -- a canonical home + engine proved from its own bytes;
  * host admitted      -- the resolved runtime may be used for managed work,
                          which an explicitly UNREGISTERED host may not be;
  * bridge reachable   -- an actual cross-boundary transport was probed. A file
                          path inside another execution boundary is NOT a
                          bridge, and this resolver never claims one.

A discovered runtime on an unknown explicit host therefore returns
`HOST_UNSUPPORTED` with `ok: false` and the discovery kept in the diagnostic
fields. `replacement_candidates()` is the ONE enumeration the automatic
rebind operation (`saipen rebind-home --auto`) consumes; it never invents a
candidate the resolver would not also examine.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

from .paths import (
    ENV_SKILL_ROOT,
    resolve_project_root,
    resolve_protocol_dir,
)

#: The three terminal codes. `BOUND` is the only green one; a managed project
#: whose runtime is not proven is UNAVAILABLE, and an explicitly named host
#: that is not in the registry is HOST_UNSUPPORTED even when a runtime proves
#: (discovery is diagnostic data, never writable admission).
BOUND = "HOST_BOOTSTRAP_BOUND"
UNAVAILABLE = "SAIPEN_HOST_RUNTIME_UNAVAILABLE"
HOST_UNSUPPORTED = "HOST_UNSUPPORTED"
NOT_SAIPEN = "NOT_SAIPEN_PROJECT"

#: Closed boundary vocabulary: the exact leg of the chain that failed. A
#: consumer branches on this, never on prose.
BOUNDARY_PROJECT = "project_binding"
BOUNDARY_ACTIVATION = "activation_contract"
BOUNDARY_RUNTIME = "canonical_runtime"
BOUNDARY_ENTRYPOINT = "direct_entrypoint"
BOUNDARY_BRIDGE = "host_bridge"
BOUNDARY_HOST = "host_registry"

#: Files an install must carry to be a usable SAIPEN home, layout-agnostic
#: (`BOOT.md` at the root in a flattened install, under `saipen/` in a clone --
#: `resolve_protocol_dir` decides which).
_ACTIVATION_RELATIVE = "ACTIVATION_BLOCK.md"


def _registry_path() -> Path:
    """The adapter registry beside the executing engine, in either layout."""
    here = Path(__file__).resolve()
    for base in (here.parents[2], here.parents[2] / "saipen"):
        candidate = base / "extensions" / "adapters" / "registry.json"
        if candidate.is_file():
            return candidate
    return here.parents[2] / "extensions" / "adapters" / "registry.json"


def _load_adapters() -> dict[str, dict]:
    """The one declarative host registry, keyed by lower-case adapter id.

    Reuses the registry owner; a missing registry is a bootstrap failure, not
    a silent empty inventory.
    """
    try:
        raw = json.loads(_registry_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    entries = raw.get("adapters") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return {}
    return {
        str(entry["id"]).lower(): entry
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    }


def _expand(value: object) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return Path(os.path.expandvars(os.path.expanduser(value)))


def _home_candidates(
    project_root: Path | None, env: dict, engine_root: Path | None = None
) -> list[dict]:
    """Every SAIPEN-controlled pointer to a canonical install, in order.

    Deliberately NO directory scanning and NO basename guessing: a candidate is
    only ever a value SAIPEN itself persisted (the project's STATE pointer), a
    carrier a verified launch exported, or the engine already executing this
    resolver.
    """
    candidates: list[dict] = []

    def add(source: str, value: object) -> None:
        if value is None:
            return
        candidates.append({"source": source, "path": str(value)})

    add("environment-skill-root", env.get(ENV_SKILL_ROOT))
    if project_root is not None:
        persisted, _problem = _persisted_home(project_root)
        add("state-saipen-home", persisted)
    # The engine executing this call IS a canonical runtime: bootstrapping from
    # it is proof, not a guess. It is last so a project's own pointer wins.
    # `engine_root` is injectable so a fixture can express "this host runs an
    # engine that is not itself a usable install" without patching the resolver.
    add("executing-engine", engine_root or Path(__file__).resolve().parents[2])
    return candidates


def _persisted_home(project_root: Path) -> tuple[object, str | None]:
    """The persisted STATE pointer and its DEAD-ness, read once.

    Read-only and bounded; a missing/unreadable STATE yields `(None, None)`,
    which is the legacy/unverifiable shape the pointer contract already
    treats as "no machine-local binding".
    """
    from .state import parse_frontmatter, persisted_home_error

    state_path = project_root / ".saipen" / "STATE.md"
    try:
        fields, error = parse_frontmatter(state_path.read_text(encoding="utf-8"))
    except OSError:
        fields, error = None, None
    if error is not None or not isinstance(fields, dict):
        return None, None
    value = fields.get("saipen_home")
    return value, persisted_home_error(value)


def replacement_candidates(
    project_root: Path | str | None = None,
    *,
    env: dict | None = None,
    engine_root: Path | str | None = None,
) -> list[dict]:
    """Candidates that may REPLACE a dead persisted home, in trust order.

    The persisted pointer is excluded on purpose: it is the dead value being
    replaced. What remains is only what a verified launch exported, or the
    engine already executing -- both are canonical proofs, neither is a disk
    scan or a guessed path. The caller still proves each candidate against its
    own install layout before any write; discovery alone is not admission.
    """
    source_env = dict(os.environ if env is None else env)
    root = Path(project_root) if project_root is not None else None
    candidates = _home_candidates(
        root, source_env, Path(engine_root) if engine_root is not None else None
    )
    return [row for row in candidates if row.get("source") != "state-saipen-home"]


def _prove_home(candidate: str) -> dict:
    """Prove one candidate is a usable SAIPEN home (activation + engine).

    Returns a record with `ok`, `home`, `protocol_dir`, `engine`, `boundary`
    and `why`. A candidate is proven from its OWN bytes -- the repository clone
    (documents under `saipen/`) and a flattened install are one shape here
    because `resolve_protocol_dir` owns that distinction.
    """
    home = _expand(candidate)
    record = {"source": None, "home": str(home) if home else candidate, "ok": False}
    if home is None or not home.is_dir():
        record["why"] = "path does not resolve to a directory on this host"
        return record
    try:
        protocol_dir = resolve_protocol_dir(home)
    except ValueError as exc:
        record["why"] = f"no BOOT.md cold-start kernel: {exc}"
        return record
    record["protocol_dir"] = str(protocol_dir)
    if not (protocol_dir / _ACTIVATION_RELATIVE).is_file():
        record["why"] = (
            f"activation contract missing: {protocol_dir / _ACTIVATION_RELATIVE}"
        )
        record["boundary"] = BOUNDARY_ACTIVATION
        return record
    # The engine root is the installation root (source clone) or the flattened
    # skill root; `resolve_tool_root` semantics are: `<root>/tools/saipen.py`.
    engine = home / "tools" / "saipen.py"
    if not engine.is_file():
        record["why"] = f"engine missing: {engine}"
        record["boundary"] = BOUNDARY_ENTRYPOINT
        return record
    record["engine"] = str(engine)
    record["ok"] = True
    return record


def _launcher(home: Path) -> dict:
    """The installed CLI launcher surface (`bin/saipen[.cmd]`) for a home.

    Discovery, reachability and transport are THREE different facts (T-1425):

      discovered -- a launcher file exists;
      executable -- this host can actually run it (POSIX: the +x bit;
                    Windows: a `.cmd` shim, which is the only runnable form);
      transport  -- `direct_launcher` only when it is executable, else `none`.

    A file that merely exists is launcher inventory, not a usable transport,
    and is never reported as one.
    """
    record = {
        "ok": False,
        "discovered": False,
        "executable": False,
        "dir": None,
        "posix": None,
        "windows": None,
        "transport": "none",
        "why": "no bin/saipen or bin/saipen.cmd in this install",
    }
    for base in (home / "bin", home / "saipen" / "bin"):
        posix = base / "saipen"
        windows = base / "saipen.cmd"
        if not (posix.is_file() or windows.is_file()):
            continue
        record.update(
            discovered=True,
            dir=str(base),
            posix=str(posix) if posix.is_file() else None,
            windows=str(windows) if windows.is_file() else None,
        )
        if os.name == "nt":
            executable = windows.is_file()
            why = (
                ""
                if executable
                else "launcher exists but is not runnable by this host: "
                "no bin/saipen.cmd (a bare bin/saipen is not executable here)"
            )
        else:
            executable = posix.is_file() and os.access(posix, os.X_OK)
            why = (
                ""
                if executable
                else "launcher file exists but is not executable (missing +x)"
            )
        record.update(
            executable=executable,
            ok=executable,
            transport="direct_launcher" if executable else "none",
            why=why,
        )
        break
    return record


def _host_record(host: str | None, adapters: dict[str, dict]) -> dict:
    if not host:
        return {"host": None, "known": False, "strength": "UNKNOWN"}
    entry = adapters.get(host.lower())
    if entry is None:
        return {"host": host, "known": False, "strength": "ENFORCEMENT_GAP"}
    return {
        "host": entry.get("id"),
        "known": True,
        "blocking_capability": bool(entry.get("blocking_capability")),
        "declared_strength": entry.get("declared_strength"),
        "install": entry.get("install"),
    }


def _remediation(code: str, boundary: str | None, host: str | None) -> str:
    if boundary == BOUNDARY_PROJECT:
        return "run from the managed project, or pass --project-root <path>"
    if boundary == BOUNDARY_ACTIVATION:
        return "reinstall the SAIPEN skill for this host (bootstrap/inject.ps1|sh --adapter <id>)"
    if boundary == BOUNDARY_RUNTIME:
        return (
            "the project's STATE.saipen_home does not resolve to a SAIPEN install "
            "on this host; point at one with `saipen rebind-home <candidate>`"
        )
    if boundary == BOUNDARY_ENTRYPOINT:
        return (
            "the resolved SAIPEN home has no tools/saipen.py; install the runtime "
            "for this host (bootstrap/inject.ps1|sh)"
        )
    if boundary == BOUNDARY_BRIDGE:
        return (
            "no canonical launcher is reachable from this shell; prepend the "
            "installed skill's bin/ to PATH, or use a host integration that injects it"
        )
    if boundary == BOUNDARY_HOST:
        return (
            "host is not registered in extensions/adapters/registry.json; "
            "register the adapter or run bootstrap under a supported host id"
        )
    return "no canonical SAIPEN runtime is reachable from this host"


def _fingerprint(payload: dict) -> str:
    """A stable digest of the diagnosis so a host can suppress repeated output."""
    stable = {
        key: payload.get(key)
        for key in ("code", "boundary", "project_root", "saipen_home", "host")
    }
    return hashlib.sha256(
        json.dumps(stable, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def _finalize_host(result: dict, host_refused: bool) -> dict:
    """Apply the host-admission verdict without hiding runtime discovery.

    An explicitly named host that the registry does not know is never green:
    `ok` becomes false and `code` becomes HOST_UNSUPPORTED. What the resolver
    DID discover stays in the same payload (`saipen_home`, `engine`,
    `runtime_discovered`, `runtime_boundary`), because separating "runtime
    discovered" from "host admitted" is exactly the point -- a diagnostic
    consumer may read the first, and no writable managed-host operation may
    read the second as permission.
    """
    if not host_refused:
        return result
    result["runtime_discovered"] = bool(
        result.get("saipen_home") and result.get("engine")
    )
    if result.get("code") == NOT_SAIPEN:
        # Not a managed project at all: the project verdict is the first fact.
        result["fingerprint"] = _fingerprint(result)
        return result
    if result.get("boundary") != BOUNDARY_HOST:
        result["runtime_boundary"] = result.get("boundary")
    result["ok"] = False
    result["code"] = HOST_UNSUPPORTED
    result["boundary"] = BOUNDARY_HOST
    result["remediation"] = (
        f"host {result.get('host')!r} is not registered in "
        "extensions/adapters/registry.json; register the adapter or run "
        "bootstrap under a supported host id"
    )
    result["fingerprint"] = _fingerprint(result)
    return result


def resolve_bootstrap(
    project_root: Path | str | None = None,
    *,
    host: str | None = None,
    start: Path | str | None = None,
    env: dict | None = None,
    honor_environment: bool = True,
    engine_root: Path | str | None = None,
) -> dict:
    """Resolve the canonical SAIPEN runtime binding for one host + project.

    Read-only. Returns a stable structured record whose `code` is BOUND (the
    only green value), UNAVAILABLE, HOST_UNSUPPORTED, or NOT_SAIPEN. `env` is
    injectable for fixtures; absent, the process environment is used.
    `honor_environment` admits the verified host/session carrier
    (`SAIPEN_PROJECT_ROOT`), which is exactly what a detached staging launch
    writes. `engine_root` overrides the executing-engine candidate so a fixture
    can express a host that has no usable engine, without patching the resolver.
    """
    source_env = dict(os.environ if env is None else env)
    adapters = _load_adapters()
    host_record = _host_record(host, adapters)
    host_refused = bool(host) and not host_record.get("known", False)
    result: dict = {
        "ok": False,
        "code": UNAVAILABLE,
        "host": (host or None),
        "host_record": host_record,
        "host_supported": host_record.get("known", False),
        "project_root": None,
        "project_lineage": None,
        "saipen_home": None,
        "protocol_dir": None,
        "engine": None,
        "launcher": None,
        "bridge": None,
        "binding": None,
        "runtime_discovered": False,
        "python": sys.executable or None,
        "attempted": [],
        "boundary": BOUNDARY_RUNTIME,
        "remediation": "",
        "fingerprint": "",
    }

    # A. project binding ----------------------------------------------------
    resolved = resolve_project_root(
        start, explicit=project_root, honor_environment=honor_environment
    )
    if not resolved.ok:
        if getattr(resolved, "code", None) == "NOT_SAIPEN_PROJECT":
            result.update(
                code=NOT_SAIPEN,
                boundary=None,
                detail=getattr(resolved, "reason", ""),
                remediation="no SAIPEN project or asserted binding; guard non-interfering",
            )
            result["fingerprint"] = _fingerprint(result)
            return _finalize_host(result, host_refused)
        result.update(
            code=UNAVAILABLE,
            boundary=BOUNDARY_PROJECT,
            detail=getattr(resolved, "reason", "project binding did not verify"),
            attempted=[{"source": "project-binding", "ok": False,
                        "why": getattr(resolved, "reason", "")}],
        )
        result["remediation"] = _remediation(UNAVAILABLE, BOUNDARY_PROJECT, host)
        result["fingerprint"] = _fingerprint(result)
        return _finalize_host(result, host_refused)

    root = Path(resolved.root)
    result["project_root"] = str(root)
    result["project_lineage"] = resolved.lineage

    persisted_value, persisted_problem = _persisted_home(root)
    result["binding"] = {
        "persisted_home": persisted_value,
        "persisted_home_dead": persisted_problem is not None,
        "reason": persisted_problem,
    }

    # C. PATH command already resolves -------------------------------------
    # A canonical `saipen` on PATH is REPORTED, never trusted as the binding:
    # a launcher from another install is still an install, and the binding must
    # name which one. The controlled-home resolution below owns the verdict.
    which = shutil.which("saipen", path=source_env.get("PATH"))
    if which:
        result["attempted"].append({"source": "path", "path": which, "ok": True})

    # D/E/F. controlled home -> entrypoint + launcher ----------------------
    chosen = None
    for candidate in _home_candidates(root, source_env, engine_root):
        record = _prove_home(candidate["path"])
        record["source"] = candidate["source"]
        result["attempted"].append(record)
        if record.get("ok") and chosen is None:
            chosen = record
    if chosen is not None:
        home = Path(chosen["home"])
        launcher = _launcher(home)
        launcher_reachable = bool(launcher.get("ok"))
        reachable = bool(which) or launcher_reachable
        result["saipen_home"] = chosen["home"]
        result["protocol_dir"] = chosen.get("protocol_dir")
        result["engine"] = chosen.get("engine")
        result["launcher"] = launcher
        result["runtime_discovered"] = True
        result["bridge"] = {
            "required": not reachable,
            "transport": (
                "path" if which else ("direct_launcher" if launcher_reachable else "none")
            ),
            # This resolver probes no cross-boundary transport. A launcher file
            # inside an isolated host is a path, not a bridge, and is never
            # claimed as one (T-1425).
            "cross_boundary": False,
            "why": (
                ""
                if reachable
                else "engine reachable but no launcher transport: no `saipen` "
                "on PATH and no executable bin/ launcher for this host"
            ),
        }
        result["bridge_required"] = not reachable
        if result["binding"] is not None and result["binding"].get("persisted_home_dead"):
            result["binding"]["convergence_command"] = "saipen rebind-home --auto"
        result["ok"] = True
        result["code"] = BOUND
        result["boundary"] = None
        result["remediation"] = "canonical SAIPEN runtime reachable"
        result["fingerprint"] = _fingerprint(result)
        return _finalize_host(result, host_refused)

    # G. unavailable --------------------------------------------------------
    # The boundary is the FIRST failing leg encountered while walking the
    # candidates in order, so the diagnostic names the earliest thing the
    # operator must fix. A pointer that does not resolve on this host is
    # BOUNDARY_RUNTIME; a home that resolved but lacks the activation contract
    # or the engine names that leg; nothing with a usable home at all is
    # BOUNDARY_BRIDGE (there is no reachable runtime surface to bind).
    result["boundary"] = next(
        (r["boundary"] for r in result["attempted"] if r.get("boundary")),
        None,
    )
    if result["boundary"] is None:
        if any(
            r.get("why", "").startswith("path does not resolve")
            for r in result["attempted"]
        ):
            result["boundary"] = BOUNDARY_RUNTIME
        else:
            result["boundary"] = BOUNDARY_BRIDGE
    result["detail"] = (
        "no canonical SAIPEN runtime binding could be established for this host: "
        + "; ".join(
            f"{r.get('source')}={r.get('why')}" for r in result["attempted"] if r.get("why")
        )[:600]
    )
    result["bridge"] = {
        "required": True,
        "transport": "none",
        "cross_boundary": False,
        "why": "no runtime surface is reachable; no cross-boundary transport was probed",
    }
    if result["binding"] is not None and result["binding"].get("persisted_home_dead"):
        result["binding"]["convergence_command"] = "saipen rebind-home --auto"
    result["remediation"] = _remediation(UNAVAILABLE, result["boundary"], host)
    result["fingerprint"] = _fingerprint(result)
    return _finalize_host(result, host_refused)


def host_record(host: str | None) -> dict:
    """Public read-only projection of the registry entry for one host id."""
    return _host_record(host, _load_adapters())


def activation_contract(project_root: Path | str) -> dict:
    """Do the project and its resolved install carry the activation contract?

    The argument is the MANAGED PROJECT ROOT (a directory containing
    `.saipen/`), never the install home: the activation contract is a property
    of the install, but the question is asked about a project and answered
    through the SAME controlled-home resolution `resolve_bootstrap` uses. That
    is what makes it work for a flattened/installed runtime home that has no
    `.saipen/` of its own (T-1425 REPAIR 3).
    Read-only. Names the exact missing leg rather than a boolean.
    """
    root = Path(project_root)
    if not (root / ".saipen").is_dir():
        return {
            "ok": False,
            "code": NOT_SAIPEN,
            "detail": (
                f"no .saipen/ under {root} -- activation is asked about a "
                "managed project root, not an install home"
            ),
        }
    state = root / ".saipen" / "STATE.md"
    if not state.is_file():
        return {"ok": False, "code": UNAVAILABLE, "boundary": BOUNDARY_PROJECT,
                "detail": f"missing {state}"}
    # The activation contract is a property of the INSTALL, checked by
    # `_prove_home`; here we only answer whether the project EXPECTS activation.
    home = None
    for candidate in _home_candidates(root, dict(os.environ)):
        record = _prove_home(candidate["path"])
        if record.get("ok"):
            home = record
            break
    if home is None:
        return {"ok": False, "code": UNAVAILABLE, "boundary": BOUNDARY_RUNTIME,
                "detail": "no canonical SAIPEN install resolves for this project"}
    return {
        "ok": True,
        "code": "ACTIVATION_PRESENT",
        "saipen_home": home["home"],
        "activation": str(Path(home["protocol_dir"]) / _ACTIVATION_RELATIVE),
    }
