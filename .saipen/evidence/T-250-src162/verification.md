# T-250 / SRC-162 — verification record

SRC-162 repeats the SRC-161 list (screenshots dated 2026-10-06 11:12–11:26, taken on the build
staged at 10:58, before the SRC-161 wave was written) and adds two new items: Auto retry is
unpredictable, and a double-click on a sidebar edge resets its width. The SRC-161 tree was never
bundled or inspected, so this ticket re-checks every item against the current tree, repairs what
was still wrong, and ships a staged test build.

## Item by item

| # | Operator item | Finding on the current tree | Repair in this ticket |
|---|---|---|---|
| 1 | Auto retry works badly and unpredictably | The button flipped the bare *preference*, while the effective answer was also ANDed with the sidebar Auto master. With Auto OFF (the normal state) every click left the button "off". | `zaicodeRetryPolicy.ts`: one `block` per projection; an explicit project/session ON is its own answer (only the inherited global follows the master); `zaicodeAutoRetryToggle` flips the EFFECTIVE answer and lifts the stop-all / session Off that held it. Button and pane banner read the same `block`. |
| 2 | Double-click on a sidebar edge resets it to default | react-resizable-panels v4 `Separator` resets the neighbouring panel to `defaultSize` on dblclick. | `components/ui/resizable.tsx`: `ResizableHandle` defaults `disableDoubleClick` to true. The left sidebar handle is custom and has no dblclick handler. |
| 3 | Metrics: no duplicate Antigravity | Shared-account windows arrive as pool index + bare "weekly"/"5h", so two Antigravity pools read as duplicated rows. | `zaicodeWindowFromShared(input, vendor)` names the pool (`Gemini` / `Claude & GPT` for Antigravity's fixed order, `Pool N` otherwise). |
| 3b | (found) "last read failed: unsupported" on Claude/Codex | The plane cannot read Claude/Codex quota; merged rows never refreshed and showed stale numbers forever. | `zaicodeEngines.ts` probe: a shared row with its own local home falls back to the local probe when the plane answers `unsupported`. |
| 4 | Auto retry right button dead after choosing "open app" | SRC-161 kept the "Opens the app menu" mode behind a Shift+right-click hatch. In the packaged app buttons own no menu, so the mode is a dead right button. | Mode removed: `ZaicodePrefControls.tsx` always opens the panel; `rightClickOpensSettings` ignores an old stored OFF. |
| 5 | Tooltips in the top-left corner | SRC-161 fixed only the hand-rolled cards. The screenshot is a Radix `ControlHintTooltip` on a hover-only row action that goes `display:none` when the pointer leaves the row. | `ControlHintTooltip.tsx`: refuse to open on a trigger without a box, close via ResizeObserver when the trigger loses its box, `hideWhenDetached`. |
| 6 | Stability / responsiveness pass | UI zaicode suite green; 2026-10-06 log shows no RPC loop (top caller `file.readTextFile` at 0.5 ms, SAIPEN polling). | Items 1, 3b, 5, 8, 9 are the defects found. |
| 7 | CLEAR ALL DONE without confirmation | Already first-click in the SRC-161 tree (`ZaicodeClearAllDone.tsx`). | none |
| 8 | Reliable running indicators | The live-run hint's 60 s grace only expired when that project's index pushed again; a quiet project kept "working". | `WorkspaceSidebar.tsx` re-runs `reconcileZaicodeLiveRuns` every 15 s while any hint is held. |
| 9 | Limits card: duplicates and vertical voids | See 3 / 3b; spacing still loose. | `ZaicodeLimitViews.tsx`: 2 px section gaps, 1.2 line height, zero row gap in compact rows. |
| 10 | Composer `+` alone on a blank row | The trailing cluster was `shrink-0` and dropped to a new line whole, so `+` stayed alone above it. | `ChatPromptEditor.tsx`: trailing cluster is `flex-1 min-w-0` and wraps its own buttons; `useComposerToolbarFit.ts` treats an internal wrap as overflow so the compaction ladder still runs first. |
| 11 | Turn navigation overlap + user side | The SRC-161 strip is a real layout lane with user and assistant chips. | none (not driveable without a model; see boundary) |

## Tests

- New: `packages/ui/test/zaicodeSrc162RetryToggle.test.ts` (click-flip matrix over every gate,
  master/explicit rule, toggle patch, one-block banner, dblclick default, pool labels, tooltip
  anchor, live-run expiry, composer trailing cluster).
- Corrected because their premise changed: `zaicodeT217Continuity`, `zaicodeFreshReq001AutoRetry`,
  `zaicodeT201AutoRetryScope`, `zaicodeSrc161RetryReachability`, `zaicodeT220RightClickRule`,
  `zaicodeT224RetryRightClick`, `zaicodeT220SharedAccounts`, `zaicodeSrc161LimitsDensity`.

## Gates

Recorded by the checkpoint that cites this file; packaged results in `packaged/receipt.json`.
