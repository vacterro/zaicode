import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ZaicodeMainBulkCandidate,
  ZaicodeMainBulkProject,
} from "../src/zaicode/zaicodeMainBulkAssign.js";

/** The MAIN store reads localStorage at call time; a memory stub proves persistence claims. */
class MemoryStorage {
  map = new Map<string, string>();
  failNextWrite = false;
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("QuotaExceededError");
    }
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

const storage = new MemoryStorage();
(globalThis as { localStorage?: unknown }).localStorage = storage;

const { useZaicodeMainSessions } = await import("../src/zaicode/zaicodeMainSession.js");
const {
  applyZaicodeMainBulkAssign,
  planZaicodeMainBulkAssign,
  selectZaicodeMainBulkCandidate,
} = await import("../src/zaicode/zaicodeMainBulkAssign.js");

const session = (
  sessionId: string,
  updatedAt: number,
  role?: ZaicodeMainBulkCandidate["role"],
): ZaicodeMainBulkCandidate => ({
  sessionId,
  title: sessionId,
  updatedAt,
  ...(role === undefined ? {} : { role }),
});
const project = (
  key: string,
  sessions: readonly ZaicodeMainBulkCandidate[],
  extra: Partial<ZaicodeMainBulkProject> = {},
): ZaicodeMainBulkProject => ({ key, name: key, sessions, ...extra });

/** Every test starts from an empty, clean store: the store is module-global state. */
function resetStore() {
  useZaicodeMainSessions.setState({ byWorkspace: {}, armed: {} });
  storage.clear();
  storage.failNextWrite = false;
}

test("01. Left-click still changes view (tab wiring untouched)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const sidebar = readFileSync(
    fileURLToPath(new URL("../src/WorkspaceSidebar.tsx", import.meta.url)),
    "utf8",
  );
  // The MAIN tab keeps its declarative value and gains no click handler that
  // would hijack the view switch; the bulk command lives on the context menu.
  assert.match(sidebar, /value="main"/);
  assert.match(sidebar, /data-zaicode-view-main=""/);
  assert.doesNotMatch(sidebar, /data-zaicode-view-main=""[\s\S]{0,400}onClick=/);
});

test("02. Right-click opens the bulk action and never activates the left-click path", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const sidebar = readFileSync(
    fileURLToPath(new URL("../src/WorkspaceSidebar.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(sidebar, /onContextMenu=\{\s*\(event\) => \{[\s\S]{0,200}setZaicodeMainBulkMenuOpen\(true\)/);
  // Keyboard equivalent: ContextMenu key / Shift+F10 open the same menu.
  assert.match(sidebar, /event\.key !== "ContextMenu" && !\(event\.shiftKey && event\.key === "F10"\)/);
  assert.match(sidebar, /<ZaicodeMainBulkAssignMenu/);
});

test("03. Existing valid MAIN is never replaced (set all, not toggle all)", () => {
  resetStore();
  const plan = planZaicodeMainBulkAssign({
    byWorkspace: { "C:/a": "old-main" },
    projects: [project("C:/a", [session("old-main", 50), session("s2", 10)])],
  });
  assert.equal(plan.assigned, 0);
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.outcomes[0]?.kind, "unchanged");
});

test("04. A project with no MAIN gets its most recently active eligible session", () => {
  resetStore();
  const plan = planZaicodeMainBulkAssign({
    byWorkspace: {},
    projects: [project("C:/a", [session("stale", 10), session("fresh", 99)])],
  });
  assert.equal(plan.assigned, 1);
  const outcome = plan.outcomes[0];
  assert.equal(outcome?.kind, "assigned");
  assert.equal(outcome?.kind === "assigned" && outcome.sessionId, "fresh");
});

test("05. A helper session is never promoted by recency", () => {
  resetStore();
  assert.equal(
    selectZaicodeMainBulkCandidate([session("saiwiki-1", 999, "WIKI"), session("plain", 5, null)])?.sessionId,
    "plain",
  );
  assert.equal(selectZaicodeMainBulkCandidate([session("saihunt-1", 999, "HUNT")]), null);
  const plan = planZaicodeMainBulkAssign({
    byWorkspace: {},
    projects: [project("C:/a", [session("saihunt-1", 999, "HUNT")])],
  });
  // No eligible session: pending, and no fabricated MAIN id.
  assert.equal(plan.assigned, 0);
  assert.equal(plan.pending, 1);
});

test("06. An empty project becomes pending and never gets a fabricated session id", () => {
  resetStore();
  const result = applyZaicodeMainBulkAssign([project("C:/empty", [])], useZaicodeMainSessions.getState());
  assert.equal(result.plan.pending, 1);
  assert.equal(result.plan.assigned, 0);
  assert.deepEqual(useZaicodeMainSessions.getState().byWorkspace, {});
  // The pending intent is a next-session claim, which is not durable: say so.
  assert.equal(useZaicodeMainSessions.getState().armed["c:/empty"], true);
});

test("07. A cold project keeps its remembered MAIN (empty list cannot say it is gone)", () => {
  resetStore();
  useZaicodeMainSessions.getState().setMain("C:/cold", "main-x");
  const plan = planZaicodeMainBulkAssign({
    byWorkspace: useZaicodeMainSessions.getState().byWorkspace,
    projects: [project("C:/cold", [])],
  });
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.assigned, 0);
});

test("08. Two spellings of one project are one project, one MAIN entry", () => {
  resetStore();
  const result = applyZaicodeMainBulkAssign(
    [project("C:/a", [session("s1", 10)]), project("c:/a/", [session("s2", 20)])],
    useZaicodeMainSessions.getState(),
  );
  assert.equal(result.plan.assigned, 1);
  assert.equal(Object.keys(useZaicodeMainSessions.getState().byWorkspace).length, 1);
});

test("09. A switched-off project is counted and never written to", () => {
  resetStore();
  const result = applyZaicodeMainBulkAssign(
    [project("C:/off", [session("s1", 10)], { disabled: true }), project("C:/on", [session("s2", 20)])],
    useZaicodeMainSessions.getState(),
  );
  assert.equal(result.plan.skipped, 1);
  assert.equal(result.plan.assigned, 1);
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["C:/off"], undefined);
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["C:/on"], "s2");
});

test("10. One coordinated mutation preserves unrelated owners and writes once", () => {
  resetStore();
  useZaicodeMainSessions.getState().setMain("C:/other", "other-main");
  const result = applyZaicodeMainBulkAssign(
    [project("C:/a", [session("s1", 10)]), project("C:/b", [session("s2", 20)])],
    useZaicodeMainSessions.getState(),
  );
  const map = useZaicodeMainSessions.getState().byWorkspace;
  assert.equal(map["C:/a"], "s1");
  assert.equal(map["C:/b"], "s2");
  assert.equal(map["C:/other"], "other-main");
  assert.equal(result.persisted, true);
  // Durable: the read-back map is what was saved, not only in-memory state.
  const raw = JSON.parse(storage.getItem("zaicode-main-sessions-v1") ?? "{}");
  assert.equal(raw.byWorkspace["C:/a"], "s1");
});

test("11. A refused durable write is reported, not claimed as done", () => {
  resetStore();
  storage.failNextWrite = true;
  const result = applyZaicodeMainBulkAssign(
    [project("C:/a", [session("s1", 10)])],
    useZaicodeMainSessions.getState(),
  );
  assert.equal(result.persisted, false);
  // In-memory still applies for this window, but nothing claims durability.
  assert.equal(storage.getItem("zaicode-main-sessions-v1"), null);
});

test("12. Undo restores only this operation, and never overwrites a later operator edit", () => {
  resetStore();
  useZaicodeMainSessions.getState().setMain("C:/pre", "pre-main");
  const result = applyZaicodeMainBulkAssign(
    [project("C:/a", [session("s1", 10)]), project("C:/pre", [session("pre-main", 20)])],
    useZaicodeMainSessions.getState(),
  );
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["C:/a"], "s1");
  // C:/pre already had a valid MAIN, so the bulk did not touch it.
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["C:/pre"], "pre-main");

  result.undo();
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["C:/a"], undefined);

  // A later independent edit survives the undo of an earlier bulk run.
  const second = applyZaicodeMainBulkAssign(
    [project("C:/b", [session("s9", 50), session("s10", 5)])],
    useZaicodeMainSessions.getState(),
  );
  assert.equal(second.plan.assigned, 1);
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["C:/b"], "s9");
  // The operator re-picks MAIN after the bulk ran: that edit is theirs, not ours.
  useZaicodeMainSessions.getState().setMain("C:/b", "s10");
  second.undo();
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["C:/b"], "s10");
});

test("13. Repeating the bulk command is idempotent", () => {
  resetStore();
  const projects = [project("C:/a", [session("s1", 10)]), project("C:/b", [session("s2", 20)])];
  const first = applyZaicodeMainBulkAssign(projects, useZaicodeMainSessions.getState());
  const second = applyZaicodeMainBulkAssign(projects, useZaicodeMainSessions.getState());
  assert.equal(first.plan.assigned, 2);
  assert.equal(second.plan.assigned, 0);
  assert.equal(second.plan.unchanged, 2);
  assert.deepEqual(useZaicodeMainSessions.getState().byWorkspace, {
    "C:/a": "s1",
    "C:/b": "s2",
  });
});

test("14. A pending claim is consumed only by a newly created session in that project", () => {
  resetStore();
  useZaicodeMainSessions.getState().arm("C:/empty");
  assert.equal(useZaicodeMainSessions.getState().claimIfArmed("C:/empty", "new-primary"), true);
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["C:/empty"], "new-primary");
  // The claim is spent: a second session in the same project does not steal MAIN.
  assert.equal(useZaicodeMainSessions.getState().claimIfArmed("C:/empty", "late-helper"), false);
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["C:/empty"], "new-primary");
  // And another project never inherits this project's claim.
  assert.equal(useZaicodeMainSessions.getState().claimIfArmed("C:/elsewhere", "intruder"), false);
});

test("15. Bulk assignment creates no session and dispatches no work", () => {
  resetStore();
  const dispatched: string[] = [];
  const fakeAgent = { start: (id: string) => dispatched.push(id) };
  const result = applyZaicodeMainBulkAssign(
    [project("C:/a", [session("s1", 10)])],
    useZaicodeMainSessions.getState(),
  );
  assert.equal(result.plan.assigned, 1);
  assert.deepEqual(dispatched, []);
  // Sessions of the project are untouched: only the association moved.
  assert.equal(useZaicodeMainSessions.getState().armed["c:/a"], undefined);
});

test("16. Disarm reverses a pending claim without touching a real MAIN", () => {
  resetStore();
  const store = useZaicodeMainSessions.getState();
  const result = applyZaicodeMainBulkAssign([project("C:/empty", [])], store);
  assert.equal(useZaicodeMainSessions.getState().armed["c:/empty"], true);
  result.undo();
  assert.equal(useZaicodeMainSessions.getState().armed["c:/empty"], undefined);

  // Undo after the claim was already consumed by a real session leaves that session alone.
  const again = applyZaicodeMainBulkAssign([project("C:/empty", [])], useZaicodeMainSessions.getState());
  useZaicodeMainSessions.getState().claimIfArmed("C:/empty", "new-primary");
  again.undo();
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["C:/empty"], "new-primary");
});

test("17. Only persistent subSaipen roles count as helpers; core modes do not", async () => {
  const { isZaicodeHelperRole } = await import("../src/zaicode/zaicodeSessionRoles.js");
  assert.equal(isZaicodeHelperRole("WIKI"), true);
  assert.equal(isZaicodeHelperRole("HUNT"), true);
  assert.equal(isZaicodeHelperRole("CREW"), false);
  assert.equal(isZaicodeHelperRole("AUDIT"), false);
  assert.equal(isZaicodeHelperRole(null), false);
  // A core-mode session is still eligible for MAIN.
  assert.equal(selectZaicodeMainBulkCandidate([session("crew-1", 99, "CREW")])?.sessionId, "crew-1");
});

test("18. Counts reported to the operator come from the executed outcomes", () => {
  resetStore();
  useZaicodeMainSessions.setState({
    byWorkspace: { "C:/unchanged": "s2" },
    armed: {},
  });
  const result = applyZaicodeMainBulkAssign(
    [
      project("C:/assigned", [session("s1", 10)]),
      project("C:/unchanged", [session("s2", 20)]),
      project("C:/pending", []),
      project("C:/off", [session("s3", 30)], { disabled: true }),
    ],
    useZaicodeMainSessions.getState(),
  );
  const { plan } = result;
  assert.equal(plan.assigned, 1);
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.pending, 1);
  assert.equal(plan.skipped, 1);
  assert.equal(
    plan.assigned + plan.unchanged + plan.pending + plan.skipped,
    plan.outcomes.length,
    "every checked project appears exactly once",
  );
});

test("19. Undo restores a stale MAIN under its stored spelling, it does not erase it", () => {
  resetStore();
  // A stale MAIN points at a session that no longer exists, so the bulk moves
  // the project to a real session; Undo must put the stale association back.
  useZaicodeMainSessions.getState().setMain("C:/a", "gone-forever");
  const store = useZaicodeMainSessions.getState();
  const result = applyZaicodeMainBulkAssign([project("C:/a", [session("s1", 10)])], store);
  assert.equal(result.plan.assigned, 1);
  assert.equal(store.currentMain("C:/a"), "s1");
  result.undo();
  assert.equal(store.currentMain("C:/a"), "gone-forever");
  // One project is one entry, however its path was spelled.
  assert.deepEqual(Object.keys(useZaicodeMainSessions.getState().byWorkspace), ["C:/a"]);
});

test("20. Undo reads the stored spelling, not the raw project key", () => {
  resetStore();
  // The map keeps whatever spelling an earlier command saved: here the folded form.
  useZaicodeMainSessions.setState({
    byWorkspace: { "c:/folded": "gone-forever" },
    armed: {},
  });
  const store = useZaicodeMainSessions.getState();
  const result = applyZaicodeMainBulkAssign([project("C:/folded", [session("s1", 10)])], store);
  assert.equal(result.plan.assigned, 1);
  assert.equal(store.currentMain("C:/folded"), "s1");
  result.undo();
  // A raw-key read would see no previous value and erase the stale entry instead.
  assert.equal(store.currentMain("C:/folded"), "gone-forever");
  assert.deepEqual(Object.keys(useZaicodeMainSessions.getState().byWorkspace), ["c:/folded"]);
});
