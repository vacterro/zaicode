"""Machine-owned conformance scenario corpus and generated human index."""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

SCHEMA_FIELDS = (
    "id",
    "rule_ids",
    "history_refs",
    "concept",
    "setup",
    "expected",
    "coverage",
)
EXPECTED_IDS = tuple(range(1, 258))
RULE_ID_RE = re.compile(
    r"^(?:TEST|STATE|CHECKPOINT|RECOVERY|PICK|CMD|SOURCE|OPS|GOAL|EXEC|"
    r"PHASE|CONFORMANCE|CONTEXT|VERIFY)-[A-Z0-9-]+$"
)
HISTORY_REF_RE = re.compile(r"^[TE]-\d+$")


def repository_root(start: Path | None = None) -> Path:
    here = (start or Path(__file__)).resolve()
    for candidate in (here, *here.parents):
        if (candidate / "tests" / "conformance_cases.jsonl").is_file():
            return candidate
    raise ValueError("cannot locate tests/conformance_cases.jsonl")


def corpus_path(root: Path | None = None) -> Path:
    return (root or repository_root()) / "tests" / "conformance_cases.jsonl"


def human_path(root: Path | None = None) -> Path:
    return (root or repository_root()) / "saipen" / "CONFORMANCE.md"


def load_cases(root: Path | None = None) -> list[dict[str, Any]]:
    path = corpus_path(root)
    cases: list[dict[str, Any]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}:{line_no}: invalid JSON: {exc}") from exc
        if not isinstance(row, dict):
            raise ValueError(f"{path}:{line_no}: row must be an object")
        cases.append(row)
    return cases


def validate_cases(cases: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    ids: list[int] = []
    expected_keys = set(SCHEMA_FIELDS)
    for line_no, row in enumerate(cases, 1):
        keys = set(row)
        if keys != expected_keys:
            errors.append(
                f"row {line_no}: fields {sorted(keys)} != {sorted(expected_keys)}"
            )
            continue
        case_id = row["id"]
        if not isinstance(case_id, int) or isinstance(case_id, bool):
            errors.append(f"row {line_no}: id must be an integer")
        else:
            ids.append(case_id)
        for key, pattern in (
            ("rule_ids", RULE_ID_RE),
            ("history_refs", HISTORY_REF_RE),
        ):
            values = row[key]
            if (
                not isinstance(values, list)
                or any(
                    not isinstance(value, str) or not pattern.fullmatch(value)
                    for value in values
                )
                or values != sorted(set(values))
            ):
                errors.append(f"row {line_no}: {key} must be a sorted unique valid array")
        concept = row["concept"]
        if not isinstance(concept, str) or not concept.strip() or len(concept) > 160:
            errors.append(f"row {line_no}: concept must contain 1..160 characters")
        for key in ("setup", "expected"):
            if not isinstance(row[key], str) or not row[key].strip():
                errors.append(f"row {line_no}: {key} must be non-empty text")
        coverage = row["coverage"]
        if (
            not isinstance(coverage, list)
            or not coverage
            or any(not isinstance(value, str) or not value.strip() for value in coverage)
            or coverage != sorted(set(coverage))
        ):
            errors.append(f"row {line_no}: coverage must be a sorted unique string array")
    if ids != sorted(ids):
        errors.append("scenario IDs must be monotonically increasing")
    if len(ids) != len(set(ids)):
        errors.append("scenario IDs must be unique")
    if tuple(ids) != EXPECTED_IDS:
        missing = sorted(set(EXPECTED_IDS) - set(ids))
        extra = sorted(set(ids) - set(EXPECTED_IDS))
        errors.append(
            f"scenario IDs must be exactly {EXPECTED_IDS[0]}..{EXPECTED_IDS[-1]}; "
            f"missing={missing} extra={extra}"
        )
    return errors


def corpus_digest(cases: list[dict[str, Any]]) -> str:
    body = "".join(
        json.dumps(case, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
        for case in cases
    )
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def render_human(cases: list[dict[str, Any]]) -> str:
    errors = validate_cases(cases)
    if errors:
        raise ValueError("; ".join(errors))
    owner_counts = Counter(owner for case in cases for owner in case["coverage"])
    coverage_rows = "\n".join(
        f"- `{owner}`: {count}" for owner, count in owner_counts.most_common(12)
    )
    digest = corpus_digest(cases)
    rule_linked = sum(bool(case["rule_ids"]) for case in cases)
    history_linked = sum(bool(case["history_refs"]) for case in cases)
    id_range = f"{EXPECTED_IDS[0]}..{EXPECTED_IDS[-1]}"
    return f"""# SAIPEN CONFORMANCE

<!-- RULE-VIEW: CONFORMANCE-CORPUS-01 -->
<!-- GENERATED: tools/conformance_corpus.py; corpus-sha256: {digest} -->

Conformance means observable protocol behavior agrees across normative prose,
machine registry, schemas, validator checks and executable fixtures. A green
claim is evidence about the current tree, never a substitute for evidence.

## Cold-continuation principle

TEST-001 requires a fresh agent to continue from project files without hidden
chat memory. STATE, BOARD, LOG and immutable source receipts carry the durable
facts; routine execution does not load this document or the scenario corpus.

## Proof vectors

1. Static validation checks closed shapes, ownership, references and drift.
2. Red controls mutate one condition and require the named check to fail.
3. Executable scenarios and focused tests prove behavior and recovery paths.

The canonical scenario data is `tests/conformance_cases.jsonl`. It contains
{len(cases)} cases with IDs {id_range}, {rule_linked} stable Rule-ID links and
{history_linked} historical ticket/event links. Each JSON object has exactly:

- `id`: stable scenario number;
- `rule_ids`: stable protocol Rule IDs only;
- `history_refs`: non-authoritative `T-###`/`E-###` provenance;
- `concept`: short human label;
- `setup`: precondition or defect shape;
- `expected`: observable invariant;
- `coverage`: fixture, test, validator or procedural owner.

## Coverage summary

{coverage_rows}

## Maintenance

Add or edit one semantic row in `tests/conformance_cases.jsonl`, then run:

```
python tools/conformance_corpus.py --write
python tools/conformance_corpus.py --check
python tools/validate.py
```

`--write` regenerates this compact index from the corpus. `--check` rejects
schema drift, missing/duplicate/out-of-order IDs, malformed Rule IDs or history
references, empty proof ownership, and human-view drift. There is no second
scenario table to update.

The corpus is proof data, not runtime context. Debug a failing case by its
`coverage` owners and only then load the relevant rule owner through
`INDEX.md`.
"""


def check_generated(root: Path | None = None) -> list[str]:
    base = root or repository_root()
    cases = load_cases(base)
    errors = validate_cases(cases)
    if errors:
        return errors
    expected = render_human(cases)
    actual = human_path(base).read_text(encoding="utf-8-sig")
    if actual != expected:
        errors.append("saipen/CONFORMANCE.md is not the generated corpus view")
    return errors


def write_generated(root: Path | None = None) -> None:
    base = root or repository_root()
    cases = load_cases(base)
    errors = validate_cases(cases)
    if errors:
        raise ValueError("; ".join(errors))
    human_path(base).write_text(render_human(cases), encoding="utf-8", newline="\n")
