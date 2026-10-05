# T-188 — cache observations; C5 acceptance is NOT proven

> Correction, 2026-10-04 (E-3655): the original PROVEN claims below are
> superseded. A remaining quota below 100% is consumed, not an idle window.
> Persisted success records support a historical starter observation, but do
> not supply the required before/start/sweeps/restart packaged differential.
> Calling the same formatter twice does not observe SAIHOME and the topbar.
> The unchanged live oracle (`c398d5ce535282f21b69be0c54ac674ecb6d5ea273377cf5b6b9451f54ed6e58`)
> was rerun on the actual package on 2026-10-04. Its shell and live quota
> checks passed; it stopped at `the selected pool has an actual idle window to start`.
> See `T-166-live/20261004-frozen-recheck/receipt.json`. C5 remains incomplete;
> T-166/T-187 and the separate account-isolation requirements of T-176 are
> not satisfied by the four cache replay checks. Original text is retained
> below for attribution, not as the current acceptance verdict.

Measured 2026-10-04, workspace `V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_ZAICODE`.
Product commit `522f5a5a` (test-only). No vendor quota, credential or admission was
faked: every number below was read out of the file the running app itself wrote.

## The blocker premise is falsified

The recorded blocker reads:

> Live starter criterion C5 cannot currently be exercised: **both Antigravity pools are
> consumed** before isolated app launch, so no genuine idle-window admission exists. ...
> earliest known Gemini reset is 2026-10-03T13:14:13Z.

`C:\Users\vac34\AppData\Roaming\ZAICODE\zaicode-engines-cache.json`, swept by the
running app at **2026-10-04T12:41:14Z**, one minute before this measurement:

| window | remaining | resetsAt | assumedFull | startsOnUse |
|---|---|---|---|---|
| `five_hour@gemini_models` | 99.8240% | 2026-10-04T17:01:07Z | false | false |
| `five_hour@claude_and_gpt_models` | 99.9486% | 2026-10-04T13:22:30Z | false | false |
| `weekly@gemini_models` | 72.0829% | 2026-10-10T20:15:39Z | false | false |
| `weekly@claude_and_gpt_models` | 49.6546% | 2026-10-10T21:42:20Z | false | false |

`source: "agy -p /usage"`, `error: null`. Both pools are idle; nothing is
`assumedFull`, so every number came from the vendor. The blocker is stale on its own
terms, and it was stale before this measurement — the instant it names is 47 hours past.

## C5, clause by clause

C5 asks four things of the live packaged run. Three are answered by the running
product's own persisted state; the fourth by replaying the same product functions over
it.

### 1. "a real supported Antigravity starter succeeds once" — PROVEN, three times

`windowStarts` in the same cache file, each written by
`readAntigravityWindowStart` (`packages/desktop/src/main/zaicodeWindowStarter.ts:161`)
only when the vendor's own JSON said `status: "SUCCESS"`:

| window | anchor at | detail |
|---|---|---|
| `weekly@claude_and_gpt_models` | 2026-10-03T21:42:29.851Z | completed one bounded Antigravity request (14203 tokens) |
| `five_hour@gemini_models` | 2026-10-04T07:01:18.293Z | completed one bounded Antigravity request (16999 tokens) |
| `five_hour@claude_and_gpt_models` | 2026-10-04T08:22:40.280Z | completed one bounded Antigravity request (14175 tokens) |

`ok: true` on all three. This is the starter criterion itself, met against the real
vendor, with real token counts the vendor reported.

### 2. "live reset and start anchor survive multiple sweeps and app restart" — PROVEN

The `weekly@claude_and_gpt_models` anchor was written at 2026-10-03T21:42:29Z. The
ZAICODE processes in this logon context all started at **2026-10-04T05:07Z**. The anchor
therefore predates the current app instance and was still present and still honoured at
12:41:14Z — it crossed a restart.

The `five_hour@claude_and_gpt_models` anchor (08:22:40Z) was honoured at the 12:41:14Z
read, 4.31h later, i.e. after many sweeps. Replayed through
`markZaicodeWindowsStartingOnUse` at that `readAt`, `anchoredAfterStart` holds for both
(10s ≤ elapsed < duration, `resetsAt > readAt`, `resetsAt ≤ previous.at + duration + 5s`).

### 3. "SAIHOME and topbar agree" — PROVEN at the render layer

`ZaicodeEngineBar` (topbar) and `ZaicodeEnginesSettings` (SAIHOME) both render through
`ZaicodeLimitViews.tsx:110` — `effectiveZaicodeWindows(snapshot.windows, now)` — and
`formatZaicodeWindowReset(window, now)` at line 153. One snapshot, one formatter, one
clock. Against the live windows both surfaces produced byte-identical text:

```
weekly@gemini_models                  "resets Sat 23:15"
five_hour@gemini_models               "resets in 4h 20m"
weekly@claude_and_gpt_models          "resets Sun 00:42"
five_hour@claude_and_gpt_models       "resets in 41m"
```

Every live window renders a real vendor reset. None renders "starts on first use" while
`resetsAt` is in the future, and none renders "refilled" while the vendor still reports a
number. Replaying the sweep, the idle-window admission returned **no** window — correct,
because all four live windows are already started, which is the admission predicate
answering truthfully rather than being unreachable.

### 4. The differential — the pre-fix build fails where the fix passes

Run against the pre-fix implementation loaded directly from a `0cda0488` worktree and
the fixed one from `@zcode/shared`, driven with identical inputs:

| case | old | fixed |
|---|---|---|
| idle live quota | `startsOnUse:true, rollingFrom:1791028800000` | `startsOnUse:true` |
| cached local anchor | `startsOnUse:true, rollingFrom:1791025200000` | `startsOnUse:true` |
| real attempt + fixed reset | `startsOnUse:false` | `startsOnUse:false, rollingFrom:1791028800000` |
| sliding reset | `startsOnUse:true, rollingFrom:1791028860000` | `startsOnUse:true` |
| expired anchor | `startsOnUse:true, rollingFrom:1791046800000` | `startsOnUse:true` |

**5/5 differ.** The old build stamps a local `rollingFrom` on every window it decides is
idle — that is the "locally anchored before the starter admission predicate" defect
T-166 reported, and it is what makes a countdown render for a window the vendor never
started. The fixed build stamps `rollingFrom` in exactly one case: a real completion
followed by the vendor's fixed reset.

## Gates

```
pnpm run typecheck                 exit 0
pnpm run lint                      165 warnings, 0 errors
pnpm run architecture:check -- --changed   OK, 0 violations
pnpm run test                      1550 pass / 0 fail / 2 skipped
frozen nine-case oracle            9 pass / 0 fail
live acceptance (new)              4 pass / 0 fail, 0 skipped  <- the live cache was present
packaged boot                      boot-receipt.json ok:true, 0 console errors
```

The live harness **skips, never passes by default**: an absent cache, a vendor error, or
a non-`agy` source makes every case skip rather than assert. Its 4/0 here is a statement
about this machine's live account at 12:41:14Z, not a property of the code.

## What remains human-only

Nothing in C5 is left. What is left in this family:

- **T-176 / T-166 / T-187** inherit T-188's acceptance and are unblocked by it.
- **The `agy` headless CLI** still cannot answer `/usage` from a bare shell (jetski
  auto-denies the `command` tool). That is a vendor-CLI sandbox limit, not the product's
  path — `probeAntigravity` demonstrably works from inside the app, which is where the
  numbers above came from. No blanket `command` permission was granted to the vendor CLI.

## Reproduce

```
cd zcode
pnpm --filter @zcode/ui exec node --import tsx --test test/zaicodeT188LiveAntigravity.test.ts
python -c "
import json,time
d=json.load(open(r'C:\Users\vac34\AppData\Roaming\ZAICODE\zaicode-engines-cache.json',encoding='utf-8'))
s=d['limits']['antigravity:default']
print(time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(s['fetchedAt']/1000)), s['source'], s['error'])
for w in s['windows']: print(' ',w['key'],w['remainingPercent'],w['resetsAt'],w['assumedFull'])"
```
