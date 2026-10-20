import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../src/file/fileService.js";

// SAIHANDOFF: drift evidence is committed through the Host, not the renderer.
// The Host side must write atomically, hash without loading the file into
// memory, refuse to overwrite immutable evidence, and pack a real ZIP.

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-file-service-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("atomic writes create parents, replace on demand and refuse to overwrite", async () => {
  await withTempDir(async (dir) => {
    const files = createFileService();
    const target = join(dir, "nested", "deeper", "evidence.md");

    const written = await files.writeTextFileAtomic({ path: target, content: "first" });
    assert.equal(written.path, target);
    assert.equal(await readFile(target, "utf8"), "first");

    await assert.rejects(
      () => files.writeTextFileAtomic({ path: target, content: "second", overwrite: false }),
      /already exists/,
    );
    assert.equal(await readFile(target, "utf8"), "first", "immutable evidence is not replaced");

    await files.writeTextFileAtomic({ path: target, content: "second" });
    assert.equal(await readFile(target, "utf8"), "second");
  });
});

test("a failed atomic write leaves no half written file behind", async () => {
  await withTempDir(async (dir) => {
    const files = createFileService();
    const target = join(dir, "evidence.md");
    await files.writeTextFileAtomic({ path: target, content: "kept" });
    await assert.rejects(() =>
      files.writeTextFileAtomic({ path: target, content: "replaced", overwrite: false }),
    );
    const leftovers = (await readFile(target, "utf8")).length;
    assert.equal(leftovers, 4);
  });
});

test("the digest matches the bytes on disk and reports the real size", async () => {
  await withTempDir(async (dir) => {
    const files = createFileService();
    const target = join(dir, "big.bin");
    const payload = Buffer.alloc(1024 * 1024, 7);
    await writeFile(target, payload);

    const digest = await files.sha256File({ path: target });
    assert.equal(digest.size, payload.length);
    assert.equal(digest.sha256, createHash("sha256").update(payload).digest("hex"));
  });
});

test("a missing file fails the digest instead of reporting a zero hash", async () => {
  await withTempDir(async (dir) => {
    const files = createFileService();
    await assert.rejects(() => files.sha256File({ path: join(dir, "nope.md") }));
  });
});

test("copies are byte identical and never overwrite by default", async () => {
  await withTempDir(async (dir) => {
    const files = createFileService();
    const source = join(dir, "source.md");
    const target = join(dir, "out", "copy.md");
    await writeFile(source, "payload");

    const copied = await files.copyFile({ from: source, to: target, overwrite: false });
    assert.equal(copied.size, 7);
    assert.equal(await readFile(target, "utf8"), "payload");

    await assert.rejects(() => files.copyFile({ from: source, to: target, overwrite: false }));
    await files.copyFile({ from: source, to: target, overwrite: true });
  });
});

test("the zip archive is a real archive with the requested entries", async () => {
  await withTempDir(async (dir) => {
    const files = createFileService();
    const first = join(dir, "a.md");
    const second = join(dir, "b.md");
    await writeFile(first, "one");
    await writeFile(second, "two");

    const outPath = join(dir, "pack.zip");
    const zip = await files.createZipArchive({
      outPath,
      entries: [
        { name: "sessions/a.md", path: first },
        { name: "sessions/b.md", path: second },
      ],
    });
    assert.equal(zip.entries, 2);
    assert.ok(zip.size > 0);
    const bytes = await readFile(outPath);
    assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK");
    assert.match(bytes.toString("latin1"), /sessions\/a\.md/);
  });
});

test("deleting evidence removes single files only and reports what it did", async () => {
  await withTempDir(async (dir) => {
    const files = createFileService();
    const evidence = join(dir, "evidence.md");
    const metadata = join(dir, "metadata.json");
    await writeFile(evidence, "evidence");
    await writeFile(metadata, "{}");

    const result = await files.deleteFiles({
      paths: [evidence, metadata, join(dir, "gone.md"), "relative.md", dir],
    });
    assert.deepEqual(result.deleted, [evidence, metadata]);
    assert.deepEqual(result.missing, [join(dir, "gone.md")]);
    assert.equal(result.failed.length, 2, "a relative path and a directory are refused");
    assert.equal(result.failed[0]!.error.includes("non-absolute"), true);
    assert.equal(result.failed[1]!.error.includes("non-regular"), true);
    await assert.rejects(() => readFile(evidence, "utf8"), "the file is really gone");
  });
});
