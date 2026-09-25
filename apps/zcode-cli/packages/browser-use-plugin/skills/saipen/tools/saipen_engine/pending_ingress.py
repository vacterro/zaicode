"""The operator's own words survive the refusal that names their transport.

MEASURED, not imagined (T-1372, field run 2026-09-16). A routed model was
refused on a 520-byte, 12-line request -- the payload cannot survive one quoted
shell argument -- and was handed the exact transport that carries it:
``saipen start --file <path>``. It started a 179-byte paraphrase of its own
instead. The receipt that came out asserted mode ``exact`` with
``original_available`` true and a body digest matching its own meta, so it was
internally consistent, and BOARD title, coverage, closure and every downstream
gate read green over text the operator never wrote.

The defect class this ends: **a refusal that says which command to run next,
but not which BYTES that command owes.** Nothing compared what arrived with
what was refused, so rewording the request was the cheapest way past the gate.
`BOOT.md` already says "Never reword the user's task to get past a refusal";
this module is the measurement that makes the sentence enforceable.

The obligation lives in ``.saipen/recovery/`` because it is exactly what that
namespace is for: one operation in flight on this machine. It is deliberately
NOT canonical ledger state -- it is never exported, never archived, and it
outlives nothing but the next ingress.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

#: `.saipen/recovery/` is non-exportable and machine-local by contract; the
#: obligation belongs there and nowhere in the canonical ledger.
PENDING_REL = ("recovery", "pending-ingress.json")

SCHEMA_VERSION = 1

#: A pending obligation is about the NEXT ingress, not about the project's
#: life. Past this age the record is stale: the session that earned it is gone,
#: and holding a later operator to bytes nobody remembers refusing would be the
#: deadlock this module must not create.
MAX_AGE_SECONDS = 24 * 60 * 60

CODE_PARAPHRASE = "INGRESS_PARAPHRASE_REFUSED"
CODE_UNREADABLE = "INGRESS_PENDING_UNREADABLE"

#: The exact flag an operator uses to say the request itself changed.
SUPERSEDE_FLAG = "--supersede-ingress"


def pending_path(root: Path | str) -> Path:
    return Path(root).joinpath(".saipen", *PENDING_REL)


def ingress_digest(text: str) -> str:
    """One digest for one request, whatever transport spelled it.

    The shell payload carried `\\n` and no trailing newline; the file a host
    write tool produces carries `\\r\\n` and usually one. Those are the same
    request, and a digest that disagreed would refuse the operator's own bytes
    for arriving by the route the refusal demanded. Line endings and the outer
    whitespace are normalized; nothing inside the text is.
    """
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _age_seconds(stamp: Any) -> float | None:
    if not isinstance(stamp, str):
        return None
    try:
        recorded = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - recorded).total_seconds()


def record(root: Path | str, payload: str, route: str) -> dict:
    """Remember which bytes a transport refusal refused. Never raises.

    The guard is a classifier: a failure to persist this obligation must not
    turn a refusal that was about transport into a crash about disk. A record
    that could not be written simply leaves the project where it was before.
    """
    root = Path(root)
    normalized = payload.replace("\r\n", "\n").replace("\r", "\n").strip()
    entry = {
        "schema_version": SCHEMA_VERSION,
        "digest": ingress_digest(payload),
        "bytes": len(normalized.encode("utf-8")),
        "route": route,
        "recorded": _now(),
        "preview": normalized[:160],
    }
    path = pending_path(root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        from .paths import safe_atomic_write_bytes

        safe_atomic_write_bytes(
            path,
            (json.dumps(entry, indent=2, ensure_ascii=False) + "\n").encode("utf-8"),
            kind="pending ingress",
            ownership_root=root,
        )
    except (OSError, ValueError):
        return {**entry, "recorded_to_disk": False}
    return {**entry, "recorded_to_disk": True}


def pending(root: Path | str) -> dict | None:
    """The obligation this project owes its next ingress, or None.

    An unreadable record returns ``{"malformed": True}`` rather than None: an
    obligation nobody can read is not an obligation nobody has, and silently
    treating it as absent would restore exactly the hole this module closes.
    A record older than ``MAX_AGE_SECONDS`` is stale and is not enforced.
    """
    path = pending_path(root)
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError) as exc:
        return {"malformed": True, "detail": str(exc)}
    try:
        entry = json.loads(raw)
    except ValueError as exc:
        return {"malformed": True, "detail": str(exc)}
    if not isinstance(entry, dict) or not isinstance(entry.get("digest"), str):
        return {"malformed": True, "detail": "record declares no digest"}
    age = _age_seconds(entry.get("recorded"))
    if age is None:
        return {"malformed": True, "detail": "record declares no readable timestamp"}
    if age > MAX_AGE_SECONDS:
        return None
    return entry


def request_bytes(recorded: str) -> str:
    """The REQUEST inside an ingress line, without the shell tail around it.

    The deadlock this ends, reproduced from a consumer project on 2026-09-22.
    The guard recorded the whole remainder of::

        saipen start '<task>' --json 2>&1 | Out-String -Width 600

    as the refused payload -- 128 bytes, quotes, flag, redirect and pipe
    included -- because the quote-stripping only fired when the ENTIRE
    remainder was quoted. The obligation then demanded bytes that are not the
    request, so `--file` and `--hex` carrying the request could never match
    it. Three documented ways out collapsed to two, and the refusal's own
    advice ("carry the ORIGINAL bytes") named the impossible one. The session
    tried `--file`, a second file and `--hex`, was refused three times with
    three different digests, and stopped with `NEXT EXACT ACTION: NONE`.

    Blast radius was never exotic: `saipen start '<task>' --json` is the
    ordinary invocation, and any token after the closing quote broke it.
    """
    return split_request(recorded)[0]


def split_request(recorded: str) -> tuple[str, str]:
    """(request, transport tail) of an ingress remainder. ONE boundary owner.

    The request ends at the FIRST quote that can actually close it: what
    follows must be nothing, or transport -- a flag or shell punctuation first
    -- with its own quotes balanced. The first matching quote alone is not
    that. T-1459, measured on the T-1457 bytes: ``'fix the user's profile
    page'`` ended at the apostrophe, the recorded obligation owed
    ``fix the user``, and the transport the guard built carried only those
    bytes -- the operator's request silently truncated. A remainder that no
    closing quote explains is returned whole with an empty tail.
    """
    text = str(recorded or "").strip()
    if len(text) >= 2 and text[0] in "'\"":
        quote = text[0]
        # One pass, no per-candidate copies: the guard runs this on every
        # ingress line, so a long line full of quotes must stay linear.
        closes = [index for index, char in enumerate(text) if char == quote][1:]
        for rank, close in enumerate(closes):
            if close == len(text) - 1:
                return text[1:close].strip(), ""
            balanced = (len(closes) - rank - 1) % 2 == 0
            if balanced and _TRANSPORT_HEAD.match(text, close + 1):
                return text[1:close].strip(), text[close + 1 :].strip()
    return text, ""


def recorded_request_digest(found: dict) -> str:
    """The digest of the REQUEST inside a stored record, or "".

    Only when the stored preview provably covers the whole recorded payload:
    `preview` keeps the first 160 characters, so a shorter payload is stored
    in full and the request can be re-derived from it exactly. A truncated
    record answers "" rather than a guess -- half a request is not a request.
    """
    preview = str(found.get("preview") or "")
    size = found.get("bytes")
    if not preview or not isinstance(size, int) or isinstance(size, bool):
        return ""
    if size <= 0 or size > len(preview.encode("utf-8")):
        return ""
    # The stripped remainder must actually BE transport. A request whose own
    # first character is a quote would otherwise let this path accept a
    # shorter text than the operator wrote -- narrow, but it is the exact
    # weakening this gate exists to prevent, so `split_request` only reports
    # a tail it proved is transport.
    candidate, tail = split_request(preview)
    if not candidate or not tail:
        return ""
    return ingress_digest(candidate)


#: What may follow a quoted request, judged from its FIRST token: shell
#: punctuation -- pipe, redirect, background/sequence, command substitution --
#: or, after whitespace, a CLI flag or a descriptor redirect. Deciding by "a
#: shell mark anywhere" let words BEFORE the mark pass as transport
#: (``'fix' and then ship it | more``), which is exactly the shortening the
#: paraphrase gate exists to refuse. The whitespace matters: ``'a'-b`` and
#: ``'x'2>&1`` are ONE shell word, so the quote there closes nothing.
_TRANSPORT_HEAD = re.compile(r"\s*(?:\||>|<|&|;|`|\$\()|\s+(?:-|\d+>)")


def obligation(root: Path | str) -> dict:
    """Read-only: what this project owes its next ingress, and how to end it.

    The defect this ends, reported live on 2026-09-22 from a consumer project:
    the obligation was discoverable ONLY by violating it. A session hit
    ``INGRESS_PARAPHRASE_REFUSED``, had no surface naming the owed digest, its
    byte count, its preview or how long it still stands, guessed that
    ``saipen status --json`` would carry it under ``cold_route`` -- which owns
    nothing of the sort -- and answered ``NEXT EXACT ACTION: NONE``.

    Only the OPERATOR can discharge this: they hold the original bytes, or the
    authority to say the request changed. So it is operator-owned state, and
    operator-owned state that lives only inside a refusal is state the human
    never sees until an agent has already stopped.
    """
    found = pending(root)
    if found is None:
        return {"owed": False}
    if found.get("malformed"):
        return {
            "owed": True,
            "state": "UNREADABLE",
            "code": CODE_UNREADABLE,
            "detail": str(found.get("detail") or "unreadable"),
            "canonical_next_command": "saipen start --file <path>",
            "supersede_command": "saipen start " + SUPERSEDE_FLAG + " <task>",
        }
    age = _age_seconds(found.get("recorded"))
    route = str(found.get("route") or "saipen start --file <path>")
    return {
        "owed": True,
        "state": "PENDING",
        "code": CODE_PARAPHRASE,
        "digest": found["digest"],
        "bytes": found.get("bytes"),
        "recorded": found.get("recorded"),
        "age_seconds": age,
        "expires_in_seconds": None if age is None else max(0.0, MAX_AGE_SECONDS - age),
        "preview": found.get("preview"),
        # The digest of the REQUEST inside the record, when the record kept
        # the whole line. A caller needs the digest of what to SEND, not only
        # of what was stored, or it cannot tell a match from a paraphrase.
        "request_digest": recorded_request_digest(found),
        "route": route,
        "canonical_next_command": route,
        "supersede_command": "saipen start " + SUPERSEDE_FLAG + " <task>",
    }


def clear(root: Path | str, reason: str) -> bool:
    """Discharge the obligation. True when a record was actually removed."""
    path = pending_path(root)
    try:
        path.unlink()
    except FileNotFoundError:
        return False
    except OSError:
        return False
    return bool(reason)


def enforce(
    root: Path | str, text: str, *, supersede: bool = False, commit: bool = True
) -> dict | None:
    """None when this ingress may proceed; a refusal payload when it may not.

    Clearing is part of proceeding: bytes that answer the obligation discharge
    it, and so does an explicit operator supersede. What never proceeds is
    different text arriving silently while the refused bytes are still owed.

    `commit=False` answers the same question and writes nothing. A PLAN that
    discharged the obligation would let `--dry-run` -- the one call whose
    contract is that it changes nothing -- spend the operator's own guarantee
    on a preview.
    """
    found = pending(root)
    if found is None:
        return None
    if found.get("malformed"):
        if supersede:
            if commit:
                clear(root, "operator superseded an unreadable pending ingress")
            return None
        return {
            "code": CODE_UNREADABLE,
            "detail": (
                "a pending ingress obligation exists but cannot be read ("
                + str(found.get("detail") or "unreadable")
                + "). The refused request's bytes cannot be compared, so this "
                "ingress is refused rather than believed. Carry the original "
                "request through --file/--hex, or, if the request itself "
                "changed, repeat this command with " + SUPERSEDE_FLAG
            ),
            "pending_ingress": {"malformed": True},
            "canonical_next_command": "saipen start --file <path>",
            "supersede_command": "saipen start " + SUPERSEDE_FLAG + " <task>",
        }
    if supersede:
        if commit:
            clear(root, "operator superseded the refused request")
        return None
    if ingress_digest(text) == found["digest"]:
        if commit:
            clear(root, "the refused bytes arrived through their own transport")
        return None
    legacy = recorded_request_digest(found)
    if legacy and ingress_digest(text) == legacy:
        # A record written before `request_bytes` owned the boundary stored
        # the shell line, not the request. The request cannot match it, so
        # without this the obligation was dischargeable only by supersede or
        # by waiting out MAX_AGE_SECONDS. The bytes accepted here are the
        # OPERATOR's, re-derived deterministically from the stored record --
        # never a model's rewrite, which is the whole point of the gate.
        if commit:
            clear(root, "the refused request arrived; its record had kept the shell tail")
        return None
    route = str(found.get("route") or "saipen start --file <path>")
    return {
        "code": CODE_PARAPHRASE,
        "detail": (
            "this project owes its last refused ingress: "
            + str(found.get("bytes"))
            + " bytes, sha256 "
            + found["digest"]
            + ". The text supplied now has digest "
            + ingress_digest(text)
            + ", so it is not what was refused -- rewording a request to get "
            "past a transport refusal makes the receipt claim the operator's "
            "authority over the model's words. Carry the ORIGINAL bytes with "
            + route
            + ", or, if the operator genuinely changed the request, repeat "
            "this command with " + SUPERSEDE_FLAG
        ),
        "pending_ingress": {
            "digest": found["digest"],
            "bytes": found.get("bytes"),
            "recorded": found.get("recorded"),
            "route": route,
            "preview": found.get("preview"),
        },
        "supplied_digest": ingress_digest(text),
        "accepted_request_digest": legacy,
        "canonical_next_command": route,
        "supersede_command": "saipen start " + SUPERSEDE_FLAG + " <task>",
    }


__all__ = [
    "CODE_PARAPHRASE",
    "CODE_UNREADABLE",
    "MAX_AGE_SECONDS",
    "SCHEMA_VERSION",
    "SUPERSEDE_FLAG",
    "clear",
    "enforce",
    "ingress_digest",
    "obligation",
    "pending",
    "pending_path",
    "record",
    "recorded_request_digest",
    "request_bytes",
    "split_request",
]
