# ZAICODE campaign report — 2026-10-24

Extended unattended shift, Mode 2. This report covers the work performed after
T-419 under the SAIHANDOFF contract, including the work that was blocked and
why. Every PASS below names the concrete command that produced it.

## CAMPAIGN STATUS

PARTIAL — the product work landed and verified green, but no new governed
implementation could begin after T-422 because the SAIPEN safety valve is
tripped and only a fresh operator `cc` can renew it.

## PRODUCT REPOSITORY / HEAD

`zcode/`, branch `zaicode`, HEAD `017bd2f7` (clean working tree).

Nine commits were made on top of `13314481`:

| Commit | Subject |
| --- | --- |
| `a04951c1` | feat(zaicode): durable conversation queue, attachment preservation, cold-restart recovery (T-419) |
| `55f14714` | feat(ui): show what the queue actually kept, and mark what it cannot prove (T-419) |
| `f661dd6e` | feat(audio): gate the commit being pushed, not just the working tree (T-420) |
| `04d0f9db` | fix(lint): set each max-lines cap to its measured count (T-419) |
| `ff481050` | chore(workspace): stop converting evidence bytes and drop the dead swift bridge |
| `42f2df8b` | feat(audits): surface a reconcile failure instead of swallowing it (T-403) |
| `a3584127` | feat(tools): packaged audio acceptance that names no host directory (T-416) |
| `5de834b1` | feat(hooks): version the pre-push publication gate (T-420) |
| `017bd2f7` | fix(audio): let the file-URI rule see the same example surface as its sibling |

118 files changed, 7974 insertions, 421 deletions.

## WORKSPACE HEAD

`d278ef18` (docs commit on top of `dd47eb73`). The workspace remains dirty
only in `.saipen/` memory, which is versioned evidence mutated exclusively
through the `saipen` CLI.

## BASELINE

Product tree at the start of this shift was `13314481` with 110 uncommitted
paths and 35 untracked paths — that is, all of T-419 existed as working-tree
state and none of it was committed. The staged package was built at
`2dc16c99` with `sourceFingerprint 492eb695…` and `workingTreeDirty: true`.

## WORKSTREAMS COMPLETED / PARTIAL / BLOCKED

### COMPLETED

**P0 reconcile of T-419.** The reported 27/27 receipt was stale, not wrong.
The only watched source changed after the build stamp was the acceptance
harness itself, which explains the fingerprint gap without implicating the
product. Re-ran the packaged acceptance on the existing build: 27/27 checks
true, fresh profile, 4 admissions and 4 attachments, queue 4→4→4 across two
restarts, 5 promoted, 0 discarded. Closed through the full phase chain with
recorded evidence.

**Test count correction.** The handoff reported 46 focused tests. The actual
focused set is 53: core 18, bootstrap 22, UI 10, adapters 3, all passing.

**Workstream 3 — historical input recovery inventory (T-421).** Produced a
reproducible classification of all 179 discarded `session_resumed` rows.
The decisive safety finding: 125 rows are the literal text `/goal cc all`,
26 are `cc`, and several are multi-line variants; 151 rows in total are
protocol control phrases. Replaying them would manufacture operator
authorization out of historical debris, so the inventory marks them
UNRECOVERABLE regardless of what an operator might later click. Only 10 rows
are genuinely recoverable and 7 of those belong to other projects. Zero rows
carry attachments. The production database was opened read-only and never
written.

**Publication boundary (T-420).** The app repository's current tree is now
clean: the four gate commands all pass at `017bd2f7`. The pre-push hook is
versioned so a clone can enforce the boundary. While doing this I found and
fixed a real self-referential defect: the gate refused its own tests, which
made HEAD fail its own pre-push. The fix exempts example surfaces for the
file-URI rule the same way the profile-path rule already did; the guard test
that proves a real drive path is still refused passes.

**Preservation of the uncommitted tree.** The single largest risk at the start
of this shift was that 118 paths of accepted work existed only in a working
tree. They are now nine reviewable commits, each gated. Two contamination
defects were caught before they could be committed: a test fixture naming the
operator's real profile directory, and a tools harness whose defaults were
three absolute host paths. Both now resolve from the environment at run time.

**Packaged acceptance on a clean tree (T-422).** Rebuilt after the commits.
The resulting metadata is the first in this campaign that proves a match
between artifact and committed source:

- `sourceRevision 017bd2f77731f4d437cfd8f7f8db70fbeb8f907e`
- `sourceFingerprint 14c198505bdebf23f181474a18e27c0927586faaa0b33bf4c2ca3dd6a0a4e3ba`
- `workingTreeDirty: false`

Boot gate PASS (shell mounted, 28 Settings sections, ProTrail OFF/ON profiles
verified across restart, 0 uncaught exceptions, 0 console errors). Artifact
inspection PASS (33690 asar files byte-identical to the allowlisted source
tree). Privacy gate PASS (25632 payload files). `sounds:audit-artifact` PASS
(13 audio entries + 20 inlined data URIs). `privacy:audit-artifact` PASS.
`verify-t419-queue-cold-restart` PASS 27/27, `limits: []`, `pageErrors: []`,
`consoleErrors: []`.

**Storage health.** The production database is 5.81 GB with
`freelist_count = 0`, so a VACUUM would reclaim nothing and would only rewrite
the file — it was not run. Growth is genuine `part.data` payload (3.73 GB /
1,081,063 rows), not fragmentation. All six critical read paths use dedicated
indexes.

### PARTIAL

**Test performance tiers (workstream 9).** Measured, not yet institutionalised.
Startup overhead of a single trivial file under `node --import tsx` is
239–434 ms. A focused two-file UI run is 1198 ms; a focused two-file core run
is 2496 ms. The full UI suite is 46.9 s for 2183 tests. Per-suite totals for
the whole repository: scripts 12.1 s, UI 46.9 s, services 25.1 s, desktop
19.9 s, core 8.7 s, adapters 1.7 s, bootstrap 5.7 s. No tier runner or
change-impact selector was built, because that is new governed work and the
valve is closed.

**Storage remediation (workstream 8).** The read-only diagnosis is complete
and reproducible; no retention policy or deletion was proposed as an action,
because deleting historical rows for space is explicitly out of bounds without
proof that nothing references them.

### BLOCKED

**New governed implementation of any remaining workstream** (1 portable queue
backup/restore, 2 replace-attachment operation, 4 multi-session matrix,
5 self-healing decision path, 11 packaged update/rollback, 12 architectural
simplification). `saipen continue` returns
`RECONCILE_REAUTH_REQUIRED … WAIT: safety valve reached (0 waves / 27 tickets)`.
That boundary is operator-only by design: an agent replay of `cc` cannot renew
it, and I did not attempt to fabricate one.

**SRC-310** (deployed bundle matches source / resume past the checkpoint) is
still unprojected. Its first half is now demonstrably satisfied — the
`workingTreeDirty: false` build above is exactly what it asked for — but the
projection itself requires the same operator ingress that is blocked.

**Publication remediation of the six already-published contaminated refs.**
Diagnosed and documented with three options; the recommended one needs
explicit operator approval because it retires branches. No force push and no
history rewrite was performed.

## FILES CHANGED

118 files in `zcode/`, 2 documents in the workspace:

- `docs/ZAICODE_PUBLICATION_REMEDIATION.md` — contamination inventory and three
  remediation options.
- `docs/ZAICODE_HISTORICAL_INPUT_INVENTORY.md` — 179-row classification and the
  safety requirements for future selective recovery.
- `.saipen/evidence/historical-input-inventory.json` — the machine-readable
  inventory behind that document.

## COMMITS

Nine product commits (table above) and one workspace commit `d278ef18`.

## TESTS PASS / FAIL / SKIPPED

`pnpm run test` at `017bd2f7` — exit 0.

| Suite | Tests | Pass | Fail | Skipped | Duration |
| --- | --- | --- | --- | --- | --- |
| scripts | 162 | 162 | 0 | 0 | 12.1 s |
| ui | 2183 | 2170 | 0 | 13 | 46.9 s |
| services | 338 | 338 | 0 | 0 | 25.1 s |
| desktop | 336 | 334 | 0 | 2 | 19.9 s |
| core | 125 | 125 | 0 | 0 | 8.7 s |
| adapters | 17 | 17 | 0 | 0 | 1.7 s |
| bootstrap | 150 | 150 | 0 | 0 | 5.7 s |
| **total** | **3311** | **3296** | **0** | **15** | |

`pnpm run lint` — 0 errors, 94 warnings. `pnpm run typecheck` — exit 0.

Three UI failures were found and resolved during this shift, and the
classification matters: all three pinned the old source shape of code that
T-419 had deliberately changed. They were stale expectations inside the
uncommitted diff, not runtime regressions. A direct render probe confirmed the
new behaviour is correct — a durable ref renders `title="clipboard.png"` and
an unproven ref renders `title="clipboard.png (copy unverified)"`. The tests
were updated to pin the behaviour instead of the formatting.

## PACKAGED ACCEPTANCE

PASS. Artifact built from clean `017bd2f7`; boot gate, artifact inspection,
release acceptance, privacy gate, both artifact audits and the 27/27
cold-restart acceptance all pass on that one artifact.

## PRODUCTION DATA PROTECTION

The operator database was opened `mode=ro` only, for forensics. No VACUUM, no
deletion, no schema change, no write of any kind. No private audio was touched.
The workspace boundary check reports the local memory intact.

## MEASURED PERFORMANCE DELTA

Test time is unchanged in substance: the full repository suite is 3311 tests in
about two minutes wall-clock when run by hand, and the three tests that changed
did not add measurable time. The meaningful measurement this shift produced is
not a speed delta but an overhead floor: one trivial test file costs 239–434 ms
under `node --import tsx`, which is the number a future tier runner has to
amortise.

## REMAINING RISKS

1. **Six published refs remain contaminated.** `github-main`, `github-master`
   and `release/zaicode-v0.0.3` (on both remotes) still carry this machine's
   paths and the 1311-file game audio library. Fixing the tree does not clean
   an already-pushed tip. This needs an operator decision; the recommended
   path is retiring those refs and publishing a clean line.
2. **The safety valve is closed at 27 tickets.** No autonomous governed work
   can continue until a fresh operator `cc` arrives through authenticated
   native ingress. Every remaining workstream is waiting on it.
3. **The live installed app is older than the repository.** The running
   instance was built from `3839ae72`; the staged `dist-next` is now
   `14c19850` at `017bd2f7`. The swap happens on the next launcher cycle and
   was not forced, because restarting the operator's running app is their
   call.
4. **`.gitignore` in the product repo carries SAIPEN rules for paths that do
   not exist there** (`.saipen/intake`, `.saipen/archive`). Harmless dead
   rules, preserved rather than deleted, but they will mislead a future reader.
5. **The historical recovery operation does not exist.** The inventory proves
   what must never be replayed; it does not implement selective recovery. If
   one is built later, the five requirements in the document are mandatory.

## NEXT ELIGIBLE WORK

Ordered by value once authority is renewed:

1. Bring `SRC-310` into the queue and close it against the clean-tree build
   evidence already produced.
2. Workstream 2, atomic Replace Attachment, because it shares the durability
   and race-handling machinery T-419 just built.
3. Workstream 1, portable queue backup/restore, on top of the same ledger.
4. Workstream 5, the self-healing decision path, which is the largest remaining
   reliability gap.
5. Workstream 9, the test tier runner, using the overhead floor measured here.

The publication remediation decision is not engineering work and should be
answered by the operator directly.
