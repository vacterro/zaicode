import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function runFixture(stale) {
  const root = await mkdtemp(join(tmpdir(), "zaicode-graph-"));
  try {
    await writeFile(join(root, "fake.mjs"), `
      const args = process.argv.slice(2);
      if (args.includes('-r') && args.includes('Infinity')) {
        console.error('EMFILE: unbounded whole-workspace graph'); process.exit(2);
      }
      const projects = [{name:'fixture-a', path:${JSON.stringify(root)}}, {name:'fixture-b', path:${JSON.stringify(root)}}];
      const filter = args.find(x => x.startsWith('--filter='));
      if (!filter) { console.log(JSON.stringify(projects)); process.exit(0); }
      const name = filter.slice('--filter='.length);
      const version = ${JSON.stringify(stale)} && !args.includes('--lockfile-only') ? '2.0.0' : '1.0.0';
      console.log(JSON.stringify([{...projects.find(x => x.name === name), dependencies:{dep:{version}}}]));
    `);
    await writeFile(join(root, "pnpm.cmd"), `@echo off\r\n"${process.execPath}" "${join(root, "fake.mjs")}" %*\r\n`);
    const posix = join(root, "pnpm");
    await writeFile(posix, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${join(root, "fake.mjs").replaceAll("'", "'\\''")}' "$@"\n`);
    await chmod(posix, 0o755);
    const module = new URL("./third-party-npm.mjs", import.meta.url).href;
    return spawnSync(process.execPath, ["--input-type=module", "-e",
      `import {readWorkspaceProductionGraph} from ${JSON.stringify(module)}; const r=await readWorkspaceProductionGraph(${JSON.stringify(root)}); console.log(JSON.stringify({projects:r.projects.map(p=>p.name),required:[...r.required.keys()]}));`],
      {encoding:"utf8",env:{...process.env,PATH:root + (process.platform==='win32'?';':':') + process.env.PATH}});
  } finally { await rm(root, {recursive:true,force:true}); }
}

test("large-workspace graph collection stays within per-project resource bounds", async () => {
  const result = await runFixture(false);
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout.trim());
  assert.deepEqual(graph.projects, ['fixture-a', 'fixture-b']);
  assert.deepEqual(graph.required, ['dep@1.0.0']);
});
test("bounded graph collection still refuses installed/locked version drift", async () => {
  const result = await runFixture(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Installed production graph differs/);
});
