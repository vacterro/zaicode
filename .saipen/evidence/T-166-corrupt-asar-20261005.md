# T-166 — the first `dist-t166` bundle shipped a corrupt `app.asar`

Recorded 2026-10-05T00:57Z, while preparing the T-166 live acceptance. The
packaged build refused to boot, the boot gate rejected it, and the cause was
NOT the code under test. Kept because the next seat must not repeat the
diagnosis from scratch.

## What happened

`ZCODE_DESKTOP_DIST_DIR=dist-t166 pnpm run bundle:zaicode -- --os win --arch x64`
completed electron-builder, wrote the installer, and then failed its own boot
gate (`ELIFECYCLE`, `bundle_exit=1`). The gate did the right thing with a
broken build: it moved the staged tree aside to
`dist-t166/win-unpacked.rejected-20261005005119`.

```
[bundle:zaicode] boot gate: starting ...\dist-t166\win-unpacked.verifying\ZAICODE.exe on a throw-away profile
FAIL packaged boot: electron.launch: Process failed to launch!
  - [pid=20868][err] Debugger listening on ws://127.0.0.1:49195/96417f9a-...
  - [ws connected] -> [ws disconnected] code=1006
  - <process did exit: exitCode=1>
[bundle:zaicode] boot gate FAILED: the staged build was moved to
  ...\dist-t166\win-unpacked.rejected-20261005005119
```

## Ruled out first: a second running ZAICODE

The gate's own comment claims a throw-away profile, but `app.setPath("userData")`
(`packages/desktop/src/main/index.ts:288`, fed by `desktopRuntimeEnv.ts:86`)
overrides Chromium's `--user-data-dir`, so the gate does NOT isolate. With the
operator's own `dist/win-unpacked` tree running, a genuine
`requestSingleInstanceLock` (`index.ts:1871`) collision was the obvious suspect.
Two experiments killed it:

1. Re-running `verify-zaicode-boot.cjs` against the rejected build with
   `ZCODE_DESKTOP_USER_DATA_DIR=V:/_TEMP_/bootgate-t166` — still `exitCode=1`.
2. Launching the known-good `dist-t188/win-unpacked/ZAICODE.exe` at the same
   moment, same throw-away profile, same launcher
   (`V:/_TEMP_/t188-accept/boot-probe.mjs`): a window came up,
   `title="ZAICODE"`. Contention is not the cause.

So the environment was fine and the new build genuinely did not boot.

## The actual cause: an incomplete asar

`resources/app.asar` sizes and contents across the three builds on this machine:

| build | app.asar bytes | entries in asar | entries under `out/` |
| --- | --- | --- | --- |
| `dist-t188/win-unpacked` | 420240507 | 39145 | 5526 |
| `dist/win-unpacked` | 364348977 | 31978 | 5526 |
| `dist-t166/win-unpacked.rejected-…` | 316759664 | 34840 | **1221** |

The working tree's own `packages/desktop/out/` holds 8000 files. The rejected
asar packaged 1221 of them, and its header is inconsistent with its payload:
`@electron/asar` lists `\package.json` but `extractFile(p, "package.json")`
throws on `dist-t166` while it succeeds on both other builds. A main process
that cannot read its own manifest exits 1 before any window and without a
single byte on stdout — which is exactly the observed signature (a GUI-subsystem
binary has no console to write to, and the Windows Application event log stayed
empty).

## What was done about it

`packages/desktop/dist-t166` was deleted and rebuilt once, in the foreground,
with no other bundle running. Verified before the rebuild that no second
`electron-builder` process existed — two concurrent bundles writing the same
`out/` and the same `dist-t166` is the mechanism that would produce a header
that does not match its payload. The rebuild is clean and the gate passes:

```
bundle_exit=0
[bundle:zaicode] boot gate: starting ...\dist-t166\win-unpacked.verifying\ZAICODE.exe on a throw-away profile
PASS packaged boot: shell mounted, 28 Settings sections opened, ProTrail drawing on
  3 monitor(s), customization list live (0->1->2->0), no error card,
  0 uncaught exceptions, 0 console errors
```

The rebuilt `app.asar` is 420240465 bytes, back in line with the 420240507 of
the last known-good `dist-t188` build. T-166 was armed against it at 01:04Z for
the real 2026-10-05T03:01:07Z vendor roll.

The build is tooling output, not a source change: the diff between `dist-t188`
and this tree is the T-188 fix (`bb6b75f1`), its two test files (`625c0119`),
the shipped earlier-seat test/spec (`adac42dc`) and the countdown revert
(`2c25beda`) — none of which touch the desktop main bootstrap.

## Not filed as a ticket

The gate already behaved correctly: it caught a build that 765 unit tests and
`tsc` could not, and refused to let it sit where the launcher would swap it in.
Its throw-away-profile comment is inaccurate on a machine that already runs
ZAICODE, but that inaccuracy did not cause this failure, so it is noted here
rather than fixed under T-166.