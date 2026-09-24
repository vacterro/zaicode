# ZAICODE Upstream Delta Ledger

Every upstream-owned file ZAICODE modifies, why it had to be touched, why an
additive extension was not sufficient, and the expected rebase risk. New
ZAICODE-owned files are not listed here; they are rebase-free.

Rule: prefer new ZAICODE modules and centralized capability switches; no
mechanical renaming of upstream protocol identifiers, package names, storage
schemas, environment variables or RPC contracts.

| Upstream file | Change | Why additive was insufficient | Rebase risk |
|---|---|---|---|
| `packages/shared/src/index.ts` | exports `zaicode*` contracts | barrel export is the only public surface consumers may import | trivial (one block) |
| `packages/shared/src/channels.ts` | two `ServiceChannels` entries | channel registry is a closed const map | trivial |
| `packages/shared/src/env.ts` | `ZCodeProductFlavor` gains `zaicode` | flavor type is a closed union used by every consumer | low (type + normalizer) |
| `packages/services/src/session/tasksDatabase/migrations.ts` | frozen `0004_zaicode_product` plus additive `0005_zaicode_routing_backend` | migration ledger must be one owner; routing backend adds one column with a Direct default | low; shipped ledger entries are immutable |
| `packages/services/src/node.ts` | build/register ZAICODE services, executor hook, export | assembly point is a single function; services must register in order | medium (large file, additive blocks) |
| `packages/services/src/index.ts` | browser-safe descriptor exports | public package surface | trivial |
| `packages/services/src/accessor.ts` | two optional accessor fields | accessor contract is closed to direct edits | trivial |
| `packages/client/src/remoteServiceAccess.ts` | two channel proxies | client getters are added per service by design | trivial |
| `packages/desktop/src/host/index.ts` | install/clear ZAICODE executor after service init | executor needs the live host collection; no other seam exists | medium (large file; two small blocks) |
| `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` | register both ZAICODE descriptors through a focused-tested resolver; unavailable stubs are explicit when the remote host omits them | remote collection is a closed registration list | low |
| `packages/desktop/src/main/desktopRuntimeEnv.ts` | ZAICODE runtime application name | runtime identity switch is compile-time flavored | low |
| `packages/desktop/scripts/desktop-product-identity.mjs` | ZAICODE identity entry + strict switch + AUMID lookup fix | centralized identity module is the sanctioned flavor owner | low |
| `package.json` | `dev:zaicode`, `build:zaicode`, `bundle:zaicode`, `zaicode:env:check` scripts | single canonical entrypoints; no upstream build system forked | trivial |
| `tools/start-zaicode-dev.ps1` | now consumes `ZCODE_ZAICODE_IDENTITY=1` + delegates to `pnpm dev:zaicode` | isolation+identity travel as one unit | low |
| `packages/ui/src/SettingsPage.tsx` | ZAICODE settings section render branch | settings render switch is a closed chain | low |
| `packages/ui/src/settings/settingsPageConfig.ts` | ZAICODE section entry | section registry is a closed list | trivial |
| `packages/ui/src/lib/settingsNavigation.ts` | `zaicode` section id | section id union + validator are closed sets | trivial |
| `packages/ui/src/app-shell/types.ts` | `WorkspaceMainView` gains `zaicode` | view union is closed | trivial |
| `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` | ZAICODE workspace render branch + sidebar props | view switch is a closed chain | low |
| `packages/ui/src/WorkspaceSidebar.tsx` | ZAICODE nav entry + props | sidebar nav is hardcoded JSX (not data-driven) | low |
| `packages/ui/src/ChatErrorBanner.tsx` | ZAICODE zero-provider message branch | display resolver owns message mapping | low |
| `packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx`, `Root.tsx`, `quickpick/quickPickCommands.ts`, `settings/CodingPlanUpgradeDialogProvider.tsx`, `settings/model-provider-section/{Detail,StatusCards,providerFamilyConnectionVisibility}.tsx` | ZAICODE mode gates for account/commercial surfaces | the gates must sit at each render surface; a wrapper would leave dead CTAs | low each; re-check on upstream UI refactors |
| `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts` | `zaicode.*` keys, including backend/status/Inspector labels | locale maps are flat closed records | trivial (merge blocks) |

The ledger lists upstream-owned touched files; new ZAICODE-owned source files
remain tracked in the implementation notes and are not duplicated here.

Rebase procedure: re-apply the small blocks above after each upstream update,
keep `0004_zaicode_product` frozen (add `0005_...` for schema changes), then run
`C:\nodejs\node.exe scripts\zaicode-env.mjs --check`,
`pnpm typecheck`, `pnpm lint`, `pnpm --filter @zcode/web build` and the ZAICODE
focused tests. Expected conflicts are limited to `node.ts`, `host/index.ts` and
the settings/UI chains.
