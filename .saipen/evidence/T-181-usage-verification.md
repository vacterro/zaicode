# T-181 / SRC-120 Usage refinement

## Implementation and preserved ownership

The session inherited uncommitted Usage presentation work in
`packages/ui/src/zaicode/ZaicodeUsageView.tsx`, `zaicodeUsageLabels.ts` and
`packages/ui/test/zaicodeUsageLabels.test.ts`. It preserved that work and added:

- complete-string UUID rejection before display truncation;
- numeric table-cell wrapping for compact sidebars;
- two identity/metric-conservation regression cases;
- `specs/zaicode-t181-usage-presentation.md`;
- `packages/desktop/scripts/verify-zaicode-usage.cjs`, a GET-only live-router UI gate.

Existing Button variants, semantic palette tokens, pressed/selected bevels,
mode controls and the sole mounted metrics polling owner are reused. No router
configuration, user profile, tasks, provider configuration or saved theme was
changed. Foreign README, package script, provider-node and saved-settings work
remain untouched. No commit, push or tag was performed.

## Executed checks

- `pnpm typecheck`: PASS after final source changes.
- Focused Usage and SRC-119 suites: 14 PASS.
- `pnpm verify:pre-push`: exit 0; lint 0 errors / 108 existing warnings;
  architecture 0 new violations; 1326 PASS, 2 environment skips.
- `pnpm build:zaicode`: exit 0, production renderer/host build with ZAICODE identity.
- Same UI oracle against the pre-refinement packaged executable: exit 1,
  correctly detects opaque route IDs. See T-181-usage-red-control.md.
- `node packages/desktop/scripts/verify-zaicode-usage.cjs`: PASS against the
  freshly built production renderer/main launched through Electron, on an
  isolated project-local profile. Four check groups: live GET data; all tabs
  with selected state and no UUIDs including tooltips; all periods and metrics;
  640x540 page/sidebar numeric layout and close/reopen/shortcut. Zero page errors.

Detailed test logs: `.zaicode-t181-verify.log`, `.zaicode-t181-build.log`.
UI report/screenshots: `zcode/.e2e-cache/usage-t181/` (local ignored test artifacts).
The final UI run is a source-built production runtime, not a newly packaged
release. Chromium's existing text-rasterization limitation remains unchanged.

## Remaining

REVIEW must independently rerun the ticket UI gate. Publication is not authorized
by the host instructions in this session: a continuation goal is not an explicit
request to commit/push. Preserve the SHIP position and request publication
permission rather than inventing DONE or staging predecessor-owned hunks.
