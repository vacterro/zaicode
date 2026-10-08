const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../zcode');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const read = name => fs.readFileSync(path.join(root, name));
const result = {ticket:'T-268',pass:false,checks:[]};
const check = (name, ok) => { result.checks.push({name,pass:ok}); if(!ok)throw new Error(name); };
try {
  for (const ticket of ['T-268','T-267']) {
    const receipt = JSON.parse(fs.readFileSync(path.join(__dirname,ticket+'-comparison.json')));
    const digest = names => sha(Buffer.concat(names.flatMap(name => [Buffer.from(name+'\0'),read(name),...(ticket==='T-267'?[Buffer.from('\0')]:[])])));
    check(ticket+' final subject matches frozen comparison', digest(receipt.scope)===receipt.fixedSubject);
    const tests = ticket==='T-267'
      ? ['packages/ui/test/zaicodeSchedulerIdentity.test.ts','packages/ui/test/zaicodeContinuationEffects.test.ts']
      : receipt.tests;
    const oracle = ticket==='T-267' ? digest(tests) : sha(Buffer.concat([...tests.map(name=>[name,read(name)]),['verifier',fs.readFileSync(path.join(__dirname,ticket+'-compare.cjs'))]].flatMap(([name,bytes])=>[Buffer.from(name+'\0'),bytes])));
    check(ticket+' oracle unchanged',oracle===receipt.oracle);
    for(const pkg of ['ui','desktop']) {
      const inputs=tests.filter(name=>name.startsWith('packages/'+pkg+'/')).map(name=>name.slice(('packages/'+pkg+'/').length));
      if(inputs.length===0)continue;
      const run=spawnSync(process.execPath,['--import','tsx','--test',...inputs],{cwd:path.join(root,'packages',pkg),encoding:'utf8',timeout:60000});
      const log=(run.stdout||'')+(run.stderr||'');
      fs.writeFileSync(path.join(__dirname,ticket+'-review-'+pkg+'.log'),log);
      check(ticket+' '+pkg+' independent tests pass',run.status===0 && /tests (13|3|16)\s/.test(log) && /fail 0\s/.test(log));
    }
  }
  const native=JSON.parse(fs.readFileSync(path.join(__dirname,'T-268-native/final-packaged/receipt.json')));
  const asar=path.join(root,'packages/desktop/dist-next/win-unpacked/resources/app.asar');
  check('packaged native 13 checks pass',native.pass===true&&native.checks.length===13&&native.checks.every(c=>c.pass));
  check('packaged native binds current ASAR',native.asarSha256===sha(fs.readFileSync(asar)));
  check('packaged native binds unchanged verifier',native.verifierSha256===sha(fs.readFileSync('C:/Users/vac34/AppData/Local/Temp/playwright-test-t268.cjs')));
  result.pass=true;
} catch(error) {result.error=String(error);process.exitCode=1;}
fs.writeFileSync(path.join(__dirname,'T-268-review.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
