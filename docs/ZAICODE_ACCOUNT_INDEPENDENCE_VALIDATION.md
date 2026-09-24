# ZAICODE Account-Independence Validation Matrix (SRC-002)

Execution date: 2026-09-22. Source request: `SRC-002` (account independence /
product separation delta). This document records all 13 validation checks with
the evidence that exists today. Statuses are honest: `PASS (log)` = proven by a
recorded command/log, `PASS (code)` = proven by source inspection with cited
lines, `MANUAL` = interactive desktop check that was not executed headlessly and
is logged as a manual-verify request, `NOT PRESENT` = the named surface does not
exist in this codebase, and `PRESENT (boundary)` = configuration intent exists
but the external integration protocol does not.

Environment: isolated ZAICODE profile via `tools/start-zaicode-dev.ps1`
(`HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/userData/data all under
`_ZAICODE/.zaicode/`), `ZCODE_ZAICODE_MODE=1`. Production ZCode install and
profile were never touched.

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | Fresh isolated ZAICODE profile | PASS (log) | Launcher isolation lines `tools/start-zaicode-dev.ps1:16-32`; smoke logs show all state under `.zaicode/` (`.zaicode/home/.zcode/v2/setting.json`, `.zaicode/data/.zcode/workspace/default`); no production path written. |
| 2 | No Z.ai login | PASS (log) | `.saipen/evidence/zaicode-smoke1.out.log`: no login/welcome/OAuth account flow; only local `onboarding-record` preferences and settings writes. |
| 3 | ZAICODE Desktop starts | PASS (log) | `zaicode-smoke1.out.log` and `.zaicode/smoke/smoke2.out.log`: Electron main + host start, renderer ready (`perf_app_start reported`), RPC calls OK. |
| 4 | Workspace opens | PASS (log) | `lastWorkspaceSession` written for `.zaicode/data/.zcode/workspace/default`; `window-controller.listTaskList OK` in both smokes. |
| 5 | Settings open | MANUAL | Not executed headlessly. Steps: launch isolated profile, open Settings from sidebar. Expected: settings page opens; ZAICODE section present. |
| 6 | Agent management opens | MANUAL | `zaicodeAgentPersistence.test.ts` covers agent CRUD/backend persistence; the focused services matrix is 17/17 across agent, queue, and routing suites. Interactive: sidebar -> ZAICODE -> Agent Roster, or Settings -> ZAICODE; expected roster + editor visible. |
| 7 | Queue opens | MANUAL | Queue service covered by unit tests (dispatch/claim/cancel/retry/reconcile). Interactive: sidebar -> ZAICODE -> Work Queue; expected queue panel with filters and task creation. |
| 8 | SAIFREN backend intent is selectable | PRESENT (boundary) | The ZAICODE agent editor persists the `saifren` backend and reports it unavailable; the external SAIFREN protocol is not implemented, and dispatch fails closed. This selector is not an external-product configuration surface. |
| 9 | SAIRoute/9router backend intent is selectable | PRESENT (boundary) | The editor persists `sairoute` and `9router`, reports them unavailable, and dispatch fails closed. Their external protocols are not implemented; no fallback to Direct occurs. |
| 10 | No Upgrade/Connect/Coding Plan/Start Plan product CTA in normal navigation | PASS (code, visual MANUAL) | Product-mode gates: `Root.tsx:942,1040` (login CTA), `quickPickCommands.ts:282` (login command), `WorkspaceSidebarFooterUsageSummary.tsx:456` (upgrade entry), `StatusCards.tsx:640` (plan cards), `Detail.tsx:523,529` (purchase banners), `CodingPlanUpgradeDialogProvider.tsx:51` (upgrade dialog), `ChatErrorBanner.tsx:212` (upgrade CTA). Visual sweep remains a manual step. |
| 11 | Optional Z.ai provider unconfigured without errors | PASS (log/code) | `providerFamilyConnectionSelections` empty in smoke settings; app starts with zero providers; `ZCODE_AGENT_PROVIDER_NOT_READY` is surfaced only as the truthful no-routes state (`ChatErrorBanner.tsx:76-86` -> "No execution routes configured."). |
| 12 | Installed production ZCode untouched | PASS (log) | Production `~/.zcode/v2/setting.json` mtime `2026-09-21T22:58:49.7308793Z`, unchanged after smoke1 and smoke2. |
| 13 | ZCode and ZAICODE run concurrently without mutable-state collision | MANUAL (structural proof) | State roots are disjoint by construction (launcher lines 16-32; separate userData/data/home/appdata). Concurrent interactive run of both apps was not executed; manual step: start production ZCode and ZAICODE simultaneously and confirm both remain healthy. |

## Summary

- Recorded: 13/13 checks.
- Proven: #1, #2, #3, #4, #10 (code), #11, #12.
- Manual-verify requests (not claimed as passed): #5, #6, #7, #10 (visual), #13.
- Config boundary only: #8, #9; neither external protocol is implemented.

## Manual-verify steps (request, not verdict)

Run the interactive operator check on a fresh profile with zero providers,
then add one valid independent provider/model for the real Direct execution:

1. Start production ZCode and the ZAICODE desktop. Confirm both stay open and
   the production profile remains unchanged.
2. In ZAICODE, open Settings and verify the ZAICODE section is reachable with
   no account wall. Verify Agent Roster and Work Queue open from the workspace.
3. With zero providers configured, verify the workspace remains usable and the
   UI says `No execution routes configured.` Z.ai remains an optional provider;
   there are no mandatory Connect, Upgrade, Coding Plan, or Start Plan paths.
4. Configure a valid independent provider/model, select the Direct backend,
   create and save an agent, then reload the roster and confirm the backend and
   provider/model remain configured.
5. Create a queue job, dispatch it, observe the real provider/model in runtime,
   and verify the terminal status plus Inspector result/error and resolved
   provider/model.
6. Restart ZAICODE, confirm the job history and agent still load, then repeat
   the production-profile comparison. Do not treat source inspection or unit
   tests as this interactive result.

## T-12 continuation evidence (2026-09-23)

This section updates implementation facts without converting interactive checks
into passes. The account-independence smoke evidence above is historical; this
continuation has not repeated the interactive UI or installed-app concurrency
checks.

- Agent backend is persisted through additive migration
  `0005_zaicode_routing_backend`; old rows receive `direct`. Agent create,
  update, read/list, and duplicate preserve the value. The agent editor exposes
  Direct, SAIFREN, SAIRoute, and 9router; only Direct is implemented.
- Unimplemented backend dispatch fails closed. Configured backend and
  provider/model are shown separately from resolved runtime provider/model.
- Tool policy allow/deny arrays survive editor saves and plan-mode changes;
  executor runtime projection remains covered by focused tests.
- Focused checks recorded in `.saipen/LOG.md` E-138 through E-145 cover the
  editor policy, backend migration/persistence, UI status model, executor, and
  typecheck. The final focused matrix is services 17/17, UI 4/4, desktop 10/10,
  canonical identity 5/5; no interactive behavior is claimed by those tests.
- Canonical identity/environment, web build, desktop build, and Windows bundle
  gates passed under Node 24.14.0 and pnpm 10.33.2. The unpacked executable was
  smoke-launched; it was not installed.
- A fresh packaged-app smoke ran from unpacked `ZAICODE.exe` with a separate
  `.zaicode-t12-smoke` profile: Electron reported DOM ready and app start, wrote
  the default workspace, stored settings/database/logs/cookies under that
  profile's home/data/userData roots, and logged provider count 0 with no active
  provider. OAuth cache restore skipped because no provider was active. The
  production `setting.json` mtime remained
  `2026-09-21T22:58:49.7308793Z`. The provider-not-ready/login wording appeared
  only in the runtime log; it was not verified visually in the UI.
- The smoke logged a missing optional bundled Windows GLM runtime warning. The
  app still reached DOM ready with zero providers; execution through an
  independently configured provider remains part of T-9's real E2E.
- The NSIS package was built but not installed. Parallel installed-app
  coexistence and settings/roster/queue click-through remain manual checks.
