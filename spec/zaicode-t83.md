# ZAICODE feedback T-83: current queue delta

## Source and duplicate boundary

`SRC-055` is the byte-exact intake of
`Auto continue_ Если_20260927_0623.md`. The eleven requirements before its
first separator are the current implementation delta. The requests after the
separator repeat `SRC-053`; their implementation and verification remain
owned by T-72 and must be regression-checked, not implemented a second time.

## Owners and invariants

1. `zaicodeContinue.ts` owns continuation eligibility. Manual CONTINUE ALL and
   a project/session play action may resume a deliberately stopped turn; Auto
   never may. A session whose turn was stopped is excluded for the lifetime of
   that stopped session snapshot and becomes eligible again only after an
   explicit operator send changes its task state.
2. `taskNotificationOrchestrator.ts` owns terminal edge translation. In
   ZAICODE, a successful _turn_ is not a completed _task_ while the same
   session's goal remains active, paused, verifying, or not satisfied. Failed
   turns still notify; a genuinely terminal successful session still notifies.
3. `zaicodeAuditStore.ts` owns renderer projections of the durable A3 queue.
   Each project exposes an obvious `completed/total` wave count for every
   active campaign awaiting review or work; terminal campaigns occupy no
   badge. The audit service remains the source of truth.
4. `ZaicodeTopbarClock` owns the compact title-bar clock. Its time-of-day group
   includes a crisp, no-antialias-style mini analogue face without replacing
   the existing digital/timer controls or stealing caption drag space.
5. `decideZaicodeProjectStart` owns PLAY/START selection, and the sidebar owns
   project hydration. Clicking PLAY first opens/activates the project so its
   session and SAIPEN state can hydrate, then sends or opens the selected MAIN
   action. A cold task list cannot be mistaken for proof that nothing exists.
6. `ZaicodeSessionActionStrip` owns the Continue All layout. At narrow widths
   the primary button keeps a readable label; Auto and DONE wrap below it and
   no control overlaps or clips.
7. Project appearance settings own explicit ON and OFF styles: colour,
   opacity, font family, size, weight, underline, and a small set of restrained
   extras. The same normalized preference drives every workspace project row;
   state must remain legible without relying on colour alone.
8. SUBCHAT exposes only real vendor controls. Codex supports `low`, `medium`,
   `high`, `xhigh`, and `max`; Claude maps supported effort choices to its
   thinking-token budget; unsupported vendor/effort combinations are not sent
   silently. Persisted legacy values normalize safely to `auto`.
9. Window caption controls and current project/session context remain visible
   at the smallest supported desktop width. Lower-priority header actions may
   collapse first; minimize, maximize, close, project, and session identity do
   not disappear.
10. The working-icon loader accepts supported still/animated image and
    browser-decodable video formats up to 1 MiB and 4096×4096. It validates
    bytes/type and decoded dimensions before persistence, reports rejection,
    and renders video sources as muted looping inline media. Existing uploads
    continue to normalize.
11. The ZAICODE easter egg is a real keyboard-playable pixel game with a title
    screen, pause/restart, score/lives, progressive finite levels, win/game-over
    states, fullscreen play, and a detached-window action when desktop support
    is available. It uses the UI.md palette, square pixels, Verdana text, and
    no blurred canvas scaling.

## Event and failure semantics

- Auto filters on structured eligibility, never translated reason strings.
  A retry snapshot cannot re-arm a manually stopped turn.
- START waits for project selection/hydration only for a bounded interval. If
  hydration cannot complete, it reports the failure and sends nothing rather
  than creating a duplicate MAIN.
- A3 counts derive from campaign wave states and update after every service
  refresh. Malformed campaigns contribute no fabricated progress.
- Media validation revokes temporary object URLs on every success and failure.
  Oversize, unsupported, corrupt, or over-dimension media leaves the previous
  icon untouched.
- The game loop has exactly one animation/timer owner and releases listeners,
  frame callbacks, and fullscreen state on close.

## Acceptance scenarios

- Press Stop, leave Auto ON for multiple ticks: that session receives no
  command. Press its explicit CONTINUE/PLAY action: it resumes normally.
- Start `/goal cc all`: intermediate successful turns do not emit “Task
  completed”; terminal goal completion emits it once.
- A planned A3 campaign visibly reads `A3 0/3`; completed waves advance the
  value and terminal/cancelled campaigns clear the pending badge.
- At narrow desktop width Continue All, Auto, DONE, project/session identity,
  and all three caption buttons remain operable without overlap.
- Codex SUBCHAT accepts xhigh/max and produces the corresponding CLI option.
- A 1 MiB-or-smaller 4096×4096 image or supported short animated/video icon
  loads; invalid media is rejected without corrupting preferences.
- The game can be opened, played through all levels, paused, restarted, won or
  lost, made fullscreen, and closed without leaving an active loop.
