import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const root=resolve(import.meta.dirname,'../..'),evidence=join(root,'.saipen/evidence');
const read=p=>readFileSync(join(root,p)),json=p=>JSON.parse(read(p));
const hash=b=>createHash('sha256').update(b).digest('hex');
const s=json('.saipen/evidence/T-212-subject-final.json');
for(const [p,h] of Object.entries({...s.owned,...s.foreign}))assert.equal(hash(read('zcode/'+p)),h,p);
for(const [p,h] of Object.entries(s.instruments))assert.equal(hash(read(p)),h,p);
if(process.argv[2]==='stable'){console.log(JSON.stringify({owned:4,foreign:Object.keys(s.foreign).length,unchanged:true}));process.exit(0)}
const red=json('.saipen/evidence/T-212-packaged-red.json');
const green=json('.saipen/evidence/T-212-packaged-'+(process.argv[2]==='review'?'review':'green')+'.json');
assert.equal(red.pass,false);assert.equal(green.pass,true);assert.deepEqual(green.errors,[]);
assert.equal(red.verifier,green.verifier);assert.equal(red.verifier,s.instruments['.saipen/evidence/T-212-packaged.cjs']);
assert.equal(red.checks.length,10);assert.equal(green.checks.length,10);
assert.equal(red.checks.filter(c=>c.pass).length,9);assert.ok(red.errors.length>0);
const unit=read('.saipen/evidence/T-212-unit-red.txt').toString();assert.match(unit,/ℹ fail 4/);
for(const kind of ['typecheck','lint','architecture','tests','build','bundle']){
  const r=json(`.saipen/evidence/T-212-${kind}-final.json`);assert.equal(r.exit,0);assert.deepEqual(r.sourceChanges,[]);
}
const text=read('.saipen/evidence/T-212-tests-final.txt').toString();
const total=name=>[...text.matchAll(new RegExp('ℹ '+name+' (\\d+)','g'))].reduce((s,m)=>s+Number(m[1]),0);
// The \d above is doubled on purpose: inside a JS string literal a single \d collapses to a
// literal 'd', the regex then matches nothing, and every total below reads 0 -- which would
// have made `passed >= 1487` fail for the wrong reason instead of measuring the suite.
const totals={tests:total('tests'),passed:total('pass'),failed:total('fail'),skipped:total('skipped')};
assert.equal(totals.failed,0);assert.equal(totals.tests,totals.passed+totals.skipped);assert.ok(totals.passed>=1487);
const report={at:new Date().toISOString(),...s.regression,totals,packaged:green.checks.length,owned:Object.keys(s.owned),foreignPreserved:Object.keys(s.foreign).length};
writeFileSync(join(evidence,'T-212-verification'+(process.argv[2]==='review'?'-review':'')+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
