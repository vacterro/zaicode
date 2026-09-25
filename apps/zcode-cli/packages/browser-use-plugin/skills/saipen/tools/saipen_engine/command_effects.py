"""One owner for what a `saipen` invocation does to the project (CMD-EFFECT-01).

Every consumer used to keep its own answer to "is this command safe to run in
a blocked project?": the OpenCode plugin carried a regex exception list, the
guard a verb set, and the CLI a mutation table. The three drifted -- `validate`
was read-only in the dispatcher and mutating in the table, `user-request` was
reachable in the guard and Fleet-gated in the plugin -- and the drift is what
made a status probe run recovery and made a new user request unreachable
behind old debt.

The classes are closed and live in the machine-fact file
`REGISTRY.json.command_effects.table` names, beside the registry:

* DIAGNOSTIC -- reads and reports; never needs, and never triggers, recovery.
* INGRESS    -- persists explicit new user intent; reachable under any debt.
* RECOVERY   -- a registered canonical repair; reachable under the debt it
  repairs.
* EXECUTION  -- ordinary work; goes through ordinary execution admission.

The table sits in its own file rather than inside `REGISTRY.json` because the
command ROUTER -- which must read the registry whole to resolve a name to a
route -- never asks what an invocation DOES; the guard and the host adapters
do. Keeping it out of that read is what keeps the `command_resolution` load
budget honest instead of raised to fit.

This module reads the table and answers. It holds no verb list of its own.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence

from .commands import load_shortcut_table, resolve_shortcut
from .registry import (
    RegistryError,
    load_registry,
    registry_path,
    require_mapping,
    require_string_list,
)

DIAGNOSTIC = "DIAGNOSTIC"
INGRESS = "INGRESS"
RECOVERY = "RECOVERY"
EXECUTION = "EXECUTION"

_TICKET_ID = re.compile(r"T-\d+")
#: Global options the CLI strips before dispatch. A classifier that counted
#: them as operands would read `ticket compact T-1 --json` as a different
#: command than the dispatcher runs.
_GLOBAL_FLAGS = frozenset({"--json", "--dry-run"})
_GLOBAL_VALUE_OPTIONS = frozenset({"--project-root", "--agent", "--runtime-info"})


def _load() -> dict:
    pointer = require_mapping(load_registry(), "command_effects")
    name = pointer.get("table")
    if not isinstance(name, str) or "/" in name or "\\" in name or not name.endswith(".json"):
        raise RegistryError("REGISTRY.json command_effects.table must name a sibling .json file")
    path = registry_path().parent / name
    try:
        table = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise RegistryError(f"cannot load {path}: {exc}") from exc
    if (
        not isinstance(table, dict)
        or table.get("kind") != "saipen-command-effects"
        or table.get("schema_version") != 1
    ):
        raise RegistryError(f"{path} has unsupported identity/schema")
    if table.get("rule_id") != pointer.get("rule_id") or table.get("owner") != pointer.get("owner"):
        raise RegistryError(f"{path} does not carry the registry's rule_id/owner")
    classes = require_string_list(table, "classes")
    if set(classes) != {DIAGNOSTIC, INGRESS, RECOVERY, EXECUTION}:
        raise RegistryError("REGISTRY.json command_effects.classes is not the closed set")
    verbs = require_mapping(table, "verbs")
    for verb, entry in verbs.items():
        for value in _entry_classes(entry):
            if value not in classes:
                raise RegistryError(f"command_effects.verbs.{verb} names unknown class {value!r}")
    return table


def _entry_classes(entry: object) -> list[str]:
    if isinstance(entry, str):
        return [entry]
    if not isinstance(entry, dict):
        raise RegistryError("command_effects verb entry must be a class or an object")
    found = [entry.get("default")]
    for sub in (entry.get("subcommands") or {}).values():
        found.append(sub if isinstance(sub, str) else (sub or {}).get("class"))
    return [str(value) for value in found]


_TABLE = _load()
CLASSES = require_string_list(_TABLE, "classes")
UNKNOWN_CLASS = str(_TABLE.get("unknown_class") or EXECUTION)
FLEET_EXEMPT_CLASSES = frozenset(require_string_list(_TABLE, "fleet_exempt_classes"))
HELP_TOKENS = frozenset(require_string_list(_TABLE, "help_tokens"))
INGRESS_PAYLOAD_VERBS = frozenset(require_string_list(_TABLE, "ingress_payload_verbs"))
_VERBS: dict = dict(require_mapping(_TABLE, "verbs"))

#: The execution-policy modifier (EXECUTION.md, `EXEC-HUSH-01`). It is not a
#: verb and has no effect class of its own: it is stripped, and the task it
#: modifies is classified. Imported from its owner so the token cannot drift.
from .hush import MODIFIER as _MODIFIER  # noqa: E402
#: The verbs a shell line may name and still be read as ONE canonical
#: operation. The rest are classified (for the CLI's own mutation gate) but a
#: shell spelling of them stays an ordinary shell effect, as it always was.
SHELL_CANONICAL_VERBS = frozenset(_VERBS) - frozenset(
    require_string_list(_TABLE, "not_shell_canonical")
)


def _operands(tokens: Sequence[str]) -> list[str]:
    """The invocation's own words, with the CLI's global options removed."""
    out: list[str] = []
    skip = False
    for token in tokens:
        if skip:
            skip = False
            continue
        if token in _GLOBAL_FLAGS:
            continue
        if token in _GLOBAL_VALUE_OPTIONS:
            skip = True
            continue
        if any(token.startswith(option + "=") for option in _GLOBAL_VALUE_OPTIONS):
            continue
        out.append(token)
    return out


def _resolve_verb(verb: str, rest: list[str]) -> tuple[str, list[str]]:
    """A shortcut classifies as the command it routes to, payload included.

    A LEADING `hush` is stripped first. EXECUTION.md is explicit that the
    modifier is removed and the task reaches the normal resolver unchanged --
    `hush cc` routes where `cc` routes -- but this classifier did not know the
    word, so `hush` fell to `unknown_class` and every hushed invocation was
    judged EXECUTION. `hush status` then required fleet preparation and was
    refused in read-only capability as though it wrote something. Only the
    leading token is the modifier, and a bare `hush` modifies nothing.
    """
    if verb == _MODIFIER and rest:
        # Exactly ONE leading modifier. A second `hush` is the task, not a
        # second modifier, and a task that is not a verb stays unknown.
        return _resolve_verb(rest[0], rest[1:]) if rest[0] != _MODIFIER else (rest[0], rest[1:])
    if verb in _VERBS:
        return verb, rest
    key = resolve_shortcut(verb, table=load_shortcut_table())
    if key is None:
        return verb, rest
    route = load_shortcut_table().get(key, "").split()
    if len(route) < 2 or route[0] != "saipen":
        return verb, rest
    return route[1], route[2:] + rest


def classify_invocation(verb: str | None, rest: Sequence[str] = ()) -> str:
    """The effect class of `saipen <verb> <rest...>`.

    `verb=None` is bare `saipen`, which the CLI resolves to `continue`. A help
    token anywhere before `--` makes the whole invocation DIAGNOSTIC: the CLI
    answers it with usage and writes nothing, so a help probe must never be
    judged -- or refused -- as the command it is asking about.
    """
    words = _operands(list(rest))
    if "--" in words:
        words = words[: words.index("--")]
    if verb in HELP_TOKENS or any(word in HELP_TOKENS - {"help"} for word in words):
        return DIAGNOSTIC
    if verb == _MODIFIER and not words:
        # A bare modifier modifies nothing and is REPORTED (EXECUTION.md). A
        # report writes nothing, so judging it EXECUTION would demand fleet
        # preparation and a write capability for a refusal message.
        return DIAGNOSTIC
    name, words = _resolve_verb(verb or "continue", words)
    entry = _VERBS.get(name)
    if entry is None:
        return UNKNOWN_CLASS
    if isinstance(entry, str):
        return entry
    default = str(entry.get("default") or UNKNOWN_CLASS)
    sub = words[0] if words and not words[0].startswith("-") else None
    sub_entry = (entry.get("subcommands") or {}).get(sub) if sub else None
    if sub_entry is None:
        return default
    if isinstance(sub_entry, str):
        return sub_entry
    if sub_entry.get("operands") == "one_ticket_id":
        # Exactly the named repair: one canonical ticket id, nothing else. A
        # placeholder or a second operand is not the registered repair.
        if len(words) == 2 and _TICKET_ID.fullmatch(words[1]):
            return str(sub_entry.get("class") or default)
        return default
    return str(sub_entry.get("class") or default)


def classify_tokens(tokens: Sequence[str]) -> str:
    """Class of a tokenized `saipen ...` line (tokens[0] == "saipen")."""
    if not tokens or tokens[0] != "saipen":
        return UNKNOWN_CLASS
    words = _operands(list(tokens[1:]))
    if not words:
        return classify_invocation(None, ())
    return classify_invocation(words[0], words[1:])


def fleet_preflight_required(command_class: str) -> bool:
    """Whether a host must run Fleet preparation before this effect."""
    return command_class not in FLEET_EXEMPT_CLASSES


def routed_verb(token: str, rest: Sequence[str] = ()) -> str:
    """The verb the CLI dispatches `saipen <token> <rest...>` to.

    The CLI resolves a registry shortcut and strips the hush modifier BEFORE
    any dispatch, so `saipen cc` is `saipen continue` and `saipen hush status`
    is `saipen status`.
    """
    return _resolve_verb(token, list(rest))[0]


def is_shell_canonical_verb(token: str, rest: Sequence[str] = ()) -> bool:
    """Whether `saipen <token> <rest...>` names a shell-canonical operation.

    Judged on the verb the CLI dispatches to (`routed_verb`): judging the raw
    token refused the engine's own printed `saipen cc` while the CLI ran it --
    one question, two answers.
    """
    if token in SHELL_CANONICAL_VERBS or token in HELP_TOKENS:
        return True
    verb = routed_verb(token, rest)
    return verb != token and verb in SHELL_CANONICAL_VERBS
