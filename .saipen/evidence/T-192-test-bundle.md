# ZAICODE test preview — T-192 / SRC-128

This bundle lets you test moving a running internal CLI worker into a separate Windows PowerShell window. The current process continues there while ZAICODE closes. Emoji input still fails, so the feature remains unfinished and this preview is not a verified release.

## Candidate

- Installer: [ZAICODE-3.14.0-win-x64_TEST.exe](V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode/packages/desktop/dist-test-20261003-t192-pass3/ZAICODE-3.14.0-win-x64_TEST.exe).
- Run directly from the separate test directory: [ZAICODE.exe](V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode/packages/desktop/dist-test-20261003-t192-pass3/win-unpacked/ZAICODE.exe). Keep the complete win-unpacked directory together.
- Installer size: 199645980 bytes (190.4 MiB).
- Installer SHA256: `be3c72f146027d92ce2b92f0f4da7c8f62fc80a13794121f9bf4c95dcace02cc`.
- Packaged app.asar SHA256: `f8b1d17af416306dc596001d800e1c42b56b4af7cd0a6e133c4a2865d4eabae3`.
- Source: d427471cdfa44349a0f7937d2463486cb152768b, plus the frozen local workspace changes recorded in [T-192-subject-pass3.json](T-192-subject-pass3.json). This candidate includes the preserved preview workspace, not a clean committed release.
- Machine receipt: [T-192-test-bundle.json](T-192-test-bundle.json).

Use this new pass3 directory. The earlier dist-test-20261003-t192 installer contains the failed GUI-console implementation, and pass2 fails its real external launch with ENAMETOOLONG. Neither earlier candidate should be used for this test.

## Test the handoff

1. Launch the candidate and create a new internal Windows CLI worker. Workers created by an older running build cannot be moved retroactively.
2. Start a harmless long-running command and record its process PID and observable progress before transfer.
3. Open the worker context menu and select **Move to PowerShell**. The original worker should disappear from ZAICODE only after the external PowerShell is ready. The transfer is one-way.
4. Confirm the external window continues the original command and responds to input. Record the PID and progress again; the PID must stay the same and progress must continue.
5. Close and restart ZAICODE. Confirm the external command continues, without a duplicate worker. This operator restart check supplements the automated forced-host-termination check below.
6. Complete the command or close its external window when finished. Closing that window ends its own worker.

## Checks and known failure

The production build and bundle exited 0. The packaged boot smoke passed with paid vendor-window starts disabled in its temporary profile. The actual packaged factory/broker passed 5/5 checks, including a real visible PowerShell transfer and same CLI PID/state after forced termination of the test app host. The unchanged native oracle passed 8/8 checks against the final source. The earlier UI oracle passed 35/35; UI source remained unchanged afterward.

The final focused acceptance still fails on `Write-Output ('UNICODE:' + 'tere-привет-🌙')`: the expected emoji is missing in the transferred PowerShell command reader. Wire probes preserve the complete Unicode payload, and the original internal shell preserves it before transfer. The remaining cause is unresolved. See [T-192-unicode-stop.txt](T-192-unicode-stop.txt) and [T-192-worker-unicode-control.json](T-192-worker-unicode-control.json). The latest complete repository gate also failed and was not rerun after the final console changes. No current full-gate PASS or feature completion is claimed.

Native test cleanup also logged a node-pty `AttachConsole failed` diagnostic while the eight assertions and process exit passed; this receipt does not claim error-free logs.

T-192 stays in BUILD, unpublished and unfinished. All 18 foreign changed product files and 12 frozen T-188 paths were preserved. SRC-128 requests saipen stop after this test bundle; no Scheduler or vendor acceptance work is part of this delivery.
