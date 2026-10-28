// T-220 / SRC-151:R009 —— media/010 的 composer 控制条重叠必须在 301px 行宽复现
// 并被修复：窄行下左侧簇的盒子被压小，但所含控件仍按自身 min-content 右溢，
// 盒宽公式恰好算出「放得下」，于是没有任何让位 rung 收起，Switch mode 直接
// 压到右侧模型按钮（SAIRoute/SAIFREN）上，overlap 92×28px。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const src = (path: string) =>
  readFileSync(join(import.meta.dirname, "../src", path), "utf8");

const fit = src("prompt-editor/useComposerToolbarFit.ts");
const editor = src("prompt-editor/ChatPromptEditor.tsx");
const mode = src("v4/composer/V4ComposerModeControls.tsx");

test("R009: the ladder collapses the leading rung when a wrapped child overflows its own cluster", () => {
  // media/010 复现条件：行 301px，leading 盒 83px，Switch mode min-content
  // 187px。盒宽公式给出 83+206+12=301「放得下」；孩子实际到达 631，
  // extent 必须看到这段右溢。
  const ladder = fit.slice(0, fit.indexOf("export function useComposerToolbarFit"));
  assert.match(
    ladder,
    /const extent = \(element: HTMLElement\) => \{/,
    "cluster width is measured as the furthest child edge, not the box width",
  );
  assert.doesNotMatch(
    ladder,
    /content\.getBoundingClientRect\(\)\.width \+\s*trailing\.getBoundingClientRect\(\)/,
    "the box-width formula that missed the R009 overlap must be gone",
  );
  // 两侧簇都要用 extent：trailing 是 shrink-0 justify-end 簇，孩子同样可以
  // 超出盒子右缘。
  assert.match(ladder, /leadingExtent: extent\(content\)/);
  assert.match(ladder, /trailingExtent: extent\(trailing\)/);
});

test("R009: the media/010 control population keeps its collapse handles", () => {
  // 复现图（301×180 裁剪）里可见的控制集合：动作菜单、Switch mode
  // （leading）、模型按钮 SAIRoute/SAIFREN 与发送键（trailing）。修复靠
  // 已有的让位阶梯；这些 rung 不能在重构中丢失。
  assert.match(mode, /data-composer-collapse-priority="0"/, "Switch mode collapses first");
  assert.match(
    mode,
    /group-data-\[composer-compact=true\]\/mode:hidden/,
    "collapsed Switch mode drops its text label",
  );
  assert.match(editor, /data-composer-leading-content/, "leading cluster still marked");
  assert.match(editor, /data-composer-trailing-actions/, "trailing cluster still marked");
});

test("R009: narrowing past the rungs still wraps instead of clipping or overlapping", () => {
  assert.match(
    editor,
    /flex min-w-0 flex-wrap items-center gap-1" data-composer-leading-content/,
  );
  assert.match(editor, /flex-wrap items-center justify-end gap-1\.5/);
});
