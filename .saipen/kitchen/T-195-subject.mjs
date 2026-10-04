import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),product=join(root,'zcode'),output=join(root,'.saipen/evidence/T-195-subject.json');
const own=[
  'packages/ui/src/v4/composer/composerDraftStore.ts',
  'packages/ui/src/v4/composer/useDraftConfigControl.ts',
  'packages/ui/src/v4/composer/composerPlanTransition.ts',
  'packages/ui/src/v4/composer/newTaskDraft.ts',
  'packages/ui/src/ToolCallBlocks/renderers/switch-mode.tsx',
  'packages/ui/src/v4/ConversationTurnRow.tsx',
  'apps/zcode-cli/packages/core/src/tool/handlers/plan-mode-prompts.ts',
  'packages/ui/test/zaicodeImmediateImplementation.test.ts',
  'apps/zcode-cli/packages/core/test/zaicodeImmediateImplementation.test.ts',
  'specs/zaicode-immediate-implementation.md',
];
const digest=value=>createHash('sha256').update(value).digest('hex');
const file=async path=>({path,sha256:digest(await readFile(join(product,path)))});
if(process.argv[2]==='check'){
  const frozen=JSON.parse(await readFile(output,'utf8'));
  for(const entry of [...frozen.own,...frozen.foreign])if((await file(entry.path)).sha256!==entry.sha256)throw new Error('Frozen subject changed: '+entry.path);
  console.log(JSON.stringify({pass:true,own:frozen.own.length,foreign:frozen.foreign.length,fingerprint:frozen.fingerprint}));
}else{
  const previous=JSON.parse(await readFile(join(root,'.saipen/evidence/T-192-subject.json'),'utf8'));
  for(const entry of previous.foreign)if((await file(entry.path)).sha256!==entry.sha256)throw new Error('Foreign/T-188 path changed: '+entry.path);
  const paths=execFileSync('git',['-C',product,'ls-files','-m','-o','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
  const ownFiles=await Promise.all(own.map(file)),foreign=await Promise.all(paths.filter(path=>!own.includes(path)).map(file));
  const manifest={schema:'t195-subject/1',at:new Date().toISOString(),head:execFileSync('git',['-C',product,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),own:ownFiles,foreign,fingerprint:digest(JSON.stringify(ownFiles))};
  await writeFile(output,JSON.stringify(manifest,null,2));console.log(JSON.stringify({own:ownFiles.length,foreign:foreign.length,fingerprint:manifest.fingerprint}));
}
