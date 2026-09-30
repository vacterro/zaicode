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
