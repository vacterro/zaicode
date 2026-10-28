# T-220 — fresh bundle runtime/source parity and continuity

Authority: workspace SRC-150 implementation mission and exact SRC-151 fresh bundle. The operator explicitly permits current local checkout in place of the missing named project snapshot. Existing T-166 packaged vendor-roll acceptance runs independently and must not be overwritten, duplicated or interrupted.

## First bounded slice: Phase 0 identity

Reuse desktop build metadata as the only build identity owner. Build metadata records app version, full source revision, dirty-source truth, source fingerprint, UTC build timestamp, declared build channel and a unique runtime package identity. Keep the existing short commit/version/time fields compatible. A fingerprint must include new source/spec/test files under product roots, not only committed HEAD. Never claim a dirty build contains only its HEAD commit.

Packaging copies the same immutable metadata into ASAR and a resources sidecar so the normal launcher can inspect it without loading the app. No independent editable identity store.

Desktop runtime projects the packaged metadata, actual executable/resources paths and current source-tree comparison when a local installation contains the development checkout. Missing/invalid metadata, unknown Git and unmatched source are explicit states, not silent equality. The packaged revision is never replaced with current checkout HEAD. A dirty package can match only when the full current source fingerprint equals its packaged fingerprint; a shared HEAD alone is insufficient. The launcher conservatively warns that dirty provenance is unverified rather than falsely claiming every source fix is absent. Git probe failure is visible, never silently clean.

Expose the projection in About and at the existing loopback inference proxy's authenticated GET /runtime-identity endpoint. Existing bearer-token authentication protects executable/source paths. The endpoint is read-only, never triggers inference or updates. About uses the same projection and visibly flags source/package mismatch.

Normal launcher: stage promotion uses build metadata timestamp/package identity, not the executable wrapper timestamp, when metadata is available. Legacy fallback remains compatible but must not pretend metadata exists. A normal local launch must visibly warn on newer/different source instead of silently claiming source fixes are active. No application kill, source checkout, deployment or automatic package replacement outside the existing staged-swap policy.

Ownership/order:

```
source bytes -> build metadata owner -> renderer/main build -> immutable package
                                                |
normal launcher reads resources sidecar --------+-> packaged runtime
                                                       |
local source probe (read-only) -> identity projection -> About / authenticated endpoint
```

## Phase 1 gate before Group 1 implementation

Launch current T-217+ production package on an isolated realistic profile, with explicit HOME/USERPROFILE/APPDATA/LOCALAPPDATA and ZCODE_DESKTOP_USER_DATA_DIR overrides. Never rely on Chromium --user-data-dir alone. Run a real desktop renderer/CLI workload through the normal inference path; no paid provider traffic.

Exercise the actual user-local router endpoint refusing connections, bounded preferred recovery, intermediate recovery, exhaustion/internal fallback, same project/session/objective, honest UI status and return only at a continuation boundary. Helpers do not satisfy this gate. Check the path where ECONNREFUSED occurs before proxy admission as well as the route behind the supervisor. Preserve existing supervisor unless current-package reproduction proves a regression.

Acceptance classification stays unresolved until the exact desktop test establishes SOURCE_REGRESSION or STALE_RUNTIME/DEPLOYMENT_SKEW. The observed normal d662d516 package lacks supervisor markers, but the screenshot's runtime has not yet been conclusively attributed. Old dist-t217 embeds pre-commit HEAD despite containing supervisor bytes; commit ancestry alone is insufficient.

## Remaining fresh delta

REQ-002..012 remain unresolved: responsive composer/control strips, ProTrail policy-aware z-order, native maximize/restore geometry, authoritative liveness, payload-preserving queue summaries, SAITULS account-contract convergence, global persisted A3 switch, anchored/bounded tooltips and reusable relevant right-click settings. Phase 0/1 must pass first. Existing T-190/T-197..217 work is preserved; checked-off raw source bullets are not reopened.

## Verification

- Focused metadata/projection/proxy/launcher negative and positive tests; missing metadata, dirty/new files, unavailable source and timestamp disagreement.
- Machine endpoint rejects missing/wrong authentication; no paid inference used to query identity.
- Packaged About and exact normal launcher path are exercised on an isolated profile.
- Full relevant tests, typecheck, lint, architecture and production package gates after final edits.
- Runtime identity must equal immutable packaged provenance; source skew remains a diagnostic, never fabricated activation evidence.
