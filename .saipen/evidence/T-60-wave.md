# T-60 evidence — SRC-044 / SRC-045 / SRC-046 wishlist (19 items)

Date: 2026-09-25. Repo: `zcode/` (branch `zaicode`) + workspace docs.

## Root causes found

- "Launched ~8 tasks at once, it crashed": not load. At 16:19:03 local the
  in-app session `sess_4d669c55` "PHASE SCOUT T-55" (`_ZAICODE`) got
  `/goal cc all`, wrote "Cleaning up the process tree and the half-done build
  swap first" and ran `taskkill //F //IM ZAICODE.exe //T` (agent CLI db
  `~/.zcode/cli/db/db.sqlite`, part at 1790342343524). The root launcher is also
  `ZAICODE.exe`: launcher, app and all sessions died; launcher.log has no line
  after 12:32Z; the app restarted by hand at 16:19:27.
- "Sent to queue, nothing happens": the goal continuation loop returns when
  commands are pending (`target-continuation-loop.ts`), auto-drain promoted the
  queue head only when the goal was null / complete (`queue-auto-drain.ts`).
- "DONE shows cut-off sessions": after the crash, tasks-index kept
  `task_status=running` for the dead sessions; with no live phase the brief
  was neither running nor failed, so `unreadAt` made them DONE.
- "Remove the limit": schedule prompts were cut at 2 000 characters
  (`normalizeZaicodeAutostartJobs`, `workerPrompt`).
- "Worker icon does not change": grouped rows drew the upstream `LoaderIcon`.

## Item -> change

| # | Item | Change |
|---|------|--------|
| 1 | worker display garbled | Redraw (PTY one column narrower and back) in the panel header and every worker menu |
| 2 | no length limit | prompt cap 1 000 000; long / multi-line worker prompts go via a file (`zaicode:write-prompt-file`) |
| 3 | "Trust this folder?" | worker watch answers it (first 15 min, setting `autoTrust`) |
| 4 | nearest resets column | own title-bar reset timer, hover table (#, account, pool, window, left, at, in) |
| 5 | hit-limit detector | worker watch: notice + limits re-read + keep / close / close and resume after reset |
| 6 | worker conditions | schedule `beforeRun` stopWeaker / stopAll, `onlyWhenIdle` |
| 7 | WORKERS panel snapping | dock bottom / right / left / top, title drag snaps, vertical column stacks |
| 8 | more room for text | growing textarea prompt |
| 9 | state across crashes + auto-continue | crash-cut sessions and active goals auto-continue; running workers relaunched |
| 10 | project name big in the header | `ZaicodeHeaderProjectTitle` + settings (place, font, size, bold, caps, spacing, colour, session title) |
| 11 | DONE vs INTERRUPTED | `zaicodeSessionState`, amber bars, DONE excludes, lists apart |
| 12 | Play continues | `decideZaicodeProjectStart` for ▶ START |
| 13 | crash of 8 tasks | agent CLI self-protection rule `zaicode.selfProtect.kill` + identity line + KNOWLEDGE trap |
| 14 | third view project = MAIN + CLEAR ALL DONE | `projectIsMain` (default), MAIN tab, row = MAIN, CLEAR ALL DONE |
| 15 | worker icon | grouped rows use `ZaicodeWorkingIcon` |
| 16 | queue does nothing | ZAICODE `drainPastGoal` |
| 17 | goal cc all next to MAIN; worst repos first | SCHEDULER START / Hit & go continue MAIN; section order by blocked / open tickets |
| 18 | rename menu lines | `ZaicodeLayoutEntry.label`, ✎ / double-click |
| 19 | continue only marked sessions | ⚑ marks, schedule `onlyMarked` |

## Verification (this machine)

- `pnpm typecheck` exit 0; `@zcode/core` / `@zcode/bootstrap` typecheck exit 0.
- `pnpm lint`: 0 errors, 72 warnings (none on T-60 lines).
- UI `zaicode*.test.ts`: 198/198; services 30/30; desktop 38/38; CLI (self-protection,
  plan mode, goal verdict, queue drain, clear conversation) 30/30.
- Agent CLI rebuilt; `zcode.cjs` contains `zaicode.selfProtect.kill` and `drainPastGoal`.
- GUI click-through is an operator step (see the list in the final report).
