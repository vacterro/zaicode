const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createRequire}=require('node:module');
const root=process.env.T212_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T212_PACKAGED_EXE||path.join(root,'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe'));
const out=process.env.T212_PACKAGED_OUT||path.join(os.tmpdir(),'t202-edge');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t202-'));
const project=path.join(profile,'workers-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let app,page;
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T202 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
  const state=()=>page.evaluate(()=>{
    const p=document.querySelector('[data-zaicode-workers-panel]');
    return{style:p?p.getAttribute('style'):null,prefs:localStorage.getItem('zaicode-workers-prefs-v1'),resizing:!!document.querySelector('[data-zaicode-panel-resizing]')};
  });
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
    await page.locator("[data-zaicode-workers-panel] button[aria-label='New shell in this project']").first().click();
    await pause(7000);

    // The resize handle is `inset-x-0 -top-1 h-2` on the default bottom dock: it lies across the
    // top four pixels of the 20px header buttons. Click where a finger lands, not the centre.
    const labels=await page.evaluate(()=>[...document.querySelectorAll('[data-zaicode-workers-panel] button[aria-label^="Docked:"]')].map(b=>b.getAttribute('aria-label')));
    const targets=['Redraw:','New shell in this project','Workers settings','Docked:'];
    const rows=[];
    for(const prefix of targets){
      const btn=page.locator(`[data-zaicode-workers-panel] button[aria-label^=${JSON.stringify(prefix)}]`).first();
      const r=await btn.boundingBox();
      if(!r){rows.push({prefix,missing:true});continue;}
      // Walk down the button in 2px steps and record what each hit actually does.
      const per=[];
      for(let dy=1;dy<=r.height-1;dy+=3){
        const before=await state();
        await page.mouse.click(r.x+r.width/2,r.y+dy);
        await pause(500);
        const after=await state();
        const panelMoved=before.style!==after.style;
        const prefsChanged=before.prefs!==after.prefs;
        per.push({dy,panelMoved,prefsChanged});
        if(panelMoved){ // undo the resize so the next probe starts from the same size
          await page.keyboard.press('Escape');
          await pause(300);
        }
      }
      rows.push({prefix,top:r.y,height:r.height,per});
      console.log(prefix,'->',JSON.stringify(per));
    }
    console.log('labels',JSON.stringify(labels));
    fs.writeFileSync(out+'.json',JSON.stringify({rows},null,2));
  }catch(error){console.error(String(error.stack||error));process.exitCode=1;}
  finally{if(app)try{await app.close()}catch{}}
})();