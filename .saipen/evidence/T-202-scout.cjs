const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createRequire}=require('node:module');
const root=process.env.T212_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T212_PACKAGED_EXE||path.join(root,'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe')),out=process.env.T212_PACKAGED_OUT||path.join(root,'.saipen/evidence/out/T-202-scout');
if(!out)throw new Error('T212_PACKAGED_OUT required');
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

    // The panel renders null until it is opened; Alt+W is its app-scope hotkey.
    await page.keyboard.press('Alt+W');
    const panel='[data-zaicode-workers-panel]';
    await page.locator(panel).first().waitFor({timeout:30000});
    await pause(800);
    // A worker gives the header its tab row and the per-worker buttons the report is about.
    const newShell=page.locator(`${panel} button[aria-label='New shell in this project']`).first();
    if(await newShell.count()){await newShell.click();await pause(6000);}
    // Make sure the panel is expanded and has a worker, otherwise there is nothing to click.
    const snapshot=async()=>page.evaluate(()=>{
      const root=document.querySelector('[data-zaicode-workers-panel]');
      if(!root)return null;
      return root.outerHTML.length+'|'+[...root.querySelectorAll('button')].length+'|'+
        [...root.querySelectorAll('button')].map(b=>(b.getAttribute('aria-label')||b.textContent||'').trim().slice(0,40)).join('~');
    });
    const before=await snapshot();
    fs.writeFileSync(out+'-before.json',JSON.stringify({before},null,2));

    // Enumerate every button the panel renders, with what it claims to do.
    const buttons=await page.evaluate(()=>{
      const root=document.querySelector('[data-zaicode-workers-panel]');
      if(!root)return [];
      return [...root.querySelectorAll('button')].map((b,i)=>{
        const r=b.getBoundingClientRect();
        const cx=r.left+r.width/2,cy=r.top+r.height/2;
        const top=document.elementFromPoint(cx,cy);
        return {i,label:(b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||'').trim().slice(0,60),
          rect:{x:r.x,y:r.y,w:r.width,h:r.height},visible:r.width>0&&r.height>0,
          coveredBy:top?(top===b?'self':(top.getAttribute('aria-label')||top.getAttribute('title')||top.tagName+'.'+top.className||'').toString().slice(0,60)):null};
      });
    });
    fs.writeFileSync(out+'-buttons.json',JSON.stringify(buttons,null,2));
    console.log(JSON.stringify({buttons:buttons.length,covered:buttons.filter(b=>b.coveredBy&&b.coveredBy!=='self').map(b=>[b.i,b.label,b.coveredBy]),list:buttons.map(b=>[b.i,b.label,b.visible,b.coveredBy])},null,1));
    await page.screenshot({path:out+'-panel.png'});
    await pause(200);
  }catch(error){console.error(String(error.stack||error));process.exitCode=1;}
  finally{if(app)try{await app.close()}catch{}}
})();