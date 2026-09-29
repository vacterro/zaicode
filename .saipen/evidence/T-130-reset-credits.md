# T-130 -- Codex reset credits nowhere shown; read resets for ZCode Coding Plans, Claude Code and Codex together; use them from ZAICODE (SRC-093)

Product commit d46d6f0 (zcode branch `zaicode`). The operator's two screenshots: the "Nearest resets" list and "AI Usage Limits" (Codex 2 blocked by a spent week, no reset offered anywhere).

## What the data is (measured, not assumed)

- The Codex app-server protocol, generated offline (`codex app-server generate-json-schema`, CLI 0.159.0): `account/rateLimits/read` returns
  `rateLimitResetCredits { availableCount, credits[{ id, title, description, grantedAt, expiresAt, resetType, status }] }` next to the windows, and
  `account/rateLimitResetCredit/consume { creditId?, idempotencyKey }` answers `reset | nothingToReset | noCredit | alreadyRedeemed`.
- A read-only `account/rateLimits/read` through the operator's own Codex CLI (the call ZAICODE's sweep already makes; nothing spent, nothing recorded here
  but counts): Codex 2 (plus) has ONE available credit, "Full reset (Weekly + 5 hr)", about a month to expiry, while its weekly window is 100% used and
  `ordinaryUsageAllowed` is false; Codex 1 has none. ZAICODE's parser (`parseCodexRateLimits`) read the windows and dropped that block.
- Claude Code 2.1.284: the binary has no reset-credit concept (no `reset_credit`, `resetCredit`, `rate_limit_reset`; only extra usage / overage). There is
  nothing to read or spend for Claude; the list says so in one line instead of showing an empty promise.
- ZCode Coding Plan resets already existed (SRC-081, `ZaicodeCodingPlanResets`, read through ZCode's own controller) but only in the timer's list.

## What it is now

- Read: the quota read keeps the credits (`ZaicodeLimitSnapshot.resetCredits`); a failed read keeps the last ones; "the vendor sent none" (null) is not "0 left".
- Shown: (1) the title-bar reset timer's list, "Reset credits you can use", under the Coding Plan's section: account, count, what is spent (5h + weekly), the
  credit's title, "expires in 29d 0h", a Reset now button; (2) one ⟲ badge counts the Coding Plan's resets and Codex's together (the timer shows even when
  a credit is the only news); (3) every account block (Engines & limits, the usage panel, Home cards) has "⟲ 1 reset credit · Full reset (Weekly + 5 hr) ·
  expires in ..." with the same button; (4) Claude accounts: "Claude Code has no reset credits to read."
- Used: Reset now asks first in the app's dialog ("Use one Codex 2 reset? Full reset (Weekly + 5 hr). 5h and weekly are spent: they refill now. The credit is
  used up. It was the last one." red button), then goes through the main process: only a ready Codex account, one spend per account at a time, the credit that
  expires first (or the one named), a fresh idempotency key per attempt, the quota read again afterwards. The answer is a toast (a warning when nothing was
  refilled). Reading never spends: the read asks the read method only.
- Structure: the JSON-RPC plumbing moved out of `zaicodeEngines.ts` into `zaicodeCodexRpc.ts` (no Electron), so the read and the spend run against a stand-in
  app-server in tests.

## Checks

`pnpm run verify:pre-push` exit 0 (ui 761, services 85, desktop 182 pass 2 skipped, cli 30, oxlint 0 errors, architecture 0 new), `pnpm run typecheck` exit 0.
New tests: desktop `zaicodeCodexRpc` (6, real child process against a stand-in server: read, spend, every outcome, initialize error, exit, timeout with the
process ended, noise, missing program) and `zaicodeResetCreditsIpc` (4); ui `zaicodeSrc93ResetCredits` (12). Red controls: 15 mutations each turn a named test
red (redeemed rows kept, expired credits counted, pick order, outcome parsing, blocked-first order, the "last one" wording, spending without the click, the
busy guard (hangs the test: red), releasing busy, the named credit id, the idempotency key, an unknown answer taken as a reset, the deadline, single flight,
the Codex-only check).

Real Electron (built `out/`, throw-away profile, USERPROFILE and PATH pointing at a STAND-IN `codex` so no real account is touched -- a reset is spent for
good): the sweep reads the stand-in, the badge shows 1; Engines & limits shows "1 reset credit ... expires in 29d"; the timer's list shows the section; Cancel in
the dialog spends nothing (the stand-in's log has no consume call); "Use the reset" sends exactly one consume with creditId credit-1 and a UUID key; the
answer is read back and the badge goes. Screenshots of the list, the dialog and the Engines line were looked at. No real Codex reset was used.

## A defect of mine found on the way (T-126)

The run with a home whose profile folders Electron cannot resolve gave NO window at all: `registerZaicodeCustomizationIpc` called `app.getPath("appData")`
unguarded ("Failed to get 'appData' path") inside `registerPlatformIpcHandlers`, which aborted startup. Fixed in the same commit: the appData path falls back and
the registration is wrapped so a failure is logged, never thrown; pinned by a test.

## Not done / for the operator

- To USE the credit on Codex 2 the operator clicks Reset now in the running app after activating the staged build; nothing was spent by me.
- The ZCode Coding Plan's resets keep their own section and hook (ZCode's controller); they are counted in the same badge but are not listed in the account blocks.
- Claude Code exposes no reset credits; if Anthropic adds them the row shape (`ZaicodeResetCreditRow`) is vendor-neutral.
