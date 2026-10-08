# T-239 — SCOUT of the audit-inbox layer `audit/1.md` (SRC-160)

Date: 2026-10-06. Seat: `saipen-cli`. Phase read: `saipen/phases/scout.md`.

## 1. What the layer is

| Fact | Value |
|------|-------|
| canonical layer | `audit/1.md`, 77 594 bytes, `^[1-9][0-9]*\.md$` |
| generation (path + SHA-256) | `audit/1.md` → `10f0983d…d99ca`, generation 1, captured `2026-10-06T15:22:37Z` |
| receipt | SRC-160 (`.saipen/intake/active/SRC-160.md`, 758 lines, 16 audit findings over 3 waves) |
| linked Work | T-239 (the umbrella Work, one per source) |
| binding state | `.saipen/intake/audit_inbox.json` → `state: ACTIVE`, `closed_at: null`, `binding: exact` |
| other `audit/` entries | 7 `ZAICODE — *.md` files → **residue**, foreign to the transport: never read, never deleted (SOURCES.md:366-378) |

Rule owner: `SOURCE-AUDIT-INBOX-01` (SOURCES.md:329-388).

## 2. What was wrong when SCOUT started

`source reconcile SRC-160 --dry-run` reported `terminal: false` with:

```
active coverage carries no requirements            <- Contract/coverage never normalized
terminal tombstone file absent
audit inbox still claims this receipt as a live ACTIVE layer
linked Work T-239 is ## TODO, not ## DONE
no terminal coverage count agreed by any surface
findings: active_contract "seeded-empty-invalid-residue", coverage_requirements 0, coverage_terminal 0
```

The intake lifecycle (SOURCES.md:353-357) is `receipt → binding → **agent-owned
normalization into Contract and Coverage** → one umbrella Work → evidence → closure`.
The normalization step had never run for this receipt, so the layer had no
requirements at all: nothing could ever become terminal, and the inbox could
never settle either way.

## 3. SCOUT work performed (normalization)

`saipen source req SRC-160 R### requirement <clause>` × 16 — one clause per
audit finding, class `requirement` (actionable), text carries the finding id,
severity and the owning symbol. Contract advanced through
`interpretation_revision` 1 → 16; every clause starts `disposition: UNKNOWN`.

Then `saipen source disp` per clause (evidence = the revalidation table
`.saipen/evidence/T-240-src161/REQ-004-audit1-dispositions.md`, which
re-derives every claim against the current bytes):

| rid | finding | sev | disposition | owner |
|-----|---------|-----|-------------|-------|
| R001 | CORE-001 nested-persistence fail-open | P1 | BLOCKED | T-241 |
| R002 | CORE-002 Auto Goal budget process-local | P1 | BLOCKED | T-242 |
| R003 | CORE-003 delegation budget not atomic | P1 | BLOCKED | T-243 |
| R004 | CORE-004 audit cancel swallows failed stop | P1 | BLOCKED | T-244 |
| R005 | CORE-005 Save All ships nested session state | P1 | BLOCKED | T-245 |
| R006 | CORE-006 transition matrix unenforced | P2 | DEFERRED | unticketed (see below) |
| R007 | W2-001 stranded queue leases | P1 | **IMPLEMENTED** | T-240 wave |
| R008 | W2-002 retry safety lost on renderer reload | P1 | **IMPLEMENTED** | T-240 wave |
| R009 | W2-003 scheduler false stop success | P1 | BLOCKED | T-246 |
| R010 | W2-004 delegation spool not run-scoped | P1 | BLOCKED | T-247 |
| R011 | W2-005 repo init can reopen after close | P2 | DEFERRED | unticketed |
| R012 | PERF-001 poll loads whole job history | P1 | BLOCKED | T-248 |
| R013 | PERF-002 refresh serial / stale-result unsafe | P1 | BLOCKED | T-249 |
| R014 | PERF-003 stats rescan raw events | P2 | DEFERRED | unticketed |
| R015 | PERF-004 pixel-snap global observer | P2 | DEFERRED | unticketed |
| R016 | PERF-005 unbounded renderer dedupe set | P2 | DEFERRED | unticketed |

Tally: **16 requirements, 2 terminal (IMPLEMENTED), 9 BLOCKED on repair
tickets, 5 DEFERRED P2s.** The five DEFERRED rows are the still-present P2s:
SRC-161:REQ-004 asked for a ticket per still-present **P1** only, and each P2
is recorded with its reason (aggravated-by-design gap or bounded waste whose
repair belongs with the P1 touching the same file) rather than dropped.

R007 verification: `zcode` `pnpm run test` exit 0 → 118/1275/105/252/45/9/11,
0 failures, covering `packages/services/test/zaicodeJobs.test.ts` (shutdown
lease release + recurring stale-run reaper).
R008 verification: same green run plus
`packages/ui/test/zaicodeSrc161RetrySafetyReload.test.ts` (fresh modules
hydrated against pre-seeded `zaicode-retry-safety-v1` storage).

## 4. State after SCOUT

`source reconcile SRC-160 --dry-run` now reports:

```
active_contract "developed", coverage_requirements 16, coverage_terminal 2
contradictions:
  coverage carries non-terminal requirements: SRC-160:R001..R005  (all 14 non-terminal)
  terminal tombstone file absent
  audit inbox still claims this receipt as a live ACTIVE layer
  linked Work T-239 is ## BLOCKED, not ## DONE
  active Contract is developed: use the official close path, not tombstone-authoritative recovery
```

`audit status --json` → layer 1 still `pending`, `state: ACTIVE`,
`closed_pending_delete: []`, `digest_agreement: true` (bytes unchanged since
capture, so no new generation).

## 5. Decision: the layer is NOT closed, and that is the truth

Closure requires "digest PASS, contract bound to that digest, **every
actionable clause terminal with sufficient evidence**, and linked Work DONE"
(SOURCES.md:271-275), and deletion of `audit/1.md` is permitted only then,
as the journaled `audit_inbox.consume` operation (SOURCES.md:359-365). 14 of 16
clauses are not terminal, so:

- T-239 was **blocked** with the dependency spelled out (nine repair tickets
  T-241…T-249 own the non-terminal P1 clauses; the five P2s are DEFERRED with
  reasons) instead of being closed on a coverage ledger that says otherwise.
- `source retire SRC-160` and `audit_inbox.consume` were **not** run; the
  engine refuses them anyway (`delete_gate` needs terminal coverage + linked
  Work DONE + the current digest to equal the captured generation).
- `audit/1.md` stays in the directory as a workable unconsumed layer. Per
  `SOURCE-AUDIT-INBOX-01` it outranks selection of unrelated queued TODO but
  "never preempts active Work" — with T-239 blocked, `saipen continue` falls
  through to the ordinary Pick Rule, i.e. the repair tickets.

**To close later (exact sequence):** land T-241…T-249 → set each of R001-R005,
R009, R010, R012, R013 to `IMPLEMENTED`/`VERIFIED` with `--evidence` and
`--verification` (the five DEFERRED P2s must also reach a terminal disposition
or be re-dispositioned honestly — DEFERRED is not terminal) →
`source reconcile SRC-160` must print `terminal: true` → `ticket done T-239`
through REVIEW → SHIP → `source retire SRC-160 --reason …` → the journaled
consume deletes `audit/1.md` if its bytes still hash to
`10f0983d…d99ca`.

## 6. Not done here, deliberately

- No repair of CORE/W2/PERF findings: they are owned by T-241…T-249, each with
  its own verify clause and regression cycle.
- No deletion, retirement or quarantine of `audit/1.md`, SRC-160, or the seven
  residue files (only the operator may empty `audit/`).
