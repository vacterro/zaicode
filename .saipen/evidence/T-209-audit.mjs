import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const root=resolve(import.meta.dirname,'../..'),product=join(root,'zcode'),evidence=join(root,'.saipen/evidence');
const read=p=>readFileSync(join(root,p));
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(read(p).toString());
const before=json('.saipen/evidence/T-209-before.json');
for(const [p,h] of Object.entries(before.instruments))assert.equal(hash(read(p)),h,p);
for(const [p,h] of Object.entries(before.foreign))assert.equal(hash(read('zcode/'+p)),h,p);
const sources=Object.keys(before.subject).sort();
const paths=[...sources,'packages/ui/test/zaicodeT209WorkersCollapse.test.ts','specs/zaicode-t209-workers-collapse.md'].sort();
const owned=Object.fromEntries(paths.map(p=>[p,hash(read('zcode/'+p))]));
const old=Object.fromEntries(sources.map(p=>[p,hash(execFileSync('git',['show',before.base+':'+p],{cwd:product}))]));
const regression={verifier:hash(JSON.stringify(Object.fromEntries(Object.entries(before.instruments).sort()))),redSubject:hash(JSON.stringify(old)),greenSubject:hash(JSON.stringify(Object.fromEntries(sources.map(p=>[p,owned[p]]))))};
if(process.argv[2]==='freeze'){
  writeFileSync(join(evidence,'T-209-subject-final.json'),JSON.stringify({base:before.base,owned,foreign:before.foreign,regression,instruments:before.instruments},null,2));
  console.log(JSON.stringify({owned:paths.length,foreign:Object.keys(before.foreign).length,...regression}));
}else{
  assert.deepEqual(owned,json('.saipen/evidence/T-209-subject-final.json').owned);
  const red=json('.saipen/evidence/T-209-packaged-red.json'),green=json('.saipen/evidence/T-209-packaged-green.json');
  assert.equal(red.pass,false);assert.equal(green.pass,true);assert.deepEqual(green.errors,[]);
  assert.equal(red.verifier,green.verifier);assert.equal(green.verifier,before.instruments['.saipen/evidence/T-209-packaged.cjs']);
  for(const dock of ['bottom','right','left','top']){
    assert.equal(red.checks.find(c=>c.name===dock+': collapse retains compact header').pass,false);
    assert.equal(green.checks.find(c=>c.name===dock+': collapse retains compact header').pass,true);
  }
  assert.ok(red.checks.filter(c=>c.name.includes('positive:')).every(c=>c.pass));
  for(const kind of ['typecheck','lint','architecture','tests','build','bundle']){
    const r=json(`.saipen/evidence/T-209-${kind}-final.json`);assert.equal(r.exit,0);assert.deepEqual(r.sourceChanges,[]);
  }
  const text=read('.saipen/evidence/T-209-tests-final.txt').toString();
  const total=name=>[...text.matchAll(new RegExp('ℹ '+name+' (\\d+)','g'))].reduce((s,m)=>s+Number(m[1]),0);
  // \d is doubled on purpose: a single \d inside a JS string collapses to a literal 'd', the
  // regex then matches nothing and every total reads 0, which would make the >= 1485 floor
  // fail for the wrong reason instead of measuring the suite.
  const totals={tests:total('tests'),passed:total('pass'),failed:total('fail'),skipped:total('skipped')};
  assert.equal(totals.failed,0);assert.equal(totals.tests,totals.passed+totals.skipped);assert.ok(totals.passed>=1485);
  const report={at:new Date().toISOString(),...regression,totals,packaged:green.checks.length,owned:paths,foreignPreserved:Object.keys(before.foreign).length};
  writeFileSync(join(evidence,'T-209-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
