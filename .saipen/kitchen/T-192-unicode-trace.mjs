import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../..'), product=join(root,'zcode');
const require=createRequire(join(product,'packages/services/package.json'));
const {build}=require('esbuild'), pty=require('node-pty');
const scratch=await mkdtemp(join(tmpdir(),'zaicode-unicode-trace-'));
const trace=join(scratch,'input.jsonl'), broker=join(scratch,'broker.mjs'), factory=join(scratch,'factory.mjs');
const banner={js:"import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);"};
await build({entryPoints:[join(product,'packages/services/src/terminal/workerTerminalBroker.ts')],outfile:broker,format:'esm',platform:'node',bundle:true,banner,logLevel:'silent',plugins:[{name:'trace',setup(b){
  b.onResolve({filter:/^node-pty$/},()=>({path:pathToFileURL(require.resolve('node-pty')).href,external:true}));
  b.onLoad({filter:/workerTerminalBroker\.ts$/},async args=>{
    const source=await readFile(args.path,'utf8');
    if(!source.includes('pty!.write(message.data);')) throw new Error('Trace attachment point changed');
    return {loader:'ts',contents:`import {appendFile as traceAppend} from 'node:fs/promises';\n`+source.replace('pty!.write(message.data);',`(void traceAppend(${JSON.stringify(trace)},JSON.stringify({role:peer===app?'app':'external',data:message.data})+'\\n'),pty!.write(message.data));`)};
  });
}}]});
await build({entryPoints:[join(product,'packages/services/src/terminal/workerTerminalProcess.ts')],outfile:factory,format:'esm',platform:'node',bundle:true,banner,logLevel:'silent'});
const {createWorkerTerminalProcess,externalClientCommand}=await import(pathToFileURL(factory));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(read,pattern){for(let n=0;n<750;n++){if(pattern.test(read()))return;await sleep(20)}throw new Error('Trace timeout');}
let appOut='', externalOut='', external, worker;
try {
  worker=await createWorkerTerminalProcess({shell:'powershell.exe',cwd:product,cols:140,rows:24,env:process.env},{entryPath:pathToFileURL(broker),launchClient:async launch=>{
    external=pty.spawn('powershell.exe',['-NoLogo','-NoProfile','-EncodedCommand',Buffer.from(externalClientCommand(launch),'utf16le').toString('base64')],{cwd:product,env:process.env,cols:140,rows:24,useConpty:true,useConptyDll:false});
    external.onData(data=>externalOut+=data);
  }});
  worker.onData(data=>appOut+=data);
  await wait(()=>appOut,/PS .*?>/);
  worker.write("Write-Output ('BEFORE:'+'tere-привет-🌙')\r");
  await wait(()=>appOut,/BEFORE:tere-привет-🌙/);
  await worker.extractToPowerShell();worker.kill();
  external.write("Write-Output ('AFTER:'+'tere-привет-🌙')\r");
  await wait(()=>externalOut,/AFTER:tere-привет-/);
  await sleep(300);
  const writes=(await readFile(trace,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const actualInput=writes.filter(frame=>frame.role==='external').map(frame=>frame.data).join('');
  const result={schema:'t192-unicode-trace/1',at:new Date().toISOString(),scratch,writes,
    brokerExternalInputContainsEmoji:actualInput.includes('🌙'),inputCodepoints:Array.from(actualInput,char=>char.codePointAt(0).toString(16)),
    originalShellPreservesEmoji:/BEFORE:tere-привет-🌙/.test(appOut),transferredShellPreservesEmoji:/AFTER:tere-привет-🌙/.test(externalOut)};
  await writeFile(join(root,'.saipen/evidence/T-192-unicode-trace.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}finally{external?.kill();worker?.kill();}
