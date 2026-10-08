# Unfixed extraction subject

The original HomeFeed effect was moved into `ZaicodeWorkerStatsRecorder`
without changing observation, premature receipt marking, swallowed delivery
failure or lifetime retention. The hook calls observe and flush in the same
effect turn. Session DTO construction is unchanged and remains re-exported.
This makes the original broken algorithm callable without mocking React.

The adjacent snapshots are this real pre-fix subject, not an alternative
bad-input fixture. The final test file and command remain identical when
restoring these snapshots for the controlled regression.
