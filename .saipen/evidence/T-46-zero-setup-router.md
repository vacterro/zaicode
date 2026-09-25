# T-46 evidence -- zero-setup SAIFREN / SAIOPP router (SRC-035 item 1)

Operator's words (SRC-035): the full 9router mechanism, the patched one, inside
ZAICODE, isolated when needed, working through its API, the user only pastes
credentials; SAIFREN = free things, SAIOPP = the user's own best
(subscriptions via OAuth); every free tier (OpenRouter, OpenCode, Cline, …)
connectable; someone who just downloaded ZAICODE writes a task in New task and
everything is set up to the first token, stable; an autoscanner that catches
legal free APIs and says "today free model X added to SAIFREN"; no 300
dependencies in the user's face; an Autotroubleshoot that fixes ~99 %.

## Research (2026-09-25, live probes from this machine)

| Free tier | Keyless? | Result |
|---|---|---|
| Kilo Gateway `kilo-auto/free` | yes (`Bearer anonymous` accepted) | 200 "OK" in ~1-6 s; single `:free` models often 429 upstream -> the auto route first |
| Pollinations `openai-fast` (`/openai/chat/completions`) | yes (`user_tier: anonymous`) | 200 "OK" in 0.2 s |
| LLM7 `GLM-5.3-Flash`, `codestral-latest` | yes for these | 200; other LLM7 models 401 -> only checked ones, the scanner adds none |
| OVHcloud AI Endpoints | only with NO Authorization header | any bearer -> 403; 9router always sends one -> dropped |
| gen.pollinations.ai | no (401 key required) | not used |
| OpenCode Zen free models outside OpenCode's client | refused (FreeTierError); a workaround exists | not used: imitating another client is not a legitimate tier; offered with the operator's own free OpenCode key instead |
| OpenRouter / Gemini / Groq / NVIDIA NIM / Cerebras / Mistral / OpenCode Zen | free key, no card | one-paste rows with the provider's own key page |
| Cline free models | 9router `cline` OAuth provider | SAIOPP side: sign in once on the router's Providers page |

Router facts: a fresh `DATA_DIR` 9router answers `/api/health` in ~1 s; its
dashboard API accepts the CLI token once `machine-id` + `auth/cli-secret`
exist (ZAICODE writes them); `sql.js` ships inside `app/node_modules`, so the
server needs no install; ZAICODE.exe with `ELECTRON_RUN_AS_NODE=1` (Node
24.14 / Electron 41) runs the server (health 200 in 1 s).

## What was built

| Need | Where |
|---|---|
| The patched 9router inside ZAICODE | `electron-builder.config.js`: `resources/router/9router/{app,LICENSE,package.json}` from the machine's global 9router (0.5.65-extra) or `ZAICODE_ROUTER_PACKAGE_SRC` |
| Isolated when needed | `zaicodeRouterHost.ts` (Auto / My 9router / ZAICODE's own; auto = shared when a 9router DB exists) + `zaicodeRouterProcess.ts` (spawn under ZAICODE as Node, own data + port 20138, credential, log `userData/logs/zaicode-router.log`, restart with backoff, clean stop on will-quit) |
| Works through the API | `zaicodeRouterTransport.ts`: target follows the host; `callZaicodeRouterInternal` (main only) for pool / key provisioning; the renderer door keeps its allow-list |
| To the first token without setup | `zaicodeRouterBootstrap.ts` + `zaicodeRouterSetup.ts` (keyless providers, SAIFREN, SAIOPP, ZAICODE key, first-token probe; the shared router is started if down) + `ui/.../useZaicodeRouterAutoSetup.ts` (SAIRoute provider with SAIFREN + SAIOPP, SAIFREN default unless a working default exists, "SAIFREN is ready" card) |
| Autoscanner + notice | daily `scanZaicodeFreeModels` (providers' own lists, free rules per provider in `shared/src/zaicode-free-catalog.ts`), notice "Today free model X added to SAIFREN" (scenario `router.free`); operator removals respected |
| Paste credentials | Router -> Overview "More free models": key page link + paste + Add = node + key + 9router test + free models into SAIFREN; a refused key leaves nothing behind |
| SAIOPP | created empty; subscriptions via the router's OAuth Providers page; "Subscriptions as models" tab (T-40) |
| Autotroubleshoot | Router -> Overview button: package, router (start / restart), ZAICODE <-> 9router credential, pools, key, first token, per-model probes when the pool fails; the app step (SAIRoute) is re-checked too |

## Gates (2026-09-25)

- Real-router integration `desktop/test/zaicodeRouterSetup.test.ts` (run from
  `packages/services`): 8/8 -- empty router gets keyless providers + SAIFREN +
  SAIOPP and a second run changes nothing; a removed starter stays removed;
  key created once and reused; FIRST TOKEN through SAIFREN from the real free
  providers (10.1 s cold); scan appends a new free model once and respects a
  removal; a bad Groq key is refused and leaves no connection; a killed router
  process comes back by itself (1.8 s); stopped router restarted + deleted
  SAIFREN rebuilt + first token again.
- UI `test/zaicode*.test.ts`: 129/129 (new `zaicodeWave46.test.ts` 6/6: pool
  plan idempotent and reusing the operator's own node, free-model rules per
  provider, removal memory, the notice text, the app-side setup creating
  SAIRoute -> router with SAIFREN + SAIOPP and fixing a default that names no
  existing model).
- Found and fixed by that test: the bundled settings snapshot carries the
  operator's default model (`new-provider/SAIFREN`); on a fresh machine it may
  name no model, so the setup now replaces a default that does not resolve.
- Transport regression `desktop/test/zaicodeRouterTransport.test.ts`: 6/6.
  T-44 system E2E: 10/10.
- Root `tsc -b`: 0 errors. `desktop/tsconfig.main.json`: 83 = upstream baseline
  (none in ZAICODE files); preload 3 = upstream baseline. `oxlint`: 0 errors,
  72 baseline warnings. `pnpm architecture:check --changed`: OK.

## Packaging (found and fixed during ship)

- electron-builder copies `app/.next-cli-build` only when named in the filter
  and never copies `node_modules` from `extraResources`, even with a filter:
  the first bundle shipped a router without its modules. The router's
  `app/node_modules` (30 MB, no native `.node` files) is now copied in
  `afterPack` before the installer is built.
- Proof from packaged files only: `dist-next/win-unpacked/ZAICODE.exe` with
  `ELECTRON_RUN_AS_NODE=1` running `resources/router/9router/app/custom-server.js`
  on an empty DATA_DIR -> `/api/health` 200 after 1 s.
- Two bundle attempts failed on `EBUSY` writing CLI `dist/*.d.ts` (a file lock
  outside the build); a plain re-run passed (retried from the shell, not a script change).

## MANUAL-VERIFY (operator)

1. Router -> Overview shows "SAIFREN · free AI, nothing to set up", mode Auto
   (yours: this machine has 9router), Autotroubleshoot lists every step green
   and "First token … answered".
2. Click "ZAICODE's own": ZAICODE starts its private router on :20138, adds
   the free providers and SAIFREN there, moves SAIRoute to it; New task +
   Enter answers without any key. "My 9router" moves back.
3. Paste a free OpenRouter key in "More free models" -> "key saved, N free
   model(s) added to SAIFREN".
4. A day later (or "Scan now") new free models arrive with the card
   "Today free model … added to SAIFREN".
