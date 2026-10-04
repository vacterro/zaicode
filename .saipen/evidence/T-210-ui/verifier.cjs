const {chromium}=require('playwright');
const fs=require('node:fs');
const crypto=require('node:crypto');
const URL=process.env.T210_URL||'http://127.0.0.1:4210';
const OUT=process.env.T210_OUT;
if(!OUT)throw new Error('T210_OUT is required');
(async()=>{
  fs.mkdirSync(OUT,{recursive:true});
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1000,height:800}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const checks=[];const check=(name,actual,expected)=>checks.push({name,actual,expected,pass:actual===expected});
  const label=id=>`[data-case=${id}] [data-conversation-work-duration=end]`;
  const share=id=>`[data-share=${id}] [data-conversation-share-history-trigger]`;
  const text=async s=>page.locator(s).first().innerText();
  try{
    await page.clock.install({time:new Date('2026-10-03T10:00:00Z')});
    await page.goto(URL);await page.waitForSelector(label('normal'));
    for(const id of ['normal','restored','detached'])check(`${id} authoritative duration`,await text(label(id)),'Working for 2h 35m');
    check('very fresh established start',await text(label('fresh')),'Working for 1s');
    for(const id of ['missing','zero','negative','nan','infinite','future']){
      check(`${id} neutral chat label`,await text(label(id)),'Working');
      check(`${id} neutral shared label`,await text(share(id)),'Working');
    }
    check('reported zero remains a known duration',await text(label('recorded')),'Working for 1s');
    check('completed work remains terminal',await text(label('completed')),'Worked for 2h 35m');
    check('interrupted work remains terminal',await text(label('interrupted')),'Stopped · 2h 35m');
    check('idle work has no Working label',await text(label('idle')),'Worked');
    const rowRenders=await page.evaluate(()=>fixture.rowRenders);
    await page.clock.runFor(65000);
    check('known active duration advances',await text(label('normal')),'Working for 2h 36m');
    check('unknown start stays unknown after ticks',await text(label('missing')),'Working');
    check('completed duration stays frozen',await text(label('completed')),'Worked for 2h 35m');
    check('display clock never rerenders work rows',await page.evaluate(()=>fixture.rowRenders),rowRenders);
    await page.evaluate(()=>fixture.restart());await page.clock.runFor(100);
    check('reused status component admits the next actual run',await text(label('normal')),'Working for 1s');
    await page.clock.runFor(2000);
    check('next run clock advances after component reuse',await text(label('normal')),'Working for 2s');
    await page.reload();await page.waitForSelector(label('restored'));
    check('restarted renderer retains actual start',await text(label('restored')),'Working for 2h 36m');
    check('restarted renderer creates no missing start',await text(label('missing')),'Working');
    await page.setViewportSize({width:375,height:812});
    check('narrow layout has no overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.evaluate(()=>localStorage.removeItem('zcode-locale-preference'));
    await page.goto(URL+'?locale=et-EE');await page.waitForSelector(label('missing'));
    check('neutral label is localized',await text(label('missing')),'Töötab');
    check('localized shared label matches',await text(share('missing')),'Töötab');
    check('page errors',errors.length,0);
    await page.screenshot({path:OUT+'/duration.png',fullPage:true});
    const report={checks,errors,pass:checks.every(c=>c.pass),verifierSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
    fs.writeFileSync(OUT+'/report.json',JSON.stringify(report,null,2));
    console.log(JSON.stringify({pass:report.pass,total:checks.length,failed:checks.filter(c=>!c.pass)}));
    if(!report.pass)process.exitCode=1;
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
