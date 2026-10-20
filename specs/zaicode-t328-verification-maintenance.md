# T-328: preserve current behavior in mandatory verification

This removes obsolete presentation/source-layout assumptions that block current
work despite the contracted UI behavior being present. It does not weaken lint
limits, alter runtime behavior, or restore superseded product rules.

The efficiency panel now uses the compact USD format authorized by Usage
readability work. Its rendered test must still distinguish billed spend,
subscription API equivalent, monthly savings, unpriced calls, and the explicit
"Not a bill" qualifier. Pin the displayed amounts rather than the superseded
four-decimal formatting.

The model-buttons right-click panel now owns per-button visibility instead of
an old maximum-count threshold. Its existing wiring test must require the
correct preference key, panel/list controls, actual visibility writer, and
retained left-click selection.

The Shift hover wiring assertion must tolerate whitespace while still requiring
the complete `engines.accounts` collection to feed the ordered reveal branch.
The existing behavior test for hidden-account inclusion/order and the keyup/blur
listener checks remain intact. Known-bad hidden-account input must fail.

The conversation normalizer exceeds the existing 400 counted-line gate. Move
only its pure attachment projection and attachment type to an adjacent helper,
preserving the old exported type through a re-export. The normalizer remains
the sole conversation-event owner; no new state, IO, synchronization, dependency,
or lint suppression is introduced. Existing provenance/projection suites and
root typecheck/lint/test are the acceptance gates.

The first full run also exposed a Windows worker startup timeout under default
test-file concurrency; the identical two-case native worker suite passes alone.
Bound the services suite to four concurrent test files so its real PowerShell
startup retains CPU access. Preserve every test, assertion, timeout and failure
exit; this changes resource scheduling rather than acceptance or coverage.
