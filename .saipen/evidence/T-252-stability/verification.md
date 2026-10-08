# T-252 recovery stability

At product baseline `9ab895bf`, direct dispatch bypassed blocked recovery and
the resume/claim path exposed prior attempt timestamps, session, model and
result. All three SQLite repositories could reopen after close. A ready
repository also exposed a second race: job-service startup could continue into
reconciliation and restart its heartbeat after service disposal.

The shared transition matrix now supplies the permitted sources of every
atomic state-writing SQL statement. Blocked work requires Resume; waiting is
not a fresh claim. Resume/new claim clear previous-attempt projection fields.
Attempt count and old run id survive resume for stale-write discrimination;
new claim replaces the run and increments the count. Existing upstream
session history remains the session owner. This prevents stale duration,
session links and actual-model facts on recovered queue jobs.

Each repo captures one initialization generation; close invalidates it and a
post-mkdir check rejects stale initialization before opening SQLite. Old catch
handlers cannot close a fresh generation. Explicit post-close ensureReady is
supported. JobService disposal is terminal for that instance; its existing
repository admission path checks lifetime before/after await. Startup cannot
restart a heartbeat, and late APIs cannot reopen the repo. Cold concurrency
reads/writes now wait for the same repo readiness.

No schema migration, second data store, timer or permission policy was added.
Spec: `zcode/specs/zaicode-t252-recovery-stability.md`.

Evidence:

- Exact command from `zcode/packages/services`:
  `node --import tsx --test --test-reporter=spec test/zaicodeT252Recovery.test.ts`
  reports 23 passed, zero failures/cancellations (`regression-green.log`).
- Same final verifier against all four HEAD implementations: 14 assertion
  failures; independent old agent/job/stats/service implementations produce
  2 / 8 / 2 / 3 assertion failures. Known-good matrix controls still pass on
  the old subject. `red-control.mjs`, five red logs and `red-controls.json`
  preserve the exact commands, verifier hash and restored source SHA256s.
- The first matrix fixture compared decoded optional fields with the input
  shape; it was corrected to compare before/after stored projections before
  production edits. Final controlled evidence uses only that corrected oracle.
- Ten mutation cases cover all nine statuses, including terminal
  irreversibility, legal recovery, cancellation, stale reclamation and host
  release. Separate cases prove direct-RPC denial, clean resumed/claimed rows,
  stale outcome/attach refusal and fresh-session/model attachment.
- Three real repo races use the guaranteed asynchronous mkdir boundary,
  without sleeps/mocks. Pending close produces no SQLite file, fresh
  initialization survives old rejection, and Windows directory removal proves
  storage handles remain closed after shutdown. Startup/shutdown drives the
  real JobService methods in the same order as node.ts, with both cold and
  already-ready repositories; no heartbeat may start.
- Existing shutdown-recovery test now constructs a fresh service/host for the
  restart. It retains its recovery assertions and additionally checks host
  identity changes. Reusing a disposed service was a false restart model.
- Focused recovery/queue/agent/statistics suites: 50 passed (`focused.log`).
- Pinned pnpm 10.33.2 `run typecheck`: exit 0 (`typecheck.log`).
- `run verify:pre-push`: exit 0 (`prepush.log`), 1928 tests across seven
  suites (118 / 1320 / 165 / 260 / 45 / 9 / 11), zero failures/cancellations;
  lint zero errors with 166 existing warnings, architecture zero violations.
- Workspace freshness, services context and `git diff --check` passed.

Scope: four services source files, the existing job test, one new regression
suite and one spec. Formatter-only changes within those files are included;
foreign `.saipen-red/` and workspace edits are preserved. Full Node service
assembly and packaged visual acceptance are not claimed by these focused
service tests. No unrelated SRC-160 residual is waived.

Confidence: high for the repaired repository, service and current queue-data
contracts. The next worker-statistics bug is separately recorded as T-253.

Independent REVIEW repeated the exact 23-case regression and passed
(`review.log`). Product commit `7faedc74` was pushed fast-forward to existing
`origin/zaicode` and freshly read remote HEAD matches the product commit.
Exactly seven reviewed paths were staged; pre-ship index tree was
`6360a2af5d57fcf9417b65d48b32b38a761fa0ac`. Foreign scratch was preserved.
This publishes the separate product branch, not a workspace/installer tag.
