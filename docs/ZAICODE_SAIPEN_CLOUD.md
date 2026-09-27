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
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | the loop: fetch, compare, fast-forward or push, log, pause; then the product pass and self-update |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip from an independent executor plus cold-recovery proof |
| `tools/saipen-cloud/Test-ProductSync.ps1` | product pass and self-update against throwaway Git repositories (no network, no real remote) |

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

### Product pass (T-90)

`zcode/` is its own repository, so the table above never moves product
code. After it, the same tick handles the product checkout (`-ProductRepo`,
default `<repo>\zcode`; branch `-ProductBranch`, default `zaicode`). The
product pass runs whether or not the outer tree is dirty. It only ever pulls.

| Situation | Move |
|-----------|------|
| remote ahead, no incoming file is dirty here | `git merge --ff-only`; uncommitted product work stays as it is |
| remote ahead, an incoming file is dirty here | HELD: log the files, merge nothing |
| local ahead | log; **never pushed** (product is published by SAIPEN SHIP) |
| diverged | pause, log both ids, merge nothing |
| other branch, a git op in flight, fetch failed | pause |
| no `zcode/` checkout, or `-NoProduct` | skipped |

git refuses on its own a fast-forward that would overwrite a local change, so
the HELD check is an earlier, clearer guard, not the only one. A product
fast-forward does not rebuild anything: to test, run `pnpm bundle:zaicode` (or
the dev preview).

### Self-update (T-90)

The watcher runs as a copy under `%APPDATA%\SAIPEN`, so a newer watcher in
the repository never ran without a reinstall. In loop mode it now compares
its own file with the repository's committed copy on every pass. It installs
that copy over itself and restarts exactly once, with the same arguments,
only when all of these hold:

- the two files differ;
- the repository copy has no uncommitted edits;
- the repository copy parses without errors.

A copy that does not parse is refused and logged, and the running watcher
carries on.

Watchers installed before T-90 lack both the product pass and self-update.
Re-run `Install-SaipenLiveSync.ps1` once on such a machine; after that, the
watcher updates itself.

## Cloud half

`CLAUDE.md` at the root is the entry rule and
`.claude/skills/saipen/SKILL.md` is the execution procedure. The skill fetches
the SAIPEN kernel from `github.com/vacterro/saipen` and runs it through the
declared engine surface `tools/saipen.py`. The kernel is pinned by commit
(`3088eff`), never by tag. Tag `v8.0.1` is an older kernel with the same
`VERSION`; its `validate` mutates state, and its validator rejects this board.

`STATE.saipen_home` records the kernel path of whichever executor checkpointed
last. In the cloud, the first `saipen continue` on kernel `3088eff` converges
it to the running kernel as one journaled `DEC` (E-1410). On the operator
machine the pointer arrives dead in the same way. A kernel with automatic
convergence repairs it on `continue`; otherwise run
`saipen rebind-home --auto`.

**The return trip is observed.** E-1562 (cloud) converged the pointer to
`/home/user/zaicode/.claude/saipen-protocol`; E-1571 (operator machine)
converged it straight back to `V:/.../_SAIPEN`, automatically, with no manual
`rebind-home`. Both directions are the same automatic convergence, so expect
one `saipen_home` `DEC` per locality switch and treat it as expected noise
rather than a defect. It stays noise until P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) moves the pointer out of versioned
state; do not implement P1-2 as a side effect of noticing it. Never hand-edit
the pointer.

`STATE.saipen_home` may point at a kernel **development checkout** that is ahead
of the pin, not at a clean `3088eff` clone — on the operator machine it is the
`accepted-debt-rebind` branch with uncommitted work. A kernel that is not at the
pinned commit is not automatically wrong, but it is not a clean-room source
either, so the rule below about the voice contract applies to it with full
force. Never commit, stash, reset, check out or clean anything in such a
checkout; a targeted single-file restore of `saipen/STYLE.md` is the only
permitted exception, and only when the operator asked for it.

### STYLE.md is not a local setting

`saipen/STYLE.md` must be **byte-identical to the pinned kernel's file** on
every machine, in every copy, with no exceptions and no local edits. There is
more than one copy on an operator machine:

- the kernel checkout at `STATE.saipen_home` (a Git clone, on the operator
  machine a development checkout);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, populated by the
  `saipen-inject` scheduled task (`bootstrap/schedule-run.ps1`). It is **not a
  Git repository**, so `git checkout` can never repair it — a re-sync through
  the injector, or a direct write of the published content, is the only path.

The `style_contract` token in `.saipen/STATE.md` is a hash of that file's text
(`tools/validate.py`, `style_contract_token`: CRLF normalized, the
`style_contract:` line excluded). Edit `reply_language` in one copy and the
token moves; the other copy and the cloud, which fetch the published kernel,
keep the published token, and every CLI write on the mismatching side is
refused with `style_contract ... does not match the installed STYLE.md marker`.
That is the whole failure: the local side writes state the cloud cannot write.

**Changing the reply language is a kernel commit plus a repin**, never a local
edit. Change it in the kernel repository, publish it, re-pin the commit in
SKILL.md, and update `STATE.style_contract` through `saipen recover`. A local
edit to `STYLE.md` desynchronizes every machine that is not the one making it.

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
`vacterro/zaicode` branch `zaicode` and work there. Workspace-layer work does
not require product work, but it does require the clone:
`.saipen/source-nested-repos.json` declares `zcode/`, and without it the
validator fails with `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. `pnpm` gates need the pinned pnpm 10.33.2
and a prepared workspace. `pnpm bootstrap` on a fresh cloud image is the
documented way in, and the product's `package.json` already declares it.

The cloud can verify only product bytes that are on `origin/zaicode`. A
product delta that exists only in the operator's `zcode/` checkout is
invisible here, so every product gate for it is NOT RUN in the cloud, whatever
the gate. T-84 is the first case (E-1411): its fix was local-only while
`origin/zaicode` still carried the pre-fix code.

**UNSAFE_TO_EMULATE** — anything that would make a local-only gate look green.
Do not stub the launcher build, fake a packaged-app run, replay a recorded
`pnpm verify:pre-push` result as if it had just run, or convert "the code
looks correct" into a PASS line in `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — conformance that depends on where the checkout
lives. On kernel `3088eff` the cloud validator reports `closure-evidence`
FAILs (T-47, T-62, T-76, T-78 at the time of writing) that the operator
machine does not.

The kernel moves any LOG event over 1024 bytes into a
`.saipen/recovery/log-detail/` sidecar. On read it restores the sidecar only
when the checkout's absolute path equals the path it was written from. A long
VERIFY verdict written on Windows is therefore unreadable in the cloud, and the
reverse holds too.

The defect is in the kernel and is filed as P1-1 in
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Until it lands:

- quote the cloud verdict and classify it as this boundary, ticket by ticket
  (`SKILL.md` § 6 has the check);
- never rewrite sidecars, re-verify only to get green, or patch the kernel
  copy;
- keep LOG events under 1024 bytes on both sides.

The same machine-path binding also blocks work. The pre-BUILD debt baseline
is captured the first time a ticket enters BUILD and re-checked on every later
entry. A ticket that first entered BUILD on the operator machine therefore
cannot enter BUILD in the cloud: the transition is refused with
`DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 is the case on record: DEBT-000079 was
captured at E-1377 and the transition refused at E-1446. Leave such a ticket to
the machine that captured its baseline.

## Divergence

If local and remote stop sharing an ancestor, the watcher stops. It does not
merge, rebase or force. Both commit ids go into the log, the fix is
`git log --left-right --cherry-pick <branch>...origin/<branch>` by hand, and
the result is checkpointed like any other change.

## The exact cloud-side action

### Environment setup script (one time, in the cloud environment's settings)

Cloud environment menu in the session title bar -> Edit -> Setup script. It
runs before every new session, so each session starts with the product
toolchain ready:

```bash
#!/usr/bin/env bash
# ZAICODE cloud toolchain: Node 24 + pnpm 10.33.2 (product gates),
# 9router 0.5.91 (real-router tests), mono mcs (launcher compile check).
set -u
NODE=v24.14.0
if ! command -v node >/dev/null || ! node -v | grep -q '^v24\.'; then
  curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar -xJ -C /opt
  ln -sf /opt/node-$NODE-linux-x64/bin/node /opt/node-$NODE-linux-x64/bin/npm /opt/node-$NODE-linux-x64/bin/npx /usr/local/bin/
fi
npm install -g pnpm@10.33.2 && ln -sf "$(npm prefix -g)/bin/pnpm" /usr/local/bin/pnpm
mkdir -p /opt/9router && cd /opt/9router && npm pack 9router@0.5.91 >/dev/null && tar -xzf 9router-0.5.91.tgz
(apt-get update -qq && apt-get install -y -qq mono-mcs) || echo "no mono-mcs: the launcher compile check is NOT RUN"
exit 0
```

### The prompt for every new session

Start the session on repository `vacterro/zaicode`, branch `saipen-live`, and
make sure the operator machine's agent is not writing at the same time.
Replace the last line with `cc all <new list>` to hand over new work.

```
Read CLAUDE.md and .claude/skills/saipen/SKILL.md, then cold-recover SAIPEN
state from .saipen/ on branch saipen-live (STATE.md, BOARD.md, tail of LOG.md).
Chat memory is not state; docs/ZAICODE_SAIPEN_CLOUD.md is the transport contract.

Setup (skip what already exists):
- saipen = python3 .claude/saipen-protocol/tools/saipen.py --project-root <repo root>
  (fetch the kernel per SKILL.md if it is missing); run `saipen rebind-home --auto`
  when saipen_home points at another machine.
- Product clone: git clone -b zaicode https://github.com/vacterro/zaicode zcode
  (gitignored here), then `pnpm install` inside zcode (Node 24, pnpm 10.33.2).
- Real-router tests: export ZAICODE_ROUTER_PACKAGE=/opt/9router/package if it exists.

Rules:
- Fetch origin/saipen-live and origin/zaicode before every commit and every push.
  If the other side moved, merge; never rebase, reset or force. If .saipen/
  histories diverged: keep ours on saipen-live-cloud-<sha>, write both ids to
  .saipen/LOG.md, stop and ask me.
- Product gates in zcode: pnpm typecheck, pnpm lint (0 errors),
  pnpm run architecture:check -- --changed, pnpm test. A gate that cannot run
  here is NOT RUN with the reason; a failure blamed on the environment must be
  shown to fail the same without the change.
- I authorize publishing verified product commits to origin/zaicode and SAIPEN
  checkpoints to origin/saipen-live.
- Nothing is PASS until I test on Windows and say PASS. A finished ticket waits
  in VERIFY with .saipen/evidence/T-###-*.md: its commits and the exact manual
  test steps.
- One writer at a time: if LOG shows the local agent mid-work, stop and ask.

cc
```

On the operator machine the watcher fast-forwards `zcode` from
`origin/zaicode`; `REBUILD.cmd` (or `REBUILD_fast.lnk`) builds it, and the
next start of ZAICODE swaps the new build in.
