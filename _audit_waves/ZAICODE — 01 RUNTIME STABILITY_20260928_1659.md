ZAICODE

# Wave 1 — Runtime stability and exactly-once behavior

## Goal

Fix the current user-visible regressions before adding more stateful behavior. This wave is bug-first and must not expand into unrelated feature work.

## A. ProTrail is missing immediately after ZAICODE startup

The operator reports that ProTrail does not work right after ZAICODE starts. Older work proved settings/runtime pieces individually, but that does not satisfy current startup behavior.

Investigate the packaged Windows boot path end to end:
- persisted ProTrail enabled state is loaded;
- renderer and global overlay services become ready;
- Raw Input/global helper startup is requested when required;
- per-monitor overlays are created;
- first authoritative settings/state payload is not lost to a `did-finish-load`, `ready-to-show`, `isLoading()` or listener-registration race;
- tray/start-minimized paths do not skip initialization;
- no Settings visit or toggle is required to "wake" the feature.

Required invariant:

`persisted_enabled && app_running -> ProTrail runtime converges to active without user re-toggle`.

Add a startup regression that is RED against the broken behavior. Exercise at least normal launch, relaunch with persisted enabled state, and renderer reload/reconnect. Keep the existing T-94 live multi-monitor acceptance truthful; this wave does not manufacture that operator PASS.

## B. `saipen crew` appears to submit two messages at once

Treat `.saipen/extensions/subs/crew.md` as the protocol authority. Current protocol says `sc` / `saipen crew` is one agent walking a fixed serial circuit. It is not a parallel multi-message runtime.

Therefore first trace ZAICODE exactly once from:
- composer command recognition;
- local command routing;
- queue/job creation;
- provider/runtime dispatch;
- session message insertion;
- retry/auto-continue hooks.

Determine whether two visible messages are caused by duplicate composer submission, command handler + ordinary message handler both firing, duplicate queue jobs, retry replay, renderer reconnect replay, or an actual lower-layer SAIPEN issue.

Do not "fix concurrency" in SAIPEN without evidence. If ZAICODE emits two dispatches for one operator action, fix ZAICODE and introduce a stable idempotency/dispatch key at the narrowest authoritative boundary. One physical operator submit must create one logical user turn and one initial runtime dispatch.

Regression matrix:
- Enter key;
- Send button;
- `saipen crew` and `sc` alias;
- rapid double-click / key repeat;
- renderer remount/reconnect;
- retry after a real transport failure;
- auto-continue enabled/disabled.

Retries may create another transport attempt but must never create another logical user turn unless protocol semantics explicitly require it.

## C. Elapsed timer continues after work is complete

Find the authoritative terminal-state transition for a job/session/audit item. The displayed elapsed value must be derived as:
- running: `now - startedAt`;
- terminal: `completedAt - startedAt` (or equivalent authoritative final timestamp).

Terminal states include every product-defined completed/failed/cancelled terminal state. Do not keep a render interval alive merely because the component still exists. Add regression coverage with fake time and verify that elapsed freezes exactly at completion and survives reload unchanged.

## D. Notification cannot be closed

Reproduce the specific notification surface from the current product. Verify:
- close control receives pointer/keyboard input;
- click is not swallowed by a parent drag/overlay layer;
- dismissal updates the authoritative notification store;
- persistent notifications distinguish "cannot auto-dismiss" from "cannot manually dismiss";
- a dismissed transient notice does not reappear immediately due to stale source state.

Add accessibility semantics for the close action if missing. Do not globally suppress important errors merely to make the notice disappear.

## E. Commit/push reports a failure

Capture the exact command, exit code, stdout/stderr, branch, upstream and working-tree context from the current failure. Classify before patching:
- commit itself failed;
- nothing to commit;
- hook/pre-push gate failed;
- no upstream/remote;
- non-fast-forward;
- authentication/permission;
- dirty generated files;
- product/outer repository mismatch;
- misleading UI despite successful git command.

Fix the root cause only when it is ZAICODE-owned. External/auth failures must be rendered honestly with a useful recovery action and must not be shown as generic success/failure noise.

Never auto-force-push.

## F. Reported UI overlap

Operator evidence path from the source request:
`V:/___VAC/_PIC/_Clipboard_stuff/clipboard_20260927_195405_258fe415.png`

Use it if available on the operator machine. If it is unavailable, reproduce the overlapping surface from current UI rather than guessing the element.

Test at least 1920x1080 and 1366x768, normal Windows scaling, long labels, and the relevant hover/active state. Fix layout ownership, overflow, min-width or stacking at the component responsible. Do not hide content as a substitute for layout correctness.

## Wave acceptance

- ProTrail starts from persisted enabled state without opening Settings or toggling it.
- One `saipen crew` submit creates one logical user turn and one initial dispatch.
- completed work elapsed time freezes and stays frozen after reload.
- the reported notification closes normally without suppressing its source event.
- commit/push UI reports the real git outcome and a ZAICODE-owned failure is fixed.
- the reported overlap is reproduced and eliminated without causing new clipping.
- focused regressions and all relevant repository gates pass.
