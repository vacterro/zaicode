const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=process.env.T200_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T200_PACKAGED_EXE||path.join(root,'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe'));
const out=process.env.T200_PACKAGED_OUT||path.join(os.tmpdir(),'t200-packaged');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t200-'));
const project=path.join(profile,'panel-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[];const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});};
(async()=>{
  let app,page,stage='boot';const errors=[];
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T200 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
  const panel=()=>page.locator('[data-zaicode-workers-panel]').first();
  const snap=()=>page.evaluate(()=>{
    const p=document.querySelector('[data-zaicode-workers-panel]');
    return{collapsed:p?p.dataset.zaicodeWorkersPanelCollapsed:null,
      prefs:JSON.parse(localStorage.getItem('zaicode-workers-prefs-v1')||'{}'),
      tabs:document.querySelectorAll('[data-zaicode-workers-panel] button[role="tab"]').length,
      chips:document.querySelectorAll('[data-zaicode-worker-chip]').length,
      workers:document.querySelectorAll('[data-zaicode-worker-pane]').length};
  });
  const btn=prefix=>page.locator(`[data-zaicode-workers-panel] button[aria-label^=${JSON.stringify(prefix)}]`).first();
  try{
    app=await _electron.launch({executablePath:exe,args:['--user-data-dir='+profile],env,timeout:90000});
    page=await (async()=>{const end=Date.now()+60000;while(Date.now()<end){const ws=app.windows();const hit=ws.find(w=>w.url().includes('/out/renderer/index.html'));if(hit)return hit;await pause(60)}throw new Error('Timed out: main renderer')})();
    page.on('pageerror',e=>errors.push({stage,stack:String(e.stack||e)}));
    await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    check('the packaged app runs on an isolated profile',path.resolve(await app.evaluate(({app})=>app.getPath('userData')))===path.resolve(profile));
    await page.evaluate(()=>localStorage.setItem('zcode-locale-preference','en-US'));
    await page.reload();await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    await page.setViewportSize({width:1600,height:1000});

    stage='open the WORKERS panel';
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]})},project);
    await page.getByTestId('project-add').click();await page.getByRole('menuitem',{name:'Open folder',exact:true}).click();
    const row=page.locator('[data-testid^="workspace-item"]').filter({hasText:'panel-project'}).first();await row.waitFor({state:'visible'});await row.click();
    await pause(2500);
    await page.keyboard.press('Alt+W');
    await panel().waitFor({timeout:30000});
    const opened=await snap();
    check('Alt+W opens the WORKERS panel expanded',opened.collapsed==='false',{collapsed:opened.collapsed});

    stage='an empty panel stays put';
    await pause(2500);
    check('an empty panel opened on purpose is left expanded',(await snap()).collapsed==='false',{collapsed:(await snap()).collapsed});

    stage='one worker';
    await btn('New shell').click();await pause(8000);
    const one=await snap();
    check('the worker shows in the panel without folding it',one.tabs===1&&one.collapsed==='false',{tabs:one.tabs,collapsed:one.collapsed});

    stage='the last worker leaves';
    await btn('Minimize to a chip').click();await pause(2500);
    const gone=await snap();
    check('the panel folds itself when its last worker is gone',gone.collapsed==='true',{collapsed:gone.collapsed,chips:gone.chips});
    check('the fold is stored, so it survives a reload',gone.prefs.panelCollapsed===true,{panelCollapsed:gone.prefs.panelCollapsed});
    check('the worker itself is parked, not killed',gone.chips>=1,{chips:gone.chips});

    stage='back to the panel';
    await page.locator('[data-zaicode-worker-chip]').first().click();await pause(2500);
    const back=await snap();
    check('the chip brings the worker back into the panel',back.chips===0&&back.tabs===1,{chips:back.chips,tabs:back.tabs});
    // Only a panel that folded itself needs the operator to expand it again.
    const expand=panel().locator("button[aria-label^='Expand the panel']");
    if(await expand.count()){await expand.click();await pause(2500);}
    check('the panel is usable again',(await snap()).collapsed==='false',{collapsed:(await snap()).collapsed});

    stage='the control: an empty panel, no worker of its own';
    await page.reload();await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    await page.keyboard.press('Alt+W');await panel().waitFor({timeout:30000});
    await pause(2500);
    const afterReload=await snap();
    check('a reloaded empty panel is not folded for having no worker',afterReload.collapsed==='false'&&afterReload.tabs===0,{...afterReload,prefs:undefined});

    check('zero renderer exceptions while driving the panel',errors.length===0,errors);
    const receipt={at:new Date().toISOString(),executablePath:exe,profile,checks,errors,pass:checks.every(c=>c.pass),
      verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
      asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')};
    fs.writeFileSync(out+'.json',JSON.stringify(receipt,null,2));
    console.log(JSON.stringify({pass:receipt.pass,checks:checks.length,failed:checks.filter(c=>!c.pass).map(c=>c.name),receipt:out+'.json'}));
    process.exitCode=receipt.pass?0:1;
  }catch(error){
    fs.writeFileSync(out+'.json',JSON.stringify({pass:false,checks,errors,error:String(error.stack||error),profile,executablePath:exe,
      verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
      asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')},null,2));
    console.error(String(error.stack||error));process.exitCode=1;
  }finally{if(app)try{await app.close()}catch{}}
})();