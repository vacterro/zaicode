import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const product=resolve(here,'../../../zcode');
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const ownPaths=['packages/ui/src/v4/ConversationTurnGroup.tsx','packages/ui/src/zaicode/ZaicodeWorkerParts.tsx','specs/zaicode-session-duration-tail.md'];
const parent=JSON.parse(readFileSync(resolve(here,'../T-188-subject-final.json'),'utf8'));
const preserved=parent.files.map(f=>({...f,actual:sha(resolve(product,f.path))}));
if(preserved.some(f=>f.sha256!==f.actual))throw new Error('Parent T-188 subject changed');
const subject=ownPaths.map(path=>({path,sha256:sha(resolve(product,path))}));
const instrument=['serve.mjs','harness.tsx','verifier.cjs'].map(path=>({path,sha256:sha(resolve(here,path))}));
const manifest={schema:'zaicode-t191-subject/1',sourceBase:execFileSync('git',['-C',product,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),
  subject,instrument,subjectDigest:createHash('sha256').update(JSON.stringify(subject)).digest('hex'),preserved};
writeFileSync(resolve(here,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({subjectDigest:manifest.subjectDigest,instrument:instrument.find(f=>f.path==='verifier.cjs').sha256,preserved:preserved.length}));
