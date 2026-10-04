# Operator stop / restart handoff — 2026-10-03

Explicit user instruction: `saipen stop - перезапущу тебя.` Stop current
execution; do not continue eligible work until the operator resumes it.
Canonical STATE/BOARD/LOG retain authority over this handoff. Bound SAIPEN
home: `V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_SAIPEN`.

Stop disposition: E-3099 first saved the explicit operator brake and this
handoff. Native `saipen stop --json` then ran for several minutes without output
or committing a stop event. Its own process was interrupted with Ctrl-C
(exit 1); the process is confirmed gone and canonical phase remains SCOUT
T-191. The host goal is **paused**, not complete. Do not restart that expensive
stop call during recovery. Read-only inspection found `stop_checkpoint` calls
`canonical_facts`, which hashes the full project tree before building its plan;
this is a possible explanation for the delay, not a measured stack trace.
No running mutator or gate was left behind.

## Resume position

- Current Work: **T-191, SCOUT**, owner `saipen-cli`. Discovery only; no T-191
  product edits or specification have been written. Source SRC-126 requests
  elapsed session hours at both the beginning and end. User clarification:
  **ZAICODE chat and worker terminal**, not this Codex conversation.
- Next useful action: inspect the existing duration components in the product
  repository, write a small specification, then enter BUILD. Reuse authoritative
  existing clocks and formatters; do not create a second persistent clock owner
  or send time display text to the terminal input.
- Chat: `packages/ui/src/v4/ConversationTurnGroup.tsx`, private
  `AssistantHistoryStatus` and `ConversationWorkSegmentFlow`; duration formatter
  `packages/ui/src/v4/conversationWorkDuration.ts` already formats hours.
- Worker: `packages/ui/src/zaicode/ZaicodeWorkerParts.tsx`,
  `ZaicodeWorkerLabel`, `ZaicodeWorkerTerminal`, `useZaicodeNow`,
  `zaicodeWorkerElapsedMs` / existing duration formatter. A footer should use
  the same running/frozen elapsed value as the header. Keep clock ticks local
  to small labels to avoid rerendering heavy chat history or terminal content.
- Architecture changed-scope gate and UI context read PASS (0 violations).
  Source reads must use `.../_ZAICODE/zcode` as cwd, not workspace root.

## Captured next requests

- **T-192 / SRC-127**: one-way extraction of an existing, working internal CLI
  worker into external Windows PowerShell, allowing ZAICODE to restart without
  terminating or duplicating that CLI process. Captured; no implementation or
  discovery yet. Investigate PTY process ownership and quit/disposal behavior.
  A fresh CLI launch is not a live handoff. An interactive visible PowerShell
  window is explicitly requested. Do not restart the operator app to test it.
- **T-190 / SRC-125**: accurate vendor-specific limit detection, delay and
  automatic continuation through selected CLI subscriptions and SAIFREN/other
  engines until quotas reset; always answer known trust prompts. Discovery is
  saved in `.saipen/kitchen/T-190-scheduler-draft.md`; no product edits yet.
  Current watcher ignores the supplied Claude Hooks review menu and caps trust
  answers at 2 / 15 minutes. Match the actual selected menu item before choosing
  "Trust all and continue"; never blindly choose another action. Existing
  scheduler pool launch paths also fail to carry the selected model consistently.

## Unpublished verified implementation with an external live gate

- **T-188 BLOCKED_EXTERNAL**, dependency of T-166, which blocks T-187 original
  continuation request. Twelve own product paths remain unstaged/unpublished.
  They repair actual Antigravity idle-window admission, per-window persisted
  attempt history, real vendor model selection and matching effort suffix.
- Frozen 9-case regression: old subject 9 FAIL; current 9 PASS. Model/effort
  and starter tests 12 PASS. Final typecheck, lint (108 warnings/0 errors),
  architecture, repository tests (1339 PASS/2 skipped/0 FAIL), build and packaged
  boot PASS. Mandatory real idle-window starter criterion C5 is **not passed**.
- Final source manifest: `.saipen/evidence/T-188-subject-final.json`.
  Final staged app: `zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe`;
  app.asar SHA256 `1c184e4a39bf67125d17201044e5379a634ee1afb50b4d4e265827e67a62bd75`.
- Frozen final live oracle SHA256
  `c398d5ce535282f21b69be0c54ac674ecb6d5ea273377cf5b6b9451f54ed6e58`,
  `.saipen/evidence/T-166-live/playwright-test-t166.js`. Genuine old-subject RED
  is `before-final-label/receipt.json`. New `after-pass3/receipt.json` fails the
  **idle-pool applicability precondition**: both vendor pools were already used.
  Do not classify this as a successful live admission or fabricate quota.
- Last known vendor resets: Gemini 2026-10-03T13:14:13Z; Claude/GPT
  2026-10-03T14:04:48Z. A fresh actual vendor read must prove idle before resuming.
- Suspected verification neighbor (not yet ticketed):
  `packages/desktop/scripts/verify-zaicode-boot.cjs` launches a temporary app
  with the real Windows credential vault accessible and keepWindowsRolling
  enabled, then deletes that profile. It may consume the idle live-test pool.
  This is an inference, not a proven cause. Before another package boot, make
  its temporary profile explicitly disable vendor window starts and assert that
  setting; retain operator defaults. Preserve the existing 12-path subject.

## Repository and execution constraints

- `zcode` is a separate Git repository, branch `zaicode`, local/published HEAD
  `dbe0459259019308179c5b49e7e4f76a01fdecc7`. Only T-189's three generated-backup
  exclusion paths were committed/published this turn. T-191/T-190/T-192 are not
  implemented. Do not stage unrelated README, provider-node index/source/tests
  or `zaicodeSettingsDefaults.json` changes. Preserve `.release-work` backups.
- Root branch master HEAD `ab9866d4e25ba7258ca403631b22a1df44eeff9d`; remote master
  had advanced to `5bb52bbf919705a37a19cda6fd2dd182e001d956` at last read. Preserve
  root pre-existing changes and audit deletions. Installed SAIPEN has another
  active ticket owner; do not edit that installation's dirty implementation.
- No test/build/live tool sessions are running. Do not kill the operator app
  or workers. Do not edit sources during frozen gates. Use pnpm10 from root
  `.tools/pnpm10/node_modules/.bin` with `C:/nodejs` prepended to PATH.
- Legacy validator T-113 can need canonical `work reverify T-113`; recover only
  an actual matching validator failure, not preemptively. Inherited closure needs
  real committed release authority; a product carrying commit alone is insufficient.
- User-facing language is Estonian per bound STYLE. Resume with the installed
  SAIPEN `continue` route and canonical phase action; retain original /goal cc all.
