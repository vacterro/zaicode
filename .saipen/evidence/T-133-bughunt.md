# T-133 -- bug hunt and polish (SRC-096): what was found, the evidence, the fix, the test that is red on the old source

Operator (2026-09-30): "keep catching and fixing bugs to the end; make it work well enough and polish the existing features".

## How the defects were found

Not by reading code for taste. Three sources, each measured:

1. **The operator's own logs.** `~/.zaicode/v2/logs/*.log` (ZAICODE main + host, 14-day retention), `~/.zcode/cli/log/*.jsonl`
   (agent runtime), `%APPDATA%\ZAICODE\launcher.log`. Grouped by message with the ids and numbers normalised, by count and by bytes.
2. **The live process table** (`Get-CimInstance Win32_Process`), read only.
3. **The built app driven on a throw-away profile** (Playwright `_electron`, window 959x1060 = the operator's saved window size), with an
   RPC counter: the host logs every `[rpc:call]`, so the delta per surface shows any loop. Screenshots of every surface were looked at.

## Found and fixed

| # | Defect | Evidence | Fix (zcode) | Test red on the old source |
|---|--------|----------|-------------|----------------------------|
| 1 | Agent shells left without their owner run forever | 3 bash trees from 27.09 (`node --test ... \| grep/head`, AUDAPACK) alive on 30.09, their `zcode.cjs app-server` parent dead; the bundled `ugrep.exe` one held made `launcher.log` log "Pruning leftover win-unpacked.previous-20260928103829" at every start without success | fe2143e `zaicodeOrphanShells.ts`: 20 s after start and every 30 min, a shell with the agent's startup signature whose parent is gone (or reused by a younger PID) is killed with its tree; dry run on this machine selects exactly the 3 roots (38228, 47956, 37360) out of 10 agent shells, scan 300 ms | desktop `zaicodeOrphanShells.test.ts` O1-O7 (new module) |
| 2 | Stuck audit campaign re-logged and rewritten every minute | host log: "wave core rejected (artifact-missing)" for `_ZAICODE` and `_LIMISAW` 20x per 10 min, 2,880/day; `campaign.json` `updatedAt` moved every minute (two schema-1 campaigns from 27.09 whose core report was never written) | e752256 `reconcileCampaign`: an unchanged verdict returns without warning or write; a late valid report still advances | services `zaicodeAudits.test.ts` "T-133 a blocked wave is re-checked quietly" (red: "no warning per pass") |
| 3 | Settings > ZAICODE re-fetched in a loop | host log 27.09: `zaicode-agents.list`, `listTemplates`, `zaicode-jobs.getMaxConcurrency`, `getDelegationPolicy` 2,081,346 calls EACH (1.44 of 1.49 GB log that day); 29.09: 102,403 each. Built app: 6,516 `getMaxConcurrency` calls in 10 s on that page. Cause: `resolveZaicodeServices()` built a new object every render, the page's load effect depended on it, each load's setState rendered again | 5df72be: the same services resolve to the same object. Built app after the fix: 1 call per method in 10 s | ui `zaicodeT133BugHunt.test.ts` B1 |
| 4 | Title bar: long project name ran under the clock | screenshot: "ZAI" and no ellipsis, the session title and its "..." menu hidden; the right-click wrapper was the flex item with `min-width:auto` | 5df72be: wrapper `min-w-0 shrink`, the session title shrinks first (`flex-shrink:4`), a narrow session header shows the clock's time only (date/part of day in the tooltip; SAIHOME keeps them) | B3, B4 |
| 5 | SAIHOME Now tiles cut their values | screenshot at 959 px: "0 run · 0 r...", "0 tok · 0 d...", "none pendi...", "nothing ar..." | 5df72be: tiles 112 px min, values wrap | B2 |
| 6 | SAIPEN strip in a draft with no project | screenshot: "INIT SAIPEN" + "No .saipen/ in this project" next to "Select project" | 5df72be: the strip renders only with a project path | B5 |
| 7 | Small polish | sounds folder path broke inside "sounds" ("sound / s"); an empty alarm time shown as an orange error; SAIHOME Projects name column narrower than the status | 5df72be | B6, B7, B8 |
| 8 | Dates in UTC instead of the operator's day | built app: a Sounds preset saved at 01:45 on 30 Sep (Tallinn) listed as "29 Sep 2026" (`getUTC*`); the SAIHOME statistics export named its file after the UTC day | 744c695: local calendar day | B9 (Tallinn, New York) |
| 9 | SAIMAIL envelope opened Settings, not the letters | built app with the bundled release defaults (`zaicodeSettingsDefaults.json`, 27.09: `saimailClick: "settings"`): a click with 1 unread opened Settings. T-115 made "reader" the default but honoured values stored before the reader existed ("brief" was the old default every save wrote) | 480a0c2: `saimailRev` 1 moves pre-reader values to the reader once; a later choice sticks | `zaicodeSaimailReader.test.ts` (updated: a pre-reader value migrates; a value with `saimailRev: 1` sticks) |
| 10 | SAIHOME HEALTH red for good: "Router up · 41 provider(s) failing" | 9router `/api/providers` (read, GET): 41 of 57 active connections carry `lastError`, dated 15.09, 22.09, 23.09 ... -- 9router keeps it until the next success, and unused free providers never get one | (this batch) only errors from the last hour count; degraded when at least a quarter of the active providers (min 3) erred in that hour or SAIFREN is empty; the Router page shows an old error amber with its date | B11 |
| 11 | Wording | test letter "2026-09-29T22:44:24.547Z" (UTC) at 01:44 local; Activity "1 turns"; SAIMAIL "off" hint named a Create mailbox button that only appears once a folder is typed | 480a0c2 | desktop `zaicodeSaimailPost.test.ts` T-133, B10 |

Also proven on the real machine: the built `out/` app, 20 s after start, stopped exactly the three orphan trees (log: `[zaicode-orphans] stopped an agent shell left without its owner: pid 38228 (parent 26508 gone), 3254 min old ...`, same for 47956 and 37360); the bash processes of live agents were left alone. `win-unpacked.previous-20260928103829` (held by that ugrep) is now free for the launcher's prune at the next start.

## Looked at and left

- `MaxListenersExceededWarning: 11 zcode:settings-changed listeners`: each `useSettings()` subscribes once and unsubscribes; reads are deduplicated. Not a leak.
- "Tooltip is changing from controlled to uncontrolled": upstream `open={cond ? false : undefined}` pattern (ModelConfigSelect, V4ComposerModeControls).
- `session.model_selection.persist_failed` (FOREIGN KEY) and `v4 gateway error Session not found`: upstream deferred-persistence drafts, a warning only.
- `file.readTextFile` ~175k/day: SAIPEN pollers, ~0.5 ms each, by design.
- Memory telemetry 29.09: main ~310 MB, host 250-320 MB, flat over the day.
- Turn failures 28-29.09: 200 x GLM usage limit on one session before T-118's fix; after it, isolated.
- Chat cycle in the built app: send, queue during a turn (Steer / edit / delete), queued follow-up drains, Stop -> "Stopped" + CONTINUE ALL 1: all work.
- Also working in the built app: session rename (right-click) survives a reload; Sounds presets save / apply / undo; SAIMAIL create mailbox ->
  set up delivery -> test letter -> envelope "1" -> reader -> Open shows the body.
- Start-up: `database-startup` 5.2-5.5 s on the operator's data vs 2.0-2.2 s on a fresh profile. It is upstream's storage preparation, one
  zcode.cjs worker per warm-up workspace (3 here) run one after another before services start; the agent DB is 1.38 GB (518 sessions,
  211k parts, shared with the production ZCode). Not changed: the sequence guards DB migrations.
- `UnhandledPromiseRejectionWarning: ZCode Protocol client disposed` (~73/day): upstream shutdown path (`disposeAllAndWait`), at quit only.
- The 1.5 GB host log of 27.09 is deleted by the 14-day retention on 11.10; with fix 3 the daily log falls back to tens of MB.
- `win-unpacked.previous-before-p1` (753 MB) in `packages/desktop/dist`: a hand-made backup, not the launcher's pattern; left for the operator.
