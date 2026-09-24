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
recursion is impossible by construction. No runtime tool yet (T-10).
