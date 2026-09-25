# Decisions

## D-1 Product layer over an unmodified upstream checkout (2026-09-22)

ZAICODE product docs live at the ZAICODE workspace root (`UI.md`, `docs/`),
upstream source stays in `zcode/` with a narrow, documented delta. Rationale:
upstream-rebase invariant from SRC-001; a clean upstream tree keeps rebases and
delta accounting mechanical.

## D-2 Account independence via a product-mode capability (SRC-002)

Mode flag `ZCODE_ZAICODE_MODE` (`1`/`true`/`on`/`yes`), read by
`packages/shared/src/zaicode.ts` (`isZaicodeProductMode`), injected into the
renderer by preload as `__ZAICODE_PRODUCT_MODE__`, and by env in main/host.

Chosen over deleting auth code because:

- upstream gates are provider-availability, not Z.ai-account, gates
  (`packages/ui/src/lib/modelProviderAvailability.ts:10`); any provider clears
  them, so disabling promotion is enough for no-account operation;
- login remains reachable through provider configuration, so Z.ai stays an
  optional provider (SRC-002 requirement).

Gated surfaces: startup login-entry guard
(`packages/ui/src/lib/rootStartupGate.ts`), upgrade dialog provider, plan
status cards, Start Plan nav filter, purchase banners, Connect palette entry,
sidebar upgrade entry, chat error upgrade CTA, Root login CTAs.

## D-3 Profile isolation by environment (dev + validation)

ZAICODE launches with `USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA` plus
`ZCODE_DESKTOP_*` and `ZCODE_DATA_BASE_DIR` pointed inside `.zaicode/`.
Proof 2026-09-22: all state under `.zaicode/`; production
`~/.zcode/v2/setting.json` mtime unchanged; no login/welcome path in logs.
Launcher: `tools/start-zaicode-dev.ps1`.

## D-4 Account-free provider state

With zero providers the agent returns `ZCODE_AGENT_PROVIDER_NOT_READY`
(`packages/services/src/zcode-agent/zcodeAgentService.ts:2849`). ZAICODE treats
this as the truthful no-routes state, not as an account prompt. UI text must
become "No execution routes configured." (SRC-002), not an upgrade CTA.

## D-5 ZAICODE queue/agent persistence in tasks-index.sqlite (2026-09-22)

Agent definitions (`zaicode_agents`), jobs (`zaicode_jobs`) and product settings
(`zaicode_settings`) live in the existing `tasks-index.sqlite` via an additive
migration `0004_zaicode_product`; one authoritative owner (queue rows), not a
second session state machine. Job execution binds to upstream sessions by id
only. Invariants implemented in the repository: single-flight claim (atomic
UPDATE), terminal writes conditional on `run_id`+`attempt` (stale completions
rejected), cancel/complete idempotent, retry lineage via `retry_of_job_id`,
heartbeat lease (`host_id` + `heartbeat_at`, 2 min stale) so restart blocks
running rows instead of completing them, per-workspace concurrency (default 1,
max 4) counted from storage.

## D-6 Host executor injected into the services layer

`packages/services` must not import the runtime implementation. The job service
asks for an executor through the `setZaicodeJobExecutor`/`getZaicodeJobExecutor`
hook in `packages/services/src/node.ts`; the host installs
`createZaicodJobExecutor` (`packages/desktop/src/host/zaicodeRunDispatch.ts`)
after `createLocalServices` and clears it on dispose. Without an executor,
dispatch blocks with `dispatch_unavailable` rather than pretending to run.

## D-7 Bounded orchestration is one hop, operator-configured

A top-level Coordinator job may carry `delegation` (target agent +
instructions). On successful completion the service creates exactly one child
job (`parent_job_id`) and pumps it; child jobs cannot carry delegation, so
recursion is impossible by construction. Runtime delegation (T-10, 2026-09-25):
a running top-level coordinator asks for helpers through a per-run request
folder answered by the queue service (`delegateFromRun`, policy in
`shared/src/zaicode-delegation.ts`, operator decision SRC-033); the run id is
the token, depth stays exactly 1.

## D-8 9router is managed through its own API, never cloned

Providers, keys, models and pools live in 9router (`%APPDATA%\9router`, the
0.5.65-extra build carries the 9router_extra patches). ZAICODE's Router page
drives 9router's dashboard API from the desktop main process with 9router's
CLI credential: header `x-9r-cli-token` = first 16 hex chars of
sha256(`machine-id` + `9r-cli-auth` + `auth/cli-secret`), both files in the
9router data folder. Only the routes in `shared/src/zaicode-router.ts` are
reachable; `/api/settings` is reduced to `comboStrategies` before it reaches
the renderer. Pool strategy lives in settings `comboStrategies[<name>]
.fallbackStrategy` (absent = fallback), not on the combo record.

## D-9 Zero-setup router: ZAICODE ships and can run its own 9router (T-46, 2026-09-25)

Amends D-8 (which stays true for the operator's own router). ZAICODE ships the
patched 9router server (`resources/router/9router`, MIT) and chooses per
machine: `shared` = the operator's 9router (%APPDATA%\9router, :20128, never
stopped by ZAICODE; started if down), `isolated` = ZAICODE's private instance
(data in ZAICODE's userData `router/`, :20138), run by ZAICODE's own
executable with ELECTRON_RUN_AS_NODE (no Node/npm on the machine), supervised
by `ZaicodeRouterProcess` (restart with backoff, stop on will-quit); `auto` =
shared when `%APPDATA%\9router\db\data.sqlite` exists, else isolated. The
isolated router's CLI credential (machine-id + auth/cli-secret) is written by
ZAICODE before the first start. SAIFREN is filled from keyless legitimate free
tiers only (Kilo Gateway `kilo-auto/free`, Pollinations `openai-fast`, LLM7
checked models; placeholder bearer `anonymous`); OVHcloud's anonymous tier
was dropped because 9router always sends an Authorization header and OVH
answers 403 to any bearer. Operator removals from SAIFREN are remembered and
never undone (scan memory in userData `zaicode-free-scan.json`).

## D-10 SAIHOME is a view; its statistics are ingested, not scraped (T-56, 2026-09-25)

SAIHOME is `WorkspaceMainView = "saihome"`, never the composer's empty state;
opening it has no execution side effect. Its token history comes from the
agent CLI's own usage store (`~/.zcode/cli/db/db.sqlite`: `model_usage`,
`turn_usage`, `session.directory`), opened read-only by the services host and
copied into ZAICODE-owned `zaicode_stats_events` (migration
`0006_zaicode_stats`) with source-scoped stable ids, so deleting a session
does not rewrite history and replays count once. Chosen over a new CLI RPC
(no agent CLI delta) and over the upstream `v4/usage/stats` query (it needs an
active workspace client and buckets days with one fixed UTC offset). Day
bucketing happens in JS from quarter-hour SQL sums with Intl in the caller's
IANA zone. The store is shared with production ZCode on the same machine, so
SAIHOME labels it as such. CLI worker sessions carry no token counts and are
shown as unmeasured runtime.

## D-11 GitHub backup layout (T-58, 2026-09-25)

Operator's backup repository: `https://github.com/vacterro/zaicode` (PUBLIC).
Branch `main` = the `zcode/` checkout on its local branch `zaicode` (upstream
history + the ZAICODE layer, remote name `backup`); branch `workspace` = the
root `_ZAICODE` repo (`master`: launcher, docs, `.saipen/` memory). `zcode`'s
`origin` stays upstream `zai-org/ZCode` and is never pushed. The modified
Microsoft Verdana files (`packages/desktop/build/zaicode-fonts/Verdana_m1*.ttf`)
are excluded through `zcode/.git/info/exclude` because the repo is public;
they stay local (source: `_FREEBUFF_PATCH/fonts`).

## D-12 Subscription chat runs the vendor CLI headless (T-51, 2026-09-25)

SUBCHAT (SRC-038: subscriptions "as in an ordinary chat, without WORKERS")
runs each turn as the account's own CLI in headless mode (`claude -p
--output-format stream-json`, `codex exec --json`) under that account's home,
with the prompt on stdin and `--resume` / `exec resume <id>` for the next turn.
Rejected: reading the CLIs' OAuth tokens and calling the vendor APIs from
ZAICODE (a consumer subscription in a third-party harness is the vendor's
terms question, see T-40) and a text-only "CLI as a model" adapter (it cannot
carry ZAICODE's tool calls). The 9router "Subscriptions as models" path (T-40)
remains the way to put a subscription into model lists and pools.
