import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  captureAllSessionDriftDetailed,
  exportDriftReviewPack,
} from "../src/zaicode/zaicodeSessionDriftCapture.js";
import { publishZaicodeKnownProjects } from "../src/zaicode/zaicodeScheduler.js";
import { useDriftCaptureStore } from "../src/zaicode/zaicodeDriftCaptureStore.js";
import { useZaicodeDisabledProjects } from "../src/zaicode/zaicodeProjectSwitch.js";

// SAIHANDOFF: a capture batch must report partial discovery as partial, keep a
// durable record of what failed, refuse to run twice, and export a review pack
// that carries the real evidence files.

class FakeFiles {
  readonly files = new Map<string, string>();
  readonly zips: Array<{ outPath: string; entries: Array<{ name: string; path: string }> }> = [];

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

  async copyFile({
    from,
    to,
    overwrite = true,
  }: {
    from: string;
    to: string;
    overwrite?: boolean;
  }): Promise<{ path: string; size: number }> {
    const content = this.files.get(from);
    if (content === undefined) this.missing(from);
    if (!overwrite && this.files.has(to)) throw new Error(`File already exists: ${to}`);
    this.files.set(to, content!);
    return { path: to, size: Buffer.byteLength(content!, "utf8") };
  }

  async createZipArchive({
    outPath,
    entries,
  }: {
    outPath: string;
    entries: ReadonlyArray<{ name: string; path: string }>;
  }): Promise<{ path: string; size: number; entries: number }> {
    // A real Host archive reads every entry from its source path; a double that
    // accepts a path without checking it hides exactly the broken-name class of
    // bug this suite must catch.
    for (const entry of entries) {
      if (this.files.get(entry.path) === undefined) this.missing(entry.path);
    }
    const names = new Set(entries.map((entry) => entry.name));
    if (names.size !== entries.length) throw new Error("duplicate zip entry name");
    this.zips.push({ outPath, entries: [...entries] });
    const body = entries.map((entry) => entry.name).join("\n");
    this.files.set(outPath, `PK\u0003\u0004${body}`);
    return { path: outPath, size: body.length, entries: entries.length };
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

function publishProjects(count: number): void {
  publishZaicodeKnownProjects(
    Array.from({ length: count }, (_, index) => ({
      path: `C:/projects/p${index}`,
      identity: `p${index}`,
      key: `p${index}`,
      name: `p${index}`,
    })),
  );
}

function snapshotFor(target: { sessionId: string; workspacePath: string; workspaceIdentity?: string }) {
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
  };
}

const sessionService = (
  failingProjects: ReadonlySet<string>,
  options: { failReads?: boolean } = {},
) => ({
  listSessions: async ({ workspacePath }: { workspacePath: string }) => {
    if (failingProjects.has(workspacePath)) throw new Error("listSessions failed");
    return [
      {
        sessionId: `s-${workspacePath.replace(/\W/g, "")}`,
        workspace: { workspacePath, workspaceIdentity: workspacePath },
        updatedAt: 100,
      },
    ];
  },
  readSession: async (target: { sessionId: string; workspacePath: string; workspaceIdentity?: string }) => {
    if (options.failReads) throw new Error("session read failed");
    return snapshotFor(target);
  },
});

test("a batch with 3 failed projects is PARTIAL and keeps every failure receipt", async () => {
  resetStore();
  publishProjects(24);
  const failing = new Set(["C:/projects/p21", "C:/projects/p22", "C:/projects/p23"]);
  const files = new FakeFiles();
  const summary = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: sessionService(failing) as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });

  assert.equal(summary.discovery.status, "PARTIAL");
  assert.equal(summary.discovery.failedProjects, 3);
  assert.equal(summary.discovery.selectedProjects.length, 24);
  assert.equal(summary.status, "PARTIAL");

  const manifest = JSON.parse(
    files.files.get(`C:/vault/batches/${summary.batchId}/manifest.json`)!,
  );
  assert.equal(manifest.status, "PARTIAL");
  assert.equal(manifest.selectedProjects.length, 24);
  assert.equal(
    manifest.projects.filter((p: { status: string }) => p.status === "DISCOVERY_FAILED").length,
    3,
  );
  assert.equal(manifest.discovery.failedProjects, 3);
  assert.equal(manifest.captureMethod, "disk-verified");
});

test("a failed session never produces a saved receipt", async () => {
  resetStore();
  publishProjects(1);
  const files = new FakeFiles();
  const summary = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: sessionService(new Set(), { failReads: true }) as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  assert.equal(summary.status, "FAILED");
  const receipts = Object.values(useDriftCaptureStore.getState().receipts);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].captureFailed, true);
  assert.notEqual(receipts[0].verification, "SAVED_VERIFIED");
});

test("a second window cannot capture while another window holds the lease", async () => {
  resetStore();
  publishProjects(1);
  const files = new FakeFiles();
  const storage = new MemoryStorage();
  storage.setItem(
    "zaicode-drift-capture-lease",
    JSON.stringify({ ownerId: "owner-b", batchId: "other", expiresAt: Date.now() + 60_000 }),
  );
  await assert.rejects(
    () =>
      captureAllSessionDriftDetailed({
        fileService: files as never,
        sessionService: sessionService(new Set()) as never,
        vaultRoot: "C:/vault",
        leaseStorage: storage as never,
        ownerId: "owner-a",
        includeProtocolContext: false,
      }),
    /another window/,
  );
});

test("a malformed capture index is quarantined instead of destroyed", async () => {
  resetStore();
  publishProjects(1);
  const files = new FakeFiles();
  files.files.set("C:/vault/capture-index.json", "{ this is not json");
  const summary = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: sessionService(new Set()) as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  const quarantine = [...files.files.keys()].filter((key) =>
    key.startsWith("C:/vault/capture-index.corrupt-"),
  );
  assert.equal(quarantine.length, 1);
  assert.equal(files.files.get(quarantine[0]!), "{ this is not json");
  const index = JSON.parse(files.files.get("C:/vault/capture-index.json")!);
  assert.equal(index.batches.length, 1);
  assert.equal(index.batches[0].batchId, summary.batchId);
  assert.deepEqual(index.quarantined, [quarantine[0]!.split("/").pop()]);
});

test("the review pack reports a failed capture instead of an empty success", async () => {
  resetStore();
  publishProjects(1);
  const files = new FakeFiles();
  const summary = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: sessionService(new Set(), { failReads: true }) as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  // The capture failed in this fixture, so the pack reports it instead of
  // pretending the evidence exists.
  const pack = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    now: () => 1_700_000_000_000,
  });
  assert.equal(pack.sessions, 0);
  assert.equal(pack.problems, 1);
  const manifest = JSON.parse(files.files.get(`${pack.exportDir}/manifest.json`)!);
  assert.equal(manifest.sessions.length, 0);
  assert.equal(manifest.problems[0].reason, "CAPTURE_FAILED");
  assert.match(files.files.get(`${pack.exportDir}/missing-sources.md`)!, /CAPTURE_FAILED/);
  assert.equal(summary.batchId.length > 0, true);
});

test("the review pack copies a verified session and records its digest", async () => {
  resetStore();
  publishProjects(1);
  const files = new FakeFiles();
  await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: sessionService(new Set()) as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });

  const pack = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    now: () => 1_700_000_000_000,
  });
  assert.equal(pack.sessions, 1);
  assert.equal(pack.problems, 0);
  const manifest = JSON.parse(files.files.get(`${pack.exportDir}/manifest.json`)!);
  const session = manifest.sessions[0];
  assert.ok(session.evidence.startsWith("sessions/"), "the pack stores relative paths");
  assert.doesNotMatch(session.evidence, /^[A-Za-z]:/);
  const packed = files.files.get(`${pack.exportDir}/${session.evidence}`)!;
  assert.match(packed, /hello drift/, "the pack carries the real transcript");
  assert.equal(
    createHash("sha256").update(Buffer.from(packed, "utf8")).digest("hex"),
    session.sha256,
    "the manifest digest matches the packed file",
  );
  assert.equal(session.sourceSha256, session.sha256, "an unredacted copy keeps the source digest");
  assert.ok(files.files.has(`${pack.exportDir}/verify.mjs`));
  assert.ok(files.files.has(`${pack.exportDir}/checksums.sha256.txt`));
  assert.match(files.files.get(`${pack.exportDir}/index.md`)!, /self-contained/);
});

// ── Settings scope, attachment policy and load ─────────────────────────────

function snapshotWithFilePart(
  target: { sessionId: string; workspacePath: string; workspaceIdentity?: string },
  url: string,
) {
  const base = snapshotFor(target);
  return {
    ...base,
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
            type: "file",
            partId: "p-1",
            mime: "image/png",
            filename: "shot.png",
            url,
            sessionId: target.sessionId,
            messageId: "m-1",
          },
        ],
      },
    ],
  };
}

function multiSessionService(
  sessionsPerProject: number,
  options: { kinds?: readonly string[]; attachmentUrl?: string } = {},
) {
  return {
    listSessions: async ({ workspacePath }: { workspacePath: string }) =>
      Array.from({ length: sessionsPerProject }, (_, index) => ({
        sessionId: `s-${workspacePath.replace(/\W/g, "")}-${index}`,
        workspace: { workspacePath, workspaceIdentity: workspacePath },
        updatedAt: 100,
        sessionKind: options.kinds?.[index] ?? "interactive",
      })),
    readSession: async (target: {
      sessionId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }) =>
      options.attachmentUrl
        ? snapshotWithFilePart(target, options.attachmentUrl)
        : snapshotFor(target),
  };
}

test("a project switched off is skipped by policy and never breaks the batch", async () => {
  resetStore();
  publishProjects(2);
  useZaicodeDisabledProjects.setState({ keys: ["p0"] });
  const files = new FakeFiles();
  try {
    const summary = await captureAllSessionDriftDetailed({
      fileService: files as never,
      sessionService: sessionService(new Set()) as never,
      vaultRoot: "C:/vault",
      leaseStorage: new MemoryStorage() as never,
      ownerId: "owner-a",
      includeProtocolContext: false,
      includeDisabledProjects: false,
    });
    assert.equal(summary.discovery.status, "COMPLETE");
    assert.equal(summary.discovery.failedProjects, 0);
    assert.equal(summary.discovery.skippedProjects.length, 1);
    assert.equal(summary.discovery.skippedProjects[0]!.projectPath, "C:/projects/p0");
    assert.equal(summary.total, 1, "the switched-off project contributes no session");
  } finally {
    useZaicodeDisabledProjects.setState({ keys: [] });
  }
});

test("helper sessions are skipped by policy and the batch stays complete", async () => {
  resetStore();
  publishProjects(1);
  const files = new FakeFiles();
  const service = multiSessionService(2, { kinds: ["interactive", "workflow_child"] });
  const summary = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: service as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
    includeHelperSessions: false,
    mainSessionIds: { p0: "s-Cprojectsp0-0" },
  });
  assert.equal(summary.discovery.status, "COMPLETE");
  assert.equal(summary.total, 1, "only the MAIN session is captured");
  const receipt = summary.discovery.receipts[0]!;
  assert.equal(receipt.skippedSessions, 1);
  assert.equal(receipt.discoveredSessions, 1);
});

test("the attachment reference policy decides what the evidence carries", async () => {
  resetStore();
  publishProjects(1);
  const inline = "data:image/png;base64,QUJDREVGRw==";
  const kept = new FakeFiles();
  await captureAllSessionDriftDetailed({
    fileService: kept as never,
    sessionService: multiSessionService(1, { attachmentUrl: inline }) as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
    captureAttachmentsByReference: true,
  });
  const withReference = [...kept.files.entries()].find(([path]) => path.endsWith("evidence.md"))!;
  assert.match(withReference[1], /Attachment reference \(bytes not inlined\)/);

  resetStore();
  publishProjects(1);
  const dropped = new FakeFiles();
  await captureAllSessionDriftDetailed({
    fileService: dropped as never,
    sessionService: multiSessionService(1, { attachmentUrl: inline }) as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
    captureAttachmentsByReference: false,
  });
  const withoutReference = [...dropped.files.entries()].find(([path]) =>
    path.endsWith("evidence.md"),
  )!;
  assert.doesNotMatch(withoutReference[1], /Attachment reference \(bytes not inlined\)/);
  assert.doesNotMatch(withoutReference[1], /QUJDREVGRw/, "the inline payload is never written");
});

test("a pack carries local attachments only when the binary opt-in is on", async () => {
  resetStore();
  publishProjects(1);
  const files = new FakeFiles();
  files.files.set("C:/projects/p0/shot.png", "PNGDATA");
  await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: multiSessionService(1, { attachmentUrl: "C:/projects/p0/shot.png" }) as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });

  const referenceOnly = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    now: () => 1_700_000_000_000,
  });
  const referenceManifest = JSON.parse(files.files.get(`${referenceOnly.exportDir}/manifest.json`)!);
  assert.equal(referenceManifest.coverage.binaryAttachments, "references-only");
  assert.equal(referenceManifest.sessions[0].attachments, undefined);

  const withBinaries = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    now: () => 1_700_000_001_000,
    exportBinaryAttachments: true,
  });
  const binaryManifest = JSON.parse(files.files.get(`${withBinaries.exportDir}/manifest.json`)!);
  const attachment = binaryManifest.sessions[0].attachments[0];
  assert.ok(attachment.sha256, "the copied attachment carries its digest");
  assert.equal(files.files.get(`${withBinaries.exportDir}/${attachment.name}`), "PNGDATA");
});

test("24 projects with 100 sessions load in one batch", async () => {
  resetStore();
  publishProjects(24);
  const files = new FakeFiles();
  // 4 projects with 5 sessions and 20 with 4: 100 sessions in total.
  const service = {
    listSessions: async ({ workspacePath }: { workspacePath: string }) => {
      const index = Number(/p(\d+)$/.exec(workspacePath)?.[1] ?? 0);
      const count = index < 4 ? 5 : 4;
      return Array.from({ length: count }, (_, session) => ({
        sessionId: `s-${workspacePath.replace(/\W/g, "")}-${session}`,
        workspace: { workspacePath, workspaceIdentity: workspacePath },
        updatedAt: 100,
        sessionKind: "interactive",
      }));
    },
    readSession: async (target: {
      sessionId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }) => snapshotFor(target),
  };
  const summary = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: service as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  assert.equal(summary.discovery.selectedProjects.length, 24);
  assert.equal(summary.total, 100);
  assert.equal(summary.status, "COMPLETE");
  assert.equal(Object.keys(useDriftCaptureStore.getState().receipts).length, 100);
});

test("a 1000 session stress fixture still commits every session", async () => {
  resetStore();
  publishProjects(20);
  const files = new FakeFiles();
  const summary = await captureAllSessionDriftDetailed({
    fileService: files as never,
    sessionService: multiSessionService(50) as never,
    vaultRoot: "C:/vault",
    leaseStorage: new MemoryStorage() as never,
    ownerId: "owner-a",
    includeProtocolContext: false,
  });
  assert.equal(summary.total, 1000);
  assert.equal(summary.committed, 1000);
  assert.equal(summary.status, "COMPLETE");
  assert.equal(Object.keys(useDriftCaptureStore.getState().receipts).length, 1000);
});
