import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const product = join(root, 'zcode');
const executable = resolve(process.env.T192_PACKAGED_EXE);
const broker = resolve(dirname(executable), 'resources/app.asar/out/host/workerTerminalBroker.js');
const factory = resolve(dirname(executable), 'resources/app.asar/out/host/workerTerminalProcess.js');
const out = resolve(process.env.T192_PACKAGED_OUT || join(root, '.saipen/evidence/T-192-packaged'));
const require = createRequire(join(product, 'packages/services/package.json'));
const { build } = require('esbuild');
const scratch = await mkdtemp(join(tmpdir(), 'zaicode-t192-packaged-'));
await mkdir(out, { recursive: true });
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const q = value => `'${value.replaceAll("'", "''")}'`;
const kill = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
};
async function wait(read, predicate, description) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(30);
  }
  throw new Error(`Timed out: ${description}`);
}

const log = join(scratch, 'counter.jsonl');
const stopFile = join(scratch, 'stop');
const fixture = join(scratch, 'counter.cjs');
await writeFile(fixture, `const fs=require('node:fs'); const marker=require('node:crypto').randomUUID();let count=0;
const tick=()=>{const r={pid:process.pid,count:++count,marker};fs.appendFileSync(process.argv[2],JSON.stringify(r)+'\\n');console.log('COUNTER:'+r.pid+':'+r.count+':'+marker);if(fs.existsSync(process.argv[3])||count>=150)process.exit(7)};
tick();setInterval(tick,200);`);
const hostPath = join(scratch, 'host.mjs');
await build({ bundle: true, format: 'esm', platform: 'node', target: 'node24', absWorkingDir: product,
  banner: { js: "import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);" },
  plugins: [{ name: 'native-import', setup(b) {
    b.onResolve({ filter: /^file:/ }, args => ({ path: args.path, external: true }));
  } }],
  stdin: { resolveDir: product, sourcefile: 'packaged-host-fixture.js', contents: `
import {createInterface} from 'node:readline';
import {createWorkerTerminalProcess} from ${JSON.stringify(pathToFileURL(factory).href)};
const report=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const terminal=await createWorkerTerminalProcess({shell:'powershell.exe',cols:90,rows:25,cwd:${JSON.stringify(scratch)},env:process.env});
terminal.onData(data=>report({type:'data',data}));
terminal.onExit(({exitCode})=>report({type:'exit',exitCode}));
report({type:'created',terminal:{canExtractToPowerShell:true}});
createInterface({input:process.stdin}).on('line',async line=>{try{const m=JSON.parse(line);
 if(m.type==='write')terminal.write(m.data);
 if(m.type==='extract')report({type:'extracted',...await terminal.extractToPowerShell()});
}catch(e){report({type:'error',error:String(e)})}});
` }, outfile: hostPath, logLevel: 'silent' });

let child, shellPid, counterPid;
let buffer = '', stderr = '', output = '';
const messages = [];
const records = async () => {
  try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
};
try {
  await access(executable);
  child = spawn(executable, [hostPath], { cwd: product, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', USERPROFILE: scratch, HOME: scratch,
      APPDATA: join(scratch, 'AppData/Roaming'), LOCALAPPDATA: join(scratch, 'AppData/Local') } });
  child.once('error', error => { stderr += String(error); });
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    buffer += data; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const m = JSON.parse(line); messages.push(m); if (m.type === 'data') output += m.data; } catch {}
    }
  });
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  await wait(() => messages, values => values.some(v => v.type === 'created'), `packaged broker attachment (${stderr})`);
  check('packaged Electron loads its shipped broker and native ConPTY module', messages.find(v => v.type === 'created').terminal.canExtractToPowerShell === true);
  await wait(() => output, value => /PS [^\r\n>]*>/.test(value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')), 'initial PowerShell prompt');
  send({ type: 'write', data: `& ${q(process.execPath)} ${q(fixture)} ${q(log)} ${q(stopFile)}; exit $LASTEXITCODE\r` });
  const beforeLaunch = await wait(records, values => values.length >= 2, 'original live CLI');
  counterPid = beforeLaunch[0].pid;
  check('positive control: a single live CLI process advances its state', beforeLaunch.every(v => v.pid === counterPid && v.marker === beforeLaunch[0].marker));
  send({ type: 'extract' });
  const acknowledgement = await wait(() => messages, values => values.some(v => v.type === 'extracted' || v.type === 'error'), 'real visible PowerShell acknowledgement');
  const extracted = acknowledgement.find(v => v.type === 'extracted');
  if (!extracted) throw new Error(acknowledgement.find(v => v.type === 'error')?.error || stderr);
  shellPid = extracted.pid;
  check('default launch opens a real interactive PowerShell and confirms handoff', Number.isInteger(shellPid) && shellPid > 0);
  const before = await records();
  kill(child.pid);
  await sleep(1000);
  const after = await records();
  check('same CLI PID and state survive forced termination of the packaged app host',
    after.length > before.length && after.every(v => v.pid === counterPid && v.marker === before[0].marker) && after.at(-1).count > before.at(-1).count,
    { before: before.at(-1), after: after.at(-1) });
  await writeFile(stopFile, 'fixture exit requested');
  await wait(async () => {
    try { process.kill(shellPid, 0); return false; } catch { return true; }
  }, value => value, 'original shell and external client complete');
  check('fixture exit completes the transferred shell without restarting the CLI', (await records()).every(v => v.pid === counterPid));
} catch (error) {
  check('packaged native instrument completed', false, `${String(error)} ${stderr}`.slice(-1600));
} finally {
  await writeFile(stopFile, 'cleanup').catch(() => {});
  kill(shellPid); kill(counterPid); kill(child?.pid);
}
const digest = value => createHash('sha256').update(value).digest('hex');
const receipt = { schema: 't192-packaged/1', at: new Date().toISOString(), executable, broker, factory, scratch,
  appAsarSha256: digest(await readFile(join(dirname(executable), 'resources/app.asar'))),
  verifier: digest(await readFile(import.meta.filename)), checks, pass: checks.every(v => v.pass) };
await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
process.exitCode = receipt.pass ? 0 : 1;
