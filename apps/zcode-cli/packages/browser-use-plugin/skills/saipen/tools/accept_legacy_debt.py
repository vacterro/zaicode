#!/usr/bin/env python
"""Register ONE exact sealed historical missing-set as accepted legacy debt.

Canonical registration route for saipen_engine.accepted_debt (Decision B):
validates the exact events against the live canonical history, then writes ONE
journaled AD-NNNNNN record under
`.saipen/recovery/conformance/accepted_debt/`. The canonical validator then
downgrades exactly that finding to a visible warning; everything else stays
blocking. Sealed history is never edited.

    python tools/accept_legacy_debt.py --project-root <path> \
        --events E-964,E-981,E-1007,E-1114,E-1117,E-1124 \
        --authority SRC-047 --reason "operator Decision B ..." [--agent NAME]

Exit 0 only on ACCEPTED_DEBT_REGISTERED. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from saipen_engine.accepted_debt import register
from saipen_engine.state import parse_state


def _agent(root: Path) -> str:
    try:
        state = parse_state((root / ".saipen" / "STATE.md").read_text(encoding="utf-8"))
        return str(state.get("agent") or "unknown")
    except (OSError, ValueError):
        return "unknown"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", default=".", help="project root (default: cwd)")
    parser.add_argument(
        "--events",
        required=True,
        help="comma-separated exact event ids, e.g. E-964,E-981",
    )
    parser.add_argument(
        "--authority",
        required=True,
        help="canonical authority token: SRC-### | E-### | lineage-<32hex>",
    )
    parser.add_argument("--reason", required=True, help="why this debt is accepted immutable")
    parser.add_argument("--agent", default=None, help="recording agent (default: STATE.agent)")
    args = parser.parse_args(argv)

    root = Path(args.project_root).resolve()
    events = [part.strip() for part in args.events.split(",") if part.strip()]
    result = register(
        root,
        agent=args.agent or _agent(root),
        events=events,
        reason=args.reason,
        authority=args.authority,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
