const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');
const product = path.resolve(__dirname, '../../../..');
const root = path.dirname(product);
const req = createRequire(path.join(product, 'packages/desktop/package.json'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

async function run({chromium, sourcePath = path.join(product, 'packages/ui/src/zaicode/zaicodePixelSnap.ts'), out}) {
  await fs.mkdir(out, {recursive:true});
  const source = await fs.readFile(sourcePath, 'utf8');
  const built = await req('esbuild').build({stdin:{contents:source,loader:'ts',resolveDir:path.dirname(sourcePath)},bundle:true,write:false,format:'iife',globalName:'snapAPI',platform:'browser'});
  const oraclePath=__filename;
  const report = {at:new Date().toISOString(), sourcePath,sourceSha256:hash(source),oracleSha256:hash(await fs.readFile(oraclePath)),fixtureOnly:true,checks:[],errors:[],pass:false};
  const browser = await chromium.launch({headless:false});
  try {
    for (const ratio of [1,1.25,2]) {
      const context = await browser.newContext({viewport:{width:900,height:700},deviceScaleFactor:ratio});
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(String(error)));
      await page.setContent(`<style>body{margin:0}.moved{margin-left:19.75px!important}[data-workspace-shell]{width:601px;margin-left:19.25px;height:400px}.column{width:400px;margin:auto}.xy{position:absolute;left:10.5px;top:20.5px}#unrelated{position:absolute;top:500px}</style><main data-workspace-shell="true"><div class="column" data-v4-timeline-content-column="true">Actual snap column</div><div class="xy" data-zaicode-pixel-snap="xy">XY anchor</div><div id="later">Later marker</div></main><aside id="unrelated"></aside>`);
      await page.evaluate(() => {
        window.metrics={targetReads:0,documentScans:0,intervals:0};
        const selector='[data-v4-timeline-content-column="true"], [data-v4-composer-dock-content="true"], [data-zaicode-pixel-snap]';
        const rect=Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect=function(){if(this.matches(selector))window.metrics.targetReads++;return rect.call(this);};
        const query=Document.prototype.querySelectorAll;
        Document.prototype.querySelectorAll=function(s){if(s.includes('pixel-snap')||s.includes('timeline-content-column'))window.metrics.documentScans++;return query.call(this,s);};
        const interval=window.setInterval;
        window.setInterval=function(...args){window.metrics.intervals++;return interval.apply(this,args);};
        window.originalStyles=[...document.querySelectorAll(selector)].map(el=>[el,{position:el.style.position,left:el.style.left,top:el.style.top}]);
      });
      await page.addScriptTag({content:built.outputFiles[0].text});
      const frames = count => page.evaluate(count=>new Promise(resolve=>{function frame(){if(--count<=0)resolve();else requestAnimationFrame(frame);}requestAnimationFrame(frame);}),count);
      const check = (name,pass,detail) => report.checks.push({name,ratio,pass,detail});
      await page.evaluate(()=>window.stopSnap=snapAPI.installZaicodePixelSnap());
      await page.evaluate(()=>document.fonts.ready);await frames(5);
      const aligned=()=>page.evaluate(()=>[...document.querySelectorAll('[data-v4-timeline-content-column="true"],[data-zaicode-pixel-snap]')].map(el=>{const r=el.getBoundingClientRect(),d=devicePixelRatio;return {x:r.left,y:r.top,mode:el.dataset.zaicodePixelSnap,alignedX:Math.abs(r.left*d-Math.round(r.left*d))<0.025,alignedY:el.dataset.zaicodePixelSnap!=='xy'||Math.abs(r.top*d-Math.round(r.top*d))<0.025};}));
      const initial=await aligned();check('Initial rendered text lands on device pixels',initial.every(r=>r.alignedX&&r.alignedY),initial);report.instrumentReady=(report.instrumentReady??true)&&initial[0].alignedX;
      const reset=()=>page.evaluate(()=>Object.assign(window.metrics,{targetReads:0,documentScans:0}));
      await reset();await page.waitForTimeout(3200);const idle=await page.evaluate(()=>({...window.metrics}));
      check('Idle performs no target reads, broad scans or periodic timer',idle.targetReads===0&&idle.documentScans===0&&idle.intervals===0,idle);
      await reset();
      for(let index=0;index<30;index++){await page.evaluate(index=>{const unrelated=document.getElementById('unrelated');unrelated.className='churn-'+index;const span=document.createElement('span');span.textContent='unrelated '+index;unrelated.replaceChildren(span);},index);await frames(2);}
      const churn=await page.evaluate(()=>({...window.metrics}));check('Unrelated DOM churn performs no target layout reads or document scans',churn.targetReads===0&&churn.documentScans===0,churn);
      await page.evaluate(()=>{const el=document.querySelector('.xy');el.style.left='22.3px';el.style.top='35.3px';});await frames(5);const repositioned=await aligned();check('External inline anchor movement replaces the correction base',repositioned.every(r=>r.alignedX&&r.alignedY)&&Math.abs(repositioned[1].x-22.3)<1&&Math.abs(repositioned[1].y-35.3)<1,repositioned);
      await page.evaluate(()=>{const saved=window.originalStyles[1][1];saved.left='22.3px';saved.top='35.3px';});
      await page.evaluate(()=>document.querySelector('[data-workspace-shell]').style.width='602px');await frames(5);const resized=await aligned();check('Ancestor resize preserves rendered snapping',resized.every(r=>r.alignedX&&r.alignedY),resized);
      await page.evaluate(()=>document.querySelector('[data-workspace-shell]').className='moved');await frames(5);const moved=await aligned();check('Ancestor class movement without size change snaps again',moved.every(r=>r.alignedX&&r.alignedY),moved);
      await page.evaluate(()=>{window.removedTarget=document.querySelector('[data-v4-timeline-content-column]');window.removedTarget.remove();const el=document.createElement('div');el.className='column';el.dataset.v4ComposerDockContent='true';el.textContent='New real target';document.querySelector('[data-workspace-shell]').append(el);});await frames(5);
      const mounted=await page.locator('[data-v4-composer-dock-content]').evaluate(el=>{const r=el.getBoundingClientRect();return Math.abs(r.left*devicePixelRatio-Math.round(r.left*devicePixelRatio))<0.025;});check('A new subtree target is discovered and snapped',mounted,{});
      await page.evaluate(()=>document.getElementById('later').setAttribute('data-zaicode-pixel-snap','xy'));await frames(5);const marker=await aligned();check('An existing element gaining a marker is snapped',marker.every(r=>r.alignedX&&r.alignedY),marker);
      await page.evaluate(()=>window.stopSnap());await frames(3);
      const restored=await page.evaluate(()=>window.originalStyles.every(([el,s])=>el.style.position===s.position&&el.style.left===s.left&&el.style.top===s.top));check('Detached and connected targets restore original styles on cleanup',restored,{});
      await page.screenshot({path:path.join(out,'pixel-snap-dpr-'+ratio+'.png')});
      await context.close();
    }
    report.pass=report.instrumentReady&&report.errors.length===0&&report.checks.every(check=>check.pass);
  } catch(error) {report.error=String(error);}
  finally {await browser.close();await fs.writeFile(path.join(out,'receipt.json'),JSON.stringify(report,null,2));await fs.copyFile(oraclePath,path.join(out,'acceptance-script.cjs'));}
  return report;
}
module.exports = {run};
