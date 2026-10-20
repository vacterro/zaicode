import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { captureAllSessionDriftDetailed } from "../src/zaicode/zaicodeSessionDriftCapture.js";
import { publishZaicodeKnownProjects } from "../src/zaicode/zaicodeScheduler.js";
import { useDriftCaptureStore } from "../src/zaicode/zaicodeDriftCaptureStore.js";
import {
  LEASE_KEY,
  parseLease,
  refreshBatchLease,
  startLeaseHeartbeat,
  LEASE_TTL_MS,
  type BatchLease,
} from "../src/zaicode/zaicodeDriftCaptureLease.js";

// SAIHANDOFF (T-395, wave 1 C-F):
//  C  a resume skips only evidence the disk still proves, by workspace+session,
//  D  a manifest write failure is never reported as COMPLETE,
//  E  a large manifest is read whole instead of being mistaken for absent,
//  F  a slow capture keeps its lease and reports a lost one.

class FakeFiles {
  readonly files = new Map<string, string>();
  /** Paths whose writes must fail, to simulate a broken vault. */
  failWrite: (path: string) => boolean = () => false;

  private missing(path: string): never {
    const error = new Error(`ENOENT: ${path}`);
    (error as NodeJS.ErrnoException).code = "ENOENT";
    throw error;
  }

  async writeTextFile({ path, content }: { path: string; content: string }): Promise<void> {
    if (this.failWrite(path)) throw new Error(`write refused: ${path}`);
    this.files.set(path, content);
  }

  async writeTextFileAtomic({
    path,
    content,
    overwrite = true,
  }: {
    path: string;
    content: string;
    overwrite?: boolean;
  }): Promise<{ path: string; size: number }> {
    if (this.failWrite(path)) throw new Error(`write refused: ${path}`);
    if (!overwrite && this.files.has(path)) throw new Error(`File already exists: ${path}`);
    this.files.set(path, content);
    return { path, size: Buffer.byteLength(content, "utf8") };
  }

  async sha256File({ path }: { path: string }): Promise<{ sha256: string; size: number }> {
    const content = this.files.get(path);
    if (content === undefined) this.missing(path);
    const bytes = Buffer.from(content!, "utf8");
    return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  }

  async stat({ path }: { path: string }): Promise<{
    path: string;
    type: "file";
    size: number;
    mtimeMs: number;
  }> {
    const content = this.files.get(path);
    if (content === undefined) this.missing(path);
    return { path, type: "file", size: Buffer.byteLength(content!, "utf8"), mtimeMs: 0 };
  }

  async readTextFile({ path, length }: { path: string; length?: number }): Promise<{
    path: string;
    content: string;
    offset: number;
    bytesRead: number;
    totalBytes: number;
    truncated: boolean;
    isBinary: boolean;
  }> {
    const content = this.files.get(path);
    if (content === undefined) this.missing(path);
    const slice = content!.slice(0, length ?? content!.length);
    return {
      path,
      content: slice,
      offset: 0,
      bytesRead: slice.length,
      totalBytes: content!.length,
      truncated: slice.length < content!.length,
      isBinary: false,
    };
  }

  async readFileRange({
    path,
    offset,
    length,
  }: {
    path: string;
    offset: number;
    length: number;
  }): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (content === undefined) this.missing(path);
    const bytes = Buffer.from(content!, "utf8");
    return new Uint8Array(bytes.subarray(offset, offset + length));
  }
}

class MemoryStorage {
  sealed = false;
  private readonly entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.sealed) throw new Error("storage sealed");
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

function resetStore(): void {
  useDriftCaptureStore.setState({
    receipts: {},
    capturingSessionIds: [],
    activeBatch: null,
    lastBatchId: null,
    lastCaptureAt: null,
  });
}

function snapshotFor(target: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  return {
    protocol: { name: "zcode", version: "4" },
    session: {
      sessionId: target.sessionId,
      workspace: {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
      },
      status: "idle",
      updatedAt: 100,
    },
    settings: {},
    projection: {},
    runtime: {},
    messages: [
      {
        info: { role: "user", messageId: "m-1", sessionId: target.sessionId, time: { created: 1 } },
        parts: [
          {
            type: "text",
            partId: "p-1",
            text: "hello drift",
            sessionId: target.sessionId,
            messageId: "m-1",
          },
        ],
      },
    ],
  };
}

function serviceFor(idsByProject: (workspacePath: string) => string[]) {
  return {
    listSessions: async ({ workspacePath }: { workspacePath: string }) =>
      idsByProject(workspacePath).map((sessionId) => ({
        sessionId,
        workspace: { workspacePath, workspaceIdentity: workspacePath },
        updatedAt: 100,
      })),
    readSession: async (target: {
      sessionId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }) => snapshotFor(target),
  };
}

function publish(projects: string[]): void {
  publishZaicodeKnownProjects(
    projects.map((path) => ({
      path,
      identity: path,
      key: path.replace(/\W/g, ""),
      name: path,
    })),
  );
}

const singleProject = () => serviceFor(() => ["s-1"]);

test("C: a resume recaptures a session whose evidence disappeared", async () => {
  resetStore();
  publish(["C:/projects/p0"]);
  const files = new FakeFiles();
  const first = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: singleProject() as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  assert.equal(first.status, "COMPLETE");
  const committed = first.results.find((r) => r.state === "COMMITTED");
  assert.ok(committed?.outputPath);
  files.files.delete(committed!.outputPath);

  resetStore();
  const resumed = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: singleProject() as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
    resumeBatchId: first.batchId,
  });
  const after = resumed.results[0]!;
  assert.notEqual(after.state, "UNCHANGED", "a lost evidence file must not be skipped");
  assert.equal(after.state, "COMMITTED", "the session is captured again");
  assert.ok(files.files.has(committed!.outputPath), "the evidence is back on disk");
});

test("C: the same session id in two workspaces is not collapsed on resume", async () => {
  resetStore();
  publish(["C:/projects/a", "C:/projects/b"]);
  const files = new FakeFiles();
  const service = serviceFor(() => ["shared-id"]);
  const first = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: service as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  assert.equal(first.committed, 2);

  const inA = first.results.find((r) => r.projectPath === "C:/projects/a")!;
  files.files.delete(inA.outputPath);

  resetStore();
  const resumed = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: service as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
    resumeBatchId: first.batchId,
  });
  const a = resumed.results.find((r) => r.projectPath === "C:/projects/a")!;
  const b = resumed.results.find((r) => r.projectPath === "C:/projects/b")!;
  assert.equal(a.state, "COMMITTED", "the damaged workspace is captured again");
  assert.equal(b.state, "UNCHANGED", "the intact workspace keeps its skip");
});

test("D: a manifest write failure is reported, never COMPLETE", async () => {
  resetStore();
  publish(["C:/projects/p0"]);
  const files = new FakeFiles();
  files.failWrite = (path) => path.endsWith("manifest.json");
  await assert.rejects(
    () =>
      captureAllSessionDriftDetailed({
        fileService: files as never,
        sessionService: singleProject() as never,
        vaultRoot: "C:/vault",
        leaseStorage: new MemoryStorage() as never,
        ownerId: "owner-a",
        includeProtocolContext: false,
      }),
    /manifest could not be written/,
  );
  assert.equal(
    files.files.has(`C:/vault/batches/${useDriftCaptureStore.getState().lastBatchId}/manifest.json`),
    false,
  );
});

test("E: a manifest larger than the index slice is still read whole on resume", async () => {
  resetStore();
  publish(["C:/projects/p0"]);
  const files = new FakeFiles();
  const first = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: singleProject() as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  const manifestPath = `C:/vault/batches/${first.batchId}/manifest.json`;
  const manifest = JSON.parse(files.files.get(manifestPath)!);
  // 300 KiB of padding pushes the document past the 256 KiB readText slice.
  manifest.runNote = "x".repeat(300 * 1024);
  files.files.set(manifestPath, JSON.stringify(manifest));
  assert.ok(files.files.get(manifestPath)!.length > 256 * 1024);

  resetStore();
  const resumed = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: singleProject() as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
    resumeBatchId: first.batchId,
  });
  assert.equal(resumed.results[0]!.state, "UNCHANGED", "a big manifest is not mistaken for absent");
  assert.equal(resumed.skipped, 1);
});

test("E: a malformed manifest stops the resume instead of silently recapturing", async () => {
  resetStore();
  publish(["C:/projects/p0"]);
  const files = new FakeFiles();
  const first = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: singleProject() as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  files.files.set(`C:/vault/batches/${first.batchId}/manifest.json`, "{ broken");
  resetStore();
  await assert.rejects(
    () =>
      captureAllSessionDriftDetailed({
        fileService: files as never,
        sessionService: singleProject() as never,
        vaultRoot: "C:/vault",
        leaseStorage: new MemoryStorage() as never,
        ownerId: "owner-a",
        includeProtocolContext: false,
        resumeBatchId: first.batchId,
      }),
    /Cannot resume batch/,
  );
});

test("E: a capture index larger than the index slice is appended, not quarantined", async () => {
  resetStore();
  publish(["C:/projects/p0"]);
  const files = new FakeFiles();
  const history = Array.from({ length: 3 }, (_, index) => ({
    batchId: `old-${index}`,
    padding: "x".repeat(120 * 1024),
  }));
  files.files.set("C:/vault/capture-index.json", JSON.stringify({ batches: history }));
  assert.ok(files.files.get("C:/vault/capture-index.json")!.length > 256 * 1024);

  const summary = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: singleProject() as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  const index = JSON.parse(files.files.get("C:/vault/capture-index.json")!);
  assert.equal(index.batches.length, 4, "the new batch is appended to the history");
  assert.equal(index.batches[0].batchId, summary.batchId, "the newest batch leads");
  assert.equal(
    [...files.files.keys()].filter((path) => path.includes("capture-index.corrupt-")).length,
    0,
    "a big-but-valid index is never treated as corrupted",
  );
});

test("E: a pre-T-395 manifest without a digest still proves the skip from the receipt", async () => {
  resetStore();
  publish(["C:/projects/p0"]);
  const files = new FakeFiles();
  const first = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: singleProject() as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  const manifestPath = `C:/vault/batches/${first.batchId}/manifest.json`;
  const manifest = JSON.parse(files.files.get(manifestPath)!);
  for (const entry of manifest.perSessionResults) {
    delete entry.sha256;
    delete entry.outputPath;
  }
  files.files.set(manifestPath, JSON.stringify(manifest));

  // The receipts survive a renderer restart, so a healthy session is still
  // skipped instead of being recaptured just because the manifest is older.
  const resumed = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: singleProject() as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
    resumeBatchId: first.batchId,
  });
  assert.equal(resumed.results[0]!.state, "UNCHANGED");
  assert.equal(resumed.skipped, 1);
});

test("F: a lease lost mid-run never leaves the batch claiming COMPLETE", async () => {
  resetStore();
  publish(["C:/projects/p0"]);
  const files = new FakeFiles();
  const storage = new MemoryStorage();
  // Acquire reads the lease twice (before the claim and to confirm it). From
  // the third read on, another window owns it, so the post-session refresh
  // must notice the loss instead of extending the other window's lease.
  const inner = storage.getItem.bind(storage);
  let reads = 0;
  storage.getItem = (key: string) => {
    reads += 1;
    if (key === LEASE_KEY && reads > 2) {
      return JSON.stringify({ ownerId: "other", batchId: "b2", expiresAt: Date.now() + 60_000 });
    }
    return inner(key);
  };
  await assert.rejects(
    () =>
      captureAllSessionDriftDetailed({
        fileService: files as never,
        sessionService: singleProject() as never,
        vaultRoot: "C:/vault",
        leaseStorage: storage as never,
        ownerId: "owner-a",
        includeProtocolContext: false,
      }),
    /another window/,
  );
  // The captured evidence is real, but the batch is not reported as a clean
  // finish by the window that lost ownership.
  assert.ok(
    [...files.files.keys()].some((path) => path.endsWith("evidence.md")),
    "the session work that did happen is still on disk",
  );
  const manifest = JSON.parse(
    files.files.get(`C:/vault/batches/${useDriftCaptureStore.getState().lastBatchId}/manifest.json`)!,
  );
  assert.equal(manifest.status, "FAILED", "a lost lease never yields COMPLETE");
});

test("F: a lost lease is reported instead of silently extending someone else's", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    LEASE_KEY,
    JSON.stringify({ ownerId: "other", batchId: "b2", expiresAt: 10_000 }),
  );
  const result = refreshBatchLease({
    storage,
    ownerId: "owner-a",
    batchId: "b1",
    now: 1_000,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /another window/);
});

test("F: the heartbeat refreshes the lease and reports loss exactly once", () => {
  const storage = new MemoryStorage();
  storage.setItem(
    LEASE_KEY,
    JSON.stringify({ ownerId: "owner-a", batchId: "b1", expiresAt: 1 }),
  );
  let tick: (() => void) | undefined;
  let cleared = 0;
  const lost: string[] = [];
  const stop = startLeaseHeartbeat({
    storage,
    ownerId: "owner-a",
    batchId: "b1",
    now: () => 5_000,
    onLost: (reason) => lost.push(reason),
    intervalMs: 1_000,
    scheduler: {
      setInterval: (fn) => {
        tick = fn;
        return "handle";
      },
      clearInterval: () => {
        cleared += 1;
      },
    },
  });

  tick!();
  const refreshed = parseLease(storage.getItem(LEASE_KEY)) as BatchLease;
  assert.equal(refreshed.expiresAt, 5_000 + LEASE_TTL_MS, "the heartbeat extends the TTL");
  assert.equal(lost.length, 0);

  storage.setItem(
    LEASE_KEY,
    JSON.stringify({ ownerId: "other", batchId: "b2", expiresAt: 9_000 }),
  );
  tick!();
  assert.equal(lost.length, 1, "the lost claim is surfaced");
  assert.match(lost[0]!, /another window/);
  tick!();
  assert.equal(lost.length, 1, "a lost lease is never reported twice");
  assert.equal(cleared, 1, "the heartbeat stops itself");

  stop();
  assert.equal(cleared, 2, "the caller can stop the heartbeat after the run");
});

test("F: a sealed lease storage stops the batch before it reports success", async () => {
  resetStore();
  publish(["C:/projects/p0"]);
  const files = new FakeFiles();
  const storage = new MemoryStorage();
  // The acquire write succeeds, then every later write fails: ownership can no
  // longer be proven, so the batch must not claim a clean run.
  const originalSet = storage.setItem.bind(storage);
  let writes = 0;
  storage.setItem = (key: string, value: string) => {
    writes += 1;
    if (writes <= 1) return originalSet(key, value);
    throw new Error("storage sealed");
  };
  await assert.rejects(
    () =>
      captureAllSessionDriftDetailed({
        fileService: files as never,
        sessionService: singleProject() as never,
        vaultRoot: "C:/vault",
        leaseStorage: storage as never,
        ownerId: "owner-a",
        includeProtocolContext: false,
      }),
    /Cannot persist capture ownership|ownership/,
  );
});
