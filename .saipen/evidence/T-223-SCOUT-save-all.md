# T-223 SCOUT — Save All coverage for durable UI settings incl ProTrail

Date: 2026-10-05. Ticket: T-223 (SRC-153 R004). Phase on entry: SCOUT.

## The mechanism (reuse, no parallel architecture)

- Save All = Settings → "Release defaults" → "Save all settings"
  (`packages/ui/src/settings/ZaicodeSettingsSection.tsx`, `data-zaicode-save-settings`).
- Renderer capture: `captureZaicodeSettingsSnapshot()`
  (`packages/ui/src/zaicode/zaicodeSettingsSnapshot.ts`) — allowlist
  `SETTING_KEYS`, fail-closed on missing own-sound files (throws, no partial
  JSON), scrubs runtime audio state (`problipDays` dropped, `problip.running`
  forced false). Existing tests: `packages/ui/test/zaicodeSettingsSnapshot.test.ts`.
- Main write: `saveZaicodeSettingsSnapshot(json)`
  (`packages/zcode.../packages/desktop/src/main/zaicodeSettingsSnapshot.ts`) —
  already atomic (tmp + rename) to both targets (source-tree defaults JSON +
  userData backup), 4MB cap, JSON validation, preview-safe.
- Precedence already exists at the read layer: `readZaicodeSetting(key)` =
  explicit localStorage > bundled snapshot defaults > null. Every durable
  family must read through it (BUILD to verify per family, esp. ProTrail).
- Sibling registry: `ZAICODE_PROFILE_KEYS`
  (`packages/ui/src/zaicode/zaicodeProfileBundles.ts`) — per-profile bundles,
  NOT the Save All snapshot; do not conflate. Preset sections
  (`zaicodePresetSections.ts`) already list a `zaicodeProtrail` family.

## Gaps to close in BUILD (verify clause of T-223)

1. **ProTrail missing from Save All**: `zaicode-protrail-v1` is in
   `ZAICODE_PROFILE_KEYS` and preset sections but NOT in snapshot
   `SETTING_KEYS`. Headline gap — add + round-trip test.
2. **Factory Motion Wake default is ON**: `protrailDefaults()` sets
   `click.holdWakeEnabled: true` (`protrailModel.ts:215`); UI label is
   "Motion wake" (`ZaicodeProtrailClickTab.tsx:86`); normalize falls back to
   the factory value (`protrailNormalize.ts:91`). Required: factory OFF with
   precedence explicit-user > Save All snapshot > factory, proven by test
   (fresh-profile default OFF + order). Check the store load path
   (`zaicodeProtrailStore.ts`, `STORAGE_KEY = "zaicode-protrail-v1"`) reads
   through `readZaicodeSetting` in BUILD.
3. **Family audit**: diff durable families (ui, sidebar, layout, hotkeys,
   sounds/audio, workers, meters, composer, home, saihome, protrail,
   session-text, change-floaters, saiasui, lights, appearance, dispatch,
   notifications, timers, diamonds, cues, icons, fonts, fancyzones, saipen
   log/ticket order, avatar uploads, custom names, profiles, project folders,
   default model, auto title, help-hidden, list width, palette/crisp/bevels,
   active engine, notification sound, saipen pane open, todo window, plus
   upstream zcode-* keys) against `SETTING_KEYS`. Every intended family
   round-trips; the coverage test red-controls a deliberately omitted family.
4. **Exclusions to prove absent**: credentials, tokens, session ids, active
   jobs, timers (`zaicode-timer-prefs-v1` IS in SETTING_KEYS — check it holds
   only preferences, no live timers), worker ownership, ephemeral failures.
   Locate the secret stores (provider/API keys, sai-accounts) and assert they
   are not reachable from any snapshot key, by key and by payload scan.
5. **Atomicity**: file writes already atomic; prove capture is all-or-nothing
   (throw paths emit no snapshot) and covered by test.

## Harness (cited, not re-derived)

- `cd zcode/packages/ui && node --import tsx --test test/<name>.test.ts`
- `cd zcode && pnpm run typecheck` (all packages), `pnpm exec oxlint <files>`,
  `pnpm run architecture:check -- --changed`
- This turn's gates: ui suite 1196/1196 PASS, typecheck 0 errors, arch 0
  violations (T-224 evidence `T-224-SRC-154-R001-R005.md`).

## Neighbors read

- `zaicodeSettingsSnapshot.ts` + `zaicodeSettingsSnapshot.test.ts` (snapshot),
  `desktopMainIpcPlatform.ts:459` + `desktop/.../main/zaicodeSettingsSnapshot.ts`
  (atomic write), `zaicodeProfileBundles.ts` (profiles ≠ snapshot),
  `protrailModel.ts:181-215` (factory defaults), `protrailNormalize.ts:91`,
  `ZaicodeProtrailClickTab.tsx:33,86` (Motion wake toggle).

## BUILD/VERIFY (2026-10-06, T-223)

Implemented on the live tree (SCOUT gaps confirmed still open: no protrail key,
factory wake true, store already on readZaicodeSetting):

1. `packages/ui/src/zaicode/zaicodeSettingsSnapshot.ts`: `SETTING_KEYS` exported
   as `ZAICODE_SAVE_ALL_SETTING_KEYS` + `"zaicode-protrail-v1"` appended.
2. `packages/ui/src/zaicode/protrail/protrailModel.ts`: factory
   `click.holdWakeEnabled` true -> false (OFF). Precedence needs no new code:
   store loads via `readZaicodeSetting` (explicit local > bundled snapshot >
   null) then `normalizeProtrailConfig` (`flag(value, factory)`).
3. NEW `packages/ui/test/zaicodeT223SaveAllCoverage.test.ts` (7 tests): exact
   family coverage incl ProTrail; RED-control (omitted family throws);
   ProTrail byte-identical round-trip; factory OFF + fresh-profile OFF;
   user > snapshot > factory at normalize, read and end-to-end layers;
   poisoned-localStorage capture emits allowlist keys only + no secret-shaped
   key in the allowlist + live/session keys excluded; save chained strictly
   after resolved capture (failure branch never saves).

Gates on final tree: full ui TEST_EXIT=0, 1209/1209 PASS 0 fail (1202 T-225 tree
+ 7 new); focused protrail/snapshot 38/38; `pnpm run typecheck` TC_EXIT=0;
oxlint touched files 0 warnings 0 errors; `architecture:check --changed` OK 0.
No assertion weakened, no skips, no suppressions. zcode diff owned: 2 source
files + 1 new test; foreign working-tree modifications untouched, uncommitted.
