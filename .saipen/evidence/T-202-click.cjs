const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=process.env.T212_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T212_PACKAGED_EXE||path.join(root,'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe'));
const out=process.env.T212_PACKAGED_OUT||path.join(os.tmpdir(),'t202-click');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t202-'));
const project=path.join(profile,'workers-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const PREFS='zaicode-workers-prefs-v1';
(async()=>{
  let app,page;
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T202 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
  const snap=()=>page.evaluate(prefsKey=>{
    const p=document.querySelector('[data-zaicode-workers-panel]');
    const body=document.querySelector('[data-zaicode-workers-body]');
    let prefs=null;try{prefs=JSON.parse(localStorage.getItem(prefsKey));}catch{}
    return{prefs,style:p?p.getAttribute('style'):null,layout:p?p.dataset.zaicodeWorkersPanel:null,
      dock:p?p.dataset.zaicodeWorkersPanelDock:null,collapsed:p?p.dataset.zaicodeWorkersPanelCollapsed:null,
      bodyHash:body?body.innerHTML.length:0,
      tabs:document.querySelectorAll('[data-zaicode-workers-panel] button[role="tab"]').length,
      wins:document.querySelectorAll('[data-zaicode-worker-window]').length,
      chips:document.querySelectorAll('[data-zaicode-worker-chip]').length,
      settings:!!document.querySelector('[data-testid="settings-page"]')};
  },PREFS);
  const diff=(a,b)=>Object.keys(a).filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]));
  const panelBtn=prefix=>page.locator(`[data-zaicode-workers-panel] button[aria-label^=${JSON.stringify(prefix)}]`).first();
  const newWorker=async()=>{await panelBtn('New shell').click();await pause(7000);};
  const restore=async()=>{
    if(await page.locator('[data-testid="settings-page"]').count()){
      await page.locator('[data-testid="settings-back-button"]').first().click();await pause(700);
    }
    if(!(await page.locator('[data-zaicode-workers-panel]').count())){await page.keyboard.press('Alt+W');await pause(700);}
    const p=page.locator('[data-zaicode-workers-panel]').first();
    if(await p.getAttribute('data-zaicode-workers-panel-collapsed')==='true'){
      await p.locator("button[aria-label^='Expand the panel']").click();await pause(700);
    }
    if(await p.getAttribute('data-zaicode-workers-panel')!=='split'){await p.locator("button[aria-label^='Split:']").click();await pause(500);}
    if(await p.getAttribute('data-zaicode-workers-panel-dock')!=='bottom'){
      for(let i=0;i<4;i++){await p.locator("button[aria-label^='Docked:']").click();await pause(350);
        if(await p.getAttribute('data-zaicode-workers-panel-dock')==='bottom')break;}
    }
    if(await p.locator("button[aria-label^='Restore the panel size']").count()){
      await p.locator("button[aria-label^='Restore the panel size']").click();await pause(500);
    }
  };
  const results=[];
  const test=async(label,{needsWorker=false}={})=>{
    await restore();
    if(needsWorker&&(await snap()).tabs===0) await newWorker();
    const btn=await panelBtn(label);
    if(!(await btn.count())){results.push({label,missing:true});return null;}
    const before=await snap();
    let clickError=null;
    try{await btn.click({timeout:8000});}catch(e){clickError=String(e.message).split('\n')[0];}
    await pause(1500);
    const after=await snap();
    const changed=diff(before,after);
    results.push({label,clickError,changed,before,after});
    return results[results.length-1];
  };
  try{
    app=await _electron.launch({executablePath:exe,args:['--user-data-dir='+profile],env,timeout:90000});
    page=await (async()=>{const end=Date.now()+60000;while(Date.now()<end){const ws=app.windows();const hit=ws.find(w=>w.url().includes('/out/renderer/index.html'));if(hit)return hit;await pause(60)}throw new Error('Timed out: main renderer')})();
    await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    await page.evaluate(()=>localStorage.setItem('zcode-locale-preference','en-US'));
    await page.reload();await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    await page.setViewportSize({width:1600,height:1000});
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]})},project);
    await page.getByTestId('project-add').click();await page.getByRole('menuitem',{name:'Open folder',exact:true}).click();
    const row=page.locator('[data-testid^="workspace-item"]').filter({hasText:'workers-project'}).first();await row.waitFor({state:'visible'});await row.click();
    await pause(2500);
    await page.keyboard.press('Alt+W');
    await page.locator('[data-zaicode-workers-panel]').first().waitFor({timeout:30000});
    await pause(600);
    await newWorker();await newWorker();

    // Header buttons. "Redraw" repaints an invisible terminal, so it has no state to change; it is
    // exercised separately as "the click lands on the right control".
    for(const label of ['Tabs:','Split:','Split direction:','Docked:','Workers settings','Maximize the panel','Collapse the panel','New shell']) await test(label);
    // "Even" only means something once the panes are uneven: drag a divider first.
    await restore();
    const divider=page.locator('[data-zaicode-workers-body] [role="separator"]').first();
    if(await divider.count()){
      const box=await divider.boundingBox();
      if(box){await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
        await page.mouse.move(box.x+box.width/2+90,box.y+box.height/2,{steps:8});await page.mouse.up();await pause(600);}
    }
    await test('Even:');
    // Worker-row buttons.
    for(const label of ['Own window','Fill the panel','Minimize to a chip','Stop this worker']) await test(label,{needsWorker:true});

    fs.writeFileSync(out+'.json',JSON.stringify({results},null,2));
    for(const r of results) console.log((r.missing?'MISSING':r.clickError?'CLICK-ERR':(r.changed.length?'REACTS ':'DEAD    '))+' | '+r.label+(r.clickError?' | '+r.clickError:'')+(r.changed.length?' | '+r.changed.join(','):''));
  }catch(error){fs.writeFileSync(out+'.json',JSON.stringify({results,error:String(error.stack||error)},null,2));console.error(String(error.stack||error));process.exitCode=1;}
  finally{if(app)try{await app.close()}catch{}}
})();