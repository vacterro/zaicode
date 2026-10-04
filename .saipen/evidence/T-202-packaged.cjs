const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=process.env.T212_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T212_PACKAGED_EXE||path.join(root,'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe'));
const out=process.env.T212_PACKAGED_OUT||path.join(os.tmpdir(),'t202-packaged');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t202-'));
const project=path.join(profile,'workers-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[];const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});};
(async()=>{
  let app,page,stage='boot';const errors=[];
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T202 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
  const snap=()=>page.evaluate(()=>{
    const p=document.querySelector('[data-zaicode-workers-panel]');
    const body=document.querySelector('[data-zaicode-workers-body]');
    return{prefs:localStorage.getItem('zaicode-workers-prefs-v1'),style:p?p.getAttribute('style'):null,
      layout:p?p.dataset.zaicodeWorkersPanel:null,dock:p?p.dataset.zaicodeWorkersPanelDock:null,
      collapsed:p?p.dataset.zaicodeWorkersPanelCollapsed:null,body:body?body.innerHTML.length:0,
      tabs:document.querySelectorAll('[data-zaicode-workers-panel] button[role="tab"]').length,
      wins:document.querySelectorAll('[data-zaicode-worker-window]').length,
      chips:document.querySelectorAll('[data-zaicode-worker-chip]').length,
      settings:!!document.querySelector('[data-testid="settings-page"]')};
  });
  const changed=(a,b)=>Object.keys(a).filter(k=>JSON.stringify(a[k])!==JSON.stringify(b[k]));
  const btn=prefix=>page.locator(`[data-zaicode-workers-panel] button[aria-label^=${JSON.stringify(prefix)}]`).first();
  const restore=async()=>{
    if(await page.locator('[data-testid="settings-page"]').count()){await page.locator('[data-testid="settings-back-button"]').first().click();await pause(700);}
    if(!(await page.locator('[data-zaicode-workers-panel]').count())){await page.keyboard.press('Alt+W');await pause(700);}
    const p=page.locator('[data-zaicode-workers-panel]').first();
    if(await p.getAttribute('data-zaicode-workers-panel-collapsed')==='true'){await p.locator("button[aria-label^='Expand the panel']").click();await pause(700);}
    if(await p.getAttribute('data-zaicode-workers-panel')!=='split'){await p.locator("button[aria-label^='Split:']").click();await pause(500);}
    if(await p.getAttribute('data-zaicode-workers-panel-dock')!=='bottom'){
      for(let i=0;i<4;i++){await p.locator("button[aria-label^='Docked:']").click();await pause(350);
        if(await p.getAttribute('data-zaicode-workers-panel-dock')==='bottom')break;}
    }
    if(await p.locator("button[aria-label^='Restore the panel size']").count()){await p.locator("button[aria-label^='Restore the panel size']").click();await pause(500);}
  };
  const reacts=async(label,{skipRestore=false}={})=>{
    if(!skipRestore) await restore();
    const b=await btn(label);
    if(!(await b.count())){check(`${label} is clickable`,false,'missing');return;}
    const before=await snap();
    let clickError=null;
    try{await b.click({timeout:8000});}catch(e){clickError=String(e.message).split('\n')[0];}
    await pause(1500);
    const after=await snap();
    const keys=clickError?[]:changed(before,after);
    check(`${label} reacts when clicked`,!clickError&&keys.length>0,clickError?clickError:{keys,before:before.layout,after:after.layout});
  };
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
    const row=page.locator('[data-testid^="workspace-item"]').filter({hasText:'workers-project'}).first();await row.waitFor({state:'visible'});await row.click();
    await pause(2500);
    await page.keyboard.press('Alt+W');
    await page.locator('[data-zaicode-workers-panel]').first().waitFor({timeout:30000});
    check('Alt+W opens the WORKERS panel',await page.locator('[data-zaicode-workers-panel]').count()>0);

    stage='two workers';
    await btn('New shell').click();await pause(7000);
    await btn('New shell').click();await pause(7000);
    const tabs=page.locator('[data-zaicode-workers-panel] button[role="tab"]');
    check('both workers are listed in the header',(await tabs.count())===2,await tabs.count());

    stage='the worker tabs';
    const unselected=await tabs.evaluateAll(ns=>ns.findIndex(n=>n.getAttribute('aria-selected')!=='true'));
    const beforeSel=await tabs.evaluateAll(ns=>ns.map(n=>n.getAttribute('aria-selected')));
    await tabs.nth(Math.max(0,unselected)).click();await pause(1200);
    const afterSel=await tabs.evaluateAll(ns=>ns.map(n=>n.getAttribute('aria-selected')));
    check('clicking the other worker tab moves the selection',JSON.stringify(beforeSel)!==JSON.stringify(afterSel),{beforeSel,afterSel});

    stage='the header controls';
    for(const label of ['Tabs:','Split direction:','Docked:','Workers settings','Maximize the panel','Collapse the panel']) await reacts(label);
    // Split is a no-op once the panel is already split, so it is checked from the tabs layout.
    await reacts('Split:',{skipRestore:true});
    stage='even split';
    await restore();
    // "Even" only means anything once the panes are uneven, so make them uneven first and say so.
    const divider=page.locator('[data-zaicode-workers-body] [role="separator"]').first();
    check('a split divider exists to drag',(await divider.count())>0,await divider.count());
    if(await divider.count()){
      // Drag along the divider's own axis: a row split moves in x, a stacked one in y.
      const orientation=await divider.getAttribute('aria-orientation');
      const b=await divider.boundingBox();
      if(b){
        const cx=b.x+b.width/2,cy=b.y+b.height/2,dx=orientation==='vertical'?90:0,dy=orientation==='vertical'?0:60;
        await page.mouse.move(cx,cy);await page.mouse.down();
        await page.mouse.move(cx+dx,cy+dy,{steps:8});await page.mouse.up();await pause(800);
      }
    }
    const sizes=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('zaicode-workers-prefs-v1')||'{}').splitSizes||null);
    const dragged=await sizes();
    const uneven=Array.isArray(dragged)&&dragged.length>1&&dragged.every((v,i)=>Math.abs(v-0.5)>0.001)===false;
    check('dragging the divider leaves the panes uneven',Array.isArray(dragged)&&new Set(dragged.map(v=>v.toFixed(3))).size>1,dragged);
    await reacts('Even:',{skipRestore:true});
    const evened=await sizes();
    check('Even puts the panes back to an equal share',Array.isArray(evened)&&evened.every(v=>Math.abs(v-evened[0])<0.001),{dragged,evened,uneven});

    stage='the per-worker controls';
    await reacts('Own window');
    await restore();
    await reacts('Fill the panel');
    await restore();
    await reacts('Minimize to a chip');

    stage='stopping a worker';
    await restore();
    if((await snap()).tabs===0){await btn('New shell').click();await pause(7000);}
    const tabsBefore=(await snap()).tabs;
    await btn('Stop this worker').click({timeout:8000});
    await page.locator('[data-slot="dialog-overlay"]').waitFor({state:'visible',timeout:8000});
    check('Stop this worker asks before it kills',true);
    await page.getByRole('button',{name:/^(Stop|Confirm|Yes)/i}).last().click({timeout:8000});await pause(5000);
    check('answering the dialog removes the worker',(await snap()).tabs<tabsBefore,{tabsBefore,after:(await snap()).tabs});

    stage='still live';
    await reacts('Tabs:',{skipRestore:true});

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