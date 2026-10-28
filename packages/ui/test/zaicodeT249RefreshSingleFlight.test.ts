// T-249 / SRC-160:R013 (PERF-002) -- workspace refresh is single-flight and
// generation-safe.
//
// zaicodeStore.refresh had three overlapping callers (the mount effect, the 3 s
// active poll, and every runAction) awaiting five serial reads with no commit
// guard: a pass that finished last wrote an older snapshot over a newer one, and
// a second caller always started a second read set. This suite pins the SRC-160
// PERF-002 contract with deferred mock RPCs: the independent reads run
// concurrently, overlapping callers share ONE in-flight pass plus at most ONE
// trailing pass, a response that has been superseded is never committed
// (workspace switch included), and the final store state came from the newest
// request.

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

type ReadKey = "agents" | "jobs" | "templates" | "max";

const READ_KEYS: ReadKey[] = ["agents", "jobs", "templates", "max"];

interface PendingRead {
  key: ReadKey;
  resolve: (value: unknown) => void;
}

/**
 * Deferred RPCs: every controlled read parks until the test releases the whole
 * in-flight read set with one snapshot marker. `getAutoRun` answers immediately,
 * because refreshAutoRun carries its own generation guard and a pass must not
 * hang on a read this suite does not drive.
 */
function makeServices() {
  const pending: PendingRead[] = [];
  const started: ReadKey[] = [];
  const start = (key: ReadKey) => {
    started.push(key);
    return new Promise<unknown>((resolve) => pending.push({ key, resolve }));
  };
  const services = {
    modelSelection: { onDidChange: () => () => {}, getView: async () => ({ revision: 1, providers: [] }) },
    agents: {
      list: async () => start("agents"),
      listTemplates: async () => start("templates"),
    },
    jobs: {
      getAutoRun: async () => false,
      list: async () => start("jobs"),
      getMaxConcurrency: async () => start("max"),
    },
    audits: null,
  } as never;
  const valueFor = (key: ReadKey, marker: string) => {
    if (key === "agents") return { agents: [{ id: `agent-${marker}` }], diagnostics: [] };
    if (key === "jobs") return { jobs: [{ id: `job-${marker}` }], diagnostics: [] };
    if (key === "templates") return [{ id: `template-${marker}` }];
    return marker === "old" ? 1 : 7;
  };
  /** Release every read of the pass currently in flight with one snapshot marker. */
  const release = (marker: string) => {
    const open = pending.splice(0, pending.length);
    if (open.length === 0) throw new Error(`no in-flight read set to release for ${marker}`);
    for (const read of open) read.resolve(valueFor(read.key, marker));
  };
  const openReads = () => pending.length;
  const readStarts = () => started.length;
  const startsOf = (key: ReadKey) => started.filter((k) => k === key).length;
  return { services, release, openReads, readStarts, startsOf };
}

/** Let every queued microtask/macrotask turn run. */
async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function marker(): string | null {
  const job = useZaicodeStore.getState().jobs[0];
  return job ? job.id.replace(/^job-/, "") : null;
}

const workspaceA = { workspaceKey: "ws-a", workspacePath: "V:/a" } as never;
const workspaceB = { workspaceKey: "ws-b", workspacePath: "V:/b" } as never;

/** The store module is shared by the whole file; each case starts from empty. */
test.beforeEach(() => {
  useZaicodeStore.setState({
    agents: [],
    agentDiagnostics: [],
    jobs: [],
    jobDiagnostics: [],
    templates: [],
    maxConcurrency: 0,
    loading: false,
    error: null,
  });
});

test("T-249: the independent reads of one pass run concurrently", async () => {
  const { services, release, openReads, startsOf } = makeServices();

  const pass = useZaicodeStore.getState().refresh(services, workspaceA);
  await settle();
  // Promise.all: all four reads are outstanding at once, not one after another.
  assert.equal(openReads(), 4, "one pass holds all four reads open concurrently");
  for (const key of READ_KEYS) assert.equal(startsOf(key), 1, `${key} was read once`);

  release("one");
  await pass;
  assert.equal(openReads(), 0, "the pass drained its read set");
  assert.equal(marker(), "one");
});

test("T-249: a newer request supersedes an answer that arrives late; store holds the newest only", async () => {
  const { services, release, startsOf } = makeServices();

  const first = useZaicodeStore.getState().refresh(services, workspaceA);
  await settle();
  assert.equal(startsOf("jobs"), 1, "the first refresh owns the read set");

  // The newer request arrives while A's RPCs are still outstanding.
  const second = useZaicodeStore.getState().refresh(services, workspaceA);
  await settle();
  assert.equal(startsOf("jobs"), 1, "no second read set starts while one is in flight");

  // A's delayed response lands after the newer request was issued: it is stale
  // and must not be committed. (Under the old serial refresh this is the moment
  // the older snapshot overwrote the newer one.)
  release("old");
  await settle();
  await first;
  assert.equal(marker(), null, "a superseded snapshot is never committed");
  assert.equal(useZaicodeStore.getState().jobs.length, 0, "the dropped response left no partial state");

  assert.equal(startsOf("jobs"), 2, "the newer request reads exactly once more");
  release("new");
  await settle();
  await second;
  assert.equal(marker(), "new", "final store state came from the newest request");
  assert.equal(useZaicodeStore.getState().maxConcurrency, 7, "every snapshot field came from the newest request");
  assert.equal(useZaicodeStore.getState().loading, false, "the newest pass cleared loading");
});

test("T-249: one refresh held open across ten poll ticks costs one active plus one trailing pass", async () => {
  const { services, release, startsOf } = makeServices();
  const store = useZaicodeStore;

  const held = store.getState().refresh(services, workspaceA);
  await settle();

  // Ten tick opportunities while the pass is open (ZaicodeWorkspace polls every
  // 3 s; the ticks only need to be concurrent requests, not real timers).
  const ticks = Array.from({ length: 10 }, () => store.getState().refresh(services, workspaceA));
  await settle();
  assert.equal(startsOf("jobs"), 1, "at most one active refresh read set");

  release("tick-1");
  await settle();
  await held;
  assert.equal(startsOf("jobs"), 2, "at most one intentionally queued trailing refresh");

  release("tick-2");
  await settle();
  await Promise.all(ticks);
  assert.equal(startsOf("jobs"), 2, "the trailing pass does not spawn further passes once it lands");
  assert.equal(marker(), "tick-2", "the newest request owns the committed snapshot");
  assert.equal(store.getState().loading, false);
});

test("T-249: a refresh requested during an active poll includes the mutation and never regresses", async () => {
  const { services, release, startsOf } = makeServices();
  const store = useZaicodeStore;

  const poll = store.getState().refresh(services, workspaceA);
  await settle();
  // A mutation's own refresh rides in behind the still-open poll (runAction
  // awaits a fresh read after applying its change).
  const postMutation = store.getState().refresh(services, workspaceA);
  await settle();
  assert.equal(marker(), null, "nothing from the open poll has committed yet");

  release("pre-mutation");
  await settle();
  await poll;
  assert.equal(startsOf("jobs"), 2, "the post-mutation read is the trailing pass");

  release("post-mutation");
  await settle();
  await postMutation;
  assert.equal(marker(), "post-mutation", "the final snapshot includes the mutation");

  // Nothing can re-apply the pre-mutation snapshot afterwards.
  await settle(12);
  assert.equal(marker(), "post-mutation", "the committed snapshot never regresses");
  assert.equal(store.getState().loading, false);
});

test("T-249: a snapshot for an abandoned workspace never commits after navigation", async () => {
  const { services, release, startsOf } = makeServices();
  const store = useZaicodeStore;

  const leaving = store.getState().refresh(services, workspaceA);
  await settle();
  // Navigation happens while workspace A's RPCs are still pending.
  const arrived = store.getState().refresh(services, workspaceB);
  await settle();
  assert.equal(startsOf("jobs"), 1, "navigation queues behind the in-flight pass instead of reading twice");

  release("ws-a");
  await settle();
  await leaving;
  assert.equal(store.getState().jobs.length, 0, "workspace A results did not commit into workspace B");

  release("ws-b");
  await settle();
  await arrived;
  assert.equal(marker(), "ws-b", "only the arrived workspace's snapshot is visible");
  assert.equal(startsOf("jobs"), 2, "one read set per pass, never two in flight");
  assert.equal(store.getState().loading, false);
});

test("T-249: a burst of eleven concurrent refreshes costs two read sets, not eleven", async () => {
  const { services, release, readStarts, startsOf } = makeServices();
  const store = useZaicodeStore;

  const burst = Array.from({ length: 11 }, () => store.getState().refresh(services, workspaceA));
  await settle();
  assert.equal(startsOf("jobs"), 1, "eleven callers during a pass start one read set");

  release("first");
  await settle();
  release("second");
  await settle();
  await Promise.all(burst);

  assert.equal(startsOf("jobs"), 2, "a coalesced burst costs one active plus one trailing pass");
  assert.equal(readStarts(), 8, "eight RPCs total (4 reads x 2 passes), not 44");
  assert.equal(marker(), "second", "the newest request owns the committed snapshot");
  assert.equal(store.getState().loading, false);
});
