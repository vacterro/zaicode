"""Producer severity policy: the one mapping from gate to severity (T-568).

The rule the gate restores: a producer's package must be complete, fresh and
role-current WHEN IT IS CONSUMED, or when the convergence closure explicitly
requires it fresh -- never as a precondition for editing one Core line.

Severity is a property of the ACTIVE GATE, not of the finding:

  core (default) / ship / crew   every producer finding is a visible WARN.
  collect:<producer>             that producer is hard; every finding class is
                                 a FAIL for it and a WARN for every other.
  converge                       the closure-required producers are hard,
                                 every finding class included.

The input contract is closed on all three axes. An unknown gate kind, a
malformed gate string, or an unknown finding class raises ValueError instead
of falling back to the soft default: a typo'd `collect:saiwki` that silently
ran the soft gate would report green on exactly the package the caller asked
to hard-check. The CLI keeps its exit-2 refusal by catching that error in
`tools/validate.py:_parse_gate`.

This module is side-effect-free and imported by both tools/validate.py and
the in-process test matrix, so the validator and the tests can never disagree
about what the policy says.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: Closed gate kinds. `crew` behaves like the soft gates today: the crew gate
#: judges crew evidence, not producer packages.
GATE_KINDS = frozenset({"core", "ship", "converge", "collect", "crew"})

#: Closed producer finding classes. The truth table currently gives every
#: class the same row per gate; the class stays in the contract so the matrix
#: proves the complete surface instead of one representative column.
FINDING_CLASSES = frozenset(
    {"MALFORMED", "STALE", "INCOMPLETE", "NOT_READY", "MISSING"}
)

#: The validator's producer finding slugs, mapped to their policy class. An
#: unmapped slug is a bug: callers fail closed rather than guess a severity.
SLUG_FINDING_CLASS = {
    "producer-package-malformed": "MALFORMED",
    "producer-package-stale": "STALE",
    "producer-package-incomplete": "INCOMPLETE",
    "producer-package-not-ready": "NOT_READY",
    "producer-package-missing": "MISSING",
}

#: The convergence closure's required producers, named rather than discovered:
#: `--gate converge` must not depend on which producer folders happen to exist
#: in a given project, or a closure could pass by deleting the producer
#: instead of refreshing it. The single canonical roster; validate.py and the
#: tests import it, never restate it.
CONVERGE_REQUIRED_PRODUCERS = ("saitranslate", "saiwiki")

#: Display labels used only in the converge diagnostic text.
CONVERGE_LABELS = {"saitranslate": "EE", "saiwiki": "QQ"}

_PRODUCER_RE = re.compile(r"[a-z][a-z0-9_-]*\Z")


@dataclass(frozen=True)
class GateContext:
    """The parsed gate state a producer finding is assessed under."""

    kind: str
    producer: str | None = None

    def __post_init__(self):
        if self.kind not in GATE_KINDS:
            raise ValueError(f"unknown gate kind {self.kind!r}")
        if self.kind == "collect":
            if not self.producer or not _PRODUCER_RE.fullmatch(self.producer):
                raise ValueError(
                    "--gate collect:<producer> needs a producer name, "
                    f"got {self.producer!r}"
                )
        elif self.producer is not None:
            raise ValueError(f"gate {self.kind!r} takes no producer")


def parse_gate_context(raw: str | None) -> GateContext:
    """Parse one --gate value into a GateContext, refusing everything else.

    None means the default core gate. The ValueError messages are the exact
    CLI refusal texts so validate.py can print them unchanged.
    """
    if raw is None:
        return GateContext("core")
    if raw in ("core", "ship", "converge", "crew"):
        return GateContext(raw)
    if raw.startswith("collect:"):
        return GateContext("collect", raw.split(":", 1)[1])
    raise ValueError(
        f"unknown --gate {raw!r} -- one of: core (default), ship, "
        "collect:<producer>, converge, crew"
    )


def severity(gate: GateContext, producer: str | None, finding_class: str) -> str:
    """The full truth table: gate x producer x finding class -> WARN or FAIL.

    Pure and side-effect-free. Unknown finding classes raise ValueError; the
    gate context is already validated by construction.
    """
    if finding_class not in FINDING_CLASSES:
        raise ValueError(f"unknown producer finding class {finding_class!r}")
    if gate.kind == "collect":
        return "FAIL" if producer == gate.producer else "WARN"
    if gate.kind == "converge":
        return "FAIL" if producer in CONVERGE_REQUIRED_PRODUCERS else "WARN"
    return "WARN"


def finding_class_for_slug(slug: str) -> str:
    """Map a validator finding slug to its policy class, failing closed."""
    finding = SLUG_FINDING_CLASS.get(slug)
    if finding is None:
        raise ValueError(f"unknown producer finding slug {slug!r}")
    return finding
