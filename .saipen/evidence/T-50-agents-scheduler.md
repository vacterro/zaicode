# T-50 evidence -- SRC-038 agents + SCHEDULER

| Item (operator's words) | Cause found | Where |
|---|---|---|
| Clicks on ZAICODE do not work ("Create agent") | the editor opens in the inspector column (w-80) on the right; in a narrow window that column is off-screen, so the click seemed to do nothing | `zaicode/ZaicodeWorkspace.tsx`: container query; below 1100 px the inspector opens over the queue while there is something to show (editing, a selected agent / task) and closes with ×; above it stays beside the queue. |
| "I just want an agent that does `/goal cc all`" -- hit and go; the "what to do" I type | the job text was always wrapped in the agent persona (so `/goal` was prose, not a command) and the SAIPEN Operator template filed any text -- "fix all" -- as a new ticket (T-48) | `shared/src/zaicode-jobs.ts` (`ZAICODE_HIT_AND_GO_PROMPT`, `isZaicodeRawCommand`, `zaicodeJobTaskText`); `desktop/src/host/zaicodeRunDispatch.ts`: an empty task runs `/goal cc all`, a slash command or bare SAIPEN shortcut goes alone and first. Queue form: "what to do" is optional (placeholder says so). **Hit & go** button in the ZAICODE header: the Autopilot agent (new built-in template, `hitAndGo: true`, made on first use) queues `/goal cc all` here. |
| Job failed: `route-unresolved ... has no model pool selected` | agents created without a pick had no model | executor falls back to SAIFREN on SAIRoute, then SAIOPP (`shared/src/zaicode-routing.ts` `pickZaicodeFallbackPool`); new agents and the editor preselect the default model for new tasks (`zaicodeStore.ts`, `ZaicodeAgentEditor.tsx`). |
| Agents that maintain their projects, or sections MAIN0 / MAIN1; smart but predictable | -- | Schedules target one project or **every project of a sidebar section** (`zaicodeScheduleTargets`). An agent's inspector lists its schedules and has **Schedule this agent…** (`ZaicodeAgentSchedules`). |
| Subscriptions from the AI limit meters per agent: when to start, when and why, when to finish; start on limit resets and run to the end with goal | autostart (T-34) existed but was hidden in Settings -> Engines, one project only, no stop | `shared/src/zaicode-engines.ts`: `targetKind` / `section`, `watchEngineId` (the subscription whose reset triggers the start and whose quota gates it -- also for agent / in-app runners), `stopAt` + `runs` (queue runs are cancelled at the stop time, `zaicodeScheduleStopAt`). Runner `ui/src/zaicode/zaicodeAutostart.ts`: START in a fresh MAIN session (one project), an agent through the queue (any target), a pool through the hit-and-go agent (a section), or a subscription CLI worker; exactly-once moments, catch-up window, wait for quota stay. |
| Obvious SCHEDULER button in the sidebar; home screen button with readiness | -- | Sidebar menu line **SCHEDULER** (visible by default, right after ZAICODE, shows "N · next in …"); ZAICODE workspace tab **Scheduler** (`ZaicodeSchedulerPanel.tsx`: NEXT UP, presets, schedule rows with state and countdown, Run now to test, keep the computer awake). Home screen card "SCHEDULER: N ready · next …" or "nothing ready — make every quota reset count" (`ZaicodeSchedulerBits.tsx`, `ConversationDraftEmptyState.tsx`). |
| A prepared prompt: indicator / glow / outline around its AI limit meter, fires right after the reset | -- | `zaicodePreparedEngines` + `useZaicodePreparedMeters`: the title-bar meter cell and the sidebar engine tile of a watched subscription light up with the **meterPrepared** highlight (Highlights & motion, default green breathing box) and name the waiting prompt in the tooltip. |
| Corporate "Automations" -- useful? cut it or rework it plainly, with presets to try | upstream's page schedules prompts on a timer (the same job) in corporate wording; it knows nothing of quota resets, sections or agents | Cut from the ZAICODE sidebar menu (the line id is gone; `normalizeZaicodeLayoutList` drops it) and replaced by SCHEDULER: plain words, six presets (every 5h reset here, every reset in MAIN0, night shift 02:00 -> 07:00, steady cc every 2 h, morning saiwiki, weekly saihunt), Run now to test. Settings -> Engines points to SCHEDULER instead of a second copy. Upstream scheduled tasks already made keep running (nothing deleted). |

## Gates (2026-09-25, from `zcode/`)

- UI `node --import tsx --test test/zaicode*.test.ts`: 151/151 (new `zaicodeWave50.test.ts` 9/9). Test oracle moved: `zaicodeWave35` layout test now expects new menu ids after their predecessor (SRC-038: SCHEDULER right after ZAICODE) and three default lines.
- Desktop `node --import tsx --test test/zaicodeHitAndGo.test.ts test/zaicodeToolPolicy.test.ts`: 14/14 (raw commands, empty task, SAIFREN fallback, no-pool still fails closed).
- Services `node --import tsx --test test/zaicode*.test.ts`: 24/24.
- `pnpm typecheck`: 0 errors; `pnpm lint`: 0 errors / 72 baseline warnings; `pnpm architecture:check --changed`: OK.

## MANUAL-VERIFY (operator)

1. Narrow window -> ZAICODE -> Create agent: the editor opens over the queue; × closes it.
2. ZAICODE -> Hit & go: an Autopilot agent appears (first time) and a `/goal cc all` task starts in this project.
3. New task with an empty "what to do": it runs `/goal cc all`; no new SAIPEN ticket is filed.
4. Sidebar SCHEDULER -> preset "Every 5h reset → /goal cc all here": the row says "ready · waits for reset"; the A1 meter cell and tile glow; after the reset it fires once.
5. Preset "Every night 02:00 … stop 07:00": at 07:00 the queued runs are cancelled.
6. Home screen shows the SCHEDULER card; clicking it opens the Scheduler page.
