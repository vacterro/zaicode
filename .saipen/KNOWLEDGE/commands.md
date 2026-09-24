# Canonical commands (upstream zcode @ 872ad960)

Source of truth: `zcode/mise.toml`, `zcode/package.json`, `zcode/README.en.md`,
`zcode/AGENTS.md`. Cited, not re-derived.

| Purpose | Command |
|---------|---------|
| Install + prepare + build bootstrap | `pnpm bootstrap` (aliases: `mise run bootstrap`) |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` / `pnpm lint:fix` |
| Format check | `pnpm fmt:check` |
| Desktop dev (test env) | `pnpm dev:desktop:test` |
| Web dev (server 3030 + web 5173) | `pnpm dev:web` |
| Agent CLI source dev | `pnpm --filter @zcode/cli dev --help` |
| Built CLI entry | `node apps/zcode-cli/packages/cli/dist/zcode.cjs --help` |
| Pre-push gate | `pnpm verify:pre-push` (lint + architecture:check --changed) |
| Architecture check | `pnpm architecture:check --changed` |
| Unused deps/exports | `pnpm knip` |
| Desktop bundle | `pnpm bundle:desktop -- --os win --arch x64` |

Tests: no unified runner; entry points live in the target package's
`package.json` and actual test files (upstream AGENTS.md, "测试入口" line).

ZAICODE focused tests (added 2026-09-22): `node --import tsx --test
test/zaicodeJobs.test.ts` from `packages/services` (node:test + tsx resolves
`.js` specifiers to `.ts`).

Local invocation (agent shell, this machine):

- pnpm 10.33.2 isolated at `_ZAICODE/.tools/pnpm10/node_modules/.bin` (global
  pnpm is 11.x and ignores `package.json#pnpm`; the repo pins pnpm@10.33.2).
- node 24.15.0 local vs `mise.toml` pin 24.14.0 -> pnpm prints an "Unsupported
  engine" WARN for `apps/zcode-cli`; observed harmless (engines >=24.0.0).
- Every command needs a full PATH:
  `_ZAICODE/.tools/pnpm10/node_modules/.bin;C:\nodejs;` + machine + user PATH.

ZAICODE build/launch (added 2026-09-24, T-18):

- Agent CLI prompt changes (`apps/zcode-cli/packages/core`): `turbo` is not
  installed, so `pnpm --dir apps/zcode-cli build` fails; build directly with
  `pnpm --filter @zcode/core build` then `pnpm --filter @zcode/cli build`
  from `apps/zcode-cli` (output `packages/cli/dist/zcode.cjs`).
- Packaged app: `pnpm bundle:zaicode` -> `packages/desktop/dist/win-unpacked/ZAICODE.exe`.
- Root launcher: `tools\launcher\build.cmd` compiles `tools\launcher\ZaicodeLauncher.cs`
  (.NET Framework csc, winexe, no console) into `_ZAICODE\ZAICODE.exe`; it sets
  ZAICODE mode + `SAIPEN_HOME` and restarts on crash. `ZAICODE.lnk`/`ZAICODE.cmd`
  point at it; `ZAICODE.ps1` is the fallback. Build logs live in `.zaicode/logs/`.
- UI SAIPEN parsers test: `node --import tsx --test test/zaicodeSaipenModel.test.ts`
  from `packages/ui`.
