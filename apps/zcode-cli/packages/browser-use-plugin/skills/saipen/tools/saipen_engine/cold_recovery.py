"""T-1446: cold recovery package + semantic progress invariant + ingress identity.

Three primitives, one module, zero canonical writes:

- ``recovery_package``: one DERIVED, regenerable carrier (never canonical truth)
  a cold worker reads INSTEAD of walking BOARD/LOG to become actionable. It is
  rebuilt from STATE/BOARD/LOG tail on every call, so it can never drift from
  the protocol authority it projects.
- ``goal_ingress_identity``: deterministic identity over a goal objective plus
  project identity. Equal identity + no new scope => the SAME goal, the reuse
  contract the cc-all incident (T-1449/T-1450) proved missing.
- ``SemanticProgressTracker``: SRP-100's five-cycle semantic no-progress
  contract. Timestamps and heartbeats are not progress; changed source bytes,
  changed authority, or a completed bounded attempt are.

A blocker string is freely readable prose by protocol design, so the package
carries the exact operator-actionable verdicts as structured fields instead of
parsing one.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

NO_PROGRESS_THRESHOLD = 5

STATE_EVENT_RE = re.compile(r"^last_event:\s*(\d+)\s*$", re.MULTILINE)
TICKET_RE = re.compile(r"^- \[[ x/]\] (T-\d+) \[(P\d)\]")
FIELD_RE = re.compile(r"\|\s*([a-z_]+):\s*([^|]+)")
CHECKPOINT_RE = re.compile(r"\[op: checkpoint-[0-9a-f]+\] RUN: (.+)$")
_EVIDENCE_SUFFIXES = ("INCOMPLETE", "NO_EVIDENCE", "UNVERIFIED")

KNOWN_REDS_PREFIXES = (
    "declared unittest family",
    "declared core-unit family",
)
WORKABLE_BLOCKER_PREFIXES = (
    "DUPLICATE GOAL INGRESS",
    "DUPLICATE OF",
    "ACCIDENTAL DUPLICATE INGRESS",
    "INVALID_INVOCATION",
)


def _redact_prose(text: str, limit: int = 80) -> str:
    compact = " ".join(str(text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "…"


def goal_ingress_identity(objective: str, project_identity: str) -> str:
    """Deterministic identity of one semantic goal ingress.

    Pure function over (project identity, normalized objective). No LLM
    similarity, no timestamp: the same operator objective in the same project
    is the SAME ingress forever, which is what makes a repeat idempotent.
    """
    normalized = " ".join(str(objective or "").strip().lower().split())
    payload = f"{str(project_identity or '').strip().lower()}\n{normalized}"
    return "goal-" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


#: The ONE class `board.blocker_class` cannot answer for, named here and
#: nowhere else. A dependency pause is recognized protocol state, but
#: `blocker_class` matches the head exactly and the head carries the child
#: ticket (`ACTIVE_DEPENDENCY:T-1446`). Everything else routes to that owner:
#: a second copy of the closed vocabulary is how the operator-gate flag drifted
#: in the first place.
DEPENDENCY_HOLD_PREFIX = "ACTIVE_DEPENDENCY"


def classify_blocker(blocker: str) -> dict:
    """One policy owner for the blocker verdicts a cold worker needs.

    SAIPEN blocker fields are free prose by contract, so the recovery package
    carries these structured judgments instead of making every cold agent
    re-parse the same strings.

    The defect this split ends (T-1429, measured 2026-09-22): ONE flag named
    ``is_operator_gate`` covered every recognized class, so a cold worker read
    ``ACTIVE_DEPENDENCY:T-1446`` and ``HELD -- unmet dependency`` as "a human
    must act", and the package's DUE list published every parked ticket as an
    operator action due NOW. The agent stopped and waited for a person nobody
    had asked for anything.

    * ``is_operator_gate`` -- a HUMAN owns the next move. Narrow, and it is
      `board.deferred_operator_class`, not a second copy of the vocabulary.
    * ``is_parked_hold`` -- recognized and parked, human or not. This is the
      "do not read as a red" judgment the package's DEFERRED list wants.
    * ``is_workable_side_block`` -- duplicate/bounded-evidence classes that
      must never read as a global stop.
    """
    from .board import blocker_class, deferred_operator_class

    text = str(blocker or "").strip()
    upper = " ".join(text.upper().split())
    is_gate = deferred_operator_class(text) is not None
    is_hold = (
        is_gate
        or blocker_class(text) is not None
        or upper.startswith(DEPENDENCY_HOLD_PREFIX)
    )
    duplicate = upper.startswith(WORKABLE_BLOCKER_PREFIXES)
    timeout = (
        "BOUNDED" in upper and ("600-SECOND" in upper or "WINDOW" in upper)
    ) or "TIMEOUT" in upper
    return {
        "is_operator_gate": is_gate,
        "is_parked_hold": is_hold,
        "is_workable_side_block": (duplicate or timeout) and not is_hold,
        "duplicate": duplicate,
        "bounded_timeout": timeout,
    }


@dataclass(frozen=True)
class Observation:
    """One bounded authoritative observation of an autonomous loop."""

    work_id: str
    phase: str
    blocker: str = ""
    next_action: str = ""
    evidence_identities: tuple[str, ...] = ()
    source_identity: str = ""
    authority_state: str = ""
    failure_ids: tuple[str, ...] = ()
    dependencies_terminal: bool = True
    completed_attempt: bool = False
    authoritative_changed: bool = False
    timestamp: str = ""  # deliberately NOT part of any fingerprint
    heartbeat: bool = False  # deliberately NOT part of any fingerprint

    def semantic_fingerprint(self) -> str:
        """Hash of every bounded semantic input; timestamps excluded."""
        payload = "|".join(
            [
                f"work={self.work_id}",
                f"phase={self.phase}",
                f"blocker={_redact_prose(self.blocker, 160)}",
                f"action={_redact_prose(self.next_action, 160)}",
                f"evidence={','.join(sorted(self.evidence_identities))}",
                f"source={self.source_identity}",
                f"authority={self.authority_state}",
                f"failures={','.join(sorted(self.failure_ids))}",
                f"deps_terminal={int(bool(self.dependencies_terminal))}",
            ]
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def as_dict(self) -> dict:
        return {
            "work_id": self.work_id,
            "phase": self.phase,
            "blocker": _redact_prose(self.blocker),
            "next_action": _redact_prose(self.next_action),
            "evidence_identities": list(self.evidence_identities),
            "source_identity": self.source_identity,
            "authority_state": self.authority_state,
            "failure_ids": list(self.failure_ids),
            "dependencies_terminal": bool(self.dependencies_terminal),
            "completed_attempt": bool(self.completed_attempt),
            "authoritative_changed": bool(self.authoritative_changed),
            "timestamp": self.timestamp,
        }


class SemanticProgressTracker:
    """Five semantically equivalent no-progress cycles => NO_PROGRESS_LOOP.

    Timestamp-only or heartbeat-only observations are never progress. Changed
    source identity, changed authority state, or a completed bounded attempt
    each make the next equivalent cycle a legitimate new attempt.
    """

    def __init__(self, threshold: int = NO_PROGRESS_THRESHOLD):
        self.threshold = max(2, int(threshold))
        # history entries: (fingerprint, legitimate_new_attempt, heartbeat)
        self.history: list[tuple[str, bool, bool]] = []
        self.observations: list[Observation] = []
        self._fingerprint: str | None = None

    def record(self, observation: Observation) -> bool:
        """Record one observation; False when NO_PROGRESS_LOOP trips.

        A changed semantic fingerprint IS progress (changed source bytes,
        changed authority, changed blocker...), as is an explicitly legitimate
        new attempt. A heartbeat observation is an IN-FLIGHT process, not a
        completed cycle, so it never counts toward the loop threshold.
        """
        fingerprint = observation.semantic_fingerprint()
        legit = (
            bool(observation.authoritative_changed)
            or bool(observation.completed_attempt)
        )
        moved = bool(self.history) and fingerprint != self.history[-1][0]
        self.history.append((fingerprint, legit, bool(observation.heartbeat)))
        self.observations.append(observation)
        self._fingerprint = fingerprint
        if legit or moved or observation.heartbeat:
            return True
        no_progress = sum(
            1 for fp, lg, hb in self.history if fp == fingerprint and not lg and not hb
        )
        return no_progress < self.threshold

    def verdict(self) -> str:
        """RUNNING | PROGRESS | NO_PROGRESS_LOOP (T-1428 precedent)."""
        if not self.history:
            return "RUNNING"
        fingerprint = self.history[-1][0]
        if any(lg for fp, lg, _hb in self.history if fp == fingerprint):
            return "PROGRESS"
        no_progress = sum(
            1 for fp, lg, hb in self.history if fp == fingerprint and not lg and not hb
        )
        if no_progress >= self.threshold:
            return "NO_PROGRESS_LOOP"
        if len(self.history) > 1 and fingerprint != self.history[-2][0]:
            return "PROGRESS"
        return "RUNNING"

    def no_progress_count(self) -> int:
        if not self._fingerprint:
            return 0
        return sum(
            1
            for fp, lg, hb in self.history
            if fp == self._fingerprint and not lg and not hb
        )


def build_recovery_package(
    state_text: str,
    board_text: str,
    log_tail: str,
    *,
    tree_identity: str = "",
    dirty_identity: str = "",
    runtime_state: dict | None = None,
) -> dict:
    """Build the bounded DERIVED recovery carrier from canonical bytes.

    Regenerable by construction: every field is computed from STATE/BOARD/LOG
    on each call. This carrier is DATA, never authority -- a cold worker still
    resolves its action through the canonical router.

    ``runtime_state`` carries runtime-local, reconstructable observations the
    canonical bytes cannot express (canonical root, project identity/lineage,
    watchdog lease observation, claim liveness classification). It is optional
    so the pure-bytes fixture keeps working; absent values surface as empty
    fields, never as inferred truth.
    """
    runtime = dict(runtime_state or {})
    state: dict[str, str] = {}
    for line in str(state_text or "").splitlines():
        kv = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if kv:
            value = kv.group(2).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            state[kv.group(1)] = value
    event_match = STATE_EVENT_RE.search(str(state_text or ""))
    last_event = int(event_match.group(1)) if event_match else None

    todos: list[dict] = []
    doing: list[dict] = []
    blocked: list[dict] = []
    done_ids: set[str] = set()
    fields_full: dict[str, str] = {}
    rnb_full: dict[str, str] = {}
    section = ""
    for line in str(board_text or "").splitlines():
        if line.startswith("## "):
            section = line.strip()
            continue
        match = TICKET_RE.match(line)
        if not match:
            continue
        tid, priority = match.group(1), match.group(2)
        fields = {k: v.strip() for k, v in FIELD_RE.findall(line)}
        entry = {"id": tid, "priority": priority, "fields": fields}
        needs_raw = ""
        marker = "| needs: "
        if marker in line:
            needs_raw = line.split(marker, 1)[1].split("|", 1)[0]
        entry["needs"] = [n for n in re.findall(r"T-\d+", needs_raw)]
        if section == "## DONE":
            done_ids.add(tid)
        elif section == "## TODO":
            todos.append(entry)
        elif section == "## DOING":
            doing.append(entry)
        elif section == "## BLOCKED":
            fields_full[tid] = fields.get("blocker", "")
            rnb_full[tid] = fields.get("retry_not_before", "")
            entry["blocker"] = _redact_prose(fields.get("blocker", ""))
            entry["blocked_on"] = fields.get("blocked_on", "")
            blocked.append(entry)

    deps_ok = {
        entry["id"]: all(n in done_ids for n in entry["needs"]) for entry in todos
    }
    # The seat is the ticket STATE.task names, whatever section holds it: a
    # claimed DOING ticket or a PAUSED BLOCKED corridor is still the Work a
    # cold worker resumes. Only when STATE carries no active task does the
    # first dependency-eligible TODO become the primary mission.
    by_id = {entry["id"]: entry for entry in (*doing, *todos, *blocked)}
    state_task = str(state.get("task") or "").strip()
    if state_task and state_task not in ("", "none") and state_task in by_id:
        active = by_id[state_task]
    else:
        active = next((e for e in todos if deps_ok[e["id"]]), None)
        if active is None and doing:
            active = doing[0]

    checkpoint_match = None
    last_event_line = ""
    for line in str(log_tail or "").splitlines():
        m = CHECKPOINT_RE.search(line)
        if m:
            checkpoint_match = m.group(1).strip()
        ev = re.search(r"\[E-(\d+)\]", line)
        if ev:
            last_event_line = ev.group(1)
    if last_event is None and last_event_line:
        last_event = int(last_event_line)

    # Classify each BLOCKED Work through the ONE blocker policy owner.
    unrelated_reds: list[str] = []
    known_reds: list[str] = []
    deferred: list[dict] = []
    from .board import deferred_state, retry_not_before

    operator_gate_rows: list[dict] = []
    for entry in blocked:
        raw_blocker = fields_full.get(entry["id"], "")
        verdict = classify_blocker(raw_blocker)
        entry["blocker_class"] = (
            "OPERATOR_GATE"
            if verdict["is_operator_gate"]
            else "PARKED_HOLD"
            if verdict["is_parked_hold"]
            else "BOUNDED_EVIDENCE"
            if verdict["is_workable_side_block"]
            else "OTHER"
        )
        if verdict["is_workable_side_block"]:
            known_reds.append(entry["id"])
        elif verdict["is_parked_hold"]:
            deferred.append({"id": entry["id"], "blocker": entry["blocker"]})
            if verdict["is_operator_gate"]:
                # T-1429: only an operator-owned class may carry a due instant,
                # and only the instant decides DUE. No field, no due.
                gate_ticket = {
                    "section": "## BLOCKED",
                    "fields": {
                        "blocker": raw_blocker,
                        "retry_not_before": rnb_full.get(entry["id"], ""),
                    },
                }
                operator_gate_rows.append(
                    {
                        "id": entry["id"],
                        "retry_not_before": retry_not_before(gate_ticket) or "",
                        "state": deferred_state(gate_ticket) or "OPERATOR_GATE_UNDATED",
                    }
                )
        else:
            unrelated_reds.append(entry["id"])

    # EVIDENCE: bounded op receipts from the LOG tail, so a cold worker can
    # locate the last durable operations without walking the journal.
    evidence: list[str] = []
    for line in str(log_tail or "").splitlines():
        for op in re.findall(r"\[op: ([A-Za-z0-9_-]+)\]", line):
            if op not in evidence:
                evidence.append(op)
    evidence = evidence[-8:]

    active_from_blocked = active is not None and any(
        entry is active for entry in blocked
    )
    # The seat STATE names keeps its own phase. Answering `PHASE SCOUT` for a
    # claimed DOING seat (measured live 2026-09-22: T-1446 in BUILD) told a
    # cold successor to reset the phase it had to resume. STATE's next_action
    # is kept when it is about the seat; otherwise the seat resumes at STATE's
    # executing phase, and only a non-executing phase starts at SCOUT.
    active_is_seat = active is not None and active["id"] == state_task
    seat_next_action = None
    if active_is_seat:
        recorded = str(state.get("next_action", "")).strip()
        named = re.findall(r"T-\d+", recorded)
        seat_phase = str(state.get("phase", "")).strip().upper()
        if recorded and (not named or active["id"] in named):
            seat_next_action = recorded
        elif seat_phase and seat_phase not in ("DONE", "IDLE", "INIT"):
            seat_next_action = f"PHASE {seat_phase} {active['id']}"
    active_fields = active["fields"] if active else {}

    # DO_NOT_REPEAT: INCOMPLETE/NO_EVIDENCE checkpoint outcomes are the exact
    # actions a cold agent must not burn another run on.
    do_not_repeat: list[str] = []
    for line in str(log_tail or "").splitlines():
        if "-> " + "INCOMPLETE" in line or "-> NO_EVIDENCE" in line:
            m = CHECKPOINT_RE.search(line)
            if m:
                do_not_repeat.append(_redact_prose(m.group(1), 160))
            tid = re.search(r"\[target: (T-\d+)\]", line)
            if tid and tid.group(1) not in known_reds:
                known_reds.append(tid.group(1))

    return {
        "schema_version": 1,
        "carrier": "derived-recovery-package",
        "authority": "STATE/BOARD/LOG remain canonical; this package is regenerable DATA",
        "PROJECT": state.get("saipen_home", ""),
        "CANONICAL_ROOT": runtime.get("canonical_root", ""),
        "PROJECT_IDENTITY": runtime.get("project_identity", ""),
        "PROJECT_LINEAGE": runtime.get("project_lineage", ""),
        "ACTIVE_WORK": active["id"] if active else None,
        "PHASE": state.get("phase", ""),
        "LAST_EVENT": f"E-{last_event}" if last_event else None,
        "LAST_CHECKPOINT": _redact_prose(checkpoint_match) if checkpoint_match else None,
        "LAST_VERIFIED_SLICE": _redact_prose(checkpoint_match) if checkpoint_match else None,
        "TREE_IDENTITY": tree_identity,
        "DIRTY_IDENTITY": dirty_identity,
        "OWNER": (active_fields.get("owner") or "").strip(),
        "CLAIM_TIME": (active_fields.get("claim_time") or "").strip(),
        "CLAIM_SESSION": (active_fields.get("claim_session") or "").strip(),
        "CLAIM_LIVENESS": str(runtime.get("claim_liveness") or ""),
        "MUTATION_LEASE": runtime.get("watchdog") or {},
        "BLOCKER": {
            "id": active["id"] if active else None,
            "unmet_needs": [
                n for n in (active["needs"] if active else []) if n not in done_ids
            ],
        },
        "BLOCKER_SCOPE": (active_fields.get("blocker_scope") or "ticket").strip()
        if active
        else "",
        "BLOCKED_ON": (active_fields.get("blocked_on") or "").strip(),
        "EVIDENCE": evidence,
        "DEFERRED": deferred,
        "OPERATOR_GATES": operator_gate_rows,
        # T-1429: DUE means a HUMAN must act NOW. Only an operator-owned class
        # carrying a machine due instant that has passed qualifies. Publishing
        # every parked ticket here was the false operator stop that ended
        # autonomous runs with nothing for the operator to actually do.
        "DUE": [
            row["id"] for row in operator_gate_rows if row["state"] == "DUE_OPERATOR_ACTION"
        ],
        "DUE_MODEL": "retry_not_before (strict UTC) on an operator-owned blocker; T-1429",
        "KNOWN_REDS": known_reds,
        "UNRELATED_REDS": unrelated_reds,
        "DO_NOT_REPEAT": do_not_repeat,
        "NEXT_ACTION": (
            seat_next_action
            if seat_next_action and not active_from_blocked
            else str(state.get("next_action", ""))
            if (active is None or active_from_blocked)
            else f"PHASE SCOUT {active['id']}"
        ),
        "NEXT_COMMAND": "saipen continue --json",
        "TODO_ELIGIBLE": [
            {"id": e["id"], "priority": e["priority"], "needs": e["needs"]}
            for e in todos
            if deps_ok[e["id"]]
        ],
        "TODO_UNMET": [
            {"id": e["id"], "unmet": [n for n in e["needs"] if n not in done_ids]}
            for e in todos
            if not deps_ok[e["id"]]
        ],
    }


# ---------------------------------------------------------------------------
# T-1446 / SRC-105: execution epoch, agent incarnation, AUTO_RECALL, AUTO_KICK.
#
# The field failure this ends (SAIFREN, SRC-105 section 15): the operator typed
# `cc`, SAIPEN continued, Work was claimed and SCOUT was running -- then the
# host's model router replaced the model mid-work. The successor read the
# historical `cc` in the conversation tail and asked the operator what it
# meant. Nothing machine-computed stood between a cold model and free-form
# interpretation of input that had already been consumed.
#
# Everything below is a READ-ONLY projection over STATE/BOARD/LOG. The host
# carries what only the host can know (which model answers, which session,
# whether the latest user message is new) in a ``carrier`` dict; SAIPEN
# answers with the canonical execution and the one turn-entry decision.

INGRESS_NONE = "NONE"
INGRESS_HISTORICAL = "HISTORICAL"
INGRESS_CONTINUATION = "CONTINUATION_COMMAND"
INGRESS_NEW = "NEW_USER_INPUT"
INGRESS_CLASSES = (INGRESS_NONE, INGRESS_HISTORICAL, INGRESS_CONTINUATION, INGRESS_NEW)

TURN_AUTO_KICK = "AUTO_KICK"
TURN_RUN_CONTINUE = "RUN_CONTINUE"
TURN_RECOVER = "RECOVER"
TURN_OPERATOR_WAIT = "OPERATOR_WAIT"
TURN_USER_INPUT = "USER_INPUT"
TURN_ORDINARY = "ORDINARY"
TURN_DECISIONS = (
    TURN_AUTO_KICK,
    TURN_RUN_CONTINUE,
    TURN_RECOVER,
    TURN_OPERATOR_WAIT,
    TURN_USER_INPUT,
    TURN_ORDINARY,
)
#: Decisions that require the canonical continuation BEFORE any chat text.
KICK_DECISIONS = frozenset({TURN_AUTO_KICK, TURN_RUN_CONTINUE, TURN_RECOVER})

#: What a kicked turn must never do (SRC-105 section 19). Stated once so the
#: directive and the regression read the same list.
FORBIDDEN_WHEN_KICKED = (
    "ASK_USER_MEANING",
    "REQUEST_CLARIFICATION",
    "IDLE_CHAT",
    "REINTERPRET_CONSUMED_INGRESS",
)

RESUME_COMMAND = "saipen continue --json"

#: Phases in which an active seat is not executable Work.
_NON_EXECUTING_PHASES = frozenset({"", "DONE", "IDLE", "INIT", "CORRUPT"})

#: Whole-message spellings of the continuation command besides the registry
#: shortcuts (`cc`, `ccc` and their Cyrillic twins resolve mechanically).
_CONTINUE_SPELLINGS = frozenset(
    {"saipen", "saipen continue", "saipen continue --json", "saipen cc"}
)


def _digest16(prefix: str, *parts: str) -> str:
    material = "\0".join(str(part or "").strip() for part in parts)
    return prefix + hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def execution_epoch(work: str | None, owner: str | None, claim_event: str | None) -> str | None:
    """Logical execution continuity, derived from the canonical claim EVENT.

    An epoch begins at the LOG event that claimed the Work. A model, provider
    or session change writes no claim event, so it cannot change the epoch.
    BOARD `claim_time` is deliberately NOT the anchor: every checkpoint
    refreshes it as a liveness lease (measured 2026-09-22, E-8173), so an
    epoch keyed on it changed at each checkpoint. When the claim event has
    been sealed out of the live LOG the epoch is anchored on (work, owner)
    alone -- still stable, never a heartbeat.
    """
    if not (work and owner):
        return None
    return _digest16("ep-", work, owner, claim_event or "unanchored")


def _claim_event(root, work: str, owner: str) -> str | None:
    """The newest `claimed via SAIOPS` LOG event for this Work and owner."""
    from pathlib import Path

    if not (work and owner):
        return None
    pattern = re.compile(
        r"\[(E-\d+)\].*\[" + re.escape(work) + r"\].*\[op: claim-[0-9a-f]+\] "
        r"DEC: claimed via SAIOPS -- owner " + re.escape(owner) + r"\s*$"
    )
    base = Path(root) / ".saipen"
    segments = [base / "LOG.md", *sorted((base / "logs").glob("LOG-*.md"), reverse=True)[:1]]
    for segment in segments:
        try:
            lines = segment.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            match = pattern.search(line)
            if match:
                return match.group(1)
    return None


def agent_incarnation(carrier: dict | None) -> str | None:
    """The current physical actor: host, session, provider and model.

    Disposable by design. Two incarnations of one epoch are the same execution
    served by different minds; the identity exists so a replacement is
    visible, never so it can be refused.
    """
    carrier = carrier or {}
    parts = [
        str(carrier.get(key) or "").strip()
        for key in ("host", "host_session", "provider", "model")
    ]
    if not any(parts):
        return None
    return _digest16("inc-", *parts)


def is_continuation_command(text: str | None) -> bool:
    """True when the whole message IS the continuation command."""
    compact = " ".join(str(text or "").split())
    if not compact:
        return False
    if compact.lower() in _CONTINUE_SPELLINGS:
        return True
    if " " in compact:
        return False
    from .commands import resolve_shortcut

    try:
        key = resolve_shortcut(compact)
    except (OSError, ValueError):
        return False
    return key in ("cc", "ccc")


def classify_ingress(ingress: dict | None) -> dict:
    """Classify the latest user message by host identity, never by prose.

    The host names the message (``id``) and says whether a previous turn entry
    already admitted it (``consumed``). A historical message is evidence of an
    execution that already started, whatever it says. Only an unconsumed
    message is user authority -- and a message SAIPEN cannot read is treated
    as NEW, because suppressing real input is worse than one extra read.
    """
    if not isinstance(ingress, dict):
        return {"class": INGRESS_NONE, "id": None, "digest": None, "continuation": False}
    text = ingress.get("text")
    message_id = str(ingress.get("id") or "").strip() or None
    digest = None
    if isinstance(text, str) and text.strip():
        normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    if message_id is None and digest is None:
        return {"class": INGRESS_NONE, "id": None, "digest": None, "continuation": False}
    continuation = is_continuation_command(text)
    if ingress.get("consumed") is True:
        klass = INGRESS_HISTORICAL
    elif continuation:
        klass = INGRESS_CONTINUATION
    else:
        klass = INGRESS_NEW
    return {"class": klass, "id": message_id, "digest": digest, "continuation": continuation}


def turn_entry(recall: dict, ingress_class: str, *, continuation: bool = False) -> dict:
    """The ONE turn-entry decision (SRC-105 section 17 ordering).

    bind -> inspect canonical execution -> classify ingress -> detect
    replacement -> recover -> continue; ordinary interpretation comes last.
    """
    if not recall.get("readable", False) or recall.get("recovery_pending"):
        decision = TURN_RECOVER
        reason = "canonical state needs recovery before any other turn handling"
    elif ingress_class == INGRESS_NEW:
        decision = TURN_USER_INPUT
        reason = "a genuinely new user message is user authority; handle it first"
    elif recall.get("wait"):
        decision = TURN_OPERATOR_WAIT
        reason = "the canonical next action is an operator WAIT"
    elif recall.get("continuation_required"):
        decision = TURN_AUTO_KICK
        reason = (
            "active executable Work exists and no new user input, WAIT or "
            "safety stop outranks it"
        )
    elif continuation or ingress_class == INGRESS_CONTINUATION:
        # Old or new, `cc` asked for the canonical continuation, and that
        # command is idempotent: re-running it after a replacement is the
        # original request, never a new interpretation of it.
        decision = TURN_RUN_CONTINUE
        reason = "the latest user message is the continuation command itself"
    else:
        decision = TURN_ORDINARY
        reason = "no active executable Work; ordinary handling applies"
    kick = decision in KICK_DECISIONS
    return {
        "decision": decision,
        "reason": reason,
        "kick": kick,
        "command": RESUME_COMMAND if kick else None,
        "forbidden": list(FORBIDDEN_WHEN_KICKED) if kick else [],
    }


def _log_tail_text(root, max_bytes: int = 64 * 1024) -> str:
    from pathlib import Path

    path = Path(root) / ".saipen" / "LOG.md"
    try:
        with path.open("rb") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes))
            raw = handle.read()
    except OSError:
        return ""
    text = raw.decode("utf-8", errors="replace")
    if size > max_bytes and "\n" in text:
        text = text.split("\n", 1)[1]
    return text


def auto_recall(root, carrier: dict | None = None) -> dict:
    """AUTO_RECALL: the canonical execution a successor must adopt, read-only.

    Projection only. It never claims, never writes, and never depends on the
    predecessor's hidden reasoning: every field is recomputed from
    STATE/BOARD/LOG plus the host carrier on each call.
    """
    from pathlib import Path

    from . import watchdog as _watchdog
    from .board import claim_session_digest, claim_status, parse_board
    from .paths import project_lineage_identity
    from .state import parse_state_or_error

    root = Path(root)
    carrier = dict(carrier or {})
    ingress = classify_ingress(carrier.get("ingress"))
    base = {
        "schema_version": 1,
        "carrier": "auto-recall",
        "authority": "STATE/BOARD/LOG remain canonical; this recall is regenerable DATA",
        "project_root": str(root),
        "ingress": ingress,
        "ingress_already_consumed": ingress["class"] == INGRESS_HISTORICAL,
        "agent_incarnation": agent_incarnation(carrier),
        "exact_resume_command": RESUME_COMMAND,
    }
    try:
        state_text = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8-sig")
        board_text = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8-sig")
    except OSError as exc:
        recall = {**base, "readable": False, "problem": f"{type(exc).__name__}: {exc}"}
        recall["turn"] = turn_entry(recall, ingress["class"], continuation=ingress["continuation"])
        return recall
    state, error = parse_state_or_error(state_text)
    board = parse_board(board_text)
    if state is None or board.get("errors"):
        problem = error or "; ".join(board.get("errors", [])[:3])
        recall = {**base, "readable": False, "problem": str(problem)}
        recall["turn"] = turn_entry(recall, ingress["class"], continuation=ingress["continuation"])
        return recall

    task = str(state.get("task") or "").strip()
    task = "" if task.lower() == "none" else task
    ticket = board.get("tickets", {}).get(task) if task else None
    fields = (ticket or {}).get("fields", {})
    owner = str(fields.get("owner") or "").strip()
    claim_event = _claim_event(root, task, owner) if ticket else None
    claim_session = str(fields.get("claim_session") or "").strip()
    lineage = project_lineage_identity(root)
    session_digest = claim_session_digest(lineage, carrier.get("host_session"))
    liveness = claim_status(ticket, agent=state.get("agent")) if ticket else ""
    watch = _watchdog.observe(root).as_dict()
    package = build_recovery_package(
        state_text,
        board_text,
        _log_tail_text(root),
        runtime_state={
            "canonical_root": str(root),
            "project_lineage": lineage,
            "watchdog": watch,
            "claim_liveness": liveness,
        },
    )
    try:
        from .journal import scan_pending

        pending, conflicts = scan_pending(root)
        recovery_pending = bool(pending or conflicts)
    except (OSError, ValueError):
        recovery_pending = True

    phase = str(state.get("phase") or "").strip().upper()
    next_action = str(state.get("next_action") or "").strip()
    blocker = str(state.get("blocker") or "").strip()
    wait = next_action.upper().startswith("WAIT")
    section = (ticket or {}).get("section", "")
    continuation_required = bool(
        task
        and ticket is not None
        and section == "## DOING"
        and phase not in _NON_EXECUTING_PHASES
        and not wait
        and not blocker
    )
    previous = str(carrier.get("previous_incarnation") or "").strip() or None
    incarnation = base["agent_incarnation"]
    session_changed = bool(claim_session and session_digest and session_digest != claim_session)
    model_changed = bool(previous and incarnation and previous != incarnation)
    cold = carrier.get("cold") is True
    source_receipts = [
        item.strip() for item in str(fields.get("source_receipts") or "").split(",") if item.strip()
    ]
    recall = {
        **base,
        "readable": True,
        "saipen_home": str(state.get("saipen_home") or ""),
        "project_lineage": lineage,
        "execution_epoch": execution_epoch(task, owner, claim_event),
        "claim_event": claim_event,
        "active_work": task or None,
        # QUALITY-TIME-01: the successor gets the SAME acceptance, verbatim
        # from BOARD, whatever model it is. Data for the agent's own reads;
        # never copied into the injected directive (P0-1).
        "objective": _redact_prose(str((ticket or {}).get("description") or ""), 240) or None,
        "acceptance": str(fields.get("verify") or "").strip() or None,
        "source_receipts": source_receipts,
        "phase": phase,
        "last_event": package.get("LAST_EVENT"),
        "last_durable_checkpoint": package.get("LAST_CHECKPOINT"),
        "last_verified_slice": package.get("LAST_VERIFIED_SLICE"),
        "claim_owner": owner or None,
        "claim_liveness": liveness or None,
        "mutation_lease_generation": watch.get("lease_generation"),
        "mutation_lease_state": watch.get("state"),
        "blocker": blocker or None,
        "blocker_scope": package.get("BLOCKER_SCOPE") or None,
        "operator_action_due": list(package.get("DUE") or []),
        "execution_intent": str(state.get("execution_intent") or "") or None,
        "canonical_next_action": next_action or None,
        "wait": wait,
        "recovery_pending": recovery_pending,
        "continuation_required": continuation_required,
        "replacement_detected": bool(session_changed or model_changed or cold),
        "replacement_evidence": {
            "session_changed": session_changed,
            "model_changed": model_changed,
            "cold_successor": cold,
        },
        "do_not_repeat": list(package.get("DO_NOT_REPEAT") or []),
    }
    recall["turn"] = turn_entry(recall, ingress["class"], continuation=ingress["continuation"])
    return recall


def render_directive(recall: dict) -> str:
    """The bounded text a host puts in front of EVERY model request.

    A model instruction is not a recovery mechanism on its own; this text is
    the carrier of a machine decision the host computed from canonical state
    on this very request, so a replacement model receives the decision rather
    than a memory it does not have.
    """
    import json as _json

    # P0-1 (T-1317): project-derived text never becomes system instruction.
    # Every value below is admitted only through a closed grammar; a WAIT's
    # free prose and any hostile STATE/BOARD text are dropped, never echoed.
    def _bounded(value, pattern: str):
        text = str(value or "")
        return text if re.fullmatch(pattern, text) else None

    turn = recall.get("turn") or {}
    decision = _bounded(turn.get("decision"), "|".join(TURN_DECISIONS))
    work = _bounded(recall.get("active_work"), r"T-\d{1,6}")
    phase = _bounded(recall.get("phase"), r"[A-Z_]{2,16}")
    compact = {
        "decision": decision,
        "active_work": work,
        "phase": phase,
        "execution_epoch": _bounded(recall.get("execution_epoch"), r"ep-[0-9a-f]{16}"),
        "agent_incarnation": _bounded(recall.get("agent_incarnation"), r"inc-[0-9a-f]{16}"),
        "last_event": _bounded(recall.get("last_event"), r"E-\d{1,9}"),
        "ingress": _bounded((recall.get("ingress") or {}).get("class"), "|".join(INGRESS_CLASSES)),
        "replacement_detected": recall.get("replacement_detected") is True,
        "next_action": _bounded(
            recall.get("canonical_next_action"), r"PHASE [A-Z_]{2,16}(?: T-\d{1,6})?"
        ),
        "resume": RESUME_COMMAND,
    }
    lines = ["SAIPEN_AUTO_RECALL " + _json.dumps(compact, sort_keys=True)]
    if decision in KICK_DECISIONS:
        lines.append(
            f"CONTINUATION_REQUIRED: {work or 'the canonical route'} is active, legal "
            f"and unfinished (phase {phase or 'unknown'}). Before writing any "
            f"conversational text, run exactly `{RESUME_COMMAND}` and execute the "
            "action it returns in this turn."
        )
        lines.append(
            "Earlier user messages in this conversation (for example `cc`) were "
            "already consumed into this execution. They are evidence, not a new "
            "question: do not ask what they mean, do not ask whether to continue, "
            "do not wait for another keystroke."
        )
    elif decision == TURN_OPERATOR_WAIT:
        lines.append(
            "OPERATOR_WAIT: the canonical next action is an operator WAIT. Run "
            "`saipen status --json` and report its OPERATOR ACTION exactly; invent no work."
        )
    elif decision == TURN_USER_INPUT:
        lines.append(
            "NEW_USER_INPUT: the latest user message is new authority. Handle it "
            "under BOOT Entry first (an actionable task goes through `saipen start`); "
            f"active Work {work or 'none'} resumes through `{RESUME_COMMAND}` afterwards."
        )
    return "\n".join(lines)
