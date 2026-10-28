// T-220 / SRC-151:R002 —— composer 控制条必须真的装得下。
//
// 这一层要证明两件事：宽度判定看的是整行而不是只���左侧簇（右侧簇本身过宽时，
// 只比左侧的旧算法永远认为「放得下」，阶梯走到头仍然溢出）；以及右侧簇里带文字的
// 控件也参与让位阶梯，否则它们是唯一永远不会收缩的一组。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const src = (path: string) =>
  readFileSync(join(import.meta.dirname, "../src", path), "utf8");

const fit = src("prompt-editor/useComposerToolbarFit.ts");
const editor = src("prompt-editor/ChatPromptEditor.tsx");
const retry = src("zaicode/ZaicodeAutoRetryButton.tsx");
const workingFor = src("zaicode/ZaicodeComposerWorkingFor.tsx");

test("T-220: the fit ladder measures the whole row, not only the leading cluster", () => {
  // 只比 content 与 leading-actions 正是 R002 的成因：trailing 自己超宽时
  // content 永远「装得下」，于是没有任何 rung 被触发。leading-actions 现在只应
  // 出现在 ResizeObserver 的观察列表里，不能再参与宽度判定。
  assert.match(fit, /data-composer-trailing-actions/, fit);
  const ladder = fit.slice(0, fit.indexOf("export function useComposerToolbarFit"));
  assert.doesNotMatch(ladder, /data-composer-leading-actions/);
  // SRC-151:R009 — 只看盒宽会在孩子溢出盒子时误判「放得下」：301px 行、
  // 83px content 盒、187px 的 Switch mode 孩子恰好右溢 92px，压到 trailing。
  assert.match(
    ladder,
    /leadingExtent: extent\(content\)/,
    "overflow must use each cluster's furthest child extent, not the box width",
  );
  assert.match(ladder, /trailingExtent: extent\(trailing\)/, "the trailing cluster counts too");
  assert.match(ladder, /width: root\.getBoundingClientRect\(\)\.width/, "the row itself is the budget");
  // SRC-161:REQ-008 (T-240) supersedes the flat width sum: once the browser has
  // wrapped the two clusters onto separate lines, that sum can read "fits" on a
  // visibly two-row composer, so the ladder stops collapsing on a broken row.
  // One row, or it does not fit.
  assert.match(ladder, /sameRow: sameRow\(\)/, "an already wrapped row is an overflow");
});

test("T-220: the ladder clears its own state before measuring, so a wider window restores labels", () => {
  for (const control of [
    "composerModelIcon",
    "composerProviderCompact",
  ])
    assert.match(fit, new RegExp(`delete root\\.dataset\\.${control}`), control);
  assert.match(fit, /for \(const control of controls\) delete control\.dataset\.composerCompact;/);
  assert.match(fit, /root\.style\.removeProperty\("--composer-model-max-width"\)/);
});

test("T-220: the trailing cluster has collapse rungs of its own", () => {
  // 模式/思考档位是主入口，先让位；OUTBOX 与其余 trailing 控件此前没有任何 rung。
  for (const [file, label] of [
    [retry, "zaicode/ZaicodeAutoRetryButton.tsx"],
    [workingFor, "zaicode/ZaicodeComposerWorkingFor.tsx"],
  ] as const) {
    assert.match(file, /data-composer-collapse-priority="\d+"/, label);
    assert.match(file, /group-data-\[composer-compact=true\]/, `${label}: collapsed state is styled`);
  }
  // 让位顺序固定：工作时长比 auto-retry 档位文字先让，两者都在模型名之前。
  const retryPriority = Number(/data-composer-collapse-priority="(\d+)"/.exec(retry)![1]);
  const workingPriority = Number(/data-composer-collapse-priority="(\d+)"/.exec(workingFor)![1]);
  assert.ok(
    workingPriority < retryPriority,
    `working-for (${workingPriority}) must collapse before retry scope (${retryPriority})`,
  );
});

test("T-220: an exhausted ladder wraps the row instead of overlapping the trailing buttons", () => {
  // shrink-0 让 leading content 撑出容器压到右侧按钮上；可换行是最后一级安全阀。
  assert.doesNotMatch(editor, /className="flex shrink-0 items-center gap-1" data-composer-leading-content/);
  assert.match(
    editor,
    /flex min-w-0 flex-wrap items-center gap-1" data-composer-leading-content/,
    "leading content wraps when the ladder is exhausted",
  );
  assert.match(editor, /flex-wrap items-center justify-end gap-1\.5/, "the trailing cluster wraps too");
});

test("T-220: the send and cancel controls are never collapse rungs", () => {
  // 发送/取消是唯一不能为了宽度消失的两个控件：它们不带 collapse priority。
  assert.doesNotMatch(
    editor,
    /data-composer-collapse-priority="[^"]*"[\s\S]{0,400}?(TID_CHAT_SEND_BUTTON|submitControl)/,
  );
});