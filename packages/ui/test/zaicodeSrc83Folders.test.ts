import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// SRC-083: "remove the text No folder, put the count next to the New folder button, make New
// folder an icon button that is still obvious; remove the empty space, be more compact".

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

test("New folder is an icon button that still reads as a button", () => {
  const parts = source("zaicode/ZaicodeProjectFolderParts.tsx");
  const button = /export function ZaicodeNewFolderButton[\s\S]*?\n}\n/.exec(parts)?.[0] ?? "";
  assert.ok(button.length > 0, "the button is still exported");
  assert.match(button, /<FolderPlus className="size-4" \/>/);
  assert.doesNotMatch(button, />\s*New folder\s*</, "no word in the button");
  assert.match(button, /aria-label="New folder"/, "the name lives in the label and the tooltip");
  assert.match(button, /border border-border/, "framed, so it is plainly a button");
  assert.match(button, /size-6/);
});

test("the sidebar drops the No folder row and shows its count beside the button, on one compact line", () => {
  const sidebar = source("WorkspaceSidebar.tsx");
  assert.match(sidebar, /organizationRow\?\.header && folderView && !folderView\.unfiled/, "the unfiled header row is not drawn");
  assert.match(sidebar, /data-zaicode-unfiled-count=\{zaicodeUnfiledCount\}/);
  const header = /data-zaicode-unfiled-count[\s\S]{0,400}<ZaicodeNewFolderButton \/>/.exec(sidebar);
  assert.ok(header, "the count sits right before the New folder button");
  assert.match(sidebar, /flex items-center gap-1 px-1 pb-0\.5/, "the Projects line lost its extra bottom padding");
  // A real folder still gets its header (name, count, collapse).
  assert.match(source("zaicode/ZaicodeProjectFolderParts.tsx"), /data-zaicode-folder-header=/);
});
