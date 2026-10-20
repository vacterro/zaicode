import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  captureAllSessionDriftDetailed,
  type DriftCaptureBatchSummary,
} from "../src/zaicode/zaicodeSessionDriftCapture.js";
import { publishZaicodeKnownProjects } from "../src/zaicode/zaicodeScheduler.js";
import { useDriftCaptureStore } from "../src/zaicode/zaicodeDriftCaptureStore.js";
import { createDriftCaptureMetricsCollector } from "../src/zaicode/zaicodeDriftCaptureMetrics.js";
import { utf8ByteLength } from "../src/zaicode/zaicodeDriftCaptureSupport.js";

// SAIHANDOFF: the capture lifecycle must be honest about what it saved.
// Retiring a session hides the live marker but keeps the archive, a
// truncated staging write must never be reported as SAVED, and the run must
// report what it cost.

class FakeFiles {
  readonly files = new Map<string, string>();
  /** Paths whose reported size is wrong, to simulate a truncated write. */
  sizeFault: (path: string) => boolean = () => false;

  private missing(path: string): never {
    const error = new Error(`ENOENT: ${path}`);
    (error as NodeJS.ErrnoException).code = "ENOENT";
    throw error;
  }

  async writeTextFile({ path, content }: { path: string; content: string }): Promise<void> {
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
    if (!overwrite && this.files.has(path)) throw new Error(`File already exists: ${path}`);
    this.files.set(path, content);
    return { path, size: Buffer.byteLength(content, "utf8") };
  }

  async sha256File({ path }: { path: string }): Promise<{ sha256: string; size: number }> {
    const content = this.files.get(path);
    if (content === undefined) this.missing(path);
    const bytes = Buffer.from(content!, "utf8");
    const size = this.sizeFault(path) ? bytes.length - 1 : bytes.length;
    return { sha256: createHash("sha256").update(bytes).digest("hex"), size };
  }

  async stat({ path }: { path: string }): Promise<{
    path: string;
    type: "file";
    size: number;
    mtimeMs: number;
  }> {
    const content = this.files.get(path);
    if (content === undefined) this.missing(path);
    return {
      path,
      type: "file",
      size: Buffer.byteLength(content!, "utf8"),
      mtimeMs: 0,
    };
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
}

class MemoryStorage {
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

const sessionService = {
  listSessions: async ({ workspacePath }: { workspacePath: string }) => [
    {
      sessionId: "s-1",
      workspace: { workspacePath, workspaceIdentity: workspacePath },
      updatedAt: 100,
    },
  ],
  readSession: async (target: { sessionId: string; workspacePath: string; workspaceIdentity?: string }) => ({
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
        info: {
          role: "user",
          messageId: "m-1",
          sessionId: target.sessionId,
          time: { created: 1 },
        },
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
  }),
};

async function captureOnce(
  files: FakeFiles,
): Promise<DriftCaptureBatchSummary> {
  resetStore();
  publishZaicodeKnownProjects([
    {
      path: "C:/projects/p0",
      identity: "p0",
      key: "p0",
      name: "p0",
    },
  ]);
  return captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: sessionService as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
}

test("retiring a session hides the live marker but keeps the receipt and the archive", async () => {
  const files = new FakeFiles();
  const summary = await captureOnce(files);
  assert.equal(summary.status, "COMPLETE");

  const store = useDriftCaptureStore.getState();
  const receipt = Object.values(store.receipts)[0];
  assert.ok(receipt, "the capture produced a receipt");
  const identity = receipt.workspaceIdentity;
  const path = receipt.workspacePath;
  assert.equal(store.markerFor("s-1", path, identity), "SAVED_VERIFIED");

  store.retireMarker("s-1", path, identity);
  const afterRetire = useDriftCaptureStore.getState();
  assert.equal(
    afterRetire.markerFor("s-1", path, identity),
    "NOT_CAPTURED",
    "the live marker is gone",
  );
  assert.ok(
    afterRetire.getReceipt("s-1", path, identity),
    "the receipt survives the retirement",
  );
  assert.equal(
    afterRetire.listProjectTotals()[0]?.sessions,
    1,
    "the archive still counts in the project totals",
  );
  assert.ok(
    files.files.has(receipt.outputPath),
    "the evidence file is still on disk",
  );

  afterRetire.restoreMarker("s-1", path, identity);
  assert.equal(
    useDriftCaptureStore.getState().markerFor("s-1", path, identity),
    "SAVED_VERIFIED",
    "an un-archived session gets its live marker back",
  );
});

test("a truncated staging write is never reported as saved", async () => {
  const files = new FakeFiles();
  await captureOnce(files);
  const receipt = Object.values(useDriftCaptureStore.getState().receipts)[0];
  assert.ok(receipt);

  // The staged file claims a size that is not the transcript's size.
  files.sizeFault = (path) => path.includes("/.staging/evidence.md");
  resetStore();
  const summary = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: sessionService as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
    forceRecapture: true,
  });
  assert.equal(summary.status, "FAILED");
  const failed = Object.values(useDriftCaptureStore.getState().receipts)[0];
  assert.equal(failed?.captureFailed, true);
  assert.notEqual(failed?.verification, "SAVED_VERIFIED");
});

test("the batch reports what the run cost", async () => {
  const files = new FakeFiles();
  const summary = await captureOnce(files);
  assert.equal(summary.metrics.sessions, 1);
  assert.ok(summary.metrics.snapshotBytes > 0, "the committed bytes are counted");
  assert.ok(summary.metrics.durationMs >= 0);
  assert.equal(summary.metrics.rendererLongTasks, 0);
  assert.ok(Number.isFinite(summary.metrics.bytesPerSecond));

  const manifest = JSON.parse(
    files.files.get(`C:/vault/batches/${summary.batchId}/manifest.json`)!,
  );
  assert.equal(manifest.metrics.sessions, 1, "the manifest carries the metrics");
});

test("the metrics collector counts sessions, bytes and Host wait", () => {
  const collector = createDriftCaptureMetricsCollector();
  collector.start();
  collector.observeSession(120);
  collector.observeSession(80);
  collector.observeHostIo(15);
  const metrics = collector.stop();
  assert.equal(metrics.sessions, 2);
  assert.equal(metrics.snapshotBytes, 200);
  assert.equal(metrics.hostIoMs, 15);
  assert.equal(metrics.inputLatencySamples >= 0, true);
});

test("the utf-8 size check matches the encoded length", () => {
  for (const text of ["", "ascii", "café", "汉字", "😀 emoji", "mixed 😀 汉字 café"]) {
    assert.equal(utf8ByteLength(text), Buffer.byteLength(text, "utf8"), text);
  }
});
