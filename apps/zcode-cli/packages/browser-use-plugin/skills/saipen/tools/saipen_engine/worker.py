"""T-1446 / SRC-100: the bounded autonomy worker, as a real separate process.

`supervisor` decides; this runs. It is a separate module AND a separate
process on purpose: "the worker died" is the case the whole lease design
exists for, and a worker that is a function call in the supervisor's own
process cannot die without taking the supervisor with it. Every in-process
test of crash recovery is therefore a test of something else.

One slice is: prove the lease still admits mutation, refresh the heartbeat,
advance the durable checkpoint, repeat. The checkpoint is DERIVED runtime
state under `.saipen/cache/`, never canonical truth -- a replacement
generation reads it to learn where the dead generation stopped, and then
resolves what to do next through the canonical router like any cold worker.

`--die-after N` exits with `os._exit`, skipping every finally-block and
atexit hook, because a worker that gets to clean up after itself is not the
worker this protocol has to survive.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as _dt
import json
import os
import sys
from pathlib import Path

from . import supervisor, watchdog
from .paths import safe_atomic_write_bytes

CHECKPOINT_REL = Path(".saipen") / "cache" / "autonomy-worker.json"
LIVE_GENERATION_REL = Path(".saipen") / "cache" / "autonomy-live-generation.json"
SCHEMA_VERSION = 1

#: Exit codes. A worker's exit status is the only thing a supervisor that did
#: not read its stdout can see, so each refusal gets its own number.
EXIT_OK = 0
EXIT_NO_AUTHORITY = 3
EXIT_STOPPED = 4
EXIT_FENCED = 5


def checkpoint_path(root: Path | str) -> Path:
    return Path(root).resolve() / CHECKPOINT_REL


def read_checkpoint(root: Path | str) -> dict | None:
    """The last durable slice a worker finished here, or None."""
    try:
        payload = json.loads(checkpoint_path(root).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        return None
    return payload


def write_checkpoint(root: Path | str, payload: dict) -> None:
    root = Path(root).resolve()
    body = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    safe_atomic_write_bytes(
        checkpoint_path(root),
        body,
        kind="autonomy worker checkpoint",
        ownership_root=root,
    )


def _utc(now: _dt.datetime | None = None) -> str:
    return watchdog._utc(now)


def take_authority(
    root: Path | str,
    worker_id: str,
    *,
    now: _dt.datetime | None = None,
    suspect_after: float = 30.0,
    expire_after: float = 120.0,
) -> dict:
    """Acquire, adopt or replace -- whichever the supervisor's verdict allows.

    Never a fourth option. A worker that decides for itself which of these it
    is doing is a worker that can take a live generation's seat.
    """
    verdict = supervisor.decide(
        root,
        now=now,
        worker_id=worker_id,
        suspect_after=suspect_after,
        expire_after=expire_after,
    )
    name = verdict["verdict"]
    if name == supervisor.ADOPT_WORKER:
        return {
            "ok": True,
            "code": "LEASE_ADOPTED",
            "generation": verdict["adopt_generation"],
            "verdict": name,
        }
    if name == supervisor.RUN_WORK:
        try:
            lease = watchdog.acquire_lease(root, worker_id, now=now)
        except RuntimeError as exc:
            return {"ok": False, "code": str(exc), "verdict": name}
        return {
            "ok": True,
            "code": "LEASE_ACQUIRED",
            "generation": lease["lease_generation"],
            "verdict": name,
        }
    if name == supervisor.REPLACE_WORKER:
        replaced = supervisor.replace_worker(
            root,
            worker_id,
            now=now,
            suspect_after=suspect_after,
            expire_after=expire_after,
        )
        if not replaced["ok"]:
            return {**replaced, "verdict": name}
        return {
            "ok": True,
            "code": "LEASE_REPLACED",
            "generation": replaced["lease"]["lease_generation"],
            "fenced_generation": replaced["fenced_generation"],
            "verdict": name,
        }
    return {"ok": False, "code": name, "reason": verdict["reason"], "verdict": name}


def run_slice(
    root: Path | str,
    worker_id: str,
    generation: int,
    *,
    index: int,
    work: str | None,
    now: _dt.datetime | None = None,
) -> dict:
    """One bounded unit: admission check, heartbeat, durable checkpoint."""
    if not watchdog.mutation_allowed(root, worker_id, generation, now=now):
        return {"ok": False, "code": "FENCED_LEASE_GENERATION"}
    watchdog.heartbeat(root, worker_id, generation, now=now)
    previous = read_checkpoint(root) or {}
    payload = {
        "schema_version": SCHEMA_VERSION,
        "worker_id": worker_id,
        "lease_generation": generation,
        "slice_index": index,
        "slices_total": int(previous.get("slices_total") or 0) + 1,
        "work": work,
        "at": _utc(now),
        "previous_worker": previous.get("worker_id"),
        "previous_generation": previous.get("lease_generation"),
    }
    write_checkpoint(root, payload)
    return {"ok": True, "code": "SLICE_DONE", "checkpoint": payload}


def serve(
    root: Path | str,
    worker_id: str,
    *,
    slices: int = 1,
    die_after: int | None = None,
    suspect_after: float = 30.0,
    expire_after: float = 120.0,
) -> dict:
    """Take authority, run bounded slices, report. Crashes hard on demand."""
    root = Path(root)
    authority = take_authority(
        root, worker_id, suspect_after=suspect_after, expire_after=expire_after
    )
    if not authority["ok"]:
        return authority
    generation = authority["generation"]
    picture = supervisor.observe(
        root, suspect_after=suspect_after, expire_after=expire_after
    )
    work = picture["active_work"] or picture["executable_work"]
    done = 0
    for index in range(1, int(slices) + 1):
        outcome = run_slice(root, worker_id, generation, index=index, work=work)
        if not outcome["ok"]:
            return {**outcome, "generation": generation, "slices_done": done}
        done = index
        if die_after is not None and done >= int(die_after):
            # A crash, not a shutdown: no finally, no atexit, no lease release.
            sys.stdout.flush()
            os._exit(9)
    return {
        "ok": True,
        "code": "WORKER_DONE",
        "generation": generation,
        "slices_done": done,
        "authority": authority["code"],
        "work": work,
    }


# ---------------------------------------------------------------------------
# T-1446 M12/M13: the execution owner. `supervisor.decide` names the verdict;
# this loop turns each verdict into a real worker lifecycle action -- launch
# one generation of an agent host, heartbeat its lease while it lives, detect
# death, freeze and provider failure, fence it, and decide again. It is the
# only place in SAIPEN that starts agent processes on its own.

#: Seconds to wait before retrying a transient provider failure, by streak.
FAILURE_BACKOFF_SECONDS = (5.0, 15.0, 30.0, 60.0, 120.0)
#: Placeholder in the agent argv that receives the current model.
MODEL_PLACEHOLDER = "{model}"
#: Bounded output tail kept for failure classification and evidence.
OUTPUT_TAIL_BYTES = 64 * 1024

_STOP_VERDICTS = frozenset(
    {
        supervisor.IDLE,
        supervisor.OPERATOR_ACTION_DUE,
        supervisor.NO_PROGRESS_LOOP,
        supervisor.AMBIGUOUS_AUTHORITY,
    }
)


def _progress_marker(root: Path) -> dict:
    """Where canonical execution stands, from STATE alone (read-only)."""
    fields = supervisor._state_fields(supervisor._read(root, "STATE.md"))
    return {
        "last_event": fields.get("last_event", ""),
        "phase": fields.get("phase", ""),
        "task": fields.get("task", ""),
        "next_action": fields.get("next_action", ""),
        "blocker": fields.get("blocker", ""),
    }


def _agent_argv(template: list[str], model: str | None) -> list[str]:
    if model is None:
        return [part for part in template]
    return [part.replace(MODEL_PLACEHOLDER, model) for part in template]


def _tail(handle) -> str:
    """The last whole lines within OUTPUT_TAIL_BYTES.

    A cut that lands mid-line keeps the END of some line, and in a JSON
    transcript that end is the inside of an event: 24H gate 2026-09-23 read
    such fragments of the agent reading saipen/OPS.md and RUNTIME.md as
    error-channel text and stopped the run as AUTH_FAILED (T-1485). So the
    partial first line is dropped; a tail never starts inside a line.
    """
    handle.seek(0, 2)
    size = handle.tell()
    start = max(0, size - OUTPUT_TAIL_BYTES)
    at_line_start = start == 0
    if not at_line_start:
        handle.seek(start - 1)
        at_line_start = handle.read(1) == b"\n"
    handle.seek(start)
    data = handle.read()
    if not at_line_start:
        newline = data.find(b"\n")
        data = data[newline + 1:] if newline >= 0 else b""
    return data.decode("utf-8", errors="replace")


def failure_text(stdout: str, stderr: str = "") -> str:
    """The ONLY text a failure class may be read from: the error channels.

    Measured in the first field soak (2026-09-22): a generation killed on
    purpose exited 1, and the classifier found an auth word somewhere in the
    agent's own JSON transcript -- file contents it had read, tool output --
    and stopped the whole run as AUTH_FAILED. The transcript is the agent's
    work, not the host's verdict. So: all of stderr; from stdout only lines
    that are not JSON events, plus JSON events that ARE errors. A line that
    opens like an event but does not parse is a torn event -- a generation
    killed mid-write -- and is transcript too (T-1485).
    """
    kept = [stderr] if stderr else []
    for line in str(stdout or "").splitlines():
        text = line.strip()
        if not text:
            continue
        if not text.startswith("{"):
            kept.append(text)
            continue
        try:
            event = json.loads(text)
        except ValueError:
            continue
        if isinstance(event, dict) and (
            str(event.get("type") or "").lower() == "error" or "error" in event
        ):
            kept.append(json.dumps(event.get("error", event))[:2000])
    return "\n".join(kept)


def _kill_tree(proc) -> None:
    """Stop a generation AND every process it started.

    Agent hosts are usually shims (`opencode.cmd` -> node -> tool children).
    Killing only the shim leaves the real agent alive beside its replacement:
    two mutators for one epoch. Windows gets `taskkill /T`; POSIX kills the
    process group the generation was started in.
    """
    import signal
    import subprocess

    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        with contextlib.suppress(OSError):
            os.killpg(proc.pid, signal.SIGKILL)
    with contextlib.suppress(OSError):
        proc.kill()


def _run_generation(
    root: Path,
    argv: list[str],
    worker_id: str,
    generation: int,
    *,
    run_id: str,
    slice_timeout: float,
    max_slice_seconds: float,
    heartbeat_every: float,
    env: dict | None,
    clock,
) -> dict:
    """Run ONE agent generation to its end, heartbeating its lease meanwhile.

    The agent cannot heartbeat for itself -- a model does not call the
    watchdog -- so the owner does it while the process is alive, and stops the
    moment the generation is fenced from outside or overruns its slice.
    """
    import subprocess
    import tempfile
    import time

    from .paths import unbound_environment

    # The generation binds to the project by its cwd, exactly like a cold
    # session: every inherited binding carrier is dropped and PWD is pointed
    # at the project. A launcher started from another repository otherwise
    # hands the host that repository's PWD, and a measured field model ran
    # `saipen start` against the wrong ledger (16.09/17.09 incidents).
    child_env = unbound_environment(
        {**os.environ, **(env or {})},
        PWD=str(root),
        SAIPEN_AGENT=None,
        SAIPEN_AUTONOMY_RUN_ID=run_id,
        SAIPEN_AUTONOMY_WORKER=worker_id,
        SAIPEN_LEASE_GENERATION=str(generation),
    )
    with tempfile.TemporaryFile() as sink, tempfile.TemporaryFile() as errsink:
        try:
            proc = subprocess.Popen(
                argv,
                cwd=str(root),
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=sink,
                stderr=errsink,
                start_new_session=os.name != "nt",
            )
        except OSError as exc:
            return {
                "returncode": None,
                "output": f"{type(exc).__name__}: {exc}",
                "timed_out": False,
                "launch_error": True,
                "fenced": False,
                "bounded": False,
            }
        # Diagnostic only: which process serves which generation, so an
        # operator (or a chaos harness) can target exactly the live generation.
        with contextlib.suppress(OSError, ValueError):
            safe_atomic_write_bytes(
                Path(root).resolve() / LIVE_GENERATION_REL,
                json.dumps(
                    {"worker_id": worker_id, "lease_generation": generation, "pid": proc.pid}
                ).encode("utf-8"),
                kind="autonomy live generation",
                ownership_root=Path(root).resolve(),
            )
        # QUALITY > TIME (QUALITY-TIME-01): elapsed time never implies failure.
        # `slice_timeout` is the IDLE bound -- the time a generation may run
        # without durable canonical progress -- and every observed progress
        # restarts it. `max_slice_seconds` is the host execution bound; a
        # progressing generation that reaches it ends as SLICE_BOUNDED, its
        # progress already durable, never as a failure.
        started = clock()
        last_beat = started
        last_progress = started
        marker = _progress_marker(root)
        timed_out = fenced = bounded = False
        while proc.poll() is None:
            now = clock()
            if now - last_beat >= heartbeat_every:
                if not watchdog.mutation_allowed(root, worker_id, generation):
                    fenced = True
                    _kill_tree(proc)
                    break
                watchdog.heartbeat(root, worker_id, generation)
                last_beat = now
                current = _progress_marker(root)
                if current != marker:
                    marker = current
                    last_progress = now
            if now - started > max_slice_seconds:
                bounded = True
                _kill_tree(proc)
                break
            if now - last_progress > slice_timeout:
                timed_out = True
                _kill_tree(proc)
                break
            time.sleep(min(0.2, max(0.01, heartbeat_every / 4)))
        returncode = proc.wait()
        output = _tail(sink)
        errors = _tail(errsink)
    return {
        "returncode": returncode,
        "output": output,
        "errors": errors,
        "timed_out": timed_out,
        "launch_error": False,
        "fenced": fenced,
        "bounded": bounded,
    }


def supervise(
    root: Path | str,
    agent_argv: list[str],
    *,
    model: str | None = None,
    fallback_models: tuple[str, ...] | list[str] = (),
    max_cycles: int = 10,
    slice_timeout: float = 900.0,
    max_slice_seconds: float | None = None,
    heartbeat_every: float = 5.0,
    suspect_after: float = 30.0,
    expire_after: float = 120.0,
    backoff: tuple[float, ...] = FAILURE_BACKOFF_SECONDS,
    max_awaits: int = 3,
    max_wall_seconds: float | None = None,
    keep_output_tail: int = 0,
    max_unknown: int = 2,
    run_id: str | None = None,
    env: dict | None = None,
    sleep=None,
    clock=None,
) -> dict:
    """Own unattended execution for at most `max_cycles` decisions.

    Every cycle asks `supervisor.decide` first, so the loop can never do what
    the decider forbids: a HEALTHY or SUSPECT foreign lease is awaited, never
    stolen; ambiguity, a due operator gate, no-progress and idleness stop the
    loop cleanly with the verdict as the reason. A provider or model failure
    replaces only the agent incarnation: Work, Source, checkpoint and epoch
    live in canonical state the loop never writes. A different model is used
    only when the operator listed it in `fallback_models`.
    """
    args = dict(locals())
    # SAIGPU: while the agent host thinks, an idle local GPU refreshes the
    # recall index. None when the switch is OFF (the default). The lane holds
    # no lock and writes only .saipen/cache/gpu/, so it cannot change a
    # verdict. It stops with the loop on EVERY exit, an exception included
    # (T-1482): a daemon lane outliving its loop kept a long-lived caller's
    # GPU busy for nothing.
    from . import gpu as _gpu

    lane = _gpu.start_side_lane(root)
    try:
        return _supervise(**args, lane=lane)
    finally:
        if lane is not None:
            lane.stop()


def _supervise(
    root: Path | str,
    agent_argv: list[str],
    *,
    model: str | None = None,
    fallback_models: tuple[str, ...] | list[str] = (),
    max_cycles: int = 10,
    slice_timeout: float = 900.0,
    max_slice_seconds: float | None = None,
    heartbeat_every: float = 5.0,
    suspect_after: float = 30.0,
    expire_after: float = 120.0,
    backoff: tuple[float, ...] = FAILURE_BACKOFF_SECONDS,
    max_awaits: int = 3,
    max_wall_seconds: float | None = None,
    keep_output_tail: int = 0,
    max_unknown: int = 2,
    run_id: str | None = None,
    env: dict | None = None,
    sleep=None,
    clock=None,
    lane=None,
) -> dict:
    """The loop behind `supervise`; `lane` is the side lane it reports."""
    import time
    import uuid

    from . import cold_recovery

    root = Path(root).resolve()
    sleep = sleep or time.sleep
    clock = clock or time.monotonic
    run_id = run_id or "run-" + uuid.uuid4().hex[:12]
    if MODEL_PLACEHOLDER not in " ".join(agent_argv) and fallback_models:
        return {
            "ok": False,
            "code": "FALLBACK_NEEDS_MODEL_PLACEHOLDER",
            "detail": f"fallback models need {MODEL_PLACEHOLDER} in the agent argv",
        }
    models: list[str | None] = [model, *fallback_models] if model else [None]
    max_slice = float(max_slice_seconds or slice_timeout * 4)
    model_index = 0
    tracker = cold_recovery.SemanticProgressTracker()
    counters = {
        "cycles": 0,
        "worker_generation_count": 0,
        "crash_recovery_count": 0,
        "model_replacement_recovery_count": 0,
        "backoff_count": 0,
        "await_count": 0,
        "stolen_lease_count": 0,
        "progress_slices": 0,
        "slow_progress_slices": 0,
        "manual_continue_count": 0,
        "unknown_terminal_failure_count": 0,
    }
    failures: dict[str, int] = {}
    streak: dict[str, int] = {}
    history: list[dict] = []
    max_latency = 0.0
    failed_at: float | None = None

    def report(stop: str, reason: str, *, operator_action: str | None = None) -> dict:
        lane_summary = lane.stop() if lane is not None else None
        return {
            "gpu_lane": lane_summary,
            "ok": stop in (supervisor.IDLE, "MAX_CYCLES", "MAX_WALL"),
            "code": "SUPERVISE_STOPPED",
            "run_id": run_id,
            "stop": stop,
            "reason": reason,
            "operator_action": operator_action,
            "counters": {**counters, "failures": dict(failures)},
            "maximum_recovery_latency_seconds": round(max_latency, 3),
            "model": models[model_index],
            "history": history,
        }

    run_started = clock()
    for cycle in range(1, int(max_cycles) + 1):
        if max_wall_seconds is not None and clock() - run_started >= max_wall_seconds:
            return report("MAX_WALL", f"wall bound of {max_wall_seconds:.0f} s reached")
        counters["cycles"] = cycle
        worker_id = f"{run_id}-c{cycle}"
        before_lease = watchdog.observe(
            root, suspect_after=suspect_after, expire_after=expire_after
        )
        verdict = supervisor.decide(
            root,
            tracker=tracker,
            worker_id=worker_id,
            run_id=run_id,
            suspect_after=suspect_after,
            expire_after=expire_after,
        )
        name = verdict["verdict"]
        if name in _STOP_VERDICTS:
            return report(
                name,
                verdict["reason"],
                operator_action=verdict["next_command"]
                if name != supervisor.IDLE
                else None,
            )
        if name == supervisor.AWAIT_WORKER:
            counters["await_count"] += 1
            history.append({"cycle": cycle, "verdict": name})
            if counters["await_count"] > int(max_awaits):
                return report(name, verdict["reason"])
            sleep(heartbeat_every)
            continue
        authority = take_authority(
            root, worker_id, suspect_after=suspect_after, expire_after=expire_after
        )
        if not authority["ok"]:
            return report(str(authority.get("code")), str(authority.get("reason") or ""))
        if before_lease.state in (watchdog.HEALTHY, watchdog.SUSPECT) and (
            before_lease.worker_id not in (None, worker_id)
        ) and authority["code"] == "LEASE_REPLACED":
            counters["stolen_lease_count"] += 1  # impossible by construction; measured
        generation = authority["generation"]
        counters["worker_generation_count"] += 1
        if failed_at is not None:
            max_latency = max(max_latency, clock() - failed_at)
            failed_at = None
        before = _progress_marker(root)
        outcome = _run_generation(
            root,
            _agent_argv(agent_argv, models[model_index]),
            worker_id,
            generation,
            run_id=run_id,
            slice_timeout=slice_timeout,
            max_slice_seconds=max_slice,
            heartbeat_every=heartbeat_every,
            env=env,
            clock=clock,
        )
        after = _progress_marker(root)
        progressed = after != before
        if outcome["bounded"] and progressed:
            # SLOW_BUT_PROGRESSING: the host bound ended a generation that
            # kept making durable progress. Not a failure; the next
            # generation continues the same epoch from canonical state.
            failure = None
            counters["slow_progress_slices"] += 1
        else:
            failure = supervisor.classify_failure(
                outcome["returncode"],
                failure_text(outcome["output"], outcome.get("errors", "")),
                timed_out=outcome["timed_out"] or outcome["fenced"] or outcome["bounded"],
                launch_error=outcome["launch_error"],
                progressed=progressed,
            )
        if progressed:
            counters["progress_slices"] += 1
        tracker.record(
            cold_recovery.Observation(
                work_id=after["task"],
                phase=after["phase"],
                blocker=after["blocker"],
                next_action=after["next_action"],
                evidence_identities=(after["last_event"],),
                failure_ids=(failure,) if failure else (),
                completed_attempt=progressed,
                authoritative_changed=progressed,
                timestamp=_utc(),
            )
        )
        write_checkpoint(
            root,
            {
                "schema_version": SCHEMA_VERSION,
                "worker_id": worker_id,
                "lease_generation": generation,
                "slice_index": cycle,
                "slices_total": int((read_checkpoint(root) or {}).get("slices_total") or 0) + 1,
                "work": after["task"] or None,
                "at": _utc(),
                "run_id": run_id,
                "model": models[model_index],
                "returncode": outcome["returncode"],
                "failure": failure,
                "progressed": progressed,
                "last_event": after["last_event"],
            },
        )
        # One generation per slice: the finished generation is fenced so the
        # next decision replaces it with an advanced generation, and nothing
        # the old process might still do can pass `mutation_allowed`.
        with contextlib.suppress(RuntimeError):
            watchdog.fence(root, worker_id, generation)
        history.append(
            {
                "cycle": cycle,
                "verdict": name,
                "generation": generation,
                "model": models[model_index],
                "returncode": outcome["returncode"],
                "failure": failure,
                "progressed": progressed,
                "bounded": outcome["bounded"],
                "output_tail": outcome["output"][-int(keep_output_tail):]
                if keep_output_tail
                else None,
                "failure_text_tail": failure_text(
                    outcome["output"], outcome.get("errors", "")
                )[-int(keep_output_tail):]
                if keep_output_tail
                else None,
            }
        )
        if failure is None:
            streak.clear()
            continue
        failures[failure] = failures.get(failure, 0) + 1
        streak[failure] = streak.get(failure, 0) + 1
        failed_at = clock()
        policy = supervisor.FAILURE_POLICY[failure]
        if policy == "REPLACE_GENERATION":
            counters["crash_recovery_count"] += 1
            continue
        if policy == "BACKOFF_RETRY":
            counters["backoff_count"] += 1
            delay = backoff[min(streak[failure], len(backoff)) - 1] if backoff else 0.0
            sleep(delay)
            continue
        if policy == "FALLBACK_OR_OPERATOR" and model_index + 1 < len(models):
            model_index += 1
            counters["model_replacement_recovery_count"] += 1
            continue
        if policy == "STOP_AFTER_REPEAT" and streak[failure] < int(max_unknown):
            continue
        if policy == "STOP_AFTER_REPEAT":
            counters["unknown_terminal_failure_count"] += 1
        return report(
            failure,
            f"{failure} ({policy}) after generation {generation}; Work, Source, "
            "checkpoint and epoch are preserved in canonical state",
            operator_action=(
                "resolve the provider/model account condition or authorize a "
                "fallback model, then restart the supervisor"
            ),
        )
    return report("MAX_CYCLES", f"bounded run of {max_cycles} cycle(s) finished")


def _supervise_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="SAIPEN unattended execution owner")
    parser.add_argument("--project-root", required=True)
    parser.add_argument(
        "--agent-json",
        required=True,
        help='agent host argv as a JSON list, e.g. ["opencode","run","--model","{model}","cc"]',
    )
    parser.add_argument("--model", default=None)
    parser.add_argument("--fallback-model", action="append", default=[])
    parser.add_argument("--max-cycles", type=int, default=10)
    parser.add_argument("--max-wall-seconds", type=float, default=None)
    parser.add_argument("--slice-timeout", type=float, default=900.0)
    parser.add_argument("--max-slice-seconds", type=float, default=None)
    parser.add_argument("--heartbeat-every", type=float, default=5.0)
    parser.add_argument("--suspect-after", type=float, default=30.0)
    parser.add_argument("--expire-after", type=float, default=120.0)
    args = parser.parse_args(argv)
    agent = json.loads(args.agent_json)
    if not isinstance(agent, list) or not agent or not all(isinstance(a, str) for a in agent):
        print(json.dumps({"ok": False, "code": "VALIDATION_FAILED", "detail": "--agent-json"}))
        return 2
    result = supervise(
        args.project_root,
        agent,
        model=args.model,
        fallback_models=tuple(args.fallback_model),
        max_cycles=args.max_cycles,
        max_wall_seconds=args.max_wall_seconds,
        slice_timeout=args.slice_timeout,
        max_slice_seconds=args.max_slice_seconds,
        heartbeat_every=args.heartbeat_every,
        suspect_after=args.suspect_after,
        expire_after=args.expire_after,
    )
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get("ok") else EXIT_STOPPED


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["supervise"]:
        return _supervise_main(argv[1:])
    parser = argparse.ArgumentParser(description="SAIPEN bounded autonomy worker")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--worker-id", required=True)
    parser.add_argument("--slices", type=int, default=1)
    parser.add_argument("--die-after", type=int, default=None)
    parser.add_argument("--suspect-after", type=float, default=30.0)
    parser.add_argument("--expire-after", type=float, default=120.0)
    args = parser.parse_args(argv)
    result = serve(
        args.project_root,
        args.worker_id,
        slices=args.slices,
        die_after=args.die_after,
        suspect_after=args.suspect_after,
        expire_after=args.expire_after,
    )
    print(json.dumps(result, sort_keys=True))
    if result.get("ok"):
        return EXIT_OK
    if result.get("code") == supervisor.AMBIGUOUS_AUTHORITY:
        return EXIT_NO_AUTHORITY
    if result.get("code") == "FENCED_LEASE_GENERATION":
        return EXIT_FENCED
    return EXIT_STOPPED


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
