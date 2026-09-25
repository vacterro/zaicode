#!/usr/bin/env python
"""Optional USERPERSON preference profile mechanics (T-574, T-577).

USERPERSON is a meta-control, OFF by default. Its only sources are the
deterministic global user-configuration ``USERPERSON.md`` and the bound
project's ``.saipen/USERPERSON.md``. With neither present the protocol is
silent: no warning, boot failure, placeholder, onboarding, directory, file,
or cold-start surface. A source is created only after explicit user mutation.

This module is the mechanical core: resolve / safely load / parse / render /
merge / remove / validate / effective composition / projection / global
atomic persistence. It NEVER claims to understand natural-language
semantics. Preference identity is STRUCTURED (a category key plus the exact
preference text); the merge is deterministic lexical dedup on that identity,
and semantic distillation (recognizing that two differently-worded preferences
mean the same thing) is the AGENT's job BEFORE calling this writer, per
saipen/IMPROVE.md section 8 and the T-577 regression. A helper that split
natural language on a separator and called the result "semantic" silently
discarded distinct preferences such as "Prefer UI: Vintage Golden" and
"Prefer UI: Material Design" (both reduced to "prefer ui") -- that false
equivalence is the defect this format fixes.

Canonical file format (`.saipen/USERPERSON.md`):

    # USERPERSON

    - [Category] preference text

Every preference is a markdown bullet with a bracketed category key and the
preference text. Legacy bullets without a category parse as category
`General`. A preference's identity is `(category, normalized full text)`; two
preferences that differ in either are distinct and BOTH are kept.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path

PROFILE_PATH = ".saipen/USERPERSON.md"
GLOBAL_PROFILE_NAME = "USERPERSON.md"
GLOBAL_CONFIG_ENV = "SAIPEN_USER_CONFIG_HOME"
_MAX_PROFILE_BYTES = 8 * 1024 * 1024
_HEADER = "# USERPERSON"
_LEGACY_CATEGORY = "general"
_BULLET_PREFIXES = ("- ", "* ")

# Category policies per SubSaipen role. A projection selects only preferences
# whose category is in the role's policy -- never the whole profile. saihunt
# deliberately excludes UI/presentation categories unless the investigation
# makes a specific category relevant, and that relevance is recorded by the
# agent in the projection handoff, never invented by the helper.
_PROJECTION_POLICIES = {
    "saiui": {"ui", "workflow"},
    "saitranslate": {"localization", "language"},
    "saiwiki": {"documentation", "communication"},
    "saihunt": {"automation"},
}

_ONBOARDING_QUESTIONS = [
    "How do you prefer decisions between equivalent options to be made, "
    "for example safer and slower versus bolder and faster?",
    "What should the default presentation and tone be for the work this project produces?",
]

_CATEGORY_RE = re.compile(r"^\[([^\]]+)\]\s*(.*)$", re.DOTALL)


def _redact_credentials(text: str) -> str:
    """T-1015/T-1101: delegate to the shared persistence-boundary primitive.

    The canonical implementation lives in saipen_engine.codec.redact_credentials
    so credential exclusion is a single invariant, not a fragmentary per-module
    concern. This wrapper preserves the existing local call-site contract.
    """
    from saipen_engine.codec import redact_credentials
    return redact_credentials(text)


def _canonical(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip()).lower()


def _entry(category: str, text: str) -> dict:
    # T-1015: redact before any processing, persistence, or logging
    safe_text = _redact_credentials(text.strip())
    entry = {"category": category.strip(), "text": safe_text}
    identity = _canonical(f"{entry['category']}: {entry['text']}")
    entry["id"] = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
    return entry


def _split_line(line: str) -> dict | None:
    stripped = line.strip()
    if not stripped.startswith(_BULLET_PREFIXES):
        return None
    body = stripped[2:].strip()
    match = _CATEGORY_RE.match(body)
    if match:
        return _entry(match.group(1), match.group(2).strip())
    return _entry(_LEGACY_CATEGORY, body)


def parse_profile(text: str) -> dict:
    """Parse the canonical file into a preference list.

    Each entry: `id` (content hash), `category`, `text`. Round-trips with
    `render_profile`.
    """
    lines = text.splitlines()
    preferences = []
    if lines and lines[0] == _HEADER:
        for line in lines[1:]:
            entry = _split_line(line)
            if entry is not None:
                preferences.append(entry)
    return {"preferences": preferences}


def render_profile(preferences: list[dict] | list[str]) -> str:
    body_lines = []
    for preference in preferences:
        if isinstance(preference, dict):
            body_lines.append(f"- [{preference['category']}] {preference['text']}")
        elif preference.strip().startswith("- "):
            body_lines.append(preference.strip())
        elif preference.strip().startswith("* "):
            entry = _split_line(preference)
            if entry is not None:
                body_lines.append(f"- [{entry['category']}] {entry['text']}")
        else:
            body_lines.append(f"- [{_LEGACY_CATEGORY}] {preference}")
    body = "\n".join(body_lines)
    return f"{_HEADER}\n\n{body}\n" if body else f"{_HEADER}\n\n"


def merge_profile(current: list[dict] | list[str], additions: list[dict] | list[str]) -> list[dict]:
    """Deterministic lexical merge on structured preference identity.

    Two preferences are the same when category AND normalized full text are
    identical. Anything else is distinct and kept. The helper never decides
    that differently-worded preferences mean the same thing -- the agent
    distills semantics BEFORE calling this writer (T-577).
    """

    def _to_entry(value: dict | str) -> dict | None:
        if isinstance(value, dict):
            return _entry(value["category"], value["text"])
        stripped = value.strip()
        if stripped.startswith(_BULLET_PREFIXES):
            return _split_line(stripped)
        return _entry(_LEGACY_CATEGORY, stripped)

    result = [_to_entry(p) for p in current]
    result = [e for e in result if e is not None and e["text"]]
    keys = {_canonical(f"{e['category']}: {e['text']}") for e in result}
    for addition in additions:
        entry = _to_entry(addition)
        if entry is None or not entry["text"]:
            continue
        key = _canonical(f"{entry['category']}: {entry['text']}")
        if key in keys:
            continue
        result.append(entry)
        keys.add(key)
    return result


def remove_preference(
    current: list[dict], text: str, category: str | None = None
) -> tuple[list[dict], str | None]:
    """Remove one preference by its identity `(category, text)`.

    The preference identity is the pair, so removal must be category-aware:
    `[ui] X` and `[workflow] X` are two distinct entries and one remove must
    not bulk-delete both. `category=None` means the caller did NOT supply a
    category: a unique text match may be removed, but an AMBIGUOUS
    multi-category text match must refuse (the caller must scope it) instead
    of silently deleting every entry with that text.

    Returns (new_list, refusal-or-None): refusal is set when the remove is
    ambiguous and no write may happen.
    """
    target = _canonical(text)
    matches = [p for p in current if _canonical(p.get("text", "")) == target]
    if not matches:
        return current, None
    if category is not None:
        wanted = _canonical(category)
        return (
            [
                p
                for p in current
                if not (
                    _canonical(p.get("text", "")) == target
                    and _canonical(p.get("category", "")) == wanted
                )
            ],
            None,
        )
    if len(matches) > 1:
        cats = sorted({_canonical(p.get("category", "")) for p in matches})
        return (
            current,
            f"remove is ambiguous: {len(matches)} entries share text "
            f"{text!r} across categories {cats}; pass "
            "--category <name> to scope the removal",
        )
    return ([p for p in current if p not in matches], None)


def validate_profile(text: str) -> list[str]:
    """Return every structural violation, empty when the profile is valid."""
    errors = []
    lines = text.splitlines()
    if not lines or lines[0] != _HEADER:
        errors.append("USERPERSON file must open with the exact heading '# USERPERSON'")
        return errors
    for index, line in enumerate(lines[1:], 2):
        if not line.strip():
            continue
        if not line.lstrip().startswith(_BULLET_PREFIXES):
            errors.append(
                f"line {index}: every preference must be a markdown bullet "
                "starting '- ' or legacy '* '"
            )
            continue
        entry = _split_line(line)
        if entry is None or not entry["text"]:
            errors.append(f"line {index}: preference text must not be empty")
            continue
        if not entry["category"].strip():
            errors.append(f"line {index}: preference category must not be empty")
    preferences = parse_profile(text)["preferences"]
    seen = set()
    for entry in preferences:
        key = _canonical(f"{entry['category']}: {entry['text']}")
        if key in seen:
            errors.append(
                "duplicate preference -- `saipen userperson add` "
                "merges deterministically on category and exact "
                "text, never by guessing meaning"
            )
            break
        seen.add(key)
    return errors


def projection_policy(role: str) -> frozenset[str]:
    """The allowed preference categories for a SubSaipen role, or empty."""
    return frozenset(_PROJECTION_POLICIES.get(role, set()))


def project_profile(preferences: list[dict], role: str, source_fingerprint: str = "") -> dict:
    """Produce the actual bounded projection for a role.

    Returns a structured handoff: the role, the allowed categories, the source
    profile fingerprint, and ONLY the preferences whose category is in the
    policy. Never the whole profile. The handoff is auditable by Core
    (saipen/IMPROVE.md section 8).
    """
    policy = projection_policy(role)
    selected = [entry for entry in preferences if entry["category"].strip().lower() in policy]
    return {
        "role": role,
        "projection_policy": sorted(policy),
        "source_fingerprint": source_fingerprint,
        "preferences": selected,
    }


def profile_fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def onboarding_questions() -> list[str]:
    """At most three broad onboarding questions; prefer two."""
    return list(_ONBOARDING_QUESTIONS)


def profile_path(project_root: Path | str) -> Path:
    return Path(project_root) / PROFILE_PATH


class UserpersonError(ValueError):
    """Controlled profile/path failure safe for direct CLI projection."""

    def __init__(self, code: str, detail: str, *, scope: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.scope = scope


def user_config_home(
    override: Path | str | None = None,
    *,
    environ: dict[str, str] | None = None,
    platform: str | None = None,
    home: Path | str | None = None,
) -> Path:
    """Resolve the one global SAIPEN user-configuration directory.

    No directory is created. The resolver never searches disks and never uses
    ``.saipen`` or ``saipen_home``. Dependency-injection arguments keep tests
    hermetic without consulting a developer's real profile.
    """
    try:
        env = os.environ if environ is None else environ
        selected = override if override is not None else env.get(GLOBAL_CONFIG_ENV)
        if selected is not None:
            raw = str(selected).strip()
            if not raw:
                raise UserpersonError(
                    "USER_CONFIG_INVALID",
                    f"{GLOBAL_CONFIG_ENV} is empty",
                    scope="global",
                )
            return Path(raw).expanduser().resolve()

        system = os.name if platform is None else platform
        actual_home = Path(home).expanduser() if home is not None else Path.home()
        if system == "nt":
            appdata = str(env.get("APPDATA", "")).strip()
            base = (
                Path(appdata).expanduser()
                if appdata
                else actual_home / "AppData" / "Roaming"
            )
            return (base / "SAIPEN").resolve()
        xdg = str(env.get("XDG_CONFIG_HOME", "")).strip()
        base = Path(xdg).expanduser() if xdg else actual_home / ".config"
        return (base / "saipen").resolve()
    except UserpersonError:
        raise
    except (OSError, RuntimeError) as exc:
        raise UserpersonError(
            "USER_CONFIG_INVALID",
            f"cannot resolve global USERPERSON configuration: {exc}",
            scope="global",
        ) from exc


def global_profile_path(user_config_home: Path | str | None = None) -> Path:
    return user_config_home_resolved(user_config_home) / GLOBAL_PROFILE_NAME


def user_config_home_resolved(value: Path | str | None = None) -> Path:
    """Resolve an injected home or the canonical environment/platform home."""
    return user_config_home(value) if value is not None else user_config_home()


def _profile_node_bytes(path: Path, *, scope: str) -> bytes | None:
    """Read one stable, regular, in-scope profile node without following links."""
    from saipen_engine.paths import read_bound_regular_bytes

    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise UserpersonError(
            "USERPERSON_PATH_INVALID", f"cannot inspect {scope} USERPERSON: {exc}", scope=scope
        ) from exc
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if (
        not stat.S_ISREG(info.st_mode)
        or path.is_symlink()
        or bool(getattr(info, "st_file_attributes", 0) & reparse)
    ):
        raise UserpersonError(
            "USERPERSON_PATH_INVALID",
            f"{scope} USERPERSON must be a regular non-link file",
            scope=scope,
        )
    try:
        return read_bound_regular_bytes(path, info, max_bytes=_MAX_PROFILE_BYTES)
    except (OSError, ValueError) as exc:
        raise UserpersonError(
            "USERPERSON_PATH_INVALID", f"cannot safely read {scope} USERPERSON: {exc}", scope=scope
        ) from exc


def load_profile(path: Path, *, scope: str) -> dict:
    """Load and strictly validate one optional profile without side effects."""
    raw = _profile_node_bytes(path, scope=scope)
    if raw is None:
        return {
            "scope": scope,
            "present": False,
            "fingerprint": "",
            "preferences": [],
            "bytes": 0,
            "text": "",
        }
    try:
        text = raw.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as exc:
        raise UserpersonError(
            "USERPERSON_MALFORMED",
            f"{scope} USERPERSON is not valid UTF-8",
            scope=scope,
        ) from exc
    errors = validate_profile(text)
    if errors:
        raise UserpersonError(
            "USERPERSON_MALFORMED",
            f"{scope} USERPERSON is malformed: {'; '.join(errors[:5])}"
            + (f"; +{len(errors) - 5} more" if len(errors) > 5 else ""),
            scope=scope,
        )
    return {
        "scope": scope,
        "present": True,
        "fingerprint": profile_fingerprint(text),
        "preferences": parse_profile(text)["preferences"],
        "bytes": len(raw),
        "text": text,
    }


def load_project_profile(project_root: Path | str) -> dict:
    return load_profile(profile_path(project_root), scope="project")


def load_global_profile(user_config_home: Path | str | None = None) -> dict:
    return load_profile(global_profile_path(user_config_home), scope="global")


def effective_profile(
    project_root: Path | str, user_config_home: Path | str | None = None
) -> dict:
    """Compose global + project profiles mechanically, project-first.

    Exact structured duplicates collapse to the project copy. Lexically
    different entries survive even when a human might consider them in
    conflict; Python does not invent semantic authority.
    """
    global_source = load_global_profile(user_config_home)
    project_source = load_project_profile(project_root)
    preferences: list[dict] = []
    seen: set[str] = set()
    for source in (project_source, global_source):
        for item in source["preferences"]:
            key = _canonical(f"{item['category']}: {item['text']}")
            if key in seen:
                continue
            seen.add(key)
            preferences.append({**item, "source": source["scope"]})
    identity = {
        "global": {
            "present": global_source["present"],
            "fingerprint": global_source["fingerprint"],
        },
        "project": {
            "present": project_source["present"],
            "fingerprint": project_source["fingerprint"],
        },
        "preferences": preferences,
    }
    effective_fingerprint = hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()[:16]
    return {
        "active": bool(global_source["present"] or project_source["present"]),
        "global": identity["global"],
        "project": identity["project"],
        "effective_fingerprint": effective_fingerprint,
        "preferences": preferences,
        "sources": {"global": global_source, "project": project_source},
    }


def effective_projection(
    project_root: Path | str, role: str, user_config_home: Path | str | None = None
) -> dict:
    """Bounded role projection from the effective two-layer profile."""
    effective = effective_profile(project_root, user_config_home)
    projection = project_profile(
        effective["preferences"], role, source_fingerprint=effective["effective_fingerprint"]
    )
    projection["active"] = effective["active"]
    return projection


def _sync_parent(path: Path) -> None:
    """Persist a directory-entry mutation where directory fsync is available."""
    if os.name == "nt":
        return
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_replace(path: Path, text: str) -> None:
    """UTF-8 same-directory atomic replacement with a durable file flush."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_temp = tempfile.mkstemp(prefix=".USERPERSON.", suffix=".tmp", dir=path.parent)
    temp_path = Path(raw_temp)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(text.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        _sync_parent(path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp_path.unlink()


def _global_lock(home: Path):
    from saipen_engine.lock import file_writer_lock

    return file_writer_lock(home / "locks" / "userperson.lock", home)


def mutate_global_profile(
    action: str,
    *,
    text: str = "",
    category: str | None = None,
    user_config_home: Path | str | None = None,
) -> dict:
    """Apply one validated global add/remove/reset outside project state."""
    home = user_config_home_resolved(user_config_home)
    path = home / GLOBAL_PROFILE_NAME
    before = load_profile(path, scope="global")
    if action == "reset" and not before["present"]:
        return {
            "ok": False,
            "code": "TICKET_NOT_FOUND",
            "scope": "global",
            "detail": "no profile to reset",
        }
    if action not in {"add", "remove", "reset"}:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "scope": "global",
            "detail": f"unknown global USERPERSON mutation {action!r}",
        }
    if action in {"add", "remove"} and not text.strip():
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "scope": "global",
            "detail": f"userperson {action} needs non-empty text",
        }
    if action == "remove" and not before["present"]:
        return {
            "ok": True,
            "code": "UNCHANGED",
            "scope": "global",
            "present": False,
            "changed": False,
            "preferences": [],
        }

    from saipen_engine.lock import FileLockBusy

    try:
        with _global_lock(home):
            current = load_profile(path, scope="global")
            preferences = current["preferences"]
            if action == "reset":
                try:
                    path.unlink()
                except FileNotFoundError:
                    return {
                        "ok": False,
                        "code": "TICKET_NOT_FOUND",
                        "scope": "global",
                        "detail": "no profile to reset",
                    }
                _sync_parent(path)
                return {
                    "ok": True,
                    "code": "RESET",
                    "scope": "global",
                    "present": False,
                    "preferences": [],
                }
            if action == "add":
                updated = merge_profile(
                    preferences,
                    [{"category": category or _LEGACY_CATEGORY, "text": text}],
                )
            else:
                updated, refusal = remove_preference(preferences, text, category)
                if refusal:
                    return {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "scope": "global",
                        "detail": refusal,
                    }
            rendered = render_profile(updated)
            errors = validate_profile(rendered)
            if errors:
                return {
                    "ok": False,
                    "code": "USERPERSON_MALFORMED",
                    "scope": "global",
                    "detail": "; ".join(errors),
                }
            changed = rendered != current["text"]
            if changed:
                _atomic_replace(path, rendered)
            return {
                "ok": True,
                "code": "ADDED" if action == "add" else "REMOVED",
                "scope": "global",
                "present": True,
                "changed": changed,
                "fingerprint": profile_fingerprint(rendered),
                "preferences": updated,
            }
    except FileLockBusy as exc:
        return {"ok": False, "code": "WRITER_BUSY", "scope": "global", "detail": str(exc)}
    except PermissionError as exc:
        return {
            "ok": False,
            "code": "USER_CONFIG_INVALID",
            "scope": "global",
            "detail": f"global USERPERSON path is not writable: {exc}",
        }
    except UserpersonError as exc:
        return {
            "ok": False,
            "code": exc.code,
            "scope": exc.scope,
            "detail": exc.detail,
        }
    except OSError as exc:
        return {
            "ok": False,
            "code": "USERPERSON_WRITE_FAILED",
            "scope": "global",
            "detail": f"global USERPERSON write failed: {exc}",
        }


def write_profile(project_root: Path | str, text: str, agent: str = "saipen") -> dict:
    """Write the profile through the common lock + journal + roll-forward
    machinery (NITRO M7). One ATOMIC_FILE target, exact bytes via the codec,
    before/after hashes, post-write byte verification. Returns the transaction
    result; callers inspect and propagate."""
    import uuid
    from saipen_engine import codec
    from saipen_engine.journal import _hash_file, hash_bytes, run_mutation
    from saipen_engine.lock import project_writer_lock
    from saipen_engine.paths import project_identity

    root = Path(project_root)
    path = root / PROFILE_PATH
    rel = PROFILE_PATH.replace("\\", "/")
    op_id = f"userperson-{uuid.uuid4().hex}"
    doc = codec.read_document(path)
    content_bytes = doc.encode(text)
    before = _hash_file(path) if path.is_file() else ""
    with project_writer_lock(root):
        return run_mutation(
            root,
            op_id,
            "userperson",
            agent,
            project_identity(root),
            hash_bytes(rel.encode("utf-8")),
            [
                {
                    "path": rel,
                    "role": "generic",
                    "content": content_bytes,
                    "before_hash": before,
                    "after_hash": hash_bytes(content_bytes),
                }
            ],
            preconditions={rel: before},
            verification_policy="userperson",
        )


def reset_profile(project_root: Path | str, agent: str = "saipen") -> dict:
    """Delete the profile as ONE journaled `delete_file` operation.

    Reset is a mutation with a real before_hash and an empty after_hash; the
    committed target leaves the file ABSENT (the canonical OFF state), and
    recovery rolls the deletion forward the same way. There is deliberately
    NO post-commit unlink: a crash between COMMIT and unlink previously left
    a state recovery could never complete (T-1003 operational integrity).
    """
    import uuid
    from saipen_engine.journal import _hash_file, hash_bytes, run_mutation
    from saipen_engine.lock import project_writer_lock
    from saipen_engine.paths import project_identity

    root = Path(project_root)
    path = root / PROFILE_PATH
    rel = PROFILE_PATH.replace("\\", "/")
    op_id = f"userperson-reset-{uuid.uuid4().hex}"
    if not path.is_file():
        return {
            "ok": False,
            "code": "TICKET_NOT_FOUND",
            "op_id": op_id,
            "recovery_required": False,
            "detail": "no profile to reset",
        }
    before = _hash_file(path)
    with project_writer_lock(root):
        return run_mutation(
            root,
            op_id,
            "userperson_reset",
            agent,
            project_identity(root),
            hash_bytes(rel.encode("utf-8")),
            [
                {
                    "path": rel,
                    "role": "generic",
                    "action": "delete_file",
                    "before_hash": before,
                    "after_hash": "",
                }
            ],
            preconditions={rel: before},
            verification_policy="userperson",
        )
