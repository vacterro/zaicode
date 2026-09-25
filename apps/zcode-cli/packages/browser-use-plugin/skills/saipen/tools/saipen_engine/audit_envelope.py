"""Producer-neutral audit envelope -- SOURCE-AUDIT-ENQUEUE-01 (T-1231).

An audit layer MAY open with one metadata block. It is an HTML comment, so a
plain Markdown reader renders nothing and a file that never carries one stays
a perfectly valid layer:

    <!-- saipen-audit-envelope
    audit_schema: 1
    producer: audapack
    producer_version: 2.1.0
    producer_item_id: PAL-0042
    created_at: 2026-08-31T12:00:00Z
    severity: high
    confidence: medium
    observed_project: saipen
    related_audit: 3
    amends_audit: 2
    -->

Three rules make this safe to add to a transport that already works:

1. **Parsing never touches the bytes.** The envelope is part of the file, so
   it is inside the SHA-256 that identifies the generation. Nothing here
   rewrites, strips or normalizes a layer -- a digest computed before parsing
   equals the digest computed after it, always.

2. **A malformed envelope is not an invalid audit.** It downgrades to "no
   usable metadata" and the layer captures exactly as it would have without
   one. The failure class this closes: a producer's metadata bug making a real
   finding undeliverable, or worse, making a layer look deletable.

3. **Every field is a CLAIM.** `severity`, `confidence` and the rest are what
   the producer asserts, never what SAIPEN believes. No routing, priority,
   ordering or deletion decision reads them, and `maintainer_verdict` is
   forced to PENDING on intake -- a producer cannot approve its own finding.

The body below the envelope is untouched prose. Nothing here interprets it.
"""

from __future__ import annotations

import re

OPEN = "<!-- saipen-audit-envelope"
CLOSE = "-->"

# Bounded, closed field set. An unknown key is not a parse error (a newer
# producer may say more than this SAIPEN knows); it is simply not adopted,
# which keeps an old consumer readable to a new producer.
FIELDS = (
    "audit_schema",
    "producer",
    "producer_version",
    "producer_item_id",
    "created_at",
    "severity",
    "confidence",
    "observed_project",
    "related_audit",
    "amends_audit",
)

PENDING = "PENDING"

_LINE_RE = re.compile(r"^([a-z][a-z0-9_]*)\s*:\s*(.*)$")
_VALUE_MAX = 200
_LINES_MAX = 32


def _absent() -> dict:
    return {"present": False, "ok": True, "fields": {}, "maintainer_verdict": PENDING}


def _malformed(reason: str) -> dict:
    return {
        "present": True,
        "ok": False,
        "reason": reason,
        "fields": {},
        "maintainer_verdict": PENDING,
    }


def parse(text: str) -> dict:
    """Read the optional leading envelope. Never raises, never rewrites `text`."""
    if not isinstance(text, str):
        return _absent()
    # The envelope must be the FIRST thing in the file. Anything else would
    # let a producer bury metadata under prose, and then "which block wins"
    # becomes a question with no answer.
    stripped = text.lstrip("﻿")
    if not stripped.startswith(OPEN):
        return _absent()
    end = stripped.find(CLOSE, len(OPEN))
    if end == -1:
        return _malformed("envelope opened but never closed")
    block = stripped[len(OPEN) : end]
    lines = [line.strip() for line in block.splitlines()]
    lines = [line for line in lines if line]
    if len(lines) > _LINES_MAX:
        return _malformed(f"envelope carries {len(lines)} lines; the bound is {_LINES_MAX}")
    fields: dict[str, str] = {}
    for line in lines:
        match = _LINE_RE.match(line)
        if not match:
            return _malformed(f"envelope line is not `key: value`: {line[:60]!r}")
        key, value = match.group(1), match.group(2).strip()
        if len(value) > _VALUE_MAX:
            return _malformed(f"envelope value for {key!r} exceeds {_VALUE_MAX} bytes")
        if key in fields:
            return _malformed(f"envelope repeats key {key!r}")
        if key in FIELDS:
            fields[key] = value
    return {
        "present": True,
        "ok": True,
        "fields": fields,
        # Producer-supplied verdicts are discarded, not merely ignored: the
        # value that reaches provenance is the one SAIPEN sets.
        "maintainer_verdict": PENDING,
    }


def render(fields: dict) -> str:
    """Build an envelope block from known fields. Producers use this; SAIPEN
    never rewrites a layer it received."""
    lines = [OPEN]
    for key in FIELDS:
        value = fields.get(key)
        if value in (None, ""):
            continue
        text = str(value).strip()
        if "\n" in text or len(text) > _VALUE_MAX:
            continue
        lines.append(f"{key}: {text}")
    lines.append(CLOSE)
    return "\n".join(lines) + "\n"
