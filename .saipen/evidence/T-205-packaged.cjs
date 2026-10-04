const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=process.env.T212_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T212_PACKAGED_EXE),out=process.env.T212_PACKAGED_OUT;
if(!out)throw new Error('T212_PACKAGED_OUT required');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t205-'));
const project=path.join(profile,'usage-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[],check=(name,pass,detail)=>checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});
const shareOf=async node=>parseFloat((await node.evaluate(el=>el.style.width))||'NaN');
(async()=>{
  let app,page,pid,stage='boot';const errors=[];
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T205 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
  try{
    app=await _electron.launch({executablePath:exe,args:['--user-data-dir='+profile],env,timeout:90000});pid=app.process().pid;
    page=await (async()=>{const end=Date.now()+60000;while(Date.now()<end){const ws=app.windows();const hit=ws.find(w=>w.url().includes('/out/renderer/index.html'));if(hit)return hit;await pause(60)}throw new Error('Timed out: main renderer')})();
    page.on('pageerror',e=>errors.push({stage,stack:String(e.stack||e)}));
    await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    check('positive: isolated packaged profile',path.resolve(await app.evaluate(({app})=>app.getPath('userData')))===path.resolve(profile));
    // The Usage footer tool ships hidden; the operator turns it on in the footer settings.
    await page.evaluate(()=>{
      localStorage.setItem('zcode-locale-preference','en-US');
      localStorage.setItem('zaicode-protrail-v1',JSON.stringify({trail:{enabled:false},click:{enabled:false}}));
      localStorage.setItem('zaicode-bevels','0');
      localStorage.setItem('zaicode-layout-v1',JSON.stringify({footerTools:[{id:'usage',visible:true},{id:'settings',visible:true}]}));
    });
    await page.reload();await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    await page.setViewportSize({width:1280,height:900});

    stage='usage page';
    const tool=page.locator('[aria-label^="9router Usage"]').first();
    await tool.waitFor({state:'visible',timeout:20000});
    await tool.click({timeout:10000});
    const panel=page.locator('[data-zaicode-usage="page"]');
    await panel.waitFor({state:'visible',timeout:20000});
    check('the usage panel opens from its footer tool',await panel.isVisible());

    stage='refresh switcher';
    const picker=panel.locator('[data-zaicode-usage-refresh]');
    await picker.waitFor({state:'visible',timeout:15000});
    const options=await picker.locator('option').evaluateAll(nodes=>nodes.map(node=>node.value));
    check('the refresh switcher offers 10/5/3/2/1 seconds',JSON.stringify(options)===JSON.stringify(['10','5','3','2','1']),options);
    check('the refresh switcher starts at 10 seconds',await picker.inputValue()==='10');
    const live=panel.locator('input[type="checkbox"]').first();
    check('live reading is on by default',await live.isChecked());
    check('the switcher is usable while live reading is on',await picker.isEnabled());
    await picker.selectOption('1');
    check('choosing 1 second sticks',await picker.inputValue()==='1');
    check('the live label no longer claims 10s',!(await panel.innerText()).includes('Live · 10s'));
    await live.uncheck();await pause(100);
    check('turning live reading off disables the switcher',!(await picker.isEnabled()));
    await live.check();await pause(100);

    stage='resizable name column';
    const table=panel.locator('table');
    const head=table.locator('th').first();
    const handle=head.locator('[data-zaicode-usage-column-resize]');
    check('the name column carries a drag handle',await handle.count()===1);
    check('the handle is a vertical separator',await handle.getAttribute('role')==='separator'&&await handle.getAttribute('aria-orientation')==='vertical');
    const before=await shareOf(head);
    check('the name column starts at its 34% share',before===34,before);
    // With no 9router behind it the panel has no rows to compare; record how many it had so a
    // vacuous pass is never read as evidence that the body cells were checked.
    const body=await table.evaluate(node=>{
      const cells=[...node.querySelectorAll('tbody td[style*="width"]')];
      return {cells:cells.length,widths:cells.map(cell=>cell.style.width)};
    });
    check('every body cell that declares a width matches the header',body.cells>0?body.widths.every(w=>parseFloat(w)===before):true,body);
    const hb=await handle.boundingBox(),tb=await table.boundingBox();
    await page.mouse.move(hb.x+hb.width/2,hb.y+hb.height/2);
    await page.mouse.down();
    await page.mouse.move(tb.x+tb.width*0.5,hb.y+hb.height/2,{steps:10});
    await page.mouse.up();
    await pause(150);
    const widened=await shareOf(head);
    check('dragging the handle widens the name column',widened>before,{before,widened});
    check('the widened column keeps the metric columns',widened<=70,widened);
    // The handle sits on the right edge of the column, so the widened column moved it: re-measure
    // before the second drag or the pointer lands on the header and nothing is captured.
    const hb2=await handle.boundingBox();
    await page.mouse.move(hb2.x+hb2.width/2,hb2.y+hb2.height/2);
    await page.mouse.down();
    await page.mouse.move(tb.x+tb.width*0.99,hb2.y+hb2.height/2,{steps:10});
    await page.mouse.up();
    await pause(150);
    const clamped=await shareOf(head);
    check('a drag past the table stops at the 70% ceiling',clamped===70,clamped);
    await page.screenshot({path:out+'.png'});

    stage='no Done word';
    check('a finished request prints no Done word',!(await panel.innerText()).includes('Done'));

    await pause(300);check('zero renderer exceptions while driving the usage panel',errors.length===0,errors);
    const receipt={at:new Date().toISOString(),executablePath:exe,profile,checks,errors,pass:checks.every(c=>c.pass),verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')};
    fs.writeFileSync(out+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({pass:receipt.pass,checks:checks.length,failed:checks.filter(c=>!c.pass).map(c=>c.name),receipt:out+'.json'}));process.exitCode=receipt.pass?0:1;
  }catch(error){fs.writeFileSync(out+'.json',JSON.stringify({pass:false,checks,errors,error:String(error.stack||error),profile,executablePath:exe,verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')},null,2));console.error(String(error));process.exitCode=1;
  }finally{if(app)try{await app.close()}catch{}}
})();