import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),product=join(root,'zcode');
const require=createRequire(join(product,'packages/services/package.json'));
const pty=require('node-pty');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(read,pattern){for(let n=0;n<750;n++){if(pattern.test(read()))return;await sleep(20)}throw new Error('Baseline timeout');}
const results=[];
for(const dll of [false,true]) {
  let output='';
  const terminal=pty.spawn('powershell.exe',[],{cwd:product,env:process.env,cols:140,rows:24,encoding:'utf8',useConpty:true,useConptyDll:dll});
  terminal.onData(data=>output+=data);
  try {
    await wait(()=>output,/PS .*?>/);
    terminal.write("Write-Output ('BASELINE:'+(Get-Module PSReadLine).Version.ToString())\r");
    await wait(()=>output,/BASELINE:\d+\.\d+/);
    await sleep(250);
    terminal.write("Write-Output ('SECOND:'+'tere-привет-🌙')\r");
    await wait(()=>output,/SECOND:tere-привет-/);
    const moduleVersion=output.match(/BASELINE:(\d+\.\d+\.\d+)/)?.[1];
    results.push({dll,moduleVersion,pid:terminal.pid,preservesEmoji:/SECOND:tere-привет-🌙/.test(output),tail:output.slice(-1200)});
  }finally{terminal.kill();}
}
await writeFile(join(root,'.saipen/evidence/T-192-unicode-pty-baseline.json'),JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n');
console.log(JSON.stringify(results.map(({tail,...rest})=>rest)));
