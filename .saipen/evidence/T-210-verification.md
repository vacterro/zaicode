# T-210: unknown running duration

SRC-144 is implemented in the existing conversation projection and formatter.
Positive finite start/end facts and nonnegative finite active durations produce
localized elapsed labels. Missing, zero, negative, non-finite or future starts
remain unknown. An active segment with unknown time uses the existing localized
plain Working message; completed/interrupted segments never become Working.
Headers, footers and shared history use the same validation/neutral decision.
No clock owner, persisted field, catalog key or runtime lifecycle was added.

The frozen browser fixture mounts production ConversationTurnGroup,
ConversationShareReadonlyTimeline and the real projection. Heavy text/tool
rendering leaves are fixtures; Radix history controls and locale providers are
real. A fixed Chromium clock exercises normal/fresh/restored/detached active
work, invalid/missing timestamps, recorded zero, terminal work, display ticks,
renderer reload, a second run reusing the label, narrow layout and Estonian.

Final oracle: `T-210-ui/{serve.mjs,harness.tsx,verifier.cjs}`.
RED selects four source blobs from product commit a2a5ffdf through the server;
GREEN reads those four paths from the working tree. All fixture and oracle
hashes are identical. RED has 16 defect checks red and 16 positive controls
green; GREEN has 32/32 checks green, zero browser exceptions. Unit regression
uses the same new test file: 3/3 red before implementation and 3/3 green after.
The focused suite including clock history, performance and locale parity passes
15/15. `T-210-audit.mjs` checks all frozen instruments and the exact source set.

The initial 30-check oracle is preserved in *-initial.json. Read-only inspection
found a new-start admission comparison against an old display tick. Before the
final comparison, that comparison was corrected to current wall time and two
component-reuse checks were added. Fresh RED and GREEN were established on the
strengthened 32-check oracle; no earlier red is spent on a later oracle.

The unmodified T-191 fixture and verifier pass 31/31, including multi-hour
headers/footers, frozen terminal durations and no clock-driven work rendering,
terminal remount or input injection. The original server's fixture leaves lack
two imports added by later worker work. A separate compatibility server adds
only those leaf exports and uses the unchanged original harness and verifier;
all three historical instrument hashes remain byte-identical.

Final repository gates: typecheck 0, lint 0 with 162 existing warnings and zero
errors, architecture 0 violations, complete tests 1485 collected / 1483 pass /
2 inherited skips / 0 failures. All four receipts report zero source changes.
The six-path product scope and 18 preserved foreign paths are pinned in
`T-210-subject-final.json`. Publication is an isolated product-branch patch;
the roadmap continues after this ticket.
