"""T-1446 / SRC-100: the bounded supervisor that turns primitives into autonomy.

T-1447 and T-1448 left three working primitives and no lifecycle around them:
`watchdog` fences leases, `cold_recovery` decides semantic progress and builds
the cold carrier, `board`/`router` decide the next Work. Nothing joined them,
so "the agent keeps working" still meant a human noticing that it stopped.

This module is the join, and it is deliberately a DECIDER, not a launcher. It
answers two questions and writes nothing except the lease it is explicitly
asked to take:

* `observe(root)`  -- the complete read-only autonomy picture.
* `decide(root)`   -- the ONE next action, with the reason that produced it.

Process spawning stays outside. A supervisor that both decides and launches
cannot be tested for the case that matters -- two live workers -- without
actually creating two live workers, and the fencing rules are the whole point:

* UNKNOWN never permits blind takeover. Missing or corrupt runtime state is
  ambiguous authority, and ambiguous authority fails closed for mutation.
* A HEALTHY or SUSPECT lease is never stolen. Replacement is EXPIRED-only and
  goes through fence -> acquire, so the generation always advances.
* A returning old worker cannot mutate: `watchdog.mutation_allowed` is keyed to
  the current generation, and the fenced one is not it.
* A due operator gate is a real stop; a DEFERRED or parked one is not. That
  distinction is `board.deferred_state` (T-1429) and is never re-derived here.
* Repeated semantically identical cycles converge to NO_PROGRESS_LOOP rather
  than burning provider budget forever (`cold_recovery.SemanticProgressTracker`).
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path

from . import watchdog
from .board import operator_gates, parse_board, workable_tickets

#: Supervisor verdicts. One closed vocabulary, one owner.
RUN_WORK = "RUN_WORK"
ADOPT_WORKER = "ADOPT_WORKER"
REPLACE_WORKER = "REPLACE_WORKER"
AWAIT_WORKER = "AWAIT_WORKER"
OPERATOR_ACTION_DUE = "OPERATOR_ACTION_DUE"
NO_PROGRESS_LOOP = "NO_PROGRESS_LOOP"
AMBIGUOUS_AUTHORITY = "AMBIGUOUS_AUTHORITY"
IDLE = "IDLE"

VERDICTS = (
    RUN_WORK,
    ADOPT_WORKER,
    REPLACE_WORKER,
    AWAIT_WORKER,
    OPERATOR_ACTION_DUE,
    NO_PROGRESS_LOOP,
    AMBIGUOUS_AUTHORITY,
    IDLE,
)

#: Verdicts that permit a mutating worker to act. Everything else is a stop or
#: a wait, and the split is stated once so no caller invents its own.
MUTATING_VERDICTS = frozenset({RUN_WORK, ADOPT_WORKER, REPLACE_WORKER})

#: The exact command each verdict routes to. Closed and total by construction
#: -- a verdict added without a command fails this module's own control.
NEXT_COMMAND = {
    RUN_WORK: "saipen continue --json",
    ADOPT_WORKER: "saipen continue --json",
    REPLACE_WORKER: "saipen continue --json",
    AWAIT_WORKER: "saipen autonomy --json",
    OPERATOR_ACTION_DUE: "saipen status --json",
    NO_PROGRESS_LOOP: "saipen status --json",
    AMBIGUOUS_AUTHORITY: "saipen recover --json",
    IDLE: "saipen status --json",
}


#: Provider/model/host failure vocabulary (SRC-105 section 23). Closed: a
#: failure outside it is UNKNOWN, never a guess. Order is the match order --
#: a quota 429 is QUOTA_EXHAUSTED, not RATE_LIMITED.
QUOTA_EXHAUSTED = "QUOTA_EXHAUSTED"
RATE_LIMITED = "RATE_LIMITED"
AUTH_FAILED = "AUTH_FAILED"
MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
NETWORK_UNAVAILABLE = "NETWORK_UNAVAILABLE"
CAPABILITY_UNAVAILABLE = "CAPABILITY_UNAVAILABLE"
HOST_RUNTIME_FAILURE = "HOST_RUNTIME_FAILURE"
WORKER_CRASH = "WORKER_CRASH"
UNKNOWN_FAILURE = "UNKNOWN"
FAILURE_CLASSES = (
    QUOTA_EXHAUSTED,
    RATE_LIMITED,
    AUTH_FAILED,
    MODEL_UNAVAILABLE,
    PROVIDER_UNAVAILABLE,
    NETWORK_UNAVAILABLE,
    CAPABILITY_UNAVAILABLE,
    HOST_RUNTIME_FAILURE,
    WORKER_CRASH,
    UNKNOWN_FAILURE,
)

_FAILURE_PATTERNS = (
    (QUOTA_EXHAUSTED, r"insufficient_quota|quota (?:exceeded|exhausted)|out of credits|"
     r"credit balance|usage limit (?:reached|exceeded)|billing"),
    (RATE_LIMITED, r"\b429\b|rate[ _-]?limit|too many requests"),
    (AUTH_FAILED, r"\b401\b|\b403\b|unauthori[sz]ed|invalid api[ _-]?key|"
     r"authentication (?:failed|error)|forbidden"),
    (CAPABILITY_UNAVAILABLE, r"does not support (?:tools|tool use|function calling)|"
     r"(?:tool use|tools|function calling) (?:is |are )?not supported|"
     r"unsupported capability|capability unavailable"),
    (MODEL_UNAVAILABLE, r"model[^\n]{0,40}(?:not found|unavailable|does not exist|"
     r"not supported)|unknown model|no such model"),
    (PROVIDER_UNAVAILABLE, r"\b50[0234]\b|service unavailable|overloaded|bad gateway|"
     r"provider (?:error|unavailable)"),
    (NETWORK_UNAVAILABLE, r"econnrefused|econnreset|enotfound|etimedout|getaddrinfo|"
     r"network (?:error|unreachable)|connection (?:refused|reset)"),
)

#: What each failure may do to the execution. Every class preserves Work,
#: Source, checkpoint and epoch; only the incarnation may change, and a paid
#: or different model only through an operator-authorized fallback list.
FAILURE_POLICY = {
    QUOTA_EXHAUSTED: "FALLBACK_OR_OPERATOR",
    RATE_LIMITED: "BACKOFF_RETRY",
    AUTH_FAILED: "OPERATOR",
    MODEL_UNAVAILABLE: "FALLBACK_OR_OPERATOR",
    PROVIDER_UNAVAILABLE: "BACKOFF_RETRY",
    NETWORK_UNAVAILABLE: "BACKOFF_RETRY",
    CAPABILITY_UNAVAILABLE: "FALLBACK_OR_OPERATOR",
    HOST_RUNTIME_FAILURE: "REPLACE_GENERATION",
    WORKER_CRASH: "REPLACE_GENERATION",
    UNKNOWN_FAILURE: "STOP_AFTER_REPEAT",
}


def classify_failure(
    returncode: int | None, output: str = "", *, timed_out: bool = False,
    launch_error: bool = False, progressed: bool = True,
) -> str | None:
    """Name ONE failure class for a finished worker process, or None.

    None means the slice ended cleanly (exit 0, no failure text). A frozen or
    unlaunchable host is HOST_RUNTIME_FAILURE; a nonzero exit that says
    nothing recognizable is a WORKER_CRASH; recognizable provider text wins
    over the exit code because a host often exits 1 for every provider error,
    and a clean exit that made no progress is checked for the same text.
    """
    import re as _re

    if launch_error:
        # The runtime to run the Work does not exist here. That is a missing
        # capability, never evidence about any model's reasoning.
        return CAPABILITY_UNAVAILABLE
    if timed_out:
        return HOST_RUNTIME_FAILURE
    text = str(output or "").lower()
    if returncode == 0 and progressed:
        return None
    for klass, pattern in _FAILURE_PATTERNS:
        if _re.search(pattern, text):
            return klass
    if returncode == 0:
        # A host that exits 0 after a provider error it swallowed shows up
        # as no progress; without recognizable text it is not a failure.
        return None
    if returncode is None:
        return UNKNOWN_FAILURE
    if returncode < 0 or returncode in (9, 137, 139, 3221225477, 3221225786) or not text.strip():
        return WORKER_CRASH
    if "traceback (most recent call last)" in text:
        return HOST_RUNTIME_FAILURE
    return UNKNOWN_FAILURE


def _now(now: _dt.datetime | None = None) -> _dt.datetime:
    if now is None:
        return _dt.datetime.now(_dt.timezone.utc)
    return now if now.tzinfo else now.replace(tzinfo=_dt.timezone.utc)


def _read(root: Path, name: str) -> str:
    try:
        return (Path(root) / ".saipen" / name).read_text(encoding="utf-8-sig")
    except OSError:
        return ""


def _state_fields(text: str) -> dict:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if ":" not in line or line.startswith("---"):
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key.isidentifier():
            fields.setdefault(key, value)
    return fields


def observe(
    root: Path | str,
    *,
    now: _dt.datetime | None = None,
    tracker=None,
    run_id: str = "",
    suspect_after: float = 30.0,
    expire_after: float = 120.0,
) -> dict:
    """The complete read-only autonomy picture. Writes nothing, ever.

    `tracker` is an optional `cold_recovery.SemanticProgressTracker` the caller
    already owns; the supervisor never creates durable progress state of its
    own, because two progress histories would disagree the first time one of
    them was reconstructed.
    """
    root = Path(root)
    moment = _now(now)
    state_text = _read(root, "STATE.md")
    board_text = _read(root, "BOARD.md")
    state = _state_fields(state_text)
    board = parse_board(board_text)
    tickets = board.get("tickets", {})

    lease = watchdog.observe(
        root, now=moment, suspect_after=suspect_after, expire_after=expire_after
    )
    gates = operator_gates(tickets, now=moment)
    due = [gate["ticket"] for gate in gates if gate["state"] == "DUE_OPERATOR_ACTION"]
    deferred = [gate["ticket"] for gate in gates if gate["state"] == "DEFERRED_OPERATOR"]
    claimed = state.get("task", "") or ""
    workable = workable_tickets(tickets, now=moment)

    return {
        "autonomy_run_id": run_id,
        "observed_at": watchdog._utc(moment),
        "phase": state.get("phase", ""),
        "active_work": claimed if claimed and claimed != "none" else None,
        "next_action": state.get("next_action", ""),
        "last_event": state.get("last_event", ""),
        "state_blocker": state.get("blocker", ""),
        "worker_id": lease.worker_id,
        "worker_generation": lease.lease_generation,
        "lease_generation": lease.lease_generation,
        "lease_state": lease.state,
        "lease_reason": lease.reason,
        "heartbeat_at": lease.heartbeat_at,
        "heartbeat_age_seconds": lease.age_seconds,
        "workable_work": workable,
        "executable_work": workable[0] if workable else None,
        "operator_gates": gates,
        "due_operator_actions": due,
        "deferred_operator_gates": deferred,
        "board_errors": list(board.get("errors", [])),
        "no_progress_count": tracker.no_progress_count() if tracker is not None else 0,
        "progress_verdict": tracker.verdict() if tracker is not None else "RUNNING",
        # Where the last generation actually stopped. Local import: `worker`
        # imports this module, and a supervisor that cannot be read without
        # loading a worker is a supervisor with a worker-shaped dependency.
        "durable_checkpoint": _durable_checkpoint(root),
        "last_progress_at": _last_progress_at(tracker),
    }


def _durable_checkpoint(root: Path) -> dict | None:
    from .worker import read_checkpoint

    return read_checkpoint(root)


def _last_progress_at(tracker) -> str:
    """The timestamp of the newest recorded observation, or "".

    Deliberately the OBSERVATION's own stamp, not `now`: "how long since
    anything changed" is a fact about the history, and computing it from the
    reader's clock is how a stalled loop reports itself as fresh.
    """
    if tracker is None or not getattr(tracker, "observations", None):
        return ""
    return str(tracker.observations[-1].timestamp or "")


def decide(
    root: Path | str,
    *,
    now: _dt.datetime | None = None,
    tracker=None,
    worker_id: str | None = None,
    run_id: str = "",
    suspect_after: float = 30.0,
    expire_after: float = 120.0,
) -> dict:
    """The ONE next action, its reason, and the picture that produced it.

    Ordering is the contract, not an implementation detail, and it is checked
    by its own control: ambiguity first (fail closed), then a real human stop,
    then loop suppression, then worker health, then Work.
    """
    picture = observe(
        root,
        now=now,
        tracker=tracker,
        run_id=run_id,
        suspect_after=suspect_after,
        expire_after=expire_after,
    )
    lease_state = picture["lease_state"]
    executable = picture["executable_work"]

    def answer(verdict: str, reason: str, **extra) -> dict:
        return {
            "verdict": verdict,
            "reason": reason,
            "may_mutate": verdict in MUTATING_VERDICTS,
            "requires_human": verdict == OPERATOR_ACTION_DUE,
            # Never "continue as appropriate": a verdict that cannot name the
            # command that acts on it is a verdict someone has to interpret,
            # and interpretation is where autonomous runs stop.
            "next_command": NEXT_COMMAND[verdict],
            "stop_reason": "" if verdict in MUTATING_VERDICTS else reason,
            "observation": picture,
            **extra,
        }

    if lease_state == watchdog.UNKNOWN and _lease_file_exists(root):
        # Corrupt runtime state, not a clean slate. Something held this lease
        # and the record no longer says what; taking it over is exactly the
        # blind takeover the invariant forbids.
        return answer(
            AMBIGUOUS_AUTHORITY,
            "runtime lease state is unreadable -- mutation fails closed until it "
            "is recovered through canonical authority",
        )

    if picture["due_operator_actions"] and not executable:
        return answer(
            OPERATOR_ACTION_DUE,
            "a human owns the next move: "
            + ", ".join(picture["due_operator_actions"]),
            operator_work=picture["due_operator_actions"],
        )

    if picture["progress_verdict"] == "NO_PROGRESS_LOOP":
        return answer(
            NO_PROGRESS_LOOP,
            f"{picture['no_progress_count']} semantically identical cycles -- "
            "a new attempt needs changed evidence, not another run",
        )

    if lease_state in (watchdog.HEALTHY, watchdog.SUSPECT):
        if worker_id is not None and picture["worker_id"] == worker_id:
            return answer(
                ADOPT_WORKER,
                f"this worker already holds generation {picture['lease_generation']}",
                adopt_generation=picture["lease_generation"],
            )
        return answer(
            AWAIT_WORKER,
            f"generation {picture['lease_generation']} is {lease_state.lower()} and is "
            "never stolen -- only an EXPIRED lease is replaced",
        )

    if lease_state in (watchdog.EXPIRED, watchdog.TERMINAL):
        if not executable and not picture["active_work"]:
            return answer(IDLE, "no executable Work and no claimed Work to recover")
        return answer(
            REPLACE_WORKER,
            f"generation {picture['lease_generation']} is {lease_state.lower()} -- "
            "fence it, then acquire the replacement generation",
            fence_generation=picture["lease_generation"],
            fence_worker=picture["worker_id"],
            recover_work=picture["active_work"] or executable,
        )

    # UNKNOWN with no lease file at all: nothing has ever run here.
    if executable or picture["active_work"]:
        return answer(
            RUN_WORK,
            "no lease exists yet -- acquire generation 1 and run the next Work",
            work=picture["active_work"] or executable,
        )
    return answer(IDLE, "no lease, no executable Work, nothing claimed")


def _lease_file_exists(root: Path | str) -> bool:
    try:
        return (Path(root).resolve() / watchdog.CACHE_REL).exists()
    except OSError:
        return False


def replace_worker(
    root: Path | str,
    new_worker_id: str,
    *,
    now: _dt.datetime | None = None,
    suspect_after: float = 30.0,
    expire_after: float = 120.0,
) -> dict:
    """Fence the expired generation, then acquire its successor. Never steals.

    Refuses on anything but an EXPIRED or TERMINAL lease, so the "supervisor
    restarted and grabbed a live worker's seat" failure cannot be reached by
    calling this at the wrong moment.
    """
    root = Path(root)
    moment = _now(now)
    status = watchdog.observe(
        root, now=moment, suspect_after=suspect_after, expire_after=expire_after
    )
    if status.state in (watchdog.HEALTHY, watchdog.SUSPECT):
        return {
            "ok": False,
            "code": "LIVE_LEASE_PRESENT",
            "detail": f"generation {status.lease_generation} is {status.state.lower()}",
            "lease": status.as_dict(),
        }
    if status.state == watchdog.UNKNOWN:
        return {
            "ok": False,
            "code": "AMBIGUOUS_AUTHORITY",
            "detail": status.reason,
            "lease": status.as_dict(),
        }
    try:
        watchdog.fence(root, status.worker_id, status.lease_generation, now=moment)
    except RuntimeError as exc:
        return {"ok": False, "code": str(exc), "lease": status.as_dict()}
    try:
        payload = watchdog.acquire_lease(root, new_worker_id, now=moment)
    except RuntimeError as exc:
        return {"ok": False, "code": str(exc), "lease": status.as_dict()}
    return {
        "ok": True,
        "code": "WORKER_REPLACED",
        "fenced_generation": status.lease_generation,
        "fenced_worker": status.worker_id,
        "lease": payload,
    }
