"""STATE frontmatter parsing -- the shared primitive."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from . import phases
from .board import strict_iso_utc
from .registry import load_registry, require_mapping, require_string_list


def _decode_single_quoted(raw: str) -> str | None:
    """Decode a SINGLE-quoted scalar exactly, or None when not quoted.

    T-1354. This writer only ever emits double quotes, so its own files always
    round-tripped and the gap stayed invisible -- until a STATE written by
    something else arrived. A real project carried `blocker: ''`, YAML's
    single-quoted empty string, and it decoded to the two-character string
    `''`, which is truthy: the shared binding brake then refused every
    consequential tool in that project with WAIT_BLOCKED, for a blocker no
    human had set and no operation could clear. An agent that could read the
    repository and do nothing else, stopped by two apostrophes.

    Single-quoted YAML has exactly one escape: a doubled apostrophe inside the
    body is one apostrophe. Nothing else is special -- no backslash escapes --
    which is why this decodes verbatim rather than approximately.
    """
    if not (len(raw) >= 2 and raw[0] == "'" and raw[-1] == "'"):
        return None
    body = raw[1:-1]
    # An odd run of apostrophes cannot be a well-formed single-quoted scalar
    # (`'''` is an opening quote, an escape half and nothing else). Refusing to
    # guess keeps a malformed scalar verbatim instead of inventing a value.
    i = 0
    out: list[str] = []
    while i < len(body):
        if body[i] == "'":
            if i + 1 < len(body) and body[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            return None
        out.append(body[i])
        i += 1
    return "".join(out)


def _decode_quoted(raw: str) -> str | None:
    """Decode a quoted scalar exactly, or None when not quoted."""
    single = _decode_single_quoted(raw)
    if single is not None:
        return single
    if not (len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"'):
        return None
    body = raw[1:-1]
    out: list[str] = []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            if nxt in ("\\", '"'):
                out.append(nxt)
                i += 2
                continue
            # an escaped character that is NOT a quote or backslash is kept
            # verbatim (backslash + char) -- the writer only ever emits
            # \\ and \", so anything else is foreign text to preserve.
            out.append(ch)
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def coerce(raw: str):
    """Coerce a frontmatter scalar: strip quotes, booleans, integers.

    Symmetric with `_render_value`: anything the writer quotes decodes back
    to the exact original string, and unquoted scalars decode to their
    natural type. A quoted `"007"` stays the string "007" (never the int
    7), and a quoted string containing `"` or `\\` round-trips exactly.
    """
    decoded = _decode_quoted(raw)
    if decoded is not None:
        return decoded
    if raw in ("true", "false"):
        return raw == "true"
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    return raw


def parse_frontmatter(text: str):
    """Parse the YAML subset STATE.md actually uses: scalar `key: value`
    lines and simple `- item` lists. Returns (dict, error-or-None).

    Strict by construction: a duplicate scalar or list key is an error, never
    a silent last-wins (a STATE with `phase: BUILD` and `phase: VERIFY` must
    not let either value hide the other). Malformed fences and unparseable
    lines are errors too -- nothing collapses to an empty dict silently.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, "no opening --- frontmatter fence"
    fields = {}
    seen: set[str] = set()
    current_list_key = None
    for lineno, line in enumerate(lines[1:], 2):
        if line.strip() == "---":
            return fields, None
        if not line.strip():
            continue
        item = re.match(r"^\s+-\s+(.*)$", line)
        if item and current_list_key:
            fields[current_list_key].append(coerce(item.group(1).strip()))
            continue
        if item:
            return None, (
                f"line {lineno}: list item {line.strip()!r} appears outside any keyed list block"
            )
        kv = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if not kv:
            return None, f"unparseable frontmatter line: {line!r}"
        key, raw = kv.group(1), kv.group(2).strip()
        if key in seen:
            return None, (
                f"line {lineno}: duplicate STATE field {key!r} (each field may appear once)"
            )
        seen.add(key)
        if raw == "":
            fields[key] = []
            current_list_key = key
        else:
            fields[key] = coerce(raw)
            current_list_key = None
    return None, "no closing --- frontmatter fence"


# ---------------------------------------------------------------------------
# The SHARED STATE contract (hostile-regression, P1): one hand-maintained
# mirror of extensions/schemas/state.schema.json lives HERE, and
# tools/validate.py cross-checks the schema against these constants so the
# engine and the gate can never drift. Required-set, enums, type map,
# minimums and the execution-intent conditionals are enforced in
# `state_contract_errors` for EVERY engine consumer (router, fast_check,
# journal reads) -- a state the release gate would FAIL must never route or
# commit as if it were green.
# ---------------------------------------------------------------------------

_REGISTRY = load_registry()
_STATE_REGISTRY = require_mapping(_REGISTRY, "state")
STATE_REQUIRED_FIELDS = require_string_list(_STATE_REGISTRY, "required_fields")

# Every property state.schema.json defines. `additionalProperties: false`
# in the schema, so an engine-read key outside this set is unknown and
# refuses -- the same FAIL the release gate raises.
STATE_KNOWN_FIELDS = frozenset(require_string_list(_STATE_REGISTRY, "known_fields"))

# CLOSED allowlist of proven OUTPUT-ONLY STATE vocabulary (T-1322). These are
# fields the engine COMPUTES and emits in the status/next/context projections,
# never canonical STATE frontmatter INPUT. A live STATE that carries one is the
# engine's own output pasted back into the input document (the W2-003 class:
# internal/public diagnostic vocabulary leaking into the wrong domain). Only
# fields whose historical semantics are PROVEN output-only belong here; the
# canonical recovery may then migrate them by exact-key removal. This set is
# the ONLY migration authority: every other unknown field stays a strict error.
#
# `parked_work` is proven: it is produced solely by
# `tools/saipen.py::_parked_work(board_tickets, state)` and consumed only by
# the status/next/context JSON payloads; every occurrence in protocol history
# is that function, a JSON payload, an evidence/backup copy, or a live STATE
# that pasted it in (SAITULS, 13.09.26) -- it is defined by no STATE schema.
STATE_OUTPUT_ONLY_FIELDS = frozenset({"parked_work"})

STATE_PHASE_ENUM = require_string_list(require_mapping(_REGISTRY, "phases"), "all")

STATE_MODE_ENUM = require_string_list(_STATE_REGISTRY, "mode_enum")

STATE_INTENT_ENUM = require_string_list(_STATE_REGISTRY, "intent_enum")

STATE_CONVERGE_TARGETS = require_string_list(_STATE_REGISTRY, "converge_targets")

STATE_STRING_FIELDS = frozenset(require_string_list(_STATE_REGISTRY, "string_fields"))

STATE_INTEGER_FIELDS = dict(require_mapping(_STATE_REGISTRY, "integer_fields"))

# RFC § 1.2's closed WAIT category set -- the seven tokens a `WAIT:` next_action
# must carry so a stop instruction is mechanically distinguishable from a real
# gate (hostile-regression, P0#1). Mirrored from tools/validate.py's WAIT_CATEGORIES.
WAIT_CATEGORIES = require_string_list(_REGISTRY, "wait_categories")

# ---------------------------------------------------------------------------
# The ONE structured WAIT parser (hostile-regression, P1#5).
#
# CORE § 1.2 states the shape exactly: `WAIT: <category> -- <one sentence>`.
# Three properties of that sentence are load-bearing and were each violated by
# the previous prefix/substring classifier:
#
#   * the DELIMITER is mandatory. A bare `WAIT: blocked` names a category and
#     asks nothing, which is the vague stop § 1.2 exists to forbid.
#   * the BODY IS ONE SENTENCE. § 1.2: "a stop instruction carrying notes is a
#     stop instruction the next agent reads as a queue". This repository's own
#     live state proved it, so the bound belongs in the shared parser rather
#     than only in the release gate.
#   * the THREE DONE brakes have FIXED wordings. An arbitrary body under a
#     legal category is NOT one of them, and a substring match on the MARKHUNT
#     phrase made any string carrying it legal -- including a non-WAIT one.
#
# Every consumer (STATE contract, router, validator, `saipen stop`) reads THIS
# parser, so a WAIT legal in one half can never be rejected by another.
# ---------------------------------------------------------------------------

# The engine's own safety-valve pause. `N waves / M tickets` is the exact
# § 2.4 wording -- unit order is fixed, so `(3 tickets / 20 tickets)` is
# nonsense and refuses. The resume key is UNIFORM (T-###): `cc` (continue /
# bare saipen) resumes BOTH a goal run (reauthorizing a tripped valve by
# resetting both counters) and a converge run. `saipen goal` is never a
# resume key -- it is the create/pivot command, so a pause that named it
# would substitute the objective instead of continuing it.
_SAFETY_VALVE_RE = re.compile(
    r"^safety valve reached \((\d+) waves / (\d+) tickets\) -- "
    r"run 'cc' to continue$"
)

# The untriaged-MARKHUNT brake, verbatim from CORE § 1.2 / phases/done.md.
# Anchored: the phrase alone never makes a string legal.
MARKHUNT_BRAKE = (
    "WAIT: blocked -- untriaged MARKHUNT findings in ## BLOCKED; triage into ## TODO or dismiss"
)

# The § 1.2 progress tag: a single trailing bracketed suffix, informational
# only, never part of the sentence.
_PROGRESS_TAG_RE = re.compile(r"\s*\[[^\]]*\]\s*$")

# A second sentence begins at a period followed by whitespace and then a
# capital or a backtick, so `v7.176.0` and a lowercase "e.g." do not trip it
# while genuine handoff prose does. Identical to the release gate's rule --
# that is the point of sharing it.
_SECOND_SENTENCE_RE = re.compile(r"\.\s+(?=[A-Z`])")


def _wait_body(na: str) -> str:
    """The § 1.2 sentence of a `WAIT:` string, progress tag stripped."""
    return _PROGRESS_TAG_RE.sub("", na.strip()[len("WAIT:") :].strip())


def wait_grammar_error(na: object) -> str | None:
    """Why `na` is NOT a legal WAIT, or None when it is legal.

    The single authority for the closed grammar. Callers that only need the
    verdict use `parse_wait` / `is_legal_wait`; the STATE contract uses this
    so its refusal names the exact rule that was broken.
    """
    if not isinstance(na, str):
        return "next_action is not a string"
    text = na.strip()
    if not text.startswith("WAIT:"):
        return "not a WAIT: action"
    body = _wait_body(text)
    if not body:
        return (
            "carries no category and no question -- CORE § 1.2 requires "
            "'WAIT: <category> -- <one sentence>'"
        )
    if "\n" in body:
        return "spans more than one line"
    if _SAFETY_VALVE_RE.match(body):
        return None
    head, sep, tail = body.partition(" -- ")
    if not sep:
        return (
            f"has no ' -- ' delimiter: a bare category names the KIND of "
            f"stop and asks nothing, which CORE § 1.2 forbids "
            f"(got {body!r})"
        )
    if head.strip().lower() not in WAIT_CATEGORIES:
        return (
            f"opens with {head.strip()!r}, which is not one of the closed "
            f"§ 1.2 categories {'/'.join(WAIT_CATEGORIES)}"
        )
    sentence = tail.strip()
    if not sentence:
        return "has an empty question after ' -- '"
    second = _SECOND_SENTENCE_RE.search(sentence)
    if second:
        return (
            f"body starts a second sentence at offset {second.start()} -- "
            f"CORE § 1.2 bounds it to one; session status belongs in "
            f".saipen/kitchen/digest.md and queued work on BOARD.md"
        )
    return None


def parse_wait(na: object) -> str | None:
    """The lowercased § 1.2 category of a legal WAIT, else None.

    Legal forms, and ONLY these:
      * `WAIT: <category> -- <one sentence>`, category one of the closed seven;
      * the exact intent-aware safety-valve pause the engine itself emits.
    """
    if wait_grammar_error(na) is not None:
        return None
    body = _wait_body(str(na).strip())
    if _SAFETY_VALVE_RE.match(body):
        return "safety valve"
    return body.partition(" -- ")[0].strip().lower()


def is_legal_wait(na: object) -> bool:
    """True when `na` is a legal WAIT under the closed § 1.2 grammar."""
    return parse_wait(na) is not None


def safety_valve_resume_key(na: object) -> str | None:
    """The resume command an exact safety-valve pause names, else None.

    The resume key is UNIFORM: every safety-valve pause names `cc` (continue /
    bare `saipen`), which reauthorizes a tripped valve and resumes the run for
    BOTH goal and converge intents. `saipen goal` is the create/pivot command,
    never a resume key, so a pause naming it is not a legal safety-valve pause
    here.
    """
    if not isinstance(na, str) or not na.strip().startswith("WAIT:"):
        return None
    match = _SAFETY_VALVE_RE.match(_wait_body(na.strip()))
    return "cc" if match else None


# The exactly THREE brakes CORE § 1.2 permits at `phase: DONE` with an empty
# `## TODO`. Every other category there names a question about work in flight,
# and there is none -- § 1.11's UNBLOCK exception orders an auto-transition
# instead of a stop.
DONE_EMPTY_BRAKES = ("safety valve", "user brake", "markhunt")


def binding_wait(
    na: object, *, phase: object = None, empty_todo: bool = False, intent: object = None
) -> str | None:
    """Does this WAIT actually BIND in this context? The brake name, or None.

    CONTEXTUAL by construction (hostile-regression, P1#5): the router, the
    release gate and `saipen stop` must agree on when a persisted WAIT is a
    real stop, and CORE narrows the answer by context rather than by wording
    alone.

      * anywhere else: every legal WAIT binds -- a user brake is a stop with
        one hundred workable tickets.
      * `phase: DONE` + empty `## TODO`: exactly the three fixed forms bind
        (`safety valve`, `user brake`, the untriaged-MARKHUNT brake). The
        safety valve must name the uniform resume key `cc`, since a pause
        telling the user to run `saipen goal` sends them to a NEW objective
        instead of continuing this one (T-###).

    Returns the brake name from `DONE_EMPTY_BRAKES` in the narrowed context,
    the § 1.2 category elsewhere, and None when the WAIT does not bind.
    """
    category = parse_wait(na)
    if category is None:
        return None
    if not (phase == "DONE" and empty_todo):
        return category
    text = str(na).strip()
    if category == "safety valve":
        key = safety_valve_resume_key(text)
        return "safety valve" if key == "cc" else None
    if _PROGRESS_TAG_RE.sub("", text) == MARKHUNT_BRAKE:
        return "markhunt"
    if category == "user brake":
        return "user brake"
    return None


def binding_brake(state: dict, *, empty_todo: bool = False) -> tuple[str, str] | None:
    """The ONE authoritative hard-stop truth (T-1322).

    Both the continuation router (`router.route_next`) and the mutation
    admission guard (`admission.protocol_snapshot`) consume THIS function, so
    `continue` and a consequential tool can never disagree about whether the
    project is runnable or WAIT/BLOCKED.

    A hard stop is present when ANY of these holds:

      * `phase == "BLOCKED"`;
      * `blocker` is a non-empty, non-`none` value -- the persisted binding
        brake the admission guard has always honoured. The router used to
        ignore it, which is exactly how a STATE like SCOUT + an EXTERNAL
        `blocker` routed as runnable while the guard refused the mutation
        (the AUDAPACK disagreement);
      * `next_action` is a WAIT that BINDS in this exact context
        (`binding_wait`), preserving CORE's DONE + empty-TODO UNBLOCK
        exception rather than stopping on every `WAIT:` prefix.

    Returns `(kind, detail)` where `kind` is `"wait"` for a binding persisted
    WAIT, `"blocker"` for a non-empty STATE.blocker, and `"blocked"` for
    `phase: BLOCKED`; returns None when no brake binds.
    """
    phase = str(state.get("phase") or "")
    blocker = str(state.get("blocker") or "").strip()
    na = str(state.get("next_action") or "")
    if phase.upper() == "BLOCKED":
        return (
            "blocked",
            f"phase BLOCKED: blocker={blocker!r} next_action={na[:60]!r}",
        )
    if blocker and blocker.lower() != "none":
        return (
            "blocker",
            f"binding WAIT/BLOCKED state: blocker={blocker!r} "
            f"next_action={na[:60]!r}",
        )
    if na.startswith("WAIT:") and binding_wait(
        na,
        phase=phase,
        empty_todo=empty_todo,
        intent=state.get("execution_intent"),
    ):
        return ("wait", f"persisted WAIT binds in this context: {na[:60]!r}")
    return None


_STYLE_TOKEN_RE = re.compile(r"`style_contract:\s*(ded-[0-9a-f]{8})`")


def style_contract_token(text: str) -> str:
    """The installed STYLE.md voice marker, computed from the file minus its own
    declaration line (RFC § 1.2)."""
    body = "\n".join(
        ln for ln in text.replace("\r\n", "\n").split("\n") if "style_contract:" not in ln
    ).strip()
    return "ded-" + hashlib.sha256(body.encode("utf-8")).hexdigest()[:8]


# ---------------------------------------------------------------------------
# THE RUNNING INSTALLATION IS AUTHORITATIVE (hostile-regression, P0#3).
#
# VERSION, the STATE schema revision and the STYLE.md voice marker are
# properties of the SAIPEN install that is EXECUTING, not of whatever path a
# previous agent happened to persist in `STATE.saipen_home`. Reading them
# through that pointer made every one of them fail OPEN: a stale or dead home
# returned None, and `None` meant "skip the check" -- so deleting
# `style_contract` or `last_event` from a schema-v3 state passed validation
# because the pointer no longer resolved.
#
# The persisted pointer is still validated -- separately, as the bootloader
# binding it is (see `persisted_home_error`) -- but it never decides what the
# contract SAYS.
# ---------------------------------------------------------------------------


def running_home() -> Path:
    """The SAIPEN home of the RUNNING installation (this module's own tree)."""
    return Path(__file__).resolve().parents[2]


def _read_running(*parts: str) -> str | None:
    path = running_home().joinpath(*parts)
    try:
        return path.read_text(encoding="utf-8-sig")
    except OSError:
        return None


def running_protocol_major() -> int | None:
    """The MAJOR component of the running install's own `VERSION` (§ 1.2)."""
    text = _read_running("VERSION")
    if text is None:
        return None
    match = re.match(r"v?(\d+)\.", text.strip())
    return int(match.group(1)) if match else None


def running_schema_version() -> int | None:
    """The running install's `x-current-schema-version` (§ 1.2).

    The STATE schema file is authoritative for the STATE file-format revision;
    the protocol major (`saipen_version`) is a different axis and must not
    decide it.
    """
    text = _read_running("extensions", "schemas", "state.schema.json")
    if text is None:
        return None
    try:
        value = json.loads(text).get("x-current-schema-version")
    except ValueError:
        return None
    return int(value) if isinstance(value, int) else None


def running_style_token() -> str | None:
    """The running install's STYLE.md voice marker (§ 1.2)."""
    text = _read_running("saipen", "STYLE.md")
    if text is None:
        text = _read_running("STYLE.md")
    return style_contract_token(text) if text is not None else None


def installed_style_token(saipen_home: object = None) -> str | None:
    """The STYLE.md marker every STATE is judged against.

    `saipen_home` is accepted and IGNORED: the running installation owns the
    voice contract. A state written against a home that no longer resolves is
    still judged, because the check exists to prove the writing agent read the
    CURRENT contract -- and "the pointer is stale" is not evidence that it did.
    """
    return running_style_token()


def state_contract_errors(
    fields: dict, *, style_token: str | None = None, current_schema_version: int | None = None
) -> list[str]:
    """Verify exact presence/type/shape of core STATE schema against the
    protocol -- the SHARED implementation the release gate mirrors.

    ONE canonical STATE semantic validator (hostile-regression, P0#1): engine
    consumers (router, fast_check, journal reads), the fast gate and the
    release gate ALL refuse a state the others would accept. It mirrors
    state.schema.json's interpreted subset (required, enum, type, minimum,
    additionalProperties, if/then) plus the delegated execution-intent
    conditionals AND the in-memory RFC checks that must not drift between the
    engine and the validator:

      * non-INIT `transition_from` presence,
      * `phases.transition_legal`-equivalent transition pairs (the block-parked
        DONE shape is accepted here; the LOG-evidence proof is the validator's
        cross-file concern and stays there),
      * ISO-8601 UTC `updated`,
      * closed WAIT category grammar,
      * exact `style_contract` against the installed STYLE.md marker.

    A future schema_version is NOT an error here -- the validator WARNS on it to
    keep the schema-bump workflow alive, and so do we. `style_token` /
    `current_schema_version`, when supplied, enable the style_contract checks;
    callers without an installed home (legacy `saipen_home: ""`) omit them and
    the check is skipped rather than guessed.
    """
    errors = []
    for key in STATE_REQUIRED_FIELDS:
        if key not in fields:
            errors.append(f"missing required field {key}")
    for key in fields:
        if key not in STATE_KNOWN_FIELDS:
            errors.append(
                f"unknown STATE field {key!r} -- state.schema.json "
                "does not define it (retired or misspelled?)"
            )
            continue
        if key in STATE_STRING_FIELDS and not isinstance(fields[key], str):
            errors.append(f"{key} must be a string")
    phase = fields.get("phase")
    if phase is not None and (not isinstance(phase, str) or phase not in STATE_PHASE_ENUM):
        errors.append(f"phase {phase!r} not one of {'|'.join(STATE_PHASE_ENUM)}")
    att = fields.get("attempt")
    if att is not None:
        if not isinstance(att, str) or not re.fullmatch(r"A-\d{3,}", att):
            errors.append(
                f"attempt {att!r} is not an A-### id -- the STATE attempt "
                "pointer names one open Attempt episode"
            )
    tf = fields.get("transition_from")
    if tf is not None and (not isinstance(tf, str) or tf not in STATE_PHASE_ENUM):
        errors.append(f"transition_from {tf!r} not one of {'|'.join(STATE_PHASE_ENUM)}")
    mode = fields.get("mode")
    if mode is not None and (not isinstance(mode, str) or mode not in STATE_MODE_ENUM):
        errors.append(f"mode {mode!r} not one of {'|'.join(STATE_MODE_ENUM)}")
    intent = fields.get("execution_intent")
    if intent is not None and (not isinstance(intent, str) or intent not in STATE_INTENT_ENUM):
        errors.append(f"execution_intent {intent!r} not one of {'|'.join(STATE_INTENT_ENUM)}")
    target = fields.get("converge_target")
    if target is not None and (not isinstance(target, str) or target not in STATE_CONVERGE_TARGETS):
        errors.append(f"converge_target {target!r} not one of {'|'.join(STATE_CONVERGE_TARGETS)}")
    gate = fields.get("improve_gate")
    if gate is not None and (not isinstance(gate, str) or not re.fullmatch(r"T-\d+", gate)):
        errors.append(
            f"improve_gate {gate!r} is not a T-### id -- the hold names one gate ticket"
        )
    for key, minimum in STATE_INTEGER_FIELDS.items():
        value = fields.get(key)
        if value is None:
            continue
        if not isinstance(value, int) or isinstance(value, bool):
            errors.append(f"{key} must be an integer")
        elif minimum is not None and value < minimum:
            errors.append(f"{key} {value!r} is below the schema minimum {minimum}")
    requires = fields.get("requires")
    if requires is not None:
        if not isinstance(requires, list):
            errors.append("requires must be an array")
        elif any(not isinstance(item, str) for item in requires):
            errors.append("requires items must be strings")
    gm = fields.get("goal_mode")
    if gm is not None and not isinstance(gm, bool):
        errors.append("goal_mode must be a boolean")
    # Execution-intent family conditionals (schema if/then + § 2.4 delegated
    # checks): goal requires its counters; converge requires its target and
    # forbids goal counters; every other intent forbids both families.
    if intent == "goal":
        for key in ("goal_waves", "goal_tickets"):
            if key not in fields:
                errors.append(f"execution_intent goal requires {key}")
        if "converge_target" in fields:
            errors.append("execution_intent goal with converge_target")
    elif intent == "converge":
        if "converge_target" not in fields:
            errors.append("execution_intent converge requires converge_target")
        for key in ("goal_waves", "goal_tickets"):
            if key in fields:
                errors.append(f"execution_intent converge with {key}")
    elif intent in (None, "normal"):
        for key in ("goal_waves", "goal_tickets"):
            if key in fields:
                errors.append(f"non-goal execution_intent with {key}")
        if "converge_target" in fields:
            errors.append("non-converge execution_intent with converge_target")
    # --- Canonical STATE truth shared by engine, fast gate and release validator
    # (hostile-regression, P0#1). In-memory only; the cross-file checks (block-
    # parked LOG proof, vague next_action) stay in the validator.
    tf = fields.get("transition_from")
    ph = fields.get("phase")
    if ph is not None and ph != "INIT":
        if tf is None:
            errors.append(
                "missing transition_from -- required on all non-INIT "
                "states to validate phase transitions (RFC § 1.6)"
            )
        elif isinstance(tf, str):
            if tf not in phases.VALID_TRANSITIONS and tf not in phases.ANY_FROM:
                errors.append(
                    f"transition_from {tf!r} not one of the 16 phase enum values (RFC § 1.6)"
                )
            elif ph != tf and ph not in phases.ANY_FROM:
                allowed = list(phases.VALID_TRANSITIONS.get(tf, []))
                # Block-parked transitional shape: an active-ticket `ticket
                # block` parks execution at DONE with transition_from set to the
                # mid-flight phase (RFC § 1.6 narrow exception). The engine
                # accepts the shape; the validator adds the LOG-evidence proof.
                if not (
                    ph == "DONE"
                    and (
                        tf in ("SCOUT", "BUILD", "VERIFY", "REVIEW", "SHIP")
                        or tf == "HUNT"
                    )
                ):
                    if ph not in allowed:
                        errors.append(
                            f"invalid phase transition: {tf} -> {ph} (RFC § 1.6). "
                            f"Allowed from {tf}: {', '.join(allowed)}"
                        )
    updated = fields.get("updated")
    if isinstance(updated, str):
        # ONE shared strict-UTC parser (hostile-regression, P1#7). The regex
        # copy this replaced proved only the SHAPE, so the impossible
        # `2026-99-99T25:61:61Z` passed and Recovery's staleness comparison
        # silently lost its clock evidence. `board.strict_iso_utc` proves the
        # instant: real date, real time, T separator, zero offset.
        if not strict_iso_utc(updated):
            errors.append(
                f"updated must be ISO-8601 UTC (Z or +00:00) naming a REAL "
                f"instant, got {updated!r} -- Recovery miscompares staleness "
                f"across timezones otherwise (RFC § 1.2)"
            )
    na = fields.get("next_action")
    if isinstance(na, str) and na.strip().startswith("WAIT:"):
        # THE structured § 1.2 grammar via the ONE shared parser
        # (hostile-regression, P1#5): `WAIT: <category> -- <one sentence>`.
        # The delimiter, the closed category and the one-sentence bound are all
        # mandatory, and the parser names which one was broken.
        problem = wait_grammar_error(na)
        if problem is not None:
            errors.append(
                f"next_action is a malformed WAIT (a WAIT with no category "
                f"token, no ' -- ' delimiter or more than one sentence is "
                f"never legal) -- CORE § 1.2 requires 'WAIT: <category> -- "
                f"<one sentence>' where category is one of "
                f"{'/'.join(WAIT_CATEGORIES)} (or the exact safety-valve "
                f"pause); it {problem}"
            )
    # § 1.2 VERSION GUARD: a state written by a NEWER protocol than the one
    # running cannot be interpreted by it -- the running install does not know
    # the rules that state was written under. The guard is one-directional:
    # older states are readable legacy, newer ones refuse.
    running_major = running_protocol_major()
    project_major = fields.get("saipen_version")
    if (
        running_major is not None
        and isinstance(project_major, int)
        and not isinstance(project_major, bool)
        and project_major > running_major
    ):
        errors.append(
            f"saipen_version {project_major} is newer than the running SAIPEN "
            f"protocol major {running_major} -- this install cannot interpret "
            f"a state written by a later protocol (RFC § 1.2 version guard)"
        )
    if style_token is not None:
        sc = fields.get("style_contract")
        if sc is not None and sc != style_token:
            errors.append(
                f"style_contract {sc!r} does not match the installed STYLE.md "
                f"marker {style_token!r} -- the agent that wrote this checkpoint "
                f"did not read the current voice contract (RFC § 1.2)"
            )
        elif (
            current_schema_version is not None
            and fields.get("schema_version") == current_schema_version
            and sc is None
        ):
            errors.append(
                f"schema_version {current_schema_version} requires "
                f"style_contract: {style_token} (RFC § 1.2)"
            )
    return errors


def _current_schema_version(home: object = None) -> int | None:
    """The ONE schema-revision source: the RUNNING install's
    `x-current-schema-version` (hostile-regression, P0#3).

    `home` is accepted and IGNORED for call-site compatibility. Reading the
    revision through the persisted pointer let a dead home return None, and a
    None revision switched off the schema-v3 `style_contract` and `last_event`
    requirements entirely -- the checks failed open exactly where the state was
    least trustworthy.
    """
    return running_schema_version()


# ---------------------------------------------------------------------------
# The persisted bootloader pointer, validated as a POINTER (P0#3).
# ---------------------------------------------------------------------------

# The layout that makes a directory a LOADABLE SAIPEN home: the cold-start
# kernel plus the sub protocol the bootloader needs. Identical to the contract
# `crew._home_problem_for` proves for sync availability -- one liveness
# definition, two entry points.
#
# VERSION is deliberately NOT required here: the RUNNING install owns
# VERSION/schema/STYLE (P0#3), so demanding it from the persisted pointer would
# re-introduce the same fail-open coupling from the other side. `rebind-home`
# does demand a readable, major-compatible VERSION from its explicit candidate,
# because that candidate is being adopted as the install to load FROM.
HOME_LAYOUT_MARKERS = (("extensions", "subs", "PROTOCOL.md"),)

# Windows drive qualification with a separator: `C:\...` or `C:/...`.
_DRIVE_ABS_RE = re.compile(r"^[A-Za-z]:[/\\]")
# UNC share: `\\server\share...` (or the forward-slash twin `//server/...`).
# T-1010: also match the decoded form `\server\share` where the frontmatter
# parser has reduced `\\` to `\` -- a single leading backslash followed by
# non-separator characters is a decoded UNC pointer on POSIX.
_UNC_ABS_RE = re.compile(r"^(?:\\\\|//|\\)[^/\\]+")


def is_absolute_home(value: object) -> bool:
    """One cross-platform absolute-path classifier for `STATE.saipen_home`
    (T-1010).

    `Path.is_absolute()` is HOST-NATIVE: on POSIX a Windows drive or UNC
    pointer (`C:\\saipen`, `\\\\server\\share`) reads as a RELATIVE path, so
    a foreign-OS absolute home is misclassified as legacy -- and a dead
    protocol home then passes the liveness gate plus ordinary mutation
    instead of forcing `saipen rebind-home`. This classifier recognizes all
    three portable absolute syntaxes on every host:
      - POSIX absolute: leading `/`;
      - Windows drive-absolute: `C:` followed by a separator;
      - UNC share: `\\\\host\\share` or `//host/share`.
    It is a pure string classification, deliberately -- the same verdict on
    every host, so a foreign-OS pointer is dead in exactly the same way
    wherever the checkpoint is read.
    """
    if value is None:
        return False
    text = str(value).strip()
    if not text:
        return False
    return text.startswith("/") or bool(_DRIVE_ABS_RE.match(text)) or bool(_UNC_ABS_RE.match(text))


def persisted_home_error(home: object) -> str | None:
    """Why `STATE.saipen_home` is DEAD, or None when it is usable/unverifiable.

    A pointer is judged only when it is ABSOLUTE: that is the form CORE § 1.2
    defines ("the absolute path to the SAIPEN home on the machine that last
    checkpointed"), and it is the only form a later agent can resolve. An
    absent, empty or relative value carries no machine-local binding at all, so
    it is legacy/unverifiable -- reported as usable here and left to the
    release gate, exactly like a pre-v7.25.0 state with no pointer.

    A DEAD absolute pointer is not a warning: the bootloader cannot load the
    protocol it names, so ordinary mutation must refuse and `saipen
    rebind-home` is the one operation allowed to repair it.
    """
    if home is None or not str(home).strip():
        return None
    text = str(home).strip()
    path = Path(text)
    if not is_absolute_home(text):
        return None
    if not path.is_dir():
        return f"STATE.saipen_home {text!r} does not resolve to a directory on this machine"
    if not ((path / "saipen" / "BOOT.md").is_file() or (path / "BOOT.md").is_file()):
        return (
            f"STATE.saipen_home {text!r} has no saipen/BOOT.md -- the "
            f"cold-start kernel is not there"
        )
    missing = [
        Path(*parts).as_posix()
        for parts in HOME_LAYOUT_MARKERS
        if not path.joinpath(*parts).is_file()
    ]
    if missing:
        return (
            f"STATE.saipen_home {text!r} is missing "
            f"{', '.join(missing)} -- not a usable SAIPEN install"
        )
    return None


def parse_state_or_error(text: str):
    """Strict STATE read for authorization/routing consumers.

    Returns (fields, None) for a valid or absent (empty) STATE, and
    (None, error) for a PRESENT but malformed STATE. Read models must never
    treat a corrupt non-empty STATE as the empty dict `{}`: that is exactly
    how a duplicate-key or broken-fence STATE launders itself into a green
    routing decision (T-1003 hostile findings). The shared canonical STATE
    validator runs here too, so a state the release gate would FAIL cannot
    route or COMMIT as if it were green (hostile-regression, P0#1).
    """
    if not text or not text.strip():
        return {}, None
    fields, error = parse_frontmatter(text)
    if fields is None:
        return None, error
    # The RUNNING install answers the schema/version questions
    # (hostile-regression, P0#3): the schema revision and the protocol major
    # are properties of the executing install, never the persisted pointer.
    # The STYLE.md voice contract is authoritative too, but ONLY for this
    # install's OWN project state -- a state whose `saipen_home` resolves to
    # the running install. Foreign-home and empty/relative (legacy/sub) states
    # keep their bootloader pointer as their own contract concern: enforcing
    # the running install's voice on a sub-instance or another project would
    # reject legitimate foreign-style states and break sub collection, while
    # the dead-pointer case is caught separately by the persisted-home gate.
    # Deleting `style_contract` from a state that THIS install owns still fails.
    home = fields.get("saipen_home")
    style_token = None
    # T-1010: the same cross-platform absolute classifier the liveness gate
    # uses -- a foreign-OS absolute pointer must never read as legacy-relative
    # here and silently skip the running-install ownership check.
    if (
        home
        and str(home).strip()
        and is_absolute_home(home)
        and Path(str(home)).resolve() == running_home()
    ):
        style_token = running_style_token()
    contract_errors = state_contract_errors(
        fields, style_token=style_token, current_schema_version=running_schema_version()
    )
    if contract_errors:
        return None, "; ".join(contract_errors)
    return fields, None


def parse_state(text: str) -> dict:
    """Return the STATE field dict; surrogate CORRUPT on invalid STATE."""
    if not text or not text.strip():
        return {}
    fields, _error = parse_frontmatter(text)
    if fields is None:
        return {"phase": "CORRUPT", "corrupt_detail": _error}
    contract_errors = state_contract_errors(fields)
    if contract_errors:
        return {"phase": "CORRUPT", "corrupt_detail": "; ".join(contract_errors)}
    return fields


def _render_value(value) -> str:
    """Render one owned scalar in the frontmatter subset STATE uses.

    Bijective with `coerce`: a string is quoted exactly when leaving it
    bare would change its type (numeric-looking, boolean-looking, empty) or
    when it contains characters the parser would misread (spaces, colons,
    quotes, backslashes, specials). The same renderer is applied to list
    items, so a list item can never silently become an int/bool either.
    """
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, (list, tuple)):
        return None  # caller renders lists as blocks
    text = str(value)
    if text == "":
        return '""'
    would_retype = re.fullmatch(r"-?\d+", text) is not None or text in ("true", "false")
    needs_quote = (
        would_retype
        or any(c in text for c in ":,[]{}&*!|>'\"%@`")
        or text != text.strip()
        or any(c.isspace() for c in text)
    )
    if needs_quote:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def patch_state(text: str, owned: dict) -> str:
    """Return the STATE frontmatter with ONLY the owned keys changed.

    Every unowned field keeps its value, line and order. Keys already present
    are rewritten in place; new owned keys are inserted before the closing
    `---`. List values are rendered as a `key:` block with `- item` lines and
    replace the original block (including any prior list items). Unknown but
    schema-valid future fields are preserved byte-for-byte.
    """
    if not text or not text.startswith("---"):
        raise ValueError("STATE has no opening --- frontmatter fence")
    fields, parse_error = parse_frontmatter(text)
    if fields is None:
        raise ValueError(f"state-malformed: {parse_error}")
    lines = text.split("\n")
    close = None
    for idx, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            close = idx
            break
    if close is None:
        raise ValueError("STATE has no closing --- frontmatter fence")

    # Everything after the closing fence (the BOUNDARY instruction comment and
    # any other trailing prose) is preserved byte-for-byte: a STATE rewriter
    # owns only the frontmatter, never the post-fence body (T-1003 / hostile
    # ticket P0#2). The shipped TEMPLATE and live sub STATE carry a mandatory
    # BOUNDARY marker there; discarding it on spawn/update is a silent
    # contract violation.
    suffix = "\n".join(lines[close:])

    body = lines[1:close]
    pending = dict(owned)
    out: list[str] = []
    index = 0
    _list_key_re = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*):\s*$")

    def emit_block(key: str, value) -> None:
        if isinstance(value, (list, tuple)):
            out.append(f"{key}:")
            for item in value:
                # THE SAME scalar codec as scalar fields: a list item that
                # looks numeric/boolean must be quoted so it parses back as
                # the string it was written as (T-1003 bijectivity).
                out.append(f"  - {_render_value(item)}")
        else:
            out.append(f"{key}: {_render_value(value)}")

    while index < len(body):
        line = body[index]
        _stripped = line.strip()
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        is_list_item = bool(re.match(r"^\s+-\s+", line))
        if match and match.group(1) in pending:
            key = match.group(1)
            value = pending.pop(key)
            if isinstance(value, (list, tuple)):
                emit_block(key, value)
                index += 1
                while index < len(body) and re.match(r"^\s+-\s+", body[index]):
                    index += 1
                continue
            out.append(f"{key}: {_render_value(value)}")
            index += 1
            continue
        if is_list_item:
            # A preserved list item: keep it and its block intact.
            out.append(line)
            index += 1
            continue
        out.append(line)
        index += 1

    for key, value in pending.items():
        emit_block(key, value)

    # `suffix` already begins with the closing `---` fence, so the post-fence
    # body (BOUNDARY marker, etc.) is restored exactly as it was read.
    return "---\n" + "\n".join(out) + "\n" + suffix


def remove_state_fields(text: str, keys) -> str:
    """Remove exact frontmatter fields, including their list items.

    Intent-family transitions need absence, not an empty scalar: goal counters
    left behind as `""` are still fields from the wrong schema family.
    """
    if not text or not text.startswith("---"):
        raise ValueError("STATE has no opening --- frontmatter fence")
    fields, parse_error = parse_frontmatter(text)
    if fields is None:
        raise ValueError(f"state-malformed: {parse_error}")
    remove = set(keys)
    lines = text.split("\n")
    close = next((i for i, line in enumerate(lines[1:], 1) if line.strip() == "---"), None)
    if close is None:
        raise ValueError("STATE has no closing --- frontmatter fence")
    # Preserve the post-fence body (BOUNDARY marker) exactly (T-1003 / P0#2).
    suffix = "\n".join(lines[close:])
    out = []
    index = 1
    while index < close:
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", lines[index])
        if match and match.group(1) in remove:
            list_field = match.group(2).strip() == ""
            index += 1
            if list_field:
                while index < close and re.match(r"^\s+-\s+", lines[index]):
                    index += 1
            continue
        out.append(lines[index])
        index += 1
    return "---\n" + "\n".join(out) + "\n" + suffix


def transition_execution_intent(
    text: str,
    intent: str,
    converge_target: str | None = None,
    goal_waves: int = 0,
    goal_tickets: int = 0,
) -> str:
    """Apply one complete execution-intent family transition.

    Every transition first removes fields owned by all intent families, then
    introduces only target-family fields. Callers cannot accidentally retain
    goal counters in converge state or a converge target in normal state.
    """
    if intent not in ("normal", "goal", "converge"):
        raise ValueError(f"execution_intent {intent!r} outside closed enum")
    if intent == "converge" and converge_target not in ("done", "ship", "crew"):
        raise ValueError("converge intent requires target done|ship|crew")
    if intent != "converge" and converge_target is not None:
        raise ValueError("converge_target is legal only for converge intent")
    if goal_waves < 0 or goal_tickets < 0:
        raise ValueError("goal counters must be non-negative")

    clean = remove_state_fields(
        text, ("execution_intent", "goal_mode", "goal_waves", "goal_tickets", "converge_target")
    )
    owned = {"execution_intent": intent}
    if intent == "goal":
        owned.update({"goal_waves": goal_waves, "goal_tickets": goal_tickets})
    elif intent == "converge":
        owned["converge_target"] = converge_target
    result = patch_state(clean, owned)
    parsed = parse_state(result)
    family = {key for key in ("goal_waves", "goal_tickets", "converge_target") if key in parsed}
    expected = (
        {"goal_waves", "goal_tickets"}
        if intent == "goal"
        else {"converge_target"}
        if intent == "converge"
        else set()
    )
    if family != expected:
        raise ValueError(f"intent transition produced fields {family}, expected {expected}")
    return result


def patch_owned_text(original: str, state: dict, owned: dict) -> str:
    """Patch `original` STATE text using `owned`; convenience wrapper that
    guarantees the result re-parses with every non-owned key preserved."""
    return patch_state(original, owned)
