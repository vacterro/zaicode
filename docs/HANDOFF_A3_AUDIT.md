# A3 audit handoff: continue the bug hunt (after zcode `84b0baa`)

For the next model that fixes bugs in ZAICODE. It carries what the previous
cloud session knows and has not fixed yet, ordered heaviest first in the three
A3 waves (`ZAICODE_AUDIT_PROFILE_A3`: core correctness, completeness,
performance). Every item says what is proven and what is a hypothesis. Verify
a hypothesis before you change code.

## 1. Entry rules

- Read `CLAUDE.md`, then `.claude/skills/saipen/SKILL.md`. Cold-recover from
  `.saipen/` (`STATE.md`, `BOARD.md`, tail of `LOG.md`). Chat memory is not
  state.
- One writer at a time: if `LOG.md` shows the local agent mid-work, stop and
  ask the operator.
- Before every commit and every push, fetch `origin/saipen-live` and
  `origin/zaicode`. If the other side moved, merge. Never rebase, reset or
  force. If `.saipen/` histories diverged, keep ours on
  `saipen-live-cloud-<sha>`, write both ids to `.saipen/LOG.md`, stop and ask.
- The product is `zcode/` (its own repo, branch `zaicode`). The workspace repo
  (branch `saipen-live`) carries docs, evidence and SAIPEN state, never a
  product byte. Do not commit `.claude/saipen-protocol`.
- The operator asked for **one commit and one push per fix**. Publishing
  verified product commits to `origin/zaicode` and checkpoints to
  `origin/saipen-live` is authorized.
- Gates in `zcode/`: `pnpm typecheck`, `pnpm lint` (0 errors; 76 warnings is
  the baseline), `pnpm run architecture:check -- --changed` (or the full check
  once everything is committed), `pnpm test`. The root typecheck does not cover
  the desktop main, preload and renderer projects: for a change there also run
  `npx tsc -p packages/desktop/tsconfig.main.json --noEmit` (and the preload or
  renderer tsconfig) and compare with the pre-existing errors. A gate you
  cannot run is recorded as NOT RUN with the reason. A failure blamed on the
  environment must be shown to fail the same way without your change.
- Each fix gets a focused regression test that fails on the old code.
- Nothing is PASS until the operator tests on Windows and says PASS. Append
  every fix to `.saipen/evidence/T-94-src062.md` (T-94 is in VERIFY) with its
  commit and the exact Windows click steps, unless the operator opens a new
  ticket.
- Commit messages: plain English, what was wrong and why the fix is right. No
  model names anywhere in commits or files.

## 2. State at handoff

- `origin/zaicode` = `84b0baa`, `origin/saipen-live` = `06c7845`.
- Gates on `84b0baa` (cloud): typecheck 0 errors, lint 0 errors / 76 warnings,
  architecture 0 violations, tests ui 391/391, services 59/59, desktop 64 + 11
  skipped (platform skips).
- The style contract is repaired (`ded-4ae736e4` on both sides), so cloud
  sessions can write SAIPEN state again. Follow the preflight in `SKILL.md`.
- Round 2 (the first launch) fixed: the onboarding crash on a fresh start
  (`79777e9`), the clipped sidebar view row (`9a7b14b`), the sound overlap
  rule mix / queue / cut (`d5472fc`), the red SAIHOME HEALTH on a new profile
  (`e3d0e7e`), and an Inspector that called a missing pool ready (`84b0baa`).
  Their Windows steps are in the evidence file.

## 3. The fresh-launch harness (Linux container)

This is how round 2 found its bugs: the full UI, a new user's empty storage,
no provider.

```
cd zcode/packages/server && npx tsup
HOME=<scratch>/freshhome ZCODE_ZAICODE_MODE=1 node dist/entry-http.js &   # :3030
cd zcode/packages/web && npx vite --port 5173 --strictPort &
```

Drive it with `playwright-core` and `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
Before the app loads, set `globalThis.__ZAICODE_PRODUCT_MODE__ = true` in
`context.addInitScript`. Each new browser context starts with empty storage.
The server keeps its data in the fresh HOME, so agents created in one run are
still there in the next: delete the folder for a clean slate. A module the app
already loaded is reachable from `page.evaluate` as
`await import("/@fs/<abs path>/packages/ui/src/...ts")`, and it is the same
instance. Ignore what only the web build shows: "Router needs the desktop app",
`window-controller` channel timeouts, `ERR_CERT_AUTHORITY_INVALID`, and the
AudioContext autoplay warnings before a click. Measure layout in the DOM
(`scrollWidth` against `clientWidth`, element rects) instead of trusting
screenshots alone.

## 4. Wave 1: core correctness

### P1. ProTrail "Everywhere in Windows" draws only on the primary monitor (reported by the operator)

The hypothesis is strong but unproven on Windows:

- `zcode/packages/desktop/src/main/zaicodeProtrailGlobal.ts`, `send()`
  (around line 204) drops every message while
  `win.webContents.isLoading()` is true. `createOverlay` sends the overlay its
  first `{ config, origin }` from `did-finish-load` (around line 283). In
  Chromium, `DidFinishLoad` comes before `DidStopLoading`, so `isLoading()`
  is very likely still true there, and that first message is dropped.
- The overlay page (`packages/desktop/src/renderer/src/zaicode-protrail.ts`)
  starts with `origin = { x: 0, y: 0 }` and subtracts the origin from every
  desktop point. The primary monitor's real origin is (0, 0), so it looks
  right. Every other monitor keeps (0, 0), draws at desktop coordinates, and
  its trail lands off its own canvas: nothing is visible there.
- Origins are sent again only by `syncOverlays()`, to overlays that already
  exist, on `display-added`, `display-removed` or `display-metrics-changed`.
  So a secondary monitor may start working after an unrelated display event,
  which makes the bug look intermittent. The primary probably gets its config
  from a later `broadcast({ config })` in `apply()`.

The fix direction: never gate the initial state on `isLoading()`. Either
send it straight from `did-finish-load`, where the page's module script has
already registered `onFeed`, or, sturdier, let the overlay pull its state
when it is ready (an invoke that returns `{ config, origin }`). Pin it with a
desktop test next to `test/zaicodeSrc62ProtrailGlobal.test.ts`.

Verify on Windows with two monitors, including one to the left of the
primary (negative x) and one with another scaling. Then check the
neighbours of this bug:

- Pixel mode forces `force-device-scale-factor=1` for the whole app
  (`main/zaicodeCrispFonts.ts`, around line 156), overlays included. The Raw
  Input helper is per-monitor-v2 DPI aware (`zaicodeProtrailInputSource.ts`,
  around line 74), so its `GetCursorPos` gives physical pixels, which
  `screen.screenToDipPoint` converts. With mixed DPI under a forced scale
  factor, confirm that `display.bounds` and the converted points agree.
- The cursor-poll fallback feeds `getCursorScreenPoint()` (DIP) without
  conversion. Check that it agrees with the overlays' origins in the same
  setups.

### P2. The same "first message before anyone listens" race elsewhere

Grep the desktop main process for sends made on `did-finish-load`,
`ready-to-show` or right after `loadURL`/`loadFile`, and for other
`isLoading()` guards (the splash window, dialogs, any extra window). Only
`zaicodeProtrailGlobal.ts` and `desktopStabilityTelemetry.ts` use
`isLoading()` today.

### P3. Hook order hazards

`79777e9` fixed three hooks that picked a different hook by argument
(`useZCodeSessionService`, `useZCodeAgentService`, `useZCodeTaskService`, now
through `useWorkspaceOrContextServices`). Search `packages/ui/src` for the
rest of the family: a hook behind `?`, `&&` or `if`, an early `return` before
a hook, and a hook inside a loop. Check whether oxlint's react-hooks rules are
on in `.oxlintrc.json`. If they are not, find out why before you switch them
on.

### P4. "Add team" on a machine without the router

`zaicodeStore.ts` `createAgent` (around line 166) gives an agent without a
pool the default model (`readZaicodeDefaultModel()`) without checking that
this machine has it. `ZaicodeTeamPresets.tsx` then reports "No SAIFREN pool
configured — pick a pool in each agent", while each new agent already shows
`new-provider/SAIFREN`. The Inspector now says the pool is missing
(`84b0baa`). Better: use the default only when it resolves against the
provider view (`resolveZaicodeDefaultSelection`), otherwise leave the pool
empty so the message is true.

### P5. New task on a fresh profile with no provider

This was not audited yet. The bundled default model is
`new-provider/SAIFREN`. The router auto-setup normally creates a provider with
that id on a fresh Windows machine (`useZaicodeRouterAutoSetup.ts`). Walk the
web harness through New task in a project with zero providers: what does the
composer offer, what happens on Enter, is every error a sentence a new user
can act on?

## 5. Wave 2: completeness

The first-launch screens not audited yet (use the harness): the ZAICODE
block's Scheduler and Audits tabs, Tour and Guide, SAIMAIL, Timers, the
hotkey page (the bundled default registers the global Alt+F9 on every install:
check what happens when another app owns it), notifications and quiet hours,
Settings at 1366×768 (compact size), and the one-time Preview.

Small first-launch defects already seen:

- SAIHOME NOW, cell QUEUE: at 1920×1080 the text is cut to "0 run · 0 re…".
- ZAICODE → Agents header: "Create agent from mode — choose a pool, then
  Save" and "Sub-agents" squeeze each other; "Sub-agents" breaks over two
  lines.
- Sidebar header running meter: with nothing working its "0" button is 7 px
  wide inside a bevel box.
- New ZAICODE strings are English only in most places. Check what `zh-CN`
  shows before you add any keys.

The sound overlap rule (`d5472fc`) leaves Problip and Ambience outside it
(they are HTMLAudio loops and blips). Ask the operator whether Problip should
follow Queue and Cut too. Do not decide it yourself.

## 6. Wave 3: performance

Measure before you change anything. These are candidates, not findings:

- `zaicodeSoundEvents.ts` `audioContext()` calls `resume()` on every call
  while suspended, so startup preheat issues about 70 resumes. It is harmless
  in Electron, whose default autoplay policy needs no gesture.
- `preheatZaicodeSounds` runs on every Sounds-table change, including each
  master-volume slider step. Decoded buffers are cached, but own files still
  go through IndexedDB. Debounce it if a trace shows cost.
- ProTrail everywhere: the main process polls `getCursorScreenPoint` at 125 Hz
  while the cursor-poll fallback is active, and batches every 4 ms. Check the
  CPU cost with the mode on and idle.
- `ZaicodeOverflowRow` measures its children in a layout effect after every
  render. Check that the header, footer and sidebar rows do not re-render in
  a loop while a session streams.

## 7. Not yours to decide

- `zcode/packages/ui/src/zaicode/zaicodeSettingsDefaults.json` is written by
  the operator's "Save all settings", and the local agent commits it as
  "operator settings snapshot". Never edit it in the cloud. It ships the
  operator's own profile ("vacuum34" and its avatar), sidebar slots keyed by
  V:\ paths, the default model, Alt+F9, the noon reminders and the hidden help
  to every fresh install. That is fine for the operator's own build. Before a
  public release it needs a clean default set: ask the operator first, then
  sanitize in `captureZaicodeSettingsSnapshot` and when the bundled defaults
  are read, never in the operator's own storage.
- Anything behind a real STOP gate, a destructive ambiguity or a missing
  credential: ask the operator.

## 8. Report back

After each fix: the commit, the gates you ran (and what you did not run, with
the reason), and the Windows steps you added to the evidence. At the end: what
is still open from this list, in the same order.
