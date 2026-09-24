# ZAICODE Upstream Baseline Receipt (handoff Milestone A)

Recorded 2026-09-22. Source of truth is the isolated checkout in `zcode/`; the
production ZCode installation is untouched.

## Upstream

- Repository: `https://github.com/zai-org/ZCode` (official)
- Branch: `main`
- Commit: `872ad960de7ec172591f7e1952f7849229f94521` ("feat: open source", 2026-09-21)
- Source version: `3.14.0` (root `package.json`)
- License: Apache-2.0 (`LICENSE`); attribution/NOTICE obligations preserved;
  ZAICODE is an unmodified-tree derivative with a narrow documented delta
  (`docs/ZAICODE_UPSTREAM_DELTA.md`).

## Toolchain pins (mise.toml)

- Node: `24.14.0`; local runtime is node 24.15.0 (engines `>=24.0.0`; the pnpm
  "Unsupported engine" WARN for `apps/zcode-cli` is benign and pre-existing).
- pnpm: `10.33.2`; used via the project-local `.tools/pnpm10` install. The
  machine-global pnpm 11 was not used and no global tooling was replaced.

## Baseline results (pre-product-change, evidence in `.saipen/evidence/`)

| Gate | Command | Result |
|------|---------|--------|
| Bootstrap | `pnpm bootstrap` | OK (`bootstrap-M1.log`, `bootstrap-M1-retry1.log`) |
| CLI smoke | `node apps/zcode-cli/packages/cli/dist/zcode.cjs --help` | OK (`cli-help.log`) |
| Typecheck | `pnpm typecheck` | exit 0 (`baseline-typecheck.log`) |
| Lint | `pnpm lint` | 0 errors, ~70 pre-existing warnings (`baseline-lint.log`) |
| Desktop smoke | `pnpm dev:desktop:test` (isolated profile) | app start + clean quit (`desktop-smoke.*`) |

Classification: the ~70 lint warnings and the `[cua-product-helper]
invalid-runtime-manifest` dev-log line are pre-existing upstream conditions, not
ZAICODE regressions (`KNOWLEDGE/traps.md`).

## Post-change revalidation (ZAICODE delta, 2026-09-22)

- `pnpm typecheck` exit 0; `pnpm lint` 0 errors / 70 warnings (= baseline).
- `pnpm --filter @zcode/web build` OK; `pnpm --filter @zcode/desktop run
  build:no-runtime-assets` OK.
- ZAICODE focused tests: 13/13 (`packages/services/test/zaicodeJobs.test.ts`
  10/10, `zaicodeRouting.test.ts` 3/3) via `node --import tsx --test`.
- Desktop smoke with the isolated ZAICODE profile: starts, workspace opens, no
  login path; production `~/.zcode/v2/setting.json` mtime unchanged.

## Environment note

The agent shell does not inherit machine PATH; every command needs
`C:\Windows\System32`, `C:\Program Files\Git\cmd`, `C:\nodejs` plus machine/user
PATH and the pnpm10 bin directory (see `.saipen/KNOWLEDGE/commands.md`).

## T-12 continuation evidence (2026-09-23)

This is additive evidence after the historical baseline above. It records a
fresh-profile packaged-app startup smoke, but does not claim interactive UI,
installed-app coexistence, or real-provider E2E gates.

- Tool-policy editor round-trip, backend persistence/migration, backend UI
  status, executor propagation, and typecheck passed in focused checks recorded
  as `.saipen/LOG.md` E-138 through E-141.
- Canonical environment check passed under Node 24.14.0 and pnpm 10.33.2;
  five `scripts/zaicode-env.test.mjs` tests passed. The canonical desktop builder
  config resolved appId `dev.zaicode.app`, productName `ZAICODE`, and Linux
  executable/package names `zaicode`.
- Focused ZAICODE matrix passed: services 17/17, UI editor 4/4, desktop runtime
  and remote-service tests 10/10, canonical identity 5/5. `pnpm typecheck` and
  `pnpm architecture:check --changed` passed.
- `pnpm lint` reported 70 warnings / 0 errors, matching the recorded 70-warning
  baseline; warning-signature comparison found 0 new warnings.
- `pnpm --filter @zcode/web build` and canonical `pnpm build:zaicode` passed.
  `pnpm bundle:zaicode --os win --arch x64` first stopped while extracting an
  unrelated Linux `.tar.xz` remote asset because this Windows shell has no
  `xz`; retrying the canonical command with the documented
  `ZCODE_SKIP_REMOTE_ASSETS=1` Windows build switch succeeded.
- The package produced `ZAICODE-3.14.0-win-x64_TEST.exe` (142.7 MiB, below its
  500 MiB limit) and `win-unpacked/ZAICODE.exe`. Windows executable metadata
  reports product name `ZAICODE`; packaged builder config resolves appId
  `dev.zaicode.app`, productName `ZAICODE`, and `zaicode` executable/package
  names.
- A fresh unpacked-app smoke reached `dom-ready` and `perf_app_start`, created
  the default workspace, and stored settings, task database, logs, and session
  cookies in separate `.zaicode-t12-smoke` roots. Provider selections were
  empty, runtime provider count was 0, and OAuth restore skipped for no active
  provider. The production setting file retained its prior timestamp. This was
  not an interactive settings/roster/queue check or installed-app coexistence
  test; see the remaining manual steps in
  `docs/ZAICODE_ACCOUNT_INDEPENDENCE_VALIDATION.md`.
- Routing documentation now distinguishes persisted backend intent, Direct
  execution, and fail-closed unimplemented SAIFREN/SAIRoute/9router boundaries.

## Audit representation provenance debt

The supplied `_AUDAPACK` manifest describes an `audit_representation` with
`PROTOCOL_INCOMPLETE`, `authoritative_state: false`, and
`required_evidence_omitted: true` (generated 2026-09-22T13:33:09Z). Its archive
omits `UI.md`, `docs/ZAICODE_ARCHITECTURE.md`, and
`docs/ZAICODE_IMPLEMENTATION.md`, although those files exist in the live tree
and E-131 records that fact. This remains external provenance debt of the audit
representation; the archive was left read-only and the separate AUDAPACK
project was not modified.
