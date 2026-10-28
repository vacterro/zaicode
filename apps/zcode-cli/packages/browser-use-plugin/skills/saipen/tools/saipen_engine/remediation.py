"""ONE remediation contract for validator-emitted repairs (T-1434 M5).

The defect this module exists to make impossible: a validator FAIL whose own
remediation text names a command that does not exist, a docs-only verb, an
internal Python function, or a generic `saipen validate` loop when a specific
repair exists. Git history is the evidence -- the class produced T-1434 itself.

The contract is CLOSED and machine-readable:

  * every actionable remediation the validator emits resolves to exactly one
    of two kinds -- ``command`` (a REGISTERED canonical CLI verb, classified
    in COMMAND_EFFECTS.json, dispatched by tools/saipen.py) or ``external``
    (an explicitly typed action that needs an actor SAIPEN is not);
  * nothing else is a legal remediation. Free prose is never a route, and an
    unregistered command can never be emitted.

Consumers:
  * ``validate.py`` extracts remediation commands from its OWN failure
    messages through :func:`extract_commands`, so the conformance receipt can
    only ever carry commands this table admits;
  * ``conformance.generate_conformance_receipt`` records them (plus the typed
    external list) in the receipt the router leads with;
  * ``tools/test_remediation_self_consistency.py`` proves the invariant
    mechanically for every table entry (registry, effects, parser/dispatch,
    docs/help) and executes the safe transitions end to end.
"""

from __future__ import annotations

import re

#: The closed remediation kinds. A third value is a protocol error.
REMEDIATION_KINDS = ("command", "external")

#: T-1435 M7: the closed ROUTE classification every repairable hard finding
#: must resolve to. One owner, so "no dead end" is mechanically checkable
#: instead of a promise: a finding that fits none of these classes must be
#: classified explicitly immutable/unrepairable, never left with prose.
ROUTE_KINDS = (
    "CANONICAL_COMMAND",  # a registered saipen verb the operator/agent runs
    "OPERATOR_AUTHORIZED_COMMAND",  # exact maintenance command outside saipen
    "PRODUCER_OWNED_COMMAND",  # the producer's own writer reconciles it
    "IMMUTABLE_CLASSIFIED",  # deliberately unrepairable; the class is recorded
)

#: The closed external-action vocabulary. An external action is a real,
#: typed requirement on an actor outside the project -- never a command
#: dressed up as one, and never inferred from free prose.
EXTERNAL_ACTION_KINDS = (
    "OPERATOR_GUI_VERIFICATION",
    "UNAVAILABLE_UPSTREAM_CREDENTIAL",
    "EXTERNAL_PUBLICATION_AUTHORITY",
    "EXTERNAL_PROJECT_OBSERVATION",
)


class RemediationSpec:
    """ONE validator rule's lawful repair, closed and mechanically checkable.

    ``pattern`` matches the exact command text the validator emits (the
    already-substituted form, e.g. ``saipen work reverify T-008``);
    ``template`` is the same command with its variable parts in ``<...>``;
    ``verb``/``action`` name the registry identity the gate resolves.
    """

    __slots__ = (
        "action",
        "external_kind",
        "extract",
        "kind",
        "owner",
        "pattern",
        "route_kind",
        "rule",
        "template",
        "verb",
    )

    def __init__(
        self,
        rule: str,
        *,
        kind: str = "command",
        pattern: re.Pattern | None = None,
        template: str = "",
        verb: str = "",
        action: str | None = None,
        external_kind: str | None = None,
        owner: str = "",
        route_kind: str = "CANONICAL_COMMAND",
        extract: bool = True,
    ):
        if kind not in REMEDIATION_KINDS:
            raise ValueError(f"remediation kind {kind!r} outside {REMEDIATION_KINDS}")
        if route_kind not in ROUTE_KINDS:
            raise ValueError(f"remediation route {route_kind!r} outside {ROUTE_KINDS}")
        if kind == "external":
            if external_kind not in EXTERNAL_ACTION_KINDS:
                raise ValueError(f"external kind {external_kind!r} outside {EXTERNAL_ACTION_KINDS}")
            if template or verb:
                raise ValueError("an external remediation never carries a command shape")
        else:
            if not pattern or not template:
                raise ValueError("a command remediation needs pattern and template")
            if not verb and route_kind != "OPERATOR_AUTHORIZED_COMMAND":
                raise ValueError("a canonical/producer command remediation needs a verb")
        self.rule = rule
        self.kind = kind
        self.pattern = pattern
        self.template = template
        self.verb = verb
        self.action = action
        self.external_kind = external_kind
        self.owner = owner
        self.route_kind = route_kind
        self.extract = extract

    def to_dict(self) -> dict:
        return {
            "rule": self.rule,
            "kind": self.kind,
            "template": self.template,
            "verb": self.verb,
            "action": self.action,
            "external_kind": self.external_kind,
            "owner": self.owner,
            "route_kind": self.route_kind,
        }


def _cmd(
    rule: str,
    pattern: str,
    template: str,
    verb: str,
    action: str | None,
    owner: str,
    *,
    route_kind: str = "CANONICAL_COMMAND",
    extract: bool = True,
):
    return RemediationSpec(
        rule,
        kind="command",
        pattern=re.compile(pattern),
        template=template,
        verb=verb,
        action=action,
        owner=owner,
        route_kind=route_kind,
        extract=extract,
    )


#: The closed table of actionable CURRENT repairs the validator can emit.
#: Every entry names the rule identity, the exact command shape, the registry
#: verb/action it must resolve to, and the implementation owner.
REMEDIATIONS = (
    _cmd(
        "source credentials",
        r"saipen source quarantine SRC-\d+ --reason CREDENTIAL_PATTERN",
        "saipen source quarantine <SRC-###> --reason CREDENTIAL_PATTERN",
        "source",
        "quarantine",
        "tools/saipen_engine/intake.py",
    ),
    _cmd(
        "closure-evidence",
        r"saipen work reverify T-\d+",
        "saipen work reverify <T-###>",
        "work",
        "reverify",
        "tools/saipen_engine/debt.py",
    ),
    _cmd(
        "closure-provenance:external-generation",
        r"saipen ticket resolve-external T-\d+",
        "saipen ticket resolve-external <T-###> --authority <lineage-32hex> "
        "--implementation <T-###@commit> --reason <CLASS> --run <command>",
        "ticket",
        "resolve-external",
        "tools/saipen_engine/external.py",
    ),
    _cmd(
        "legacy metadata:exact",
        r"saipen ticket repair-metadata T-\d+ --field source_receipts --to SRC-\d+",
        "saipen ticket repair-metadata <T-###> --field source_receipts --to <SRC-###>",
        "ticket",
        "repair-metadata",
        "tools/saipen_engine/metadata_repair.py",
    ),
    _cmd(
        "legacy metadata:unbound",
        r"saipen ticket repair-metadata T-\d+ --field source_receipts "
        r"--legacy-unbound --authority lineage-[0-9a-f]{32}",
        "saipen ticket repair-metadata <T-###> --field source_receipts "
        "--legacy-unbound --authority <lineage-32hex>",
        "ticket",
        "repair-metadata",
        "tools/saipen_engine/metadata_repair.py",
    ),
    _cmd(
        "runtime namespace:tracked",
        r"git rm -r --cached -- .+",
        "git rm -r --cached -- <paths>",
        "",
        None,
        "tools/saipen_engine/runtime_namespace.py",
        route_kind="OPERATOR_AUTHORIZED_COMMAND",
        extract=False,
    ),
    _cmd(
        "producer lifecycle:terminal",
        r"saipen sub reconcile [A-Za-z0-9_-]+ --authority SRC-\d+",
        "saipen sub reconcile <role> --authority <SRC-###>",
        "sub",
        "reconcile",
        "tools/saipen_engine/subs.py",
        route_kind="PRODUCER_OWNED_COMMAND",
    ),
    _cmd(
        "core sweep:sweep-ticket-link",
        r"saipen ticket reasoning T-\d+",
        "saipen ticket reasoning <T-###> --recurrence <text> --weak-model <text>",
        "ticket",
        "reasoning",
        "tools/saipen_engine/operations.py",
    ),
    _cmd(
        "improve report",
        r"saipen improve reconcile [A-Za-z0-9_-]+",
        "saipen improve reconcile <cycle>",
        "improve",
        "reconcile",
        "tools/improve.py",
    ),
    _cmd(
        "source receipts",
        r"saipen source retire SRC-\d+",
        "saipen source retire <SRC-###> --reason <CLASS>",
        "source",
        "retire",
        "tools/saipen_engine/operations.py",
    ),
    _cmd(
        "source coverage",
        r"saipen source recover",
        "saipen source recover",
        "source",
        "recover",
        "tools/saipen_engine/intake.py",
    ),
)


def specs_by_rule() -> dict:
    return {spec.rule: spec for spec in REMEDIATIONS}


def external_action(kind: str, detail: str) -> dict:
    """ONE typed external remediation record.

    The shape machine consumers read to distinguish ``executable now`` from
    ``requires external actor``: ``kind`` is never ``command``, so a consumer
    can never dispatch it as one.
    """
    if kind not in EXTERNAL_ACTION_KINDS:
        raise ValueError(f"external action kind {kind!r} outside {EXTERNAL_ACTION_KINDS}")
    return {"kind": "external", "external_kind": kind, "detail": str(detail).strip()[:240]}


def extract_commands(failures) -> list[str]:
    """Bounded executable commands found in THIS run's failure messages.

    Only table-admitted shapes survive, deduplicated, order-preserving and
    capped -- a receipt is evidence, not a log. A failure message can never
    smuggle an unregistered command into the receipt, because only the closed
    patterns below are ever extracted.
    """
    found: list[str] = []
    seen: set[str] = set()
    for message in failures or ():
        text = str(message)
        for spec in REMEDIATIONS:
            if not spec.extract:
                continue
            for match in spec.pattern.finditer(text):
                command = match.group(0).strip()
                if command not in seen:
                    seen.add(command)
                    found.append(command)
        if len(found) >= 10:
            break
    return found[:10]


def resolve_command(command: str) -> dict:
    """Resolve ONE emitted command string to its table identity or refuse.

    Returns ``{"ok": True, "kind": "command", "rule", "template", "verb",
    "action"}`` or ``{"ok": False, "code": "REMEDIATION_UNREGISTERED"}``.
    """
    text = str(command or "").strip()
    for spec in REMEDIATIONS:
        if spec.pattern.fullmatch(text):
            return {
                "ok": True,
                "kind": "command",
                "rule": spec.rule,
                "template": spec.template,
                "verb": spec.verb,
                "action": spec.action,
                "route_kind": spec.route_kind,
            }
    return {
        "ok": False,
        "kind": None,
        "code": "REMEDIATION_UNREGISTERED",
        "detail": f"{text!r} matches no registered remediation shape",
    }


def is_external(record) -> bool:
    """Machine-readable test for the external class (never a string guess)."""
    return isinstance(record, dict) and record.get("kind") == "external" and (
        record.get("external_kind") in EXTERNAL_ACTION_KINDS
    )
