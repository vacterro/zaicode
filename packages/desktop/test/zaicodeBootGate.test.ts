import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runBootGate } from "../../../scripts/zaicode-boot-gate.mjs";

/**
 * The launcher swaps whatever sits in dist-next\win-unpacked into place at the
 * next start. Wave 3 staged a window that could not start. The gate decides
 * whether a bundled build may stay where the launcher will find it; these pin
 * that decision without starting Electron (the real start is
 * verify-zaicode-boot.cjs, proven red on the broken build and green on the fix).
 */

function repo(distName: string) {
  const root = mkdtempSync(join(tmpdir(), "zaicode-gate-"));
  const repoRoot = join(root, "zcode");
  const built = join(repoRoot, "packages", "desktop", distName, "win-unpacked");
  mkdirSync(built, { recursive: true });
  writeFileSync(join(built, "ZAICODE.exe"), "MZ");
  return { root, repoRoot, built };
}

const quiet = { log() {}, warn() {}, error() {} };
const calls: string[] = [];
const messages: string[] = [];
const talking = { log: (text: string) => messages.push(text), warn: (text: string) => messages.push(text), error: (text: string) => messages.push(text) };

test("a staged build is hidden from the launcher while it is tested, then put back", () => {
  const { root, repoRoot, built } = repo("dist-next");
  try {
    let visibleDuringTest: boolean | null = null;
    const result = runBootGate({
      repoRoot,
      distName: "dist-next",
      isWin: true,
      env: {},
      smoke: ({ executable }: { executable: string }) => {
        calls.push(executable);
        visibleDuringTest = existsSync(join(built, "ZAICODE.exe"));
        return { status: 0 };
      },
      log: quiet,
    });
    assert.deepEqual(result, { ok: true, action: "passed" });
    assert.equal(visibleDuringTest, false, "the launcher applies win-unpacked once the blockmap is newer: an untested build must not sit there");
    assert.equal(calls.at(-1), join(`${built}.verifying`, "ZAICODE.exe"), "the packaged executable itself is started, from the hiding place");
    assert.ok(existsSync(join(built, "ZAICODE.exe")), "a build that starts is back where the launcher expects it");
    assert.equal(existsSync(`${built}.verifying`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a leftover hiding place from a crashed gate is cleared before the next one", () => {
  const { root, repoRoot, built } = repo("dist-next");
  try {
    mkdirSync(`${built}.verifying`, { recursive: true });
    writeFileSync(join(`${built}.verifying`, "stale.txt"), "old");
    const result = runBootGate({ repoRoot, distName: "dist-next", isWin: true, env: {}, smoke: () => ({ status: 0 }), log: quiet });
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(built, "stale.txt")), false);
    assert.ok(existsSync(join(built, "ZAICODE.exe")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a staged build that cannot start is moved aside so the launcher never sees it, and the bundle fails", () => {
  const { root, repoRoot, built } = repo("dist-next");
  try {
    const parent = join(repoRoot, "packages", "desktop", "dist-next");
    mkdirSync(join(parent, "win-unpacked.rejected-19990101000000"), { recursive: true });
    messages.length = 0;
    const result = runBootGate({
      repoRoot,
      distName: "dist-next",
      isWin: true,
      env: {},
      smoke: () => ({ status: 1 }),
      log: talking,
      now: () => new Date("2026-09-29T12:34:56Z"),
    });
    assert.equal(result.ok, false);
    assert.equal(result.action, "rejected");
    assert.equal(existsSync(join(built, "ZAICODE.exe")), false, "nothing is left at the path the launcher swaps in");
    assert.deepEqual(readdirSync(parent), ["win-unpacked.rejected-20260929123456"], "the newest rejected build is kept, older rejects and the hiding place are gone");
    assert.ok(existsSync(join(parent, "win-unpacked.rejected-20260929123456", "ZAICODE.exe")), "the build is moved, not deleted");
    assert.match(messages.join("\n"), /launcher keeps the last good build/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live build that cannot start is left untouched but fails the bundle loudly", () => {
  const { root, repoRoot, built } = repo("dist");
  try {
    messages.length = 0;
    const result = runBootGate({ repoRoot, distName: "dist", isWin: true, env: {}, smoke: () => ({ status: 1 }), log: talking });
    assert.deepEqual(result, { ok: false, action: "failed-live" });
    assert.ok(existsSync(join(built, "ZAICODE.exe")), "the live folder is not moved: it may be the only build there is");
    assert.match(messages.join("\n"), /do not start it/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a smoke that times out or is killed (no status) counts as a failure, never as a pass", () => {
  const { root, repoRoot } = repo("dist-next");
  try {
    const result = runBootGate({ repoRoot, distName: "dist-next", isWin: true, env: {}, smoke: () => ({ status: null }), log: quiet });
    assert.equal(result.ok, false);
    assert.equal(result.action, "rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the skip switch works and says it was used; other platforms and a missing build do not gate", () => {
  const { root, repoRoot, built } = repo("dist-next");
  try {
    messages.length = 0;
    const neverRuns = () => assert.fail("the smoke must not run");
    assert.deepEqual(
      runBootGate({ repoRoot, distName: "dist-next", isWin: true, env: { ZAICODE_SKIP_BOOT_SMOKE: "1" }, smoke: neverRuns, log: talking }),
      { ok: true, action: "skipped" },
    );
    assert.match(messages.join("\n"), /did NOT run/);
    assert.deepEqual(runBootGate({ repoRoot, distName: "dist-next", isWin: false, env: {}, smoke: neverRuns, log: quiet }), { ok: true, action: "skipped" });
    rmSync(built, { recursive: true, force: true });
    assert.deepEqual(runBootGate({ repoRoot, distName: "dist-next", isWin: true, env: {}, smoke: neverRuns, log: quiet }), { ok: true, action: "no-build" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// SRC-081: the Discord SAIPEN COMMUNITY link joined the Settings sidebar; a gate that clicks every
// entry would have opened the operator's browser from a test. Every external link is on the skip list.
test("the boot gate never clicks a Settings entry that leaves the app", () => {
  const gate = readFileSync(join(import.meta.dirname, "../scripts/verify-zaicode-boot.cjs"), "utf8");
  const skip = /const skip = (\/.+\/i);/.exec(gate)?.[1] ?? "";
  for (const label of ["back to workspace", "on github", "support developer", "discord saipen community"]) {
    assert.ok(skip.includes(label), `${label} is skipped by the gate`);
  }
});
