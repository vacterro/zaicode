import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ZAICODE_LAYERS, zaicodeLayerClass } from "@zcode/shared";

// SRC-151:R009 「Кнопки могут налезать на друг друга」.
//
// 每个 position:fixed 且没有布局父元素的表面都是自己的孤岛：没有东西会重排它，
// 两个都挑同一个窗口角落的就会互相压住，谁都点不到。表里给每个孤岛一条命名带，
// 以后任何一处新的 fixed 表面都必须从表里取 z 值，而不是自己编一个数字。

const uiSrc = join(import.meta.dirname, "..", "src");
const read = (...parts: string[]) => readFileSync(join(uiSrc, ...parts), "utf8");

test("每个 fixed 孤岛一条命名带，且没有任何两条撞层", () => {
  const entries = Object.entries(ZAICODE_LAYERS);
  assert.ok(entries.length >= 6, "表必须覆盖 content/tray/gauge/dock/card/overlay");
  const values = entries.map(([, value]) => value);
  assert.equal(
    new Set(values).size,
    values.length,
    `层值必须唯一，实际有重复：${JSON.stringify(entries)}`,
  );
});

test("层序固定：托盘 < 任务列 < 停靠窗 < 悬停卡 < 调试浮层", () => {
  assert.ok(ZAICODE_LAYERS.content < ZAICODE_LAYERS.tray, "正文不得浮在托盘之上");
  assert.ok(ZAICODE_LAYERS.tray < ZAICODE_LAYERS.gauge, "托盘与任务列曾同处 z-40");
  assert.ok(ZAICODE_LAYERS.gauge < ZAICODE_LAYERS.dock, "可拖动停靠窗必须压住任务列");
  assert.ok(ZAICODE_LAYERS.dock < ZAICODE_LAYERS.card, "悬停卡必须盖住它描述的对象");
  assert.ok(ZAICODE_LAYERS.card < ZAICODE_LAYERS.overlay, "调试浮层永远在最上");
});

test("zaicodeLayerClass 返回该层自己的 z 类，不共用数字", () => {
  assert.equal(zaicodeLayerClass("tray"), "z-[30]");
  assert.equal(zaicodeLayerClass("gauge"), "z-[35]");
  assert.equal(zaicodeLayerClass("dock"), "z-[90]");
  assert.equal(zaicodeLayerClass("overlay"), "z-[210]");
  const tray = zaicodeLayerClass("tray");
  const gauge = zaicodeLayerClass("gauge");
  assert.notEqual(tray, gauge, "托盘与任务列不能回到同一个 z 值——那就是 R009");
});

test("四个 fixed 孤岛都从表里取层，不再硬编码 z 值", () => {
  const sites: Array<[string, string]> = [
    [join("zaicode", "ZaicodeWorkersDock.tsx"), "tray"],
    [join("v4", "ZaicodeTodoGauge.tsx"), "gauge"],
    [join("v4", "ZaicodeTodoDock.tsx"), "dock"],
    [join("zaicode", "ZaicodeFancyZoneOverlay.tsx"), "overlay"],
  ];
  for (const [file, layer] of sites) {
    const source = read(...file.split("/"));
    assert.ok(
      source.includes(`zaicodeLayerClass("${layer}")`),
      `${file} 必须用 zaicodeLayerClass("${layer}")`,
    );
    assert.ok(
      !/fixed[^"`\n]*z-(\[)?\d/.test(source),
      `${file} 不得再硬编码 z 值`,
    );
  }
});

test("悬停卡走 card 带，两处都不再写 z-[200]", () => {
  for (const file of [
    join("zaicode", "ZaicodeAnchoredCard.tsx"),
    join("zaicode", "ZaicodeLimitMeter.tsx"),
  ]) {
    const source = read(...file.split("/"));
    assert.ok(!source.includes("z-[200]"), `${file} 不得硬编码 z-[200]`);
  }
  assert.equal(ZAICODE_LAYERS.card, 200, "card 带就是悬停卡的那一层");
});

test("限制仪表的卡片已改走 ZaicodeAnchoredCard，旧的贴角定位已消失", () => {
  const source = read("zaicode", "ZaicodeLimitMeter.tsx");
  assert.ok(source.includes("<ZaicodeAnchoredCard"), "仪表卡必须走共享规则");
  assert.ok(!source.includes("createPortal"), "仪表卡不再自己开 portal");
  assert.ok(
    !source.includes("Math.max(8, Math.min("),
    "旧的单轴夹取就是 R010 的贴角根因",
  );
  assert.ok(!source.includes("zaicodeDevicePx"), "像素换算已由共享规则接管");
});
