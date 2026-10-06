import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  zaicodeAnchorBox,
  zaicodeTooltipCornerPlacement,
  ZAICODE_TOOLTIP_GAP,
  ZAICODE_TOOLTIP_MARGIN,
  type ZaicodeTooltipAnchor,
} from "@zcode/shared";

/**
 * SRC-161:REQ-003 -- "tooltips can render in the upper-left corner".
 *
 * Every hand-rolled surface that positioned itself against a measured rect did
 * it with the same expression: `Math.max(8, Math.min(...))`. With no anchor box
 * that clamp collapses to the 8px margin and the card draws in the corner. The
 * fix is one gate in @zcode/shared, and the interesting assertion is geometric:
 * the old expression produces a corner coordinate for exactly the inputs the
 * new one refuses.
 */

const VIEWPORT = { width: 1600, height: 900 };

function box(left: number, top: number, width = 24, height = 24): ZaicodeTooltipAnchor {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

const ui = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (relative: string) => readFileSync(join(ui, relative), "utf8");

test("SRC-161:REQ-003: 没有盒子的锚点被拒绝，真实盒子原样通过", () => {
  assert.equal(zaicodeAnchorBox(null), null);
  assert.equal(zaicodeAnchorBox(undefined), null);
  // 未布局的 DOMRect：这正是"左上角"的来源。
  assert.equal(zaicodeAnchorBox(box(0, 0, 0, 0)), null);
  // 一个轴为零同样是坏盒子——它只能定位到一个角。
  assert.equal(zaicodeAnchorBox(box(400, 300, 0, 24)), null);
  assert.equal(zaicodeAnchorBox(box(400, 300, 24, 0)), null);
  assert.equal(zaicodeAnchorBox({ ...box(10, 10), left: Number.NaN }), null);
  assert.equal(zaicodeAnchorBox({ ...box(10, 10), bottom: Number.POSITIVE_INFINITY }), null);
  const real = box(400, 300);
  assert.equal(zaicodeAnchorBox(real), real, "好盒子按引用返回，不复制也不改动");
});

test("SRC-161:REQ-003: 红对照——旧的角标夹取把零盒子画到 8px 边距上", () => {
  const PANEL_WIDTH = 360;
  const oldLeftFor = (anchor: ZaicodeTooltipAnchor) =>
    Math.max(8, Math.min(anchor.right - PANEL_WIDTH, VIEWPORT.width - PANEL_WIDTH - 8));
  const oldTopFor = (anchor: ZaicodeTooltipAnchor) =>
    Math.min(anchor.bottom + 6, VIEWPORT.height - 96);

  const zero = box(0, 0, 0, 0);
  assert.equal(oldLeftFor(zero), 8, "旧表达式对零盒子返回左边距");
  assert.equal(oldTopFor(zero), 6, "旧表达式对零盒子返回上边距");
  assert.equal(zaicodeTooltipCornerPlacement(zero, { width: PANEL_WIDTH, height: 0 }, VIEWPORT), null);
});

test("SRC-161:REQ-003: 角标面板贴住触发的右下角并留在视口内", () => {
  const anchor = box(900, 40); // right = 924, bottom = 64
  const placement = zaicodeTooltipCornerPlacement(anchor, { width: 360, height: 0 }, VIEWPORT, "end")!;
  assert.equal(placement.left, 924 - 360, "右边缘对齐触发器的右边缘");
  assert.equal(placement.top, 64 + ZAICODE_TOOLTIP_GAP, "落在触发器下方一个间距");
  assert.equal(placement.side, "bottom");
  // 高度按落地一侧的余量封顶，绝不会长过窗口。
  assert.equal(placement.maxHeight, VIEWPORT.height - 64 - ZAICODE_TOOLTIP_MARGIN - ZAICODE_TOOLTIP_GAP);
  assert.ok(placement.top + placement.maxHeight <= VIEWPORT.height - ZAICODE_TOOLTIP_MARGIN);
});

test("SRC-161:REQ-003: 贴着右/下边缘时夹取与翻面而不是溢出", () => {
  // 右上角：面板要向左缩进到安全边距。
  const nearRight = zaicodeTooltipCornerPlacement(box(1584, 20), { width: 360, height: 0 }, VIEWPORT, "end")!;
  assert.equal(nearRight.left, VIEWPORT.width - 360 - ZAICODE_TOOLTIP_MARGIN);
  assert.ok(nearRight.left + 360 <= VIEWPORT.width - ZAICODE_TOOLTIP_MARGIN);

  // 左下角：下方没有余量，面板翻到触发器上方，并贴住触发器上边缘。
  const lowAnchor = box(400, VIEWPORT.height - 30);
  const nearBottom = zaicodeTooltipCornerPlacement(lowAnchor, { width: 360, height: 0 }, VIEWPORT, "end")!;
  assert.equal(nearBottom.side, "top");
  assert.equal(nearBottom.maxHeight, lowAnchor.top - ZAICODE_TOOLTIP_MARGIN - ZAICODE_TOOLTIP_GAP);
  assert.equal(nearBottom.top + nearBottom.maxHeight, lowAnchor.top - ZAICODE_TOOLTIP_GAP, "卡片的下边缘贴在触发器上方");
  assert.ok(nearBottom.top >= ZAICODE_TOOLTIP_MARGIN, "上边缘不会跑到边距之外");

  // 视口本身没有尺寸时不画。
  assert.equal(zaicodeTooltipCornerPlacement(box(400, 300), { width: 360, height: 0 }, { width: 0, height: 0 }), null);
});

test("SRC-161:REQ-003: 每个手写定位面都走同一个门禁", () => {
  // 共用的纯函数就是那个门禁。
  assert.ok(zaicodeAnchorBox(box(1, 1, 1, 1)), "一个 1x1 的盒子仍然可定位");

  const card = read("zaicode/ZaicodeAnchoredCard.tsx");
  assert.ok(card.includes("zaicodeAnchorBox"), "提示卡使用共用的锚点门禁");
  assert.ok(card.includes("if (!placement"), "放置结果为空时提示卡什么也不画");
  assert.ok(card.includes("anchorEl"), "提示卡可以重新测量仍挂载的触发器");

  const reader = read("zaicode/ZaicodeSaimailReaderPopover.tsx");
  assert.ok(reader.includes("zaicodeTooltipCornerPlacement"), "信件阅读面板使用共用的角标定位");
  assert.equal(reader.includes("Math.max(8, Math.min("), false, "手写的角标夹取已删除");
  assert.ok(reader.includes("if (!placement) return null;"), "没有盒子就没有面板");

  const tour = read("zaicode/ZaicodeTour.tsx");
  assert.ok(tour.includes("zaicodeAnchorBox(findTarget("), "导览把零盒子的目标当作没有目标");
  assert.equal(tour.includes("Math.max(8,"), false, "导览不再自带 8px 魔法边距");

  // 每一个 ZaicodeAnchoredCard 调用点都把触发器元素一起传下去。
  for (const [file, count] of [
    ["zaicode/ZaicodeLimitMeter.tsx", 1],
    ["zaicode/ZaicodeSaimailHeaderButton.tsx", 2],
    ["v4/ZaicodeTodoGauge.tsx", 1],
  ] as const) {
    const source = read(file);
    assert.equal(
      (source.match(/anchorEl=/g) ?? []).length,
      count,
      `${file} 传出触发器元素`,
    );
  }
});
