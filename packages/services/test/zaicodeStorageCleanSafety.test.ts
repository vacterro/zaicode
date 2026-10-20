import assert from "node:assert/strict";
import { lstatSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFsStorageCleaner } from "../src/storage/adapters/fsCleaner.js";
import { planStorageClean } from "../src/storage/domain/cleanPlan.js";

test("storage clean safety: plan preserves active sessions, undeterminable mtime, and protected items", () => {
  const now = 1_700_000_000_000;
  const context = { rootId: "zaicode" as const, hasCustomDataBaseDir: false };

  // 1. Subagent transcripts with active session hook
  const subagentCandidates = [
    { relativePath: "cli/agents/sess-active/sub-1/transcript.jsonl", bytes: 100, mtimeMs: now - 100_000_000 },
    { relativePath: "cli/agents/sess-idle/sub-2/transcript.jsonl", bytes: 200, mtimeMs: now - 100_000_000 },
    { relativePath: "cli/agents/sess-recent/sub-3/transcript.jsonl", bytes: 300, mtimeMs: now - 10_000 },
    { relativePath: "cli/agents/sess-future/sub-4/transcript.jsonl", bytes: 400, mtimeMs: now + 50_000 },
    { relativePath: "cli/agents/sess-invalid/sub-5/transcript.jsonl", bytes: 500, mtimeMs: 0 },
  ];

  const plan = planStorageClean({
    categoryId: "subagentTranscripts",
    candidates: subagentCandidates,
    context,
    now,
    isSessionActive: (id) => id === "sess-active",
  });

  // sess-active must be preserved (hook)
  // sess-recent must be preserved (mtime < 24h)
  // sess-future must be preserved (invalid future timestamp)
  // sess-invalid must be preserved (invalid <= 0 timestamp)
  // Only sess-idle qualifies
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].relativePath, "cli/agents/sess-idle/sub-2/transcript.jsonl");
  assert.equal(plan.skippedCount, 4);
});

test("storage clean safety: logs category preserves same-day logs and future timestamps", () => {
  // Use a fixed timestamp and explicitly offset by 48 hours for previous day to avoid timezone boundaries
  const now = new Date("2026-10-13T12:00:00Z").getTime();
  const twoDaysAgo = now - 48 * 60 * 60 * 1000;
  const context = { rootId: "zaicode" as const, hasCustomDataBaseDir: false };

  const candidates = [
    { relativePath: "logs/today.log", bytes: 100, mtimeMs: now - 1000 },
    { relativePath: "logs/twodaysago.log", bytes: 200, mtimeMs: twoDaysAgo },
    { relativePath: "logs/future.log", bytes: 300, mtimeMs: now + 1_000_000 },
    { relativePath: "logs/invalid.log", bytes: 400, mtimeMs: 0 },
  ];

  const plan = planStorageClean({
    categoryId: "logs",
    candidates,
    context,
    now,
  });

  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].relativePath, "logs/twodaysago.log");
  assert.equal(plan.skippedCount, 3);
});

test("storage clean safety: TOCTOU deletion-time verification guards against symlinks, swaps, and changes", async () => {
  const testRoot = join(tmpdir(), `zaicode-clean-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testRoot, "logs", "sub"), { recursive: true });

  const outsideDir = join(tmpdir(), `zaicode-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, "secret.txt"), "DO NOT DELETE");

  try {
    const cleaner = createFsStorageCleaner();

    // Normal valid file
    const validPath = join(testRoot, "logs", "valid.log");
    writeFileSync(validPath, "content");
    const validCandidate = { relativePath: "logs/valid.log", bytes: 7, mtimeMs: 1_000_000 };
    utimesSync(validPath, 1000, 1000);
    const validStats = lstatSync(validPath);
    Object.assign(validCandidate, { fileIdentity: `${validStats.dev}:${validStats.ino}:${validStats.birthtimeMs}` });

    // File modified after enumeration (mtime mismatch)
    const modifiedPath = join(testRoot, "logs", "modified.log");
    writeFileSync(modifiedPath, "orig");
    utimesSync(modifiedPath, 2000, 2000);
    const modifiedStats = lstatSync(modifiedPath);
    const modifiedCandidate = { relativePath: "logs/modified.log", bytes: 4, mtimeMs: 2_000_000,
      fileIdentity: `${modifiedStats.dev}:${modifiedStats.ino}:${modifiedStats.birthtimeMs}` };
    // touch to different mtime
    utimesSync(modifiedPath, 3000, 3000);

    // Directory in place of file (target is not a regular file)
    const dirAsFilePath = join(testRoot, "logs", "directory-target");
    mkdirSync(dirAsFilePath, { recursive: true });
    const dirCandidate = { relativePath: "logs/directory-target", bytes: 0, mtimeMs: 1_000_000 };

    // File under a directory junction
    const junctionDir = join(testRoot, "logs", "junction-link");
    symlinkSync(outsideDir, junctionDir, "junction");
    const escapedCandidate = { relativePath: "logs/junction-link/secret.txt", bytes: 13, mtimeMs: 5_000_000 };

    // Path traversal candidate
    const traversalCandidate = { relativePath: "../outside.txt", bytes: 10, mtimeMs: 1_000 };

    // Missing file
    const missingCandidate = { relativePath: "logs/missing.log", bytes: 10, mtimeMs: 1_000 };

    const candidates = [
      validCandidate,
      modifiedCandidate,
      dirCandidate,
      escapedCandidate,
      traversalCandidate,
      missingCandidate,
    ];

    // Optional file symlink test if OS / user permissions allow file symlinks
    let symlinkTested = false;
    const symlinkPath = join(testRoot, "logs", "symlink.log");
    try {
      symlinkSync(join(outsideDir, "secret.txt"), symlinkPath, "file");
      candidates.push({ relativePath: "logs/symlink.log", bytes: 13, mtimeMs: 4_000_000 });
      symlinkTested = true;
    } catch {
      // Non-elevated Windows without Developer Mode disallows file symlinks (junctions are supported)
    }

    const deleteResult = await cleaner.deleteFiles(testRoot, candidates, { keepDirectories: ["logs"] });

    // Only validCandidate should be deleted
    assert.equal(deleteResult.deletedCount, 1);
    assert.equal(deleteResult.freedBytes, 7);

    // Failures should record every rejected target with appropriate code
    const codesByPath = new Map(deleteResult.failures.map((f) => [f.path, f.code]));
    assert.equal(codesByPath.get("logs/modified.log"), "ECHANGED");
    assert.equal(codesByPath.get("logs/directory-target"), "EUNSAFE");
    assert.equal(codesByPath.get("logs/junction-link/secret.txt"), "EUNSAFE");
    assert.equal(codesByPath.get("../outside.txt"), "EOUTSIDE");
    assert.equal(codesByPath.get("logs/missing.log"), "ENOENT");
    if (symlinkTested) {
      assert.equal(codesByPath.get("logs/symlink.log"), "EUNSAFE");
    }

    // Verify secret file was NOT deleted
    assert.ok(
      (await import("node:fs")).existsSync(join(outsideDir, "secret.txt")),
      "Outside file must not be deleted through symlink or junction",
    );
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("storage clean safety: candidate enumeration skips directory junctions", async () => {
  const testRoot = join(tmpdir(), `zaicode-scan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const outsideDir = join(tmpdir(), `zaicode-scan-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testRoot, "cli", "agents", "real-dir"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  writeFileSync(join(testRoot, "cli", "agents", "real-dir", "file1.txt"), "real");
  writeFileSync(join(outsideDir, "secret.txt"), "outside");

  // Create junction inside cli/agents pointing outside
  symlinkSync(outsideDir, join(testRoot, "cli", "agents", "junction-link"), "junction");

  try {
    const cleaner = createFsStorageCleaner();
    const candidates = await cleaner.listCandidates(testRoot, [
      { prefix: "cli/agents", recursive: true },
    ]);

    const paths = candidates.map((c) => c.relativePath);
    assert.ok(paths.includes("cli/agents/real-dir/file1.txt"), "Real file must be enumerated");
    assert.ok(!paths.some((p) => p.includes("junction-link")), "Directory junctions must not be traversed");
    assert.ok(!paths.some((p) => p.includes("secret.txt")), "Files in junction targets must not be enumerated");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
