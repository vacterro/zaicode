import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ZAICODE_TOOLTIP_GAP,
  ZAICODE_TOOLTIP_MARGIN,
  zaicodeTooltipPlacement,
  type ZaicodeTooltipAnchor,
} from "@zcode/shared";

/**
 * SRC-161:REQ-007 -- the "AI Usage Limits" view wasted vertical space and could
 * grow past the window. The card already caps height and scrolls; what this
 * covers is that the panel is honestly dense, that it follows the card's real
 * width instead of asserting its own, and that the card's rendered width is the
 * same clamped number its `left` was computed from.
 */

const src = (relative: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", ...relative.split("/")), "utf8");

const METER_CARD_WIDTH = 436;
const NARROW = { width: 380, height: 720 };
const anchorAt = (left: number, top: number, width = 24, height = 24): ZaicodeTooltipAnchor => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

test("REQ-007: 436px 的卡片在 380px 窗口里被夹到视口宽度，left 与渲染宽度用同一个数", () => {
  const placement = zaicodeTooltipPlacement(anchorAt(370, 8, 24, 24), { width: METER_CARD_WIDTH, height: 0 }, NARROW, "bottom");
  assert.ok(placement, "锚点有盒子，卡片必须出现");
  const rendered = Math.min(METER_CARD_WIDTH, NARROW.width - ZAICODE_TOOLTIP_MARGIN * 2);
  assert.equal(rendered, 364, "380 - 2*8");
  assert.ok(placement.left + rendered <= NARROW.width - ZAICODE_TOOLTIP_MARGIN, "夹取后的卡片不再越出右边界");
  assert.equal(placement.left, ZAICODE_TOOLTIP_MARGIN, "空间不足时贴住左边距");

  const card = src("zaicode/ZaicodeAnchoredCard.tsx");
  assert.ok(
    card.includes("Math.min(width, viewport.width - ZAICODE_TOOLTIP_MARGIN * 2)"),
    "卡片按同一个公式夹取自己实际渲染的宽度",
  );
  assert.ok(card.includes("width: renderedWidth"), "style 用的是夹取后的宽度");
});

test("REQ-007: 面板跟随卡片宽度并收紧纵向节奏", () => {
  const views = src("zaicode/ZaicodeLimitViews.tsx");
  assert.equal(views.includes("w-[420px]"), false, "不再自己钉死 420px —— 让卡片决定宽度");
  assert.ok(views.includes('data-zaicode-limits-panel'), "面板有稳定的数据标记");
  const panel = views.slice(views.indexOf("export function ZaicodeLimitsPanel"));
  assert.ok(panel.includes("w-full min-w-0 flex-col gap-0.5"), "占满卡片宽度、缩小段间距");
  assert.ok(panel.includes("leading-[1.2]"), "行高收紧，消除巨大空白条");
  assert.ok(panel.includes("border-t border-border/60 pt-0.5"), "段落内边距从 1.5 收到 1");
  assert.ok(panel.includes("compact"), "密集视图使用 compact 列宽");
  // 红控：旧写法（8px 段间距 + 固定宽度）确实不在文件里了。
  assert.equal(views.includes("flex w-[420px] flex-col gap-2 text-ui-xs"), false);
});

test("REQ-007: 高度仍然由卡片的视口上限 + 内部滚动兜底", () => {
  const card = src("zaicode/ZaicodeAnchoredCard.tsx");
  assert.ok(card.includes("maxHeight: Math.floor(placement.maxHeight)"), "高度上限来自共享放置规则");
  assert.ok(card.includes("overflow-y-auto"), "超出可用高度时面板内部滚动");
  // 仪表在标题栏里，面板向下开：可用高度必须正好是它下方到视口底部的空间。
  const low = zaicodeTooltipPlacement(anchorAt(600, 8, 24, 24), { width: METER_CARD_WIDTH, height: 0 }, { width: 1600, height: 900 }, "bottom")!;
  assert.equal(low.maxHeight, 900 - 32 - ZAICODE_TOOLTIP_MARGIN - ZAICODE_TOOLTIP_GAP);
  assert.ok(low.top + low.maxHeight <= 900, "面板永远不会越过视口底部");
});
