const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=process.env.T212_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T212_PACKAGED_EXE),out=process.env.T212_PACKAGED_OUT;
if(!out)throw new Error('T212_PACKAGED_OUT required');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t204-'));
const project=path.join(profile,'goal-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[],check=(name,pass,detail)=>checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});
(async()=>{
  let app,page,pid,stage='boot';const errors=[];
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T204 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
  try{
    app=await _electron.launch({executablePath:exe,args:['--user-data-dir='+profile],env,timeout:90000});pid=app.process().pid;
    page=await (async()=>{const end=Date.now()+60000;while(Date.now()<end){const ws=app.windows();const hit=ws.find(w=>w.url().includes('/out/renderer/index.html'));if(hit)return hit;await pause(60)}throw new Error('Timed out: main renderer')})();
    page.on('pageerror',e=>errors.push({stage,stack:String(e.stack||e)}));
    await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    check('positive: isolated packaged profile',path.resolve(await app.evaluate(({app})=>app.getPath('userData')))===path.resolve(profile));

    // A project the operator never visited, turned off in this profile's store. If the mode were a
    // single global flag this entry would silence the button in every project; if it were inherited
    // from another workspace the button here would start off. It must change nothing.
    stage='seed a foreign project';
    await page.evaluate(()=>{
      localStorage.setItem('zcode-locale-preference','en-US');
      localStorage.setItem('zaicode-auto-goal-v1',JSON.stringify({off:{'V:/some/other/project':true}}));
    });
    await page.reload();await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    await page.setViewportSize({width:1280,height:900});
    // The composer belongs to a conversation, and a fresh profile lands on SAIHOME with none.
    stage='open a project';
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]})},project);
    await page.getByTestId('project-add').click();
    await page.getByRole('menuitem',{name:'Open folder',exact:true}).click();
    const row=page.locator('[data-testid^="workspace-item"]').filter({hasText:'goal-project'}).first();
    await row.waitFor({state:'visible',timeout:30000});await row.click();

    stage='the switch';
    const button=page.locator('[data-testid="zaicode-auto-goal"]');
    await button.waitFor({state:'visible',timeout:30000});
    check('the composer carries the Auto-Goal switch',await button.count()===1);
    check('a project nobody turned off starts with the goal on',await button.getAttribute('data-zaicode-auto-goal')==='on');
    check('the on state is announced pressed',await button.getAttribute('aria-pressed')==='true');
    check("another project's off switch does not reach this one",await button.getAttribute('data-zaicode-auto-goal')==='on');
    check('the title names the text it appends',(await button.getAttribute('aria-label')||'').includes('/goal cc all'));

    stage='the editor';
    const editor=page.locator('[contenteditable="true"]').first();
    await editor.waitFor({state:'visible',timeout:20000});
    await editor.click();
    await page.keyboard.type('Take the handoff and finish the board');
    await pause(200);
    const typed=await editor.innerText();
    check('the operator text lands in the editor',typed.includes('Take the handoff'));
    check('the editor never shows the goal the switch appends',!typed.includes('/goal'));

    stage='turning it off';
    await button.click();await pause(150);
    check('clicking the switch turns the goal off',await button.getAttribute('data-zaicode-auto-goal')==='off');
    check('the off state is announced unpressed',await button.getAttribute('aria-pressed')==='false');
    check('the title offers to write the goal by hand',(await button.getAttribute('aria-label')||'').includes('off'));
    // The draft must survive a toggle: a switch that ate the half-typed handoff would be worse than
    // having no switch at all.
    check('the half-typed handoff survives the toggle',(await editor.innerText()).includes('Take the handoff'));
    await page.screenshot({path:out+'-off.png'});

    stage='persistence';
    await page.reload();await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    // A reload returns to SAIHOME, which has no composer; the project is still in the sidebar.
    const back=page.locator('[data-testid^="workspace-item"]').filter({hasText:'goal-project'}).first();
    await back.waitFor({state:'visible',timeout:30000});await back.click();
    const after=page.locator('[data-testid="zaicode-auto-goal"]');
    await after.waitFor({state:'visible',timeout:60000});
    check('the off choice outlives a restart of the window',await after.getAttribute('data-zaicode-auto-goal')==='off');
    await after.click();await pause(150);
    check('turning it back on works',await after.getAttribute('data-zaicode-auto-goal')==='on');
    await page.screenshot({path:out+'.png'});

    await pause(300);check('zero renderer exceptions while driving the switch',errors.length===0,errors);
    const receipt={at:new Date().toISOString(),executablePath:exe,profile,checks,errors,pass:checks.every(c=>c.pass),verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')};
    fs.writeFileSync(out+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({pass:receipt.pass,checks:checks.length,failed:checks.filter(c=>!c.pass).map(c=>c.name),receipt:out+'.json'}));process.exitCode=receipt.pass?0:1;
  }catch(error){fs.writeFileSync(out+'.json',JSON.stringify({pass:false,checks,errors,error:String(error.stack||error),profile,executablePath:exe,verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')},null,2));console.error(String(error));process.exitCode=1;
  }finally{if(app)try{await app.close()}catch{}}
})();
