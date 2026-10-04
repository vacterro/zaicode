import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../..');
const product = join(root, 'zcode');
const require = createRequire(join(product, 'packages/services/package.json'));
const { build } = require('esbuild');
const nodePty = require('node-pty');
const subject = process.env.T192_SUBJECT || 'working';
const out = resolve(process.env.T192_OUT || join(root, '.saipen/evidence/T-192-native-green'));
await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'zaicode-t192-native-'));
const checks = [];
const check = (name, pass, details = '') => { checks.push({ name, pass: !!pass, details }); };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function wait(read, pattern, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const match = read().match(pattern); if (match) return match; await delay(20); }
  throw new Error(`Missing ${pattern}: ${read().slice(-1500)}`);
}
function kill(pid) { try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
function compileOptions() {
  return { bundle: true, platform: 'node', format: 'esm', target: 'node24', absWorkingDir: product,
    banner: { js: "import {createRequire as fixtureRequire} from 'node:module'; const require=fixtureRequire(import.meta.url);" },
    plugins: [{ name: 'native-subject', setup(b) {
      b.onResolve({ filter: /^node-pty$/ }, () => ({ path: pathToFileURL(require.resolve('node-pty')).href, external: true }));
      
      b.onLoad({ filter: /workerTerminalBroker\.ts$/ }, async args => {
        let source = await readFile(args.path, 'utf8');
        const trace = JSON.stringify(join(scratch, 'broker-trace.jsonl'));
        source = 'import {appendFileSync as traceAppend} from "node:fs"; const traceBroker = v => traceAppend(' + trace + ', JSON.stringify({at:Date.now(), ...v}) + "\\n");\n' + source;
        source = source.replace('const stop = (kill = true) => {', 'const stop = (kill = true) => { traceBroker({event:"stop",kill,terminalExited,closing,stack:new Error().stack});');
        source = source.replace('pty.onExit(({ exitCode }) => {', 'pty.onExit(({ exitCode }) => { traceBroker({event:"ptyExit",exitCode});');
        source = source.replace('peer.on("close", () => {', 'peer.on("close", () => { traceBroker({event:"peerClose",role});');
        source = source.replace('readFrames(peer, (message) => {', 'readFrames(peer, (message) => { traceBroker({event:"frame",role,type:message.type,terminalExited});');
        source = source.replace('pty!.resize(message.cols, message.rows);', '(() => {try { pty!.resize(message.cols, message.rows); } catch(error) { traceBroker({event:"resizeError",error:String(error)}); throw error; }})();');
        return { contents: source, loader: 'ts' };
      });
if (subject !== 'working') b.onLoad({ filter: /terminalService\.ts$/ }, args => ({ contents: execFileSync('git', ['-C', product, 'show', `${subject}:packages/services/src/terminal/terminalService.ts`], { encoding: 'utf8' }), loader: 'ts' }));
    } }], logLevel: 'silent' };
}
const brokerPath = join(scratch, 'workerTerminalBroker.mjs');
await build({ ...compileOptions(), entryPoints: [join(product, 'packages/services/src/terminal/workerTerminalBroker.ts')], outfile: brokerPath });
const hostPath = join(scratch, 'host.mjs');
const serviceURL = JSON.stringify(join(product, 'packages/services/src/terminal/terminalService.ts').replaceAll('\\', '/'));
const processURL = JSON.stringify(join(product, 'packages/services/src/terminal/workerTerminalProcess.ts').replaceAll('\\', '/'));
await build({ ...compileOptions(), stdin: { contents: `
import {createInterface} from 'node:readline';
import {createTerminalService} from ${serviceURL};
import {createWorkerTerminalProcess,externalClientCommand} from ${processURL};
const report=v=>process.stdout.write(JSON.stringify(v)+'\\n');
let launched;
const service=createTerminalService({settingService:{get:async()=>({terminalInheritSystemProfile:false})},
workerTerminalFactory:params=>createWorkerTerminalProcess(params,{entryPath:new URL(${JSON.stringify(pathToFileURL(brokerPath).href)}),
launchClient:launch=>new Promise(resolve=>{launched=resolve;report({type:'launch',script:externalClientCommand(launch)})})})});
const terminal=await service.create({cols:90,rows:25,cwd:${JSON.stringify(scratch)},externalizable:true});
service.onDynamicData(terminal.id)(data=>report({type:'data',data}));
service.onDynamicExit(terminal.id)(exitCode=>report({type:'exit',exitCode}));
report({type:'created',terminal});
createInterface({input:process.stdin}).on('line',async line=>{try{const m=JSON.parse(line);
if(m.type==='write')await service.write({id:terminal.id,data:m.data});
if(m.type==='launched')launched?.();
if(m.type==='extract') {if(service.extractToPowerShell)report({type:'extracted',...await service.extractToPowerShell({id:terminal.id})});else report({type:'unavailable'});}
}catch(e){report({type:'error',error:String(e)})}});
`, resolveDir: product, sourcefile: 'native-host-fixture.js' }, outfile: hostPath });
const fixture = join(scratch, 'counter.cjs');
await writeFile(fixture, `const fs=require('node:fs'),rl=require('node:readline');let count=0;const marker=require('node:crypto').randomUUID();
const emit=()=>{const r={pid:process.pid,count:++count,marker};fs.appendFileSync(process.argv[2],JSON.stringify(r)+'\\n');console.log('COUNTER:'+process.pid+':'+count+':'+marker)};
emit();setInterval(emit,200);rl.createInterface({input:process.stdin}).on('line',line=>{if(line==='state')console.log('STATE:'+process.pid+':'+count+':'+marker);if(line==='exit7'){console.log('FIXTURE_EXIT:'+process.pid);process.exit(7)}});`);
const q = v => `'${v.replaceAll("'", "''")}'`;
async function host(name) {
  const log = join(scratch, `${name}.jsonl`);
  const child = spawn(process.execPath, [hostPath], { cwd: product, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch, APPDATA: join(scratch,'AppData/Roaming'), LOCALAPPDATA: join(scratch,'AppData/Local') } });
  const messages = []; let output = '', stderr = '', buffer = '', external, externalEnded = false, externalClosed = false, externalExit;
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  child.stderr.on('data', data => { stderr += data.toString(); });
  child.stdout.on('data', data => {
    buffer += data.toString(); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const m = JSON.parse(line); messages.push(m); if (m.type === 'data') output += m.data;
        if (m.type === 'launch') {
          external = nodePty.spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(m.script, 'utf16le').toString('base64')], { cols: 90, rows: 25, cwd: scratch, env: process.env, useConpty: true });
          external.onData(data => { output += data; });
          externalExit = new Promise(resolve => external.onExit(({ exitCode }) => { externalEnded = true; resolve(exitCode); }));
          send({ type: 'launched' });
        }
      } catch {}
    }
  });
  let counter;
  try {
    await wait(() => JSON.stringify(messages) + stderr, /"type":"created"/);
    await wait(() => output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,''), /PS [^\r\n>]*>/);
    send({ type: 'write', data: `& ${q(process.execPath)} ${q(fixture)} ${q(log)}\r` });
    counter = await wait(() => output, /COUNTER:(\d+):(\d+):([a-f0-9-]{36})/);
  } catch (error) { kill(child.pid); throw error; }
  return { child, send, messages, counter, read: () => output, clearOutput: () => { output = ''; }, log,
    external: () => external, externalExit: () => externalExit,
    externalEnded: () => externalEnded,
    closeExternal: () => { if (external && !externalEnded && !externalClosed) { externalClosed = true; external.kill(); } },
    cleanup: () => { if (external && !externalEnded && !externalClosed) { externalClosed = true; external.kill(); } kill(child.pid); } };
}
async function records(path) { return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
let active;
try {
  active = await host('transfer');
  check('positive control: live CLI has a PID and writes its counter', Number(active.counter[1]) > 0);
  active.send({ type: 'write', data: 'state\r' });
  const state = await wait(active.read, /STATE:(\d+):(\d+):([a-f0-9-]{36})/);
  check('positive control: app input reaches the same CLI', state[1] === active.counter[1]);
  active.send({ type: 'extract' });
  await wait(() => JSON.stringify(active.messages), /"type":"(extracted|unavailable|error)"/);
  check('terminal service confirms a live PowerShell handoff', active.messages.some(m => m.type === 'extracted'));
  const before = await records(active.log);
  kill(active.child.pid);
  await delay(900);
  const after = await records(active.log);
  check('same CLI PID and monotonic counter survive taskkill /T /F of app host', after.length > before.length && after.every(r => String(r.pid) === state[1]) && after.at(-1).count > before.at(-1).count, { before: before.at(-1), after: after.at(-1) });
  if (active.external()) {
    active.clearOutput();
    active.external().resize(110, 32);
    active.external().write('state\r');
    await wait(active.read, new RegExp(`STATE:${state[1]}:(\\d+):${state[3]}`));
    check('external input/output and resize continue the original CLI', true);
    active.external().write('exit7\r');
    await wait(active.read, /FIXTURE_EXIT:\d+/);
    active.external().write('exit $LASTEXITCODE\r');
    await wait(() => active.externalEnded() ? 'closed' : '', /closed/, 5000);
    const actualExit = await active.externalExit(); check('external console receives original nonzero exit', actualExit === 7, {exitCode: actualExit, output: active.read().slice(-10000)});
  } else check('external input/output and resize continue the original CLI', false, 'No external ownership on old subject');
  active.cleanup();
  if (subject === 'working') {
    active = await host('external-close');
    active.send({ type: 'extract' });
    await wait(() => JSON.stringify(active.messages), /"type":"extracted"/);
    active.closeExternal();
    await delay(900); const closed = await records(active.log);
    await delay(500); const remainsClosed = await records(active.log);
    check('closing the external console stops its own CLI', closed.length === remainsClosed.length);
    active.cleanup();
  }
  active = await host('app-crash-before-transfer');
  kill(active.child.pid);
  await delay(900); const stopped = await records(active.log);
  await delay(500); const stillStopped = await records(active.log);
  check('app crash before handoff stops its own CLI without orphaning', stopped.length === stillStopped.length);
} catch (error) { check('native instrument completed', false, String(error)); }
finally { active?.cleanup(); }
const receipt = { schema: 't192-native/1', subject, at: new Date().toISOString(), verifier: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), scratch, checks, pass: checks.every(c => c.pass) };
await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ subject, pass: receipt.pass, checks: checks.map(c => ({ name: c.name, pass: c.pass })), out }));
process.exit(receipt.pass ? 0 : 1);
