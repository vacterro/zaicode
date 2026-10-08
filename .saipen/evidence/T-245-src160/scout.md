# T-245 SCOUT — SRC-160:R005 (CORE-005) Save All ships nested session/ephemeral state

Date: 2026-10-06 · Ticket T-245 · Source SRC-160 (audit/1.md 173-205, revalidated STILL_PRESENT).

## Board verify clause (verbatim)

"a snapshot whose allowlisted family carries sess_* / firedEvents / history payload is either
projected to an explicit per-family allowlist or rejected; a regression test poisons a sess_* key
and asserts it is absent from the snapshot"

## Sites (verified against current bytes)

| What | Where |
|---|---|
| the raw copy | `packages/ui/src/zaicode/zaicodeSettingsSnapshot.ts` `captureZaicodeSettingsSnapshot` :113-153 — every allowlisted family copied verbatim except `zaicode-audio-v1` (:119-130) |
| the allowlist | same file `ZAICODE_SAVE_ALL_SETTING_KEYS` :5-67 (56 families) |
| the shipped defaults | `packages/ui/src/zaicode/zaicodeSettingsDefaults.json` (51 lines, one JSON value per line; tracked; `packages/ui/dist/...` is an untracked build copy) |
| the T-229 write boundary | `packages/desktop/src/main/zaicodeSettingsSnapshotShape.ts` (untracked, T-229) — flat key namespace / length / count only; **not weakened here, not extended here** |
| the coverage test | `packages/ui/test/zaicodeT223SaveAllCoverage.test.ts` :183-222 asserts only a missing *top-level* key |
| the family reader | `packages/ui/src/zaicode/zaicodeUiPrefs.ts` :66-112 (`normalizeZaicodeUiPrefs` is already an explicit field allowlist, but it *keeps* `autoRetrySessions`/`schedulerIneligible`); `zaicodeAutostart.ts` :63-72 (`normalizeZaicodeContinuingJobs`) |

## Defect mechanism

`captureZaicodeSettingsSnapshot` copies whatever string the family holds. Families that mix durable
preferences with per-session or per-run state therefore ship that state as the next release's
factory default. Measured in the checked-in file today (recursive walk of all 45 settings values):

| Family | Payload found in the shipped defaults |
|---|---|
| `zaicode-ui-prefs-v1` | `autoRetrySessions{"sess_3377c3c7-bcd3-4e2e-9f26-80c5d80eb5b5":false}` |
| `zaicode-autostart-v1` | rows `firedEvents[…]`, `lastRunAt`, `lastResult` (2 jobs) |
| `zaicode-timer-prefs-v1` | `intervalRules[].lastFired` / `lastFiredMinute` (4 rules) |
| `zaicode-dispatch-prefs-v1` | `lastProject` |
| `zaicode-home-v1` | `lastView` |

Every one is state about one session, one run or the operator's last click — not a preference.
The existing test cannot see any of it: it asserts a *top-level* key is absent, and these are nested
inside allowlisted strings. `console.warn` is already the ui house style for a refused action
(`SettingsPage.tsx:1021`, `sidePaneTerminalSessionRegistry.ts:135`).

## Design (settled here)

Capture-side projection, fail-closed, one table:

* `ZAICODE_SNAPSHOT_EPHEMERAL_FIELDS: Record<family, readonly string[]>` names, per family, the
  fields that belong to a session/run and must be stripped before the family travels
  (`zaicode-ui-prefs-v1`: `autoRetrySessions`, `schedulerIneligible`; `zaicode-autostart-v1`:
  `firedEvents`, `lastRunAt`, `lastResult`, `runs`; `zaicode-timer-prefs-v1`: `lastFired`,
  `lastFiredMinute`; `zaicode-dispatch-prefs-v1`: `lastProject`; `zaicode-home-v1`: `lastView`;
  `zaicode-presets-v1`: the union — a preset is a bundle of other families' payloads).
* `ZAICODE_SNAPSHOT_EPHEMERAL_NAMES` (the union) plus the `^sess_` key pattern is the **deny
  vocabulary**. After its own strip, a family is scanned recursively: any leftover volatile field
  or session key means the family is **rejected** from the snapshot with a `console.warn` naming the
  path. Nothing travels implicitly, and an unexamined family can never leak.
* A family with no declared strip list still gets stamped verbatim — but only after the scan passes
  it, so a future session-scoped field fails closed instead of shipping. The regression test walks
  the *shipped* file, so adding a family or a field without a decision fails the suite.
* The `zaicode-audio-v1` projection, the Sound-table own-file logic, the version/`cueAudio` shape,
  the allowlist and `readZaicodeSetting` precedence stay untouched; `zaicodeSettingsSnapshotShape.ts`
  (T-229) is not weakened and not extended — the leak is closed at its source.
* The shipped `zaicodeSettingsDefaults.json` is cleaned field-by-field (only the affected value
  strings are rewritten; no reformat of the other 40 lines).

## Test plan — `packages/ui/test/zaicodeSettingsSnapshot.test.ts` (extend)

| Case | Clause |
|---|---|
| poison `zaicode-ui-prefs-v1` with `autoRetrySessions{"sess_…"}` + `schedulerIneligible{"sess_…"}`: snapshot keeps `showGreeting`, both maps gone, no `sess_` anywhere in the captured string | "a regression test poisons a sess_* key and asserts it is absent from the snapshot" |
| poison an undeclared family (`zaicode-home-v1`) with a nested `sess_…` key: the family is absent from the snapshot (rejected, nothing leaked) | "projected … or rejected" |
| autostart rows lose `firedEvents`/`lastRunAt`/`lastResult`/`runs`, keep `name`/`enabled`/`prompt`/`stopAt`/`trigger` | "explicit per-family allowlist" |
| timer rules lose `lastFired`/`lastFiredMinute`, keep `minutes`/`enabled` | same |
| the shipped `zaicodeSettingsDefaults.json` carries no session key and no volatile field at any depth | "history payload" must not ship |
| a family with no volatile state still round-trips byte-identical (T-223 ProTrail test) | contract preservation |

Red controls: the same new cases against the pre-fix capture (raw copy) — red on cases 1-5; and
against the pre-clean shipped defaults, which is the file-level half of the same defect.

## Declared ceiling

The deny vocabulary is a name list, not a schema: a future family field named e.g. `when` that means
"session id" would pass. The shipped-file test makes that visible at review time. A session id that
appears as a *value* under a durable field name is out of reach of a structural scan; only the
families' own readers know their semantics.
