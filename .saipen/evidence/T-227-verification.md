# T-227 verification — `/goal cc all` wave: HUNT-002 collected, reproduced, repaired, gated

Scope: the operator's `/goal cc all`. The TARGET_FREE blocker was lifted because
the saihunt role adoption in the same session produced a CURRENT uncollected
package (HUNT-002) at workspace `4e2135523fda59b7f055667dd0fbd4a6fd039f3c` /
zcode `1cbb09215880372e2ef52d2b7eae37b1812c3304`.

## 1. Convergence actions (engine state, no product byte)

| Action | Command | Result |
|---|---|---|
| HUNT-001 disposition | `saipen sub dispose saihunt HUNT-001` | `SUB_DISPOSITIONED` bound to T-147 (DONE) |
| HUNT-002 intake | `saipen sub collect` | `SUB_COLLECTED` -> Core review hypothesis **T-228** |
| Sub health after | `saipen sub status saihunt --json` | `REVIEW_PENDING`, ready 1, reviewed 1 |

The collect was refused twice before that, both correctly:
`INVALID_ROLE` for `saipen collect saihunt` (wrong verb for this project's
extension surface), then `PACKAGE_INCOMPLETE` because the stale READY HUNT-001
blocked the whole collect — the disposition above is what cleared it.

## 2. Independent reproduction (RED control, before any source change)

`packages/ui/test/zaicodeT223SaveAllCoverage.test.ts`, two new tests, run
`node --import tsx --test test/zaicodeT223SaveAllCoverage.test.ts` from
`packages/ui` on the unmodified sources:

```
tests 9 | pass 7 | fail 2
X T-227: a captured Save All family reaches its own reader
  AssertionError: the captured release default must reach the icon-profile reader
  0 !== 1
X T-227: no allowlisted family reads raw localStorage past the accessor
  zaicodeIconSlots.tsx must read its family through readZaicodeSetting,
  not localStorage.getItem(PROFILES_KEY)
```

The behavioural half is the proof, not the source half: with the release default
for `zaicode-icon-profiles-v1` seeded through the same bundled JSON the accessor
reads, the family's own reader still returned `0` profiles. A captured Save All
default was unreachable.

## 3. Repair (three read sites, no behaviour change on a populated profile)

- `zaicodeIconSlots.tsx:310` — `localStorage.getItem(PROFILES_KEY)` -> `readZaicodeSetting(PROFILES_KEY)`
- `ZaicodSaipenSidePane.tsx:47` — `readLogOrder` -> `readZaicodeSetting(LOG_ORDER_KEY)`
- `ZaicodSaipenSidePane.tsx:57` — `readTicketOrder` -> `readZaicodeSetting(TICKET_ORDER_KEY)`,
  plus the module's own `readZaicodeSetting` import

Writes stay `localStorage.setItem`; every other durable family already pairs
`readZaicodeSetting` with a raw `setItem`.

## 4. GREEN + repo gates (all post-change, one run)

Raw log: `V:/_TEMP_/saihunt/t227-gates.log` (406 KB)

| Gate | Exit | Detail |
|---|---|---|
| focused | 0 | 9/9 in `zaicodeT223SaveAllCoverage.test.ts` |
| `pnpm run verify:pre-push` | 0 | lint clean, `architecture: OK`, then the suite |
| `pnpm test` | 0 | 14 pass blocks, **3494 passed / 0 failed**, 0 `ELIFECYCLE` |
| `pnpm run typecheck` | 0 | `tsc -b` over 14 project refs |

Failure scan over the whole log: no `fail [1-9]`, no `not ok`, no `✖`, no
`ELIFECYCLE`. The only `Error:` lines are two `AttachConsole failed` console
quirks from the Windows test runner, with every suite exiting 0.

## 5. Boundary

Product repo `zcode` — exactly three paths touched by this ticket:
`packages/ui/src/zaicode/zaicodeIconSlots.tsx`,
`packages/ui/src/zaicode/ZaicodSaipenSidePane.tsx`,
`packages/ui/test/zaicodeT223SaveAllCoverage.test.ts`.
Workspace tree untouched outside `.saipen/` (engine writes via the CLI).

## 6. Deliberately NOT changed

`zaicode-saipen-pane-open-v1`, `zaicode-todo-window`,
`zaicode-notification-sound`, `zaicode-notification-custom-sound-name` stay
outside the Save All allowlist: `zaicodeProfileBundles.ts:10-14` declares those
live facts shared, so their absence is a recorded decision, not this defect.
