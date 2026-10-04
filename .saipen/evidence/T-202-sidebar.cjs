const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createRequire}=require('node:module');
const root=process.env.T212_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T212_PACKAGED_EXE||path.join(root,'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe'));
const out=process.env.T212_PACKAGED_OUT||path.join(os.tmpdir(),'t202-sidebar');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t202-'));
const project=path.join(profile,'workers-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let app,page;
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T202 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
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
    // The sidebar block only exists once a worker does, so make one from the panel's own button.
    await page.keyboard.press('Alt+W');
    await page.locator('[data-zaicode-workers-panel]').first().waitFor({timeout:30000});
    await pause(500);
    await page.locator("[data-zaicode-workers-panel] button[aria-label='New shell in this project']").first().click();
    await pause(8000);
    const block='[data-zaicode-sidebar-workers]';
    await page.locator(block).first().waitFor({timeout:20000});
    const describe=async()=>page.evaluate(sel=>{
      const root=document.querySelector(sel);
      return root?{html:root.innerHTML.length,workers:root.dataset.zaicodeSidebarWorkers,
        labels:[...root.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return{l:b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent.trim().slice(0,30),hit:top===b?'self':(top?top.tagName+'.'+String(top.className).slice(0,40):'null')};})} :null;
    },block);
    const before=await describe();
    console.log('sidebar block:',JSON.stringify(before,null,1));
    // Toggle the panel from the sidebar and see whether the panel actually opens.
    const toggle=page.locator(`${block} button[title^="Show the WORKERS panel"], ${block} button[title^="Hide the WORKERS panel"]`).first();
    console.log('toggle label:',await toggle.getAttribute('title'));
    let err=null;
    try{await toggle.click({timeout:8000});}catch(e){err=String(e.message).split('\n')[0];}
    await pause(1500);
    const panelVisible=await page.locator('[data-zaicode-workers-panel]').count();
    console.log('after toggle: panel present =',panelVisible,'err =',err);
    // And the sidebar's own "new shell" button.
    const add=page.locator(`${block} button[aria-label='New shell in this project']`).first();
    const beforeWorkers=(await describe()).workers;
    let err2=null;
    try{await add.click({timeout:8000});}catch(e){err2=String(e.message).split('\n')[0];}
    await pause(8000);
    console.log('sidebar new shell:',beforeWorkers,'->',(await describe()).workers,'err =',err2);
    fs.writeFileSync(out+'.json',JSON.stringify({before,panelVisible,err,err2},null,2));
    await page.screenshot({path:out+'.png'});
  }catch(error){console.error(String(error.stack||error));process.exitCode=1;}
  finally{if(app)try{await app.close()}catch{}}
})();