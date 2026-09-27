import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// SRC-058 polish pass. Two defects the packaged smoke could not see, because
// each hides in a branch the smoke never exercised: a named container that was
// never declared, and a sound cue that was always suppressed on the path an
// operator actually clicks.
//
// Both are invariants ACROSS two files -- the failure is precisely that the two
// sides disagree -- so they are asserted on the source, not on a mounted tree.

const srcRoot = join(import.meta.dirname, "..", "src");
const read = (relative: string): string => readFileSync(join(srcRoot, relative), "utf8");

test("the sidebar panel declares the container the action strip queries", () => {
  // A named container query only matches an ancestor that declares that name.
  // Undeclared, the rule is dead and the strip keeps its stacked fallback at
  // every sidebar width, which is what the operator reported.
  const shell = read("app-shell/WorkspaceShellLayout.tsx");
  const at = shell.indexOf('data-workspace-sidebar-panel="true"');
  assert.notEqual(at, -1, "the sidebar panel element is still present");
  const panel = shell.slice(at, shell.indexOf(">", at));
  assert.match(panel, /@container\/workspace-sidebar\b/, "the queried ancestor must declare the name");

  const strip = read("zaicode/ZaicodeSessionActionStrip.tsx");
  assert.match(strip, /@min-\[360px\]\/workspace-sidebar:grid-cols-\[minmax\(0,1fr\)_auto_auto\]/);
  assert.match(strip, /@min-\[360px\]\/workspace-sidebar:col-span-1/);
});

test("the project row owns its sound cue, so the generic click cannot bury it", () => {
  // App.tsx sends sidebar.project as an echo, and an echo arriving within
  // 700 ms of a direct sound is dropped. Clicking the row used to produce
  // exactly such a direct sound through the global ui.button listener, so the
  // project cue never played. Declaring the cue on the row plays it directly
  // and opts the row out of that listener.
  const item = read("WorkspaceSidebarItem.tsx");
  const trigger = item.indexOf("CollapsibleTrigger");
  const row = item.slice(trigger, item.indexOf("data-testid", trigger));
  assert.match(row, /data-zaicode-sound="sidebar\.project"/);

  const events = read("zaicode/zaicodeSoundEvents.ts");
  assert.ok(
    events.includes('closest("[data-zaicode-sound]'),
    "the generic listener honours the declarative opt-out",
  );
  assert.ok(events.includes('addEventListener("click"'), "the click listener is still wired");
  assert.ok(events.includes('playZaicodeSound("ui.button")'), "ui.button is still the generic button cue");
});
