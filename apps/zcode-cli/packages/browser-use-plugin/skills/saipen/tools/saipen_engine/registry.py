"""Loader for SAIPEN's machine-owned protocol registry.

REGISTRY.json owns closed executable facts. Runtime code may derive constants
from it, but must never recover missing facts by scraping English prose.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class RegistryError(ValueError):
    """The canonical registry is absent or structurally unusable."""


def registry_path(protocol_dir: Path | str | None = None) -> Path:
    if protocol_dir is not None:
        return Path(protocol_dir) / "REGISTRY.json"

    from .paths import resolve_protocol_dir, resolve_tool_root

    return resolve_protocol_dir(resolve_tool_root()) / "REGISTRY.json"


def load_registry(
    protocol_dir: Path | str | None = None, *, required: bool = True
) -> dict[str, Any]:
    """Return the canonical registry; never fall back to prose."""
    path = registry_path(protocol_dir)
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        if required:
            raise RegistryError(f"cannot load {path}: {exc}") from exc
        return {}
    if not isinstance(data, dict):
        if required:
            raise RegistryError(f"{path} root is not an object")
        return {}
    if data.get("kind") != "saipen-machine-registry" or data.get("schema_version") != 1:
        if required:
            raise RegistryError(f"{path} has unsupported identity/schema")
        return {}
    return data


def require_mapping(registry: dict[str, Any], key: str) -> dict[str, Any]:
    value = registry.get(key)
    if not isinstance(value, dict):
        raise RegistryError(f"REGISTRY.json `{key}` must be an object")
    return value


def require_string_list(container: dict[str, Any], key: str) -> tuple[str, ...]:
    value = container.get(key)
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise RegistryError(f"REGISTRY.json `{key}` must be a string array")
    return tuple(value)
