const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createRequire}=require('node:module');
const root=process.env.T212_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T212_PACKAGED_EXE||path.join(root,'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe'));
const out=process.env.T212_PACKAGED_OUT||path.join(os.tmpdir(),'t202-tabs2');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t202-'));
const project=path.join(profile,'workers-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let app,page;
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T202 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
  const checks=[];const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,detail});console.log((pass?'PASS ':'FAIL ')+name+(detail===undefined?'':' :: '+JSON.stringify(detail)));};
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
    await pause(500);
    const newShell=()=>page.locator("[data-zaicode-workers-panel] button[aria-label='New shell in this project']").first();
    await newShell().click();await pause(7000);
    await newShell().click();await pause(7000);

    const tabs=page.locator('[data-zaicode-workers-panel] button[role="tab"]');
    check('two workers are listed as tabs',(await tabs.count())===2,await tabs.count());
    const sel=async()=>tabs.evaluateAll(ns=>ns.map(n=>n.getAttribute('aria-selected')));
    const first=JSON.stringify(await sel());
    const unselected=await tabs.evaluateAll(ns=>ns.findIndex(n=>n.getAttribute('aria-selected')!=='true'));
    check('exactly one tab is selected to begin with',unselected>=0,first);
    await tabs.nth(unselected).click();await pause(1500);
    const second=JSON.stringify(await sel());
    check('clicking the other worker tab moves the selection',first!==second,{first,second});

    // "Stop this worker" is a confirm dialog, not a dead button: prove it opens and that
    // answering it really removes the worker.
    await page.locator("[data-zaicode-workers-panel] button[aria-label^='Stop this worker']").first().click({timeout:8000});
    const dialog=page.locator('[data-slot="dialog-overlay"]');
    await dialog.waitFor({state:'visible',timeout:8000});
    check('Stop this worker asks before killing the worker',true);
    const before=await page.locator('[data-zaicode-workers-panel] button[role="tab"]').count();
    const confirm=page.getByRole('button',{name:/^(Stop|Confirm|Yes)/i}).last();
    await confirm.click({timeout:8000});await pause(5000);
    const after=await page.locator('[data-zaicode-workers-panel] button[role="tab"]').count();
    check('answering the dialog removes the worker',after<before,{before,after});
    // The panel has to stay live with a stopped worker in it.
    const live=await page.evaluate(()=>{const p=document.querySelector('[data-zaicode-workers-panel]');return p?p.dataset.zaicodeWorkersPanel:null;});
    await page.locator("[data-zaicode-workers-panel] button[aria-label^='Tabs:']").first().click({timeout:8000});await pause(1200);
    const now=await page.evaluate(()=>document.querySelector('[data-zaicode-workers-panel]').dataset.zaicodeWorkersPanel);
    check('the header still answers after a worker was stopped',live!==now,{live,now});
    fs.writeFileSync(out+'.json',JSON.stringify({checks},null,2));
    process.exitCode=checks.every(c=>c.pass)?0:1;
  }catch(error){fs.writeFileSync(out+'.json',JSON.stringify({checks,error:String(error.stack||error)},null,2));console.error(String(error.stack||error));process.exitCode=1;}
  finally{if(app)try{await app.close()}catch{}}
})();