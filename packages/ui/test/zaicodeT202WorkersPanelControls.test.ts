import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { zaicodeWorkerCloseRequest } from "../src/zaicode/zaicodeWorkerClose.js";
import type { ZaicodeWorker } from "../src/zaicode/zaicodeWorkers.js";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/zaicode/${name}`, import.meta.url)), "utf8");
const parts = read("ZaicodeWorkerParts.tsx");
const panel = read("ZaicodeWorkersPanel.tsx");
const sidebar = read("ZaicodeSidebarWorkers.tsx");

/** A handler that is written but does nothing is what SRC-136 looked like from the outside. */
const hasHandler = (jsx: string) => /onClick=\{\s*(?!undefined|null)[^}]/s.test(jsx);

/** The JSX of every <ZaicodeWorkerIconButton .../> in a source file, opening tag only. */
const iconButtons = (source: string) =>
  [...source.matchAll(/<ZaicodeWorkerIconButton\b([\s\S]*?)\/>/g)].map((m) => m[1]!);

/** The JSX of the icon buttons inside one named function. */
const iconButtonsIn = (source: string, name: string) => {
  const start = source.indexOf(`export function ${name}`);
  assert.notEqual(start, -1, `${name} is gone from this file`);
  const end = source.indexOf("\nexport function", start + 1);
  return iconButtons(source.slice(start, end === -1 ? undefined : end));
};

const worker = (over: Partial<ZaicodeWorker> = {}) =>
  ({ id: "w1", short: "PS", projectName: "zaicode", exitCode: null, minimized: false, placement: "panel", ...over }) as unknown as ZaicodeWorker;

test("every WORKERS-panel control carries a title and a handler", () => {
  // SRC-136 was "the buttons simply do nothing". A control without one of these two is inert by
  // construction, which is exactly what the operator reported and could not see.
  const inert = iconButtons(panel).filter((jsx) => !/title=/.test(jsx) || !hasHandler(jsx));
  assert.deepEqual(inert, [], "panel controls without a title or a handler");
  const inertRows = iconButtonsIn(parts, "ZaicodeWorkerHeaderButtons").filter(
    (jsx) => !/title=/.test(jsx) || !hasHandler(jsx),
  );
  assert.deepEqual(inertRows, [], "per-worker controls without a title or a handler");
});

test("the shared icon button cannot swallow its own click", () => {
  const start = parts.indexOf("export function ZaicodeWorkerIconButton");
  const next = parts.indexOf("\nexport function", start + 1);
  const body = parts.slice(start, next === -1 ? undefined : next);
  assert.match(body, /type="button"/);
  assert.match(body, /title=\{title\}/, "a control the operator cannot identify is a dead control");
  assert.match(body, /aria-label=\{title\}/);
  // Both the dock drag and the divider drag start on pointerdown, so the press has to be consumed
  // here or the panel moves under the click instead of the control answering.
  assert.match(body, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(body, /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*onClick\(\);/s);
});

test("the panel header row is never made unclickable", () => {
  const header = panel.slice(panel.indexOf('<span className="flex shrink-0 items-center">'));
  const row = header.slice(0, header.indexOf("\n        </span>"));
  assert.ok(row.length > 0, "the header control row is gone");
  assert.doesNotMatch(row, /pointer-events-none|invisible|opacity-0/);
  // The sidebar's per-row buttons are hover-revealed on purpose; the panel's header must not be.
  assert.doesNotMatch(panel, /className="[^"]*invisible[^"]*"[^>]*>\s*<ZaicodeWorkerHeaderButtons/);
  // T-277: revealed over the row's right end, so they never take the label's room.
  assert.match(sidebar, /invisible absolute inset-y-0 right-0 flex items-center[^"]*group-focus-within:visible group-hover:visible/);
});

test("stopping a running worker asks first; a finished one does not", () => {
  const request = zaicodeWorkerCloseRequest(worker(), true);
  assert.ok(request, "a running worker must be confirmed before it is killed");
  assert.match(request!.title, /PS/);
  assert.equal(request!.confirmVariant, "destructive");
  assert.equal(zaicodeWorkerCloseRequest(worker({ exitCode: 0 }), true), null);
  assert.equal(zaicodeWorkerCloseRequest(worker(), false), null);
});