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
