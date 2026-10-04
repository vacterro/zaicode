# T-195: implement directly by default

SRC-130 requests immediate implementation without the large plan card or a
separate implementation approval. Product contract:
`zcode/specs/zaicode-immediate-implementation.md`.

The composer draft remains the intent owner. Unmarked legacy Plan drafts restore
with Plan off, keeping text and model. Restored session configuration cannot opt
the next submission into planning; replayed automatic plan entry remains off.
`/plan` and the checkbox mark a deliberate choice in that same draft. Native v4
submission freezes the existing execution-state field, and the real permission
owner permits edits while rejecting unsolicited EnterPlanMode before full access.
The tool description now agrees with that policy and omits more than 4,000
characters of proactive planning instructions. Upstream/explicit configured
planning keep their existing policy.

Successful/historical ZAICODE plan cards are omitted from the real renderer and
their hidden body from assistant copy. Failure output remains visible. Recorded
plans and explicit pending plan interactions are not deleted.

## Frozen regression and positive controls

Base product: `6fa72c2959567c01f72dc6c2058a5b01217bed4d`.
Ten-path subject: `T-195-subject.json`, fingerprint
`0cfe1416b0722adfac0fd7516052c43a7fd0b1b2b73b26e720184614e79c14db`.
Foreign eighteen/T-188 twelve paths remain byte-identical.

- UI unit oracle
  `1b7ab46bc1e9d86aa7672837f21a40cfe4b0be9cfb836cc34a53736a8a245060`:
  frozen RED 2 failures/3 positive passes, GREEN 5 passes. Actual persisted
  draft migration, text/model preservation, frozen submission Plan off,
  explicit Plan on, replay deduplication, normal exit and upstream behavior.
- Core unit oracle
  `071855e76c117e8bedbf765056126ae93aa883ec4b59ee5bf19d5fa39bebec90`:
  frozen RED 1 failure/2 positive passes, GREEN 3 passes. Actual permission
  owner and actual model-visible tool guidance; explicit override/upstream.
- Visible Chromium oracle
  `cf3a0d8d69365de10547db32257b8143906e77f9d04fd90d3cceaf47356ac4f4`:
  actual production SwitchModeToolCallBlock and assistant copy function,
  real Intl/React and ToolOutput, markdown/code/service leaves isolated.
  Frozen RED 5 failures/5 positive passes against base source; GREEN 10/10,
  zero browser exceptions. Product/upstream rerenders, error visibility,
  preserved normal answer, copy and narrow viewport covered.

Receipts: `T-195-red.json`, `T-195-green.json`,
`T-195-ui/{red,green}/receipt.json`. Commands and expected failures are retained;
neither a missing test nor a compile failure counts as the RED control.

## Gates

`T-195-typecheck.json` and `T-195-core-typecheck.json`: exit 0.
`T-195-pre-push.json/txt`: full repository 1351 passes/two skips/zero failures;
lint 108 warnings/zero errors; architecture zero violations.
Independent REVIEW, final canonical conformance and carrying publication are
recorded before closure. No live paid model call was made for this UI/runtime
policy acceptance; actual provider response quality is not claimed by fixtures.

Independent visible REVIEW also passed 10/10 with the identical oracle and zero
exceptions. Core returned CURRENT_PASS. The exact ten-path scope was committed
as `dd9c0e9549a60dcd8e3fd4a2cb9fb8185113ab70`, pushed to the established
product `origin/zaicode`, and independently confirmed with `git ls-remote`.
The prior empty index was saved, staged paths matched the frozen manifest and
staged diff check passed. All foreign eighteen paths stayed byte-identical.
