import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { zaicodeUsageSurface } from "../src/zaicode/zaicodeUsage.js";

// 执行真正的 caller predicate，而不是重复一份算法或断言旧错误语法。
// 完整 portal 导入会触发 Node 不支持的 PNG 资源；它不是行为 RED，不能冒充回归。
const source = readFileSync(new URL("../src/zaicode/ZaicodeGlobalSidebars.tsx", import.meta.url), "utf8");
const expression = /const usage = ([^;]+);/.exec(source)?.[1];
assert.ok(expression, "the production global Usage predicate is present");
const portalOwns = new Function("zaicodeUsageSurface", "usageMode", "workspaceOpener", `return ${expression};`) as
  (surface: typeof zaicodeUsageSurface, mode: "closed" | "sidebar" | "page", opener: (() => boolean) | null) => boolean;

for (const mode of ["closed", "sidebar", "page"] as const) {
  for (const workspaceOwns of [false, true]) {
    test(`Usage global caller: ${mode}, workspace owner ${workspaceOwns}`, () => {
      const expected = mode !== "closed" && !workspaceOwns;
      assert.equal(portalOwns(zaicodeUsageSurface, mode, workspaceOwns ? () => true : null), expected);
    });
  }
}
