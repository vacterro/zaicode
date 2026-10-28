# Soak coverage tolerance (T-179)

Eliminate the undocumented ten-percent shortfall that allowed a 12-hour soak to
pass after only 10.8 hours. Coverage belongs to the existing verdict helper;
live and replay runs must carry the same configured sampling interval.

## Rule

A configured horizon may miss at most one sampling interval, not a percentage
of the horizon. The harness records elapsed time at the beginning of each
measurement, then probes and waits for `sampleSeconds` before its next iteration;
there need not be a sample at the exact requested deadline. Default cadence is
15 seconds. A finite positive configured cadence smaller than the horizon is
used; malformed cadence falls back to the default, and a cadence at least as
large as the horizon grants no tolerance. The verdict reports the applied
`coverageToleranceSeconds` so the allowance remains explicit evidence.

This change does not change the existing final-fps-row coverage source (T-177),
FPS degradation criteria, churn accounting, or surface checks. Those are
independent evidence contracts.

## Acceptance

The unchanged test oracle fails against the old ten-percent implementation.
Healthy timelines at 90.1%, 95% and 99% of a 12-hour window fail. Timelines just
below, at and above one cadence short of the horizon exercise the boundary;
full coverage still passes. Custom cadence, invalid cadence and horizons
shorter than a cadence cannot silently widen acceptance. Live and replay
configuration propagate `sampleSeconds`. Execute existing soak-verdict tests,
product typecheck, lint, architecture check and full pre-push suite.
