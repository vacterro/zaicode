"""Structured validator findings (AUDAPACK T-172 / SAIPEN T-1301).

The Work delta gate cannot safely compare human-readable text blobs, so every
validator problem/warning needs a stable structured identity. This module is
the ONE classifier: it derives ``rule_id``/``subject_kind``/``subject_id``/
``finding_key``/``detail_hash`` from a rendered finding message WITHOUT
weakening the validator -- classification never removes, downgrades or hides a
finding, and an unclassifiable message falls back to ``unclassified`` +
``global``, which the Work gate always treats as blocking.

finding_key is stable across timestamps, output ordering, line-number movement
(where the semantic subject is unchanged), formatting and invocation time. It
changes when the rule changes, the subject changes, or the semantic defect
changes materially (via detail_hash comparison on top of the same key). The
key is NEVER built from the whole rendered English message.

CREDENTIAL SAFETY (AUDAPACK T-172 Phase D3): SOURCE_CREDENTIALS_UNSAFE and
every other credential/secret-bearing family NEVER carries message content
into structured artifacts -- only the rule id, the safe resource identity, a
redacted category and a non-reversible evidence hash. No matched value, token
body, password, API key or unsafe source fragment is ever serialized here.
"""

from __future__ import annotations

import hashlib
import json
import re

RULESET_VERSION = 1

SEVERITIES = ("problem", "warning")

# Canonical subject vocabulary.
SUBJECT_KINDS = ("work", "source", "event", "receipt", "path", "global")

_ID_PATTERNS = {
    "work": re.compile(r"T-\d+"),
    "source": re.compile(r"SRC-\d+"),
    "event": re.compile(r"E-\d+"),
    "receipt": re.compile(r"(?:XP|OP)-\d+|op[-_ ]?id[: ]\S+"),
}


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class Rule:
    """One finding-family classifier: how to recognize it and who owns it."""

    def __init__(
        self,
        rule_id: str,
        pattern: str,
        subject_kind: str,
        *,
        subject_pattern: str | None = None,
        subject_last: bool = False,
        credential: bool = False,
        detail: str | None = None,
    ):
        self.rule_id = rule_id
        self.re = re.compile(pattern)
        self.subject_kind = subject_kind
        self.subject_re = re.compile(subject_pattern) if subject_pattern else None
        self.subject_last = subject_last
        self.credential = credential
        self.detail_template = detail

    def subject(self, message: str) -> str | None:
        if self.subject_re is not None:
            if self.subject_last:
                found = self.subject_re.findall(message)
                return found[-1] if found else None
            found = self.subject_re.search(message)
            if found:
                return found.group(0)
            return None
        return _default_subject(message, self.subject_kind)


def _default_subject(message: str, subject_kind: str) -> str | None:
    """Best canonical subject for a rule with no dedicated extractor."""
    if subject_kind == "global":
        return None
    regex = _ID_PATTERNS.get(subject_kind)
    if regex is not None:
        found = regex.search(message)
        if found:
            return found.group(0)
    return None


# The rule table, in priority order. First match wins, so specific families
# precede their generic prefixes. Rendering order of validator output NEVER
# affects identity: classification is per-message and keys are compared as
# sets, never as ordered lists.
_RULES: tuple[Rule, ...] = (
    # -- credential safety: detail is a FIXED redacted string; message content
    # (which names a pattern category and path) never enters structured data.
    Rule(
        "source_credential_unsafe",
        r"credential gate|SOURCE_CREDENTIALS_UNSAFE|credential pattern",
        "source",
        subject_pattern=r"SRC-\d+",
        credential=True,
        detail="credential-pattern:redacted",
    ),
    Rule(
        "source_receipt_unresolved_work",
        r"DONE Work (T-\d+) has unresolved source receipt",
        "work",
        subject_pattern=r"T-\d+",
        detail=None,
    ),
    Rule(
        "source_receipt_active_invalid",
        r"active receipt (SRC-\d+) (contract/coverage invalid|coverage unreadable"
        r"|contract revision chain)",
        "source",
        subject_pattern=r"SRC-\d+",
    ),
    Rule(
        "source_receipt_clause_drift",
        r"active receipt (SRC-\d+) contract/coverage clause drift",
        "source",
        subject_pattern=r"SRC-\d+",
    ),
    Rule(
        "source_receipt_orphan",
        r"ORPHAN_RECEIPT (SRC-\d+)",
        "source",
        subject_pattern=r"SRC-\d+",
    ),
    Rule(
        "source_receipt_closed_archive_invalid",
        r"closed receipt (SRC-\d+) archive bundle invalid",
        "source",
        subject_pattern=r"SRC-\d+",
    ),
    Rule(
        "source_receipt_missing_board",
        r"BOARD Work (T-\d+) references missing source receipt",
        "work",
        subject_pattern=r"T-\d+",
    ),
    Rule(
        "source_receipt_index_drift",
        r"(active receipt|tombstone) (SRC-\d+) (index metadata drift|index digest drift"
        r"|differs from index projection)",
        "source",
        subject_pattern=r"SRC-\d+",
    ),
    Rule(
        "source_receipt_linkage_drift",
        r"active receipt SRC-\d+ linkage missing from BOARD Work",
        "source",
        subject_pattern=r"SRC-\d+",
    ),
    Rule(
        "work_closure_evidence",
        r"ticket (T-\d+) is ## DONE but carries no current-cycle verification evidence "
        r"\(classifier: ([^)]+)\)",
        "work",
        subject_pattern=r"T-\d+",
    ),
    Rule(
        "log_provenance_marker",
        r"mechanical provenance \[saio\].*?(E-\d+)",
        "event",
        subject_pattern=r"E-\d+",
        subject_last=True,
    ),
    Rule(
        "log_ticket_ref",
        r"ticket ref \[([^\]]+)\] isn't numeric",
        "global",
        detail=None,
    ),
    Rule(
        "log_timestamp_inversion",
        r"timestamp moves backwards by",
        "global",
    ),
    Rule(
        "board_soft_cap",
        r"BOARD\.md is .* \(soft cap",
        "global",
    ),
    Rule(
        "log_soft_cap",
        r"LOG\.md is .* (past|over) the",
        "global",
    ),
    Rule(
        "changelog_unarchived",
        r"CHANGELOG\.md carries .* version entries",
        "global",
    ),
    Rule(
        "cross_doc_drift",
        r"cross-doc drift \[([^\]]+)\]",
        "global",
    ),
    Rule(
        "legacy_closure_evidence",
        r"ticket (T-\d+) has no ticket-bearing closure event",
        "work",
        subject_pattern=r"T-\d+",
    ),
    Rule(
        "half_claim",
        r"ticket (T-\d+) carries owner but no claim_time",
        "work",
        subject_pattern=r"T-\d+",
    ),
    Rule(
        "translation_stale",
        r"locale README",
        "global",
    ),
    Rule(
        "wiki_mirror",
        r"(wiki-mirror|mirrors conformance corpus)",
        "global",
    ),
    Rule(
        "sub_role_revision_legacy",
        r"subSaipen STATE\(s\) predate role-revision recording",
        "global",
    ),
    Rule(
        "producer_package_malformed",
        r"OUTBOX\.md fails strict OUTBOX parsing",
        "global",
    ),
)

RULE_TABLE = tuple(
    {
        "rule_id": rule.rule_id,
        "pattern": rule.re.pattern,
        "subject_kind": rule.subject_kind,
        "credential": rule.credential,
    }
    for rule in _RULES
)


def ruleset_fingerprint() -> str:
    """Explicit compatibility binding for debt snapshots (F3).

    Covers exactly the identity semantics: rule ids, recognition patterns,
    subject kinds and the credential-redaction policy. A validator edit that
    changes finding identity semantics changes this fingerprint, and every
    older snapshot then refuses comparison (BASELINE_RULESET_CHANGED) instead
    of silently comparing incompatible keys.
    """
    payload = json.dumps(
        {"ruleset_version": RULESET_VERSION, "rules": RULE_TABLE},
        sort_keys=True,
        separators=(",", ":"),
    )
    return _sha(payload)


def finding_key(rule_id: str, subject_kind: str, subject_id: str | None) -> str:
    """Stable cross-run identity: rule + subject only. Never ordering, never
    timestamps, never line numbers, never the rendered message."""
    return _sha(f"{rule_id}|{subject_kind}|{subject_id or ''}")[:16]


def _normalized_detail(rule: Rule, message: str) -> str:
    """The semantic-condition fingerprint input.

    Message-derived detail is deliberately narrow: the classifier class and
    semantic tokens, with volatile numbers (line numbers, counts, sizes,
    timestamps) stripped, and -- for credential families -- with ALL message
    content dropped in favor of the fixed redacted category.
    """
    if rule.credential:
        return rule.detail_template or "credential-pattern:redacted"
    if rule.detail_template is not None:
        return rule.detail_template
    text = message
    # Volatile numbers: line numbers, byte/line counts, sizes, minutes.
    text = re.sub(r":\d+", "", text)
    text = re.sub(r"\b\d+(?:\.\d+)?\s*(?:KB|MB|lines?|entries?|version entries)\b", "<n>", text)
    text = re.sub(r"\b\d+m\b", "<n>", text)
    text = re.sub(r"\b\d+(?:\.\d+)?s\b", "<n>", text)
    if rule.rule_id == "work_closure_evidence":
        found = re.search(r"\(classifier: ([^)]+)\)", text)
        if found:
            return found.group(1)
    if rule.rule_id == "log_provenance_marker":
        return "structural-event-missing-op-marker"
    # Multi-id subjects (e.g. a ticket ref naming several tickets) keep the
    # id set, order-normalized, so ordering never changes identity.
    ids = re.findall(r"T-\d+|SRC-\d+|E-\d+", text)
    if ids:
        return ",".join(sorted(set(ids)))
    return re.sub(r"\s+", " ", text).strip()


def classify(severity: str, message: str, category: str | None = None) -> dict:
    """Classify ONE rendered validator finding. Never raises."""
    severity = "problem" if severity == "problem" else "warning"
    rule: Rule | None = None
    if category:
        for candidate in _RULES:
            if message.lstrip().startswith(f"{category}"):
                rule = candidate
                break
    if rule is None:
        for candidate in _RULES:
            if candidate.re.search(message):
                rule = candidate
                break
    if rule is not None:
        subject_id = rule.subject(message)
        subject_kind = rule.subject_kind
        if subject_kind != "global" and not subject_id:
            subject_kind = "global"
        detail = _normalized_detail(rule, message)
        structured = {
            "severity": severity,
            "rule_id": rule.rule_id,
            "subject_kind": subject_kind,
            "subject_id": subject_id,
            "credential": rule.credential,
        }
    else:
        subject_id = None
        subject_kind = "global"
        detail = re.sub(r"\s+", " ", message).strip()[:200]
        structured = {
            "severity": severity,
            "rule_id": "unclassified",
            "subject_kind": "global",
            "subject_id": None,
            "credential": False,
        }
    # Subject reference is presentation-only metadata: canonical file refs
    # when the message carries one. It is NEVER part of finding_key.
    ref = None
    found = re.search(r"[\w./\\-]+(?:\.\w+):\d+", message)
    if found:
        ref = found.group(0)
    structured.update(
        {
            "subject_ref": ref,
            "finding_key": finding_key(
                structured["rule_id"], structured["subject_kind"], structured["subject_id"]
            ),
            "detail_hash": _sha(detail)[:16],
            "detail": None if structured["credential"] else detail,
            "category": category,
        }
    )
    return structured


def findings_digest(problems: list[dict], warnings: list[dict]) -> str:
    """Order-independent integrity digest over the classified finding set."""
    canonical = json.dumps(
        {
            "problems": sorted(problems, key=lambda f: f["finding_key"] + f["detail_hash"]),
            "warnings": sorted(warnings, key=lambda f: f["finding_key"] + f["detail_hash"]),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return _sha(canonical)


def compare_finding(a: dict, b: dict) -> str:
    """Same-key equivalence: CARRIED when the semantic condition is unchanged."""
    return "CARRIED" if a.get("detail_hash") == b.get("detail_hash") else "CHANGED"
