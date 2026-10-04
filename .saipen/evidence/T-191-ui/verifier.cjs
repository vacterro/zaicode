const {chromium}=require('playwright');
const fs=require('node:fs');
const TARGET_URL=process.env.T191_URL||'http://127.0.0.1:4191';
const OUT=process.env.T191_OUT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/.saipen/evidence/T-191-ui/before';
(async()=>{
  fs.mkdirSync(OUT,{recursive:true});
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1000,height:800}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const checks=[];const check=(name,actual,expected)=>checks.push({name,actual,expected,pass:actual===expected});
  const text=async s=>(await page.locator(s).count())?await page.locator(s).first().innerText():null;
  const tail=id=>`[data-case=${id}] [data-conversation-work-duration=end]`;
  const start=id=>`[data-case=${id}] [data-testid^=chat-assistant-history-trigger]`;
  const update=async p=>{await page.evaluate(p=>fixture.update(p),p);await page.clock.runFor(100);};
  try{
    await page.clock.install({time:new Date('2026-10-03T10:00:00Z')});
    await page.goto(TARGET_URL);await page.waitForFunction(()=>globalThis.fixture?.update);
    await page.clock.runFor(100);
    // Use the pre-existing real history button as a positive control, not a new selector.
    const header=id=>`[data-case=${id}] [data-history-open][type=button]`;
    for(const id of ['running','completed','interrupted']){
      const h=await text(header(id)),t=await text(tail(id));
      check(`${id} has existing header`,h!==null,true);
      check(`${id} footer matches header`,t!==null&&t===h,true);
      check(`${id} footer contains hours`,t?.includes('2h 35m')||false,true);
    }
    check('unknown duration is not fabricated',await text(tail('unknown')),'Worked');
    check('control-only turn has no duration footer',await page.locator(tail('control')).count(),0);
    const guided=await page.locator(tail('guided')).allTextContents();
    check('guide keeps both segment durations',JSON.stringify(guided),JSON.stringify(['Worked for 2h 5m','Worked for 30m']));
    await page.locator(header('completed')).click();await page.clock.runFor(100);
    check('collapsed history retains footer',await page.locator(tail('completed')).isVisible().catch(()=>false),true);
    const counts=await page.evaluate(()=>({rows:fixture.rowRenders,terminal:fixture.terminalRenders,mounts:fixture.terminalMounts,inputs:fixture.inputs.length}));
    await page.clock.runFor(65000);
    check('running footer advances',await text(tail('running')),'Working for 2h 36m');
    check('completed footer stays frozen',await text(tail('completed')),'Worked for 2h 35m');
    check('interrupted footer stays frozen',await text(tail('interrupted')),'Stopped · 2h 35m');
    check('clock does not rerender chat rows',await page.evaluate(()=>fixture.rowRenders),counts.rows);
    check('clock does not remount terminal',await page.evaluate(()=>fixture.terminalMounts),counts.mounts);
    check('clock submits no terminal input',await page.evaluate(()=>fixture.inputs.length),counts.inputs);
    check('worker retains original command',await page.evaluate(()=>fixture.inputs[0]),'fixture-original-command');
    check('worker footer is visible',await page.locator('[data-zaicode-worker-duration=end]').isVisible().catch(()=>false),true);
    check('worker footer matches running age',(await text('[data-zaicode-worker-duration=end]'))?.includes('2h 36m')||false,true);
    await page.evaluate(()=>fixture.terminalExit('fixture-worker',0));await page.clock.runFor(100);
    const workerFinal=await text('[data-zaicode-worker-duration=end]');
    await page.clock.runFor(3600000);
    check('worker successful exit freezes duration',await text('[data-zaicode-worker-duration=end]'),workerFinal);
    check('worker footer reports successful exit',workerFinal?.startsWith('exited 0 after ')||false,true);
    await update({exitCode:7,endedAt:Date.parse('2026-10-03T10:00:00Z')});
    check('worker failed exit uses recorded final duration',await text('[data-zaicode-worker-duration=end]'),'exited 7 after 2h 35m');
    await update({placement:'window',finished:true});
    check('floating worker keeps footer',await page.locator('[data-zaicode-worker-duration=end]').isVisible().catch(()=>false),true);
    check('completed chat uses persisted duration',await text(tail('running')),'Worked for 2h 35m');
    await page.setViewportSize({width:375,height:812});await page.clock.runFor(100);
    check('narrow worker footer stays visible',await page.locator('[data-zaicode-worker-duration=end]').isVisible().catch(()=>false),true);
    check('narrow viewport has no page overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.evaluate(()=>localStorage.removeItem('zcode-locale-preference'));
    await update({locale:'zh-CN'});
    const localized=await text(tail('completed'));
    check('duration footer uses existing localization',localized,'已工作 2 时 35 分');
    check('page errors',errors.length,0);
    await page.screenshot({path:OUT+'/duration.png',fullPage:true});
    const report={checks,errors,pass:checks.every(c=>c.pass)};fs.writeFileSync(OUT+'/report.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify({pass:report.pass,total:checks.length,failed:checks.filter(c=>!c.pass)}));
    if(!report.pass)process.exitCode=1;
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
