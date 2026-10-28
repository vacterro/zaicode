import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  zaicodeTooltipPlacement,
  zaicodeTooltipPixel,
  ZAICODE_TOOLTIP_GAP,
  ZAICODE_TOOLTIP_MARGIN,
  type ZaicodeTooltipAnchor,
} from "@zcode/shared";

/**
 * SRC-151:R010 + R012 -- hover cards that spawn in the top-left corner, and
 * giant ones. Both were the same missing rule: an inline clamp against a
 * hardcoded pixel width, on one axis only, with no anchor validation.
 */

const VIEWPORT = { width: 1600, height: 900 };

function anchorAt(left: number, top: number, width = 24, height = 24): ZaicodeTooltipAnchor {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

test("R010: 没有盒子的锚点不产生提示框，而不是画在左上角", () => {
  // 完全空的 DOMRect（未布局/隐藏的触发器）就是那个"左上角"的来源。
  assert.equal(zaicodeTooltipPlacement(anchorAt(0, 0, 0, 0), { width: 320, height: 200 }, VIEWPORT), null);
  assert.equal(
    zaicodeTooltipPlacement({ left: Number.NaN, top: 0, right: 0, bottom: 0, width: 10, height: 10 }, { width: 320, height: 200 }, VIEWPORT),
    null,
  );
  // 视口也没有尺寸时不画。
  assert.equal(zaicodeTooltipPlacement(anchorAt(100, 100), { width: 320, height: 200 }, { width: 0, height: 0 }), null);
});

test("R010: 居中对齐且始终留在视口内", () => {
  const middle = zaicodeTooltipPlacement(anchorAt(800, 400), { width: 320, height: 100 }, VIEWPORT)!;
  assert.equal(middle.left, 800 + 24 / 2 - 320 / 2, "卡片以触发器为中心");
  assert.equal(middle.side, "top");
  assert.equal(middle.top, 400 - ZAICODE_TOOLTIP_GAP - 100);

  // 紧贴右边缘：不会跑出窗口。
  const right = zaicodeTooltipPlacement(anchorAt(1590, 400), { width: 320, height: 100 }, VIEWPORT)!;
  assert.ok(right.left + 320 <= VIEWPORT.width - ZAICODE_TOOLTIP_MARGIN, "右边不越界");
  assert.equal(right.left, VIEWPORT.width - 320 - ZAICODE_TOOLTIP_MARGIN);

  // 紧贴左边缘。
  const left = zaicodeTooltipPlacement(anchorAt(0, 400), { width: 320, height: 100 }, VIEWPORT)!;
  assert.equal(left.left, ZAICODE_TOOLTIP_MARGIN);
});

test("R010: 首选方向放不下时翻到另一侧", () => {
  const top = zaicodeTooltipPlacement(anchorAt(800, 20), { width: 320, height: 300 }, VIEWPORT, "top");
  assert.equal(top!.side, "bottom");
  assert.equal(top!.top, 44 + ZAICODE_TOOLTIP_GAP, "落在锚点下方而不是被挤到视口外");

  const bottom = zaicodeTooltipPlacement(anchorAt(800, 880), { width: 320, height: 300 }, VIEWPORT, "bottom");
  assert.equal(bottom!.side, "top");
});

test("R012: 卡片高度永远不超过所在侧的可用空间", () => {
  // 一条很长的 todo 文本：卡片比两侧都高，必须留在首选侧并自己滚动。
  const tall = zaicodeTooltipPlacement(anchorAt(800, 450), { width: 320, height: 5000 }, VIEWPORT, "top")!;
  assert.ok(tall.maxHeight <= VIEWPORT.height, `高度必须被视口限制，实际 ${tall.maxHeight}`);
  assert.equal(tall.scroll, true);
  assert.equal(tall.top, ZAICODE_TOOLTIP_MARGIN, "贴住视口顶部而不是跑到屏幕外");

  // 邮箱预览：锚点在标题栏，上方没有空间，于是向下并被限制。
  const preview = zaicodeTooltipPlacement(anchorAt(1500, 8, 28, 28), { width: 320, height: 0 }, VIEWPORT, "bottom")!;
  assert.ok(preview.maxHeight <= VIEWPORT.height - 8 - 28 - ZAICODE_TOOLTIP_MARGIN - ZAICODE_TOOLTIP_GAP);
  assert.ok(preview.top >= 0 && preview.top + preview.maxHeight <= VIEWPORT.height);
});

test("R012: 小窗口里宽度也被夹住，卡片不会比窗口还宽", () => {
  const tiny = zaicodeTooltipPlacement(anchorAt(5, 5), { width: 320, height: 60 }, { width: 300, height: 200 }, "bottom")!;
  assert.equal(tiny.left, ZAICODE_TOOLTIP_MARGIN, "贴住左边距");
  assert.ok(tiny.maxHeight <= 200 - (5 + 24) - ZAICODE_TOOLTIP_MARGIN - ZAICODE_TOOLTIP_GAP);
  assert.ok(tiny.top + tiny.maxHeight <= 200, "纵向仍然在窗口内");
});

test("像素字体对齐整设备像素（SRC-048）", () => {
  assert.equal(zaicodeTooltipPixel(10.5, 2), 10.5);
  assert.equal(zaicodeTooltipPixel(10.4, 2), 10.5);
  assert.equal(zaicodeTooltipPixel(10.5, 1), 11);
  assert.equal(zaicodeTooltipPixel(Number.NaN, 2), 0);
  assert.equal(zaicodeTooltipPixel(10.5, 0), 11);
});

const src = (relative: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", ...relative.split("/")), "utf8");

test("两个手写的 role=tooltip 卡片都已经走共享锚定组件", () => {
  const gauge = src("v4/ZaicodeTodoGauge.tsx");
  assert.ok(gauge.includes("<ZaicodeAnchoredCard"), "todo 提示框必须锚定");
  assert.equal(gauge.includes('role="tooltip"'), false, "不再自己画 role=tooltip");
  assert.equal(/Math\.max\(8,\s*Math\.min\(/.test(gauge), false, "旧的内联夹取已经不存在");

  const saimail = src("zaicode/ZaicodeSaimailHeaderButton.tsx");
  assert.ok(saimail.includes("<ZaicodeAnchoredCard"));
  assert.equal(saimail.includes('role="tooltip"'), false);
  assert.equal(saimail.includes("Math.max(8, Math.min("), false);
  assert.equal(saimail.includes("createPortal"), false, "锚定组件负责 portal");

  const card = src("zaicode/ZaicodeAnchoredCard.tsx");
  assert.ok(card.includes("zaicodeTooltipPlacement("), "组件复用共享的放置规则");
  assert.ok(card.includes("maxHeight"), "高度上限是卡片的一部分");
});