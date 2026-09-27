# ZAICODE feedback coverage (T-82 / T-83)

The queue request `SRC-054` points to `V:\_TEMP_\fastprompter_drag\Auto continue_ Если_20260927_0623.md`. `SRC-055` preserves its eleven requests before the first `---` as the T-83 implementation scope. The requests after that separator repeat the earlier `SRC-053` scope; they are not a second implementation queue. The product implementation is published on `zaicode` through `4860369` and specified in `zcode/spec/zaicode-t83.md`.

| # | New request | Product owner | Evidence |
|---|---|---|---|
| 1 | Manual Stop excludes a session from Auto continue | `zaicodeContinue.ts` | `zaicodeWave60.test.ts`: stopped session stays out of Auto and remains available to explicit CONTINUE ALL |
| 2 | Visible A3 audit wave count per project | `zaicodeAuditStore.ts`, project sidebar | `zaicodeWave60.test.ts`: active campaigns contribute completed/total; terminal campaigns clear |
| 3 | Mini analogue topbar clock | `ZaicodeTopbarClock.tsx` | Topbar renders the digital and mini analogue faces together; packaged UI starts |
| 4 | Intermediate `/goal cc all` turns do not say “Task completed” | `taskNotificationOrchestrator.ts` | `zaicodeWave56.test.ts`: active goal is silent and verified goal emits completion |
| 5 | PLAY/START hydrates project before selecting MAIN | `WorkspaceSidebarItem.tsx`, `zaicodeContinue.ts` | Durable task list is read after activation; timeout sends no command; `zaicodeWave60.test.ts` checks selection |
| 6 | Full pixel game (PEBBLE DROP, replaced by SAIPEGGLE in SRC-062) | `zaicode/saipeggle/*` | `zaicodeSrc62Saipeggle.test.ts`: 55 adventure boards without overlaps, seeds, physics, a whole level won through Extreme Fever, board codes, wiring |
| 7 | Configurable ON/OFF project styling and font | `ZaicodeSidebarSettings.tsx`, `zaicodeSidebarPrefs.ts`, `WorkspaceSidebarItem.tsx` | Normalized preferences drive every project row; `zaicodeWave56.test.ts` checks ON/OFF persistence |
| 8 | Subscription effort including Codex xhigh/max (SUBCHAT removed in SRC-062; subscriptions are models in the model menu) | model menu, `shared/src/zaicode-subscription-models.ts` | `zaicodeWave71.test.ts` checks vendor mapping and stored effort |
| 9 | Continue All fits a narrow window | `ZaicodeSessionActionStrip.tsx` | Packaged Electron smoke at 640×540 checks the action strip has no horizontal overflow |
| 10 | Caption controls plus project/session context at narrow width | `WorkspaceHeader.tsx`, `WorkspaceHeaderActionSection.tsx` | Packaged Electron smoke at 640×540 checks all three caption buttons remain visible |
| 11 | Working icon media up to 1 MiB and 4096×4096, including video | `zaicodeWorkingMedia.ts`, `ZaicodeWorkingIcon.tsx`, `ZaicodeLightsSettings.tsx` | `zaicodeT83Media.test.ts` checks limits, corrupt/unsupported rejection and URL cleanup |

Verification on 2026-09-27: `pnpm run verify:pre-push`, `tsc -b packages/shared packages/ui`, the packaged Electron smoke in `packages/desktop/scripts/verify-zaicode-t83.cjs`, and `test/e2e/zaicodeFaults.e2e.ts` all passed. The game engine's six-level progression and loss path also have deterministic unit tests; the smoke covers its window and keyboard integration.
