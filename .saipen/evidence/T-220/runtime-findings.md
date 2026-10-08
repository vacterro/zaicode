# T-220 — Phase 0 preliminary runtime/source parity

Captured 2026-10-05. This is read-only discovery, not completed Phase 0/1 acceptance.

## Observed normal launch

- Workspace shortcut `ZAICODE.lnk` targets the root `ZAICODE.exe`, with no arguments and the workspace as its working directory.
- At inspection the root launcher PID was 8376; its direct packaged-app child PID was 8808.
- The child executable was `V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode/packages/desktop/dist/win-unpacked/ZAICODE.exe`.
- Renderer command lines for that app identify the same `dist/win-unpacked/resources/app.asar` and the operator's normal `%APPDATA%/ZAICODE` profile. No application was stopped or launched by this investigation.
- The existing C# launcher source names this `dist` package as its normal target; `ZAICODE.cmd` delegates to the root launcher. `ZAICODE.ps1` also defaults to this package.

## Package identity observed on disk

See `runtime-package-inspection.json` for exact metadata and ASAR hashes.

| Package | Embedded version | Embedded commit | Embedded build time (UTC) | dfacb62d ancestor of label? |
|---|---|---|---|---|
| normal `dist` | 3.14.0 | d662d516 | 2026-10-04T10:21:59.602Z | No |
| previous `dist-t217` | 3.14.0 | 522f5a5a | 2026-10-04T17:28:41.035Z | No |
| current `dist-t166` | 3.14.0 | adac42dc | 2026-10-05T01:00:47.526Z | Yes |
| `dist-t188` | 3.14.0 | bb6b75f1 | 2026-10-04T20:55:07.839Z | Yes |

Current product source HEAD: `adac42dce6835e518705a8c58ce00c4059a174f9`. Git confirms `dfacb62d` is its ancestor. Existing untracked `zcode/.saipen-red/` was preserved. No product source changes were made.

The root `VERSION` is 0.0.2, whereas the packaged Electron app reports 3.14.0 in its embedded package metadata. These are separate existing version surfaces; do not substitute the launcher/workspace version for the app package version.

**Important qualification:** the old T-217 packaged receipt names `dist-t217`, but that package embeds its pre-commit HEAD `522f5a5a`. It may contain uncommitted T-217 implementation bytes. A Git ancestry test of that label does not prove their absence. Commit identity alone cannot attest dirty build contents. Read-only main-bundle inspection found both supervisor markers (`zaicode-router-supervisor.json`, `zaicode-shared-router-recovery.log`) absent in normal `dist`, but present in `dist-t217`, `dist-t166` and `dist-t188`. This confirms the old label alone is insufficient: the T-217 test package includes supervisor bytes despite its old HEAD label. These marker checks are not an end-to-end functional test. The current implementation must bind package identity to actual built bytes/dirty provenance rather than silently treating a label as complete source proof.

## Identity mechanisms already present

`packages/desktop/scripts/build-metadata.mjs` writes `out/metadata/build-meta.json`; tsup and Vite reuse its app version, short commit and timestamp. Desktop About/export-log code consumes those fields. Reuse this mechanism rather than introducing another independent identity store.

Not yet established: a machine-readable live endpoint with package identity, update-channel truth and stale-source diagnostics. Existing code inspection is not a live About/endpoint acceptance test.

## Update and launcher boundary

- The observed normal package's `resources/app-update.yml` uses a generic provider at `http://localhost:8081`. That is packaged updater configuration, not proof of a selected managed production channel.
- The root launcher sets `ZAICODE_INSTALL_ROOT`; managed Settings updates use `install/Update-ZAICODE.ps1` and `ZaicodeInstallLib.ps1`. Actual selected channel/state still needs read-only runtime verification.
- `REBUILD.cmd` invokes the product bundle script. Its documented contract stages into `dist-next` while the live executable is locked, then relies on the next ordinary launch to swap it.
- C# `ApplyStagedBuild` decides whether the staged build is newer by comparing **executable modification times**, not embedded source/package identities. `StagedBuildReady` additionally checks ASAR/installer/blockmap existence and times. No ready `dist-next/win-unpacked/resources/app.asar` was found during the inspection.
- The launcher silently keeps the old package if live/staged executables are in use, if readiness fails, if executable-time comparison rejects it, or if the swap fails. The executable shell's timestamp is not a source revision ordering proof.
- Building `dist-t217`, `dist-t188` or `dist-t166` does not make the normal `dist` launcher use them. The observed normal package remains older than current source.

## What is proven and what is not

Proven: **current normal-launch source/package skew exists**. The running executable path is observed and its on-disk package embeds an older revision than current source.

Not proven: that the fresh screenshot was taken from this exact process/package; that old label excludes all dirty T-217 bytes; that the current T-217+ package survives the user's ECONNREFUSED path; recovery-attempt bounds, fallback, objective/session continuity, UI state and safe return. Therefore fresh REQ-001 remains BLOCKED, not closed as STALE_RUNTIME and not reopened as SOURCE_REGRESSION.

No router was killed, no paid vendor request was made, no live profile was altered and no package was replaced. The existing T-166 vendor-roll harness/ownership was preserved.

## Remaining gates

1. Supply/locate the exact requested `_ZAICODE_05.10.26-T04-13-11.zip` snapshot; the 04-14-45 archive is not silently substituted.
2. Resolve focus through normal SAIPEN ownership. START captured SRC-150/T-220 as a separate model-supplied candidate but returned `active_ticket:T-166`, `preempted:false` and `preempt_active_work:false`. Do not fabricate a witnessed task carrier or dependency to bypass that result. An explicit read-only claim preview (`saipen claim T-220 --explicit --dry-run`) returned `ALREADY_CLAIMED`, `DOING holds T-166`, with zero changes.
3. Bind immutable package provenance, channel and runtime diagnostics; prove exact normal launcher parity in an isolated profile without interrupting the operator's normal running app.
4. Run the requested real packaged desktop/router outage scenario on current T-217+ bytes with a non-paid route. Only then choose regression repair or stale-runtime acceptance.
5. Group 1 changes and all new/full regression gates remain NOT RUN. Previous T-217 gates are historical evidence, not fresh acceptance.

## Continuation checkpoint

E-3772 resolves the missing-snapshot decision: operator selected current local checkout. E-3775 records T-220 BUILD under saipen-cli; T-166 remains parked with its armed runner/profile/package untouched. Phase 0 source edits are uncommitted and not deployed. Full fingerprint-aware provenance, authenticated diagnostic endpoint and About are implemented; focused JS/TS tests pass, scratch C# launcher checks pass, typecheck and architecture pass. Current-package outage and Group 1 acceptance still NOT RUN. Earlier statements above describe the read-only intake time, not current ownership.
