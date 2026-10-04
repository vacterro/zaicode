const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const URL=process.env.T195_UI_URL||'http://127.0.0.1:4195',OUT=process.env.T195_UI_OUT;
(async()=>{
  const browser=await chromium.launch({headless:false}),page=await browser.newPage();
  const checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
  const check=(name,pass)=>checks.push({name,pass:!!pass});
  const load=async(query)=>{await page.goto(URL+query);await page.waitForFunction(()=>globalThis.fixture?.ready)};
  try{
    await load('');
    check('ZAICODE renders no successful historical plan card',await page.locator('#plan-slot section').count()===0);
    check('normal answer remains visible',await page.locator('#normal-answer').innerText()==='Implemented and verified.');
    check('copy excludes hidden plan body',await page.evaluate(()=>fixture.copy==='Implemented and verified.'));
    await page.locator('#toggle-product').click();await page.waitForFunction(()=>!fixture.product);
    check('upstream plan card still appears after rerender',await page.locator('#plan-slot section').count()===1);
    check('upstream copy retains its displayed plan',await page.evaluate(()=>fixture.copy.includes('# Historical plan')));
    await page.locator('#toggle-product').click();await page.waitForFunction(()=>fixture.product);
    check('switching back removes card without hook mismatch',await page.locator('#plan-slot section').count()===0);
    await page.locator('#toggle-error').click();await page.waitForFunction(()=>fixture.failure);
    check('real plan failure remains visible',await page.locator('#plan-slot').innerText().then(t=>t.includes('Fixture planning failure')));
    check('failure does not render a success plan card',await page.locator('#plan-slot section').count()===0);
    await page.setViewportSize({width:375,height:700});
    check('narrow viewport preserves the normal answer',await page.locator('#normal-answer').isVisible());
    check('no browser exceptions',errors.length===0);
  }catch(error){checks.push({name:'instrument completes',pass:false,error:String(error)})}finally{await browser.close()}
  const receipt={schema:'t195-ui/1',checks,errors,pass:checks.every(c=>c.pass),verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')};
  if(OUT){fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'receipt.json'),JSON.stringify(receipt,null,2))}
  console.log(JSON.stringify(receipt));process.exitCode=receipt.pass?0:1;
})();
