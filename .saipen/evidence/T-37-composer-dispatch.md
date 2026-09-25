# T-37 evidence — SRC-032 items 1, 3, 4 (item 2 = T-38)

Source: SRC-032. Item 2 (clone the 9router_extra provider support) was split
into T-38 at intake ("этот тикет полный отдельный заход").

## Items -> implementation

| SRC-032 item | Where |
|---|---|
| 1a. Typed text is kept reliably as a draft | Drafts already persisted per scope in `ui/src/v4/composer/composerDraftStore.ts` (localStorage, flushed on blur/pagehide/unmount, 350 ms debounce). Defect found and fixed: switching sessions inside the debounce window dropped the last keystrokes of the scope being left (the scope-switch effect cleared the timer and discarded the snapshot). New `persistV4ComposerDraftContent` writes that snapshot to the previous scope, keeping its mode/model (`ConversationComposer.tsx` scope-switch effect). |
| 1b. CLEAR empties the current session by default, not a new task | New v4 command `clearConversation` (`shared/src/zcode-protocol-v4/command.ts`); native handler in `bootstrap/.../handlers/fork-edit-retry.ts`: stop the running turn (pauses an active goal), drop the goal, drop every queued input, then `runtime.rewindConversationToStart` (core `rewind-message.ts`: the same same-session branch cut edit/retry use, anchored at the first user prompt; nothing deleted from the store); refused in selection side chats (`executor.ts`). UI: `useZaicodeClearSession` request store (`zaicodeSaipen.ts`) -> `SessionPane.tsx` dispatches the command for its own session. Setting `clearMode` (`zaicodeUiPrefs.ts`, default `session`, alternative `new`) in Settings -> Layout & home -> Composer buttons. |
| 3. No hidden binding: the model picked inside is what START uses | `adoptZaicodeComposerModel` (`zaicodeDefaultModel.ts`), called from `SessionPane.handleSelectModel` (user picks only; the GLM quota fallback path does not call it): the pick becomes the default for fresh sessions (START opens one) and releases a subscription engine selected on the sidebar, with a toast saying so. Before: a single click on a sidebar engine tile persisted, and START then opened that CLI in a terminal whatever the composer said. |
| 4. Dispatcher: open a terminal / vendor CLI in any project as its own instance (AUDAPACK style) | `zaicodeDispatch.ts` (prefs: where, launchers, last project), `ZaicodeDispatchPanel.tsx` (header button "Dispatch", Alt+D; project picker, Opens in: Own window / WORKERS panel / In-app window; engine tiles with quota fill; launcher tiles: Terminal, OpenCode, operator's own), `settings/ZaicodeDispatchSettings.tsx` (launcher editor in Settings -> Workers & terminal). Own window = `launchZaicodeExternalWorker` (detached PowerShell console titled `<short> <project> | ZAICODE`, the same mechanism AUDAPACK uses: a new console per launch). Sidebar publishes `projectList` through `zaicodeSessionNav.ts`. |

Also fixed: the START / STEP / CLEAR hotkeys were listed in Settings -> Hotkeys
but no handler was registered, so binding them did nothing.
`ZaicodeSaipenControls.tsx` now registers them; the composer that last took
focus wins.

## Gates (run from `zcode/` after the last edit)

- `tsc -b` (the `pnpm typecheck` project list) EXIT 0; `tsc --noEmit -p packages/ui/tsconfig.json` 0 errors.
- `tsc --noEmit -p packages/core/tsconfig.json` 0; `pnpm --filter @zcode/core build` then
  `tsc --noEmit -p packages/bootstrap/tsconfig.json` 0 (bootstrap reads core's dist types).
- `pnpm lint`: 0 errors, 72 warnings (baseline; none in files added here). First run hit
  max-lines on `zaicodeWorkers.ts` (403 > 400): the Dispatch shell launcher was folded into
  `openZaicodeShellWorker(cwd, placement, launcher?)`.
- `pnpm architecture:check --changed`: OK, 0 violations.
- UI: `node --import tsx --test test/zaicode*.test.ts` from `packages/ui`: 99/99
  (new `zaicodeWave37.test.ts` 5/5: clear mode, model adoption, draft flush, dispatch prefs, project pick).
- Bootstrap: `node --import tsx --test ../../apps/zcode-cli/packages/bootstrap/test/clearConversation.test.ts`
  from `packages/services`: 4/4 (effect order stop -> pause -> goal -> queue -> cut -> broadcast;
  empty session noop; unavailable cut fails loudly; native + side-chat refusal).

## Red controls (VERIFY-ORACLE-01)

- Bootstrap: `clearQueueItems` call replaced by `const droppedQueueItems = 0` ->
  `clearConversation.test.ts` 2 fail / 2 pass; file restored -> 4/4.
- UI: `clearMode` forced to `"new"` and the draft merge dropped (`...rest`) ->
  `zaicodeWave37.test.ts` 2 fail / 3 pass; files restored -> 5/5.

## Bundle

- First `REBUILD.cmd --fast`: `vite build` crashed natively during "rendering chunks"
  (exit 3221225477 = 0xC0000005, access violation) with 27 GB RAM free; typecheck and
  lint were already green, so this was the toolchain, not the change. Second run EXIT 0.
- Staged `packages/desktop/dist-next/win-unpacked` (ZAICODE-3.14.0-win-x64_TEST); `app.asar`
  contains `zaicode-dispatch-prefs-v1`, `clearConversation` (5), `Empty this session`,
  `START now runs`; the bundled agent CLI `zcode.cjs` contains `clearConversation`.

## MANUAL-VERIFY STEPS + EXPECTED (GUI; T-9: no desktop automation here)

1. Restart ZAICODE (the launcher swaps dist-next in). Open a session with a few turns,
   type text in the composer, press CLEAR -> the same session (same sidebar row) shows an
   empty conversation; a running turn stops; a goal badge disappears; the typed text stays.
2. Settings -> ZAICODE -> Layout & home -> Composer buttons -> CLEAR = Open a new session ->
   CLEAR now opens a fresh draft and leaves the old session intact.
3. Click a Subs tile on the sidebar (e.g. C1), then pick SAIRoute / SAIOPP in a composer's
   model menu -> toast "START now runs SAIOPP in the app…", the tile is released, START
   opens an in-app session on SAIOPP (no terminal).
4. Type in session A, switch to session B at once, come back -> A's text is complete.
5. Header "Dispatch" button (or Alt+D) -> pick a project, "Own window", click OC -> a
   PowerShell window titled "OC <project> | ZAICODE" opens in that folder running opencode.
6. Settings -> Hotkeys: bind CLEAR to a key -> pressing it in a composer empties that session.
