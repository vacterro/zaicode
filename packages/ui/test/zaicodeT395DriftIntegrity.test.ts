import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { exportDriftReviewPack } from "../src/zaicode/zaicodeSessionDriftCapture.js";
import {
  driftReceiptKey,
  useDriftCaptureStore,
  type DriftCaptureReceipt,
} from "../src/zaicode/zaicodeDriftCaptureStore.js";
import { MAX_REDACT_BYTES } from "../src/zaicode/zaicodeDriftCaptureSupport.js";

// SAIHANDOFF (T-395): the review pack must fail closed.
// A ZIP entry may only name a file that is really in the pack, and evidence
// that cannot be scanned for credentials is never copied unscanned.

type RipgrepEntry = { name: string; path: string };

class PackFilesDouble {
  readonly files = new Map<string, string>();
  readonly zips: Array<{ outPath: string; entries: RipgrepEntry[] }> = [];
  /** stat() reports this size instead of the real byte length. */
  readonly reportedSize = new Map<string, number>();
  readonly failReadRange = new Set<string>();
  readonly failReadText = new Set<string>();
  zipEntryCountOverride?: number;

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
    const size = this.reportedSize.get(path) ?? Buffer.byteLength(content!, "utf8");
    return { path, type: "file", size, mtimeMs: 0 };
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
    if (this.failReadText.has(path)) throw new Error(`read refused: ${path}`);
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
    if (this.failReadRange.has(path)) throw new Error(`read refused: ${path}`);
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
    entries: ReadonlyArray<RipgrepEntry>;
  }): Promise<{ path: string; size: number; entries: number }> {
    // A real Host archive reads every entry from its source path. Accepting a
    // path without checking it is what hid the broken metadata entry name.
    for (const entry of entries) {
      if (this.files.get(entry.path) === undefined) this.missing(entry.path);
    }
    this.zips.push({ outPath, entries: [...entries] });
    const body = `PK\u0003\u0004${entries.map((entry) => entry.name).join("\n")}`;
    this.files.set(outPath, body);
    // The Host returns the size it stat-ed after the rename, so the double must
    // report the same bytes it just stored.
    return {
      path: outPath,
      size: Buffer.byteLength(body, "utf8"),
      entries: this.zipEntryCountOverride ?? entries.length,
    };
  }
}

function seedReceipts(files: PackFilesDouble, count: number): DriftCaptureReceipt[] {
  const receipts: DriftCaptureReceipt[] = [];
  for (let index = 0; index < count; index += 1) {
    const sessionId = `s-${index}`;
    const workspacePath = "C:/projects/p0";
    const outputPath = `C:/vault/batches/b1/projects/p0-abc/sessions/${sessionId}/evidence.md`;
    const metadataPath = `C:/vault/batches/b1/projects/p0-abc/sessions/${sessionId}/metadata.json`;
    const content = `# session ${sessionId}\n\nhello drift\n`;
    files.files.set(outputPath, content);
    files.files.set(metadataPath, JSON.stringify({ sessionId }));
    files.files.set(`${outputPath.slice(0, outputPath.lastIndexOf("/"))}/sha256.txt`, "digest\n");
    receipts.push({
      sessionId,
      workspacePath,
      workspaceIdentity: "p0",
      batchId: "b1",
      capturedAt: "2026-10-20T00:00:00.000Z",
      messages: 1,
      characters: content.length,
      sha256: createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex"),
      watermarkUpdatedAt: 100,
      outputPath,
      metadataPath,
      verification: "SAVED_VERIFIED",
    });
  }
  const byKey: Record<string, DriftCaptureReceipt> = {};
  for (const receipt of receipts) {
    byKey[driftReceiptKey(receipt.sessionId, receipt.workspacePath, receipt.workspaceIdentity)] =
      receipt;
  }
  useDriftCaptureStore.setState({ receipts: byKey, activeBatch: null });
  return receipts;
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

test("zip entries name real pack files and the metadata entry is not double-prefixed", async () => {
  resetStore();
  const files = new PackFilesDouble();
  seedReceipts(files, 1);
  const pack = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    format: "zip",
    now: () => 1_700_000_000_000,
  });

  assert.equal(files.zips.length, 1);
  const [zip] = files.zips;
  assert.equal(zip!.outPath, `${pack.exportDir}.zip`);
  for (const entry of zip!.entries) {
    assert.ok(
      files.files.has(entry.path),
      `zip entry ${entry.name} points at a file that is really in the pack`,
    );
    assert.equal(entry.path, `${pack.exportDir}/${entry.name}`, "entry path mirrors entry name");
    assert.doesNotMatch(entry.name, /sessions\/sessions\//, "no doubled sessions prefix");
  }
  const metadataEntry = zip!.entries.find((entry) => entry.name.endsWith("/metadata.json"));
  assert.ok(metadataEntry, "the metadata file is in the archive");
  assert.match(metadataEntry!.name, /^sessions\/[^/]+\/s-[^/]+\/metadata\.json$/);
  assert.ok(files.files.has(`${pack.exportDir}/${metadataEntry!.name}`));
});

test("a multipart pack keeps every zip entry inside its own part", async () => {
  resetStore();
  const files = new PackFilesDouble();
  seedReceipts(files, 2);
  const pack = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    format: "zip",
    splitPartBytes: 1,
    now: () => 1_700_000_000_500,
  });
  assert.equal(pack.parts, 2);
  assert.equal(files.zips.length, 2);
  for (const [index, zip] of files.zips.entries()) {
    const partDir = `${pack.exportDir}/part-${String(index + 1).padStart(2, "0")}`;
    assert.equal(zip.outPath, `${partDir}.zip`);
    for (const entry of zip.entries) {
      assert.ok(files.files.has(entry.path), `missing source for ${entry.name}`);
      assert.equal(entry.path, `${partDir}/${entry.name}`);
    }
    assert.ok(
      zip.entries.some((entry) => entry.name.endsWith("/evidence.md")),
      "each part carries its own evidence",
    );
  }
});

test("a zip whose entry count disagrees with the request is refused", async () => {
  resetStore();
  const files = new PackFilesDouble();
  seedReceipts(files, 1);
  files.zipEntryCountOverride = 2;
  await assert.rejects(
    () =>
      exportDriftReviewPack({
        fileService: files as never,
        vaultRoot: "C:/vault",
        format: "zip",
        now: () => 1_700_000_002_000,
      }),
    /expected/,
  );
});

test("a clean source is scanned and copied exactly, not claimed as redacted", async () => {
  resetStore();
  const files = new PackFilesDouble();
  seedReceipts(files, 1);
  const pack = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    now: () => 1_700_000_003_000,
  });
  assert.equal(pack.sessions, 1);
  assert.equal(pack.problems, 0);
  const manifest = JSON.parse(files.files.get(`${pack.exportDir}/manifest.json`)!);
  const session = manifest.sessions[0];
  assert.equal(session.redaction, "SCANNED_UNCHANGED");
  assert.equal(session.sourceSha256, session.sha256, "a clean scan keeps the source digest");
  assert.equal(manifest.redaction.requested, true);
  assert.equal(manifest.redaction.mode, "pattern-scan");
  assert.equal(manifest.redaction.unscannedCopies, "excluded");
  assert.match(files.files.get(`${pack.exportDir}/index.md`)!, /scanned, no secrets/);
});

test("a credential-bearing source is redacted and its packed digest changes", async () => {
  resetStore();
  const files = new PackFilesDouble();
  const [receipt] = seedReceipts(files, 1);
  const secret = "sk-abcdefghijklmnopqrstuvwx";
  const content = `# session\n\ntoken ${secret}\n`;
  files.files.set(receipt!.outputPath, content);
  receipt!.sha256 = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

  const pack = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    now: () => 1_700_000_004_000,
  });
  assert.equal(pack.sessions, 1);
  const manifest = JSON.parse(files.files.get(`${pack.exportDir}/manifest.json`)!);
  const session = manifest.sessions[0];
  assert.equal(session.redaction, "REDACTED");
  assert.notEqual(session.sha256, session.sourceSha256);
  const packed = files.files.get(`${pack.exportDir}/${session.evidence}`)!;
  assert.doesNotMatch(packed, /sk-abcdefghijklmnopqrstuvwx/);
  assert.match(packed, /\[REDACTED_TOKEN\]/);
});

test("an oversize source is excluded with a visible reason instead of copied unscanned", async () => {
  resetStore();
  const files = new PackFilesDouble();
  const [receipt] = seedReceipts(files, 1);
  files.reportedSize.set(receipt!.outputPath, MAX_REDACT_BYTES + 1);

  const pack = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    now: () => 1_700_000_005_000,
  });
  assert.equal(pack.sessions, 0);
  assert.equal(pack.problems, 1);
  const manifest = JSON.parse(files.files.get(`${pack.exportDir}/manifest.json`)!);
  assert.equal(manifest.sessions.length, 0);
  assert.equal(manifest.problems[0].reason, "REDACTION_SKIPPED_OVERSIZE");
  assert.equal(manifest.coverage.sessions.redactionSkippedOversize, 1);
  assert.match(files.files.get(`${pack.exportDir}/missing-sources.md`)!, /REDACTION_SKIPPED_OVERSIZE/);
  const evidenceCopies = [...files.files.keys()].filter(
    (path) => path.startsWith(pack.exportDir) && path.endsWith("evidence.md"),
  );
  assert.equal(evidenceCopies.length, 0, "no unscanned evidence copy exists");
});

test("a read failure during the scan excludes the source", async () => {
  resetStore();
  const files = new PackFilesDouble();
  const [receipt] = seedReceipts(files, 1);
  files.failReadRange.add(receipt!.outputPath);

  const pack = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    now: () => 1_700_000_006_000,
  });
  assert.equal(pack.sessions, 0);
  const manifest = JSON.parse(files.files.get(`${pack.exportDir}/manifest.json`)!);
  assert.equal(manifest.problems[0].reason, "REDACTION_FAILED");
  assert.equal(manifest.coverage.sessions.redactionFailed, 1);
});

test("an explicit unredacted export carries an unscannable source and says so", async () => {
  resetStore();
  const files = new PackFilesDouble();
  const [receipt] = seedReceipts(files, 1);
  files.reportedSize.set(receipt!.outputPath, MAX_REDACT_BYTES + 1);

  const pack = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    allowUnredactedSources: true,
    now: () => 1_700_000_007_000,
  });
  assert.equal(pack.sessions, 1, "the operator authorization is honored");
  const manifest = JSON.parse(files.files.get(`${pack.exportDir}/manifest.json`)!);
  assert.equal(manifest.sessions[0].redaction, "UNREDACTED_AUTHORIZED");
  assert.equal(manifest.redaction.unscannedCopies, "operator-authorized");
  assert.match(files.files.get(`${pack.exportDir}/index.md`)!, /operator explicitly authorized/);
});

test("disabling redaction is reported as disabled, never as a clean scan", async () => {
  resetStore();
  const files = new PackFilesDouble();
  seedReceipts(files, 1);
  const pack = await exportDriftReviewPack({
    fileService: files as never,
    vaultRoot: "C:/vault",
    redactCredentials: false,
    now: () => 1_700_000_008_000,
  });
  const manifest = JSON.parse(files.files.get(`${pack.exportDir}/manifest.json`)!);
  assert.equal(manifest.sessions[0].redaction, "DISABLED");
  assert.equal(manifest.redaction.mode, "disabled");
  assert.match(files.files.get(`${pack.exportDir}/index.md`)!, /Redaction was disabled/);
});
