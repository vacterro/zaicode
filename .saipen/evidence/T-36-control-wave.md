# T-36 evidence — SRC-031 wave (+ T-35 wiring carried)

Source: SRC-031 (6 items). T-35 (SRC-030) was half-wired when T-36 took the
seat (runtime, clock, five settings pages not mounted); the wiring is part of
this build because the same surfaces carry both waves.

## Items -> implementation

| SRC-031 item | Where |
|---|---|
| 1. AI limit meters configurable like FastPrompter (hide 0%, only usable 5h, per-engine hide) | `ui/src/zaicode/zaicodeMeterPrefs.ts` (rules + prefs), `ZaicodeMeterSettings.tsx` (panel in Settings -> Engines & limits and on right-click of the meter), `ZaicodeLimitMeter.tsx` (filters, fill used/left, vendor tint, names, glow), `ZaicodeEngineBar.tsx` (tile filter scope) |
| 2. Ambience minimal next to Problip | `ZaicodeAudioPanels.tsx` `ZaicodeAmbienceCompact`; Settings -> Sounds -> Background (Problip + Ambience side by side) |
| 3. Memory unclear | `ZaicodeMemoryExplainer.tsx` in Settings -> Memory (what/where/cost/who), clearer en-US description + empty text |
| 4. Home "Empty" twice | `zaicodeUiPrefs.ts` defaults off + `homeRev` one-time move; hover link "Home screen" -> Layout & home; home panel in `settings/ZaicodeLayoutSettings.tsx` |
| 5. Workers: separate, snappable, split, docked terminal default, project names when minimized, anchors, sidebar, Terminus, text not drawing | `zaicodeWorkers.ts` (placement panel/window, minimize, dock/float, duplicate, cycle), `zaicodeWorkerLayout.ts` (split/snap/magnet/clamp, pure), `zaicodeWorkerPrefs.ts`, `ZaicodeWorkersPanel.tsx` (bottom panel in `WorkspaceShellLayout.tsx`), `ZaicodeWorkersDock.tsx` (windows + tray), `ZaicodeSidebarWorkers.tsx`, `ZaicodeWorkerParts.tsx`, `settings/ZaicodeWorkersSettings.tsx`; `TerminalSession` font override + repaint on re-attach; registry `detachDom(key, fromHost)`; initial command survives remount; worker hotkeys (Alt+W, Alt+[ / Alt+], float, minimize, layout, even) |
| 6. Availability tint, adjustable | `zaicodeAvailabilityTint` on sidebar tiles (strength 0..60, preview in the meter panel) |

T-35 carry: `ZaicodeAppRuntime` mounted in `App.tsx`; `ZaicodeTopbarClock` in the
header; Settings group ZAICODE (Layout & home, Workers & terminal,
Notifications, Timers, Hotkeys, Help); refill/low/worker/agent/autostart/
SAIMAIL/Problip notification cards + glow; readable percent text; sound picker
in every Sounds row; ambience/problip/terminal-font moved; team presets + tour
on the ZAICODE page; Help section.

## Gates (run from `zcode/` after the last edit)

- `pnpm typecheck` EXIT=0.
- UI typecheck `tsc --noEmit -p packages/ui/tsconfig.json` EXIT=0; red control
  (planted `const n: number = "x"`) reported TS2322, file removed.
- `pnpm lint`: 0 errors (72 warnings; none in files added by this ticket).
  max-lines: `ZaicodeWorkspace.tsx` split (`ZaicodeWorkspaceStrips.tsx`); the
  upstream disable idiom with a reason on `zaicodeTimers.ts`,
  `ZaicodeSoundPicker.tsx`, `zaicodeSoundEvents.ts`.
- `pnpm architecture:check --changed`: OK, 0 violations.
- ui `node --import tsx --test test/zaicode*.test.ts` 94/94 (new
  `zaicodeWave36.test.ts` 13/13); services 20/20; core saipenGoalVerdict 10/10.
- Desktop main/preload tsconfigs: no error on the hotkey IPC lines.
- `REBUILD.cmd --fast` EXIT=0 -> staged `packages/desktop/dist-next` (172.0 MiB);
  asar contains `zaicode-workers-prefs-v1`, `zaicode-meter-prefs-v1`,
  `data-zaicode-workers-panel`, "How Memory works", "Ready-made teams",
  "Only engines that can work now".

GUI click-through is not automatable here (T-9); behaviour is covered by the
pure-rule tests above and by the staged build for the operator's check.
