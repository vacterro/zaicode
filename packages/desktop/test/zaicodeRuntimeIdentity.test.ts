import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { collectSourceIdentity } from "../scripts/build-metadata.mjs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  projectZaicodeRuntimeIdentity,
  readZaicodeRuntimeIdentity,
} from "../src/main/zaicodeRuntimeIdentity.js";
import { ZaicodeSubscriptionProxy } from "../src/main/zaicodeSubscriptionProxy.js";

const revision = "a".repeat(40);
const metadata = {
  appVersion: "3.14.0",
  buildCommitId: "aaaaaaaa",
  sourceRevision: revision,
  buildTime: "2026-10-05T01:00:00.000Z",
  updateChannel: "local",
  runtimePackageIdentity: "zaicode-" + "b".repeat(64),
  workingTreeDirty: false,
  sourceFingerprint: "d".repeat(64),
};
const runtime = {
  executablePath: "V:/isolated/ZAICODE.exe",
  resourcesPath: "V:/isolated/resources",
  packaged: true,
};

test("runtime identity never substitutes current checkout revision for packaged source", () => {
  const value = projectZaicodeRuntimeIdentity(metadata, runtime, {
    revision: "c".repeat(40),
    dirty: false,
    newer: true,
  });
  assert.equal(value.sourceRevision, revision);
  assert.equal(value.source.status, "SOURCE_NEWER");
  assert.equal(value.source.revision, "c".repeat(40));
  assert.equal(value.runtimePackageIdentity, metadata.runtimePackageIdentity);
  assert.equal(value.updateChannel, "local");
});

test("same HEAD is not proof of parity when source or package has dirty provenance", () => {
  assert.equal(
    projectZaicodeRuntimeIdentity(metadata, runtime, { revision, dirty: true }).source.status,
    "SOURCE_DIRTY",
  );
  assert.equal(
    projectZaicodeRuntimeIdentity({ ...metadata, workingTreeDirty: true }, runtime, {
      revision,
      dirty: false,
    }).source.status,
    "UNVERIFIED_DIRTY_BUILD",
  );
  assert.equal(
    projectZaicodeRuntimeIdentity(metadata, runtime, { revision, dirty: false }).source.status,
    "MATCH",
  );
});

test("missing metadata and unavailable checkout are explicit rather than fake equality", () => {
  const missing = projectZaicodeRuntimeIdentity(null, runtime, null);
  assert.equal(missing.sourceRevision, "unknown");
  assert.equal(missing.runtimePackageIdentity, "unknown");
  assert.equal(missing.source.status, "METADATA_UNAVAILABLE");
  assert.equal(
    projectZaicodeRuntimeIdentity(metadata, runtime, null).source.status,
    "SOURCE_UNAVAILABLE",
  );
});

test("legacy short revision without package identity remains visibly unverified", () => {
  const result = projectZaicodeRuntimeIdentity(
    { appVersion: "3.14.0", buildCommitId: "aaaaaaaa", buildTime: metadata.buildTime },
    runtime,
    { revision, dirty: false },
  );
  assert.equal(result.source.status, "METADATA_INCOMPLETE");
});

test("packaged reader uses immutable metadata file and reports missing source without launching anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "zaicode-identity-"));
  const metadataPath = join(root, "build-meta.json");
  await writeFile(metadataPath, JSON.stringify(metadata));
  const value = await readZaicodeRuntimeIdentity({ ...runtime, metadataPath, installRoot: null });
  assert.equal(value.sourceRevision, revision);
  assert.equal(value.source.status, "SOURCE_UNAVAILABLE");
  assert.equal(value.version, "3.14.0");
  await mkdir(join(root, "empty-checkout"));
});

test("machine endpoint is read-only and requires existing inference proxy authentication", async () => {
  const identity = projectZaicodeRuntimeIdentity(metadata, runtime, null);
  let routeCalls = 0;
  const proxy = new ZaicodeSubscriptionProxy({
    routerUrl: () => "http://127.0.0.1:1",
    routerKey: async () => null,
    call: async () => {
      throw new Error("identity must not call router");
    },
    token: "identity-test-token",
    route: async () => {
      routeCalls++;
      return null;
    },
    runtimeIdentity: async () => identity,
  });
  await proxy.listen();
  try {
    assert.equal((await fetch(`${proxy.url}/runtime-identity`)).status, 401);
    assert.equal(
      (await fetch(`${proxy.url}/runtime-identity`, { headers: { authorization: "Bearer wrong" } }))
        .status,
      401,
    );
    const result = await fetch(`${proxy.url}/runtime-identity`, {
      headers: { authorization: "Bearer identity-test-token" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), identity);
    assert.equal(
      (
        await fetch(`${proxy.url}/runtime-identity`, {
          method: "POST",
          headers: { authorization: "Bearer identity-test-token" },
        })
      ).status,
      405,
    );
    assert.equal(routeCalls, 0);
  } finally {
    await proxy.close();
  }
});

test("dirty source parity requires matching full source bytes, not just HEAD", () => {
  const dirty = { ...metadata, workingTreeDirty: true };
  assert.equal(
    projectZaicodeRuntimeIdentity(dirty, runtime, {
      revision,
      dirty: true,
      fingerprint: metadata.sourceFingerprint,
    }).source.status,
    "MATCH",
  );
  assert.equal(
    projectZaicodeRuntimeIdentity(dirty, runtime, {
      revision,
      dirty: true,
      fingerprint: "e".repeat(64),
    }).source.status,
    "SOURCE_DIRTY",
  );
  assert.equal(
    projectZaicodeRuntimeIdentity(dirty, runtime, {
      revision,
      dirty: false,
      fingerprint: "e".repeat(64),
    }).source.status,
    "SOURCE_DIFFERENT",
  );
});

test("malformed metadata stays readable and cannot claim parity", async () => {
  const root = await mkdtemp(join(tmpdir(), "zaicode-bad-identity-"));
  const metadataPath = join(root, "build-meta.json");
  await writeFile(
    metadataPath,
    JSON.stringify({
      ...metadata,
      sourceRevision: 7,
      appVersion: {},
      workingTreeDirty: "false",
      runtimePackageIdentity: "unknown",
    }),
  );
  const result = await readZaicodeRuntimeIdentity({ ...runtime, metadataPath, installRoot: null });
  assert.equal(result.sourceRevision, "unknown");
  assert.equal(result.version, "unknown");
  assert.equal(result.workingTreeDirty, null);
  assert.equal(result.source.status, "METADATA_INCOMPLETE");
});

test("runtime async fingerprint equals builder fingerprint and notices edited bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "zaicode-source-parity-"));
  const cwd = join(root, "zcode");
  await mkdir(join(cwd, "packages"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  await writeFile(join(cwd, "packages", "source.ts"), "export const value = 1;\n");
  git("add", "packages/source.ts");
  git(
    "-c",
    "user.name=Parity",
    "-c",
    "user.email=parity@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  await writeFile(join(cwd, "packages", "new.ts"), "export const fresh = 2;\n");
  const source = collectSourceIdentity(cwd);
  const metadataPath = join(root, "build-meta.json");
  await writeFile(metadataPath, JSON.stringify({ ...metadata, ...source }));
  const input = { ...runtime, metadataPath, installRoot: root };
  assert.equal((await readZaicodeRuntimeIdentity(input)).source.status, "MATCH");
  await writeFile(join(cwd, "packages", "new.ts"), "export const fresh = 3;\n");
  assert.equal((await readZaicodeRuntimeIdentity(input)).source.status, "SOURCE_DIRTY");
});
