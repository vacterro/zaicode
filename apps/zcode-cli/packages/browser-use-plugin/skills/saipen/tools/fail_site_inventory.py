"""The validator's fail surface, by identity rather than by volume.

`tools/audit_checks.py` recorded one scalar -- how many `fail(...)` sites
`tools/validate.py` declares -- and treated it as the inventory gate. A scalar
binds VOLUME, not IDENTITY: a change that removes one check and adds another
keeps the total, so the gate stays green while the surface underneath it is a
different surface. `tools/test_check_inventory.py` proved that blind spot
rather than closing it (T-1292), and T-1359 closes it.

Identity here is semantic, not positional. A site is named by the qualified
function that encloses it plus the normalized AST of the `fail(...)` call, so
inserting unrelated lines above a check does not rename it, while changing,
moving between functions, deleting or replacing the call does. Line numbers
are report metadata and never identity: the previous session's inventory was
recorded as line numbers and was stale the moment anything above them moved.

The ledger lives beside this module in `validator_fail_sites.json`. Each site
carries one disposition:

  COVERED
      An `audit_checks.CASES` control drives this exact check red on its own
      condition. The record names it, and `audit_checks.check_inventory_probe`
      refuses a name that is not a live CASE -- so a deleted control cannot
      leave a site reading as covered.

      The bound, stated rather than implied: that binding is by NAME. The
      sweep proves the named CASE still drives ITS OWN expectation red, and
      the pairing of that CASE to THIS site was established by measurement
      when the record was written, not re-derived on every run. A CASE
      rewritten to drive a different check red would keep this record
      truthful-looking. Nothing here claims otherwise.
  INTENTIONALLY_NO_MUTATION_CASE
      A file mutation cannot express this site's condition, and the record
      says why. Not a waiver: a reason that names the invariant and what does
      prove it instead.
  BASELINE
      Inherited from the surface that existed before this inventory did, never
      individually adjudicated. Deliberately honest about what has NOT been
      proven -- and closed: the gate lets this set shrink and refuses to let it
      grow, so a NEW check can never arrive as "baseline".
"""

from __future__ import annotations

import ast
import hashlib
import json
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

#: Where the adjudicated inventory lives, relative to a project root.
LEDGER_REL = "tools/validator_fail_sites.json"

#: The validator this inventory owns, relative to a project root.
VALIDATOR_REL = "tools/validate.py"

#: The closed set of dispositions. `BASELINE` is shrink-only (see module docs).
COVERED = "COVERED"
NO_MUTATION_CASE = "INTENTIONALLY_NO_MUTATION_CASE"
BASELINE = "BASELINE"
DISPOSITIONS = (COVERED, NO_MUTATION_CASE, BASELINE)

#: What the regenerator writes for a site it has never seen. Deliberately
#: OUTSIDE `DISPOSITIONS`, so the gate stays red until a human adjudicates it.
#: This is what makes `BASELINE` shrink-only: regeneration cannot mint one, so
#: a new check can never inherit the "never adjudicated" excuse of the old
#: surface. The only way into `BASELINE` is to have been there already.
UNADJUDICATED = "UNADJUDICATED"

SCHEMA_VERSION = 1


@dataclass(frozen=True)
class FailSite:
    """One `fail(...)` call, identified semantically."""

    site_id: str
    qualname: str
    #: Normalized AST of the call, line numbers excluded. Identity input.
    signature: str
    #: Nth identical call inside the same function. Zero for a unique site.
    ordinal: int
    #: Human orientation only. NEVER an identity input.
    line: int
    #: Static text of the first argument, where it is a literal or an f-string
    #: whose literal parts are readable. Empty when the message is computed.
    message: str


def _qualname_map(tree: ast.AST) -> dict[ast.AST, str]:
    """Map every node to the dotted name of the scopes enclosing it."""
    names: dict[ast.AST, str] = {tree: ""}
    stack: list[ast.AST] = [tree]
    while stack:
        node = stack.pop()
        prefix = names[node]
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                names[child] = f"{prefix}.{child.name}" if prefix else child.name
            else:
                names[child] = prefix
            stack.append(child)
    return names


def _literal_text(node: ast.expr) -> str:
    """The literal text of an expression, skipping every computed part.

    `fail("a " "b " + joined)` and `fail(f"a {x} b")` both carry real prose a
    human needs in the report; reading only `ast.Constant` dropped it and left
    the two longest cross-doc drift messages blank.
    """
    if isinstance(node, ast.Constant):
        return node.value if isinstance(node.value, str) else ""
    if isinstance(node, ast.JoinedStr):
        return "".join(_literal_text(part) for part in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _literal_text(node.left) + _literal_text(node.right)
    return ""


def _static_message(node: ast.Call) -> str:
    """The literal part of the fail message, or "" when it is computed."""
    if not node.args:
        return ""
    return _literal_text(node.args[0])


def compute_site_id(qualname: str, signature: str, ordinal: int) -> str:
    """Stable identity for one site. Deterministic across machines."""
    digest = hashlib.sha256(f"{qualname}\x00{signature}\x00{ordinal}".encode("utf-8"))
    return digest.hexdigest()[:16]


def fail_sites(source: str) -> tuple[FailSite, ...]:
    """Every `fail(...)` site the validator declares, in identity order.

    Raises `SyntaxError` when the source does not parse -- an unparsable
    validator is reported, never silently counted as zero checks.
    """
    tree = ast.parse(source)
    qualnames = _qualname_map(tree)
    seen: Counter[tuple[str, str]] = Counter()
    sites: list[FailSite] = []
    for node in ast.walk(tree):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "fail"
        ):
            continue
        qualname = qualnames.get(node, "") or "<module>"
        signature = ast.dump(node, annotate_fields=True, include_attributes=False)
        ordinal = seen[(qualname, signature)]
        seen[(qualname, signature)] += 1
        sites.append(
            FailSite(
                site_id=compute_site_id(qualname, signature, ordinal),
                qualname=qualname,
                signature=signature,
                ordinal=ordinal,
                line=getattr(node, "lineno", 0),
                message=_static_message(node),
            )
        )
    # Sorted by identity, not by position: reordering functions in the
    # validator must not look like a different inventory.
    return tuple(sorted(sites, key=lambda site: site.site_id))


def count_fail_sites(source: str) -> int:
    """How many fail sites the validator declares. Reporting metadata."""
    return len(fail_sites(source))


def load_ledger(root: Path) -> dict:
    """Read the adjudicated inventory. Raises OSError/ValueError on damage."""
    text = (root / LEDGER_REL).read_text(encoding="utf-8-sig")
    ledger = json.loads(text)
    if not isinstance(ledger, dict) or not isinstance(ledger.get("sites"), list):
        raise ValueError("ledger has no `sites` record")
    return ledger


def ledger_index(ledger: dict) -> dict[str, dict]:
    """Ledger records by site id."""
    return {record["site_id"]: record for record in ledger["sites"]}


def render_ledger(sites, dispositions: dict[str, dict]) -> str:
    """Serialize an inventory deterministically, newline-terminated."""
    records = []
    for site in sites:
        verdict = dispositions.get(site.site_id, {"disposition": BASELINE})
        record = {
            "site_id": site.site_id,
            "qualname": site.qualname,
            "ordinal": site.ordinal,
            "line": site.line,
            "message": site.message[:160],
            "disposition": verdict["disposition"],
        }
        if verdict.get("case"):
            record["case"] = verdict["case"]
        if verdict.get("reason"):
            record["reason"] = verdict["reason"]
        records.append(record)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "subject": VALIDATOR_REL,
        "owner": "tools/fail_site_inventory.py",
        "count": len(records),
        "sites": records,
    }
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def inventory_errors(root: Path) -> list[str]:
    """Every way the live fail surface disagrees with the adjudicated ledger.

    Returns an empty list when they agree. Each entry names WHICH site, so a
    same-count swap reports both halves instead of cancelling out.
    """
    try:
        source = (root / VALIDATOR_REL).read_text(encoding="utf-8-sig")
    except OSError as exc:
        return [f"cannot read the canonical validator: {exc}"]
    try:
        sites = fail_sites(source)
    except SyntaxError as exc:
        return [f"canonical validator does not parse: {exc}"]
    try:
        ledger = load_ledger(root)
    except OSError as exc:
        return [f"cannot read the fail-site ledger: {exc}"]
    except ValueError as exc:
        return [f"fail-site ledger is not usable: {exc}"]

    recorded = ledger_index(ledger)
    live = {site.site_id: site for site in sites}
    errors: list[str] = []

    for site_id in sorted(live.keys() - recorded.keys()):
        site = live[site_id]
        errors.append(
            f"ADDED fail site {site_id} at {VALIDATOR_REL}:{site.line} in "
            f"{site.qualname} ({site.message[:70]!r}) -- a new check needs a "
            f"CASE in tools/audit_checks.py, or a recorded reason it has none. "
            f"Regenerate {LEDGER_REL} in the same change"
        )
    for site_id in sorted(recorded.keys() - live.keys()):
        record = recorded[site_id]
        errors.append(
            f"REMOVED fail site {site_id} last seen in {record.get('qualname')} "
            f"({str(record.get('message', ''))[:70]!r}) -- a deleted check "
            f"leaves its control testing nothing. Drop the CASE and regenerate "
            f"{LEDGER_REL} in the same change"
        )

    for record in ledger["sites"]:
        disposition = record.get("disposition")
        if disposition == UNADJUDICATED:
            errors.append(
                f"fail site {record.get('site_id')} in {record.get('qualname')} "
                f"({str(record.get('message', ''))[:70]!r}) is still "
                f"{UNADJUDICATED} -- give it a CASE in tools/audit_checks.py and "
                f"record {COVERED}, or record {NO_MUTATION_CASE} with a reason "
                f"that names what proves the invariant instead"
            )
        elif disposition not in DISPOSITIONS:
            errors.append(
                f"fail site {record.get('site_id')} carries disposition "
                f"{disposition!r}, outside {DISPOSITIONS}"
            )
        if disposition == COVERED and not record.get("case"):
            errors.append(f"fail site {record['site_id']} claims COVERED but names no CASE")
        if disposition == NO_MUTATION_CASE and not record.get("reason"):
            errors.append(
                f"fail site {record['site_id']} claims {NO_MUTATION_CASE} but records no reason"
            )

    declared = ledger.get("count")
    if isinstance(declared, int) and declared != len(ledger["sites"]):
        errors.append(
            f"ledger declares {declared} sites and lists {len(ledger['sites'])} -- "
            f"regenerate {LEDGER_REL}"
        )
    return errors


def baseline_ids(ledger: dict) -> frozenset[str]:
    """The closed, shrink-only inherited set."""
    return frozenset(
        record["site_id"] for record in ledger["sites"] if record.get("disposition") == BASELINE
    )


def regenerate(root: Path) -> str:
    """The ledger the live validator implies, keeping adjudicated verdicts.

    A site already in the ledger keeps its disposition, its CASE name and its
    reason; only its reported line moves. A site this ledger has never seen is
    written `UNADJUDICATED`, which the gate refuses -- regeneration reports a
    new check, it does not bless one.
    """
    source = (root / VALIDATOR_REL).read_text(encoding="utf-8-sig")
    sites = fail_sites(source)
    try:
        known = ledger_index(load_ledger(root))
    except (OSError, ValueError):
        known = {}
    dispositions: dict[str, dict] = {}
    for site in sites:
        record = known.get(site.site_id)
        if record is None:
            dispositions[site.site_id] = {"disposition": UNADJUDICATED}
            continue
        verdict = {"disposition": record.get("disposition", UNADJUDICATED)}
        if record.get("case"):
            verdict["case"] = record["case"]
        if record.get("reason"):
            verdict["reason"] = record["reason"]
        dispositions[site.site_id] = verdict
    return render_ledger(sites, dispositions)


def main(argv: list[str] | None = None) -> int:
    """`--write` regenerates the ledger; bare prints what disagrees."""
    argv = list(sys.argv[1:] if argv is None else argv)
    root = Path(__file__).resolve().parents[1]
    if "--write" in argv:
        (root / LEDGER_REL).write_text(regenerate(root), encoding="utf-8", newline="\n")
        print(f"wrote {LEDGER_REL}")
        argv = [arg for arg in argv if arg != "--write"]
    errors = inventory_errors(root)
    for error in errors:
        print(f"FAIL: {error}")
    if errors:
        return 1
    source = (root / VALIDATOR_REL).read_text(encoding="utf-8-sig")
    print(f"PASS: {len(fail_sites(source))} fail site(s), every identity adjudicated")
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry
    sys.exit(main())
