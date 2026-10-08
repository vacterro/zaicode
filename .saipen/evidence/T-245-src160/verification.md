# T-245 VERIFICATION — SRC-160:R005 (CORE-005) Save All ships nested session/ephemeral state

Date: 2026-10-06 · Ticket T-245 · Source SRC-160 (audit/1.md 173-205) · closure mode own_patch
Owner: saipen-cli · commit tree: `zcode/` (separate Git repository, its own changes preserved)

## Requirement (verbatim from the board)

"a snapshot whose allowlisted family carries sess_* / firedEvents / history payload is either
projected to an explicit per-family allowlist or rejected; a regression test poisons a sess_* key
and asserts it is absent from the snapshot"

Disposition: **IMPLEMENTED** — SRC-160:R005.

## What was changed

| File | Change |
|---|---|
| `packages/ui/src/zaicode/zaicodeSettingsSnapshot.ts` | `ZAICODE_SNAPSHOT_EPHEMERAL_NAMES` (the volatile-field vocabulary) + `ZAICODE_SNAPSHOT_EPHEMERAL_FIELDS` (per-family declaration) + `ZAICODE_SNAPSHOT_SESSION_KEY = /^sess_/`; `stripEphemeralFields` (recursive strip), `findEphemeralPayload` (recursive scan), `projectZaicodeSnapshotFamily` (strip → scan → verbatim, or refuse with a warning); the capture loop's `else` branch now goes through it |
| `packages/ui/src/zaicode/zaicodeSettingsDefaults.json` | the shipped defaults cleaned: `zaicode-ui-prefs-v1` `autoRetrySessions`+`schedulerIneligible`, `zaicode-autostart-v1` `firedEvents`/`lastRunAt`/`lastResult`/`runs`, `zaicode-timer-prefs-v1` `lastFired`/`lastFiredMinute`, `zaicode-dispatch-prefs-v1` `lastProject`, `zaicode-home-v1` `lastView` |
| `packages/ui/test/zaicodeSettingsSnapshot.test.ts` | five T-245 cases (poison, refusal, autostart history, timer marks, shipped-file walk) + `snapshotOf` helper; `withLocalStorage` widened to a generic so a snapshot can be returned |

The `zaicode-audio-v1` projection, the cue/own-sound carry logic, the version/`cueAudio` shape, the
allowlist and `readZaicodeSetting` precedence are untouched. `packages/desktop/src/main/zaicodeSettingsSnapshotShape.ts`
(T-229, untracked, owned elsewhere) is **not weakened and not extended**.

## Defect → proof

| Defect | Proof it is closed |
|---|---|
| a per-session map travels inside `zaicode-ui-prefs-v1` | poisoned capture test: `autoRetrySessions{sess_…}`/`schedulerIneligible{sess_…}` gone, `showGreeting` kept, no `sess_` anywhere in the snapshot |
| a family the table does not know leaks instead of failing closed | poisoned `zaicode-home-v1` with a nested `sess_…` key: the family is refused (absent) and the refusal is warned |
| run/fired history ships as a factory default | autostart rows lose `firedEvents`/`lastRunAt`/`lastResult`/`runs` and keep `id`/`name`/`enabled`/`prompt`/`stopAt`/`trigger`; timer rules lose `lastFired`/`lastFiredMinute` and keep `id`/`minutes`/`enabled` |
| the checked-in file itself carries the leak | a recursive walk of every shipped family finds no session key and no volatile field |
| a family with no session state must still round-trip | byte-identical assertion (`zaicode-header-title-v1`) plus the T-223 ProTrail byte-identical test, unchanged and green |

File-level write check: pre-edit and post-edit values compared field by field — exactly 5 families
differ, every removed path is a volatile field (or an element inside one), nothing added, no value
changed, 40/45 families byte-identical, `version`/`cueAudio` equal, line endings unchanged (LF).

## RED controls — `V:/tmp/t245-red.mjs` (three, each hash-restored)

| Control | Patch | Result |
|---|---|---|
| C1 | capture copies every family verbatim again (the defect itself) | exit 1 — 4 T-245 cases red (`V:/tmp/t245-red-C1.txt`) |
| C2 | the session scan stops finding anything (leak instead of refuse) | exit 1 — the refusal case red (`V:/tmp/t245-red-C2.txt`) |
| C3 | the shipped defaults carry the live payload again | exit 1 — the shipped-file case red (`V:/tmp/t245-red-C3.txt`) |

Driver pre/post hashes equal (`6d83e565…` code, `670fb4a8…` json): no patched copy was left behind.

## Gates (this tree, this commit state)

| Gate | Result |
|---|---|
| `packages/ui` snapshot suite | 9/9 pass, 0 failing |
| `pnpm run test` (scripts + ui + services + desktop + cli core/adapters/bootstrap) | exit 0 — 118 / 1296 / 110 / 259 (2 pre-existing skips) / 45 / 9 / 11, 0 failing |
| `pnpm run lint` | exit 0 — 0 errors, 167 warnings, all pre-existing and outside the touched files (the one warning this change introduced was removed) |
| `pnpm run typecheck` | exit 0 |
| `pnpm run architecture:check -- --changed` | OK, 0 violations |

## Transitions

SCOUT → BUILD → VERIFY → RUN verify → REVIEW → SHIP → DONE (`closure_mode: own_patch`).

## OPERATOR REQUIRED

None for this ticket. Every clause is machine-checkable in this seat: the regression test is the
field gate, and the shipped file it walks is the artifact the next build ships. No packaged build,
no Electron shell and no manual screen is needed to decide R005 — unlike T-240/T-226/T-225/T-224,
this change has no visual acceptance surface.

## Declared ceiling

The refuse vocabulary is a **name list**, not a schema: a future family field that means "session"
under an unremarkable name (e.g. `when`) passes the scan. The shipped-file test makes any new
undeclared payload visible at review time, which is the upgrade path — a per-family schema would be
the real fix and is a larger design decision. A session id that appears as a **value** under a
durable field name is out of reach of a structural scan; only the family's own reader knows its
semantics.

## Residuals (named, not hidden)

* The T-229 writer boundary validates shape only (flat namespace / length / count). It does not
  re-check the payload, so a future capture-side bug would still be writable. Closing that belongs
  to the T-229 module's owner; a duplicated deny-scan in the main process would drift from the
  renderer's table.
* `zaicode-presets-v1` is stripped with the union of all volatile names, because a preset bundles
  other families' payloads. A durable field coincidentally named `runs` inside a preset would be
  stripped with it — accepted, and visible in the preset round-trip if it ever happens.
