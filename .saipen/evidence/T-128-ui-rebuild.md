# T-128 -- rebuild the UI where it is poor and clumsy (SRC-091): what was rebuilt, what was wrong, the test that goes red on the old source

Product commit 5ce76ac (zcode branch `zaicode`). The operator's examples: T-117 (empty chat window), T-119 (a "No folder" word, a New folder button that is not
an obvious button), T-122, T-124 (empty lines for a single/pool cell), T-127 (a pool that cannot be built without a duplicate).

## How the surfaces were found

Not by taste: by running the built app and by one greppable rule. The examples have one thing in common -- a control nobody looked at while it ran. So the
pass (1) grepped every native browser dialog in `packages/ui/src` (`window.prompt/confirm/alert`), (2) ran the desktop app and asked whether they work at all,
(3) drove each rebuilt control in the real app (Playwright on the built `out/`, a throw-away profile) and (4) looked at a screenshot of Settings > every
section (29) and of each new control.

Finding (2) is the important one: in the desktop app `window.prompt("x")` throws `prompt() is not supported.` (measured 2026-09-29, built `out/`; `confirm` exists).
So every button that asked for a name with `prompt` did nothing at all. Finding (3) added a second dead control that no unit test could see (below).

## The surfaces

| # | Surface | What was wrong | What it is now | Test that goes red on the old source |
|---|---------|----------------|----------------|--------------------------------------|
| 1 | Sidebar **New folder** (the icon button T-119 made) | `window.prompt` -> "prompt() is not supported": the button did nothing | a popover under the button with a name field (starts on "New folder", Enter creates, Escape leaves, blank keeps the suggestion) | U1 (no browser dialog calls anywhere), U5; real app: Escape -> no folder, typed name + Enter -> folder, blank -> "New folder" |
| 2 | **Folder options menu** (the "..." on a folder header) | `FolderMenu` kept its own `open` flag that started false and returned nothing: the menu could never be seen, so Rename and Delete folder were unreachable | the header alone decides; the menu opens | U4 renders `ZaicodeFolderMenu` and needs the Rename and Delete items; real app: the menu opens |
| 3 | **Rename folder** | `window.prompt` (and behind the dead menu) | the menu turns into the same name field, starting on the current name | U5; real app: "Reviews" -> "Reviews 2" |
| 4 | **Delete folder** | `window.confirm`: the operating system's blocking dialog, a beep, no styling | the app's own confirmation: "Delete folder (projects are kept)?", what happens in words, red button, Esc/Enter | U5, U7; real app: Cancel keeps the folder, confirm deletes it and the project stays |
| 5 | Session text **Save as preset** | `window.prompt`: did nothing | an inline name field in the presets row (starts on "My text") | U7; real app: Escape leaves, Enter adds the preset button |
| 6 | Session text **Import settings** | `window.confirm` with a multi-line paragraph | the app's dialog: what the file would replace, "Import now" | U7 (asked before `importDocument`, a declined dialog leaves settings alone); real app: Cancel changes nothing, confirm replaces |
| 7 | **CLEAR ALL DONE** | `window.confirm` with the list of sessions | the app's dialog with the same list as bullets, "Clear N" | U7 (asked before anything is archived; declined stops it) |
| 8 | A **plan reset** ("Reset now") | `window.confirm` for a reset that is used up for good | the app's dialog, red "Use the reset" | U7 and the moved Src81 pin (asked before the reset is spent) |
| 9 | **Stopping a running worker** | `window.confirm` that froze the window | the app's dialog, red "Stop and close"; an ended worker or the setting off closes without a question | U6 (`zaicodeWorkerCloseRequest`) |

New shared piece: `ZaicodeNameField` (`resolveZaicodeName` is its rule). The confirmations reuse the app's own `confirmDialogStore` (project helper first).

## Checks

`pnpm run verify:pre-push` exit 0 (ui 749, services 85, desktop 169 pass 2 skipped, cli 30, oxlint 0 errors, architecture 0 new), `pnpm run typecheck` exit 0.
New suite `zaicodeSrc91UiRebuild.test.ts` (7). Red controls: 10 mutations each turn a named test red (a `window.prompt` call back in, the menu that returns nothing,
the blank-name fallback, the submit button, asking for an ended worker, the red variant, the declined dialog in Clear all done / plan reset / import, the inline
preset field). Real Electron: `check-ui` PASS -- New folder (Escape, typed, blank), Rename, Delete with Cancel then confirm and the project kept, Save as preset
(Escape, Enter), Import (Cancel keeps, confirm replaces). Screenshots of the popover, the rename field, the delete dialog and the preset field were looked at.

## Looked at and left

- The 29 Settings sections at 1200x900: nothing overlapping or empty-lined that the examples describe; not changed.
- The Timers "Random sound pool" is a different design (each row has its own picker and time window; "Add sound" adds an editable row). It is a table of rows, not the
  "add whatever the dropdown points at" button that T-127 removed, so it stays.
- A "New folder" button only shows once a project is open (it sits in the Projects header); with no project the sidebar says "No open projects" -- by design.
- Not run: the plan-reset and Clear-all-done dialogs and the worker close in the real app (each needs state a throw-away profile does not have: a Coding Plan, finished
  helper sessions, a running terminal). Their asking order and the declined path are pinned by tests instead; the dialog itself is the same one Delete folder shows.
