# ruff: noqa: RUF002, RUF003
"""Deterministic command parsing for SAIPEN compound inputs.

Defect class this module exists to close: a protocol command or shortcut can
reach free-form natural-language reasoning before deterministic SAIPEN
resolution ("sc" answered as a style-mode greeting; "saipen push + build ccc"
executed only one segment while the other was narrated away).

Rules enforced here:

- A compound input (``saipen push + build ccc``) is split into an ORDERED
  list of command segments BEFORE any conversational interpretation. No
  segment may disappear because a model considers it unnecessary.
- A whole first token that matches a declared SAIPEN shortcut activates
  SAIPEN and resolves to its row. Any remaining text is opaque payload
  for that command. The table is read from REGISTRY.json (saipen/REGISTRY.json)
  as the machine authority; COMMANDS.md explains the surface but is not parsed.
- Shortcut normalization is UNICODE-CODEPOINT SUBSTITUTION, never
  keyboard-position substitution (CMD-ROUTING-01): each character is
  lowercased and folded through the one declared Cyrillic-confusable map, then
  looked up EXACTLY in the canonical table. Cyrillic сс therefore normalizes
  to Latin cc -- never to Latin ss, which has no Cyrillic twin because no
  Cyrillic character folds to "s". There is no keyboard-layout guessing, no
  visual-similarity guessing, no Levenshtein matching, and no model
  interpretation anywhere in this path: an unresolved token fails closed.
- Style commands (``stop caveman`` / ``normal mode``) are recognized as
  style tokens ONLY when the token is not a declared shortcut. ``sc`` is
  never "stop caveman".
- Chain policy is STOP_ON_FAILURE by default: a later segment after an
  earlier REFUSED/FAILED segment becomes NOT_RUN unless it is provably
  independent. Skipping with prose is forbidden; every recognized segment
  receives an explicit terminal disposition.
"""

from __future__ import annotations

from pathlib import Path

from .registry import RegistryError
from .registry import load_registry as _load_registry
from .registry import require_mapping, require_string_list

# REGISTRY.json is the sole machine authority. Import-time consumers derive
# immutable constants from it; no English-prose fallback exists.
_REGISTRY = _load_registry()
CYRILLIC_CONFUSABLE_MAP = {
    str(key): str(value)
    for key, value in require_mapping(_REGISTRY, "cyrillic_confusables").items()
}

# Lexical routing: every declared shortcut owns its input.
# Destination validates arguments; resolver never decides payload validity.
CYRILLIC_CONFUSABLES = str.maketrans(CYRILLIC_CONFUSABLE_MAP)
# The inverse direction: used to DERIVE the Cyrillic twins of the canonical
# table (a shortcut has a twin exactly when every one of its letters is in
# this map). Derived, never hand-maintained.
LATIN_TO_CYRILLIC_CONFUSABLE = {v: k for k, v in CYRILLIC_CONFUSABLE_MAP.items()}


def normalize_shortcut_token(token: str) -> str:
    """The deterministic shortcut normalizer (CMD-ROUTING-01).

    Lowercase (plain ``lower()`` -- never ``casefold()``, whose undeclared
    expansions would smuggle non-protocol characters into the alphabet), then
    translate ONLY the declared Unicode confusable characters. This is
    codepoint substitution, not keyboard-position substitution: Cyrillic
    ``сс`` normalizes to Latin ``cc``, and because ``s`` is not a fold target,
    no Cyrillic input can ever normalize to ``ss`` or ``sss``.
    """
    return token.strip().lower().translate(CYRILLIC_CONFUSABLES)


def resolve_shortcut(token: str, *, table: dict[str, str] | None = None) -> str | None:
    """Resolve a raw whole-message token to its canonical LATIN shortcut key.

    The algorithm is fixed: take the raw token, normalize it through
    :func:`normalize_shortcut_token` (codepoint substitution only), then look
    the result up EXACTLY in the canonical registry table. Return
    the canonical Latin key, or ``None`` when nothing declares it -- an
    unresolved token fails closed and is never guessed into a shortcut. The
    raw token is preserved by the caller for evidence/reporting; this function
    never mutates protocol state.
    """
    if table is None:
        table = load_shortcut_table()
    key = normalize_shortcut_token(token)
    return key if key in table else None


def derive_cyrillic_twins(
    latin_keys: list[str] | set[str] | dict[str, str] | None = None,
) -> dict[str, str]:
    """Mechanically derive the Cyrillic twins of the given Latin shortcuts.

    A shortcut has a twin exactly when EVERY letter folds (is present in the
    declared confusable map); the twin is the character-by-character inverse
    mapping. Returns {cyrillic_twin: latin_key}. There is deliberately no
    second hand-maintained twin list anywhere: callers derive from here.
    """
    keys = (
        set(latin_keys)
        if isinstance(latin_keys, (set, frozenset))
        else list(latin_keys)
        if latin_keys is not None
        else list(load_shortcut_table())
    )
    return {
        "".join(LATIN_TO_CYRILLIC_CONFUSABLE[ch] for ch in key): key
        for key in keys
        if key and all(ch in LATIN_TO_CYRILLIC_CONFUSABLE for ch in key)
    }


def load_registry(protocol_dir: Path | str | None = None) -> dict:
    """Compatibility export for callers; reads REGISTRY.json only."""
    return _load_registry(protocol_dir, required=False)


def load_shortcut_table(protocol_dir: Path | str | None = None) -> dict[str, str]:
    """Read the canonical shortcut table from REGISTRY.json.

    Returns {shortcut: canonical saipen command}. Missing or malformed registry
    yields an empty table so command dispatch fails closed. Prose is never read.
    """
    registry = load_registry(protocol_dir)
    shortcuts = registry.get("shortcuts") if registry else None
    if not isinstance(shortcuts, dict):
        return {}
    return {
        key: route
        for key, route in shortcuts.items()
        if isinstance(key, str) and isinstance(route, str)
    }


def is_declared_shortcut(token: str, table: dict[str, str] | None = None) -> bool:
    """True when the whole token is a declared SAIPEN shortcut.

    An unknown two/three-letter token must NOT become a shortcut; only an
    exact table match counts. Canonical Latin rows match directly; Cyrillic
    twins reach those same rows only through the declared confusable fold.
    """
    if table is not None:
        return token.strip() in table or normalize_shortcut_token(token) in table
    full = load_shortcut_table()
    return token.strip() in full or normalize_shortcut_token(token) in full


def parse_compound_command(message: str) -> list[str]:
    """Split a possibly-compound command message into ordered segments.

    Segments are separated by `` + `` (space-plus-space) or by newlines.
    A plus inside a token such as ``C++`` or ``A+B`` remains literal payload.
    Quoted payload (double quotes) is treated as opaque and never split.
    This is pure lexical splitting: semantic resolution happens per segment
    afterwards.
    """
    if not message or not message.strip():
        return []
    raw = message.strip()
    parts: list[str] = []
    current: list[str] = []
    quote = False
    escape = False
    i = 0
    while i < len(raw):
        ch = raw[i]
        if escape:
            current.append(ch)
            escape = False
            i += 1
            continue
        if ch == "\\":
            escape = True
            current.append(ch)
            i += 1
            continue
        if ch == '"':
            quote = not quote
            current.append(ch)
            i += 1
            continue
        if not quote and ch == "\n":
            parts.append("".join(current))
            current = []
            i += 1
            while i < len(raw) and raw[i] == "\n":
                i += 1
            continue
        if not quote and ch == "+" and i > 0 and i + 1 < len(raw):
            if raw[i - 1].isspace() and raw[i + 1].isspace():
                parts.append("".join(current))
                current = []
                i += 1
                if i < len(raw) and raw[i].isspace():
                    i += 1
                continue
        current.append(ch)
        i += 1
    if quote:
        return []
    parts.append("".join(current))
    segments = []
    for part in parts:
        stripped = part.strip()
        if stripped:
            segments.append(stripped)
    return segments


def resolve_compound_command(
    message: str,
    *,
    protocol_dir: Path | str | None = None,
    table: dict[str, str] | None = None,
) -> list[dict]:
    """Resolve a compound message into ordered command segments with targets.

    Each segment returns::

        {"index": int, "segment": str, "command": str, "kind": "command"|"shortcut"|"unknown"}

    - a segment starting with ``saipen `` is a canonical command (kind=command);
    - a first whole token that matches the shortcut table resolves to its
      command; remaining text is appended unchanged as opaque payload
      (kind=shortcut);
    - a bare token that does NOT match is kind=unknown (never a guessed
      shortcut, never a style token unless the caller decides so).

    ``stop caveman`` / ``normal mode`` are multi-word and never shortcut
    matches; they are returned as kind=unknown (style) segments.
    """
    if table is None:
        table = load_shortcut_table(protocol_dir)
    segments = parse_compound_command(message)
    resolved: list[dict] = []
    for index, segment in enumerate(segments):
        if segment.startswith("saipen "):
            resolved.append(
                {"index": index, "segment": segment, "command": segment, "kind": "command"}
            )
            continue
        if " " in segment:
            words = segment.split()
            leading = words[0]
            leading_target = table.get(leading) or table.get(normalize_shortcut_token(leading))
            if leading_target is not None:
                payload = segment[len(leading) :].lstrip()
                # Every leading declared shortcut owns its payload; destination validates.
                if payload:
                    resolved.append(
                        {
                            "index": index,
                            "segment": segment,
                            "command": f"{leading_target} {payload}",
                            "kind": "shortcut",
                            "payload": payload,
                        }
                    )
                else:
                    resolved.append(
                        {
                            "index": index,
                            "segment": segment,
                            "command": leading_target,
                            "kind": "shortcut",
                        }
                    )
                continue
            # Multi-word segment: check for a TRAILING declared shortcut.
            # Narrowed to the single normative idiom `build ccc` (CORE §1.10) --
            # arbitrary trailing shortcuts are NOT commands (Wave 4 payload safety).
            trailing = words[-1]
            target = table.get(trailing) or table.get(
                normalize_shortcut_token(trailing)
            )
            if target is not None and segment == "build ccc":
                # Only `build ccc` is authorized trailing; twin `build ссс` same.
                resolved.append(
                    {
                        "index": index,
                        "segment": segment,
                        "command": target,
                        "kind": "shortcut",
                        "context": " ".join(words[:-1]),
                    }
                )
                continue
            if (
                target is not None
                and normalize_shortcut_token(trailing) == "ccc"
                and " ".join(words[:-1]) == "build"
            ):
                # Cyrillic twin path: `build ссс` after normalization
                resolved.append(
                    {
                        "index": index,
                        "segment": segment,
                        "command": target,
                        "kind": "shortcut",
                        "context": "build",
                    }
                )
                continue
            # Multi-word style/tone commands and free prose are not shortcuts.
            resolved.append({"index": index, "segment": segment, "command": "", "kind": "unknown"})
            continue
        target = table.get(segment) or table.get(normalize_shortcut_token(segment))
        if target is not None:
            resolved.append(
                {"index": index, "segment": segment, "command": target, "kind": "shortcut"}
            )
            continue
        resolved.append({"index": index, "segment": segment, "command": "", "kind": "unknown"})
    return resolved


# REGISTRY.json is the sole authority for chain/result vocabulary. Exported
# names remain stable for callers, but values and failure membership are
# derived at import time rather than maintained as a second closed set here.
_CHAIN_FACTS = require_mapping(_REGISTRY, "chain_policies")
(
    CHAIN_STOP_ON_FAILURE,
    CHAIN_CONTINUE_WHEN_INDEPENDENT,
) = require_string_list(_CHAIN_FACTS, "closed_set")
if _CHAIN_FACTS.get("default") != CHAIN_STOP_ON_FAILURE:
    raise RegistryError("REGISTRY chain_policies.default must be first in closed_set")

_DISPOSITION_FACTS = require_mapping(_REGISTRY, "dispositions")
(
    DISPOSITION_EXECUTED,
    DISPOSITION_REFUSED,
    DISPOSITION_BLOCKED,
    DISPOSITION_SKIPPED_BY_PROTOCOL,
    DISPOSITION_ALREADY_SATISFIED,
    DISPOSITION_NOT_RUN,
    DISPOSITION_FAILED,
) = require_string_list(_DISPOSITION_FACTS, "closed_set")
_FAILURE_DISPOSITIONS = frozenset(
    require_string_list(_DISPOSITION_FACTS, "failure")
)


def chain_disposition(
    dispositions: list[str],
    *,
    policy: str = CHAIN_STOP_ON_FAILURE,
    independent: list[bool] | None = None,
) -> list[str]:
    """Apply the canonical chain policy to a sequence of segment outcomes.

    ``dispositions`` is the per-segment result in order. Under
    STOP_ON_FAILURE (default), the first failure freezes every later segment
    to NOT_RUN. Under CONTINUE_WHEN_INDEPENDENT, a later segment may keep its
    own disposition only when ``independent[i]`` is True; otherwise it is
    NOT_RUN. This is a deterministic mechanical rule -- the caller never
    "decides" per-invocation whether a segment is skipped.
    """
    result = list(dispositions)
    if policy == CHAIN_CONTINUE_WHEN_INDEPENDENT:
        independent = independent or [False] * len(dispositions)
        blocked = False
        for i, disp in enumerate(dispositions):
            if blocked and not independent[i]:
                result[i] = DISPOSITION_NOT_RUN
            elif disp in _FAILURE_DISPOSITIONS:
                blocked = True
        return result
    # STOP_ON_FAILURE
    blocked = False
    for i, disp in enumerate(dispositions):
        if blocked:
            result[i] = DISPOSITION_NOT_RUN
        elif disp in _FAILURE_DISPOSITIONS:
            blocked = True
    return result
