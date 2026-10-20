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
import { zaicodeAnchoredCardFrame } from "../src/zaicode/zaicodeAnchoredCardFrame.js";

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

test("REQ-007: 先量后定位——未测量时隐藏且不设上限，测量后按可用高度封顶并内部滚动", () => {
  const card = src("zaicode/ZaicodeAnchoredCard.tsx");
  // 内部滚动兜底：内容高于所在一侧的可用高度时由卡片自己滚。
  assert.ok(card.includes("overflow-y-auto"), "超出可用高度时面板内部滚动");
  assert.ok(card.includes("frame.maxHeight"), "高度上限来自共享放置规则");
  assert.ok(card.includes("frame.visibility"), "未测量的隐藏状态也走同一处");

  // 仪表在标题栏里，面板向下开：可用高度是它下方到视口底部的空间。
  const low = zaicodeTooltipPlacement(
    anchorAt(600, 8, 24, 24),
    { width: METER_CARD_WIDTH, height: 0 },
    { width: 1600, height: 900 },
    "bottom",
  )!;
  assert.equal(low.maxHeight, 900 - 32 - ZAICODE_TOOLTIP_MARGIN - ZAICODE_TOOLTIP_GAP);
  assert.ok(low.top + low.maxHeight <= 900, "面板永远不会越过视口底部");

  // 初始未测量：卡片在文档里（才能被量到）但隐藏，且没有高度上限。
  const unmeasured = zaicodeAnchoredCardFrame(null, low);
  assert.equal(unmeasured.visibility, "hidden", "首次测量前隐藏");
  assert.equal(unmeasured.maxHeight, undefined, "首次测量前不设上限");

  // 首次渲染测量：placement 提供视口约束后的上限。
  const measured = zaicodeAnchoredCardFrame(4000, low);
  assert.equal(measured.visibility, undefined, "测量后可见");
  assert.equal(measured.maxHeight, Math.floor(low.maxHeight), "上限就是这一侧的可用高度");

  // 内容高于可用高度：上限小于真实内容 → 内部滚动；放置规则也声明 scroll。
  const clipped = zaicodeTooltipPlacement(
    anchorAt(600, 8, 24, 24),
    { width: METER_CARD_WIDTH, height: 4000 },
    { width: 1600, height: 900 },
    "bottom",
  )!;
  assert.equal(clipped.scroll, true, "内容比可用高度高 → 内部滚动");
  assert.ok(measured.maxHeight! < 4000, "上限小于真实内容高度");

  // 内容高度变化（ResizeObserver 更新）只换 placement 的输入，封顶规则不变。
  assert.equal(zaicodeAnchoredCardFrame(120, low).maxHeight, measured.maxHeight);

  // 视口变矮 → 可用高度变小，测量后的上限跟着变小。
  const shortViewport = zaicodeTooltipPlacement(
    anchorAt(600, 8, 24, 24),
    { width: METER_CARD_WIDTH, height: 0 },
    { width: 1600, height: 500 },
    "bottom",
  )!;
  assert.ok(shortViewport.maxHeight < low.maxHeight, "视口变矮 → 可用高度变小");
  assert.equal(
    zaicodeAnchoredCardFrame(4000, shortViewport).maxHeight,
    Math.floor(shortViewport.maxHeight),
  );

  // 首选侧与翻面：下方放不下时翻到触发器上方，并封顶在上方的余量内。
  const flipAnchor = anchorAt(600, 860, 24, 24);
  const flipped = zaicodeTooltipPlacement(
    flipAnchor,
    { width: METER_CARD_WIDTH, height: 300 },
    { width: 1600, height: 900 },
    "bottom",
  )!;
  assert.equal(flipped.side, "top", "下方放不下时翻到触发器上方");
  assert.ok(flipped.top + flipped.maxHeight <= flipAnchor.top, "翻转后的卡片不会压住触发器");

  // ResizeObserver 接线与清理：跟踪真实内容高度，卸载时断开。
  assert.ok(card.includes("new ResizeObserver"), "用 ResizeObserver 跟踪真实内容高度");
  assert.ok(card.includes("observer.observe(card)"), "观察卡片本身");
  assert.ok(card.includes("observer.disconnect()"), "卸载时断开观察器");
});
