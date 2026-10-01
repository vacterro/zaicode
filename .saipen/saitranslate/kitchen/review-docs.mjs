// A second model pass improves prose without changing the source/placeholder acceptance path.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root=import.meta.dirname;
const dir=join(root,'docs');
const source=JSON.parse(readFileSync(join(dir,'source.json'),'utf8'));
const locales=['et-EE','ru-RU','ded','uk-UA','ja-JP','de-DE','fr-FR','es-ES','it-IT','pt-BR','nl-NL','pl-PL','sv-SE','da-DK','fi-FI','nb-NO','zh-CN','ko-KR','th-TH','vi-VN','ar-SA','he-IL','tr-TR','hi-IN','id-ID','el-GR','cs-CZ','ro-RO','hu-HU','bg-BG','sk-SK','hr-HR'];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function run(locale,file) {
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[join(root,'produce.mjs'),locale,'--repair',file,'--batches','1','--model','cl/cline-free/mimo-v2.6-flash','--retries','5'],{windowsHide:true,env:{...process.env,SAITRANSLATE_KITCHEN_DIR:dir,SAITRANSLATE_SOURCE_CATALOG:join(dir,'source.json'),SAITRANSLATE_SURFACE_DESCRIPTION:'the user documentation',SAITRANSLATE_POLISH:'1'},stdio:['ignore','pipe','pipe']});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>appendFileSync(join(root,'review-docs.log'),chunk));
    child.on('exit',code=>resolve(code));
  });
}
async function worker() {
  while(locales.length) {
    const locale=locales.shift();
    const draft=join(dir,'drafts',`${locale}.json`);
    while(!existsSync(draft)||Object.keys(JSON.parse(readFileSync(draft,'utf8'))).length!==Object.keys(source).length) await delay(5000);
    const receiptFile=join(dir,`${locale}.reviewed.json`);
    const checked=existsSync(receiptFile)?JSON.parse(readFileSync(receiptFile,'utf8')):[];
    const keys=Object.keys(source).filter(key=>!checked.includes(key));
    for(let index=0;index<keys.length;index+=10) {
      const chunk=keys.slice(index,index+10);
      const file=join(dir,`${locale}.review-keys.json`);
      writeFileSync(file,JSON.stringify(chunk)+'\n');
      let success=false;
      for(let attempt=0;attempt<3&&!success;attempt++) success=(await run(locale,file))===0;
      if(!success) {appendFileSync(join(root,'review-docs.log'),`${locale}: REVIEW FAILED ${chunk.join(',')}\n`);break;}
      checked.push(...chunk);
      writeFileSync(receiptFile,JSON.stringify(checked,null,2)+'\n');
    }
    appendFileSync(join(root,'review-docs.log'),`${new Date().toISOString()} ${locale}: reviewed ${checked.length}/${Object.keys(source).length}\n`);
  }
}
await Promise.all(Array.from({length:12},worker));
