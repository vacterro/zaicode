const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const URL=process.env.T192_UI_URL||'http://127.0.0.1:4192';
const OUT=process.env.T192_UI_OUT;
(async()=>{
  const browser=await chromium.launch({headless:true});const page=await browser.newPage();
  const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
  const check=(name,pass)=>checks.push({name,pass:!!pass});
  const menu=async()=>{await page.locator('[data-worker-menu]').click({button:'right'});return page.getByRole('menuitem',{name:'Move to PowerShell',exact:true})};
  try {
    for(const mode of ['success','failure','missing','exited','nostart','stale']){
      await page.goto(`${URL}?mode=${mode}`);await page.waitForFunction(()=>globalThis.fixture?.creates.length===1);await page.waitForFunction(()=>globalThis.fixture.writes.length===1);
      check(`${mode}: original command typed once`,await page.evaluate(()=>globalThis.fixture.writes.length===1&&globalThis.fixture.writes[0]==='original-fixture-command\r'));
      check(`${mode}: requests broker capability at creation`,await page.evaluate(()=>globalThis.fixture.creates[0].externalizable===true));
      if(mode==='success'){await page.evaluate(()=>globalThis.fixture.remount());check('moving worker retains its original PTY',await page.evaluate(()=>globalThis.fixture.creates.length===1));}
      const item=await menu();const exists=await item.count();check(`${mode}: menu offers one-way PowerShell action`,exists===1);
      if(!exists){await page.keyboard.press('Escape');continue;}
      const disabled=['missing','exited','nostart'].includes(mode);
      check(`${mode}: readiness/capability/exit guard`,(await item.getAttribute('aria-disabled')==='true')===disabled);
      if(disabled){await page.keyboard.press('Escape');continue;}
      await item.click();await page.waitForFunction(()=>globalThis.fixture.calls===1);
      check(`${mode}: retains worker until acknowledgement`,await page.evaluate(()=>globalThis.fixture.removed.length===0&&globalThis.fixture.disposed.length===0));
      if(mode==='failure'){await page.waitForFunction(()=>globalThis.fixture.toasts.length>0);check('failed launch keeps worker and its PTY',await page.evaluate(()=>globalThis.fixture.removed.length===0&&globalThis.fixture.disposed.length===0));}
      else {if(mode==='stale')await page.evaluate(()=>globalThis.fixture.replace());await page.evaluate(()=>globalThis.fixture.complete());
        if(mode==='stale'){await page.waitForFunction(()=>globalThis.fixture.toasts.length>0);check('late handoff never removes a newer generation',await page.evaluate(()=>globalThis.fixture.removed.length===0));}
        else {await page.waitForFunction(()=>globalThis.fixture.removed.length===1);check('success removes presentation and releases old app attachment once',await page.evaluate(()=>globalThis.fixture.disposed.length===1));}}
      check(`${mode}: never types the original CLI command twice`,await page.evaluate(()=>globalThis.fixture.writes.length===1));
    }
    check('no uncaught browser errors',errors.length===0);
  }catch(e){checks.push({name:'browser instrument completed',pass:false,error:String(e)})}finally{await browser.close()}
  const receipt={schema:'t192-ui/1',checks,errors,pass:checks.every(c=>c.pass),verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
  if(OUT){fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'receipt.json'),JSON.stringify(receipt,null,2))}
  console.log(JSON.stringify(receipt));process.exitCode=receipt.pass?0:1;
})();
