# T-38 evidence — SRC-032 item 2: 9router_extra support inside ZAICODE

Source: SRC-032 item 2 ("клонируй механизм поддержки 9router_extra ... чтобы юзер
легко мог настроить свои ключи и провайдеры, модели, ПУЛ ... надёжным, простым и
предсказуемым"; screenshots: 9router Combos, Usage, Providers pages).

## Design (why this shape)

9router (0.5.65-extra, `%APPDATA%\9router`) already owns providers, keys, models
and pools (combos), with the 9router_extra patches built in. Cloning that store
into ZAICODE would create a second truth that drifts. ZAICODE instead drives
9router's own dashboard API, authenticated exactly like 9router's CLI
(`x-9r-cli-token` = first 16 hex of sha256(machine-id + "9r-cli-auth" +
auth/cli-secret), read from 9router's data folder by the main process only).
The dashboard and ZAICODE therefore always show the same data. The
9router_extra upgrade itself (`apply-update.ps1`: stop, safety backup, install
the patched package, restore state, relaunch) is run as-is, visibly.

## Items -> implementation

| Need | Where |
|---|---|
| One allow-listed door to 9router | `shared/src/zaicode-router.ts`: route allow-list (providers, provider-nodes, combos, models, settings GET/PATCH limited to `comboStrategies`, usage stats; `/api/keys` excluded — the page never needs 9router's own API keys); no shutdown / update / database / OAuth / tunnel routes; traversal and `//` refused. Record normalizers, strategy map, pool move, name/prefix helpers. |
| Credential + transport (main only) | `desktop/src/main/zaicodeRouterTransport.ts` (no Electron; token, 15 s / 60 s-for-tests deadline, 9router's own error text surfaced, down = message not throw), `zaicodeRouter.ts` (info, start `9router -t --skip-update`, open dashboard, run `apply-update.ps1` in a visible console; path overridable by `ZAICODE_ROUTER_EXTRA_UPDATE`). IPC in `desktopMainIpcPlatform.ts`, channels in `shared/src/channels.ts`, preload `callZaicodeRouter` & co. |
| Settings -> ZAICODE -> Router (9router) | `ui/src/zaicode/zaicodeRouter.ts` (store: status, version, connections, nodes, pools, models, settings, today's usage; every change re-reads 9router), `settings/ZaicodeRouterSettings.tsx` (Overview: status/version, "no 9router_extra patches" warning, Refresh, Start, Open dashboard, 9router_extra update with confirm, today's requests / tokens, endpoint), `ZaicodeRouterProviders.tsx` (all connections: on/off, Test, remove with confirm; add OpenAI/Anthropic-compatible provider + key in one step = node + connection; another key for an existing provider = key pool), `ZaicodeRouterPools.tsx` (pools with Fallback / Round robin / Fusion, ordered models ⤒ ↑ ↓ ✕, add model with search over 9router's models, create / delete pool). |
| Entry points | Sidebar pool row label (SAIRoute) opens the Router page; nav id `zaicodeRouter`. |

## Gates (from `zcode/`)

- `tsc -b` over the `pnpm typecheck` project list: EXIT 0. `tsc --noEmit -p packages/ui/tsconfig.json`: 0.
  `packages/desktop/tsconfig.main.json`: 83 errors, all pre-existing upstream (appARMSBootstrap rootDir,
  applicationIcons, WindowControlsOverlay types); none in the files of this ticket.
- `pnpm lint`: 0 errors, 72 warnings (baseline; two new warnings in new files fixed).
- `pnpm architecture:check --changed`: OK, 0 violations.
- UI `node --import tsx --test test/zaicode*.test.ts`: 103/103 (new `zaicodeWave38.test.ts` 4/4:
  allow-list, records, pool edits, usage fields; usage field names checked against 9router's
  `usageRepo.js`: totalRequests / totalPromptTokens / totalCompletionTokens).
- Transport against a fake 9router (`packages/desktop/test/zaicodeRouterTransport.test.ts`, run from
  `packages/services`): 6/6 (token derivation, token sent, 9router error text, refused call never sent,
  router down reported, settings reduced to `comboStrategies` before the renderer). One earlier run had 2 failures in 5 ms on the first loopback calls; 18
  consecutive re-runs were green; not reproduced, recorded here as an unexplained one-off.
- Pre-VERIFY self-review: GET `/api/settings` returned login/tunnel values to the renderer; main now
  passes only `comboStrategies` (`pickZaicodeRouterSettings`), and `/api/keys` left the allow-list.
- Red control: allow-list short-circuited to `return true` -> wave38 1 fail; restored -> 4/4.
- Live read against the real 9router (before it went down on its own at ~02:1x): `/api/health` 200,
  `/api/version` 0.5.65-extra, `/api/combos` with the CLI token -> SAIFREN (82 models), SAIOPP (20).
  At VERIFY time 9router's tray process (pid 41940, `cli.js --tray --skip-update -p 20128`) was alive
  but nothing listened on 20128; ZAICODE did not restart it.

## MANUAL-VERIFY STEPS + EXPECTED

1. With 9router running, Settings -> ZAICODE -> Router (9router): "● running v0.5.65-extra", today's
   requests/tokens, Providers N, Pools 2.
2. Providers & keys: toggle a provider off and on -> the 9router dashboard shows the same state.
   Test on a working provider -> "works".
3. Add an OpenAI-compatible provider with a key -> it appears in the list and in the 9router
   dashboard as a custom provider with prefix `<prefix>/…`.
4. Pools: open SAIOPP, move a model up, change the strategy to Round robin -> the dashboard's Combos
   page shows the same order and strategy.
5. Stop 9router -> Overview says "not reachable" with the reason; Start 9router brings it back.

## Bundle (shared staging for T-38, T-39, T-40)

`REBUILD.cmd --fast` EXIT 0 -> `packages/desktop/dist-next` (ZAICODE-3.14.0-win-x64_TEST); `app.asar`
contains `Subscriptions as models`, `zaicode:call-router`, `zaicode-no-motion`, `Calm interface`,
`12-hour clock`, `ZAICODE_INHERITED_TZ`, the picker's "Use this sound".
