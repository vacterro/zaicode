# T-176 / SRC-118 — PHASE 0: Antigravity account isolation proof

Verdict: **BLOCKED at PHASE 0.** The installed Antigravity CLI exposes exactly one
credential slot per Windows logon context. No supported isolation mechanism exists.

No credential, token, email or secret is recorded in this file.

## What was checked

### 1. The CLI and its whole flag surface

```
agy --version   -> 1.2.14
agy --help      -> print-mode flags only: --add-dir --agent -c/--continue --conversation
                   --dangerously-skip-permissions --disable-slash-commands --effort -i
                   --input-format --json-schema --log-file --mode --model --new-project
                   --output-format -p/--print --print-timeout --project --prompt-interactive
                   --remote-control --sandbox
                   subcommands: agent(s) changelog help install mcp mic-serve models
                   plugin(s) remote-control update
```

There is **no** `login`, `logout`, `auth`, `account`, `profile`, `keyring`, `identity`
or `usage` subcommand, and **no** `--profile`, `--user-data-dir`, `--auth-store`,
`--keyring`, `--credential` or `--account` flag. Sign-in is an interactive slash
command (`/login`, `/logout`), confirmed by the changelog entry instructing users to
"run `/logout` and `/login`".

### 2. Isolation knobs inside the binary

Token-shaped scan of `agy.exe` (names only):

- `--profile` and `--user-data-dir` exist as **strings**, but neither is a top-level
  flag and neither addresses the credential store. Passing them changes nothing.
- `keyring`, `keyring_windows`, `keyringStorage`, `keyringUser`, `keyringAuth`,
  `keyring_detector_*`, `keyring_fallback` — a keyring implementation with a
  Windows backend and a fallback path, but **no** keyring-namespace flag or env var.
- Every `AGY_*` / `ANTIGRAVITY_*` / `GEMINI_*` / `GOOGLE_*` variable in the binary was
  enumerated. All are UI, telemetry, sandbox or API-key variables. **None** selects or
  namespaces a credential store.

### 3. The credential store itself — decisive

`cmdkey /list` (target names only, no secrets) shows exactly one Antigravity entry:

```
Target: LegacyGeneric:target=gemini:antigravity
User:  antigravity
```

One flat, fixed target name. Compare the neighbouring
`LegacyGeneric:target=gemini-cli-api-key/default-api-key`, which shows the keyring
library *does* support several named entries under one service — `gemini:antigravity`
simply never uses that freedom. There is no `gemini:antigravity:2`, no per-profile
suffix, and no second Antigravity slot.

Windows Credential Manager is partitioned per logon context. A different data dir,
HOME, `USERPROFILE`, browser profile or process environment does **not** create a
second credential target inside the same logon context.

### 4. Live probe — account A works, and is the only one

The exact probe ZAICODE already uses returns real quota for the one stored credential:

```
agy -p "/usage" --output-format json --dangerously-skip-permissions
Gemini Models            Weekly Limit Remaining      36%   2026-10-07T06:41:21Z
Gemini Models            Five Hour Limit Remaining   96%   2026-10-02T14:47:26Z
Claude and GPT models    Weekly Limit Remaining       0%   2026-10-02T16:16:03Z
Claude and GPT models    Five Hour Limit Remaining  disabled
```

Two side findings worth recording:

- In Git Bash the argument `/usage` is rewritten to a Windows path by MSYS path
  conversion and the model answers a disk-usage question instead. The probe must be
  spawned without a shell (`MSYS_NO_PATHCONV=1` when run from Git Bash). ZAICODE's
  `spawn` path already avoids this; ad-hoc shell invocations do not.
- Headless `/usage` shells out, so it needs either `--dangerously-skip-permissions`
  or a `permissions.allow` rule for the command tool; without one the run returns
  `denied_actions` and empty output.

### 5. Documentation search

`agy changelog` was searched for switch/add/second/multiple account, account picker,
per-account and account-specific. **Zero hits.** The full 1.2.14 release history has
no multi-account feature.

## The alternatives are not substitutes

| Mechanism | Why it cannot carry a second Google AI Pro subscription |
|---|---|
| `GEMINI_API_KEY` + `modelProvider: "gemini"` | Runs against the Gemini API (AI Studio) quota pool, a different entitlement from the Antigravity Pro subscription. It also needs a key that the user's personal account does not expose for Antigravity. |
| `AGY_ADC_AUTH` / `GOOGLE_APPLICATION_CREDENTIALS` | Application Default Credentials are a GCP service-account / enterprise path. Producing one for a personal Google account means exporting OAuth material, which SRC-118 forbids and which would put tokens under application control. |
| Second data dir / HOME / USERPROFILE / browser profile | Does not change the `gemini:antigravity` credential target inside one logon context. |
| Credential swapping (save A, write B, run, restore A) | Explicitly forbidden by SRC-118, and genuinely unsafe: races between two parallel workers, refresh-token rotation, crash leaving the wrong credential active. |

## Conclusion

SRC-118's stop rule applies: *do not fabricate a solution.* One Windows logon context
holds one Antigravity credential, therefore it can present one Antigravity account.
The invariant "one visual record = one real independent auth context" cannot be
satisfied today, and PHASES 2-5 must not be started — they would render two accounts
where only one can exist, which is precisely the false multi-account support the
receipt prohibits.

## The minimal safe next option

A genuinely separate Windows logon/security context for the second Antigravity
account. Each logon context gets its own Credential Manager vault and therefore its
own `gemini:antigravity` target, which is real isolation rather than a simulation.

That requires a human, and this ticket stops here on purpose:

1. **Operator decision** — whether to create a second local Windows account on this
   machine for Antigravity account B. Not reversible by the agent, and it is the
   user's machine.
2. **Operator action** — create/choose that account, and run the official
   `agy` `/login` inside it, choosing the second Google account by hand. The agent
   neither reads nor stores the password, and does not perform the login.

Once a second logon context exists and account B is logged in there, the PHASE 0
acceptance is mechanical — snapshot A, snapshot B, A again, B again, both
concurrently — and PHASES 1-5 can proceed against two contexts that are provably
independent.