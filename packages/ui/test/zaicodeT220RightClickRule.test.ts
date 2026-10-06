import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeZaicodeUiPrefs, rightClickOpensSettings } from "@/zaicode/zaicodeUiPrefs.js";

/**
 * SRC-151:R011 -- "right-click a button, get the settings for that button",
 * as a RULE applied everywhere rather than a habit of a few buttons.
 */

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (relative: string) => readFileSync(join(uiSrc, ...relative.split("/")), "utf8");

test("R011: 没有写过偏好的安装，右键就是打开设置（默认即所求）", () => {
  const prefs = normalizeZaicodeUiPrefs(null);
  assert.deepEqual(prefs.rightClickSettings, {}, "没有默认值列表，只有显式关闭");
  for (const key of ["header", "meter", "saimail", "modelButtons", "actionView"] as const) {
    assert.equal(rightClickOpensSettings(prefs, key), true, `${key} 默认打开设置`);
  }
});

test("SRC-162: 旧偏好里的“应用菜单”不再让右键失效", () => {
  const prefs = normalizeZaicodeUiPrefs({ rightClickSettings: { meter: false, retry: false } });
  assert.equal(rightClickOpensSettings(prefs, "meter"), true, "按钮没有应用菜单，右键始终打开设置");
  assert.equal(rightClickOpensSettings(prefs, "retry"), true);
  assert.equal(rightClickOpensSettings(prefs, undefined), true);
});

test("R011: 损坏的偏好文件不会把右键变成别的东西", () => {
  const prefs = normalizeZaicodeUiPrefs({ rightClickSettings: { meter: "yes", header: false, x: 1 } });
  assert.deepEqual(prefs.rightClickSettings, { header: false }, "只保留真正的布尔值");
  assert.equal(rightClickOpensSettings(prefs, "meter"), true, "非布尔值视为未设置");
});

test("R011: 每个拥有设置的控件都挂上了自己的 preferenceKey", () => {
  // 规则是"哪里期待右键出设置，哪里就挂上"，所以这里断言覆盖面而不是某一个按钮。
  const files = readdirSync(join(uiSrc, "zaicode")).filter((name) => name.endsWith(".tsx"));
  const missing: string[] = [];
  for (const name of files) {
    const source = readFileSync(join(uiSrc, "zaicode", name), "utf8");
    if (!source.includes("<ZaicodeRightClickSettings")) continue;
    if (!source.includes("preferenceKey=")) missing.push(name);
  }
  assert.deepEqual(missing, [], "这些控件仍然没有接入右键开关");
});

test("R011: 开关和标记都长在共享封装里，不是每个按钮各写一份", () => {
  const shared = read("zaicode/ZaicodePrefControls.tsx");
  assert.ok(shared.includes("data-zaicode-rightclick={preferenceKey}"), "控件在 DOM 上带着自己的键");
  // SRC-162: no mode switch that can leave a control with a dead right button.
  assert.ok(!shared.includes("Opens the app menu"), "不再提供会让右键失效的“应用菜单”模式");
  assert.ok(!shared.includes("data-zaicode-rightclick-switch"));

  const prefs = read("zaicode/zaicodeUiPrefs.ts");
  assert.ok(prefs.includes("ZAICODE_RIGHT_CLICK_CONTROLS"), "控件清单集中在一处");
});

test("R011: 合成器的模型按钮也遵守规则", () => {
  const model = read("zaicode/ZaicodeModelButtons.tsx");
  assert.ok(model.includes("<ZaicodeRightClickSettings"), "模型按钮包进共享封装");
  assert.ok(model.includes('preferenceKey="modelButtons"'));
  assert.ok(model.includes("ZAICODE_MODEL_BUTTONS_MAX"), "面板说的是这条规则自己的阈值");
  // 面板包装不能破坏左键选择与原有标记。
  assert.ok(model.includes('data-zaicode-model-buttons={buttons.length}'), "原有测试钩子保留");
  assert.ok(model.includes("onSelect(button.value)"), "左键仍然选择模型");
});