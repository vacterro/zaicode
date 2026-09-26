# T-67 — ZAICODE performance / leak pass (SRC-049)

Verify field: "before/after measurements (heap, listener/timer counts, render
counts, CPU at idle) with leaks found and fixed; no behaviour lost (all zaicode
tests green)."

Reproduce the census:
`node -e '<census script in this ticket's LOG entry>'` (scans
`packages/ui/src/zaicode`, `packages/desktop/src/main`,
`packages/services/src/zaicode`).

## 1. Listener / timer census (before → after: unchanged, and clean)

| measure | value |
|---|---|
| timer sites (`setInterval`/`setTimeout`) | 128 in 82 files |
| of those, files with an explicit `clear*` | 70 |
| listener sites (`addEventListener`) | 111 in 48 files |
| of those, files with an explicit `removeEventListener` | 42 |

Every file without a cleanup token was inspected one by one. All are one of:
fire-once (object-URL revoke, settle waits), self-nulling debounce
(`zaicodeSubchatStore.saveTimer`, `zaicodeWorkerWatch.state.timer` — guarded so
it cannot stack, nulled when it fires), or one-time install behind an
`installed` flag (`zaicodeScrollGuard`, `zaicodeWorkerRecovery.beforeunload`).
**No listener/timer leak found; nothing to fix here.** The sites the ticket
names as suspects — audio fades, problip, autostart scheduler, SAIPEN poller,
pixel-snap heartbeat, splash poll, engines sweep, job heartbeat, memory logger
— all have verified teardown on their stop/dispose path.

## 2. Render counts (before → after, measured headlessly)

`zaicodeNowGate.ts`: the 1-second interval still fires every second, but `now`
advances only when the display's own bucket changed (React bails out on the
identical value). Applied to `ZaicodeTopbarClock` and `ZaicodeResetTimer`.

| display | before | after |
|---|---|---|
| clock with no seconds and nothing under an hour | 60 renders/min | **1 render/min** |
| reset chip more than an hour from a reset | 60 renders/min | **1 render/min** |
| clock with `showSeconds`, or any countdown < 1 h | 60 renders/min | 60 renders/min (unchanged) |

Proof: `packages/ui/test/zaicodeWave67.test.ts` drives 60 one-second ticks and
counts state changes — 1 for the minute-granularity case, 60 for the seconds
case, plus the switch into the last hour (never freezes). Threshold is an hour
because `formatZaicodeRemaining` starts printing seconds at 59m59s.
Store-driven chips (productivity countdown, fresh marks) keep re-rendering
through their own subscriptions, so nothing freezes.

## 3. Store growth (before → after)

| store | before | after |
|---|---|---|
| audit campaign history (disk + renderer mirror) | unbounded: every campaign ever created | all *active* campaigns + newest 30 finished |

`loadCampaigns` keeps every active campaign (so reconciliation never misses
one) and caps finished history at 30; old campaign dirs and their reports stay
on disk. Prove: `packages/services/test/zaicodeAudits.test.ts` — 40 finished
campaigns list as 30, and an active campaign is never dropped.

## 4. Measurement visibility (before → after)

Before: ZAICODE had **zero** registrations in `uiMemoryDiagnosticsRegistry`, so
the 60-second heap sample in the desktop log could not see the ZAICODE layer at
all. After: three providers, ten counters —

`zaicodeTimers.timers`, `zaicodeTimers.tempTimers`,
`zaicodeTimers.intervalRules`, `zaicodeTimers.missedAlarms`,
`zaicodeAudits.campaigns`, `zaicodeAudits.activeCampaigns`,
`zaicodeNotifications.toasts`, `zaicodeNotifications.freshMarks`.

They ride every `[memory] role=renderer` line the app already writes (gated at
5 % heap / 10 % native change, 5-minute heartbeat), so the heap and counter
trends are now readable per release without new plumbing. Prove:
`zaicodeWave67.test.ts` asserts the providers are registered and are pure reads.

## 5. Heap and CPU at idle — operator-run (environment limit)

The two rows an agent cannot measure here: the desktop app is Electron and
headless UI automation is unavailable in this environment (same constraint
recorded for T-9 and T-66). Procedure for the operator:

1. Start ZAICODE, leave it on an idle project for 10 minutes.
2. Desktop log: `grep "\[memory\] role=renderer" <userData>/logs/*.log | tail -20`
   — watch `heapUsedKb`/`rssKb` between first and heartbeat lines; counters above
   must stay flat (`zaicodeTimers.*`, `zaicodeAudits.campaigns`, toasts).
3. Task Manager → ZAICODE processes → CPU at idle (expect ≈0 % with the window
   focused and no agent running).

## Gates

- ui `node --import tsx --test test/zaicode*.test.ts` → 252/252 PASS (wave67 6/6 new)
- services → 39/39 PASS (campaign cap test new)
- desktop → 49/49 PASS — **no behaviour lost**
- `tsc --noEmit`: ui, services, desktop → 0 errors
- `pnpm lint` → 0 errors

ponytail: no CPU-profiler harness added — the 60 s diagnostics line already
answers "is idle getting worse", and a profiler is a separate ticket the day a
real regression shows up in it.
