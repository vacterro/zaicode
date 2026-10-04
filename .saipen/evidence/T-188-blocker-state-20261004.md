# T-188 — the recorded blocker is stale; the live acceptance is still not reachable, but for a different reason

Measured 2026-10-04, workspace `V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_ZAICODE`.

## The recorded blocker

`.saipen/recovery/board-compaction/T-188/T-188-c26e80e60890de114382f237.BOARD.md`:

> BLOCKED_EXTERNAL -- Live starter criterion C5 cannot currently be exercised: both
> Antigravity pools are consumed before isolated app launch, so no genuine idle-window
> admission exists. ... Fresh vendor reset must provide an idle pool; earliest known
> Gemini reset is 2026-10-03T13:14:13Z. Never fake quota, credentials or successful admission.

## What still holds

**The engineering is complete and its frozen oracle is green on the current tree, not
only at subject time.** The frozen nine-case regression
`zcode/packages/ui/test/zaicodeT188WindowStart.test.ts` (sha256 `2d2b9bae`, the oracle
named in E-3093) was run against today's working tree:

```
pnpm --filter @zcode/ui exec node --import tsx --test test/zaicodeT188WindowStart.test.ts
# 9 tests, 9 pass, 0 fail
```

One of the twelve files in `.saipen/evidence/T-188-subject-final.json` has drifted since
2026-10-03T09:09:07Z — `packages/ui/src/zaicode/ZaicodeLimitViews.tsx` — and the other
eleven still hash exactly as recorded. The nine cases still pass with that one file
drifted, so the behaviour the subject froze is intact in the tree as it stands today.

## What no longer holds

**"Both Antigravity pools are consumed" is no longer established.** The blocker names
its own expiry: *earliest known Gemini reset is 2026-10-03T13:14:13Z*. That instant is
more than 24 hours in the past. The premise was true when written and has simply aged;
nobody re-measured it, so the ticket still asserts a fact about a window that has since
passed. This is the same decay T-215 was found to have.

**T-176's isolation wall does not apply in this logon context.** T-176's blocker rests
on Antigravity holding exactly one credential per Windows logon context. Checked
directly:

```
cmdkey.exe /list:gemini:antigravity
  Target: gemini:antigravity
  Type: Generic
  User: antigravity
  Local machine persistence
```

The credential is present here. Whatever blocks T-176 is about a *second, isolated*
context, and it is not the obstacle to a live acceptance run in this one.

## What actually stops the live acceptance now

The gate on C5 is knowing whether a pool is idle, and that comes from the product's own
read-only probe, `probeAntigravity` in
`zcode/packages/desktop/src/main/zaicodeEngines.ts:715`, which shells out to
`agy -p /usage --output-format json`. Reproduced from the shell against the installed
CLI at `C:\Users\vac34\AppData\Local\agy\bin\agy.exe`:

```
jetski: no output produced -- a tool required the "command" permission that headless
mode cannot prompt for, so it was auto-denied.
{"status":"SUCCESS","response":"","denied_actions":[{"action":"command",...}],
 "usage":{"input_tokens":34628,...}}
```

So the headless probe cannot complete: `/usage` reaches for a `command` tool, headless
mode cannot prompt for it, and it is auto-denied. There is no `permissions.allow` rule
for it — no `settings.json` exists under `C:\Users\vac34\AppData\Local\agy` or under
`.zaicode/home/.gemini/antigravity-cli`, and the product supplies no such rule either.

Two things are deliberately *not* done here:

- The shell reproduction is **not** evidence that the product's probe is broken. It ran
  a full agent turn (34,628 input tokens) and returned an empty response, which is not
  what `probeAntigravity` expects to parse. The product path runs inside the packaged
  app with its own resolved `account.cli` and profile; it may well succeed where this
  ad-hoc shell call does not. The reproduction establishes that *this* route is not a
  way to read the pool, nothing stronger.
- **No blanket `command` permission was granted to the vendor CLI** to make the probe
  return something. Auto-approving a command tool for a vendor CLI in the operator's
  home directory is a security-posture change made for test convenience, and it is
  outside the product. If it is genuinely required for C5, it is a decision to record,
  not one to slip in.

## Net position

C5 -- *a real supported Antigravity starter succeeds once, live reset and start anchor
survive multiple sweeps and app restart, SAIHOME and topbar agree* -- remains unproven.
Nothing here fakes quota, credentials or a successful admission. What changed is the
reason: the ticket no longer waits on a pool that may well be idle, it waits on a live
run of the packaged app against a real vendor account, which needs the app up and an
idle pool confirmed by the product's own read.

## Reproduce

```
# nine-case regression against the current tree
cd zcode && pnpm --filter @zcode/ui exec node --import tsx \
  --test test/zaicodeT188WindowStart.test.ts

# credential presence in this logon context
cmdkey.exe /list:gemini:antigravity

# subject drift
python -c "
import json,hashlib,os
d=json.load(open('../.saipen/evidence/T-188-subject-final.json',encoding='utf-8'))
print([f['path'] for f in d['files']
       if hashlib.sha256(open(f['path'],'rb').read()).hexdigest()!=f['sha256']])"
```