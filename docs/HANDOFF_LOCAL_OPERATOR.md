# Handoff: what the operator machine does after the 2026-09-27 cloud session

Audience: the operator, or a local agent working in this checkout on the
Windows machine. Run the sections in order. Every step names its expected
result, so a surprise is noticed at the step that caused it. None of the
steps rewrites history, force-pushes or discards work.

State when this was written:

| Repository / branch | Head | What it carries |
|---|---|---|
| `origin/saipen-live` | the commit that adds this file | Protocol state; the new watcher and its test; the handoff and cloud docs |
| `origin/zaicode` | `5260c2f` | Four product fixes (T-89) on top of `4860369` |

## 1. Install the new watcher (one time, required)

The running watcher is a copy in `%APPDATA%\SAIPEN`. It still syncs
`saipen-live`, but it has neither the product pass nor self-update. It
fast-forwards this checkout to the commit that carries the new watcher, and
then keeps running the old code.

1. Confirm that the outer checkout arrived and is clean:

   ```
   git -C <ZAICODE> status --short
   git -C <ZAICODE> log -1 --oneline
   ```

   Expected: no output from `status`, and the head is the commit that added
   this file. If `status` lists paths under `.saipen/`, checkpoint them
   through SAIPEN first. The installer refuses a dirty tree on purpose.

2. Reinstall:

   ```
   powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
   ```

   Expected: it ends with `Synchronization: VERIFIED`.

3. Within 30 seconds, `%APPDATA%\SAIPEN\ZAICODE_cloud-sync.log` has a line
   starting with `Product:`. Expected:
   `Product: fast-forwarded 4860369... -> 5260c2f...`, or
   `Product: synchronized at 5260c2f...`.

   Any other `Product:` line is covered in section 2.

From then on, a newer watcher committed to `saipen-live` installs itself.
The log shows `Self-update: installed ...`, followed by a single new
`Watcher up`.

## 2. If the product line is not "synchronized"

The four commits change only these files: `packages/ui/...`,
`packages/desktop/src/main/zaicodeSplash*.ts` and new test files. They do not
touch your unpublished T-84 files (`packages/desktop/src/host/zaicodeRunDispatch.ts`,
`packages/desktop/test/zaicodeHitAndGo.test.ts`), so those uncommitted edits
do not block the fast-forward.

| Log line | Meaning | Action |
|---|---|---|
| `HELD: ... (<files>)` | An incoming file has uncommitted changes here | Commit or finish that work. The next pass then fast-forwards by itself. |
| `... is ahead of origin/zaicode. Not pushed` | You have product commits that were never published | Publish them through SAIPEN SHIP (`git -C zcode push origin zaicode`). The watcher never pushes product. |
| `DIVERGED: local <a> and origin/zaicode <b>` | Both sides have commits | `git -C zcode pull --no-rebase origin zaicode`, resolve, commit, push. Never rebase or force. |
| `product branch is 'X', expected 'zaicode'` | `zcode/` is on another branch | `git -C zcode switch zaicode` when you are ready |
| `fast-forward ... failed; git changed nothing` | git itself refused | Read the file list in that line, then treat it like HELD |

## 3. Prove the bridge on Windows PowerShell 5.1

The cloud ran the test under PowerShell 7.4.6 only (`32 checks, 0 failures`).
Windows PowerShell 5.1, the one that runs the watcher, still has to pass it
here:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\saipen-cloud\Test-ProductSync.ps1
```

Expected: `PRODUCT SYNC VERIFIED: 32 checks, 0 failures.` The test works in
`%TEMP%` against throwaway repositories and touches neither this checkout
nor GitHub.

Optional: the full round-trip, `tools\saipen-cloud\Test-SaipenLiveSync.ps1`.
It pushes probe commits to the real `origin/saipen-live`.

## 4. First SAIPEN call on this machine

1. `saipen continue`. `STATE.saipen_home` still points at the cloud's kernel
   path, and this call converges it back to your installation. That is one
   `DEC` event, the mirror of cloud event E-1410. If the answer is
   `home-dead` instead, run `saipen rebind-home --auto`. Never edit STATE by
   hand.
2. `saipen validate`. Expected here: `VALID` / `CURRENT_PASS`.
   - The cloud shows four `closure-evidence` FAILs (T-47, T-62, T-76, T-78).
     That is the known boundary described in `.claude/skills/saipen/SKILL.md`
     § 6, and it should not show here.
   - If anything here names `/home/user/zaicode`, it is the same
     machine-path binding (P1-1 in `docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`)
     in the other direction. Record it and do not rewrite the record.
3. Checkpoint and commit the resulting `.saipen/` change as usual. The
   watcher pushes it.

## 5. Test the four product fixes

In `zcode\`. The commits change no dependency, so `pnpm install` is only
needed if you have not installed since `4860369`.

```
pnpm run verify:pre-push
pnpm bundle:zaicode
```

`verify:pre-push` should pass everything, including the 9 Windows-only
desktop tests that the cloud skipped. The cloud counts were ui 284, services
49 and desktop 44+9. Then start the build. `ZAICODE-Preview.exe` gives an
isolated one-time session that keeps your daily profile safe.

| Fix | How to see it | Expected |
|---|---|---|
| `6295bec` working-for timer | Let a session work for a few minutes, then open it | The chatbox and the project row show the time since the work started, not `0m` and not the session's age |
| `99bcffa` tooltip blink | Hover Stop and other hint icons, resting at their top edge | The hint appears once and stays |
| `f4284a1` start-up picture | Settings: pick a PNG, restart, then pick a JPG and restart | The launcher splash, the app splash and the settings preview all show the JPG |
| `5260c2f` background retry | Fail a turn (for example, kill the network) in a project you do not open | After the retry interval an `Auto-retry (attempt 1)` toast appears without opening the project |

Report the results back as a verdict (`MANUAL-VERIFY RESULT: PASS/FAIL ...`
on T-89). A step that was not done is not a PASS.

## 6. Which work runs where

| Work | Where | Why |
|---|---|---|
| **T-84** Solo reasoning default | this machine | The fix exists only in your `zcode` working tree. Its debt baseline (DEBT-000079) is bound to this machine's path, so the cloud cannot re-enter BUILD for it. Next: publish the T-84 delta, run `pnpm run verify:pre-push`, then drive packaged Solo -> queue -> manual Run and read the terminal job's `actualModelSelection`. |
| **T-89** remaining polish audit (25 repeats) | a cloud session | Its debt baseline was captured in the cloud, so this machine would get `DEBT_SNAPSHOT_FOREIGN_PROJECT` on BUILD entry. The coverage map is `.saipen/evidence/T-89-polish-audit.md`. |
| **New item #1**, the Claude Code reset system | needs you first | Send the text of the new Claude Code `/usage` output. The screenshot `clipboard_20260927_075217` is on `V:` and the cloud cannot see it. LIMISAW and FastPrompter live only on this machine. |

## 7. Rules that keep the bridge from breaking

- Never force-push, `reset --hard`, stash-and-drop, or clean either repository.
- On divergence, keep both sides, write both commit ids into `.saipen/LOG.md`,
  and merge by hand.
- Keep every LOG event under 1024 bytes. Longer events become sidecars bound
  to one machine's path.
- Never rewrite `.saipen/recovery/*` records or STATE fields to turn a gate
  green on one side.
- Product reaches `origin/zaicode` only through SAIPEN SHIP. The watcher
  only ever pulls product.
