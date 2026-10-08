import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectBuildMetadata,
  collectSourceIdentity,
} from "../packages/desktop/scripts/build-metadata.mjs";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "zaicode-source-identity-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  mkdirSync(join(cwd, "packages"));
  writeFileSync(join(cwd, "packages", "source.ts"), "export const value = 1;\n");
  git("add", "packages/source.ts");
  git(
    "-c",
    "user.name=Identity Test",
    "-c",
    "user.email=identity@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  return { cwd, git };
}

test("metadata exposes full source revision, package identity and declared channel", () => {
  const metadata = collectBuildMetadata();
  assert.match(metadata.sourceRevision, /^[a-f0-9]{40}$/);
  assert.match(metadata.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.match(metadata.runtimePackageIdentity, /^zaicode-[a-f0-9]{64}$/);
  assert.ok(["local", "stable", "test", "development"].includes(metadata.updateChannel));
  assert.equal(typeof metadata.workingTreeDirty, "boolean");
  assert.equal(metadata.buildCommitId, metadata.sourceRevision.slice(0, 8));
});

test("new source and changed tracked bytes change fingerprint even without changing HEAD", () => {
  const { cwd, git } = fixture();
  const clean = collectSourceIdentity(cwd);
  assert.equal(clean.workingTreeDirty, false);
  writeFileSync(join(cwd, "packages", "new.ts"), "export const newValue = 2;\n");
  const added = collectSourceIdentity(cwd);
  assert.equal(added.sourceRevision, clean.sourceRevision);
  assert.equal(added.workingTreeDirty, true);
  assert.notEqual(added.sourceFingerprint, clean.sourceFingerprint);
  writeFileSync(join(cwd, "packages", "source.ts"), "export const value = 3;\n");
  const modified = collectSourceIdentity(cwd);
  assert.notEqual(modified.sourceFingerprint, added.sourceFingerprint);
  assert.equal(collectSourceIdentity(cwd).sourceFingerprint, modified.sourceFingerprint);
  assert.equal(
    git("status", "--porcelain").includes("new.ts"),
    true,
    "probe must not stage or commit",
  );
});

test("a build that rewrites a tracked file with other line endings leaves the tree clean", () => {
  const { cwd, git } = fixture();
  writeFileSync(join(cwd, "packages", "types.d.ts"), "export type A = 1;\r\nexport type B = 2;\r\n");
  git("-c", "core.autocrlf=false", "add", "packages/types.d.ts");
  git("-c", "user.name=Identity Test", "-c", "user.email=identity@example.invalid", "commit", "--quiet", "-m", "types");
  writeFileSync(join(cwd, "packages", "types.d.ts"), "export type A = 1;\nexport type B = 2;\n");
  assert.equal(collectSourceIdentity(cwd).workingTreeDirty, false, "the installed launcher would warn on every start");
  writeFileSync(join(cwd, "packages", "types.d.ts"), "export type A = 3;\nexport type B = 2;\n");
  assert.equal(collectSourceIdentity(cwd).workingTreeDirty, true);
});

test("Git absence never manufactures clean source provenance", () => {
  const cwd = mkdtempSync(join(tmpdir(), "zaicode-no-git-"));
  const identity = collectSourceIdentity(cwd);
  assert.equal(identity.sourceRevision, "unknown");
  assert.equal(identity.sourceFingerprint, "unknown");
  assert.equal(identity.workingTreeDirty, null);
});
