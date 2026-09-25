# T-40 evidence — SRC-034: vendors as ordinary models inside ZAICODE

Question (SRC-034): can the vendor subscriptions (Claude Code, Codex,
Antigravity, …) run inside ZAICODE as normal models in the model list,
seamlessly, instead of opening a terminal?

## Research answer

1. ZAICODE's model layer speaks HTTP model APIs only: every provider is an
   OpenAI (chat completions / responses) or Anthropic compatible endpoint
   (`apps/zcode-cli/packages/adapters/src/model`, provider config
   `api.type` + `baseUrl`). The old ACP external-agent path was removed
   upstream (comments in `services/src/node.ts`, `zcodeTaskServiceAdapter.ts`).
2. A vendor CLI is not a model: `claude -p`, `codex exec` run their own agent
   loop and execute their own tools. Wrapping one as a "model" would either
   fight ZAICODE's tool loop (two agents editing the same tree) or reduce it to
   text-only chat. Not seamless; rejected.
3. The seamless path already exists on this machine: 9router serves OAuth
   subscriptions as OpenAI-compatible models (`/v1`), routed as
   `<alias>/<model>` (`codex` -> `cx/…`, `antigravity` -> `ag/…`, `claude` ->
   `cc/…`). ZAICODE's SAIRoute provider points at the same endpoint
   (`http://localhost:20128/v1`, `personalModelIds: ["SAIFREN"]` in
   `~/.zcode/v2/provider_config.json`). Listing `cx/gpt-…` under SAIRoute makes
   it an ordinary model in every model menu, running with ZAICODE's tools,
   transcript, queue and SAIPEN controls. Pools can mix subscription models
   with API-key models.
4. Limits to state plainly: the quota is the one the vendor CLI uses (the
   Engines meters still read it); whether a vendor permits its consumer
   subscription through a proxy is that vendor's terms (Anthropic's consumer
   terms restrict third-party use of Claude subscriptions), not something
   ZAICODE decides.

## Built

| Piece | Where |
|---|---|
| Subscription grouping (OAuth connections only, 9router's alias map) | `shared/src/zaicode-router.ts` `zaicodeSubscriptionModels`, `ZAICODE_ROUTER_OAUTH_ALIASES` (copied from 9router 0.5.65-extra `OAUTH_ALIASES`), `zaicodeRouterAliasOf` |
| Router -> "Subscriptions as models" tab | `ui/src/settings/ZaicodeRouterSubscriptions.tsx`: per subscription its 9router models; Add (to the SAIRoute provider through `providerSettingsService.addPersonalModel`, with 9router's context window / max output / vision) and Use (add + default for new sessions / START); connect-in-dashboard link when nothing is connected |
| Which ZAICODE provider is "SAIRoute" | `findZaicodeRouterProvider` (`zaicodeRoutingModel.ts`): the provider whose base URL is 9router's port on localhost, else the SAIRoute-named one |
| Entry from a vendor tile | Sidebar engine tile right-click: "Use <short> inside ZAICODE as a model…" opens Router on that tab (`useZaicodeRouter.requestTab`) |

## Gates (from `zcode/`)

- `tsc -b` (typecheck list) 0; UI `tsc --noEmit` 0; `pnpm lint` 0 errors (72 baseline warnings);
  `pnpm architecture:check --changed` OK.
- UI tests 105/105 (new `zaicodeWave40.test.ts` 2/2: OAuth-only grouping with alias match, active merge;
  router provider by port / renamed / by name / none / port look-alike).
- Red control: alias match removed -> wave40 1 fail; restored -> 2/2.
- Live: 9router was down during this ticket (tray alive, port 20128 closed), so the tab was not
  exercised against the real list; the alias map and route shapes were read from 9router's source.

## MANUAL-VERIFY STEPS + EXPECTED

1. 9router running with Codex connected. Settings -> ZAICODE -> Router -> Subscriptions as models:
   "OpenAI Codex" with its `cx/…` models; "Adds to: SAIRoute".
2. Add `cx/<model>` -> "in list ✓"; the composer model menu shows it under SAIRoute; a prompt runs in
   the chat (no terminal opens) and appears in 9router's Usage.
3. Right-click the CX tile on the sidebar -> "Use CX inside ZAICODE as a model…" opens that tab.

## Bundle (shared staging for T-38, T-39, T-40)

`REBUILD.cmd --fast` EXIT 0 -> `packages/desktop/dist-next` (ZAICODE-3.14.0-win-x64_TEST); `app.asar`
contains `Subscriptions as models`, `zaicode:call-router`, `zaicode-no-motion`, `Calm interface`,
`12-hour clock`, `ZAICODE_INHERITED_TZ`, the picker's "Use this sound".
