# SAIPEN CONFORMANCE

<!-- RULE-VIEW: CONFORMANCE-CORPUS-01 -->
<!-- GENERATED: tools/conformance_corpus.py; corpus-sha256: 2417200feb29ef2d05fe0373a9454dbb8ef378f7aff93fc1292d0242a573a437 -->

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
257 cases with IDs 1..257, 7 stable Rule-ID links and
65 historical ticket/event links. Each JSON object has exactly:

- `id`: stable scenario number;
- `rule_ids`: stable protocol Rule IDs only;
- `history_refs`: non-authoritative `T-###`/`E-###` provenance;
- `concept`: short human label;
- `setup`: precondition or defect shape;
- `expected`: observable invariant;
- `coverage`: fixture, test, validator or procedural owner.

## Coverage summary

- `tools/validate.py`: 172
- `tools/audit_checks.py`: 59
- `documented evidence`: 51
- `tools/run_scenarios.py`: 29
- `tools/audit_floor.py`: 8
- `extensions/subs/PROTOCOL.md`: 7
- `tools/audit_parity.py`: 3
- `tests/validate.sh`: 2
- `tests/scenarios/`: 2
- `saipen/BOOT.md`: 1
- `tests/scenarios/checkpoint-self-confirmation/README.md`: 1
- `saipen/tests/scenarios/`: 1

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
