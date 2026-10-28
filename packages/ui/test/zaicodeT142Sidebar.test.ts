import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/** Execute the renderer's real section mapping and the header's real count expression. */
function counts(folded: boolean) {
  const source = readFileSync(process.env.ZAICODE_T142_SIDEBAR_SUBJECT ?? new URL("../src/WorkspaceSidebar.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("sidebar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let mapping: ts.Expression | undefined;
  let count: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "zaicodeRenderSections") mapping = node.initializer;
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "ZaicodeSlotGroupHeader") {
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "count" && attribute.initializer && ts.isJsxExpression(attribute.initializer)) count = attribute.initializer.expression;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(mapping);
  assert.ok(count);
  const code = ts.transpileModule(`const sections = ${mapping.getText(ast)}; sections.map(section => ({ count: ${count.getText(ast)}, visible: section.tabs.length }));`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const result = runInNewContext(code, {
    useMemo: (callback: () => unknown) => callback(),
    zaicodeProjectSections: [
      { group: "MAIN0", folded, tabs: [{ id: "a" }, { id: "b" }] },
      { group: "SIDE0", folded, tabs: [] },
    ],
    zaicodeRowPlan: new Map(),
    orderSectionTabs: (tabs: unknown[]) => tabs,
  });
  return JSON.parse(JSON.stringify(result));
}

test("folded slots retain their hidden project count; an empty slot stays zero", () => {
  assert.deepEqual(counts(true), [{ count: 2, visible: 0 }, { count: 0, visible: 0 }]);
});

test("expanded slots count the same projects that they render", () => {
  assert.deepEqual(counts(false), [{ count: 2, visible: 2 }, { count: 0, visible: 0 }]);
});
