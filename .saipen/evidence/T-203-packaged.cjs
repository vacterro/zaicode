const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=process.env.T212_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T212_PACKAGED_EXE),out=process.env.T212_PACKAGED_OUT;
if(!out)throw new Error('T212_PACKAGED_OUT required');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t203-'));
const project=path.join(profile,'search-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[],check=(name,pass,detail)=>checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});
const navIds=async page=>page.locator('[data-testid^="settings-section-nav-"]').evaluateAll(nodes=>nodes.map(n=>n.dataset.testid.replace('settings-section-nav-','')));
(async()=>{
  let app,page,pid,stage='boot';const errors=[];
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T203 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
  try{
    app=await _electron.launch({executablePath:exe,args:['--user-data-dir='+profile],env,timeout:90000});pid=app.process().pid;
    page=await (async()=>{const end=Date.now()+60000;while(Date.now()<end){const ws=app.windows();const hit=ws.find(w=>w.url().includes('/out/renderer/index.html'));if(hit)return hit;await pause(60)}throw new Error('Timed out: main renderer')})();
    page.on('pageerror',e=>errors.push({stage,stack:String(e.stack||e)}));
    await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    check('positive: isolated packaged profile',path.resolve(await app.evaluate(({app})=>app.getPath('userData')))===path.resolve(profile));
    await page.evaluate(()=>localStorage.setItem('zcode-locale-preference','en-US'));
    await page.reload();await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    await page.setViewportSize({width:1280,height:900});

    stage='open settings';
    await page.locator("button[aria-label='Settings']").first().click({timeout:15000});
    const box=page.locator('[data-testid="settings-section-search"]');
    await box.waitFor({state:'visible',timeout:30000});
    check('settings carries a search box above the nav',await box.isVisible());
    const all=await navIds(page);
    // A vacuous nav would make every filter below pass without proving anything.
    check('the nav offers the full section list before searching',all.length>20,all.length);
    // Check the fold while nothing is filtered: once a query empties a group's advanced list the
    // <details> is legitimately gone, and looking for it there proves nothing.
    const fold=page.locator('details[data-zaicode-settings-advanced]').first();
    await fold.waitFor({state:'attached',timeout:15000});
    check('the Advanced fold starts closed',await fold.evaluate(node=>!node.open));

    stage='keyword search';
    // The words someone actually types, not the label on the button.
    await box.fill('font size');await pause(250);
    const fontIds=await navIds(page);
    check('"font size" narrows the nav to the sections that answer it',fontIds.length<all.length&&fontIds.length>0,fontIds);
    check('"font size" finds Appearance',fontIds.includes('appearance'),fontIds);
    await page.screenshot({path:out+'-font.png'});

    stage='every token has to hit';
    await box.fill('dark');await pause(250);
    const darkIds=await navIds(page);
    await box.fill('dark font');await pause(250);
    const bothIds=await navIds(page);
    check('adding a second word narrows rather than widens',bothIds.length<=darkIds.length,{dark:darkIds.length,both:bothIds.length});

    stage='the advanced fold';
    // zaicodeColors is one of the six T-206 hid behind Advanced; a hit there is worthless
    // unless the search opens the fold itself.
    await box.fill('accent');await pause(250);
    const liveFold=page.locator('details[data-zaicode-settings-advanced]').first();
    check('a hit inside Advanced opens the fold by itself',await liveFold.evaluate(node=>node.open));
    check('the hidden section is now reachable',(await navIds(page)).includes('zaicodeColors'),await navIds(page));
    await page.screenshot({path:out+'-advanced.png'});
    await box.fill('');await pause(250);
    check('clearing the query leaves the fold as the operator left it',!(await fold.evaluate(node=>node.open)));
    const backToAll=await navIds(page);
    check('clearing the query brings every section back',backToAll.length===all.length,{before:all.length,after:backToAll.length});

    stage='no results';
    await box.fill('nothingmatchesthis');await pause(250);
    check('an impossible word shows the no-match line',await page.locator('[data-testid="settings-section-search-empty"]').isVisible());
    check('and the nav is empty rather than stale',(await navIds(page)).length===0);
    await page.screenshot({path:out+'-empty.png'});

    stage='jump on Enter';
    await box.fill('tokens');await pause(250);
    await box.press('Enter');await pause(400);
    check('Enter opens the first section that matched',await page.locator('[data-testid="settings-page"]').getAttribute('data-active-section')==='usage',await page.locator('[data-testid="settings-page"]').getAttribute('data-active-section'));

    stage='the clear button';
    check('the clear button appears once the box has text',await page.locator('[data-testid="settings-section-search-clear"]').isVisible());
    await page.locator('[data-testid="settings-section-search-clear"]').click();await pause(250);
    check('clearing empties the box',(await box.inputValue())==='');
    check('clearing brings the whole nav back',(await navIds(page)).length===all.length);

    await pause(300);check('zero renderer exceptions while driving the search',errors.length===0,errors);
    await page.screenshot({path:out+'.png'});
    const receipt={at:new Date().toISOString(),executablePath:exe,profile,checks,errors,pass:checks.every(c=>c.pass),verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')};
    fs.writeFileSync(out+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({pass:receipt.pass,checks:checks.length,failed:checks.filter(c=>!c.pass).map(c=>c.name),receipt:out+'.json'}));process.exitCode=receipt.pass?0:1;
  }catch(error){fs.writeFileSync(out+'.json',JSON.stringify({pass:false,checks,errors,error:String(error.stack||error),profile,executablePath:exe,verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')},null,2));console.error(String(error));process.exitCode=1;
  }finally{if(app)try{await app.close()}catch{}}
})();
