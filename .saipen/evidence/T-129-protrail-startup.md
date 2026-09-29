# T-129: ProTrail does not start with the session (SRC-092)

Recorded 2026-09-29, session claude-code-local-verify. Product: zcode `303a41e`, `2f00201`, `3e6bb7a` (branch `zaicode`).

## What the operator said

"Еще заметил снова Protrail при начале сессии не запускается. Тоесть оно как бы «включено» вначале но приходится
переключать обратно чтобы заработало." -- ProTrail is on at the start, shows nothing, and works after it is switched
off and on. "Снова": the same class as Wave 1 A (T-107/T-108, startup convergence), which is in the running build.

## What was measured

| Fact | Source |
|------|--------|
| The operator's app (main pid 65132, started 19:09:36 local) had the three overlay renderers and the click helper created at 19:13:28, the minute of the manual toggle. | process list (creation times, parent = main) |
| `app.windows=4` (main + three overlays) held from the first memory sample at 19:10:37, in this session and the previous one. So the overlays EXISTED before the toggle and did not draw. | `~/.zaicode/v2/logs/2026-09-29.log` |
| Packaged live build (`dist/win-unpacked`, T-108 fix inside) on a throw-away profile: overlays up and drawing in 5 of 5 cold starts, also with 15 CPU burners running, also with the operator's Local Storage seeded (ProTrail enabled, everywhere). | Playwright `_electron.launch` probes; the check is a synthetic sweep, lit canvas pixels 2100-2200 per overlay |
| The overlay page holds the config at its first feed (`readyState: complete`), the drawing pipeline works (rAF 52 frames / 500 ms, 700+ stroke calls), and a toggle through the platform API changes nothing measurable. | probe spies inside the overlay pages |
| PowerToys FancyZones runs with `openWindowOnActiveMonitor` and relocates ordinary windows after show (T-94). The operator's AutoHotkey scripts do not touch ZAICODE windows (`taskbar_state.ini` lists only Total Commander). | docs/HANDOFF_PROTRAIL_CONTINUE.md, the scripts |

## Cause

**Not reproduced.** No defect was found that explains the operator's case; nothing here claims one. What the code could
not see, and now can:

1. "Running" meant: a window was built, its document loaded, the reader said ready. Nothing asked the overlay itself
   whether it holds the config, is monitor-sized, or makes frames.
2. An overlay whose document never finished loading was waited for forever (no rebuild).
3. A monitor that settled on another SIZE with the same origin left its overlay at the old size
   (`syncOverlays` compared x and y only).
4. The click reader gave up after 3 restarts until a toggle.
5. The window's own canvas went idle the moment the desktop mode was WANTED, not when it was confirmed: with
   overlays that exist but draw nothing, ProTrail was nowhere.
6. A start that failed left no line in any log.

## Change

- `zaicodeProtrailHealth.ts` (pure): `judgeOverlay` and `createOverlayHealth`. Every overlay page answers a probe
  (`window.__zaicodeProtrailProbe`: config held, enabled, page size, a real animation frame). The main process shows a
  hidden overlay, puts a moved one back (two pixels of slack, six put-backs per overlay, then one log line),
  re-sends the config to a page that never took it, and rebuilds one that did not load in 8 s or stopped
  answering (budget: 4 rebuilds per monitor per minute, then one log line). A page that answers but makes no frames
  (window hidden or covered, a fullscreen game) is only left unconfirmed, never rebuilt. One pass a second while
  anything is unconfirmed, one every 5 s once all is well.
- Status carries `verified` (confirmed overlays) and `monitors`; the start-up loop and the window canvas wait for
  every monitor to be confirmed; Settings says "Checking the overlays: 1 of 3 confirmed" while it is not.
- `syncOverlays` follows a size change; a reader that gave up is tried again every 30 s; a reader that is ready and
  silent while the cursor moves (four different positions in 15 s, no event) is replaced.
- `[protrail]` lines go to the app log (`~/.zaicode/v2/logs`): start, each overlay created/loaded/repaired, reader
  events, `N of M overlays confirmed`.
- Packaged boot gate (`verify-zaicode-protrail.cjs`, called by `verify-zaicode-boot.cjs`): waits for one overlay per
  monitor with no toggle, sends each a synthetic sweep on the real feed channel and requires lit pixels everywhere.

## Verification

- Desktop `test/zaicodeProtrailHealth.test.ts`: 23/23. Red control 1: against the pre-fix module (`bdf7ab0`, harness
  `PROTRAIL_MAIN_SOURCE`) M1-M10 are red, the rule tests and M11 (no false positive) are green on both. Red control 2:
  against the first version of the health pass (`2f00201`, `PROTRAIL_HEALTH_SOURCE` too) H3, H10, M12, M13 are red.
- REVIEW pass 1 found three risks in the first version and routed back to BUILD (`3e6bb7a`): a covered window
  (fullscreen game) was rebuilt after three strikes; the placement test was exact, so fractional scaling could move an
  overlay every second; no cap on put-backs against a window manager. Each has a test that is red on `2f00201`.
- UI `test/zaicodeProtrailConfirm.test.ts`: 6/6. Red control (`bdf7ab0` converge module): converged(running, 3 loaded,
  0 confirmed) was true and the loop asked once and stopped; it now asks until every monitor is confirmed.
- Packaged, final build `3e6bb7a` (`pnpm bundle:zaicode`, staged into `dist-next`): boot gate PASS, ProTrail drawing
  on 3 monitors, lit pixels 3396 / 3431 / 3431, 29 Settings sections, 0 console errors (`dist-next/boot-receipt.json`).
  The first bundle (`303a41e`) passed the same gate (lit 6827 / 4230 / 9714) and was replaced by this one. The
  evidence probe (`protrail-probe.cjs`, operator's Local Storage seeded) drew in 2 of 2 cold starts on it.
- Controls of the gate itself, on the old live build: healthy `lit [3398,3431,3431]`; overlays handed a null config:
  red ("every ProTrail overlay draws (lit 0,0,0)"); mode switched off: red ("one overlay per monitor ... 0 of 3").
- `pnpm typecheck` exit 0; `pnpm lint` 0 errors; `pnpm run architecture:check --changed` 0 violations;
  `pnpm run verify:pre-push` exit 0 on `3e6bb7a` (ui 671, services 85, desktop 133 with 2 skipped, cli 30). One full run earlier
  showed `zaicodeRouterTransport.test.ts` red once; alone it passes and three whole-suite reruns were green (flaky, not
  ProTrail).
- Oracles changed on purpose: startup test A6 now expects the one slow health timer (was 0 pending); the call-site
  source test for `registerZaicodeProtrailGlobalIpc` expects the log hook.

## NOT verified

The operator's own start. The staged build waits in `packages/desktop/dist-next` and is swapped in by the launcher on
the next restart. Operator look: restart, wait ~15 s, ProTrail should draw without any toggle and Settings -> ProTrail
should read "Drawing over 3 monitors". If it does not: `grep "\[protrail\]" ~/.zaicode/v2/logs/<date>.log` names what
the health pass saw and did, and `node .saipen/evidence/protrail-probe.cjs <exe> --seed %APPDATA%\ZAICODE --repeat 5`
reruns the packaged check with the operator's settings. Mixed-DPI alignment and click/hold on every monitor stay with
T-94.
