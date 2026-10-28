// T-225 / SRC-155 -- "Bevels on list rows" must visibly change the list rows.
//
// The report (screenshot 223645): toggling the sub-option shows no difference
// at all. Wiring is intact (toggle -> bevelRows -> `zaicode-bevel-rows` class
// on <html>), the ROWS selectors match rendered rows, and the palette carries
// bevel tokens -- so the toggle dies in the cascade: the presentation preset
// kill-rule (`box-shadow: none`, injected AFTER the bevel CSS in the same
// <style> element) ties the workspace-row bevel at (0,3,1) and wins by source
// order for every non-classic presentation, because the row is a
// `div[role="button"]`. The explicit rows toggle must outrank the preset.
//
// These tests compute real CSS specificity from the shipped selector strings:
// every bevel-row rule must beat the presentation kill-rule, and every covered
// row prefix must name a real test-id base (so a row rename like the R001 rail
// rewrite cannot silently uncover the rows again).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const src = (path: string) =>
  readFileSync(join(import.meta.dirname, "..", "src", path), "utf8");

const bevels = src("zaicode/zaicodeBevels.ts");
const presentation = src("zaicode/zaicodePresentation.ts");
const testIds = readFileSync(
  join(import.meta.dirname, "..", "..", "shared", "src", "test-ids.ts"),
  "utf8",
);

type Spec = [number, number, number];

function compareSpec(a: Spec, b: Spec): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** Simplified specificity for the shipped selectors (no nesting, no :has). */
function specificity(selector: string): Spec {
  let s = selector;
  // :is() takes its most specific argument; substitute the winner in place.
  s = s.replace(/:is\(([^()]*)\)/g, (_whole, args: string) => {
    const options = String(args)
      .split(",")
      .map((part) => ({ part: part.trim(), spec: specificity(part.trim()) }));
    options.sort((x, y) => compareSpec(x.spec, y.spec));
    return options[options.length - 1]!.part;
  });
  // :not() adds nothing itself; its argument counts normally.
  s = s.replace(/:not\(([^()]*)\)/g, "$1");
  // :where() and everything inside it counts for nothing.
  s = s.replace(/:where\(([^()]*)\)/g, "");
  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (s.match(/\.[\w-]+/g) ?? []).length;
  const attrs = (s.match(/\[[^\]]+\]/g) ?? []).length;
  const pseudoClasses = (s.match(/(?<!:):[\w-]+(\([^()]*\))?/g) ?? []).length;
  const pseudoElements = (s.match(/::[\w-]+/g) ?? []).length;
  const elements = s
    .split(/[\s>+~]+/)
    .filter((token) => /^[a-zA-Z][\w-]*/.test(token)).length;
  return [ids, classes + attrs + pseudoClasses, elements + pseudoElements];
}

function rowScope(): string {
  const match = /const ROWS = \[[\s\S]*?\]\.map\(\(selector\) => `([^`$]+)\$\{selector\}`\)/.exec(bevels);
  assert.ok(match, "ROWS scope prefix must exist");
  return match[1].trim();
}

function rowParts(name) {
  var re = name === 'ROWS'
    ? /const ROWS = \[([\s\S]*?)\]\.map/
    : /const ROWS_OPEN = \[([\s\S]*?)\]\.map/;
  var match = re.exec(bevels);
  assert.ok(match, name + ' array must exist');
  return Array.from(match[1].matchAll(/"([^"]+)"/g)).map(function(m) { return m[1]; });
}

function killSelector(): string {
  const match = /(html\[data-zaicode-style\][^{}]+)\{\s*\n?\s*box-shadow: none !important;/.exec(
    presentation,
  );
  assert.ok(match, "presentation kill-rule selector must exist");
  return match[1].trim();
}

test("T-225: every bevel-row rule outranks the presentation shadow kill-rule", () => {
  const scope = rowScope();
  const kill = killSelector();
  const killSpec = specificity(kill);
  const selected =
    /(html\.zaicode-bevels[^\n`]*data-zaicode-project-selected[^\n`]*)/.exec(bevels);
  assert.ok(selected, "selected-row sunken rule must exist");
  const full = [...rowParts("ROWS"), ...rowParts("ROWS_OPEN")].map((part) => `${scope} ${part}`);
  full.push(selected[1]);
  assert.ok(full.length >= 3, `expected row rules, got ${full.length}`);
  for (const selector of full) {
    const spec = specificity(selector);
    assert.ok(
      compareSpec(spec, killSpec) > 0,
      `"${selector}" (${spec}) must beat the kill-rule "${kill}" (${killSpec}) or toggling rows stays invisible`,
    );
  }
});

test("T-225: every covered row prefix names a real test-id base", () => {
  for (const prefix of ["workspace-item-", "task-item-"]) {
    assert.ok(
      bevels.includes(`[data-testid^="${prefix}"]`),
      `bevel CSS must still cover ${prefix} rows`,
    );
    const base = prefix.replace(/-$/, "");
    assert.ok(
      testIds.includes(`"${base}"`),
      `shared test-ids must define the "${base}" base or the selector matches nothing`,
    );
  }
});

test("T-226: the generic bevel rules leave the list rows to the rows sub-toggle", () => {
  // OFF must mean flat in every presentation. Before T-226 the generic
  // role=button raised rule matched the workspace row (div[role=button]) even
  // with the rows class absent, so under Classic the toggle changed nothing.
  assert.ok(
    bevels.includes(`'[role="button"]:not([data-testid^="workspace-item-"])'`),
    "generic raised rule must exclude workspace rows",
  );
  assert.ok(
    bevels.includes(`'[role="button"]:active:not([data-testid^="workspace-item-"])'`),
    "generic pressed rule must exclude workspace rows",
  );
  assert.ok(
    !bevels.includes(`'[role="button"]',`),
    "no bare role=button entry may match a workspace row",
  );
});
