"""Evidence-based closure: provenance resolution and cohort authority.

CORE-003 / SRC-026:R003. Two facts the protocol kept confusing:

* **Ticket acceptance is not a per-ticket Git commit.** A ticket whose
  implementation already exists, durably published elsewhere, has nothing of
  its own to isolate; demanding a personal diff made the FastPrompter ticket
  BLOCK on an impossible requirement and stopped the loop.
* **Evidence closure is not publication ownership.** Several tickets can
  legitimately share one unpublished implementation; inventing a fictional
  per-ticket blob for each is a lie the release machinery would then commit.

So closure has exactly four lifecycle modes. Three of them resolve to a
publication authority: ``own_patch`` (default, the ticket owns and publishes an
isolatable delta), ``inherited_verified`` (no delta; a named DURABLE publication
authority carries it) and ``cohort`` (evidence complete, publication owed by a
C-### batch). The fourth, ``superseded_verified`` (T-1418), is local Work
lifecycle terminality through a verified DONE successor and asserts NO
publication at all: legitimate old Work was implemented and verified by a later
Work, so it owns no executable delta, but the successor is not thereby published.
This module owns the two things that must never be decided twice: the STRICT
implementation-source resolver and the durable cohort registry.

Publication stays a separate, downstream question for EVERY mode.
`superseded_verified` is the mode that makes that separation explicit: its ticket
is lifecycle-terminal while ``resolve_implementation_source`` may still return
non-green, and both answers are correct at once.

Nothing here trusts prose, and nothing here trusts a bare status. `DONE` alone
is not publication: a DONE ticket may itself have closed `inherited_verified`
against something that was never published, so resolution RECURSES to real
release evidence and refuses cycles deterministically.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from . import codec
from .board import (
    closure_cohort as _ticket_cohort,
    closure_mode as _ticket_closure_mode,
    external_evidence as _ticket_external_evidence,
    external_implementation as _ticket_external_implementation,
    implementation_source as _ticket_source,
    parse_board,
    superseded_by as _ticket_successor,
)

COHORT_REGISTRY_REL = ".saipen/kitchen/cohort_registry.json"
COHORT_SCHEMA_VERSION = 1
COHORT_ID_RE = re.compile(r"^C-\d+$")

#: The CLOSED implementation-source grammar. An authority outside these three
#: shapes is not "unknown", it is invalid -- an open grammar would let any
#: string become publication evidence by looking plausible.
SOURCE_GRAMMAR = ("release:<id>", "T-###", "SRC-###")

_RELEASE_RE = re.compile(r"^release:(?P<id>\S+)$")
_WORK_RE = re.compile(r"^T-\d+$")
_RECEIPT_RE = re.compile(r"^SRC-\d+$")

#: Recursion bound. A malformed chain must refuse deterministically, never
#: exhaust the interpreter stack -- the refusal is the product, not a crash.
_MAX_DEPTH = 32


@dataclass(frozen=True)
class SourceVerdict:
    """Why an implementation source does or does not prove publication."""

    ok: bool
    source: str
    kind: str
    detail: str
    chain: tuple[str, ...] = ()
    release: dict | None = None

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "source": self.source,
            "kind": self.kind,
            "detail": self.detail,
            "chain": list(self.chain),
            "release": self.release,
        }


# ----------------------------------------------------------------- registry


def registry_path(root: Path | str) -> Path:
    return Path(root) / ".saipen" / "kitchen" / "cohort_registry.json"


def empty_registry() -> dict:
    return {"schema_version": COHORT_SCHEMA_VERSION, "cohorts": {}}


def read_registry(root: Path | str) -> dict:
    """The durable cohort registry, or an empty one.

    A malformed registry is NOT silently replaced with an empty one: cohort
    membership is publication authority, and quietly forgetting it would turn
    an owed publication into "no cohort exists". Callers get the exception.
    """
    path = registry_path(root)
    if not path.is_file():
        return empty_registry()
    raw = codec.read_doc(path)
    if not raw.strip():
        return empty_registry()
    data = json.loads(raw)
    if not isinstance(data, dict) or not isinstance(data.get("cohorts"), dict):
        raise ValueError(f"{COHORT_REGISTRY_REL} is not a cohort registry object")
    data.setdefault("schema_version", COHORT_SCHEMA_VERSION)
    return data


def render_registry(registry: dict) -> str:
    """Canonical registry bytes -- deterministic, so a no-op write is a no-op."""
    return json.dumps(registry, indent=2, sort_keys=True) + "\n"


def hash_paths(root: Path | str, paths) -> dict[str, str]:
    """Bind each shared path to the hash of the bytes LIVE on disk.

    Deliberately hashes what is on disk rather than what a caller claims: the
    cohort's whole purpose is to own accumulated shared bytes nobody can split,
    so its record must be of the real thing.
    """
    from .journal import hash_bytes

    root = Path(root)
    out: dict[str, str] = {}
    for raw in paths:
        rel = str(raw).replace("\\", "/").strip()
        if not rel:
            continue
        fp = root / rel
        if not fp.is_file():
            raise FileNotFoundError(rel)
        out[rel] = hash_bytes(fp.read_bytes())
    return out


def upsert_member(
    registry: dict,
    cohort_id: str,
    ticket_id: str,
    *,
    paths: dict[str, str],
    verification: str,
    closed_at: str,
    agent: str,
) -> dict:
    """Return a NEW registry with this member bound into ``cohort_id``.

    Pure: the caller turns the result into ONE journaled write target, so a
    cohort membership and the BOARD line that claims it commit together or not
    at all.
    """
    out = json.loads(json.dumps(registry))
    cohorts = out.setdefault("cohorts", {})
    cohort = cohorts.setdefault(
        cohort_id,
        {
            "schema_version": COHORT_SCHEMA_VERSION,
            "cohort_id": cohort_id,
            "members": {},
            "publication_status": "pending",
            "scope": [],
            "release_op_id": "",
            "version": "",
            "tag": "",
            "commit": "",
        },
    )
    cohort["members"][ticket_id] = {
        "ticket_id": ticket_id,
        "paths": dict(paths),
        "verification": verification,
        "closed_at": closed_at,
        "closed_by": agent,
    }
    scope: set[str] = set(cohort.get("scope") or [])
    for member in cohort["members"].values():
        scope.update((member.get("paths") or {}).keys())
    cohort["scope"] = sorted(scope)
    return out


def cohort_scope(cohort: dict) -> dict[str, str]:
    """The ONE frozen batch scope: every shared path exactly once.

    Two members that both changed ``main.py`` contribute ONE path, bound to the
    single live identity they both attribute. A path claimed with two different
    hashes is a genuine disagreement and raises rather than picking a winner.
    """
    scope: dict[str, str] = {}
    for member in (cohort.get("members") or {}).values():
        for rel, digest in (member.get("paths") or {}).items():
            if rel in scope and scope[rel] != digest:
                raise ValueError(
                    f"cohort members disagree about {rel}: {scope[rel]} vs {digest}"
                )
            scope[rel] = digest
    return scope


def cohort_readiness(root: Path | str, cohort: dict) -> dict:
    """Is every member evidence-complete, so the batch may publish?

    READY requires every member DONE in this exact cohort, with no unresolved
    required Source clause and no P0/P1 blocker anywhere that would make the
    publication itself unsafe. The canonical BOARD parser represents a DONE
    checkbox as ``"x"`` -- the earlier attempt at this rule compared against
    the literal ``"[x]"`` and therefore never found a ready member.
    """
    root = Path(root)
    board = parse_board(codec.read_doc(root / ".saipen" / "BOARD.md"))
    tickets = board["tickets"]
    problems: list[str] = []
    if board["errors"]:
        problems.append("BOARD parse error(s): " + "; ".join(board["errors"][:3]))
    members = cohort.get("members") or {}
    if not members:
        problems.append("cohort has no members")
    for tid in sorted(members):
        ticket = tickets.get(tid)
        if ticket is None:
            problems.append(f"{tid} is not on BOARD")
            continue
        if ticket.get("section") != "## DONE" or ticket.get("checkbox") != "x":
            problems.append(
                f"{tid} is {ticket.get('section')} [{ticket.get('checkbox')}] -- "
                "a cohort publishes only evidence-complete members"
            )
            continue
        if _ticket_closure_mode(ticket) != "cohort":
            problems.append(f"{tid} did not close as cohort")
        elif _ticket_cohort(ticket) != cohort.get("cohort_id"):
            problems.append(
                f"{tid} names cohort {_ticket_cohort(ticket)} but is registered "
                f"under {cohort.get('cohort_id')}"
            )
        if not str((ticket.get("fields") or {}).get("verify", "")).strip():
            problems.append(f"{tid} carries no | verify: evidence")
    for tid, ticket in tickets.items():
        if ticket.get("section") != "## BLOCKED":
            continue
        if tid in members:
            problems.append(f"member {tid} is BLOCKED")
    # No member may publish over an unresolved required Source clause: the
    # existing work-closure gate is the canonical answer to that question, so
    # it is CALLED rather than approximated here.
    from .intake import work_closure_gate

    for tid in sorted(members):
        gate = work_closure_gate(root, tid)
        if not gate.get("ok"):
            problems.append(
                f"{tid} source coverage gate: {gate.get('code') or gate.get('detail')}"
            )
    return {"ready": not problems, "problems": problems}


# ---------------------------------------------------------------- resolver


def _published_releases(root: Path) -> list[dict]:
    """Every record that proves an ACTUAL durable publication.

    Two independent authorities, both required to be TERMINAL: COMMITTED
    release journal receipts, and the published `release_receipt.json` closure
    artifact a fresh clone can see. A kitchen receipt that names no commit and
    no committed operation is a release IN FLIGHT, and an in-flight release is
    not publication -- accepting it is exactly how "it shipped" becomes true
    before anything shipped.
    """
    from .release import _committed_release_receipts

    records: list[dict] = []
    try:
        records.extend(_committed_release_receipts(root))
    except Exception:  # evidence is a gate; an unreadable journal proves nothing
        records = []
    published = root / ".saipen" / "kitchen" / "release_receipt.json"
    if published.is_file():
        try:
            raw = json.loads(published.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raw = None
        if isinstance(raw, dict) and raw not in records:
            records.append(raw)
    return [r for r in records if _is_published(r)]


def _is_published(record: dict) -> bool:
    """A record is publication evidence only when it is terminal."""
    if record.get("operation") == "release" and record.get("status") == "COMMITTED":
        return record.get("release_stage") == "COMMITTED"
    # A closure artifact proves publication when it names the identity a clone
    # could check out: a commit, or an explicitly no-publish COMMITTED release.
    if record.get("commit"):
        return True
    return record.get("mode") == "no-publish" and bool(record.get("op_id"))


def _release_matches(record: dict, wanted: str) -> bool:
    candidates = {
        str(record.get("op_id") or ""),
        str(record.get("version") or ""),
        str(record.get("tag") or ""),
        str(record.get("commit") or ""),
    }
    candidates.discard("")
    if wanted in candidates:
        return True
    # `release:v0.4.2` naming a receipt whose version is `0.4.2`.
    return wanted.lstrip("v") in {c.lstrip("v") for c in candidates}


def resolve_implementation_source(
    root: Path | str,
    source: str,
    *,
    _chain: tuple[str, ...] = (),
) -> SourceVerdict:
    """THE strict resolver, shared by the closure operation and the validator.

    Returns a verdict; never mutates. The rules, all of them fail-closed:

    ``release:<id>``  requires terminal published release evidence.
    ``T-###``         TODO / DOING / BLOCKED are invalid; a DONE ``own_patch``
                      needs committed release evidence NAMING that Work; a DONE
                      ``cohort`` needs a SHIPPED cohort with an exact release
                      identity; a DONE ``inherited_verified`` resolves its own
                      source recursively; a DONE ``superseded_verified`` follows
                      ``superseded_by`` to its successor and resolves THAT Work.
                      `DONE` alone is never trusted. Supersession does not
                      manufacture publication: the follow is a PROVENANCE link,
                      so a superseded ticket whose successor is unpublished
                      returns non-green, exactly as it should.
    ``SRC-###``       a Source is PROVENANCE, not publication: it must be
                      terminal with a durable linked Work, and that Work is
                      then resolved recursively. An ACTIVE Source is invalid.

    A cycle (T-A -> T-B -> T-A) refuses deterministically with the chain named,
    with no recursion overflow and no mutation.
    """
    root = Path(root)
    source = (source or "").strip()
    if not source:
        return SourceVerdict(
            False, source, "missing", "no implementation source was named"
        )
    if source in _chain:
        return SourceVerdict(
            False,
            source,
            "cycle",
            "implementation provenance is cyclic: "
            + " -> ".join([*_chain, source])
            + " -- no member of this chain proves publication",
            chain=(*_chain, source),
        )
    if len(_chain) >= _MAX_DEPTH:
        return SourceVerdict(
            False,
            source,
            "depth",
            f"implementation provenance chain exceeds {_MAX_DEPTH} links; refuse",
            chain=(*_chain, source),
        )
    chain = (*_chain, source)

    m = _RELEASE_RE.match(source)
    if m:
        wanted = m.group("id")
        for record in _published_releases(root):
            if _release_matches(record, wanted):
                return SourceVerdict(
                    True,
                    source,
                    "release",
                    f"durable release evidence: version {record.get('version')!r} "
                    f"tag {record.get('tag')!r}",
                    chain=chain,
                    release=record,
                )
        return SourceVerdict(
            False,
            source,
            "release",
            f"implementation source {source!r} cannot be resolved to a durable "
            f"published release; no COMMITTED release receipt names {wanted!r}",
            chain=chain,
        )

    if _WORK_RE.match(source):
        return _resolve_work(root, source, chain)

    if _RECEIPT_RE.match(source):
        return _resolve_receipt(root, source, chain)

    return SourceVerdict(
        False,
        source,
        "grammar",
        f"implementation source {source!r} is outside the closed grammar "
        f"({', '.join(SOURCE_GRAMMAR)}); an authority that cannot be checked "
        f"is not an authority",
        chain=chain,
    )


def _resolve_work(root: Path, ticket_id: str, chain: tuple[str, ...]) -> SourceVerdict:
    board = parse_board(codec.read_doc(root / ".saipen" / "BOARD.md"))
    ticket = board["tickets"].get(ticket_id)
    if ticket is None:
        return SourceVerdict(
            False, ticket_id, "work", f"{ticket_id} is on no BOARD section", chain=chain
        )
    section = ticket.get("section")
    if section != "## DONE":
        return SourceVerdict(
            False,
            ticket_id,
            "work",
            f"{ticket_id} sits under {section}; unfinished Work cannot be "
            f"publication authority -- only a DONE ticket whose implementation "
            f"is actually published may be inherited",
            chain=chain,
        )
    mode = _ticket_closure_mode(ticket)
    if mode == "external_implementation":
        # SRC-088 / T-1434 M2: the fix lives in an EXTERNAL authority and this
        # project verified it locally. The receipt is append-only and binds the
        # installed engine GENERATION it was verified against; the ONE shared
        # predicate (external.resolution_problems) makes a moved/rolled-back
        # dependency non-green here, in the validator, and in every consumer.
        from . import external as _external

        problems = _external.resolution_problems(root, ticket_id, ticket)
        if problems:
            return SourceVerdict(
                False,
                ticket_id,
                "work",
                f"{ticket_id} closed external_implementation but the resolution "
                f"is not current: " + "; ".join(problems[:4]),
                chain=chain,
            )
        return SourceVerdict(
            True,
            ticket_id,
            "work",
            f"{ticket_id} was implemented by "
            f"{_ticket_external_implementation(ticket)} and verified locally "
            f"against the installed generation ({_ticket_external_evidence(ticket)})",
            chain=chain,
        )
    if mode == "superseded_verified":
        successor = _ticket_successor(ticket)
        if not successor:
            return SourceVerdict(
                False,
                ticket_id,
                "work",
                f"{ticket_id} closed superseded_verified with no superseded_by Work",
                chain=chain,
            )
        verdict = resolve_implementation_source(root, successor, _chain=chain)
        if verdict.ok:
            return SourceVerdict(
                True,
                ticket_id,
                "work",
                f"{ticket_id} was superseded by {successor}: {verdict.detail}",
                chain=verdict.chain,
                release=verdict.release,
            )
        return SourceVerdict(
            False,
            ticket_id,
            "work",
            f"{ticket_id} was superseded by {successor}, which has no proven "
            f"publication: {verdict.detail}",
            chain=verdict.chain,
        )
    if mode == "inherited_verified":
        inner = _ticket_source(ticket)
        if not inner:
            return SourceVerdict(
                False,
                ticket_id,
                "work",
                f"{ticket_id} closed inherited_verified with no "
                f"implementation_source; its own authority is missing",
                chain=chain,
            )
        verdict = resolve_implementation_source(root, inner, _chain=chain)
        if verdict.ok:
            return SourceVerdict(
                True,
                ticket_id,
                "work",
                f"{ticket_id} inherits from {inner}: {verdict.detail}",
                chain=verdict.chain,
                release=verdict.release,
            )
        return SourceVerdict(
            False,
            ticket_id,
            "work",
            f"{ticket_id} inherits from {inner}, which cannot be resolved: {verdict.detail}",
            chain=verdict.chain,
        )
    if mode == "cohort":
        cohort_id = _ticket_cohort(ticket)
        if not cohort_id:
            return SourceVerdict(
                False,
                ticket_id,
                "work",
                f"{ticket_id} closed as cohort with no C-### authority",
                chain=chain,
            )
        try:
            registry = read_registry(root)
        except (OSError, ValueError) as exc:
            return SourceVerdict(
                False, ticket_id, "work", f"cohort registry unreadable: {exc}", chain=chain
            )
        cohort = (registry.get("cohorts") or {}).get(cohort_id)
        if cohort is None:
            return SourceVerdict(
                False,
                ticket_id,
                "work",
                f"{ticket_id} names cohort {cohort_id}, which has no durable "
                f"registry record -- BOARD prose is not cohort authority",
                chain=chain,
            )
        if cohort.get("publication_status") != "shipped":
            return SourceVerdict(
                False,
                ticket_id,
                "work",
                f"{ticket_id} belongs to cohort {cohort_id}, whose publication "
                f"is still {cohort.get('publication_status', 'pending')!r}; an "
                f"unshipped cohort has published nothing to inherit",
                chain=chain,
            )
        if not cohort.get("release_op_id") or not cohort.get("version"):
            return SourceVerdict(
                False,
                ticket_id,
                "work",
                f"cohort {cohort_id} claims shipped without an exact release "
                f"identity (release_op_id/version)",
                chain=chain,
            )
        return SourceVerdict(
            True,
            ticket_id,
            "work",
            f"{ticket_id} published through cohort {cohort_id} "
            f"(release {cohort.get('release_op_id')}, version {cohort.get('version')})",
            chain=chain,
            release=dict(cohort),
        )
    # own_patch, or a legacy DONE that predates closure provenance: the SAME
    # bar either way -- independent committed release evidence naming the Work.
    for record in _published_releases(root):
        if str(record.get("ticket_id") or "") == ticket_id:
            return SourceVerdict(
                True,
                ticket_id,
                "work",
                f"{ticket_id} owns committed release evidence "
                f"(version {record.get('version')!r}, tag {record.get('tag')!r})",
                chain=chain,
                release=record,
            )
    return SourceVerdict(
        False,
        ticket_id,
        "work",
        f"{ticket_id} is DONE but no committed release evidence names it; DONE "
        f"is an evidence claim, never proof of publication",
        chain=chain,
    )


def _resolve_receipt(root: Path, receipt_id: str, chain: tuple[str, ...]) -> SourceVerdict:
    from . import intake

    status = intake.status(root, receipt_id)
    if not status.get("ok"):
        return SourceVerdict(
            False,
            receipt_id,
            "source",
            f"{receipt_id} is not a readable Source receipt: "
            f"{status.get('detail') or status.get('code')}",
            chain=chain,
        )
    state = str(status.get("status") or "")
    if state != intake.CLOSED_STATUS:
        return SourceVerdict(
            False,
            receipt_id,
            "source",
            f"{receipt_id} is {state or 'ACTIVE'}; a Source is provenance, not "
            f"publication, and a non-terminal Source proves nothing was "
            f"published from it",
            chain=chain,
        )
    work = status.get("linked_work")
    if not work:
        return SourceVerdict(
            False,
            receipt_id,
            "source",
            f"{receipt_id} is terminal but names no durable linked Work",
            chain=chain,
        )
    verdict = resolve_implementation_source(root, str(work), _chain=chain)
    if verdict.ok:
        return SourceVerdict(
            True,
            receipt_id,
            "source",
            f"{receipt_id} -> {work}: {verdict.detail}",
            chain=verdict.chain,
            release=verdict.release,
        )
    return SourceVerdict(
        False,
        receipt_id,
        "source",
        f"{receipt_id} links {work}, which cannot be resolved: {verdict.detail}",
        chain=verdict.chain,
    )
