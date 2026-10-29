import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareNativeSearchTools } from "./prepare-native-search-tools.mjs";
import { ARCHIVE_SOURCE_REVISION, resolveArchiveRequests, restoreArchiveSet } from "./restore-native-search-archives.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const payload = Buffer.from("offline archive fixture; never an executable");
const descriptor = { path: "ripgrep-v14.1.1-1/ripgrep-test.zip", sha256: digest(payload) };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "native-archive-restore-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("all six desktop targets plus legacy remote macOS resolve exactly 18 pinned archives", () => {
  const all = resolveArchiveRequests({ all: true });
  assert.equal(all.length, 18);
  assert.equal(new Set(all.map((item) => item.path)).size, 18);
  assert.equal(all.filter((item) => item.path.startsWith("ripgrep-v13.0.0-10/")).length, 2);
  assert.equal(resolveArchiveRequests({ platform: "win32", arch: "x64" }).length, 2);
  assert.equal(resolveArchiveRequests({ platform: "linux", arch: "arm64", remote: true }).length, 3);
  assert.throws(() => resolveArchiveRequests({ all: true, platform: "linux" }), /cannot select/);
});

test("offline restore pins the origin and source revision and verifies existing bytes", async (t) => {
  const root = fixture(t);
  const seen = [];
  const result = await restoreArchiveSet([descriptor], { dependenciesDir: root, download: async (url) => {
    seen.push(url);
    return payload;
  } });
  assert.deepEqual(result.restored, [descriptor.path]);
  assert.equal(seen[0], `https://raw.githubusercontent.com/vacterro/zaicode/${ARCHIVE_SOURCE_REVISION}/apps/zcode-cli/dependencies/native-search/${descriptor.path}`);
  assert.deepEqual(readFileSync(join(root, descriptor.path)), payload);
  const again = await restoreArchiveSet([descriptor], { dependenciesDir: root, download: async () => assert.fail("existing archive downloaded") });
  assert.deepEqual(again.restored, []);
  assert.equal(again.verified.length, 1);
});

test("a later download mismatch leaves every missing archive and directory unwritten", async (t) => {
  const root = join(fixture(t), "not-created");
  let requests = 0;
  await assert.rejects(restoreArchiveSet([descriptor, { ...descriptor, path: "bfs-v4.1.1-1/bfs-test.tar.gz" }], {
    dependenciesDir: root,
    download: async () => ++requests === 1 ? payload : Buffer.from("corrupt"),
  }), /Downloaded.*checksum mismatch/);
  assert.equal(requests, 2);
  assert.equal(existsSync(root), false);
});

test("modified existing archive is preserved and refuses before network access", async (t) => {
  const root = fixture(t);
  const destination = join(root, descriptor.path);
  mkdirSync(dirname(destination));
  writeFileSync(destination, "unreviewed existing bytes");
  await assert.rejects(restoreArchiveSet([descriptor], { dependenciesDir: root, download: async () => assert.fail("unexpected network") }), /Existing.*checksum mismatch/);
  assert.equal(readFileSync(destination, "utf8"), "unreviewed existing bytes");
});

test("path traversal and backslashes refuse without creating files", async (t) => {
  const root = fixture(t);
  for (const path of ["../escape.zip", "bfs/../../escape.zip", "C:/escape.zip", "bfs\\escape.zip", "/escape.zip"]) {
    await assert.rejects(restoreArchiveSet([{ ...descriptor, path }], { dependenciesDir: root, download: async () => assert.fail("unexpected network") }), /Unsafe.*path/);
  }
});

test("directory symlinks or Windows junctions never redirect recovery", async (t) => {
  const root = fixture(t);
  const outside = fixture(t);
  symlinkSync(outside, join(root, "ripgrep-v14.1.1-1"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(restoreArchiveSet([descriptor], { dependenciesDir: root, download: async () => assert.fail("unexpected network") }), /Unsafe.*directory/);
  assert.equal(existsSync(join(outside, "ripgrep-test.zip")), false);
});

test("a concurrent unreviewed destination is preserved rather than overwritten", async (t) => {
  const root = fixture(t);
  const destination = join(root, descriptor.path);
  await assert.rejects(restoreArchiveSet([descriptor], { dependenciesDir: root, download: async () => {
    mkdirSync(dirname(destination));
    writeFileSync(destination, "concurrent writer");
    return payload;
  } }), /Existing.*checksum mismatch/);
  assert.equal(readFileSync(destination, "utf8"), "concurrent writer");
});

test("a failed request writes no archive or dependency directory", async (t) => {
  const root = join(fixture(t), "not-created");
  await assert.rejects(restoreArchiveSet([descriptor], { dependenciesDir: root, download: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(existsSync(root), false);
});

test("production preparation still refuses missing and modified local archives", async (t) => {
  const root = fixture(t);
  const archivePath = join(root, "rg.zip");
  const prebuiltPlan = {
    platformKey: "win32-x64", outputDir: join(root, "output"),
    artifacts: [{ archivePath, archiveSha256: digest(payload) }],
  };
  await assert.rejects(prepareNativeSearchTools({ prebuiltPlan }), /Invalid local native search archive/);
  writeFileSync(archivePath, "modified archive");
  await assert.rejects(prepareNativeSearchTools({ prebuiltPlan }), /Invalid local native search archive/);
  assert.equal(existsSync(prebuiltPlan.outputDir), false);
});
