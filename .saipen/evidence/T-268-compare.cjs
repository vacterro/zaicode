const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../zcode'), baseline = path.join(__dirname, 'T-268-original');
const files = [
 'packages/shared/src/zaicode-engines.ts', 'packages/ui/src/zaicode/zaicodeAutostart.ts',
 'packages/ui/src/zaicode/ZaicodeSchedulerPanel.tsx', 'packages/ui/src/zaicode/zaicodeSidebarWidth.ts',
 'packages/ui/src/zaicode/zaicodeActions.ts', 'packages/ui/src/lib/workspaceSidePane.ts',
 'packages/ui/src/hooks/useAppPanels.ts', 'packages/ui/src/App.tsx', 'packages/ui/src/app-shell/types.ts',
 'packages/ui/src/app-shell/WorkspaceShellLayout.tsx', 'packages/desktop/src/main/zaicodeWindowStarter.ts',
 'packages/desktop/src/main/zaicodeEngines.ts',
];
const tests = ['packages/ui/test/zaicodeSchedulerAdmission.test.ts', 'packages/ui/test/zaicodeWindowPoolAdmission.test.ts', 'packages/ui/test/zaicodeSchedulerResetBoundary.test.ts',
 'packages/ui/test/zaicodeSaipenToggle.test.ts', 'packages/desktop/test/zaicodeBoundedWindowStart.test.ts'];
const read = name => fs.readFileSync(path.join(root, name));
const digest = rows => crypto.createHash('sha256').update(Buffer.concat(rows.flatMap(([name, bytes]) => [Buffer.from(name+'\0'), bytes]))).digest('hex');
const fixed = files.map(name => [name, read(name)]), original = files.map(name => [name, fs.readFileSync(path.join(baseline, name))]);
const oracle = digest([...tests.map(name => [name, read(name)]), ['verifier', fs.readFileSync(__filename)]]);
const write = values => values.forEach(([name, bytes]) => fs.writeFileSync(path.join(root, name), bytes));
const build = () => {
 const r = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b', 'packages/shared'], {cwd:root,encoding:'utf8',timeout:60000});
 if(r.status!==0)throw new Error('shared build: '+r.stdout+r.stderr);
};
const run = name => {
 build(); const results = ['ui','desktop'].map(pkg => {
  const inputs = tests.filter(t=>t.startsWith('packages/'+pkg+'/')).map(t=>t.slice(('packages/'+pkg+'/').length));
  const r = spawnSync(process.execPath, ['--import','tsx','--test',...inputs], {cwd:path.join(root,'packages',pkg),encoding:'utf8',timeout:60000});
  const log = (r.stdout||'')+(r.stderr||'');
  fs.writeFileSync(path.join(__dirname, 'T-268-'+name+'-'+pkg+'.log'),log);
  if(!new RegExp('tests '+(pkg==='ui'?13:3)+'(?:\\s|$)').test(log))throw new Error('missing tests: '+log);
  return r.status;
 }); return results;
};
let red;
try { write(original); red = run('original-repeat'); } finally { write(fixed); build(); }
const green = run('fixed-repeat');
if(digest([...tests.map(name=>[name,read(name)]),['verifier',fs.readFileSync(__filename)]])!==oracle)throw new Error('oracle changed');
const receipt = {ticket:'T-268',oracle,originalSubject:digest(original),fixedSubject:digest(fixed),red,green,scope:files,tests};
fs.writeFileSync(path.join(__dirname,'T-268-comparison.json'),JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt));
if(red.some(x=>x===0||x===null)||green.some(x=>x!==0))process.exitCode=1;
