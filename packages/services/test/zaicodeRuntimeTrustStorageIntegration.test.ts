import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStorageService } from "../src/storage/app/storageService.js";
import { createFsStorageCleaner } from "../src/storage/adapters/fsCleaner.js";
import type { StorageRootSpec } from "@zcode/shared";
import type { FsCleanerPort, ScanRunnerPort } from "../src/storage/app/ports.js";

const now = 1_700_000_000_000;
const old = { relativePath: "cli/agents/sess-old/sub-1/transcript.jsonl", bytes: 100, mtimeMs: now - 172_800_000 };
const root = { id: "zaicode", path: "V:/DISPOSABLE-NOT-USED", hasCustomDataBaseDir: false } as StorageRootSpec;
function fakeCleaner() {
  const deleted: string[] = [];
  const cleaner: FsCleanerPort = {
    listCandidates: async () => [old],
    deleteFiles: async (_path, targets, options) => {
      let skippedCount = 0;
      for (const candidate of targets) {
        if (options.canDelete && !await options.canDelete(candidate)) skippedCount++;
        else deleted.push(candidate.relativePath);
      }
      return { deletedCount: deleted.length, freedBytes: deleted.length * 100, failures: [], skippedCount };
    },
  };
  return { cleaner, deleted };
}
const idleRunner: ScanRunnerPort = { run: async () => ({ roots: [], errors: [] }) };

test("storage service: await root-bound runtime authority; missing, unknown and unavailable providers preserve transcripts", async () => {
  for (const provider of [undefined, async () => undefined, async () => { throw Error("unavailable"); }, async () => true]) {
    const fixture = fakeCleaner();
    const service = createStorageService({ roots: { resolveRoots: async () => [root] }, scanRunner: idleRunner,
      cleaner: fixture.cleaner, now: () => now, isSessionActive: provider });
    const result = await service.clean({ rootId: "zaicode", categoryId: "subagentTranscripts" });
    assert.equal(result.deletedCount, 0);
    assert.equal(result.skippedCount, 1);
    assert.deepEqual(fixture.deleted, []);
    service.dispose();
  }
});

test("storage service: activity changing after planning is rechecked before deletion", async () => {
  const fixture = fakeCleaner();
  let reads = 0;
  const service = createStorageService({ roots: { resolveRoots: async () => [root] }, scanRunner: idleRunner,
    cleaner: fixture.cleaner, now: () => now, isSessionActive: async (sessionId, actualRoot) => {
      assert.equal(sessionId, "sess-old"); assert.equal(actualRoot, root);
      return ++reads > 1;
    } });
  const result = await service.clean({ rootId: "zaicode", categoryId: "subagentTranscripts" });
  assert.equal(reads, 2);
  assert.equal(result.deletedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.deepEqual(fixture.deleted, []);
  service.dispose();
});

test("storage service: partial locked-file failure is reported; a repeated cleanup only sees remaining candidates", async () => {
  let lists = 0;
  const cleaner: FsCleanerPort = {
    listCandidates: async () => ++lists === 1 ? [old, { ...old, relativePath: "cli/agents/sess-old/sub-2/transcript.jsonl" }] : [old],
    deleteFiles: async (_path, targets) => ({ deletedCount: targets.length - 1, freedBytes: (targets.length - 1) * 100,
      failures: [{ path: old.relativePath, code: "EPERM" }] }),
  };
  const service = createStorageService({ roots: { resolveRoots: async () => [root] }, scanRunner: idleRunner,
    cleaner, now: () => now, isSessionActive: async () => false });
  const first = await service.clean({ rootId: "zaicode", categoryId: "subagentTranscripts" });
  assert.equal(first.deletedCount, 1); assert.equal(first.failures[0]!.code, "EPERM");
  const second = await service.clean({ rootId: "zaicode", categoryId: "subagentTranscripts" });
  assert.equal(second.deletedCount, 0); assert.equal(second.failures.length, 1);
  service.dispose();
});

test("storage scans: late root resolution cannot start an older scan over the newer request", async () => {
  let resolveFirst!: (roots: StorageRootSpec[]) => void;
  let calls = 0;
  const started: string[] = [];
  const service = createStorageService({ roots: { resolveRoots: () => ++calls === 1
    ? new Promise<StorageRootSpec[]>((resolve) => { resolveFirst = resolve; }) : Promise.resolve([root]) },
    scanRunner: { run: async (request) => { started.push(request.roots[0]!.path); return { roots: [], errors: [] }; } },
    cleaner: fakeCleaner().cleaner, now: () => now });
  const first = service.startScan();
  const second = await service.startScan();
  resolveFirst([ { ...root, path: "V:/OLDER-DISPOSABLE" } ]);
  await first;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [root.path]);
  assert.equal((await service.getSnapshot())?.jobId, second.jobId);
  service.dispose();
});

test("filesystem cleanup: replacing a candidate with identical mtime and size never deletes the replacement", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "zaicode-t322-replacement-"));
  try {
    await mkdir(join(testRoot, "logs"));
    const file = join(testRoot, "logs", "old.log");
    await writeFile(file, "original"); await utimes(file, 1000, 1000);
    const cleaner = createFsStorageCleaner();
    const candidates = await cleaner.listCandidates(testRoot, [{ prefix: "logs", recursive: false }]);
    await rename(file, join(testRoot, "logs", "held-original.log"));
    await writeFile(file, "replaced"); await utimes(file, 1000, 1000);
    const result = await cleaner.deleteFiles(testRoot, candidates, { keepDirectories: ["logs"] });
    assert.equal(result.deletedCount, 0); assert.equal(result.failures[0]!.code, "ECHANGED");
    assert.equal(await readFile(file, "utf8"), "replaced");
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
