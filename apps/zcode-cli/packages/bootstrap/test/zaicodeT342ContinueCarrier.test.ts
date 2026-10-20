// T-342：两个会话不能覆盖同项目尚未被 child 读取的 operator carrier。
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSaipenContinueLauncher, type SaipenContinueAnswer } from "../src/zcode-protocol-v4/commands/continue-owner.js";

const readerSource = [
  "import{writeFileSync,readdirSync,readFileSync}from'node:fs';",
  "import path from'node:path';",
  "writeFileSync(path.join(process.cwd(),'ready-'+process.pid),'ready');",
  "const deadline=Date.now()+5000;",
  "while(readdirSync(process.cwd()).filter(n=>n.startsWith('ready-')).length<2){if(Date.now()>deadline)throw Error('fixture barrier timed out');await new Promise(r=>setTimeout(r,10));}",
  "const file=process.env.SAIPEN_TASK_FILE??'';",
  "const detail=JSON.stringify({file,text:file?readFileSync(file,'utf8'):'ABSENT'});",
  "process.stdout.write(JSON.stringify({ok:false,code:'FIXTURE_REFUSAL',detail}));",
  "process.exitCode=1;",
].join("\n");

function fixture() {
  const owned = mkdtempSync(path.join(tmpdir(), "zaicode-t342-carrier-"));
  const project = path.join(owned, "project");
  const transport = path.join(owned, "transport-stub");
  const bin = path.join(transport, "bin");
  mkdirSync(project);
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(transport, "package.json"), '{"type":"module"}');
  if (process.platform === "win32") {
    writeFileSync(path.join(bin, "read-carrier.mjs"), readerSource);
    writeFileSync(
      path.join(bin, "saipen.cmd"),
      '@echo off\r\n"' + process.execPath + '" "%~dp0read-carrier.mjs"\r\n',
    );
  } else {
    const launcher = path.join(bin, "saipen");
    writeFileSync(launcher, "#!/usr/bin/env node\n" + readerSource);
    chmodSync(launcher, 0o755);
  }
  // 仅隔离测试 stub；此 fixture 从不调用真实 SAIPEN，也不生成真实 authority。
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("SAIPEN_")),
  );
  env.SAIPEN_HOME = transport;
  env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? "");
  return { owned, project, env };
}

function observed(answer: SaipenContinueAnswer): { file: string; text: string } {
  return JSON.parse(answer.detail.slice(answer.detail.indexOf("{")));
}

test("T-342: simultaneous sessions retain their own exact continuation carrier bytes", async () => {
  const f = fixture();
  const inputs = ["cc", "saipen continue"];
  const answers = await Promise.all(
    inputs.map((operatorText) =>
      runSaipenContinueLauncher(f.project, { env: f.env, operatorText, timeoutMs: 10000 }),
    ),
  );
  const actual = answers.map(observed);
  assert.deepEqual(
    actual.map((row) => row.text),
    inputs,
    "a peer submission must never replace the first request before its child reads",
  );
  assert.notEqual(actual[0]!.file, actual[1]!.file, "requests need individual immutable carriers");
});

test("T-342: an inherited external carrier is preserved unchanged for both children", async () => {
  const f = fixture();
  const file = path.join(f.owned, "inherited-transport-carrier.txt");
  const text = "synthetic inherited transport bytes";
  writeFileSync(file, text);
  const env = { ...f.env, SAIPEN_TASK_FILE: file };
  const answers = await Promise.all(
    ["cc", "saipen continue"].map((operatorText) =>
      runSaipenContinueLauncher(f.project, { env, operatorText, timeoutMs: 10000 }),
    ),
  );
  assert.deepEqual(answers.map(observed), [{ file, text }, { file, text }]);
  assert.equal(readFileSync(file, "utf8"), text);
});

