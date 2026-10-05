# T-188 — the blocker named quota; the cause was a code defect. Fixed.

Measured 2026-10-04, workspace `V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_ZAICODE`.
Product tree `zcode/`, change in `packages/shared/src/zaicode-engines.ts`.

## The recorded blocker was false

> LIVE_IDLE_PRECONDITION_UNAVAILABLE ... Claude/GPT remaining is 99.948561 percent,
> already consumed

99.948561% is not "consumed". Read out of the cache the running app itself wrote at
**2026-10-04T20:04:48Z** (`%APPDATA%/ZAICODE/zaicode-engines-cache.json`,
`source: "agy -p /usage"`, `error: null`, every window `assumedFull: false`):

| window | remaining | the tile rendered | resets |
|---|---|---|---|
| weekly@gemini_models | 46.3593 | 46% | 2026-10-10T20:15:39Z |
| five_hour@gemini_models | 43.5290 | 44% | 2026-10-04T22:01:07Z |
| weekly@claude_and_gpt_models | 49.6032 | 50% | 2026-10-10T21:42:20Z |
| five_hour@claude_and_gpt_models | 99.9487 | **100%** | 2026-10-05T00:03:40Z |

The engine tile shows `Math.round(remainingPercent)`. So the product **displayed
"100%"** on a window whose admission predicate refused to start it. Nothing had to
be waited for; the user was looking at a full window that refused to roll.

## Defect 1 — admission read a different number than the display

`markZaicodeWindowsStartingOnUse` gated idle on
`!(window.remainingPercent !== null && window.remainingPercent < 100)`.
Antigravity never reports a literal 100 again after the first bounded request, so
that clause was false for every window that vendor ever touched.

Fixed with one exported definition both sides now use:

```ts
export function zaicodeWindowIsFull(window: Pick<ZaicodeLimitWindow, "remainingPercent">): boolean {
  return window.remainingPercent === null || Math.round(window.remainingPercent) >= 100;
}
```

Applied at the two sites that decided the question — the idle gate and the
`rollingFrom` stamp — and at `zaicodeWindowShowsLiveCountdown`, which asked the same
question. `zaicodeMeterPrefs.ts:167` asks it too and is left alone: it is a UI
meter preference, not admission, and no ticket covers it.

## Defect 2 — a rolling vendor was only recognised in its starts-on-use shape

`looksIdle` only fires when `resetsAt ≈ readAt + window length`, which is the
*starts-on-use* shape. Antigravity reports `resetsAt = last real start + window
length`, so a cycle nobody has touched still carries the **previous** cycle's
reset, already in the past — and neither `looksIdle` nor `waitingFromCache` could
see that. Every automatic starter on that vendor was unreachable, which is the
defect the ticket title names.

```ts
const rolledOverUntouched = window.resetsAt !== null && window.resetsAt <= readAt && zaicodeWindowIsFull(window);
```

A vendor reset that has passed while the window still reads full IS the untouched
new cycle. It is vendor-backed, not a guess: a spent window in the same state
reports a real number below full and stays out of admission.

## Proof: RED to GREEN on the live numbers

Identical input both sides — `remainingPercent: 99.82404112815857` (the live
`five_hour@gemini_models` reading), `resetsAt` one minute in the past, no local
anchor:

```
pre-fix   ADMITTED=null
post-fix  ADMITTED=five_hour@gemini_models
```

`test/zaicodeT188AdmissionFullness.test.ts` pins four cases: the rounding
definition, admission of a rolled-over full window, a spent window staying out, and
a window with a real start inside its cycle **not** being started twice. The frozen
nine-case oracle `test/zaicodeT188WindowStart.test.ts` is untouched — it could not
catch this, because every fixture in it is a literal 100% with a reset a full
window ahead, which is exactly the shape Antigravity never reports.

## Gates

```
pnpm run typecheck                              exit 0
pnpm run lint                                   165 warnings, 0 errors
pnpm run architecture:check -- --changed        0 violations
frozen nine-case + new admission cases          13 pass / 0 fail
live oracle over the real cache                 4 pass / 0 fail / 0 skipped
pnpm run test                                    see T-188-full-suite-20261004.txt
```

## What is still not proven, and why

C5 asks for a **packaged** differential: before, start, SAIHOME, topbar, sweeps,
restart, in one packaged run. Measured across all eight accounts in the live cache
at 20:07Z, every one of them returns `ADMITTED=null` — correctly:

- three Antigravity windows are mid-cycle and spent;
- `five_hour@claude_and_gpt_models` carries a real start at 19:03:50Z with its
  reset at 00:03:40Z still ahead, so refusing a second paid request is right.

An idle window now exists only at a vendor reset instant. The next is
**2026-10-04T22:01:07Z** (`five_hour@gemini_models`). No quota, credential, reset
or admission was faked to reach this point, and none will be: the packaged run has
to happen against the real vendor at a real instant.

## Reproduce

```
cd zcode
pnpm --filter @zcode/ui exec node --import tsx --test test/zaicodeT188AdmissionFullness.test.ts
pnpm --filter @zcode/ui exec node --import tsx --test test/zaicodeT188WindowStart.test.ts
python -c "
import json,time
d=json.load(open(r'C:\Users\vac34\AppData\Roaming\ZAICODE\zaicode-engines-cache.json',encoding='utf-8'))
s=d['limits']['antigravity:default']
print(time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(s['fetchedAt']/1000)), s['source'], s['error'])
for w in s['windows']: print(' ',w['key'],w['remainingPercent'],w['resetsAt'],w['assumedFull'])"
```BB6B75F1 fix(zaicode): admit a rolling window the vendor still reports full (T-188)

## Desktop main bundle rebuilt with the fix

`pnpm --filter @zcode/desktop run build` at 2026-10-04T23:31 local, log in
`T-188-package-build-20261004.txt`, exit 0. `grep -l zaicodeWindowIsFull out/` matches
`out/main/chunk-VWJ24SHD.js` — the bundle the starter actually runs carries the fix.
The electron-packaged `ZAICODE.exe` is not rebuilt by that script and the running app
was not touched.

---

## 2026-10-04T22:13Z — packaged live run across the real vendor roll

The packaged differential was attempted, not deferred. `dist-t188/win-unpacked/ZAICODE.exe`
(Windows x64, 204.3 MiB installer / 212 MB unpacked) was launched by
`playwright-core`'s `_electron` against a private profile, and held live for 57 minutes
across the `five_hour@gemini_models` roll. Raw log: `T-188-packaged-acceptance.json`;
harness `T-188-acceptance-harness.mjs`; probe `T-188-live-admission-probe.mjs`.

### The package carries the fix

Decided by token diff, not by build success:

| build | `app.asar` bytes | `zaicodeWindowIsFull` occurrences |
| --- | --- | --- |
| `dist-t188` (the fix) | 420 240 507 | **1** |
| `dist` (what the operator is running) | 364 348 977 | **0** |

### Isolation, and a real defect in my own first attempt

`--user-data-dir` does **not** isolate this app. `packages/desktop/src/main/index.ts:294`
calls `app.setPath("userData", runtimeUserDataPath)`, which overrides the Chromium switch,
and `runtimeUserDataPath` comes from `ZCODE_DESKTOP_USER_DATA_DIR`
(`packages/desktop/src/main/desktopRuntimeEnv.ts:85`). The first attempt therefore wrote
into the operator's live `%APPDATA%\ZAICODE\zaicode-engines-cache.json`; that instance was
stopped by its own PID 31860 and the harness re-launched with the env var. After the fix the
private profile owns its own cache, and the live cache stayed frozen at
`lastSweepAt 21:05:52Z` for the whole run.

### What the run measured

1003 sweep snapshots, 8 accounts, 21:09:18Z → 22:10:44Z. **No `windowStarts` record was ever
written by the packaged instance** — the starter never fired, and the reason is now measured
rather than guessed. Complete window table at the last sweep
(`.saipen/evidence/T-188-acceptance-harness.mjs` reproduces it):

```
antigravity:default  :: weekly@gemini_models=42.447/-/20:15:39; five_hour@gemini_models=99.936/-/03:01:07;
                       weekly@claude_and_gpt_models=49.603/-/21:42:20; five_hour@claude_and_gpt_models=99.949/-/00:03:40
claude:…\.claude        :: error "no subscription limits reported (API-key account?)"
claude:…\.claude-account2 :: five_hour=100/-/–; weekly=0/-/11:00:00
codex:…\.codex          :: five_hour=100/STARTS-ON-USE/03:05:20; weekly=0/-/21:17:11
codex:…\.codex-account2 :: five_hour=100/STARTS-ON-USE/03:05:21; weekly=0/-/21:38:18; weekly@base=0/-/10:13:43
codex:…\.codex-account3free :: monthly=0/-/23:14:55
freebuff:…             :: daily=100/-/00:00:00
zcode:plan             :: error "no Coding Plan key"
```

Every account is excluded for a stated, correct reason:

- **Antigravity** never reports the idle shape. All four windows carry `startsOnUse=false`
  and a concrete future `resetsAt`. Its 5 h window rolled at `22:01:07Z` and, with **no
  request from this session in between**, the very next read at `22:05:38Z` already reported
  `resetsAt 03:01:07Z` = roll + 5 h. The vendor advances the window anchor on the clock, so
  an untouched window is indistinguishable from a used one. There is no idle window to admit.
- **Codex** is the only vendor that does advertise the idle shape — both accounts show
  `five_hour = 100%` with `startsOnUse=true` and a reset ≈ read + 5 h. Admission is refused
  by the deliberate guard at `packages/shared/src/zaicode-engines.ts`: *"主额度耗尽时不能为待
  命储备触发默认模型请求"* — a spent main pool (`weekly = 0`) must not spend a request on a
  standby window. Both accounts are at `weekly = 0`.
- Claude primary is API-key based (no subscription windows), freebuff is not a starter
  vendor, zcode has no plan key.

### What this proves about the fix, on the live vendor

The run missed the acceptance moment by 4 m 31 s: the vendor advertises its idle shape for
`ZAICODE_IDLE_WINDOW_TOLERANCE_MS` = 180 s after a roll, and the sweep landed at +271 s.
Scoring the **real** captured reading both ways
(`T-188-live-admission-20261004.json`, old expression reproduced verbatim from
`bb6b75f1^`, which reads `!(remainingPercent !== null && remainingPercent < 100)`):

| seconds after the real roll | old admits | new admits |
| --- | --- | --- |
| 20 / 40 / 60 / 120 / 180 | **false** | **true** |
| 240 / 269 / 271 / 300 / 600 | false | false |

On the live vendor reading `99.93627071380615`, the pre-fix code has a **0 %** admission rate
across the entire window in which the vendor says it is idle. The fix has **100 %**. That is
the defect the ticket named, measured end-to-end on the operator's own account: the surfaces
render `Math.round(remainingPercent)`, so they printed `100%` while admission read `99.936`
and refused.

The residual miss is not a correctness bug and is not the fix's doing: the vendor advertises
the idle state for 180 s once per 5 hours, and ZAICODE samples on a 300 s sweep grid. The
probability of a sweep landing inside that window is 3/5. Making it deterministic needs a
design change the code already anticipated but never implemented — `_previousWindows` in
`markZaicodeWindowsStartingOnUse` is accepted and discarded, and it is the only place that
could remember "this window's reset advanced by exactly one duration, so the new cycle is
untouched" independently of sweep phase.

### Why T-188 stays open

Its verify clause requires *a real supported Antigravity starter succeeds once*. The vendor
window was full at the moment the app read it, but the only read that landed inside the
180 s idle advertisement did not exist in this run. The next opportunity is the
`five_hour@gemini_models` roll at **2026-10-05T03:01:07Z**, closing at `03:04:07Z`.

---

## 2026-10-05T00:05Z — the acceptance actually passed

The armed isolated instance (profile `V:/_TEMP_/zaicode-t188-armed`, same packaged
`dist-t188` exe) fired a real starter at `2026-10-05T00:05:09.691Z`:

```
windowStarts["five_hour@claude_and_gpt_models"] = {
  at:     1791158709691,                    // 2026-10-05T00:05:09.691Z
  ok:     true,
  detail: "completed one bounded Antigravity request (14162 tokens)"
}
```

`ok: true` is written only when the vendor's own `agy` JSON reported SUCCESS. The reading
that enabled it, read out of the same cache, is the one this ticket is about:

| | value |
| --- | --- |
| `remainingPercent` (raw) | `99.94872212409973` |
| what every surface renders | `100%` |
| `resetsAt` | `2026-10-05T00:03:40Z`, i.e. 119 s in the past |
| vendor shape | anchored and rolled over, no request since |

Both defects are load-bearing. Scoring **this exact reading** old vs new
(`T-188-live-red-green-20261005.json`, old expression verbatim from `bb6b75f1^`):

- **old admits: `false`.** `99.9487 < 100` fails the pre-fix guard outright; and with no
  `rolledOverUntouched` clause and a vendor that never sets `startsOnUse`, `looksIdle` was the
  only remaining path, needing `|resetsAt − (readAt + 5 h)| ≤ 180 000` — here that
  difference is **18 119 s**.
- **new admits: `true`**, `newAdmittedKey = "five_hour@claude_and_gpt_models"`.

That is the ticket's regression clause met on live vendor data, not on a fixture.

### The anchor survives, and is not re-spent

After the start the window carries `rollingFrom = 1791158709691` and
`resetsAt = 2026-10-05T05:03:40Z` = start + 5 h. Across every recorded sweep after the start
(`T-188-packaged-acceptance-20261005.json`, 191 antigravity states): the start record is
present in all of them, `rollingFrom` is identical in all of them, `resetsAt` has exactly one
distinct value, and `windowStarts` holds exactly **one** key. No duplicate paid request.

Restart, proven on a copy of the profile so the armed instance's phase for the 03:01:07Z roll
stayed intact (`T-188-restart-proof-20261005.txt`, a fresh packaged launch against
`V:/_TEMP_/zaicode-t188-restart`):

```
startRecordSurvived : true
rollingFromSurvived : true
liveResetSurvived   : true
startsAfterRestart  : 1
```

The instance re-read the vendor live after restart (`source: "agy -p /usage"`, `error: null`)
and still refused to send a second request against an already-started window.

### Verdict against the ticket's verify clause

> *a real supported Antigravity starter succeeds once, live reset and start anchor survive
> multiple sweeps and app restart*

| requirement | evidence |
| --- | --- |
| a real supported starter succeeds once | `ok: true`, 14162 tokens, `2026-10-05T00:05:09.691Z` |
| live reset survives multiple sweeps | one distinct `resetsAt` `05:03:40Z` across 191 states |
| start anchor survives multiple sweeps | `rollingFrom` identical in 191/191 |
| survives app restart | fresh packaged launch, all three `true`, 1 start |
| must fail on the old commit | `oldAdmits: false` on this exact reading |
| must pass on the fix | `newAdmits: true`, and it did pass in the packaged app |

The earlier 21:09Z–22:27Z run missed this by 4 m 31 s purely because of sweep phase; the fix
was already carried, and the second window proved it without any code change.
