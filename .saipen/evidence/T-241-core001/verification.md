# T-241 / CORE-001 verification

The four persisted JSON columns now share a decoder that preserves absence,
valid values and corruption as distinct outcomes. Syntax or schema corruption
produces an existing `invalid-definition` / `invalid-job` diagnostic naming the
column and prevents execution. The damaged bytes remain in SQLite. Only SQL
NULL and the historical zero-length string keep their absence semantics;
whitespace-only values are rejected. Valid restrictive policies and model
options round-trip unchanged. No migration or runtime permission change.

Repository baseline: zcode `1e23cfff`. The previous owner's two decoder edits
and untracked regression suite were continued; foreign `.saipen-red/` was
preserved. Existing row/list/get/service admission contracts remain authoritative.
Spec: `zcode/specs/zaicode-t241-nested-persistence.md`.

Validation with the repository-pinned pnpm 10.33.2:

- Exact regression command, from `zcode/packages/services`:
  `node --import tsx --test --test-reporter=spec test/zaicodeT241NestedPersistence.test.ts`
  reports 27 passed, zero failures/cancellations (`regression-green.log`).
- Same suite with only the agent repository restored to its HEAD decoder:
  14 assertion failures (`red-agent.log`). With only the job repository restored:
  11 assertion failures (`red-job.log`). `red-control.mjs` restores the exact
  repaired bytes in `finally`; `red-controls.json` records both SHA256 pairs.
  Tests, fixtures and expected values are identical in both controls and green.
- New whitespace cases first produced four failures against the inherited
  partial repair; the final reader rejects all four.
- Focused persistence/queue suites: 48 passed, zero failures/cancellations
  (`focused.log`). They cover diagnostic visibility, raw stored bytes, dispatch
  denial, legacy absence and valid nested round-trips.
- `pnpm run typecheck`: exit 0 (`typecheck.log`).
- `pnpm run verify:pre-push`: exit 0 (`prepush.log`); lint zero errors and 166
  existing warnings; architecture zero violations; 1905 tests across seven
  suites (118 / 1320 / 142 / 260 / 45 / 9 / 11), zero failures/cancellations.
- Workspace freshness and pre-edit architecture checks passed. Services is
  an unmanaged module; this internal helper adds no cross-module contract.
- `git diff --check`: exit 0.

Review: both usable-row constructors return before building a candidate when
a nested value is malformed. The empty tool policy fallback is reachable only
for validated `{}` or legacy absence. No read deletes or rewrites rows and no
executor path was weakened. Additional touched lines in the job repository are
formatter-only. This service contract is fully exercised by real temporary
SQLite and real job-service admission; no GUI verdict is claimed.

Confidence: high. Packaging/UX acceptance belongs to the subsequent stability
wave; this verification proves the persistence and admission repair.

Independent REVIEW repeated the exact 27-case regression command and passed
(`review.log`). Published product commit:
`9ab895bf40cb6493c624368021385a0105a7bba8`, fast-forward to the existing
`origin/zaicode`; a fresh `git ls-remote` matches product HEAD. Exactly the five
reviewed product files were committed. Foreign `.saipen-red/` remains untouched.
This is product-branch publication in the separate `zcode/` Git repository,
not a tagged workspace or installer release.
