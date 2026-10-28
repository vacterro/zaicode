import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getZaicodeSaipenProjection } from "../src/main/zaicodeSaipenProjection.js";

// T-43 fault matrix, stale-snapshot: a SAIPEN launcher that failed once must be
// asked again without waiting for STATE / BOARD / LOG to change.

const LAUNCHER = [
  "@echo off",
  'if exist "%~dp0fail.flag" exit /b 1',
  'echo {"ok":true,"phase":"BUILD","claimed_ticket":"T-1"}',
  "",
].join("\r\n");

test("a failed projection is retried after a few seconds, a good one is kept until the files change", { skip: process.platform !== "win32" }, async () => {
  const base = mkdtempSync(join(tmpdir(), "zaicode-projection-"));
  const home = join(base, "home");
  const project = join(base, "project");
  const saved = process.env.SAIPEN_HOME;
  try {
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "saipen.cmd"), LAUNCHER);
    mkdirSync(join(project, ".saipen"), { recursive: true });
    for (const name of ["STATE.md", "BOARD.md", "LOG.md"]) writeFileSync(join(project, ".saipen", name), `# ${name}\n`);
    process.env.SAIPEN_HOME = home;

    const flag = join(home, "bin", "fail.flag");
    writeFileSync(flag, "");
    assert.equal(await getZaicodeSaipenProjection(project), null, "the failing launcher gives no projection");
    unlinkSync(flag);
    assert.equal(await getZaicodeSaipenProjection(project), null, "within the retry window the failure is still cached");

    await new Promise((resolve) => setTimeout(resolve, 5200));
    const back = await getZaicodeSaipenProjection(project);
    assert.equal(back?.phase, "BUILD", "after the retry window SAIPEN is asked again, with no file change");
    assert.equal(back?.claimedTicket, "T-1");

    writeFileSync(flag, "");
    assert.equal((await getZaicodeSaipenProjection(project))?.phase, "BUILD", "a good answer stays cached while the files are unchanged");
  } finally {
    if (saved === undefined) delete process.env.SAIPEN_HOME;
    else process.env.SAIPEN_HOME = saved;
    rmSync(base, { recursive: true, force: true });
  }
});
