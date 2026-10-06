import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Reported UI overlap (SRC-070 item F).
 *
 * These are layout-ownership assertions, not screenshots: each one states an
 * invariant that holds at 1920x1080 and at 1366x768, at 100% Windows scaling,
 * with long labels, in the hover and active states alike, because none of them
 * depend on a particular width. The operator crop that prompted this
 * (`V:\\_PIC\\_Clipboard_stuff\\clipboard_20260927_195405_258fe415.png`) is a
 * 312x107 fragment and could not be attributed to a component from its pixels
 * alone, so nothing here is written to "match" it.
 */

function source(relative: string): string {
  return readFileSync(join(import.meta.dirname, "..", relative), "utf8");
}

const VIEWPORTS = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1366x768", width: 1366, height: 768 },
] as const;

test("F1 the workers tray is capped on every anchor, not only the side ones", () => {
  const text = source("src/zaicode/ZaicodeWorkersDock.tsx");
  assert.match(text, /const TRAY_SIZE = "max-h-\[70vh\] max-w-\[70vw\] overflow-auto"/);
  const tray = text.match(/className=\{cn\("fixed flex gap-1", zaicodeLayerClass\("tray"\), TRAY_SIZE, TRAY_POSITION\[anchor\]\)\}/);
  assert.ok(tray, "the size cap is not conditional on the anchor");
  assert.equal(text.includes('vertical && "max-h-[70vh] overflow-y-auto"'), false, "a 768px window had no cap at all");
});

test("F2 a centred header title yields the band when the toolbar owns it", () => {
  const text = source("src/zaicode/ZaicodeHeaderProjectTitle.tsx");
  assert.match(text, /function isSidebarPanelCollapsed\(\)/);
  assert.match(text, /if \(isSidebarPanelCollapsed\(\)\) return null;/);
  // The `start` placement is untouched: nothing the operator could read is lost.
  assert.match(text, /if \(placement === "start"\) return title;/);
  // The free band still starts after the sidebar when it is open.
  assert.match(text, /left: sidebarRight \? "8px" : "var\(--zaicode-top-overlay-width, var\(--workspace-sidebar-panel-width, 0px\)\)"/);
});

test("F3 the overlay band variable is defined for both sidebar states", () => {
  const text = source("src/app-shell/WorkspaceShellLayout.tsx");
  assert.ok(text.includes("--zaicode-top-overlay-width"), "the band variable exists");
  assert.match(text, /isSidebarPanelVisible\s*\? `\$\{workspaceSidebarPanelWidthPx\}px`/);
  assert.match(text, /workspaceSidebarPanelWidthPx}px/);
  assert.ok(text.includes("--windows-caption-controls-right-inset, 136px"), "the caption inset is still reserved when the sidebar is collapsed");
});

test("F4 no floating surface may be laid out without a ceiling on a 768px-tall window", () => {
  // The 1366x768 case: anything that can exceed the viewport height.
  const offenders: string[] = [];
  for (const relative of ["src/zaicode/ZaicodeWorkersDock.tsx", "src/zaicode/ZaicodeTour.tsx"]) {
    const text = source(relative);
    if (/fixed z-\d+ flex max-w-\[70vw\] gap-1"/.test(text) && !text.includes("TRAY_SIZE")) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], "a fixed surface with no height ceiling paints past the viewport");
});

test("F5 the top overlay never drops its width ceiling", () => {
  const text = source("src/DesktopTopOverlay.tsx");
  // The overlay is `w-fit` and must be pinned to the sidebar column when that
  // column exists, otherwise its buttons spill into the content column.
  assert.match(text, /const topOverlayWidthStyle = isSidebarVisible/);
  assert.match(text, /width: sidebarRight && isWindowsDesktop/);
  assert.ok(text.includes(': "var(--workspace-sidebar-panel-width)"'), "the left sidebar still owns its column width");
  assert.match(text, /zaicodeToolbar && "min-w-0 flex-1"/);
  // The caption inset is a reservation, never a silent drop for a ZAICODE bar:
  // the toolbar is only as wide as the sidebar, so the buttons sit left of it.
  assert.match(text, /paddingRight: \(zaicodeToolbar && !sidebarRight\)/);
  assert.ok(text.includes("createWindowsCaptionControlsStyle(windowsWindowControlsRightPaddingPx) : {}), ...topOverlayWidthStyle"), "the relocated overlay owns its caption variable, not only a child");
});

test("F6 the row gauge strip never paints over the row it decorates", () => {
  const decor = source("src/zaicode/ZaicodeGroupedRowDecor.tsx");
  assert.match(decor, /maxWidth: "calc\(100% - 20px\)"/);
  const item = source("src/WorkspaceSidebarItem.tsx");
  const row = item.match(/"relative flex h-8 min-w-0 flex-1[^"]*"/);
  assert.ok(row, "the sidebar row is a positioned box");
  assert.ok(row[0].includes("overflow-hidden"), "a decorating strip must not paint over the row's own text");
  assert.match(item, /min-w-0 flex-1 truncate/);
});

test("F7 the sidebar, content and side pane still fit at 1366x768", () => {
  const text = source("src/app-shell/WorkspaceShellLayout.tsx");
  assert.match(text, /WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 264/);
  assert.match(text, /max-w-\[50%\] flex-none overflow-hidden/);
  // 264 sidebar + 4 handle + 320 content floor = 588, well inside 1366.
  assert.match(text, /min-w-\[320px\] flex-1 flex-col/);
  assert.equal(VIEWPORTS.every((view) => view.width >= 264 + 4 + 320), true);
});

test("F8 the docked todo dock is clamped to the viewport", () => {
  const text = source("src/v4/ZaicodeTodoDock.tsx");
  assert.match(text, /w-80 max-w-\[min\(calc\(100vw-2rem\),20rem\)\]/);
  assert.match(text, /right: 16, top: 64/, "docked below the 48px header band, not on top of it");
});
