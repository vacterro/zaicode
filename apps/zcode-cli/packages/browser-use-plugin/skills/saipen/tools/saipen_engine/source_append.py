"""SRC-104 / T-1461: operational handoff appends are mission state, not prose.

The failure this ends: an operator hands the running mission one more file --
"recoverable binding failures must fall back to direct launch" -- and the agent
answers with a summary of it. The requirement never reaches BOARD, coverage or
routing, so it exists only in a chat transcript the next model will not see.
The same thing happens to a 2,000-line replacement handoff pasted after `/new`
and to ten small "bricks" delivered over an afternoon.

Transport never mattered; what was missing was one canonical way for material
that CHANGES THE ACTIVE MISSION to become durable mission input. This module is
that owner, built from intake machinery that already existed:

* an append is an immutable intake receipt captured VERBATIM with
  ``amends: <controlling SRC>`` -- the controlling source's bytes are never
  touched, and exact-digest dedupe makes a repeated file idempotent;
* a per-source ORDERED ledger (``.saipen/intake/appends/SRC-###.json``) records
  each append's class, delta, supersession and processing state, so "received
  but not yet projected" is a machine fact routing can act on;
* projection derives traceable requirement clauses deterministically from the
  normative lines (MUST / MUST NOT / do not / never / acceptance and test
  items), binds them to the controlling mission's Work, marks superseded
  requirements SUPERSEDED (never deleted), and rewinds the active Work only as
  far as the delta truthfully requires;
* `saipen continue` routes a received-but-unprojected append to
  ``saipen source apply-append SRC-###`` before any phase continuation, so the
  mission cannot proceed as if the append had not arrived.

Semantic judgement stays with the agent -- the class (APPEND / SUPERSEDE /
CLARIFICATION / CONFLICT / NEW_MISSION), the delta kind and what an append
supersedes are explicit inputs. Everything mechanical is decided here once.
"""

from __future__ import annotations

import datetime as _dt
import json
import re
from pathlib import Path

from . import intake

APPEND = "APPEND"
SUPERSEDE = "SUPERSEDE"
CLARIFICATION = "CLARIFICATION"
CONFLICT = "CONFLICT"
NEW_MISSION = "NEW_MISSION"
CLASSES = (APPEND, SUPERSEDE, CLARIFICATION, CONFLICT, NEW_MISSION)

#: What the append changes, which decides the minimum truthful rewind.
DELTA_IMPLEMENTATION = "implementation"
DELTA_EVIDENCE = "evidence"
DELTA_REVIEW = "review"
DELTA_PACKAGING = "packaging"
DELTA_CONTEXT = "context"
DELTAS = (DELTA_IMPLEMENTATION, DELTA_EVIDENCE, DELTA_REVIEW, DELTA_PACKAGING, DELTA_CONTEXT)

RECEIVED = "RECEIVED"
PROJECTED = "PROJECTED"
SUPERSEDED = "SUPERSEDED"
LEDGER_STATES = (RECEIVED, PROJECTED, SUPERSEDED)

LEDGER_DIR = ("intake", "appends")
SCHEMA_VERSION = 1

#: Phases after BUILD in lifecycle order. Only an IMPLEMENTATION delta rewinds,
#: and only a Work that already moved past BUILD: new evidence is produced where
#: the Work stands (an unresolved clause already gates closure), so an
#: acceptance-only append never sends finished code back to BUILD.
_PAST_BUILD = ("VERIFY", "REVIEW", "SHIP")

#: The receipt kind appends are captured as.
APPEND_KIND = "corrective_followup"

#: Bounds on derived clauses. A clause is a pointer into immutable bytes, not a
#: second copy of them; a mega handoff yields many clauses, never unbounded ones.
MAX_CLAUSE_CHARS = 400
MAX_CLAUSES = 250


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


# -- deterministic requirement derivation ------------------------------------

_NORMATIVE = re.compile(
    r"\b(?:MUST(?: NOT)?|SHALL(?: NOT)?|NEVER)\b|"
    r"(?i:\bmust(?: not)?\b|\bshall\b|^\s*(?:do not|never|always|avoid)\b)"
)
_INVARIANT = re.compile(r"(?i)\b(?:must not|shall not|never)\b|^\s*(?:do not|avoid)\b")
#: Headings under which EVERY list item is itself normative content.
_ACCEPTANCE_HEADING = re.compile(
    r"(?i)\b(?:acceptance|test matrix|tests?|required(?: zeros)?|invariants?|"
    r"terminal conditions|must|constraints?)\b"
)
_HEADING = re.compile(
    r"^\s*(?:#{1,6}\s+.+|[A-Z0-9][A-Z0-9 /&'().:,\-]{3,}|\d+(?:\.\d+)*\.?\s+[A-Z].*)$"
)
_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.+)$")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'`(])")
#: Em and en dash by code point: handoff titles use them, and a literal copy of
#: either in source is an ambiguous-character trap.
_DASHES = chr(0x2014) + chr(0x2013)
_CAPS_TITLE = re.compile(r"^[A-Z0-9][A-Z0-9 /&'().:,\-" + _DASHES + r"]{3,}$")


def _normalize(text: str) -> str:
    compact = " ".join(str(text or "").split()).strip(" -*;")
    if len(compact) > MAX_CLAUSE_CHARS:
        compact = compact[: MAX_CLAUSE_CHARS - 1].rstrip() + "…"
    return compact


def _units(body: str):
    """(text, is_list_unit) per semantic unit: a paragraph or one list item.

    Operational handoffs hard-wrap at ~80 columns, so a LINE is not a unit: a
    wrapped sentence split in two would become two half-requirements. A blank
    line ends a unit; a bullet starts a new one and swallows its continuation
    lines; a fenced block is one list-like unit ("stolen lease count = 0" and
    its siblings stay together as the criterion they are).
    """
    block: list[str] = []
    items: list[list[str]] = []
    in_fence = False

    def flush():
        if items:
            for item in items:
                yield " ".join(item), True
        elif block and in_fence:
            yield " ".join(block), True
        elif block:
            # Rejoin the wrap, then split on sentence ends: adjacent rules
            # written one per line without a blank line between them are
            # separate requirements, a sentence wrapped over two lines is one.
            for sentence in _SENTENCE_END.split(" ".join(block)):
                if sentence.strip():
                    yield sentence.strip(), False

    for raw in [*str(body or "").splitlines(), ""]:
        stripped = raw.strip()
        if stripped.startswith("```"):
            yield from flush()
            block, items = [], []
            in_fence = not in_fence
            continue
        if not stripped or (not in_fence and set(stripped) <= set("=-_*#~")):
            yield from flush()
            block, items = [], []
            continue
        item = None if in_fence else _ITEM.match(raw)
        if item is not None and _CAPS_TITLE.match(item.group(1)):
            # "13. ACCELERATED CHAOS GATE" is a numbered heading, not an item.
            yield from flush()
            block, items = [], []
            yield item.group(1).strip(), None
            continue
        if item is not None:
            if block:
                yield from flush()
                block = []
            items.append([item.group(1)])
        elif items and not in_fence:
            items[-1].append(stripped)
        else:
            block.append(stripped)
    yield from flush()


def derive_normative_clauses(body: str) -> list[tuple[str, str]]:
    """Traceable requirement clauses from an operational body. Deterministic.

    A unit (paragraph, list item or fenced block) is normative when it carries
    a normative keyword, or when it is a list/fenced unit under a heading that
    makes its items normative (acceptance, tests, required values,
    invariants). `MUST NOT` / `never` / `do not` units are invariants; units
    under acceptance/test headings are acceptance criteria; the rest are
    requirements. Identical texts collapse to one, so a consolidated handoff
    and the bricks it was assembled from derive the SAME clause set -- which is
    what makes the two input forms equivalent.
    """
    clauses: list[tuple[str, str]] = []
    seen: set[str] = set()
    heading = ""
    for text, is_list in _units(body):
        if is_list is None or (
            not is_list
            and not _NORMATIVE.search(text)
            and (_HEADING.match(text) or _CAPS_TITLE.match(text)
                 or (text.endswith(":") and len(text) <= 80))
        ):
            heading = text
            continue
        under_acceptance = bool(heading and _ACCEPTANCE_HEADING.search(heading))
        if not (_NORMATIVE.search(text) or (is_list and under_acceptance)):
            continue
        normalized = _normalize(text)
        key = normalized.lower()
        if not normalized or key in seen:
            continue
        seen.add(key)
        if _INVARIANT.search(text):
            klass = "invariant"
        elif under_acceptance:
            klass = "acceptance-criterion"
        else:
            klass = "requirement"
        clauses.append((klass, normalized))
        if len(clauses) >= MAX_CLAUSES:
            break
    return clauses


# -- ledger ------------------------------------------------------------------

def ledger_path(root: Path | str, source: str) -> Path:
    return Path(root).joinpath(".saipen", *LEDGER_DIR, f"{source}.json")


def read_ledger(root: Path | str, source: str) -> dict:
    path = ledger_path(root, source)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"schema_version": SCHEMA_VERSION, "source": source, "appends": []}
    except (OSError, UnicodeError, ValueError) as exc:
        raise ValueError(f"append ledger {source} is unreadable: {exc}") from exc
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != SCHEMA_VERSION
        or payload.get("source") != source
        or not isinstance(payload.get("appends"), list)
    ):
        raise ValueError(f"append ledger {source} has an unsupported shape")
    return payload


def _write_ledger(root: Path, source: str, ledger: dict) -> None:
    from .journal import _atomic_write, owned_target_path
    from .lock import project_writer_lock

    path = ledger_path(root, source)
    body = (json.dumps(ledger, indent=2, sort_keys=True) + "\n").encode("utf-8")
    with project_writer_lock(root):
        owned_target_path(root, path.relative_to(root).as_posix(), kind="source append ledger")
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write(path, body, ownership_root=root)


def ledgers(root: Path | str) -> list[dict]:
    """Every append ledger in the project, oldest source first. Read-only."""
    directory = Path(root).joinpath(".saipen", *LEDGER_DIR)
    if not directory.is_dir():
        return []
    found = []
    for path in sorted(directory.glob("SRC-*.json")):
        try:
            found.append(read_ledger(root, path.stem))
        except ValueError as exc:
            found.append({"source": path.stem, "appends": [], "error": str(exc)})
    return found


def _entry(ledger: dict, receipt: str) -> dict | None:
    return next((item for item in ledger["appends"] if item.get("receipt") == receipt), None)


def find_append(root: Path | str, receipt: str) -> tuple[str, dict] | tuple[None, None]:
    """(controlling source, ledger entry) for an append receipt."""
    for ledger in ledgers(root):
        entry = _entry(ledger, receipt)
        if entry is not None:
            return ledger["source"], entry
    return None, None


# -- resolution --------------------------------------------------------------

def _state_and_board(root: Path) -> tuple[dict, dict]:
    from .board import parse_board
    from .codec import read_doc
    from .state import parse_state_or_error

    state, _error = parse_state_or_error(read_doc(root / ".saipen" / "STATE.md"))
    board = parse_board(read_doc(root / ".saipen" / "BOARD.md"))
    return state or {}, board


def _receipts_of(ticket: dict | None) -> list[str]:
    raw = str(((ticket or {}).get("fields") or {}).get("source_receipts") or "")
    return [value.strip() for value in raw.split(",") if value.strip()]


def resolve_controlling_source(root: Path | str, explicit: str | None = None) -> dict:
    """Which source an append amends. Explicit wins; else the active Work's."""
    root = Path(root)
    active = {item["receipt"]: item for item in intake.active_receipts(root)}
    if explicit:
        if explicit not in active:
            return {
                "ok": False,
                "code": "APPEND_TARGET_UNKNOWN",
                "detail": f"{explicit} is not an active source receipt",
            }
        return {"ok": True, "source": explicit}
    state, board = _state_and_board(root)
    task = str(state.get("task") or "none")
    ticket = board.get("tickets", {}).get(task)
    for receipt in _receipts_of(ticket):
        if receipt in active:
            return {"ok": True, "source": receipt, "work": task}
    candidates = sorted(
        receipt
        for receipt, item in active.items()
        if item.get("linked_work")
        and (intake._read_meta(root, receipt) or {}).get("source_kind") == "user_instruction"
    )
    return {
        "ok": False,
        "code": "APPEND_TARGET_UNKNOWN",
        "detail": (
            "no active Work names a source receipt to amend; name the mission with "
            "--to <SRC-###>"
            + (f" (active user sources: {', '.join(candidates[-5:])})" if candidates else "")
        ),
        "canonical_next_command": "saipen source append --to <SRC-###> --file <path>",
    }


# -- append (durable receipt + ledger entry) -----------------------------------

def append(
    root: Path | str,
    body: str,
    *,
    to: str | None = None,
    klass: str = APPEND,
    delta: str = DELTA_IMPLEMENTATION,
    supersedes: tuple[str, ...] | list[str] = (),
    label: str = "",
    actor: str | None = None,
) -> dict:
    """Make one operational append durable. Never interprets beyond its inputs."""
    root = Path(root)
    if klass not in CLASSES:
        return {"ok": False, "code": "APPEND_CLASS_INVALID", "detail": f"class {klass!r}",
                "allowed": list(CLASSES)}
    if delta not in DELTAS:
        return {"ok": False, "code": "APPEND_DELTA_INVALID", "detail": f"delta {delta!r}",
                "allowed": list(DELTAS)}
    if klass == NEW_MISSION:
        return {
            "ok": False,
            "code": "APPEND_NEW_MISSION",
            "detail": (
                "a different objective is a new mission, never an append: it enters "
                "through ordinary intake so it is not silently merged into this one"
            ),
            "canonical_next_command": "saipen start --file <path>",
        }
    supersedes = [str(value).strip() for value in supersedes if str(value).strip()]
    if klass == CONFLICT and not supersedes:
        return {
            "ok": False,
            "code": "APPEND_CONFLICT_UNNAMED",
            "detail": "a conflicting update must name what it supersedes (--supersedes)",
        }
    target = resolve_controlling_source(root, to)
    if not target.get("ok"):
        return target
    source = target["source"]
    unknown = [value for value in supersedes if not _supersedable(root, source, value)]
    if unknown:
        return {
            "ok": False,
            "code": "APPEND_SUPERSEDES_UNKNOWN",
            "detail": f"nothing to supersede at {', '.join(unknown)}",
        }
    captured = intake.capture(root, body, source_kind=APPEND_KIND, amends=source)
    if not captured.get("ok"):
        return captured
    receipt = captured["receipt"]
    if receipt == source:
        return {
            "ok": True,
            "code": "APPEND_IS_SOURCE",
            "receipt": receipt,
            "source": source,
            "detail": "these bytes ARE the controlling source; nothing new to project",
        }
    ledger = read_ledger(root, source)
    existing = _entry(ledger, receipt)
    if existing is not None:
        return {
            "ok": True,
            "code": "ALREADY_APPENDED",
            "receipt": receipt,
            "source": source,
            "seq": existing["seq"],
            "state": existing["state"],
            "canonical_next_command": (
                f"saipen source apply-append {receipt}"
                if existing["state"] == RECEIVED
                else "saipen continue --json"
            ),
        }
    entry = {
        "receipt": receipt,
        "seq": len(ledger["appends"]) + 1,
        "class": klass,
        "delta": delta,
        "supersedes": supersedes,
        "label": _normalize(label)[:120],
        "state": RECEIVED,
        "received_at": _now(),
        "source_sha256": captured.get("source_sha256"),
        "derived_clauses": [],
        "work": [],
        "rewind": None,
        "projected_at": None,
        "steps": [],
    }
    ledger["appends"].append(entry)
    _write_ledger(root, source, ledger)
    event = _journal(
        root,
        actor,
        f"append {receipt} to {source} received (seq {entry['seq']}, {klass}/{delta}"
        + (f", supersedes {','.join(supersedes)}" if supersedes else "")
        + f"); projection: saipen source apply-append {receipt}",
    )
    return {
        "ok": True,
        "code": "APPEND_RECEIVED",
        "receipt": receipt,
        "source": source,
        "seq": entry["seq"],
        "class": klass,
        "delta": delta,
        "event": event,
        "canonical_next_command": f"saipen source apply-append {receipt}",
    }


def _journal(root: Path, actor: str | None, text: str) -> str | None:
    """One LOG decision line per append transition -- visible, never the only record.

    Best effort by design: the receipt and the ledger are the durable truth, so a
    refused LOG write (for example a foreign seat) never undoes an append.
    """
    from .operations import checkpoint

    try:
        state, _board = _state_and_board(root)
        result = checkpoint(root, actor or str(state.get("agent") or "saipen"), "DEC", None, text)
    except Exception:  # the append is already durable
        return None
    return result.data.get("event_id") if result.ok else None


def _supersedable(root: Path, source: str, value: str) -> bool:
    """A clause id (`SRC-###:R###`) with coverage, or an earlier append."""
    if re.fullmatch(r"SRC-\d+:R\d+", value):
        receipt = value.split(":", 1)[0]
        try:
            ledger = intake._read_coverage(root, receipt)
        except (OSError, ValueError):
            return False
        return value in ledger.get("requirements", {})
    if re.fullmatch(r"SRC-\d+", value):
        return _entry(read_ledger(root, source), value) is not None
    return False


# -- projection --------------------------------------------------------------

def minimum_rewind(phase: str, delta: str) -> str | None:
    """The phase an active Work must return to, or None to stay where it is."""
    if delta == DELTA_IMPLEMENTATION and phase in _PAST_BUILD:
        return "BUILD"
    return None


def _live_work(root: Path, source: str) -> tuple[str | None, dict]:
    """The controlling mission's Work that is not DONE, preferring DOING."""
    state, board = _state_and_board(root)
    tickets = board.get("tickets", {})
    meta = intake._read_meta(root, source) or {}
    members = sorted(intake.linked_works(meta))
    by_section = {}
    for work in members:
        ticket = tickets.get(work)
        if ticket is not None:
            by_section.setdefault(ticket["section"], []).append(work)
    task = str(state.get("task") or "none")
    if task in members and task in tickets and tickets[task]["section"] == "## DOING":
        return task, state
    for section in ("## DOING", "## TODO", "## BLOCKED"):
        if by_section.get(section):
            return by_section[section][0], state
    return None, state


def apply_append(root: Path | str, receipt: str, *, actor: str | None = None) -> dict:
    """Project one received append into the mission. Idempotent and resumable.

    Every step is individually idempotent, so a crash anywhere leaves a state
    the next call completes rather than duplicates: Work is linked before any
    clause is derived (so clauses carry the Work), clause texts already on the
    receipt are skipped, supersession re-applies the same disposition, and the
    rewind only fires while the Work is still past the target phase.
    """
    from .operations import ticket_add, transition_phase

    root = Path(root)
    source, entry = find_append(root, receipt)
    if entry is None:
        return {"ok": False, "code": "APPEND_NOT_FOUND",
                "detail": f"{receipt} is not a recorded append of any source"}
    if entry["state"] == PROJECTED:
        return {"ok": True, "code": "ALREADY_PROJECTED", "receipt": receipt, "source": source,
                "work": entry.get("work", []), "derived_clauses": entry.get("derived_clauses", [])}
    if entry["state"] == SUPERSEDED:
        return {"ok": True, "code": "APPEND_SUPERSEDED", "receipt": receipt, "source": source}

    work, state = _live_work(root, source)
    created = None
    if work is None:
        # The mission's Work is finished: the append's actionable content is
        # NEW Work under the same mission, started through canonical intake,
        # never refused because the prior Work is DONE.
        label = entry.get("label") or f"operational append {receipt} to {source}"
        added = ticket_add(
            root,
            actor or str(state.get("agent") or "saipen"),
            "P1",
            f"Append {receipt} to {source}: {label}",
            [],
            f"every derived clause of {receipt} carries a terminal disposition with evidence",
        )
        if not added.ok:
            return {"ok": False, "code": added.code, "detail": added.to_dict().get("message")
                    or added.to_dict().get("detail"), "receipt": receipt}
        work = added.data["ticket"]
        created = work
    linked = intake.link_work_to(root, receipt, work)
    if not linked.get("ok"):
        return {**linked, "receipt": receipt, "step": "link"}
    _mark_step(root, source, receipt, "linked")

    body = intake.read_body(root, receipt)
    if not body.get("ok"):
        return {**body, "receipt": receipt, "step": "read"}
    derived = derive_normative_clauses(str(body.get("body") or ""))
    if entry.get("class") == CLARIFICATION:
        derived = [("context", text) for _klass, text in derived]
    contract = intake._read_contract(root, receipt) or {}
    existing = {
        " ".join(str(clause.get("text") or "").split()).lower(): rid
        for rid, clause in (contract.get("clauses") or {}).items()
    }
    clause_ids = list(existing.values())
    if not derived and not existing:
        seeded = intake.ensure_request_clause(root, receipt)
        if not seeded.get("ok"):
            return {**seeded, "receipt": receipt, "step": "derive"}
        contract = intake._read_contract(root, receipt) or {}
        clause_ids = sorted((contract.get("clauses") or {}).keys())
    # T-1462: every new clause in ONE contract revision under ONE writer-lock
    # transaction; one plan per clause made a 156-clause handoff outlast the
    # interactive bound of the `continue` that projected it.
    batch: list[dict] = []
    for klass, text in derived:
        if text.lower() in existing:
            continue
        rid = f"R{len(existing) + 1:03d}"
        batch.append({"rid": rid, "text": text, "class": klass})
        existing[text.lower()] = f"{receipt}:{rid}"
        clause_ids.append(f"{receipt}:{rid}")
    if batch:
        added = intake.add_requirements(root, receipt, batch)
        if not added.get("ok"):
            return {
                **added,
                "receipt": receipt,
                "step": "derive",
                "clause": str(batch[0]["text"])[:80],
            }
    _mark_step(root, source, receipt, "derived")

    superseded = _apply_supersession(root, source, entry, receipt)
    if isinstance(superseded, dict):
        return superseded
    _mark_step(root, source, receipt, "superseded")

    rewind = None
    target = minimum_rewind(str(state.get("phase") or ""), entry.get("delta", DELTA_IMPLEMENTATION))
    task = str(state.get("task") or "none")
    if target and task == work:
        moved = transition_phase(
            root,
            target,
            actor or str(state.get("agent") or "saipen"),
            work,
            f"{target}: append {receipt} ({entry.get('class')}/{entry.get('delta')}) adds "
            f"implementation to {work}; minimum truthful rewind from {state.get('phase')}",
        )
        if not moved.ok:
            return {"ok": False, "code": moved.code, "receipt": receipt, "step": "rewind",
                    "detail": moved.to_dict().get("message") or moved.to_dict().get("detail")}
        rewind = {"from": state.get("phase"), "to": target, "work": work}
    ledger = read_ledger(root, source)
    current = _entry(ledger, receipt)
    current.update(
        state=PROJECTED,
        work=sorted(set(current.get("work") or []) | {work}),
        derived_clauses=clause_ids,
        rewind=rewind,
        projected_at=_now(),
        created_work=created,
        superseded=superseded,
    )
    _write_ledger(root, source, ledger)
    event = _journal(
        root,
        actor,
        f"append {receipt} to {source} projected into {work}: {len(clause_ids)} clause(s)"
        + (f", created {created}" if created else "")
        + (f", superseded {len(superseded)}" if superseded else "")
        + (f", rewind {rewind['from']}->{rewind['to']}" if rewind else ", no rewind"),
    )
    return {
        "ok": True,
        "code": "APPEND_PROJECTED",
        "event": event,
        "receipt": receipt,
        "source": source,
        "work": work,
        "created_work": created,
        "derived_clauses": clause_ids,
        "superseded": superseded,
        "rewind": rewind,
        "canonical_next_command": "saipen continue --json",
    }


def _mark_step(root: Path, source: str, receipt: str, step: str) -> None:
    ledger = read_ledger(root, source)
    entry = _entry(ledger, receipt)
    if entry is not None and step not in entry.setdefault("steps", []):
        entry["steps"].append(step)
        _write_ledger(root, source, ledger)


def _apply_supersession(root: Path, source: str, entry: dict, receipt: str):
    """Mark what this append replaces SUPERSEDED. Terminal evidence survives."""
    targets = list(entry.get("supersedes") or [])
    ledger = read_ledger(root, source)
    if entry.get("class") == SUPERSEDE and not targets:
        targets = [
            item["receipt"]
            for item in ledger["appends"]
            if item["receipt"] != receipt and item["seq"] < entry["seq"]
            and item["state"] != SUPERSEDED
        ]
    evidence = f"superseded by append {receipt} to {source} ({entry.get('class')})"
    done: list[str] = []
    for target in targets:
        if re.fullmatch(r"SRC-\d+:R\d+", target):
            owner = target.split(":", 1)[0]
            coverage = intake._read_coverage(root, owner)
            current = coverage.get("requirements", {}).get(target, {}).get("disposition")
            if current in intake.TERMINAL_DISPOSITIONS and current != "SUPERSEDED":
                # Completed evidence is history, not an obsolete instruction.
                continue
            result = intake.set_disposition(root, owner, target, "SUPERSEDED", evidence=evidence)
            if not result.get("ok"):
                return {**result, "receipt": receipt, "step": "supersede", "target": target}
            done.append(target)
            continue
        prior = _entry(ledger, target)
        if prior is None:
            continue
        coverage = intake._read_coverage(root, target)
        for rid, row in sorted(coverage.get("requirements", {}).items()):
            if row.get("disposition") in intake.TERMINAL_DISPOSITIONS:
                continue
            result = intake.set_disposition(root, target, rid, "SUPERSEDED", evidence=evidence)
            if not result.get("ok"):
                return {**result, "receipt": receipt, "step": "supersede", "target": rid}
            done.append(rid)
        ledger = read_ledger(root, source)
        prior = _entry(ledger, target)
        prior["state"] = SUPERSEDED
        prior["superseded_by"] = receipt
        _write_ledger(root, source, ledger)
        done.append(target)
    return done


# -- observation ---------------------------------------------------------------

def pending_appends(root: Path | str) -> list[dict]:
    """Received-but-unprojected appends, oldest first. Read-only."""
    pending = []
    for ledger in ledgers(root):
        for item in ledger.get("appends", []):
            if item.get("state") == RECEIVED:
                pending.append({**item, "source": ledger["source"]})
    pending.sort(key=lambda item: (item.get("received_at") or "", item["source"], item["seq"]))
    return pending


def pending_append_projection(root: Path | str | None) -> dict | None:
    """The router's read-only seam: the one append routing must project first."""
    if root is None:
        return None
    try:
        pending = pending_appends(root)
    except (OSError, ValueError) as exc:
        return {"invalid": True, "action": "saipen source appends",
                "detail": f"append ledger unreadable: {exc}"}
    if not pending:
        return None
    first = pending[0]
    return {
        "action": f"saipen source apply-append {first['receipt']}",
        "receipt": first["receipt"],
        "source": first["source"],
        "pending": len(pending),
        "detail": (
            f"operational append {first['receipt']} to {first['source']} is durable but "
            "not yet projected into the mission; project it before continuing"
        ),
    }


def append_status(root: Path | str) -> dict:
    """What status shows: per mission, latest append, counts, pending, Work."""
    root = Path(root)
    missions = []
    for ledger in ledgers(root):
        appends = ledger.get("appends", [])
        if not appends and "error" not in ledger:
            continue
        active_clauses = superseded_clauses = 0
        for item in appends:
            try:
                coverage = intake._read_coverage(root, item["receipt"])
            except (OSError, ValueError):
                continue
            for row in coverage.get("requirements", {}).values():
                if row.get("disposition") == "SUPERSEDED":
                    superseded_clauses += 1
                elif row.get("actionable", True):
                    active_clauses += 1
        latest = appends[-1] if appends else {}
        unprojected = [item["receipt"] for item in appends if item.get("state") == RECEIVED]
        missions.append({
            "source": ledger["source"],
            "appends": len(appends),
            "latest_append": latest.get("receipt"),
            "latest_class": latest.get("class"),
            "unprojected": unprojected,
            "active_requirements": active_clauses,
            "superseded_requirements": superseded_clauses,
            "affected_work": sorted({work for item in appends for work in item.get("work") or []}),
            "next_action": (
                f"saipen source apply-append {unprojected[0]}" if unprojected
                else "saipen continue --json"
            ),
            "error": ledger.get("error"),
        })
    return {"ok": True, "missions": missions}


__all__ = [
    "APPEND",
    "CLARIFICATION",
    "CLASSES",
    "CONFLICT",
    "DELTAS",
    "NEW_MISSION",
    "SUPERSEDE",
    "append",
    "append_status",
    "apply_append",
    "derive_normative_clauses",
    "find_append",
    "minimum_rewind",
    "pending_append_projection",
    "pending_appends",
    "read_ledger",
    "resolve_controlling_source",
]
