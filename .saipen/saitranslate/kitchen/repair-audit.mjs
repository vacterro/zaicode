import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const root=import.meta.dirname;
const audit=JSON.parse(readFileSync(join(root,'audit.json'),'utf8'));
const tasks=[];
for(const [locale,surfaces]of Object.entries(audit.locales))for(const [surface,info]of Object.entries(surfaces)) {
  const keys=[...new Set([...info.broken,...info.technical,...info.suspicious])];
  if(keys.length)tasks.push({locale,surface,keys});
}
function run(locale,surface,file) {
  const dir=surface==='ui'?root:join(root,surface);
  const env={...process.env,SAITRANSLATE_KITCHEN_DIR:dir,SAITRANSLATE_POLISH:'1'};
  if(surface!=='ui')env.SAITRANSLATE_SOURCE_CATALOG=join(dir,'source.json');
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[join(root,'produce.mjs'),locale,'--repair',file,'--batches','1','--model','cl/cline-free/mimo-v2.6-flash','--retries','6'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>appendFileSync(join(root,'repair-audit.log'),chunk));
    child.on('exit',code=>resolve(code));
  });
}
async function worker(){while(tasks.length){const {locale,surface,keys}=tasks.shift();const dir=surface==='ui'?root:join(root,surface);const file=join(dir,`${locale}.repair-keys.json`);writeFileSync(file,JSON.stringify(keys)+'\n');let success=false;for(let attempt=0;attempt<3&&!success;attempt++)success=(await run(locale,surface,file))===0;appendFileSync(join(root,'repair-audit.log'),`${new Date().toISOString()} ${locale}/${surface}: ${success?'REPAIRED':'FAILED'} ${keys.length} rows\n`);}}
await Promise.all(Array.from({length:6},worker));
