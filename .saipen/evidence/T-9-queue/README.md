# T-9 real desktop queue verification

Implementation source: published application commit
`e90914815ad3c607132cc6aafeea0a106f848cb4`. This verification adds no product
or SAIPEN protocol implementation delta.

Run from the workspace root:

```powershell
node .saipen/evidence/T-9-queue/verify.cjs --out .zaicode/smoke/T9-queue
```

The harness reuses the published `verify-zaicode-free.cjs` environment and
process cleanup. The packaged executable, OS homes, Electron data homes,
bundled router and project folder are isolated. Vendor home/auth overrides
are removed; automatic updates are disabled. Only the launched process tree
is stopped, and its checked temporary directory is removed.

Through visible UI controls it opens a temporary project, opens ZAICODE,
turns Autopilot off, creates a custom agent, explicitly selects SAIFREN,
saves the agent, adds a task and presses Run. Only the native folder chooser
is substituted with the temporary project path. No renderer store, queue
service or database row is mutated by the verifier.

The unchanged completion oracle first rejects the real pre-dispatch Queued
row, then accepts Completed after Run. The host-owned SQLite database is
read independently in read-only mode: completed status, session/run IDs,
start/finish timestamps, agent identity and actual SAIFREN selection must
all agree. The observed UI sequence is Queued → Running → Completed.

VERIFY and independent REVIEW: PASS, 2026-09-30. Timings and runtime IDs are
recorded separately in `receipt.json` and `review-receipt.json`.
`receipt.json` contains the actual run identity and negative
instrument control; two screenshots show the queued and completed states.
Paid subscription inference is outside this verification claim.

During initial harness development, two checks failed because of verifier
assumptions: a text-content word boundary between the model label and hint,
and an expected Ready label where the app correctly shows Queued. These
were corrected without product changes. The final harness was executed
again and passed its own negative control and real runtime checks.

The old T-9 assertion that desktop automation is unavailable is superseded
by this executed scenario. T-94's requested human multi-monitor acceptance
remains separate; these queue results do not supply a human verdict.

## Closure remains pending

The VERIFY and REVIEW criteria are demonstrated, but the canonical
`ticket done T-9 --closure-mode inherited_verified --implementation-source
release:e90914815ad3c607132cc6aafeea0a106f848cb4` command refused closure:
`VALIDATION_FAILED`, because no COMMITTED SAIPEN release receipt names that
application commit. Git publication was independently confirmed on
`origin/zaicode`; it is not being substituted for the protocol's required
release receipt. T-141's root release is parked on the external maintainer's
release-inventory repair. No receipt was fabricated and no gate was bypassed.

T-9 is evidence-complete, not canonically closed. After T-141 publishes,
resolve its real COMMITTED release identity and use that implementation
authority for inherited verification closure.
