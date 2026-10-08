# T-220 — MANUAL-VERIFY STEPS + EXPECTED (Group 1)

**Status: the machine gates passed. The visual acceptance was NOT performed and is not
claimed.** Two hard reasons, both recorded rather than worked around:

1. **The clause screenshots cannot be read.** Every Group-1 clause ships a PNG
   (`media/00N_clipboard_20261005_*.png`). Reading one returns *"Media omitted from provider
   request because the selected model does not support image input."* Each fix below was
   therefore derived from the **clause text plus a code-path trace**, never from the pixels.
   No clause here is screenshot-confirmed, and nothing was tuned "to match" a screenshot.
2. **The running ZAICODE shell must not be stopped.** ZAICODE runs every open session
   including this one, so the live Electron window cannot be closed or relaunched to
   observe it. Browser automation drives a browser, not this desktop shell.

So each row below is a step the operator can do in the already-running app, with what a pass
looks like. Any row that does not behave as stated is a real miss — please say which.

## How the tree is now

Machine gates, re-run on the real tree in the VERIFY pass, 2026-10-05:

| Gate | Result |
|---|---|
| `pnpm run typecheck` | 0 errors |
| `pnpm run lint` | 165 warnings / 0 errors (baseline held) |
| `pnpm run architecture:check` | 0 violations |
| `@zcode/ui` tests | 1132 / 1132 |
| `@zcode/desktop` tests | 246 pass / 0 fail |
| `@zcode/services` tests | 103 / 103 |

Continuation evidence: `goal-continuation-20261005.md` (E2 admission gate, D
presence projector, E1 merge convergence, E3 extent metric), SRC-153 ledger
`SRC-153-disposition-ledger.md` (R006..R017 DUPLICATE, R002-R003 -> T-222,
R004 -> T-223). This checklist is the current acceptance surface; older
wording that contradicts it is superseded below.

Each new gate was proved able to fail: a deliberate red control (setting `gauge` back to the
`tray` value and hardcoding `z-40` in the todo gauge; reintroducing conditional tray capping)
turned the relevant assertions red, and restoring returned them green. A gate that cannot
fail is not a gate.

---

## R002 — composer does not fit everything it needs

**Steps.** In the composer, drag the window narrow — down to roughly 640px and then 480px —
with a long model name selected. Watch the strip at several widths.

**Expected.** The controls collapse in order (optional buttons first, then the model name
narrows, then the model name becomes an icon). Send and Cancel never collapse. Nothing is
silently cut off: past the last rung the row wraps. Buttons are never drawn on top of each
other. Widening the window restores the full row.

## R003 — ProTrail z-order

**Steps.** Open two windows and one of them a third time, or switch windows rapidly.

**Expected.** The window you asked for comes to the front and stays there. A window never
drops behind a different one immediately after you raised it.

## R004 — maximize geometry

**Steps.** Maximize a window. Restore it. Maximize again.

**Expected.** The maximized window fills the work area — its title bar is fully visible and
not under the taskbar. Restore returns the window to the size and position you had before.

## R005 / R040 — stall detector (one defect, two reports)

**Steps.** Start a long job, then stop its engine from making progress while it claims to be
running. Watch the composer working indicator and the meter.

**Expected.** The indicator stops claiming live work once progress actually stops. It no
longer animates forever for a job that has gone quiet.

## R006 — queued row attachments

**Steps.** Queue a message with two or more files attached. Open the queue panel.

**Expected.** Each queued row shows the attachments it will send, not just its text and
status.

## R007 / E1 — SAI Accounts live convergence (MANUAL_PENDING)

Machine proof exists (merge tests: add/remove/stability). This row is the live
part no machine can do: with ZAICODE already open and running,

**Steps.**
1. Note the current account list in Engines.
2. Add / sign in a second supported same-vendor account in SAI Accounts.
3. Wait the normal discovery cadence (bounded polling, default
   `intervalMinutes: 5`, see `ZAICODE_ENGINES_DEFAULT_CONFIG`) or trigger the
   documented on-demand refresh.
4. Observe the list. 5. Remove / invalidate that account. 6. Observe again.

**Expected.** Exactly one new distinct account appears with no ZAICODE restart;
two same-vendor accounts stay two rows; worker/subscription surfaces converge;
after removal no usable stale duplicate remains; existing active work does not
migrate accounts mid-refresh.

## R008 / E2 — automatic audits admission (MANUAL_PENDING)

Supersedes the old "off runs the first wave then parks" expectation: that
behavior is obsolete. The switch now gates automatic ADMISSION itself.

**Steps A — ENABLED.** With Automatic audits ON and Wave generation ON, leave a
project idle with an empty board. **Expected.** Auto Continue / Continue All may
admit an automatic A3 campaign.

**Steps B — DISABLED.** Turn Automatic audits (or Wave generation) OFF.
**Expected.** Auto Continue / Continue All create ZERO new automatic A3
campaigns and ZERO automatic first waves; existing audit artifacts remain;
already-running work is not destructively killed; an explicitly hand-started
audit still runs its first wave and parks per wave; Continue advances one wave
at a time.

**Steps C — restart + re-enable.** Restart ZAICODE with the switch OFF: no
automatic campaign appears. Turn it back ON: automatic admission resumes with
no duplicate resurrection.

## R009 / E3 — composer strip overlap at narrow geometry (MANUAL_PENDING)

The old Workers-tray-vs-Todo-gauge scenario was the wrong screenshot
attribution and is withdrawn. The acceptance target is the lower composer
strip around **+ / adjacent compact control / SAIFREN**, under the extent-based
fit measurement (`useComposerToolbarFit`: each cluster measured to its
furthest child edge, ~301px reproduced constraint).

**Steps.** Narrow the window to roughly 640px, 480px, then ~300px, watching the
lower composer strip; then widen back through neighboring widths.

**Expected.** No visual overlap and no overlapping hit targets at any width; +
stays clickable; the intermediate compact control stays clickable; SAIFREN
stays clickable; past the last rung the row wraps instead of clipping;
widening restores the full row. Send and Cancel never collapse.

## R005 / D — connection / recovery presence (MANUAL_PENDING)

Machine proof exists (9 projector tests). This row is the live part: the
composer mini and the sidebar row must always agree.

**Steps.** Start healthy work; then kill / lose the preferred API/router;
watch through bounded recovery; let fallback engage; then fail fallback too;
then provoke a quota wait; then let healthy execution resume.

**Expected.** Healthy active work -> Working. Lost connection -> Reconnecting
(optionally attempt N/10 during bounded recovery). Fallback engaged ->
Fallback active (never a false second preferred worker). Preferred + fallback
unavailable -> Offline / Interrupted (never Working). Quota exhaustion ->
Waiting for quota/reset. Healthy resume -> Working.

## R001 — Auto Retry packaged click truth (MANUAL_PENDING)

**Steps.** In the packaged build, on the SRC-153 R001 project: click OFF ->
ON; click ON -> OFF; reload / restart ZAICODE.

**Expected.** Every click changes the visible AND effective state; the scope
readout names the owning scope (This session / This project / Inherited:
Global ON-OFF) and never contradicts the tooltip; persisted state after
restart matches the visible state.

## R010 — tooltips spawning in the top-left corner

**Steps.** Hover the composer todo gauge and the SAIMAIL envelope button. Move the window
against the top edge, then the bottom edge, then a corner.

**Expected.** The card always appears next to the thing it describes, never in the top-left
corner. It flips to the other side when the preferred side has no room, and it stays inside
the window at every window size.

## R011 — right click opens that button's settings

**Steps.** Right-click a header button, the AI limits meter, the compact/full toggle, the
sidebar, the clock, the model buttons, and a few more.

**Expected.** Right click opens the settings for **that** control — including the model
buttons, which previously had none. Each control's own settings panel now has a
Settings/Menu switch: left at **Settings** (the default) a right click opens settings; set to
**Menu** the control's right click does nothing special instead.

## R012 — giant tooltips

**Steps.** Hover a todo item with a very long description, and the SAIMAIL mailbox preview
with many unread telegrams.

**Expected.** The card is capped to the room actually available on the side it chose and
scrolls inside itself. It never grows past the window.

---

## What this document is not

It is not an acceptance record. Every row above is untested by machine and awaits the
operator's eyes. If any row misbehaves, the clause goes back to BUILD with the observed
behaviour — not marked done with a note.
