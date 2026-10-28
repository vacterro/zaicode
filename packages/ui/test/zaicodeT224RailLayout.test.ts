/**
 * T-224 / SRC-154:R001 — the vertical sidebar rail presents its controls from
 * one contract, not from per-button offsets.
 *
 * The compact project sidebar is a vertical rail. Its controls used to carry
 * hand-picked geometry each (h-8, h-10, h-7), and the MAIN marker sat at the
 * box corner where it could overlap the glyph. This file pins the replacement:
 * a pure axis/layout decision plus one control view, exercised across sidebar
 * widths, rail heights and both layout modes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";

import { TabStoreProvider } from "../src/store/TabStoreProvider.js";
import { ZaicodeProjectRail } from "../src/zaicode/ZaicodeProjectRail.js";
import { ZaicodeRailControl } from "../src/zaicode/ZaicodeRailControl.js";
import {
  zaicodeRailControlLayout,
  zaicodeRailFit,
  zaicodeRailOverflows,
  zaicodeRailStackHeightPx,
  zaicodeSidebarAxisFor,
  ZAICODE_RAIL_MIN_HIT_PX,
} from "../src/zaicode/zaicodeRailLayout.js";
import { ZAICODE_SIDEBAR_RAIL_WIDTH } from "../src/zaicode/zaicodeSidebarWidth.js";

const src = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

test("R001: the axis follows the live width — rail at or under 52px, rows above", () => {
  assert.equal(zaicodeSidebarAxisFor(40), "vertical");
  assert.equal(zaicodeSidebarAxisFor(ZAICODE_SIDEBAR_RAIL_WIDTH), "vertical");
  assert.equal(zaicodeSidebarAxisFor(ZAICODE_SIDEBAR_RAIL_WIDTH + 1), "horizontal");
  assert.equal(zaicodeSidebarAxisFor(160), "horizontal");
  assert.equal(zaicodeSidebarAxisFor(200), "horizontal");
  assert.equal(zaicodeSidebarAxisFor(400), "horizontal");
  assert.equal(zaicodeSidebarAxisFor(Number.NaN), "horizontal", "an unmeasurable panel is the full sidebar, never a squeezed rail");
});

test("R001: both modes share one family — same icon, gap and corners", () => {
  const vertical = zaicodeRailControlLayout("vertical");
  const horizontal = zaicodeRailControlLayout("horizontal");
  assert.equal(vertical.iconSizePx, horizontal.iconSizePx);
  assert.equal(vertical.gapPx, horizontal.gapPx);
  assert.equal(vertical.radiusPx, horizontal.radiusPx);
  assert.equal(vertical.labelPlacement, "hidden", "the rail is icon-only");
  assert.equal(horizontal.labelPlacement, "beside", "the full sidebar keeps its labels");
  assert.ok(vertical.hitSizePx >= ZAICODE_RAIL_MIN_HIT_PX, "the rail box stays clickable");
  assert.ok(horizontal.hitSizePx >= ZAICODE_RAIL_MIN_HIT_PX, "the row stays clickable");
});

test("R001: the stack scrolls instead of squeezing hit targets", () => {
  assert.equal(zaicodeRailOverflows(800, 3), false, "a short list fits");
  assert.equal(zaicodeRailOverflows(200, 12), true, "a long list in a short window scrolls");
  assert.equal(zaicodeRailOverflows(200, 0), false);
  // 3 controls at 32px + 2 gaps + padding = 116px.
  assert.equal(zaicodeRailStackHeightPx(3, "vertical"), 8 + 3 * 32 + 2 * 4);
  const fit = zaicodeRailFit(200, 12, 2);
  assert.equal(fit.scrolls, true);
  assert.ok(fit.visible >= 2, "the pinned entries stay reachable");
  assert.ok(fit.visible < 12, "the rest scrolls");
  const roomy = zaicodeRailFit(2000, 12, 2);
  assert.deepEqual(roomy, { visible: 12, scrolls: false });
});

const controlHtml = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(ZaicodeRailControl, {
      layout: zaicodeRailControlLayout("vertical"),
      label: "Project Alpha",
      tag: "Pro",
      icon: createElement("span", null, "i"),
      onActivate: () => {},
      ...over,
    }),
  );

test("R001: one control view — stable box, icon-only, name kept for ears and tooltips", () => {
  const html = controlHtml();
  assert.match(html, /height:32px/, "the box comes from the contract, not a class per button");
  assert.match(html, /aria-label="Project Alpha"/, "the accessible name is the full name");
  assert.match(html, /title="Project Alpha"/, "the tooltip is the full name");
  assert.ok(!html.includes(">Project Alpha<"), "the full name is never painted in the rail");
  assert.match(html, />Pro</, "the abbreviated tag is what the eye gets");
  assert.match(html, /data-zaicode-rail-axis="vertical"/);
});

test("R001: active, hover, focus and disabled read the same on every control", () => {
  const plain = controlHtml();
  assert.match(plain, /hover:bg-hover/, "hover is there when enabled");
  assert.match(plain, /focus-visible:ring-2/, "keyboard focus is visible");
  const active = controlHtml({ active: true });
  assert.match(active, /aria-current="page"/);
  assert.match(active, /bg-selected/);
  assert.match(active, /data-zaicode-rail-active="true"/);
  const disabled = controlHtml({ disabled: true });
  assert.match(disabled, /disabled=""/);
  assert.match(disabled, /cursor-not-allowed/);
  assert.match(disabled, /data-zaicode-rail-disabled="true"/);
  assert.ok(!disabled.includes("hover:bg-hover"), "a disabled control does not promise hover");
});

test("R001: markers live inside the box — no corner offsets to overlap the glyph", () => {
  const html = renderToStaticMarkup(
    createElement(ZaicodeRailControl, {
      layout: zaicodeRailControlLayout("vertical"),
      label: "Project Alpha",
      tag: "Pro",
      icon: createElement("span", null, "i"),
      leading: createElement("span", { "data-marker": "live" }),
      trailing: createElement("span", null, "◆"),
      onActivate: () => {},
    }),
  );
  assert.ok(!html.includes("right-0"), "no corner-pinned badge");
  assert.ok(!html.includes("top-0"), "no corner-pinned badge");
  assert.match(html, /data-marker="live"/, "the live marker still renders");
  assert.match(html, /◆/, "the MAIN marker still renders, inline beside the tag");
});

test("R001: the rail renders every control through the contract", () => {
  const html = renderToStaticMarkup(
    createElement(TabStoreProvider, null, createElement(ZaicodeProjectRail, { onHome: () => {}, onNew: () => {} })),
  );
  assert.match(html, /data-zaicode-project-rail/);
  assert.match(html, /data-zaicode-rail-axis="vertical"/);
  assert.match(html, /data-zaicode-rail-scroll/, "the project list scrolls instead of squeezing");
  for (const name of ["SAIHOME", "New session", "Settings"]) {
    assert.match(html, new RegExp(`aria-label="${name}"`), `${name} keeps its accessible name`);
  }
  // Button boxes lead with height in their style; the icon slots lead with width.
  const heights = [...html.matchAll(/<button[^>]*style="height:(\d+)px/g)].map((match) => match[1]);
  assert.ok(heights.every((height) => height === heights[0]), `one height for all controls: ${heights.join(",")}`);
  assert.ok(!html.includes("h-7") && !html.includes("h-8") && !html.includes("h-10"), "no per-button heights left");
});

test("R001: the rail source keeps no private geometry", () => {
  const rail = src("zaicode/ZaicodeProjectRail.tsx");
  assert.match(rail, /ZaicodeRailControl/, "every button goes through the contract");
  assert.doesNotMatch(rail, /h-7|h-8|h-10/, "no hand-picked heights");
  assert.doesNotMatch(rail, /right-0 top-0/, "no corner-pinned marker");
  assert.match(rail, /\.slice\(0, 3\)/, "the tag abbreviates; the name stays whole in the label");
  assert.match(rail, /aria-label="Compact projects"/, "the rail itself stays labelled");
});
