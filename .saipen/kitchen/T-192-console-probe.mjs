import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const q=v=>`'${v.replaceAll("'","''")}'`;
const runtimes=[process.execPath,resolve(root,'zcode/packages/desktop/dist-test-20261003-t192/win-unpacked.rejected-20261003134032/ZAICODE.exe')];
const results=[];
for(let i=0;i<runtimes.length;i++){
  const file=resolve(root,`.saipen/evidence/T-192-console-${i}.json`);
  const script=resolve(root,`.saipen/kitchen/T-192-console-${i}.cjs`);
  await writeFile(script,`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)},JSON.stringify({runtime:process.execPath,stdinTTY:process.stdin.isTTY||false,stdoutTTY:process.stdout.isTTY||false,columns:process.stdout.columns||null}));setTimeout(()=>process.exit(0),500);`);
  const encoded=Buffer.from(`$env:ELECTRON_RUN_AS_NODE='1'; & ${q(runtimes[i])} ${q(script)}; Start-Sleep -Seconds 2; exit`,'utf16le').toString('base64');
  const outer=Buffer.from(`$ErrorActionPreference='Stop'; Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoLogo -NoProfile -EncodedCommand ${encoded}' | Out-Null`,'utf16le').toString('base64');
  await new Promise((res,rej)=>{const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',outer],{windowsHide:true,stdio:'ignore'});child.on('error',rej);child.on('exit',code=>code===0?res():rej(new Error(String(code))));});
  await new Promise(res=>setTimeout(res,3500));
  results.push(JSON.parse(await readFile(file,'utf8')));
}
console.log(JSON.stringify(results));
