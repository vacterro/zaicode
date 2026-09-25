"""Project-local durable knowledge cards, index projection, and retrieval.

``.saipen/KNOWLEDGE`` remains the authority.  Cards are optional structured
Markdown inside ``cards/``; ``INDEX.md`` is a deletable generated projection.
All read APIs are side-effect free.  Only :func:`write_index` writes, and that
operation is explicit and bounded to the projection file.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .paths import (
    prove_owned_dir_chain,
    prove_owned_regular,
    read_bound_regular_bytes,
    safe_atomic_write_bytes,
)

KNOWLEDGE_REL = Path(".saipen/KNOWLEDGE")
CARDS_REL = KNOWLEDGE_REL / "cards"
INDEX_REL = KNOWLEDGE_REL / "INDEX.md"
CARD_MARKER = "<!-- SAIPEN KNOWLEDGE CARD v1 -->"
INDEX_MARKER = "<!-- SAIPEN KNOWLEDGE INDEX v1; generated projection; not authority -->"
KINDS = frozenset({"lesson", "decision", "trap", "convention"})
STATUSES = frozenset({"active", "superseded"})
PROMOTION_CRITERIA = (
    "verified",
    "reusable",
    "decision_bearing",
    "not_cheaply_derivable",
    "non_duplicate",
    "non_transient",
    "safe",
)
_FIELDS = frozenset({"kind", "scope", "trigger", "status", "evidence", "supersedes"})
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_ROW_RE = re.compile(
    r"^- (?P<path>cards/[a-z0-9][a-z0-9-]*\.md) \| "
    r"(?P<kind>lesson|decision|trap|convention) \| scope: (?P<scope>[^|]+) \| "
    r"trigger: (?P<trigger>[^|]+) \| (?P<status>active|superseded)$"
)
_LEGACY_ROW_RE = re.compile(r"^- (?P<path>[^|]+) \| legacy \| title: (?P<title>[^|]+)$")
_LEGACY_HEADING = "Legacy KNOWLEDGE documents (path and title only; no structured metadata):"
_LEGACY_TITLE_RE = re.compile(r"(?m)^#[ \t]+(.+?)[ \t]*$")
_UNTITLED = "(untitled)"
_MAX_TITLE_CHARS = 120
_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9_-]{2,}", re.IGNORECASE)
_STOPWORDS = frozenset(
    {
        "the",
        "and",
        "for",
        "with",
        "from",
        "that",
        "this",
        "into",
        "when",
        "then",
        "new",
        "task",
        "ticket",
        "work",
        "phase",
        "add",
        "adding",
        "use",
        "using",
        "current",
        "future",
        "should",
        "must",
        "project",
    }
)
_SECRET_PATTERNS = (
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----"),
    re.compile(r"(?i)\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S{8,}"),
)
_LOG_LEAK_RE = re.compile(r"(?m)^-\s+[0-9]{2,4}[-/.][0-9]{2}[-/.][0-9]{2}.*(?:RUN|DEC|H):")
_MAX_CARD_BYTES = 256 * 1024


@dataclass(frozen=True)
class KnowledgeCard:
    path: str
    kind: str
    scope: tuple[str, ...]
    trigger: str
    status: str
    evidence: tuple[str, ...]
    supersedes: tuple[str, ...]
    title: str
    claim: str
    why: str
    content_sha256: str

    @property
    def identity(self) -> str:
        return PurePosixPath(self.path).stem.casefold()

    @property
    def retrieval_identity(self) -> tuple[tuple[str, ...], str]:
        return tuple(sorted(item.casefold() for item in self.scope)), _norm(self.trigger)

    def index_record(self) -> dict[str, str]:
        return {
            "path": self.path,
            "kind": self.kind,
            "scope": ", ".join(self.scope),
            "trigger": self.trigger,
            "status": self.status,
        }


def _norm(text: str) -> str:
    return " ".join(text.casefold().split())


def _split_csv(value: str, field: str) -> tuple[str, ...]:
    if "|" in value or "\n" in value or "\r" in value:
        raise ValueError(f"{field} contains an index delimiter or newline")
    items = tuple(part.strip() for part in value.split(",") if part.strip())
    if not items:
        raise ValueError(f"{field} must be non-empty")
    return items


def _safe_reference(value: str, field: str) -> str:
    ref = value.strip().replace("\\", "/")
    if not ref:
        raise ValueError(f"{field} contains an empty reference")
    if field == "evidence" and ref.startswith("human-decision:"):
        if not ref.removeprefix("human-decision:").strip():
            raise ValueError("evidence human decision must be named")
        return ref
    path = PurePosixPath(ref)
    if path.is_absolute() or ".." in path.parts or re.match(r"^[A-Za-z]:", ref):
        raise ValueError(f"{field} reference escapes KNOWLEDGE: {value!r}")
    return ref


def _read_owned(path: Path, root: Path, *, max_bytes: int = _MAX_CARD_BYTES) -> bytes:
    prove_owned_dir_chain(path.parent, kind="knowledge path", ownership_root=root)
    witnessed = prove_owned_regular(path, kind="knowledge file")
    return read_bound_regular_bytes(path, witnessed, max_bytes=max_bytes)


def parse_card(text: str, path: str = "cards/card.md") -> KnowledgeCard:
    """Parse one complete structured card with no YAML dependency."""
    rel = path.replace("\\", "/")
    posix = PurePosixPath(rel)
    if len(posix.parts) != 2 or posix.parts[0] != "cards" or posix.suffix != ".md":
        raise ValueError(f"card path must be cards/<slug>.md: {path}")
    if not _SLUG_RE.fullmatch(posix.stem):
        raise ValueError(f"card slug is not canonical: {posix.stem!r}")
    if text.startswith("\ufeff"):
        raise ValueError("card must be UTF-8 without a BOM")
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lines or lines[0] != CARD_MARKER:
        raise ValueError(f"card must start with {CARD_MARKER}")
    fields: dict[str, str] = {}
    cursor = 1
    while cursor < len(lines) and lines[cursor].strip():
        key, sep, value = lines[cursor].partition(":")
        if not sep or key not in _FIELDS:
            raise ValueError(f"invalid card header line {cursor + 1}: {lines[cursor]!r}")
        if key in fields:
            raise ValueError(f"duplicate card field {key}")
        fields[key] = value.strip()
        cursor += 1
    missing = sorted({"kind", "scope", "trigger", "status", "evidence"} - set(fields))
    if missing:
        raise ValueError("missing card field(s): " + ", ".join(missing))
    if fields["kind"] not in KINDS:
        raise ValueError(f"invalid kind {fields['kind']!r}")
    if fields["status"] not in STATUSES:
        raise ValueError(f"invalid status {fields['status']!r}")
    scope = _split_csv(fields["scope"], "scope")
    trigger = fields["trigger"].strip()
    if not trigger or "|" in trigger or "\n" in trigger:
        raise ValueError("trigger must be non-empty single-line text without '|'")
    evidence = tuple(
        _safe_reference(item, "evidence") for item in _split_csv(fields["evidence"], "evidence")
    )
    supersedes_raw = fields.get("supersedes", "none").strip()
    supersedes = (
        ()
        if not supersedes_raw or supersedes_raw.casefold() == "none"
        else tuple(
            _safe_reference(item, "supersedes") for item in _split_csv(supersedes_raw, "supersedes")
        )
    )
    body = "\n".join(lines[cursor + 1 :]).strip()
    title_match = re.match(r"^# ([^\n]+)\n+(.+)$", body, re.DOTALL)
    if not title_match:
        raise ValueError("card body needs '# <title>' followed by a claim and Why")
    title = title_match.group(1).strip()
    remainder = title_match.group(2).strip()
    claim_blob, sep, why = remainder.partition("\n\nWhy:\n")
    if not sep or not claim_blob.strip() or not why.strip():
        raise ValueError("card body needs one claim paragraph and a non-empty 'Why:' block")
    if "\n\n" in claim_blob.strip():
        raise ValueError("card claim must be one concise paragraph")
    for pattern in _SECRET_PATTERNS:
        if pattern.search(text):
            raise ValueError("card contains a secret-like value")
    if _LOG_LEAK_RE.search(text):
        raise ValueError("card contains event-journal syntax; history belongs in LOG")
    raw = text.encode("utf-8")
    return KnowledgeCard(
        path=rel,
        kind=fields["kind"],
        scope=scope,
        trigger=trigger,
        status=fields["status"],
        evidence=evidence,
        supersedes=supersedes,
        title=title,
        claim=claim_blob.strip(),
        why=why.strip(),
        content_sha256=hashlib.sha256(raw).hexdigest(),
    )


def _card_paths(root: Path) -> list[Path]:
    cards_dir = root / CARDS_REL
    if not os.path.lexists(cards_dir):
        return []
    prove_owned_dir_chain(cards_dir, kind="knowledge cards", ownership_root=root)
    if not cards_dir.is_dir():
        raise ValueError(f"knowledge cards path is not a directory: {cards_dir}")
    paths: list[Path] = []
    for path in cards_dir.iterdir():
        if path.suffix.casefold() != ".md":
            continue
        prove_owned_regular(path, kind="knowledge card")
        paths.append(path)
    return sorted(paths, key=lambda item: item.name.casefold())


def read_cards(root: Path | str) -> list[KnowledgeCard]:
    root = Path(root).resolve()
    cards = []
    for path in _card_paths(root):
        raw = _read_owned(path, root)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ValueError(f"{path.name} is not UTF-8: {exc}") from None
        cards.append(parse_card(text, f"cards/{path.name}"))
    return cards


def _tree_errors(cards: list[KnowledgeCard]) -> list[str]:
    errors: list[str] = []
    by_identity: dict[str, KnowledgeCard] = {}
    by_path = {card.path: card for card in cards}
    active_keys: dict[tuple[tuple[str, ...], str], KnowledgeCard] = {}
    replacers: dict[str, list[KnowledgeCard]] = {}
    for card in cards:
        if card.identity in by_identity:
            duplicate_path = by_identity[card.identity].path
            errors.append(
                f"duplicate normalized card identity: {duplicate_path}, {card.path}"
            )
        by_identity[card.identity] = card
        if card.status == "active":
            previous = active_keys.get(card.retrieval_identity)
            if previous is not None:
                errors.append(
                    "two active cards share one scope/trigger identity: "
                    f"{previous.path}, {card.path}; supersede one explicitly"
                )
            active_keys[card.retrieval_identity] = card
        for target in card.supersedes:
            if target == card.path:
                errors.append(f"{card.path} supersedes itself")
                continue
            target_card = by_path.get(target)
            if target_card is None:
                errors.append(f"{card.path} supersedes missing target {target}")
                continue
            if card.status != "active" or target_card.status != "superseded":
                errors.append(
                    f"{card.path} supersession must link an active replacement "
                    "to a superseded target"
                )
            replacers.setdefault(target, []).append(card)
    for card in cards:
        if card.status != "superseded":
            continue
        replacements = replacers.get(card.path, [])
        if len(replacements) != 1:
            errors.append(
                f"{card.path} is superseded but has {len(replacements)} active replacement link(s)"
            )
    return errors


def _records_digest(cards: list[KnowledgeCard], legacy: list[tuple[str, str]]) -> str:
    payload = {
        "cards": [
            {"path": card.path, "sha256": card.content_sha256}
            for card in sorted(cards, key=lambda item: item.path)
        ],
        "legacy": [{"path": path, "title": title} for path, title in legacy],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    return hashlib.sha256(encoded).hexdigest()


def _legacy_title(path: Path, root: Path) -> str:
    """Return the mechanically provable H1 of a legacy KNOWLEDGE document."""
    try:
        text = _read_owned(path, root, max_bytes=1024 * 1024).decode("utf-8")
    except (OSError, UnicodeError, ValueError):
        return "(unreadable)"
    match = _LEGACY_TITLE_RE.search(text)
    if not match:
        return _UNTITLED
    title = " ".join(match.group(1).replace("|", " ").split())
    title = "".join(char for char in title if char.isprintable())
    return title[:_MAX_TITLE_CHARS].strip() or _UNTITLED


def _legacy_entries(root: Path) -> list[tuple[str, str]]:
    """Enumerate non-card KNOWLEDGE documents as (relative path, title) pairs.

    Only path and H1 are projected: no legacy semantics are guessed and no body
    reaches the index.  Cards own structured metadata; these rows exist so a
    cold agent can see the legacy surface without reading the whole tree.
    """
    knowledge_dir = root / KNOWLEDGE_REL
    if not knowledge_dir.is_dir():
        return []
    entries: list[tuple[str, str]] = []
    for path in sorted(knowledge_dir.rglob("*.md"), key=lambda item: item.as_posix().casefold()):
        rel = path.relative_to(knowledge_dir).as_posix()
        if rel == INDEX_REL.name or rel.startswith("cards/"):
            continue
        if not path.is_file():
            continue
        entries.append((rel, _legacy_title(path, root)))
    return entries


def build_index(root: Path | str) -> str:
    """Return exact deterministic INDEX.md bytes as text; write nothing."""
    root = Path(root).resolve()
    cards = read_cards(root)
    errors = _tree_errors(cards)
    if errors:
        raise ValueError("; ".join(errors))
    legacy = _legacy_entries(root)
    lines = [
        INDEX_MARKER,
        f"source-digest: sha256:{_records_digest(cards, legacy)}",
        f"cards: {len(cards)}",
        f"legacy: {len(legacy)}",
        "",
        "# Knowledge index",
        "",
        "Active cards are retrieval candidates. Superseded cards remain forensic history.",
        "",
    ]
    for card in sorted(cards, key=lambda item: item.path):
        rec = card.index_record()
        lines.append(
            f"- {rec['path']} | {rec['kind']} | scope: {rec['scope']} | "
            f"trigger: {rec['trigger']} | {rec['status']}"
        )
    if not cards:
        lines.append("(no structured cards)")
    if legacy:
        lines.extend(["", _LEGACY_HEADING, ""])
        lines.extend(f"- {path} | legacy | title: {title}" for path, title in legacy)
    return "\n".join(lines) + "\n"


def parse_index(text: str) -> dict:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    if len(lines) < 8 or lines[0] != INDEX_MARKER:
        raise ValueError("INDEX.md lacks the generated projection marker")
    digest_match = re.fullmatch(r"source-digest: sha256:([0-9a-f]{64})", lines[1])
    count_match = re.fullmatch(r"cards: (\d+)", lines[2])
    legacy_match = re.fullmatch(r"legacy: (\d+)", lines[3])
    if not digest_match or not count_match or not legacy_match:
        raise ValueError("INDEX.md has invalid digest/count metadata")
    records = []
    legacy = []
    for line in lines:
        if not line.startswith("- "):
            continue
        match = _ROW_RE.fullmatch(line)
        if match:
            records.append(match.groupdict())
            continue
        legacy_row = _LEGACY_ROW_RE.fullmatch(line)
        if not legacy_row:
            raise ValueError(f"INDEX.md has invalid row: {line!r}")
        legacy.append(legacy_row.groupdict())
    if len(records) != int(count_match.group(1)) or len(legacy) != int(legacy_match.group(1)):
        raise ValueError("INDEX.md card count does not match its rows")
    return {"digest": digest_match.group(1), "records": records, "legacy": legacy}


def _is_projection(text: str) -> bool:
    """Recognize projection ownership, including damaged/versioned headers."""
    return text.startswith("<!-- SAIPEN KNOWLEDGE INDEX") or bool(
        re.search(r"(?m)^source-digest:", text)
    )


def validate_knowledge(root: Path | str) -> dict:
    root = Path(root).resolve()
    knowledge_dir = root / KNOWLEDGE_REL
    if not os.path.lexists(knowledge_dir):
        return {"errors": [], "cards": 0, "active": 0, "index": "absent"}
    errors: list[str] = []
    cards: list[KnowledgeCard] = []
    try:
        prove_owned_dir_chain(knowledge_dir, kind="knowledge", ownership_root=root)
        cards = read_cards(root)
        errors.extend(_tree_errors(cards))
    except (OSError, UnicodeError, ValueError) as exc:
        errors.append(str(exc))
    index_state = "absent"
    index_path = root / INDEX_REL
    if index_path.exists():
        try:
            raw = _read_owned(index_path, root, max_bytes=512 * 1024)
            text = raw.decode("utf-8")
            if not _is_projection(text):
                return {
                    "errors": errors,
                    "cards": len(cards),
                    "active": sum(card.status == "active" for card in cards),
                    "index": "legacy",
                }
            parse_index(text)
            expected = build_index(root)
            if text != expected:
                errors.append("INDEX.md is stale; run `saipen knowledge index`")
                index_state = "stale"
            else:
                index_state = "fresh"
        except (OSError, UnicodeError, ValueError) as exc:
            errors.append(f"INDEX.md: {exc}")
            index_state = "invalid"
    return {
        "errors": errors,
        "cards": len(cards),
        "active": sum(card.status == "active" for card in cards),
        "index": index_state,
    }


def write_index(root: Path | str, *, dry_run: bool = False) -> dict:
    root = Path(root).resolve()
    try:
        text = build_index(root)
        target = root / INDEX_REL
        try:
            existing = _read_owned(target, root, max_bytes=512 * 1024)
        except FileNotFoundError:
            existing = None
        if existing is not None and not _is_projection(existing.decode("utf-8")):
            raise ValueError(
                "INDEX.md is a legacy document; preserve or rename it before generating an index"
            )
        changed = existing != text.encode("utf-8")
        if not dry_run and changed:
            safe_atomic_write_bytes(
                target,
                text.encode("utf-8"),
                kind="knowledge index",
                ownership_root=root,
            )
        return {
            "ok": True,
            "code": "KNOWLEDGE_INDEX_PLAN" if dry_run else "KNOWLEDGE_INDEXED",
            "path": INDEX_REL.as_posix(),
            "changed": changed,
            "bytes": len(text.encode("utf-8")),
            "digest": parse_index(text)["digest"],
            "writes": "none" if dry_run else ([INDEX_REL.as_posix()] if changed else []),
        }
    except (OSError, UnicodeError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}


def _terms(text: str) -> set[str]:
    return {
        token.casefold().replace("_", "-")
        for token in _TOKEN_RE.findall(text)
        if token.casefold() not in _STOPWORDS
    }


def _quick_index(root: Path) -> tuple[list[dict], str]:
    index_path = root / INDEX_REL
    if not os.path.lexists(index_path):
        return [], "absent"
    try:
        index_stat = prove_owned_regular(index_path, kind="knowledge index")
        text = read_bound_regular_bytes(index_path, index_stat, max_bytes=512 * 1024).decode(
            "utf-8"
        )
        parsed = parse_index(text)
        # INDEX is a cache, never authority.  Exact regeneration catches
        # edited rows and changed card content even when mtimes are preserved
        # or moved backwards.  Card bodies are parsed internally for this
        # proof but only selected bodies are returned to model context.
        if text != build_index(root):
            return [], "stale"
        return parsed["records"], "fresh"
    except (OSError, UnicodeError, ValueError):
        return [], "stale"


def retrieve(root: Path | str, objective: str, *, limit: int = 3) -> dict:
    """Return the smallest highest-scoring active card set for *objective*.

    The compact index routes retrieval after exact comparison with its source
    cards.  Card bodies are parsed internally to prove freshness, but only the
    selected bodies are emitted to model context.  Missing/stale indexes safely
    fall back to direct card records; the read never rewrites the projection.
    """
    root = Path(root).resolve()
    if limit < 1:
        raise ValueError("retrieval limit must be positive")
    query = _terms(objective)
    if not query:
        return {"index": "unused", "retrieved": [], "loaded_paths": [], "metadata_scanned": 0}
    records, index_state = _quick_index(root)
    direct_cards: dict[str, KnowledgeCard] = {}
    if index_state != "fresh":
        try:
            cards = read_cards(root)
            errors = _tree_errors(cards)
            if errors:
                raise ValueError("; ".join(errors))
        except (OSError, UnicodeError, ValueError) as exc:
            return {
                "index": index_state,
                "retrieved": [],
                "loaded_paths": [],
                "metadata_scanned": 0,
                "error": str(exc),
            }
        direct_cards = {card.path: card for card in cards}
        records = [card.index_record() for card in cards]
    scored: list[tuple[int, str, dict]] = []
    for record in records:
        if record["status"] != "active":
            continue
        haystack = _terms(f"{record['path']} {record['scope']} {record['trigger']}")
        score = len(query & haystack)
        if score:
            scored.append((score, record["path"], record))
    if not scored:
        return {
            "index": index_state,
            "retrieved": [],
            "loaded_paths": [],
            "metadata_scanned": len(records),
        }
    scored.sort(key=lambda item: (-item[0], item[1]))
    best = scored[0][0]
    selected = [item for item in scored if item[0] == best][:limit]
    loaded: list[str] = []
    retrieved = []
    for score, path, _record in selected:
        card = direct_cards.get(path)
        if card is None:
            target = root / KNOWLEDGE_REL / Path(path)
            raw = _read_owned(target, root)
            card = parse_card(raw.decode("utf-8"), path)
        loaded.append(path)
        retrieved.append(
            {
                "path": card.path,
                "kind": card.kind,
                "scope": list(card.scope),
                "trigger": card.trigger,
                "title": card.title,
                "claim": card.claim,
                "why": card.why,
                "evidence": list(card.evidence),
                "score": score,
            }
        )
    return {
        "index": index_state,
        "retrieved": retrieved,
        "loaded_paths": loaded,
        "metadata_scanned": len(records),
    }


def render_retrieval(result: dict) -> str:
    items = result.get("retrieved") or []
    if not items:
        return ""
    lines = ["## RETRIEVED KNOWLEDGE"]
    for item in items:
        lines.extend(
            [
                f"- source: .saipen/KNOWLEDGE/{item['path']}",
                f"  claim: {item['claim']}",
                f"  why: {item['why']}",
                f"  evidence: {', '.join(item['evidence'])}",
            ]
        )
    return "\n".join(lines)


def evaluate_promotion(
    facts: dict[str, bool],
    *,
    scope: tuple[str, ...] = (),
    trigger: str = "",
    existing: list[KnowledgeCard] | None = None,
) -> dict:
    """Apply the closed anti-bloat gate; never creates a card implicitly."""
    failed = [criterion for criterion in PROMOTION_CRITERIA if facts.get(criterion) is not True]
    if failed:
        return {"eligible": False, "action": "reject", "failed": failed}
    identity = (tuple(sorted(item.casefold() for item in scope)), _norm(trigger))
    duplicate = next(
        (
            card
            for card in (existing or [])
            if card.status == "active" and card.retrieval_identity == identity
        ),
        None,
    )
    if duplicate is not None:
        return {"eligible": True, "action": "reuse", "path": duplicate.path, "failed": []}
    return {"eligible": True, "action": "promote", "failed": []}
