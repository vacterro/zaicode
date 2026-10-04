# SRC-119 delivery and acceptance

Product base: `zcode` branch `zaicode`, `4a9ad6d9`. Protocol work: T-180.
Evidence below binds implementation checks; no paid task was started to manufacture a quota failure.

| Clause | Result | Implementation / acceptance |
| --- | --- | --- |
| R001 | Verified regression | Live conversation projection retains 512 rows. Automatic leading-turn recovery stops at 240; older history loads on explicit intent. A real projection store fed 100,000 rows stays bounded. Closed stores release snapshots. |
| R002 | Verified regression | SAIFREN's unsupported binary thought choices are filtered by the existing thought policy. Its single effective choice is hidden; models with supported reasoning levels retain their selector. |
| R003 | Verified regression | Closing a view no longer publishes a false stop. Sidebar and project runtime merge live reports with index activity; only newer authoritative completion clears a report. Test uses Saituls and stale/missing index facts. |
| R004 | Packaged UI verified | Native 9router Usage page and sidebar show all router clients, totals, cache, cost estimate, chart, recent requests, models, providers and accounts. Header/footer are configurable. Ctrl+Alt+B opens/closes the sidebar. Polling runs every 10 seconds only while visible, without duplicate views over Settings. |
| R005 | Packaged UI verified | Phase opens STATE/BOARD/LOG for the exact project, including a centered new draft. Global helpers live once at Root. The unchanged GUI oracle failed before the draft fix and passes afterward. |
| R006 | Implemented; short acceptance | Renderer retention, automatic hydration and clock rendering are bounded. Completed chat data remains persisted. Existing SRC-116 cache and supervisor bounds are preserved. Fresh packaged churn acceptance is recorded separately; no new 6-9-hour soak is claimed. |
| R007 | Verified regression | Exhausted routes prefer available SAIFREN before SAIOPP/other models and exclude held providers. Failure events deduplicate across replay; unknown resets use increasing 15-minute-to-6-hour backoff, known vendor resets are honored. Successful host model telemetry clears a hold. Auto retry on a healthy replacement obeys Auto, Stop and attempt limits. |
| R008 | Implemented and regression checked | Retry/edit await the current composer model switch; rejected or missing acknowledgements prevent replay. The inherited CLI replay path uses current session selection before the historical intent's route. No live paid-quota retry was generated. |
| R009 | Existing behavior reverified | Supported rolling-window anchors persist, roll forward and heal stale first-use flags. Existing window-truth regression suite passes. Packaged health contains live Antigravity window resets with waitingForFirstUse=false. A new idle vendor window start was not induced. |
| R010 | Existing behavior reverified | Rolling windows show their countdown even at 100%; the topbar and home use the same reset filter. Existing window-truth tests pass; packaged screenshot shows the live AG countdown. |
| R011 | Existing behavior reverified | Help curriculum starts with basics and ends with the game; the packaged F1 check opens `1 · Start here`. Usage joins the engines/limits chapter. |
| R012 | Existing behavior reverified | Native Help opens internal ZAICODE Help. Issue and feature-report routes use `github.com/vacterro/zaicode`; the existing T-145 suite rechecks routing and templates. |
| R013 | Existing behavior reverified | About names ZAICODE and its repository and loads `zaicode-logo-128.png`. T-145 About HTML/escaping and packaged-resource checks pass. |

## Verification artifacts

- `src119-gates-final.log`: `pnpm verify:pre-push`, 1320 passed, 2 environment skips, exit 0.
- `src119-typecheck-final.log`: monorepo TypeScript build, exit 0.
- `src119-regression-pair.json`: identical tests/fixtures/runtime against three pre-fix subjects (5 failing of 12), then current subjects (12 passing). The scope is explicitly recorded; this is not a claim that the entire old app was restored.
- `src119-regression-red.log`, `src119-regression-green.log`: regression run output.
- `src119-settings-regression.log`: saved-default-sensitive test isolation, without resetting operator preferences.
- `src119-ui/report-before-phase-fix.json`: real earlier Phase failure.
- `src119-ui/report.json`: packaged Usage, Phase and F1 acceptance, no renderer errors.
- `src119-ui-global/report.json`: additional Settings/global mode and close-button acceptance, no duplicate Usage views.
- `src119-bundle-final.log` and `zcode/packages/desktop/dist-next/boot-receipt.json`: canonical package/resource/size/boot gates. Final package reuses prepared CLI and remote assets; current production desktop output is rebuilt before packaging.
- `src119-soak-final/verdict.json`, `timeline.jsonl`, `report.md`: fresh short packaged run. These establish short acceptance, not a new 9-hour result.

## Scope and preservation

Operator's README, package script and provider-node SAI Accounts work were present before this request. Their saved `zaicodeSettingsDefaults.json` changed during the session (Save all settings); preserve it as foreign work. It is included in the local package as operator preferences and is excluded from this ticket's commit.

Existing persisted chat logs and credentials are not deleted. Tests use their own profiles and terminate only processes they spawned. Test profiles are kept under ignored `.tools/`, outside evidence publication.

The running operator application remains untouched. The staged package is applied by the workspace launcher on its next normal start.
