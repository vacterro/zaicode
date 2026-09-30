# T-135 -- 9router_extra carried onto upstream 9router 0.5.91 (SRC-098)

Operator (2026-09-30, Russian): "Да, заодно пожалуйста и мой 9router_extra пропатч до конца заодно до последней версии чтобы работало."

## What "my 9router_extra" was

`%APPDATA%\9router\source` (origin `decolua/9router`, branch `test/rebase-0565`):

- 3 commits on `v0.5.65`: `be3c1907` (WorkBuddy hy3, Antigravity Gemini 3.8 flash tiers, AgentRouter, Cline, compat gateways),
  `24bd343b` (fold mid-conversation system messages), `1987013e` (OpenCode responses `response.failed` + 60 s fallback);
- 53 uncommitted working-tree files (ZCode provider, OpenCode Go session header, confirmation lifecycle, tool-call id/name
  sanitising, WorkBuddy import, tests). They are in the installed `9router 0.5.65-extra` build (strings found in its
  `.next-cli-build`), so they are part of the extra.

The operator's tree was never touched: the port ran in a clone (`V:\_TEMP_\r9x\src`); the working tree was copied in as
one commit (line endings normalised; the `golden-url-header` snapshot that upstream deliberately dropped left out).

## The port (branch `extra-0.5.91`, now also in the operator's source repo, working tree untouched)

| Commit | What |
|---|---|
| `dba63b5f` | WorkBuddy, Antigravity 3.8 tiers + quota discovery on PROD, AgentRouter, compat gateway fixes. **Cline: upstream 0.5.91 ships its own Cline (OAuth, API key, free tier via recommended-models); the extra's Cline code and its 4 Cline tests were dropped in favour of upstream's** |
| `2eca5945`, `0f9e5c9b` | system-message folding; OpenCode responses inspector |
| `4425a940` | the working-tree extras; where upstream now has the same fix (OpenCode Go executor with session header, OAuth modal flow ledger, responses tool-call indexing, 400 = no account cooldown) upstream's version was kept |
| `4f0884b0` | port fixes: duplicate registry import `p124` (agentrouter vs qoder-cn) broke the whole registry; blank tool names no longer become `__`; commandcode + responses tool names back to upstream; Gemini 3.8 upstream test aligned to the extra's `-tiered(<tier>)` ids (upstream still sends `gemini-3.8-flash-high(high)`, which Antigravity answered 404 when the extra was made) |
| `8a3075e7` | package version `0.5.91-extra` |
| `2c418210` | WorkBuddy auto-import route rewritten on the connection repo API: it imported a `db` handle that `@/lib/db` never exported (a runtime failure already in 0.5.65-extra) and carried a hard-coded fallback email |

## Gates

- 9router unit tests (`npm --prefix tests test`): port **2817 passed / 101 failed**; clean upstream `v0.5.91` in the same
  environment **2715 passed / 101 failed**, and the 101 failing tests are the same set (`comm` of the two lists is empty).
  The extra adds 102 passing tests and no failure of its own. Before the port fixes: 30 new failures, all resolved.
- Package: `npm run pack:cli` -> `9router-0.5.91-extra.tgz` (15.6 MB, 3349 files), no "Attempted import error" after the
  WorkBuddy route fix. Copied to `%LOCALAPPDATA%\9router_WatchEdit\engine\packages\`; the unified patch against
  `v0.5.91` is `engine\patches\9router-0.5.91-extra-unified.patch` (7344 lines).
- Live: `verify-zaicode-free.cjs dist\win-unpacked\ZAICODE.exe --router-package <extracted 0.5.91-extra>` on an empty
  profile: ZAICODE ran it isolated on :20138, created its key, SAIFREN and the token saver through the management API,
  first token in 1.2 s, and a New task answer after 2 s -> **PASS**.
- `apply-update.ps1` (9router_extra repo, working tree only): default package = the newest `9router-*-extra.tgz` in the
  engine folder (now 0.5.91-extra), banners name the package. `test_core004_apply_update_contract.py`: 6 passed.

## Not done on purpose

- The operator's running 9router (`%APPDATA%\9router`, used by the live ZAICODE) was **not** swapped: `apply-update.ps1`
  stops 9router, which would cut the operator's running sessions. One command applies it when nothing runs:
  `powershell -File V:\___VAC\__K\__CODE\_PY\_9router_extra\apply-update.ps1`.
- Nothing was committed in `_9router_extra` (it sits on `fix/t-53-history-remediation` with unrelated uncommitted work)
  or pushed to `decolua/9router` (upstream, not ours).

## Re-verification, 2026-09-30 afternoon (SRC-099 continuation order; SRC-101 go-ahead)

Nothing was taken from the section above on trust; every gate below was re-run on the current trees.

### A. Diff coverage -- every change of the old extra, classified

Old extra = `v0.5.65..test/rebase-0565` (be3c1907, 24bd343b, 1987013e) plus the uncommitted working tree of
`%APPDATA%\9router\source` (40 modified + 9 untracked paths). Mechanical pass (`V:\_TEMP_9x\coverage.py`):
for each path, the lines the old extra ADDED relative to v0.5.65 and how many of them are in `extra-0.5.91`
(`in new`) and in clean `v0.5.91`. >= 90 % in the new branch = PORTED; the rest was reviewed by hand against
upstream 0.5.91. Result, 92 paths: **PORTED 70** (67 mechanical + 3 adapted), **SUPERSEDED_BY_UPSTREAM 14**,
**INTENTIONALLY_DROPPED_WITH_REASON 8**, **MISSING 0**.

| Path | origin | in new / added | Class |
|---|---|---|---|
| `cli/9router-0.5.59.tgz` | wip | 0/106253 | INTENTIONALLY_DROPPED: build artifact in the working tree, not source |
| `cli/9router-0.5.65.tgz` | wip | 0/106275 | INTENTIONALLY_DROPPED: build artifact in the working tree, not source |
| `cli/README.md` | commit | 2/2 | PORTED |
| `cli/cli.js` | wip | 17/17 | PORTED |
| `open-sse/config/clineConstants.js` | commit | 0/12 | INTENTIONALLY_DROPPED: extra Cline replaced by upstream 0.5.91 Cline (OAuth, API key, free tier) |
| `open-sse/config/errorConfig.js` | wip | 3/3 | PORTED |
| `open-sse/config/providerModels.js` | commit | 4/4 | PORTED |
| `open-sse/config/runtimeConfig.js` | wip | 4/4 | PORTED |
| `open-sse/executors/base.js` | commit | 2/2 | PORTED |
| `open-sse/executors/commandcode.js` | wip | 0/5 | SUPERSEDED_BY_UPSTREAM: file identical to v0.5.91; upstream buffers split SSE lines itself |
| `open-sse/executors/default.js` | wip | 62/71 | PORTED (compat gateway helpers present); Cline hooks SUPERSEDED_BY_UPSTREAM |
| `open-sse/executors/index.js` | wip | 6/6 | PORTED |
| `open-sse/executors/opencode-go.js` | wip | 7/27 | SUPERSEDED_BY_UPSTREAM: upstream executor sends x-opencode-session |
| `open-sse/executors/opencode.js` | wip | 168/168 | PORTED |
| `open-sse/executors/workbuddy.js` | commit | 53/53 | PORTED |
| `open-sse/handlers/chatCore.js` | wip | 5/7 | SUPERSEDED_BY_UPSTREAM: forced SSE->JSON restores tool names via upstream restoreToolNames |
| `open-sse/handlers/chatCore/nonStreamingHandler.js` | commit | 11/11 | PORTED |
| `open-sse/handlers/chatCore/sseToJsonHandler.js` | wip | 0/6 | SUPERSEDED_BY_UPSTREAM: restoreToolNames(toolNameMap) on all 3 return paths |
| `open-sse/handlers/chatCore/streamingHandler.js` | wip | 1/1 | PORTED |
| `open-sse/handlers/search/callers.js` | wip | 1/1 | PORTED |
| `open-sse/handlers/search/normalizers.js` | wip | 1/1 | PORTED |
| `open-sse/providers/registry/agentrouter.js` | commit | 69/69 | PORTED |
| `open-sse/providers/registry/antigravity.js` | commit | 5/6 | PORTED: only a comment line differs |
| `open-sse/providers/registry/cline.js` | commit | 1/13 | SUPERSEDED_BY_UPSTREAM: upstream cline + clinepass registry |
| `open-sse/providers/registry/glm.js` | wip | 1/1 | PORTED |
| `open-sse/providers/registry/index.js` | wip | 3/6 | PORTED: renumbered p131-p133 (fixes p124 id collision agentrouter/qoder-cn) |
| `open-sse/providers/registry/workbuddy.js` | commit | 66/66 | PORTED |
| `open-sse/providers/registry/zcode.js` | wip | 57/57 | PORTED |
| `open-sse/providers/shared.js` | commit | 22/22 | PORTED |
| `open-sse/services/accountFallback.js` | wip | 1/4 | SUPERSEDED_BY_UPSTREAM: upstream 4xx (not 401/402/403/429) = no account lock |
| `open-sse/services/clineModels.js` | commit | 0/64 | INTENTIONALLY_DROPPED: same reason; upstream clinepassModels.js |
| `open-sse/services/combo.js` | wip | 55/55 | PORTED |
| `open-sse/services/tokenRefresh.js` | commit | 3/3 | PORTED |
| `open-sse/services/tokenRefresh/providers.js` | commit | 8/11 | PORTED (dedupRefresh); Cline refresh SUPERSEDED_BY_UPSTREAM |
| `open-sse/services/usage.js` | wip | 4/4 | PORTED |
| `open-sse/services/usage/codebuddy-cn.js` | commit | 2/2 | PORTED |
| `open-sse/shared/clineAuth.js` | commit | 0/32 | SUPERSEDED_BY_UPSTREAM: upstream shared/clineAuth.js + clineEnvelope.js |
| `open-sse/translator/concerns/kiroConversation.js` | wip | 2/2 | PORTED |
| `open-sse/translator/concerns/toolCall.js` | wip | 59/59 | PORTED |
| `open-sse/translator/formats/openai.js` | commit | 35/35 | PORTED |
| `open-sse/translator/index.js` | wip | 6/6 | PORTED |
| `open-sse/translator/request/openai-responses.js` | wip | 11/19 | SUPERSEDED_BY_UPSTREAM: upstream stringifies tool arguments/input |
| `open-sse/translator/request/openai-to-claude.js` | wip | 12/12 | PORTED |
| `open-sse/translator/response/openai-responses.js` | wip | 7/16 | SUPERSEDED_BY_UPSTREAM: upstream fallbackToolCallId in concerns/toolCall.js |
| `open-sse/utils/claudeCloaking.js` | wip | 6/25 | PORTED+SUPERSEDED: decloakToolNames kept for non-streaming; forced-SSE path is upstream |
| `open-sse/utils/opencodeGoSession.js` | wip | 39/39 | PORTED |
| `open-sse/utils/proxyFetch.js` | wip | 17/17 | PORTED |
| `open-sse/utils/stream.js` | wip | 37/37 | PORTED |
| `open-sse/utils/streamHelpers.js` | wip | 36/36 | PORTED |
| `package.json` | wip | 0/1 | PORTED: version 0.5.91-extra |
| `src/app/(dashboard)/dashboard/basic-chat/BasicChatPageClient.js` | wip | 11/11 | PORTED |
| `src/app/(dashboard)/dashboard/basic-chat/sessionLifecycle.js` | wip | 30/30 | PORTED |
| `src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js` | wip | 11/11 | PORTED |
| `src/app/(dashboard)/dashboard/providers/[id]/CompatibleModelsSection.js` | commit | 12/12 | PORTED |
| `src/app/(dashboard)/dashboard/providers/[id]/page.js` | commit | 1/5 | SUPERSEDED_BY_UPSTREAM: live cursor/cline catalogs upstream |
| `src/app/(dashboard)/dashboard/providers/components/AddCompatibleModal.js` | commit | 10/10 | PORTED |
| `src/app/api/oauth/[provider]/[action]/route.js` | wip | 7/7 | PORTED |
| `src/app/api/oauth/workbuddy/auto-import/route.js` | commit | 29/56 | PORTED (rewritten on connection repo API, 2c418210: raw db handle never exported, hard-coded email dropped) |
| `src/app/api/provider-nodes/validate/route.js` | commit | 23/23 | PORTED |
| `src/app/api/providers/[id]/models/route.js` | wip | 29/36 | PORTED (optional discovery); Cline resolver SUPERSEDED_BY_UPSTREAM |
| `src/app/api/providers/[id]/test/testUtils.js` | wip | 22/32 | PORTED; Cline auth test SUPERSEDED_BY_UPSTREAM |
| `src/app/api/providers/suggested-models/filters.js` | commit | 7/7 | PORTED |
| `src/app/api/providers/validate/route.js` | wip | 26/26 | PORTED |
| `src/app/api/usage/[connectionId]/route.js` | commit | 11/11 | PORTED |
| `src/app/api/v1/models/route.js` | commit | 4/7 | PORTED; Cline catalog SUPERSEDED_BY_UPSTREAM |
| `src/lib/modelCatalog/sync.js` | wip | 1/1 | PORTED |
| `src/lib/oauth/confirmationLifecycle.js` | wip | 21/21 | PORTED |
| `src/lib/oauth/constants/oauth.js` | commit | 2/2 | PORTED |
| `src/lib/oauth/devicePolling.js` | wip | 47/47 | PORTED |
| `src/lib/oauth/providers/cline.js` | commit | 0/74 | SUPERSEDED_BY_UPSTREAM: upstream Cline OAuth |
| `src/lib/oauth/providers/index.js` | commit | 3/3 | PORTED |
| `src/lib/oauth/providers/workbuddy.js` | commit | 87/87 | PORTED |
| `src/shared/components/ModelSelectModal.js` | commit | 0/26 | SUPERSEDED_BY_UPSTREAM: upstream LIVE_CATALOG_PROVIDERS cursor/cline/clinepass |
| `src/shared/components/OAuthModal.js` | wip | 2/44 | SUPERSEDED_BY_UPSTREAM: upstream bounded/abortable device polling |
| `tests/translator/__snapshots__/golden-url-header.test.js.snap` | wip | 1177/1201 | PORTED |
| `tests/unit/agentrouter-provider.test.js` | commit | 143/143 | PORTED |
| `tests/unit/antigravity-gemini-38.test.js` | commit | 24/24 | PORTED |
| `tests/unit/antigravity-quota-lock.test.js` | commit | 20/20 | PORTED |
| `tests/unit/cline-models.test.js` | commit | 0/35 | INTENTIONALLY_DROPPED: tests of the dropped extra Cline |
| `tests/unit/cline-oauth.test.js` | commit | 0/92 | INTENTIONALLY_DROPPED: tests of the dropped extra Cline |
| `tests/unit/cline-routing.test.js` | commit | 0/104 | INTENTIONALLY_DROPPED: tests of the dropped extra Cline |
| `tests/unit/cline-v1-models.test.js` | commit | 0/33 | INTENTIONALLY_DROPPED: tests of the dropped extra Cline |
| `tests/unit/compat-gateway-routing.test.js` | wip | 304/304 | PORTED |
| `tests/unit/device-polling.test.js` | wip | 142/142 | PORTED |
| `tests/unit/openai-system-message-folding.test.js` | commit | 66/66 | PORTED |
| `tests/unit/opencode-go-session-header.test.js` | wip | 136/137 | PORTED |
| `tests/unit/opencode-hallucination-and-streamdone.test.js` | wip | 82/82 | PORTED |
| `tests/unit/opencode-responses-inspector.test.js` | commit | 64/64 | PORTED |
| `tests/unit/provider-validate-defaultmodel.test.js` | wip | 134/134 | PORTED |
| `tests/unit/token-refresh-generic.test.js` | commit | 0/2 | SUPERSEDED_BY_UPSTREAM: Cline refresh contract test belongs to upstream Cline |
| `tests/unit/workbuddy-provider.test.js` | commit | 56/56 | PORTED |
| `vitest.config.js` | wip | 10/10 | PORTED |

### B. Tests -- no new failure

`npx vitest run` in `tests/` of both trees, same machine, same minute:
extra-0.5.91 (2c418210) **2817 passed / 101 failed / 59 skipped (2991)**; clean v0.5.91 (f01fb909) **2715 passed /
101 failed / 59 skipped (2889)**. The failing test lists (213 lines each) are identical: `comm -23` of the two sets
is empty. The extra adds 102 passing tests and no failure; the 101 are upstream's baseline and were not touched.

### C. Package

`npm run pack:cli` in the clone at 2c418210: `9router-0.5.91-extra.tgz`, 15 579 575 bytes, 3354 files,
`package/package.json` version `0.5.91-extra`, **0 "Attempted import error"** lines in the build log.
sha256 `55a4224bddde9f76fde10f496c9e5077da1ebd3f444d9d823723dd909aca8de0`. Installed at
`%LOCALAPPDATA%\9router_WatchEdit\engine\packages\9router-0.5.91-extra.tgz` with
`9router-0.5.91-extra.source.json` beside it (commit, branch, upstream base, sha256, build time), so the
tarball names its exact source commit. (A Next build is not byte-reproducible; the sidecar is the identity.)

### D. Isolated runtime and the ZAICODE FREE path

- `verify-zaicode-free.cjs dist\win-unpacked\ZAICODE.exe --router-package <extracted 0.5.91-extra>` on an empty
  profile: **PASS** -- router isolated on :20138, the app's zero-setup chain configured it through the management
  API (key, SAIFREN, default model), first token 1.5 s, New task answered after 10 s (receipt
  `V:\_TEMP_9xree136ree-receipt.json`).
- Dry run on a COPY of the operator's real data (`db`, `auth`, `runtime`, catalogs) on :20199, before touching the
  live router: management API `GET /api/version` 0.5.91-extra, `/api/providers` 424 connections, `/api/combos` 2
  (SAIFREN, SAIOPP), `/api/keys` 94, `/api/settings` 200, `/v1/models` 2206; `POST /v1/chat/completions`
  model SAIFREN -> "ok" in 1.0 s.

### E. apply-update contract

`apply-update.ps1` selects the newest `9router-*-extra.tgz` (checked: resolves to 0.5.91-extra);
`test_core004_apply_update_contract.py` 6 passed. The change touched only that file, so it was committed alone in
`_9router_extra` on the operator's branch `fix/t-53-history-remediation`: **8a9dc7a** (not pushed); the 17 other
modified/untracked paths of the operator were not staged or changed.

### Live swap (operator go-ahead SRC-101: "update it ... you may kill it and start it again")

`powershell -File V:\___VAC\__K\__CODE\_PY\_9router_extrapply-update.ps1` at 13:09 UTC: stopped PIDs
33676/53112 (0.5.65-extra), safety backup `%APPDATA%\9router_backup_2026-09-30_160938`, `npm install -g`
0.5.91-extra (its postinstall warm-up was blocked by npm's allow-scripts; it is optional, cli.js does it at run
time), relaunched `9router -t --skip-update` (pid 29476). After the swap on :20128: version 0.5.91-extra,
424 connections, 2 combos, 94 keys, 2204 models, SAIFREN chat "ok".
Rollback, if ever needed: `apply-update.ps1 -PackagePath %LOCALAPPDATA%\9router_WatchEdit\engine\packages\9router-0.5.65-extra.tgz`
(the backup above holds the pre-swap data).
