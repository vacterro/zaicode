"""T-1382 field probe: the damaged SAITULS fixture, driven by canonical verbs.

Rebuilds the 17.09.26 incident shape -- a retired STATE field, a duplicated
BOARD id, two DONE rows carrying stale blocker metadata and four LOG lines that
lost their leading bullet plus one free-text record -- and walks the recovery
route the engine names, WITHOUT touching a canonical file by hand. Reports the
trail and the final verdict so the acceptance evidence describes what the
fixture actually contains.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

SAIPEN_CLI = TOOLS / "saipen.py"
#: The fixture binds THIS repository as its protocol home, exactly as the
#: regression does: the point of the specimen is a damaged PROJECT, not a
#: damaged installation.
HOME = TOOLS.parent

_SAITULS_STATE = (
    "---\n"
    "phase: BUILD\n"
    "task: T-176\n"
    'next_action: "PHASE BUILD T-176"\n'
    'blocker: ""\n'
    "transition_from: SCOUT\n"
    "saipen_version: 8\n"
    "schema_version: 3\n"
    "last_event: 1303\n"
    "style_contract: ded-4ae736e4\n"
    'saipen_home: "{home}"\n'
    "agent: buffy\n"
    "parked_work: T-999\n"
    "requires:\n  - filesystem\n  - python\n"
    "mode: full\n"
    'updated: "2026-09-17T00:00:00Z"\n'
    "---\n"
)

_SAITULS_BOARD = (
    "## DOING\n"
    "- [/] T-176 [P1] the live one | verify: it works | owner: buffy\n"
    "## TODO\n"
    "## DONE\n"
    "- [x] T-176 [P1] the duplicate id | verify: it works | blocker: STALE -- long gone\n"
    "- [x] T-177 [P1] another done row | verify: it works | blocker: STALE -- also gone\n"
    "## BLOCKED\n"
)

_SAITULS_LOG = (
    "- 17.09.26 00:00 [E-1299] [T-176] [agent: buffy] "
    "[op: claim-aaaaaaaaaaaa4aaaaaaaaaaaaaaaaaaa] DEC: claimed via SAIOPS -- owner buffy\n"
    "17.09.26 00:01 [E-1300] [parent: E-1299] [T-176] [agent: buffy] "
    "[op: checkpoint-bbbbbbbbbbbb4bbbbbbbbbbbbbbbbbbb] RUN: SCOUT -- lost its bullet\n"
    "17.09.26 00:02 [E-1301] [parent: E-1300] [T-176] [agent: buffy] "
    "[op: checkpoint-cccccccccccc4cccccccccccccccccccc] RUN: SCOUT -- lost its bullet\n"
    "17.09.26 00:03 [E-1302] [parent: E-1301] [T-176] [agent: buffy] "
    "[op: transition-dddddddddddd4dddddddddddddddddddd] RUN: transition to BUILD -- the work\n"
    "SAIPATCH checkpoint written by hand, no canonical event tag at all\n"
    "17.09.26 00:04 [E-1303] [parent: E-1302] [T-176] [agent: buffy] "
    "[op: checkpoint-eeeeeeeeeeee4eeeeeeeeeeeeeeeeeeee] RUN: BUILD -- lost its bullet\n"
)


def build_fixture(home: Path) -> Path:
    from saipen_engine.journal import ensure_project_lineage

    root = Path(tempfile.mkdtemp(prefix="saipen-saituls-probe-")) / "SAITULS"
    (root / ".saipen").mkdir(parents=True)
    (root / ".saipen" / "STATE.md").write_text(
        _SAITULS_STATE.format(home=str(home).replace("\\", "\\\\")), encoding="utf-8"
    )
    (root / ".saipen" / "BOARD.md").write_text(_SAITULS_BOARD, encoding="utf-8")
    (root / ".saipen" / "LOG.md").write_text(_SAITULS_LOG, encoding="utf-8")
    ensure_project_lineage(root)
    subprocess.run(["git", "init"], cwd=str(root), capture_output=True)
    return root


def cli(root: Path, *args) -> dict:
    from saipen_engine.paths import unbound_environment

    run = subprocess.run(
        [sys.executable, str(SAIPEN_CLI), *args, "--json"],
        cwd=str(root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=unbound_environment(),
        timeout=600,
    )
    try:
        return json.loads(run.stdout or "{}")
    except json.JSONDecodeError:
        return {"_raw": (run.stdout + run.stderr)[:800]}


def decide(decision: dict, keep_section: str) -> str:
    """The operator's answer: this SECTION keeps the id, the other gives it up."""
    records = decision["records"]
    keep = next(r for r in records if r["section"] == keep_section)
    other = next(r for r in records if r["digest"] != keep["digest"])
    return (
        f"saipen recover --resolve-duplicate-id {decision['ticket']} "
        f"--keep {keep['digest']} --reassign {other['digest']}"
    )


def main() -> int:
    root = build_fixture(HOME)
    print(f"fixture {root}")
    answer = cli(root, "recover")
    print("1. recover ->", answer.get("code"), f"({answer.get('reason_code')})")
    decision = answer.get("duplicate_id_decision") or {}
    if not decision:
        print("   NO STRUCTURED DECISION:", json.dumps(answer)[:1200])
        return 1
    for record in decision["records"]:
        print(
            f"   record {record['digest'][:12]} {record['section']} "
            f"line {record['line']} :: {record['description'][:50]}"
        )
    command = decide(decision, "## DOING")
    print("2. operator decision:", command)
    applied = cli(root, *command.split()[1:])
    print("   ->", applied.get("code"), applied.get("detail", "")[:200])
    if not applied.get("ok"):
        print(json.dumps(applied)[:800])
        return 1
    print("   new id:", applied.get("new_id"), "evidence:", applied.get("evidence"))
    for step in range(8):
        answer = cli(root, "recover")
        code = answer.get("code")
        print(f"   recover -> {code}")
        if code == "CLEAN":
            break
        route = answer.get("canonical_next_command")
        if not route:
            print("   no route:", json.dumps(answer)[:600])
            break
        print("   route:", route)
        result = cli(root, *route.split()[1:])
        print("   ->", result.get("code"))
        if not result.get("ok"):
            print(json.dumps(result)[:600])
            break
    for verb in (("validate",), ("status",), ("continue",)):
        answer = cli(root, *verb)
        print(f"3. {verb[0]} ->", answer.get("code"), answer.get("ok"))
    board = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
    print("4. BOARD now:\n" + "".join(f"   {ln}\n" for ln in board.splitlines()))
    log = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
    seen = [ln.split("[E-")[1].split("]")[0] for ln in log.splitlines() if "[E-" in ln]
    print("5. LOG event ids:", seen, "unique:", len(seen) == len(set(seen)))
    print(
        "6. recovery evidence:",
        sorted(p.name for p in (root / ".saipen" / "recovery").rglob("*")),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
