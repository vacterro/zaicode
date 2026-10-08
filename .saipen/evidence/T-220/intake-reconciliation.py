"""Preserve bundle ordering; never modify the supplied bundle or close Work."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = Path(__file__).resolve().parent
BUNDLE = EVIDENCE / "fresh-bundle"
HOME = Path("V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_SAIPEN")
LAUNCHER = HOME / "bin/saipen.cmd"
INDEX = json.loads((BUNDLE / "silo.index.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((BUNDLE / "manifest.json").read_text(encoding="utf-8"))
SOURCE = BUNDLE / INDEX["source_member"]
LINES = SOURCE.read_text(encoding="utf-8").splitlines()

# These are historical reconciliation links, not current-build acceptance.
HISTORY = {
    13: ["T-190", "T-217", "T-216"],
    14: ["T-217"], 15: ["T-217"], 16: ["T-217"], 17: ["T-217"],
    18: ["T-217", "T-201"], 19: ["T-217"], 20: ["T-217"],
    21: ["T-217"], 22: ["T-217"], 23: ["T-217"], 24: ["T-217"],
    25: ["T-209", "T-212"], 26: ["T-208"], 27: ["T-206"],
    28: ["T-205"], 29: ["T-204"], 30: ["T-203"], 31: ["T-202"],
    32: ["T-201", "T-217"], 33: ["T-200"], 34: ["T-199"],
    35: ["T-198"], 36: ["T-197"], 38: ["T-217"],
    40: [], 41: ["T-190", "T-217", "T-216"],
}

def canonical(*args):
    result = subprocess.run(
        [str(LAUNCHER), *args, "--project-root", str(ROOT), "--json"],
        cwd=HOME, capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Canonical operation failed: {args}\n{result.stdout}\n{result.stderr}")
    response = json.loads(result.stdout)
    if not response.get("ok"):
        raise RuntimeError(response)
    return response

rows = []
for req in INDEX["requirements"]:
    number = req["source_order"]
    text = req["text"]
    checked = text.lstrip().startswith("[x]")
    if checked:
        disposition = "USER_CHECKED_OFF"
        reason = "Explicit checked-off source clause; do not reopen."
    elif number == 1:
        disposition = "BLOCKED"
        reason = "New live outage evidence; old tests cannot close it. Live normal-launch package is older; current-package desktop outage and screenshot attribution are still unproven."
    elif number <= 12:
        disposition = "NEW"
        reason = "Fresh Group 1 delta; implementation waits for runtime/source parity and Phase 1 acceptance."
    elif number == 40:
        disposition = "DUPLICATE"
        reason = "Same liveness concern as fresh REQ-005; reconcile there, do not create another ticket."
    elif HISTORY.get(number):
        disposition = "DUPLICATE"
        reason = "Historical scope already owned by the linked Work; preserve its implementation. Current-source and packaged rechecks remain pending, so this is not an ALREADY_IMPLEMENTED acceptance claim."
    else:
        disposition = "BLOCKED"
        reason = "Historical requirement needs evidence reconciliation; not dispositioned from memory."
    rows.append({
        "requirement_id": req["id"], "clause_id": f"R{number:03d}",
        "source_order": number, "group_id": req["group_id"],
        "line_start": req["line_start"], "line_end": req["line_end"],
        "text": text, "media": req.get("media", []),
        "disposition": disposition, "reason": reason,
        "historical_work": HISTORY.get(number, []),
        "implementation_evidence": [], "current_verification": "NOT_RUN",
        "class": "context" if checked else "requirement",
    })

# The producer omitted three checked-off bullets and linked their pictures to
# neighboring actionable requirements. Preserve its index exactly and supplement it.
covered_lines = {row["line_start"] for row in rows}
for line_number, text in enumerate(LINES, 1):
    if text.lstrip().startswith("[x]") and line_number not in covered_lines:
        rows.append({
            "requirement_id": f"USER-CHECKED-OFF-L{line_number:03d}",
            "clause_id": f"R{len(rows)+1:03d}", "source_order": None,
            "line_start": line_number, "line_end": line_number, "text": text,
            "disposition": "USER_CHECKED_OFF",
            "reason": "Checked-off raw source bullet omitted by producer index; retained without renumbering REQ IDs or reopening work.",
            "historical_work": [], "implementation_evidence": [],
            "current_verification": "NOT_RUN", "class": "context",
        })

ledger = {
    "schema_version": 1, "work": "T-220", "request_receipt": "SRC-150",
    "bundle_receipt": "SRC-151", "status": "PROVISIONAL_INTAKE_NOT_ACCEPTANCE",
    "bundle_source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
    "indexed_requirements": len(INDEX["requirements"]), "raw_source_clauses": len(rows),
    "screenshots_preserved": len(MANIFEST["items"]),
    "blockers": [
        "Exact requested _ZAICODE_05.10.26-T04-13-11.zip snapshot not supplied or found in inspected input directories; do not substitute 04-14-45 snapshot.",
        "Canonical active Work remains T-166 / saipen-cli. START admitted SRC-150 as model_supplied P2 candidate and explicitly returned preempt_active_work:false; do not fabricate an operator carrier or dependency to steal the seat.",
        "Current packaged desktop router-outage scenario not executed; neither SOURCE REGRESSION nor final STALE RUNTIME acceptance is proven.",
    ],
    "requirements": rows,
    "index_caveats": [
        "Raw checked-off lines 56, 86 and 95 are missing from producer requirement index.",
        "Media 025, 033 and 034 belong to these checked-off source lines, not new acceptance for REQ-025, REQ-038 and REQ-041 respectively.",
        "Bundle manifest build revision identifies FastPrompter producer, not screenshot ZAICODE runtime.",
    ],
}
(EVIDENCE / "disposition-ledger.json").write_text(json.dumps(ledger, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
md = [
    "# T-220 / SRC-150 + SRC-151 — provisional fresh-bundle intake",
    "", "No implementation or final acceptance is claimed. See disposition-ledger.json for exact clause texts and mappings.",
    "", "## Ordered disposition", "", "| Requirement | Source line | Disposition | Historical work | Current check |",
    "|---|---:|---|---|---|",
]
for row in sorted(rows, key=lambda row: row["line_start"]):
    md.append(f"| {row['requirement_id']} | {row['line_start']} | {row['disposition']} | {', '.join(row['historical_work']) or '—'} | NOT RUN |")
md += ["", "## Blocking gates", "", *[f"- {item}" for item in ledger["blockers"]], "", "## Producer index caveats", "", *[f"- {item}" for item in ledger["index_caveats"]]]
(EVIDENCE / "disposition-ledger.md").write_text("\n".join(md)+"\n", encoding="utf-8")

if "--apply" in sys.argv:
    operations = []
    for row in rows:
        result = canonical("source", "req", "SRC-151", row["clause_id"], row["class"], row["text"])
        operations.append({"requirement_id": row["requirement_id"], "operation": "normalize", "result": result})
    # Nothing terminal: preserve unknown/current acceptance rather than treating
    # historical evidence as sufficient proof over contradictory new screenshots.
    (EVIDENCE / "normalization-receipt.json").write_text(json.dumps(operations, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
print(json.dumps({"indexed": len(INDEX["requirements"]), "clauses": len(rows), "checked_off": sum(row["disposition"] == "USER_CHECKED_OFF" for row in rows), "applied": "--apply" in sys.argv}))
