# T-253 worker statistics verification

The original effect marked every completed/disappeared worker as recorded
before service availability or acknowledgement, swallowed delivery errors,
kept historical ids forever, and sent bursts larger than the service's 200-row
limit. The repaired internal recorder retains stable pending payloads until
success, serializes/coalesces 200-item delivery and stores receipts only while
the worker is visible. Existing base-service publication, worker changes and
SAIHOME refresh trigger retries; no new timer or localStorage history exists.
Independent queue/router refreshes remain concurrent; stats reads follow the
write acknowledgement. Repeated identical recording errors log once.

Original algorithm attribution: the effect and session DTO builder at product
`7faedc74` were first extracted into the callable recorder without changing
their broken behavior. The existing 12-case SAIHOME suite passed on that
extraction. Its exact files are under `pre-fix/`; the final oracle executes
against those files restored at their actual product paths. This is the
unfixed subject, not a missing-module or deliberately poisoned-input control.
The scratch package.json only gives the standalone legacy comparison the same
ESM interpretation as the original UI package.

Final exact command from zcode root:
`node --import tsx --test --test-reporter=spec packages/ui/test/zaicodeT253WorkerStatsRecorder.test.ts`

- 12 passed, zero failures/cancellations (`green.log`, independent `review.log`).
- Same final oracle against the unfixed extraction: eight assertion failures
  and four known-good controls (`red.log`). `red-control.mjs` restores both
  source files byte-for-byte and records verifier/subject/source hashes in
  `regression.json`.
- The initial 11-case oracle was extended after a deterministic microtask
  arrival between drain and finally left work waiting. The intermediate
  subject produced exactly one new failure (`cleanup-window-red.log`). Final
  red evidence was repeated against the original subject with the new oracle;
  old-verifier evidence is not spent. Successful cleanup drains the new work;
  an error waits for an existing retry trigger rather than spinning.
- Current VERIFY-cycle anchored regression pair is in E-4138/E-4139. The first
  REVIEW transition correctly refused a BUILD-cycle red half; the same control
  and green were repeated inside VERIFY before the accepted transition.
- 100,000 terminal workers completed and disappeared: every session delivered,
  zero acknowledged-history entries retained. Visible terminal workers submit
  once; disappeared running workers preserve their captured stopped timestamp;
  unavailable/rejected/uncertain delivery retries without losing payloads;
  overlaps and new arrivals remain serial.
- `durable-replay.mjs` uses the real StatsService and real temporary Windows
  SQLite: 450 sessions arrive as 200/200/50, replay after cache eviction keeps
  450 rows and identical stored bytes. The original and repaired algorithms
  produce identical stored bytes for 12 normal finished/stopped sessions.
  Detailed receipt: `durable-replay.json`. Independent REVIEW repeated it.
- Pinned pnpm 10.33.2 typecheck exit 0 (`typecheck.log`).
- `verify:pre-push` exit 0 (`prepush.log`): 1940 tests across seven suites
  (118 / 1332 / 165 / 260 / 45 / 9 / 11), zero failures/cancellations; lint zero
  errors with 166 existing warnings; architecture zero violations.
- Freshness, UI architecture context and `git diff --check` passed.

Memory bound applies to acknowledged history (zero after disappearance) and
visible workers. Undelivered sessions are necessary pending work and may grow
while the host stays unavailable; they are not silently discarded or claimed
persisted across renderer destruction. Durable deduplication remains solely
the existing SQLite primary key. No GUI/published-package acceptance is claimed
by these service/recorder tests. The unrelated unbounded home queue read is
separately tracked as T-254.

Scope: HomeFeed integration, one internal recorder, one regression file and
one spec. Foreign scratch/root work preserved. Confidence: high for the stated
recording, replay, batching and retention contracts.

Product commit `22282f70a7f57487f69d4203352b000bd47d2e7f` published
fast-forward to existing origin/zaicode; fresh remote HEAD equals local HEAD.
Exactly four reviewed paths staged; original index tree
`bac34679e02147741424747672e294197a21eca8`. Foreign `.saipen-red/` preserved.
This is product-branch publication, not a tagged workspace/installer release.
