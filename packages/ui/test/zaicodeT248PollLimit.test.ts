// T-248 / SRC-160:R010 -- the active queue poll reads a bounded window.
//
// The 3 s poll (and the mount effect, and every mutation refresh) read the whole
// zaicode_jobs history for the workspace. The store now asks for the newest N rows
// only; the repository adds back anything older than the window that is not
// terminal, so live queue counts stay exact while finished history stops growing
// the poll. This case pins the UI half of that contract: the request the store
// sends is bounded, and it still names the workspace.

import assert from "node:assert/strict";
import test from "node:test";

/** Minimal browser globals so zaicodeDefaultModel's storage read works. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}
const storage = new MemoryStorage();
const fakeWindow = Object.assign(new EventTarget(), { localStorage: storage });
Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const { useZaicodeStore } = await import("../src/zaicode/zaicodeStore.js");

interface JobListFilter {
  workspaceKey?: string;
  limit?: number;
}

test("T-248: the store's queue refresh carries a finite window limit for the workspace", async () => {
  const filters: JobListFilter[] = [];
  const services = {
    modelSelection: {
      onDidChange: () => () => {},
      getView: async () => ({ revision: 1, providers: [] }),
    },
    agents: { list: async () => ({ agents: [], diagnostics: [] }), listTemplates: async () => [] },
    jobs: {
      list: async (filter: JobListFilter) => {
        filters.push(filter);
        return { jobs: [], diagnostics: [] };
      },
      getAutoRun: async () => false,
      getMaxConcurrency: async () => 1,
    },
    audits: null,
  } as never;
  const workspace = { workspaceKey: "ws-a", workspacePath: "V:/a" } as never;

  await useZaicodeStore.getState().refresh(services, workspace);

  assert.equal(filters.length, 1);
  const filter = filters[0]!;
  assert.equal(filter.workspaceKey, "ws-a");
  assert.equal(typeof filter.limit, "number", "bounded read: the poll sends a row limit");
  assert.ok(Number.isInteger(filter.limit), `integer limit, got ${String(filter.limit)}`);
  assert.ok(filter.limit! > 0, `positive limit, got ${String(filter.limit)}`);
  assert.ok(filter.limit! <= 200, `window stays small, got ${String(filter.limit)}`);
});
