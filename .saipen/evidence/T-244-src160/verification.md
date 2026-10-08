# T-244 (SRC-160 R004 / CORE-004) — verification

Clause: a rejected `jobService.cancel` leaves the Quick3 campaign in a non-terminal,
non-launching state and never enqueues a replacement wave past a live worker; a test drives a
`cancel_stop_failed` rejection and asserts the campaign status and that no wave was launched.

## The defect as it was

`zaicodeAuditService.ts` called `await this.deps.jobService.cancel(state.jobId).catch(() => undefined)`
at two sites:

| site | line (pre-fix) | what followed a swallowed failure |
| --- | --- | --- |
| `retry()` | 685 | `state.status = "pending"`, `state.jobId = null`, `campaign.status = "running"`, then `enqueueWave(...)` — a second worker is dispatched while the first is still alive |
| `cancel()` | 701 | `campaign.status = "cancelled"` — the campaign reads as finished while its worker still runs |

The queue already models the failure: `cancelZaicodeJob` keeps the live handle, writes
`cancel_stop_failed: …` on the row and rethrows (`zaicodeJobCancellation.ts` :24-40);
`ZaicodeJobService.retry` (:323) and `remove` (:356) refuse such a row; `archive()` (:716)
already refuses to archive a campaign whose stop failed. Only the two call sites above
pretended the stop had succeeded.

## Lifecycle decision (no new status value)

A failed stop is not terminal. The work is still going, so:

- `cancel()` leaves the campaign `running`, keeps `waves[i].jobId`, records `rejectReason`, enqueues nothing.
- `retry()` leaves the campaign `blocked`, keeps `waves[i].jobId` and the attempt number, records `rejectReason`, enqueues nothing.
- Both persist before returning. The status vocabulary (`planned|running|complete|blocked|cancelled`) and the wave vocabulary (`pending|running|complete|partial|blocked`) are unchanged, so no UI or repo change is implied.

## The change

`zcode/packages/services/src/zaicode/zaicodeAuditService.ts`
(sha256 `3ea8bf8c84cf8da985982f35bd9b503dcc4ee8a5496e973a5c9c537efb66ac79`):

- New `private async stopWaveJob(jobId, state): Promise<boolean>` (:304-312): awaits
  `jobService.cancel(jobId)`; on rejection records
  `state.rejectReason = "the running task could not be stopped: <message>"` and returns `false`.
- `retry()` (:703) and `cancel()` (:722) early-return via `saveCampaign` when `stopWaveJob` reports `false`,
  replacing both `.catch(() => undefined)` swallows.

`zcode/packages/services/test/zaicodeAudits.test.ts`
(sha256 `6168cf15b956e72506daa6e37ee0e36a8ec126490016f511ff1e97c7c463c04f`):

- `createHarness(factory, logger?, readBoard?, refuseCancel?)` gained the 4th parameter; with it the
  harness wraps the real `ZaicodeJobService` in a `Proxy` whose `cancel` rejects with
  `cancel_stop_failed: <label>` and whose every other property is `Reflect.get` from the real service,
  so the queue's real persistence and revision semantics still run.
- Test "T-244: a rejected cancel leaves the campaign running and launches nothing": status stays
  `running`, `waves[0].jobId` is unchanged, `rejectReason` matches `/could not be stopped: cancel_stop_failed/`,
  the queue job count is unchanged, and a freshly constructed `ZaicodeAuditService` over the same root reads `running`.
- Test "T-244: a rejected cancel inside retry never launches a replacement wave": Core writes
  `"# nothing useful\n"` so the campaign is `blocked` with Core's attempt 1; after `retry()` the status is still
  `blocked`, `currentWaveIndex` is 0, `waves[0].jobId` and `attempt` are unchanged, `rejectReason` matches
  `/could not be stopped/`, `waves[1].jobId` is `null`, and the queue job count is unchanged.

## Red controls (`V:/tmp/t244-red.mjs`, transcripts `V:/tmp/t244-red-C{1,2,3}.txt`)

Each control copies the file to a backup, patches it, runs the suite, and restores from the backup.

| control | patch | result |
| --- | --- | --- |
| C1 | `retry()` back to `.catch(() => undefined)` + re-enqueue | exit 1, 37 pass / 1 fail — only "rejected cancel inside retry …" red |
| C2 | `cancel()` back to `.catch(() => undefined)` + `status = "cancelled"` | exit 1, 37 pass / 1 fail — only "rejected cancel leaves the campaign running …" red |
| C3 | `stopWaveJob` catch returns `true` (the swallow, moved one level down) | exit 1, 36 pass / 2 fail — both T-244 cases red |

`equal: true` — the file hash before and after the runs is `3ea8bf8c…`. The controls discriminate:
each call site is independently covered, and the helper itself is covered by C3.

## Gate table

| gate | command | result |
| --- | --- | --- |
| services suite | `node --import tsx --test test/zaicodeAudits.test.ts` (cwd `packages/services`) | 38/38 pass, 0 fail, exit 0 |
| full suite | `pnpm run test` (cwd `zcode`) | exit 0 — 118 / 1296 / 112 / 259 (2 pre-existing skips) / 45 / 9 / 11, 0 failing |
| lint | `pnpm run lint` | 0 errors, 166 warnings (all pre-existing; none in a touched file) |
| typecheck | `pnpm run typecheck` | exit 0, 0 TS errors |
| architecture | `pnpm run architecture:check -- --changed` | OK, 0 violations, 0 new |

## Disposition

R004: IMPLEMENTED.

## Declared ceiling

- The two call sites are covered; `archive()`'s refusal (T-141) was already correct and is untouched.
- `stopWaveJob` reports the queue's own rejection message verbatim; it does not classify the failure
  (offline vs. busy vs. gone). The test asserts on `/could not be stopped/`, not on a taxonomy.
- The refusal path is exercised through a `Proxy` over the real job service, not through a real dead
  worker process; the real queue's `cancel_stop_failed` contract is asserted by the T-141 test family and
  is only simulated at the service boundary here.

## OPERATOR REQUIRED

none.
