"""The declared core-unit family as SHIP evidence (T-1344).

``test_runner`` declares one core-unit family -- ``python -m unittest discover
-s tools -p test_*.py`` -- and closures kept recording green from narrower
invocations (named modules imported dotted, never the whole discovery in its
own order). Waves closed green while the declared family was red, because
nothing tied the evidence a SHIP cites to the family the repository declares.

This module is that tie, in three parts:

* **Baseline.** ``tools/core_unit_baseline.json`` records the family's inherited
  red set by test id. A NEW red is a test id outside it; the inherited ones stay
  visible without blocking unrelated Work.
* **Record.** A run of the declared family, in a disposable copy of the working
  tree, is written as a JSON record under ``.saipen/evidence/core-unit/`` with
  the content fingerprint of the copy it tested. A LOG record anchored on
  ``CORE-UNIT-EVIDENCE`` cites it by path and digest. The record is produced by
  running the family; prose about a run is not a run.
* **Gate.** ``ship_gate`` refuses a transition into SHIP when the project
  declares the family and the ticket's current VERIFY cycle cites no admissible
  record: none, a digest that does not match, a run with a new red, a run that
  did not complete, or a fingerprint that is not the tree being shipped.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

FAMILY_NAME = "unit"
#: The project declares the family by carrying the runner that declares it.
DECLARATION_REL = "tools/saipen_engine/test_runner.py"
BASELINE_REL = "tools/core_unit_baseline.json"
RECORD_DIR_REL = ".saipen/evidence/core-unit"
#: T-1481. The red sections of a fresh run, kept beside nothing that decides:
#: a runtime cache for advisory triage (SAIGPU), never part of a record.
RED_SECTIONS_REL = ".saipen/cache/core-unit"
#: One red section is cut to this many characters; the tail holds the error.
RED_SECTION_CHARS = 4000
MARKER = "CORE-UNIT-EVIDENCE"
SCHEMA_VERSION = 1
#: The subject is everything the sandbox copy holds except canonical state.
#: The family reads far more than tools/ and saipen/ -- tests/ fixtures,
#: bootstrap/, extensions/, VERSION and the root file set through validate.py
#: -- so a narrower digest let a PASS be reused for a tree it never tested.
#: `.saipen/` is left out on purpose: every checkpoint rewrites it, so
#: fingerprinting it would make any record stale the moment its own LOG line
#: lands. `.git/` is history, not the tree under test.
FINGERPRINT_EXCLUDED = (".git", ".saipen")

#: One red test in the unittest summary. ``-v`` prints a docstring in place of
#: the id on the progress line, so ids come from these headers only. A subTest
#: header appends ``[message]`` and/or ``(params)``; they are dropped, so every
#: red subtest of one test is that test's single id.
_RED_RE = re.compile(r"^(FAIL|ERROR|UNEXPECTED SUCCESS): (\S+) \(([^()\s]+)\)(?: .*)?$")
#: unittest's error list writes this separator directly above every header, so
#: a line that merely LOOKS like a header (a test printing `FAIL: ...`) is not one.
_SEPARATOR = "=" * 70
_HEADER_PREFIXES = ("FAIL: ", "ERROR: ", "UNEXPECTED SUCCESS: ")
_RAN_RE = re.compile(r"^Ran (\d+) tests? in ", re.MULTILINE)
_TALLY_RE = re.compile(r"^(OK|FAILED)\b(?: \((.*)\))?\s*$", re.MULTILINE)
_TALLY_FIELD_RE = re.compile(r"\b(?:failures|errors|unexpected successes)=(\d+)")
_EVIDENCE_RE = re.compile(
    r"^" + MARKER + r" (?P<verdict>PASS|FAIL)\b.*?"
    r"\brecord:(?P<record>\S+) sha256:(?P<sha>[0-9a-f]{64})\b"
)


def declared(root: Path | str) -> bool:
    """True when this project declares the core-unit family."""
    return (Path(root) / DECLARATION_REL).is_file()


def family():
    """The declared family, from the ONE registry `saipen test` also runs."""
    from .test_runner import _families

    for item in _families():
        if item.name == FAMILY_NAME:
            return item
    raise LookupError(f"test_runner declares no {FAMILY_NAME!r} family")


def parse_output(text: str) -> dict:
    """The red ids of a complete unittest run, with the counts that audit them.

    ``text`` is the runner's stream (stderr): a test's own stdout can print
    anything. ``headers`` counts red headers, ``unparsed`` the ones the id
    grammar missed, and ``tallied`` is the red total unittest printed on its
    final ``OK``/``FAILED (...)`` line (None when there is none).
    """
    body = (text or "").replace("\r\n", "\n")
    lines = body.split("\n")
    red = set()
    headers = parsed = 0
    for above, line in zip(lines, lines[1:]):
        if above != _SEPARATOR or not line.startswith(_HEADER_PREFIXES):
            continue
        headers += 1
        match = _RED_RE.match(line)
        if match is None:
            continue
        parsed += 1
        _kind, name, where = match.groups()
        red.add(where if where.endswith("." + name) else f"{where}.{name}")
    ran = _RAN_RE.findall(body)
    tally = _TALLY_RE.findall(body)
    tallied = None
    if tally:
        tallied = sum(int(count) for count in _TALLY_FIELD_RE.findall(tally[-1][1]))
    return {
        "ran": int(ran[-1]) if ran else None,
        "red": sorted(red),
        "headers": headers,
        "unparsed": headers - parsed,
        "tallied": tallied,
    }


def red_sections(text: str) -> dict:
    """``{test id: its section of the unittest error list}`` (T-1481).

    The same anchoring as ``parse_output``: a section starts at a separator
    line directly above a red header and ends at the next separator or dash
    rule that closes the error list. Long sections keep their tail, where the
    exception is.
    """
    lines = (text or "").replace("\r\n", "\n").split("\n")
    sections: dict = {}
    for index, (above, line) in enumerate(zip(lines, lines[1:])):
        if above != _SEPARATOR or not line.startswith(_HEADER_PREFIXES):
            continue
        match = _RED_RE.match(line)
        if match is None:
            continue
        _kind, name, where = match.groups()
        test_id = where if where.endswith("." + name) else f"{where}.{name}"
        body = []
        for follow in lines[index + 2 :]:
            if follow == _SEPARATOR or (follow.startswith("-" * 70) and body and body[-1] == ""):
                break
            body.append(follow)
        section = "\n".join([line, *body]).strip()
        if len(section) > RED_SECTION_CHARS:
            section = line + "\n...\n" + section[-RED_SECTION_CHARS:]
        sections.setdefault(test_id, section)
    return sections


def keep_red_sections(root: Path | str, record_path: str, sections: dict) -> str | None:
    """Cache a fresh run's red sections next to nothing canonical (T-1481)."""
    if not sections:
        return None
    directory = Path(root) / RED_SECTIONS_REL
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (Path(record_path).stem + ".red.json")
    payload = {"record": record_path, "sections": sections}
    path.write_text(json.dumps(payload, indent=1, ensure_ascii=False), encoding="utf-8")
    return path.relative_to(Path(root)).as_posix()


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_fingerprint(root: Path | str) -> str:
    """Content digest of the tested subject, tracked or not.

    The file set is the one ``run_family`` copies into its sandbox -- the same
    ignore rule -- minus ``FINGERPRINT_EXCLUDED`` at the top level, so the
    digest of the real tree and of the copy agree exactly when the bytes do.
    """
    from .test_runner import _ignore_copy

    base = Path(root)
    files = []
    for directory, dirnames, filenames in os.walk(base):
        here = Path(directory)
        ignored = _ignore_copy(directory, [*dirnames, *filenames])
        if here == base:
            ignored |= set(FINGERPRINT_EXCLUDED)
        dirnames[:] = sorted(name for name in dirnames if name not in ignored)
        files.extend(here / name for name in filenames if name not in ignored)
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda item: item.relative_to(base).as_posix()):
        if not path.is_file():
            continue
        digest.update(path.relative_to(base).as_posix().encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def load_baseline(root: Path | str) -> tuple[dict | None, str | None]:
    """``(baseline, error)``; exactly one is None."""
    path = Path(root) / BASELINE_REL
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, f"{BASELINE_REL} is missing"
    except (OSError, ValueError) as exc:
        return None, f"{BASELINE_REL} is unreadable: {exc}"
    red = data.get("red") if isinstance(data, dict) else None
    if (
        not isinstance(data, dict)
        or data.get("schema") != SCHEMA_VERSION
        or data.get("family") != FAMILY_NAME
        or not isinstance(red, list)
        or not all(isinstance(item, str) for item in red)
    ):
        return None, f"{BASELINE_REL} is not a schema {SCHEMA_VERSION} {FAMILY_NAME!r} baseline"
    return data, None


def baseline_digest(root: Path | str) -> str:
    return _sha256_file(Path(root) / BASELINE_REL)


#: The four files one checkpoint writes together. A copy that straddles a
#: checkpoint holds a STATE ahead of its LOG (T-1479).
CHECKPOINT_FILES = ("STATE.md", "LOG.md", "BOARD.md", "MANIFEST.json")
#: Attempts to copy `.saipen` between two checkpoints before giving up.
CONSISTENT_COPY_ATTEMPTS = 20


def _checkpoint_stamp(saipen_dir: Path) -> tuple:
    stamp = []
    for name in CHECKPOINT_FILES:
        try:
            st = (saipen_dir / name).stat()
        except FileNotFoundError:
            stamp.append(None)
            continue
        stamp.append((st.st_size, st.st_mtime_ns))
    return tuple(stamp)


def _without_locks(ignore):
    """Lock files are this process's runtime, not state: a held one cannot even
    be read on Windows, and a sandbox creates its own on demand."""

    def wrapped(directory: str, names: list[str]) -> set[str]:
        ignored = set(ignore(directory, names))
        if Path(directory).name == "locks":
            ignored.update(name for name in names if name.endswith(".lock"))
        return ignored

    return wrapped


def _copy_saipen_once(source: Path, target: Path, ignore, *, lock: bool) -> bool:
    """Copy ``source/.saipen`` to ``target``; True when no checkpoint landed meanwhile.

    The checkpoint files are compared before and after, so an optimistic copy
    that straddled a checkpoint is detected. With ``lock`` the canonical writer
    lock is also taken when it is free, so no writer can start a checkpoint
    mid-copy. Copying `.saipen` takes tens of seconds and a held lock refuses
    every canonical writer WRITER_BUSY meanwhile, so the lock is for a retry
    only, never the first attempt.
    """
    from .lock import WriterLock

    held = False
    writer = WriterLock(source)
    if lock:
        try:
            held = writer.acquire()
        except PermissionError:
            held = False
    try:
        before = _checkpoint_stamp(source / ".saipen")
        shutil.copytree(source / ".saipen", target, symlinks=True, ignore=_without_locks(ignore))
        return held or _checkpoint_stamp(source / ".saipen") == before
    finally:
        if held:
            writer.release()


def copy_tree_consistent(source: Path, sandbox: Path, ignore) -> None:
    """``shutil.copytree`` whose ``.saipen`` part is ONE checkpoint (T-1479).

    A checkpoint written while the tree is being copied left the sandbox with
    STATE.last_event ahead of the LOG tail; every state-reading test in it then
    answered VALIDATION_FAILED, and the evidence verdict described the copy
    race, not the subject.
    """

    def ignore_top_saipen(directory: str, names: list[str]) -> set[str]:
        ignored = set(ignore(directory, names))
        if Path(directory) == source and ".saipen" in names:
            ignored.add(".saipen")
        return ignored

    shutil.copytree(source, sandbox, symlinks=True, ignore=ignore_top_saipen)
    if not (source / ".saipen").is_dir():
        return
    for attempt in range(CONSISTENT_COPY_ATTEMPTS):
        # Each attempt gets a fresh directory BESIDE the sandbox, never inside
        # it: a torn copy is abandoned, not deleted. `.saipen` holds read-only
        # git objects (the saiwiki kitchen clone) that rmtree cannot remove on
        # Windows, and a half-deleted copy made the next attempt fail with
        # FileExistsError. The enclosing temporary directory reclaims them.
        staging = sandbox.parent / f"saipen-copy-{attempt}"
        if _copy_saipen_once(source, staging, ignore, lock=attempt > 0):
            os.replace(staging, sandbox / ".saipen")
            return
        time.sleep(min(0.25 * (attempt + 1), 2.0))
    raise RuntimeError(
        f"CORE_UNIT_COPY_TORN: .saipen changed during each of {CONSISTENT_COPY_ATTEMPTS} copies"
    )


#: T-1472. The family is ONE discovery; run as concurrent shards of it, each in
#: its own copy of the same subject, it proves the same thing in a fraction of
#: the wall time (2254 s sequential at af93fd56). One job is the declared
#: command itself, unchanged.
DEFAULT_JOBS = max(1, min(6, (os.cpu_count() or 2) // 2))
#: The stdlib-only shard runner. Like this module it is the harness, not the
#: subject: it runs from the engine, so any project declaring the family shards.
SHARD_RUNNER = Path(__file__).resolve().with_name("core_unit_shard.py")
#: Each module's measured time, kept to balance the next run's shards. A cache
#: beside the red sections: it decides only which shard runs a module.
DURATIONS_REL = ".saipen/cache/core-unit/durations.json"


def shardable(command) -> tuple[str, str] | None:
    """``(start, pattern)`` when ``command`` is exactly the declared discovery
    shape the shard runner reproduces, else None (the family then runs whole)."""
    tail = list(command)[1:]
    if len(tail) != 9 or tail[:4] != ["-B", "-m", "unittest", "discover"]:
        return None
    if tail[4] != "-s" or tail[6] != "-p" or tail[8] != "-v":
        return None
    return tail[5], tail[7]


def plan_shards(modules, weights: dict, jobs: int) -> list[list[str]]:
    """Longest-first onto the least-loaded shard; deterministic for equal input.

    A module with no measured weight is costed at the mean of the measured
    ones, so a new module neither starves nor swamps a shard.
    """
    modules = sorted(set(modules))
    known = [float(weights[name]) for name in modules if name in weights]
    default = sum(known) / len(known) if known else 1.0
    cost = {name: float(weights.get(name, default)) for name in modules}
    shards: list[list[str]] = [[] for _ in range(max(1, int(jobs)))]
    loads = [0.0] * len(shards)
    for name in sorted(modules, key=lambda item: (-cost[item], item)):
        index = min(range(len(shards)), key=lambda item: (loads[item], item))
        shards[index].append(name)
        loads[index] += cost[name]
    return shards


def load_durations(root: Path | str) -> dict:
    try:
        data = json.loads((Path(root) / DURATIONS_REL).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    modules = data.get("modules") if isinstance(data, dict) else None
    if not isinstance(modules, dict):
        return {}
    return {
        str(name): float(seconds)
        for name, seconds in modules.items()
        if isinstance(seconds, (int, float)) and seconds >= 0
    }


def keep_durations(root: Path | str, measured: dict) -> None:
    """Merge a run's per-module times into the balancing cache."""
    if not measured:
        return
    merged = {**load_durations(root), **measured}
    path = Path(root) / DURATIONS_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"schema": 1, "modules": dict(sorted(merged.items()))}
    path.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")


def _modules(sandbox: Path, start: str, pattern: str) -> list[str]:
    """The top-level test modules discovery will import, by file name. A module
    this misses is still run: the catch-all shard takes every unnamed one."""
    import fnmatch

    return sorted(
        path.stem
        for path in (sandbox / start).iterdir()
        if path.is_file()
        and path.suffix == ".py"
        and fnmatch.fnmatch(path.name, pattern)
        and path.stem.isidentifier()
    )


def _run_whole(sandbox: Path, declared_family, spool: Path) -> dict:
    from .test_runner import _run_family

    report = _run_family(sandbox, declared_family, spool=spool)
    # unittest's runner writes to stderr; stdout is the tests' own output.
    text = (spool / "stderr").read_bytes().decode("utf-8", errors="replace")
    return {
        "status": report["status"],
        "exit_code": report.get("exit_code"),
        **parse_output(text),
        "sections": red_sections(text),
    }


def _run_shard(sandbox: Path, declared_family, shape: tuple, spec: dict, work: Path) -> dict:
    from .test_runner import TestFamily, _run_family

    spool = work / "spool"
    spool.mkdir()
    spec_path = work / "spec.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    manifest_path = work / "manifest.json"
    command = (
        declared_family.command[0],
        "-B",
        str(SHARD_RUNNER),
        *shape,
        str(spec_path),
        str(manifest_path),
    )
    began = time.monotonic()
    report = _run_family(
        sandbox,
        TestFamily(declared_family.name, command, declared_family.timeout),
        spool=spool,
    )
    text = (spool / "stderr").read_bytes().decode("utf-8", errors="replace")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        manifest = None
    return {
        "status": report["status"],
        "exit_code": report.get("exit_code"),
        **parse_output(text),
        "sections": red_sections(text),
        "manifest": manifest if isinstance(manifest, dict) else None,
        "duration_s": round(time.monotonic() - began, 1),
    }


def merge_shards(shards: list[dict]) -> dict:
    """One run from its shards: red is the union, counts are sums, and the
    partition is proven by arithmetic -- every shard discovered the same
    family, and together they kept every discovered test exactly once."""
    statuses = [shard["status"] for shard in shards]
    if "TIMEOUT" in statuses:
        status = "TIMEOUT"
    else:
        status = "PASS" if all(item == "PASS" for item in statuses) else "FAIL"
    exits = [shard.get("exit_code") for shard in shards]
    if status == "TIMEOUT" or None in exits:
        exit_code = None
    else:
        exit_code = next((code for code in exits if code != 0), 0)
    rans = [shard.get("ran") for shard in shards]
    tallies = [shard.get("tallied") for shard in shards]
    manifests = [shard.get("manifest") or {} for shard in shards]
    sections: dict = {}
    durations: dict = {}
    for shard, manifest in zip(shards, manifests):
        sections.update(shard.get("sections") or {})
        for name, seconds in (manifest.get("modules") or {}).items():
            durations[name] = round(durations.get(name, 0.0) + float(seconds), 1)
    discovered = {manifest.get("discovered") for manifest in manifests}
    selected = [manifest.get("selected") for manifest in manifests]
    partition_error = None
    if None in discovered or None in selected:
        silent = [index for index, item in enumerate(selected) if item is None]
        partition_error = f"shard(s) {silent} never reported their discovery"
    elif len(discovered) != 1:
        partition_error = f"shards discovered different families: {sorted(discovered)}"
    elif sum(selected) != min(discovered):
        partition_error = f"shards kept {sum(selected)} of {min(discovered)} discovered tests"
    return {
        "status": status,
        "exit_code": exit_code,
        "ran": sum(rans) if None not in rans else None,
        "red": sorted({test for shard in shards for test in shard.get("red") or []}),
        "headers": sum(int(shard.get("headers") or 0) for shard in shards),
        "unparsed": sum(int(shard.get("unparsed") or 0) for shard in shards),
        "tallied": sum(tallies) if None not in tallies else None,
        "sections": sections,
        "discovered": next(iter(discovered)) if len(discovered) == 1 else None,
        "partition_error": partition_error,
        "shards": [
            {
                "status": shard["status"],
                "exit_code": shard.get("exit_code"),
                "ran": shard.get("ran"),
                "selected": manifest.get("selected"),
                "red": shard.get("red") or [],
                "headers": shard.get("headers"),
                "unparsed": shard.get("unparsed"),
                "tallied": shard.get("tallied"),
                "duration_s": shard.get("duration_s"),
            }
            for shard, manifest in zip(shards, manifests)
        ],
        "module_durations_s": dict(sorted(durations.items())),
    }


def run_family(root: Path | str, *, timeout: int | None = None, jobs: int = 1) -> dict:
    """Run the declared family in a disposable copy; parse the COMPLETE output.

    With ``jobs`` > 1 and a declared command of the discovery shape, the same
    discovery runs as that many concurrent shards, each in its own copy of the
    one consistent snapshot, and every copy must carry the tested fingerprint.
    """
    import contextlib
    from concurrent.futures import ThreadPoolExecutor

    from .test_runner import _ignore_copy

    source = Path(root).resolve()
    declared_family = family()
    if timeout is not None:
        declared_family = type(declared_family)(
            declared_family.name, declared_family.command, timeout
        )
    shape = shardable(declared_family.command) if int(jobs) > 1 else None
    count = int(jobs) if shape else 1
    started = time.monotonic()
    with contextlib.ExitStack() as stack:
        # Each shard lives where the sequential run lives -- its own
        # `saipen-core-unit-*/project` -- so no test sees a longer path.
        tmps = [
            Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="saipen-core-unit-")))
            for _ in range(count)
        ]
        sandboxes = [tmp / "project" for tmp in tmps]
        copy_tree_consistent(source, sandboxes[0], _ignore_copy)
        # The subject is what was copied, fingerprinted where it was tested:
        # a write to the real tree after this line changes nothing here.
        tested = tree_fingerprint(sandboxes[0])
        if count == 1:
            spool = tmps[0] / "spool"
            spool.mkdir()
            run = _run_whole(sandboxes[0], declared_family, spool)
        else:
            with ThreadPoolExecutor(max_workers=count) as pool:
                list(pool.map(lambda target: shutil.copytree(sandboxes[0], target, symlinks=True),
                              sandboxes[1:]))
                copies = list(pool.map(tree_fingerprint, sandboxes[1:]))
            if any(item != tested for item in copies):
                raise RuntimeError("CORE_UNIT_SHARD_COPY: a shard copy is not the tested subject")
            plan = plan_shards(_modules(sandboxes[0], *shape), load_durations(source), count)
            # Shard 0 is the catch-all: every module no other shard names.
            named = sorted({name for shard in plan[1:] for name in shard})
            specs = [{"exclude": named}, *({"include": shard} for shard in plan[1:])]
            with ThreadPoolExecutor(max_workers=count) as pool:
                shards = list(pool.map(
                    lambda index: _run_shard(
                        sandboxes[index], declared_family, shape, specs[index], tmps[index]
                    ),
                    range(count),
                ))
            run = merge_shards(shards)
    return {
        **run,
        "fingerprint": tested,
        "jobs": count,
        "duration_s": round(time.monotonic() - started, 1),
        "timeout_s": declared_family.timeout,
        "command": ["python", *declared_family.command[1:]],
    }


def _consistency(run: dict) -> list[str]:
    """What makes a run -- or one shard of it -- not a complete run."""
    red = run.get("red") or []
    problems = []
    if run.get("status") == "TIMEOUT":
        problems.append(f"the family did not finish inside {run.get('timeout_s')} s")
    if not run.get("ran"):
        problems.append("no 'Ran N tests' line: the family did not run to its summary")
    if run.get("exit_code") not in (0, None) and not red:
        problems.append(f"exit code {run.get('exit_code')} with no parsed red test")
    if run.get("exit_code") == 0 and red:
        problems.append("exit code 0 contradicts the parsed red tests")
    if run.get("unparsed"):
        problems.append(f"{run['unparsed']} red header(s) outside the id grammar")
    if run.get("tallied") is not None and run.get("tallied") != run.get("headers"):
        problems.append(
            f"unittest tallied {run['tallied']} red but {run.get('headers')} header(s) were read"
        )
    return problems


def judge(run: dict, baseline_red) -> dict:
    """The verdict of one run against the baseline; the arithmetic lives here only."""
    red = set(run.get("red") or [])
    inherited = set(baseline_red or [])
    new_red = sorted(red - inherited)
    fixed = sorted(inherited - red)
    problems = _consistency(run)
    for index, shard in enumerate(run.get("shards") or []):
        shard_run = {**shard, "timeout_s": run.get("timeout_s")}
        problems.extend(f"shard {index}: {problem}" for problem in _consistency(shard_run))
    if run.get("partition_error"):
        problems.append(str(run["partition_error"]))
    if new_red:
        problems.append(f"{len(new_red)} new red outside the baseline")
    return {
        "verdict": "FAIL" if problems else "PASS",
        "new_red": new_red,
        "fixed": fixed,
        "problems": problems,
    }


def _git_head(root: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def write_record(root: Path | str, run: dict, fingerprint: str) -> dict:
    """Judge ``run`` against the current baseline and persist the record."""
    base = Path(root)
    baseline, error = load_baseline(base)
    if error:
        raise ValueError(error)
    verdict = judge(run, baseline["red"])
    now = datetime.datetime.now(datetime.timezone.utc)
    record = {
        "schema": SCHEMA_VERSION,
        "family": FAMILY_NAME,
        "command": run["command"],
        "fingerprint": fingerprint,
        "fingerprint_excludes": list(FINGERPRINT_EXCLUDED),
        "baseline_sha256": baseline_digest(base),
        "head": _git_head(base),
        "finished_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": run["status"],
        "exit_code": run["exit_code"],
        "ran": run["ran"],
        "duration_s": run["duration_s"],
        "timeout_s": run.get("timeout_s"),
        "headers": run.get("headers"),
        "unparsed": run.get("unparsed"),
        "tallied": run.get("tallied"),
        "red": run["red"],
        # T-1472: how the one discovery was executed, and the proof that its
        # shards covered it. Absent for a whole (single-process) run.
        **{
            key: run[key]
            for key in ("jobs", "discovered", "partition_error", "shards", "module_durations_s")
            if run.get(key) is not None
        },
        **verdict,
    }
    directory = base / RECORD_DIR_REL
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{fingerprint[:16]}-{now.strftime('%Y%m%dT%H%M%SZ')}.json"
    path.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {
        "record": record,
        "path": path.relative_to(base).as_posix(),
        "sha256": _sha256_file(path),
    }


def reusable_record(root: Path | str, fingerprint: str) -> dict | None:
    """The newest PASS record of exactly this tree and baseline, or None.

    The family's subject is the fingerprinted content, so a Work that changed
    none of it (state, knowledge, a doc outside the trees) is proven by the run
    that already tested those bytes; rerunning would measure the same subject.
    """
    base = Path(root)
    baseline, error = load_baseline(base)
    if error:
        return None
    digest = baseline_digest(base)
    for path in sorted((base / RECORD_DIR_REL).glob(f"{fingerprint[:16]}-*.json"), reverse=True):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if (
            record.get("fingerprint") == fingerprint
            and record.get("baseline_sha256") == digest
            and judge(record, baseline["red"])["verdict"] == "PASS"
        ):
            return {
                "record": record,
                "path": path.relative_to(base).as_posix(),
                "sha256": _sha256_file(path),
            }
    return None


def evidence_line(written: dict) -> str:
    """The anchored LOG text that cites one record."""
    record = written["record"]
    return (
        f"{MARKER} {record['verdict']} family:{FAMILY_NAME} ran:{record['ran']} "
        f"red:{len(record['red'])} new_red:{len(record['new_red'])} "
        f"fixed:{len(record['fixed'])} fingerprint:{record['fingerprint'][:16]} "
        f"record:{written['path']} sha256:{written['sha256']}"
    )


def parse_evidence(text: str) -> dict | None:
    """The anchored citation in one LOG text, or None for anything else."""
    match = _EVIDENCE_RE.match((text or "").strip())
    return match.groupdict() if match else None


def _current_cycle(ticket_id: str, events: list[dict]) -> list[dict] | None:
    from .log import _is_verify_boundary

    for index in range(len(events) - 1, -1, -1):
        event = events[index]
        if (
            event.get("ticket") == ticket_id
            and event.get("taxonomy") == "RUN"
            and _is_verify_boundary(event)
        ):
            return events[index:]
    return None


def evidence_command(ticket_id: str) -> str:
    return f"python tools/core_unit.py evidence {ticket_id}"


def ship_gate(root: Path | str, ticket_id: str, events: list[dict]) -> str | None:
    """Why ``ticket_id`` may not enter SHIP, or None.

    Silent for a project that does not declare the family. Otherwise the
    ticket's CURRENT VERIFY cycle must cite a record of the declared family
    that is intact, complete, has no red outside the baseline, was judged
    against the baseline in force now, and tested the trees being shipped.
    """
    base = Path(root)
    if not declared(base):
        return None
    baseline, error = load_baseline(base)
    if error:
        return f"the declared core-unit family has no usable baseline: {error}"
    cycle = _current_cycle(ticket_id, events)
    if cycle is None:
        return f"{ticket_id} has no current VERIFY cycle to carry core-unit evidence"
    cited = None
    for event in reversed(cycle):
        if event.get("ticket") != ticket_id or event.get("taxonomy") != "RUN":
            continue
        cited = parse_evidence(event.get("text", ""))
        if cited is not None:
            break
    if cited is None:
        return (
            f"the current VERIFY cycle of {ticket_id} names no run of the declared "
            f"core-unit family ({' '.join(family().command[1:])})"
        )
    path = base / cited["record"]
    try:
        if not path.resolve().is_relative_to((base / RECORD_DIR_REL).resolve()):
            return f"cited record {cited['record']} is outside {RECORD_DIR_REL}"
        if _sha256_file(path) != cited["sha"]:
            return f"cited record {cited['record']} does not match its sha256"
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return f"cited record {cited['record']} is unreadable: {exc}"
    if record.get("family") != FAMILY_NAME or record.get("schema") != SCHEMA_VERSION:
        return f"cited record {cited['record']} is not a {FAMILY_NAME!r} family record"
    verdict = judge(record, baseline["red"])
    if verdict["verdict"] != "PASS":
        return f"cited core-unit run is not admissible: {'; '.join(verdict['problems'])}"
    if record.get("baseline_sha256") != baseline_digest(base):
        return "cited core-unit run was judged against a different baseline"
    if record.get("fingerprint") != tree_fingerprint(base):
        return (
            "cited core-unit run tested a different tree: the working tree "
            f"(outside {', '.join(FINGERPRINT_EXCLUDED)}) changed after it ran"
        )
    return None


def main(argv: list[str] | None = None) -> int:
    """CLI; run as ``python tools/core_unit.py`` (the package uses relative imports)."""
    import argparse

    parser = argparse.ArgumentParser(prog="core_unit.py", description=__doc__.split("\n", 1)[0])
    sub = parser.add_subparsers(dest="command", required=True)
    evidence = sub.add_parser("evidence", help="run the family and cite it in the ticket's LOG")
    evidence.add_argument("ticket")
    evidence.add_argument("--project-root", default=".")
    evidence.add_argument("--agent")
    evidence.add_argument("--timeout", type=int)
    evidence.add_argument(
        "--jobs",
        type=int,
        default=DEFAULT_JOBS,
        help="concurrent shards of the one discovery (1 = the declared command, whole)",
    )
    evidence.add_argument(
        "--fresh", action="store_true", help="run even when a PASS record of this tree exists"
    )
    baseline = sub.add_parser("baseline", help="record the family's current red set")
    baseline.add_argument("--project-root", default=".")
    baseline.add_argument("--from-record", help="a record path to take the red set from")
    baseline.add_argument(
        "--grow",
        metavar="REASON",
        help="required when the new baseline adds red ids the old one lacks",
    )
    baseline.add_argument("--timeout", type=int)
    baseline.add_argument("--jobs", type=int, default=DEFAULT_JOBS)
    args = parser.parse_args(argv)
    root = Path(args.project_root).resolve()

    if args.command == "baseline":
        return _baseline(root, args)
    return _evidence(root, args)


def _emit(payload: dict) -> int:
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0 if payload["ok"] else 1


def _baseline(root: Path, args) -> int:
    if args.from_record:
        record = json.loads((root / args.from_record).read_text(encoding="utf-8"))
        run = {key: record.get(key) for key in ("status", "exit_code", "ran", "red", "command")}
    else:
        run = run_family(root, timeout=args.timeout, jobs=args.jobs)
        keep_durations(root, run.get("module_durations_s") or {})
    if run["status"] not in ("PASS", "FAIL") or not run["ran"]:
        return _emit({"ok": False, "detail": "the family did not complete", "run": run})
    old, _error = load_baseline(root)
    grown = sorted(set(run["red"]) - set((old or {}).get("red") or []))
    if old is not None and grown and not args.grow:
        return _emit(
            {"ok": False, "detail": "baseline would grow; pass --grow REASON", "grown": grown}
        )
    data = {
        "schema": SCHEMA_VERSION,
        "family": FAMILY_NAME,
        "command": run["command"],
        "recorded_at": _git_head(root),
        "ran": run["ran"],
        "grown_because": args.grow if grown else None,
        "red": sorted(run["red"]),
    }
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    (root / BASELINE_REL).write_text(text, encoding="utf-8")
    return _emit({"ok": True, "red": len(data["red"]), "grown": grown})


def _evidence(root: Path, args) -> int:
    from . import operations
    from .state import parse_state

    _baseline_data, error = load_baseline(root)
    if error:
        return _emit({"ok": False, "detail": error})
    fingerprint = tree_fingerprint(root)
    written = None if args.fresh else reusable_record(root, fingerprint)
    reused = written is not None
    if written is None:
        run = run_family(root, timeout=args.timeout, jobs=args.jobs)
        keep_durations(root, run.get("module_durations_s") or {})
        # The record is the truth about the copy that ran, so it is kept either
        # way; a tree that drifted since the copy only loses the citation.
        written = write_record(root, run, run.get("fingerprint") or fingerprint)
        keep_red_sections(root, written["path"], run.get("sections") or {})
        if tree_fingerprint(root) != written["record"]["fingerprint"]:
            return _emit(
                {
                    "ok": False,
                    "detail": (
                        "the working tree changed after the family's copy was taken; "
                        "the record describes that copy and is not cited. Remove the "
                        "drift and rerun this command (it reuses a PASS record of an "
                        "identical tree) or rerun with --fresh"
                    ),
                    "verdict": written["record"]["verdict"],
                    "record": written["path"],
                }
            )
    state = parse_state((root / ".saipen" / "STATE.md").read_text(encoding="utf-8"))
    agent = args.agent or state.get("agent") or "unknown"
    result = operations.checkpoint(root, agent, "RUN", args.ticket, evidence_line(written))
    record = written["record"]
    return _emit(
        {
            "ok": result.ok and record["verdict"] == "PASS",
            "verdict": record["verdict"],
            "ran": record["ran"],
            "red": len(record["red"]),
            "new_red": record["new_red"],
            "fixed": record["fixed"],
            "problems": record["problems"],
            "record": written["path"],
            "reused": reused,
            "checkpoint": result.code,
            "checkpoint_detail": result.message or None,
        }
    )
