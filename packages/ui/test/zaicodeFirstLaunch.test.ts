import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { zaicodeOverflowFit, zaicodeOverflowHidden } from "../src/zaicode/zaicodeOverflow.js";

// The first launch as a new user sees it: an empty profile, the default 264 px
// sidebar, no project yet. These pin what the fresh-install audit found.

const src = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

test("service hooks never change their hook order when the workspace path arrives", () => {
  // The onboarding dialog mounts before the workspace path is known; picking a
  // different hook by path made React crash it ("change in the order of Hooks").
  for (const file of ["hooks/useZCodeSessionService.ts", "hooks/useZCodeAgentService.ts", "hooks/useZCodeTaskService.ts"]) {
    const code = src(file);
    assert.match(code, /useWorkspaceOrContextServices\(workspacePath, preferredRemoteSessionId, workspaceIdentity\)/, file);
    assert.doesNotMatch(code, /\?\s*use[A-Z]\w*\(/, `${file}: no hook behind a condition`);
  }
  const helper = src("hooks/useWorkspaceServices.tsx");
  assert.match(
    helper,
    /const contextServices = useServices\(\);\s+const workspaceServices = useWorkspaceServices\(workspacePath, preferredRemoteSessionId, workspaceIdentity\);\s+return workspacePath \? workspaceServices : contextServices;/,
  );
});

test("the overflow row can keep chosen items longest without reordering the row", () => {
  // Default keep (trailing first) is exactly the old leading-fit rule.
  for (const [widths, available] of [
    [[28, 28, 28], 100],
    [[28, 28, 28, 28, 28], 120],
    [[28, 28], 10],
    [[49, 36, 24, 24], 98],
  ] as const) {
    const keep = widths.map((_, index) => -index);
    const hidden = zaicodeOverflowHidden(widths, keep, available, 2, 28);
    const fit = zaicodeOverflowFit(widths, available, 2, 28);
    assert.deepEqual(hidden, widths.map((_, index) => index >= fit), `${widths.join(",")} in ${available}`);
  }
  // The sidebar at 264 px: SLOTS 49, LIVE 36, + 24, sort 24 in 98 px. The add
  // button stays; sorting leaves first, then LIVE, then SLOTS.
  assert.deepEqual(zaicodeOverflowHidden([49, 36, 24, 24], [3, 2, 9, 0], 98, 2, 28), [true, true, false, true]);
  assert.deepEqual(zaicodeOverflowHidden([49, 36, 24, 24], [3, 2, 9, 0], 130, 2, 28), [false, true, false, true]);
  assert.deepEqual(zaicodeOverflowHidden([49, 36, 24, 24], [3, 2, 9, 0], 139, 2, 28), [false, false, false, false]);
  assert.deepEqual(zaicodeOverflowHidden([], [], 50, 2, 28), []);
});

test("the sidebar view row never cuts a button off at the default width", () => {
  const sidebar = src("WorkspaceSidebar.tsx");
  assert.match(sidebar, /<ZaicodeOverflowRow className="min-w-0 flex-1 justify-end" items=\{zaicodeItems\} \/>/);
  assert.match(sidebar, /\{ key: "add-project", keep: 9, node: projectAddMenu \}/, "adding a project is the last to leave the row");
  assert.match(sidebar, /\{ key: "filter", keep: 0, node: filterMenu \}/, "sorting is the first");
  // The words only when the whole row fits next to them.
  assert.equal(sidebar.match(/hidden @min-\[440px\]\/zsbtools:inline/g)?.length, 3);
  assert.doesNotMatch(sidebar, /@min-\[248px\]\/zsbtools/);
});

test("an agent whose pool is not on this machine is not shown as ready to dispatch", () => {
  // A fresh machine without the router: "Add team" gives agents the default pool
  // (new-provider/SAIFREN), and the Inspector said "Pool selected. Dispatch runs ...".
  const inspector = src("zaicode/ZaicodeInspector.tsx");
  assert.match(inspector, /const \{ groups: poolGroups, loading: poolsLoading \} = useZaicodePoolGroups\(\);/);
  assert.match(inspector, /poolMissing\(selectedAgent\) \? "zaicode\.route\.poolMissing" : routePlanStatusMessageId\(selectedAgentRoutePlan\)/);
  assert.match(inspector, /if \(poolsLoading \|\| !providerId \|\| !modelId\) return false;/, "never while the pools are still loading");
  for (const locale of ["en-US", "zh-CN"]) assert.match(src(`i18n/locales/${locale}.ts`), /"zaicode\.route\.poolMissing":/, locale);
});
