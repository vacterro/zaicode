"""Is this FAIL -> PASS pair evidence of a fix? (`VERIFY-ORACLE-01`)

`phases/verify.md` has always required a regression test that failed before the
fix. What it could not say was which test. Nothing bound the verifier that
produced the FAIL to the verifier that produced the PASS, so the cheapest way
to close a bug ticket was never to fix the bug:

    BUG EXISTS -> TEST FAILS -> weaken the fixture -> TEST PASSES -> DONE

Every downstream guard reads green. REVIEW re-runs the ticket's own `verify:`
and gets the same green from the same weakened oracle. `acceptance.py` marks
evidence stale only when BUILD is RE-entered, so an edit made inside the one
BUILD never trips it. The escaped-defect taxonomy already has the name for this
-- `CONTROL_DISARMED` -- and the instrument control is already the mechanism
against it. The only missing piece was arithmetic: hold the verifier fixed and
compare.

WHAT A DIGEST CAN AND CANNOT SAY. It can say the verifier changed, or did not.
It can never say the verifier is semantically correct: an oracle that asserts
the wrong behaviour hashes exactly as confidently as a right one. So identity
is half the contract and the red control in `phases/verify.md` is the other
half -- prove the same unchanged oracle goes RED against the PRE-FIX subject.
This module owns only the half a machine can decide.

Pure: it hashes bytes the caller names and compares records the caller built.
It reads no state, writes nothing, and knows nothing about tickets.
"""

from __future__ import annotations

import re
from pathlib import Path

from .journal import hash_bytes

RULE_ID = "VERIFY-ORACLE-01"

#: Verdicts. `ADMISSIBLE` is the only one that may be cited as fix evidence.
ADMISSIBLE = "ADMISSIBLE"
ORACLE_CHANGED = "ORACLE_CHANGED"
SUBJECT_UNCHANGED = "SUBJECT_UNCHANGED"
SUBJECT_UNRECORDED = "SUBJECT_UNRECORDED"
NOT_A_REGRESSION_PAIR = "NOT_A_REGRESSION_PAIR"

#: ONE record vocabulary (CORE-002). The comparison record has exactly two
#: identity keys, `verifier` and `subject`, and the parser produces exactly
#: that shape. It previously emitted `oracle`/`subject` while the verdict
#: consumed `verifier`/`subject`, so the parser's output was not the verdict's
#: declared record without an undocumented remapping -- an easy thing to get
#: wrong at the moment this is finally wired into production.
VERIFIER_KEY = "verifier"
SUBJECT_KEY = "subject"

#: `verifier:<hex>` / `subject:<hex>` inside an evidence line. `oracle:` is
#: accepted as the same field under its human-facing spelling -- the norm and
#: this module both say "oracle" in prose -- and both spellings land on the
#: single `verifier` record key above.
_TOKEN = re.compile(r"\b(verifier|oracle|subject):([0-9a-f]{8,64})\b")
_TOKEN_KEY = {"verifier": VERIFIER_KEY, "oracle": VERIFIER_KEY, "subject": SUBJECT_KEY}

_MISSING = "(none)"


def oracle_digest(root: Path | str, paths) -> str:
    """Content identity of the files that DEFINE success for one check.

    The test, its fixtures, its golden files, its mocks -- whatever the caller
    names. An absent path contributes its name and an explicit absence marker
    rather than being skipped: deleting the failing case is one of the ways
    this defect is committed, and a deletion that changed nothing in the digest
    would be the one edit the check could not see.
    """
    root = Path(root)
    parts: list[str] = []
    for rel in sorted({str(p).replace("\\", "/") for p in (paths or ())}):
        target = root / rel
        try:
            body = hash_bytes(target.read_bytes()) if target.is_file() else _MISSING
        except OSError:
            body = _MISSING
        parts.append(f"{rel}={body}")
    return hash_bytes("\n".join(parts).encode("utf-8"))


def verifier_identity(command: str, oracle_paths=(), root: Path | str = ".") -> str:
    """What produced a verdict: the command plus the bytes that define success.

    The command belongs in the identity because narrowing test discovery,
    excluding a directory or swapping a behavioural run for a smoke run changes
    the question just as surely as editing an assertion does, and leaves every
    named file byte-identical.
    """
    return hash_bytes(
        "\n".join(
            [
                f"command={(command or '').strip()}",
                f"oracle={oracle_digest(root, oracle_paths)}",
            ]
        ).encode("utf-8")
    )


def parse_identity(text: str) -> dict:
    """The identity tokens carried by an evidence line, in RECORD shape.

    The result is exactly what `regression_pair_verdict` consumes: keys
    `verifier` and `subject`, never the wire spellings. A line carrying both
    `verifier:` and `oracle:` keeps the first occurrence, so a second spelling
    cannot quietly redefine the identity a reader already saw.
    """
    found: dict[str, str] = {}
    for token, value in _TOKEN.findall(text or ""):
        found.setdefault(_TOKEN_KEY[token], value)
    return found


#: The anchored evidence record (CORE-001). Until this existed, the whole rule
#: was documentation plus a helper nothing called: `operations.py` gated
#: VERIFY -> REVIEW and finish through `log.verification_evidence` alone, which
#: decides from free-form text carrying `PASS` and `conf: high` and never
#: compared an oracle to a subject. A bug could stay untouched, its fixture be
#: weakened, a normal green be logged, and both canonical gates accepted it.
#:
#: Anchored for the reason `structural_marker_events` gives: a line that merely
#: CONTAINS a marker is discussing it. The record must BEGIN the event.
_EVIDENCE_RE = re.compile(
    r"^REGRESSION-EVIDENCE\s+(FAIL|PASS)\b(?P<rest>.*)$", re.DOTALL
)
EVIDENCE_PREFIX = "REGRESSION-EVIDENCE "

#: Verdicts the gate can reach that are not about the pair itself.
NO_EVIDENCE = "NO_REGRESSION_EVIDENCE"


def parse_evidence(text: str) -> dict | None:
    """One `REGRESSION-EVIDENCE <FAIL|PASS> verifier:… subject:…` record.

    Returns the record `regression_pair_verdict` consumes, or None when the
    line is not an anchored evidence record. Prose about regression evidence
    is not evidence, which is the entire point of the anchor.
    """
    match = _EVIDENCE_RE.match((text or "").strip())
    if match is None:
        return None
    record = parse_identity(match.group("rest"))
    record["result"] = match.group(1)
    return record


def regression_evidence_verdict(records) -> dict:
    """The verdict for a ticket's current-cycle evidence records.

    Takes the LATEST FAIL and the LATEST PASS, because a cycle may legitimately
    record several attempts and the pair that matters is the one that closed
    it. Missing either half is `NO_REGRESSION_EVIDENCE` -- distinct from a pair
    that exists and is inadmissible, so the diagnostic can say which of the two
    an agent is actually looking at.
    """
    before = after = None
    for record in records or ():
        if record.get("result") == "FAIL":
            before = record
        elif record.get("result") == "PASS":
            after = record
    if before is None or after is None:
        missing = "FAIL" if before is None else "PASS"
        return _verdict(
            NO_EVIDENCE,
            f"no {missing} half of a regression pair was recorded in this VERIFY "
            f"cycle. A ticket declaring `regression: required` owes both: the "
            f"SAME verifier red against the pre-fix subject and green against "
            f"the post-fix one",
        )
    return regression_pair_verdict(before, after)


def regression_pair_verdict(before: dict, after: dict) -> dict:
    """Does this FAIL -> PASS pair prove the SUBJECT is what changed?

    `before` and `after` are records carrying `result`, `verifier` and
    `subject`. The whole judgement is which of the two moved:

        verifier same,    subject changed -> ADMISSIBLE
        verifier changed, subject changed -> ORACLE_CHANGED, unattributable
        verifier changed, subject same    -> ORACLE_CHANGED, the greenwash
        verifier same,    subject same    -> SUBJECT_UNCHANGED, nothing to fix

    The second row matters as much as the third. Editing production code and
    its test in one pass leaves no way to prove which side turned the light
    green, and "probably the fix" is not evidence.
    """
    before = before or {}
    after = after or {}
    if str(before.get("result", "")).upper() != "FAIL" or str(
        after.get("result", "")
    ).upper() != "PASS":
        return _verdict(
            NOT_A_REGRESSION_PAIR,
            "a fix comparison is a FAIL against the pre-fix subject followed by a "
            f"PASS against the post-fix subject; got {before.get('result')!r} -> "
            f"{after.get('result')!r}",
        )

    before_v, after_v = before.get("verifier"), after.get("verifier")
    before_s, after_s = before.get("subject"), after.get("subject")
    if not before_v or not after_v:
        return _verdict(
            ORACLE_CHANGED,
            "no verifier identity was recorded for one side of the comparison, so "
            "the two runs cannot be shown to have asked the same question. An "
            "unrecorded identity is not a matching one",
        )
    if before_v != after_v:
        detail = (
            "the subject changed too, so nothing attributes the green to the fix "
            "rather than to the weaker check"
            if before_s and after_s and before_s != after_s
            else "the subject did not change, so the only thing that turned this "
            "green was the check itself"
        )
        return _verdict(
            ORACLE_CHANGED,
            f"the verifier changed between the FAIL and the PASS ({str(before_v)[:12]} "
            f"-> {str(after_v)[:12]}) -- {detail}. The earlier FAIL is not evidence "
            "for this fix; re-establish it against the current oracle",
        )
    if before_s and after_s and before_s == after_s:
        return _verdict(
            SUBJECT_UNCHANGED,
            "the same verifier reports FAIL then PASS against the same subject, "
            "which is an unstable verifier or an unrecorded change, never a proven "
            "fix",
        )
    if not before_s or not after_s:
        # CORE-002: this used to fall through to ADMISSIBLE, so an ABSENT
        # subject identity was treated as proof the subject had changed --
        # fail-OPEN on the identity of the very thing whose change is supposed
        # to have caused the green. Missing verifier already failed closed
        # right above; the two sides are now symmetric, because the claim
        # "the implementation is what changed" needs both endpoints named.
        missing = "pre-fix" if not before_s else "post-fix"
        return _verdict(
            SUBJECT_UNRECORDED,
            f"no subject identity was recorded for the {missing} side, so nothing "
            "shows the implementation moved between the FAIL and the PASS. An "
            "unrecorded identity is not a changed one",
        )
    return _verdict(
        ADMISSIBLE,
        "the same verifier failed against the pre-fix subject and passed against "
        "the post-fix subject, so the implementation is what changed",
    )


def _verdict(code: str, reason: str) -> dict:
    return {
        "code": code,
        "admissible": code == ADMISSIBLE,
        "reason": reason,
        "rule_id": RULE_ID,
    }
