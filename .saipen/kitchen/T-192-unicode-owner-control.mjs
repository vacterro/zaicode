import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'../..'),product=join(root,'zcode');
const require=createRequire(join(product,'packages/services/package.json'));
const {build}=require('esbuild');
const scratch=await mkdtemp(join(tmpdir(),'zaicode-unicode-owner-'));
const broker=join(scratch,'broker.mjs'),factory=join(scratch,'factory.mjs');
const banner={js:"import {createRequire as fixtureRequire} from 'node:module';const require=fixtureRequire(import.meta.url);"};
await build({entryPoints:[join(product,'packages/services/src/terminal/workerTerminalBroker.ts')],outfile:broker,format:'esm',platform:'node',bundle:true,banner,logLevel:'silent',plugins:[{name:'native',setup(b){b.onResolve({filter:/^node-pty$/},()=>({path:pathToFileURL(require.resolve('node-pty')).href,external:true}));}}]});
await build({entryPoints:[join(product,'packages/services/src/terminal/workerTerminalProcess.ts')],outfile:factory,format:'esm',platform:'node',bundle:true,banner,logLevel:'silent'});
const {createWorkerTerminalProcess}=await import(pathToFileURL(factory));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(read,pattern){for(let n=0;n<750;n++){if(pattern.test(read()))return;await sleep(20)}throw new Error('Owner control timeout');}
const results=[];
for(const mode of ['app-resize','external-no-resize','external-resize']) {
  let output='',peer,worker;
  try {
    worker=await createWorkerTerminalProcess({shell:'powershell.exe',cwd:product,cols:140,rows:24,env:process.env},{entryPath:pathToFileURL(broker),launchClient:async launch=>{
      const config=JSON.parse(await readFile(launch.configPath,'utf8'));
      peer=createConnection(config.pipe);
      let buffer='';
      peer.on('data',bytes=>{buffer+=bytes;let end;while((end=buffer.indexOf('\n'))>=0){const frame=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(frame.type==='data')output+=frame.data;}});
      await new Promise((resolve,reject)=>{peer.once('error',reject);peer.once('connect',resolve);});
      peer.write(JSON.stringify({type:'hello',role:'external',token:config.token,lease:launch.lease})+'\n');
    }});
    worker.onData(data=>output+=data);
    await wait(()=>output,/PS .*?>/);
    worker.write("Write-Output ('BEFORE:'+'tere-привет-🌙')\r");
    await wait(()=>output,/BEFORE:tere-привет-🌙/);
    if(mode.startsWith('external')) {
      await worker.extractToPowerShell();worker.kill();
      if(mode==='external-resize')peer.write(JSON.stringify({type:'resize',cols:140,rows:24})+'\n');
      peer.write(JSON.stringify({type:'write',data:"Write-Output ('AFTER:'+'tere-привет-🌙')\r"})+'\n');
    } else {
      worker.resize(140,24);
      worker.write("Write-Output ('AFTER:'+'tere-привет-🌙')\r");
    }
    await wait(()=>output,/AFTER:tere-привет-/);
    await sleep(100);
    results.push({mode,pid:worker.pid,preservesEmoji:/AFTER:tere-привет-🌙/.test(output)});
  }finally{peer?.destroy();worker?.kill();}
}
await writeFile(join(root,'.saipen/evidence/T-192-unicode-owner-control.json'),JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n');
console.log(JSON.stringify(results));
