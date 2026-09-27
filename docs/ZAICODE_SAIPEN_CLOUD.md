# ZAICODE SAIPEN cloud transport

How this checkout and a Claude Code Cloud session run one SAIPEN workspace
with different executor locality, and where the boundary between them is.

## The shape

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

One branch carries the protocol state. There is no merge step, no rebase step
and no second local branch to keep in step: whichever executor has a verified
checkpoint commits and pushes it, and the other side takes it with a
fast-forward.

`master` is the pre-transport history and `origin/workspace` is its published
mirror. Neither is force-updated by the transport.

## What travels and what does not

A checkpoint in this repository carries the SAIPEN protocol state, the root
launcher, the installer, the docs and these transport scripts. That is the
whole workspace layer.

It carries **no product byte**. `zcode/` is a separate Git repository, listed
in `.saipen/source-nested-repos.json` and gitignored at this root
(`/zcode/`). Product work needs its own clone of `vacterro/zaicode` on branch
`zaicode`, and that clone is a second, independent object with its own history.

The consequence is easy to get wrong: a clean `git status` at this root says
nothing about uncommitted product work, and a `saipen-live` fast-forward says
nothing about product code. Check `git -C zcode status` explicitly.

## Local half

Two scripts, both repo-owned so a new machine gets them from the repository
instead of from memory:

| File | Role |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | validates, reconciles the branch, installs and starts the watcher, writes the autostart entry, proves local == remote |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | the loop: fetch, compare, fast-forward or push, log, pause |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip from an independent executor plus cold-recovery proof |

Install and repair:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

It is idempotent. Machine-local state lives in `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (a copy), `ZAICODE_cloud-sync.log` (rotated at
2 MB to `.log.1`), `ZAICODE_cloud-sync.lock` (single instance),
`ZAICODE_cloud-sync.pid`, and a Startup-folder entry
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

The installer refuses a dirty tree and never cleans it. If every dirty path is
canonical SAIPEN state under `.saipen/`, it says so and prints the exact
checkpoint commands; that is an uncheckpointed protocol state, not a transport
fault, and the installer will not commit it behind the protocol's back.

## Watcher behaviour

| Situation | Move |
|-----------|------|
| clean, local is an ancestor of remote | `git merge --ff-only` |
| clean, remote is an ancestor of local | `git push` |
| dirty | pause; not even a fetch |
| on another branch | pause |
| both advanced, no shared ancestor | pause, log both commit ids, merge nothing |
| fetch or network failed | log degraded, retry next tick |
| a merge/rebase/cherry-pick is in flight | pause |

Never: force push, hard reset, stash, clean, checkout of a foreign branch,
commit, or a stop by process name. The installer stops a watcher only by the
pid it recorded in its own pid file.

A dirty tree costs nothing, because the watcher checks dirt before it fetches.
An idle checkout therefore makes no network calls at all.

## Cloud half

`CLAUDE.md` at the root is the entry rule and
`.claude/skills/saipen/SKILL.md` is the execution procedure. The skill fetches
the SAIPEN kernel from `github.com/vacterro/saipen` (pinned in the skill) and
runs it through the declared engine surface `tools/saipen.py`.

One trap worth naming: the published `bin/saipen` is a machine-bound shim that
hardcodes one operator's absolute interpreter and checkout paths. It runs on
exactly one machine. The cloud must use `python3 tools/saipen.py`.

Shortcuts: `cc` continues the current Work; `cc all <text>` ingests the whole
message as source/appends and continues every eligible Work. Neither asks for
routine confirmation.

## Capability classification

**AVAILABLE_IN_CLOUD** — protocol state and the workspace layer. Reading and
writing `.saipen/`, the launcher (`tools/launcher/ZaicodeLauncher.cs`), the
installer under `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/`, and the
transport scripts. Git read, commit, push and fetch on `saipen-live`. Any
gate that is a file assertion, a diff review or a text check.

**LOCAL_WINDOWS_ONLY** — the gates that need this machine.

| Gate | Why |
|------|-----|
| `tools\launcher\build.cmd` | compiles `ZaicodeLauncher.cs` with the .NET Framework `csc`; no Windows SDK on a cloud image |
| packaged Electron E2E (`zcode` desktop, Solo → queue → dispatch) | needs a desktop session and a seeded provider profile |
| the live 9router | a Windows service on this machine |
| interactive desktop click-through | a human and a screen |
| the watcher's own runtime cases | the watcher only ever runs on the machine holding the checkout |

These are recorded as local-only acceptance boundaries. They are never
reported as passed because the diff looked right.

**SAFE_TO_DEFER** — the product layer. A cloud session can clone
`vacterro/zaicode` branch `zaicode` and work there, but nothing in the
workspace layer forces it to. `pnpm` gates need the pinned pnpm 10.33.2 and a
prepared workspace; `pnpm bootstrap` on a fresh cloud image is the documented
way in, and the product's `package.json` already declares it.

**UNSAFE_TO_EMULATE** — anything that would make a local-only gate look green.
Do not stub the launcher build, fake a packaged-app run, replay a recorded
`pnpm verify:pre-push` result as if it had just run, or convert "the code
looks correct" into a PASS line in `.saipen/LOG.md`.

## Divergence

If local and remote stop sharing an ancestor, the watcher stops. It does not
merge, rebase or force. Both commit ids go into the log, the fix is
`git log --left-right --cherry-pick <branch>...origin/<branch>` by hand, and
the result is checkpointed like any other change.

## The exact cloud-side action

One prompt starts a cloud session that continues the current Work:

```
Read CLAUDE.md, then .claude/skills/saipen/SKILL.md, and continue the active
SAIPEN Work on branch saipen-live. Treat .saipen/ as canonical. Commit and
push your verified checkpoints to origin/saipen-live; never force push.
Record any gate you cannot run here as NOT RUN with the reason.
```
