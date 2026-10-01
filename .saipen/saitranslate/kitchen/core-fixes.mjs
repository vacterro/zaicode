// Core-owned source-drift repair. The ordinary batch acceptance path owns the merge.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root=import.meta.dirname;
const values={
  'chat.toolCall.taskOutput.fetching':'Ожидание фоновой задачи',
  'chat.toolCall.taskOutput.timeout':'Задача ещё выполняется, ожидание завершено',
  'feedback.severity.P1-高.label':'Невозможно пользоваться',
  'feedback.severity.P2-中.label':'Мешает работе',
  'feedback.severity.P3-低.label':'Небольшая проблема или предложение',
};
const keyFile=join(root,'ru-source-fixes.json');
writeFileSync(keyFile,JSON.stringify(Object.keys(values))+'\n');
for(;;) {
  try { mkdirSync(join(root,'.lock')); break; }
  catch { await new Promise(resolve=>setTimeout(resolve,200)); }
}
try {
  const issued=spawnSync(process.execPath,[join(root,'runner.mjs'),'repair','ru-RU',keyFile],{encoding:'utf8'});
  const id=/issued (\S+):/.exec(issued.stdout)?.[1];
  if(!id)throw new Error(issued.stdout+issued.stderr);
  const batch=JSON.parse(readFileSync(join(root,'outbox',`${id}.json`),'utf8'));
  const answer=join(root,'outbox',`${id}.txt`);
  writeFileSync(answer,batch.keys.map((key,index)=>`${index+1}|${JSON.stringify(values[key])}`).join('\n')+'\n');
  const accepted=spawnSync(process.execPath,[join(root,'tools.mjs'),'done',id,answer],{encoding:'utf8'});
  process.stdout.write(accepted.stdout+accepted.stderr);
  if(accepted.status!==0)process.exitCode=1;
}finally{rmdirSync(join(root,'.lock'));}
