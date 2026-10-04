const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=process.env.T206_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T206_PACKAGED_EXE),out=process.env.T206_PACKAGED_OUT;
if(!out)throw new Error('T206_PACKAGED_OUT required');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t206-'));
const project=path.join(profile,'settings-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,good,name,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const v=await read();if(good(v))return v;await pause(60)}throw new Error('Timed out: '+name)}
const checks=[],check=(name,pass,detail)=>checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});
(async()=>{
  let app,page,pid,stage='boot';const errors=[];
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T206 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
  try{
    app=await _electron.launch({executablePath:exe,args:['--user-data-dir='+profile],env,timeout:90000});pid=app.process().pid;
    page=await until(()=>app.windows(),ws=>ws.some(w=>w.url().includes('/out/renderer/index.html')),'main renderer',60000).then(ws=>ws.find(w=>w.url().includes('/out/renderer/index.html')));
    page.on('pageerror',e=>errors.push({stage,stack:String(e.stack||e)}));
    await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    check('positive: isolated packaged profile',path.resolve(await app.evaluate(({app})=>app.getPath('userData')))===path.resolve(profile));
    await page.evaluate(()=>{
      localStorage.setItem('zcode-locale-preference','en-US');
      localStorage.setItem('zaicode-protrail-v1',JSON.stringify({trail:{enabled:false},click:{enabled:false}}));
      localStorage.setItem('zaicode-bevels','0');
    });
    await page.reload();await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    await page.setViewportSize({width:1280,height:900});
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]})},project);
    await page.getByTestId('project-add').click();await page.getByRole('menuitem',{name:'Open folder',exact:true}).click();
    const row=page.locator('[data-testid^="workspace-item"]').filter({hasText:'settings-project'}).first();await row.waitFor({state:'visible'});await row.click();

    stage='settings nav';
    await page.locator("button[aria-label='Settings']").first().click({timeout:10000});
    const nav=page.locator('nav').filter({hasText:'Keyboard Shortcuts'}).first();await nav.waitFor({timeout:20000});
    const fold=nav.locator('details').first();
    await fold.waitFor({state:'visible',timeout:15000});
    check('advanced fold exists in the ZAICODE nav group',await fold.count()===1);
    check('advanced fold starts collapsed',await fold.evaluate(node=>!node.open));
    check('advanced fold summary is labelled Advanced',(await fold.locator('summary').innerText()).trim()==='Advanced');

    // The point of the ticket: SAIASUI must not greet the user before the fold is opened.
    const demoted=['zaicodeSounds','zaicodeColors','zaicodeLights','zaicodeProtrail','zaicodeSessionText','zaicodeNotifications'];
    const promoted=['zaicode','zaicodeSidebar','zaicodeLayout','zaicodeEngines','zaicodeWorkers'];
    const idOf=button=>button.dataset.testid.replace('settings-section-nav-','');
    const order=await fold.evaluate(node=>{
      const selector='button[data-testid^="settings-section-nav-"]';
      const inside=[...node.querySelectorAll(selector)].map(b=>b.dataset.testid.replace('settings-section-nav-',''));
      // The parent holds the group's own list; drop the fold's entries so they are not counted twice.
      const outside=[...node.parentElement.querySelectorAll(selector)].filter(b=>!b.closest('details')).map(b=>b.dataset.testid.replace('settings-section-nav-',''));
      return [...outside,...inside];
    });
    check('every demoted section still sits inside the fold',demoted.every(id=>order.includes(id)),order);
    check('every everyday section stays visible without expanding',promoted.every(id=>order.includes(id)),order);
    check('the fold comes after the everyday ZAICODE sections',order.indexOf('zaicodeWorkers')<order.indexOf('zaicodeSounds'),order);

    stage='zaicode page fold';
    await fold.locator('summary').click();await pause(200);
    check('the fold opens on click',await fold.evaluate(node=>node.open));
    await page.getByTestId('settings-section-nav-zaicode').click({timeout:10000});
    const advanced=page.locator('[data-zaicode-advanced]');
    await advanced.waitFor({state:'visible',timeout:15000});
    check('the ZAICODE page carries its own advanced fold',await advanced.count()===1);
    check('the ZAICODE page fold starts collapsed',await advanced.evaluate(node=>!node.open));
    const saiasui=page.locator('[data-zaicode-saiasui-settings]').first();
    check('SAIASUI is hidden until the page fold is opened',!(await saiasui.isVisible().catch(()=>false)));
    await advanced.locator('summary').click();await pause(300);
    check('the ZAICODE page fold reveals SAIASUI',await saiasui.isVisible());
    await page.screenshot({path:out+'.png'});

    await pause(300);check('zero renderer exceptions while walking settings',errors.length===0,errors);
    const receipt={at:new Date().toISOString(),executablePath:exe,profile,checks,errors,pass:checks.every(c=>c.pass),verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')};
    fs.writeFileSync(out+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({pass:receipt.pass,checks:checks.length,failed:checks.filter(c=>!c.pass).map(c=>c.name),receipt:out+'.json'}));process.exitCode=receipt.pass?0:1;
  }catch(error){fs.writeFileSync(out+'.json',JSON.stringify({pass:false,checks,errors,error:String(error.stack||error),profile,executablePath:exe,verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')},null,2));console.error(String(error));process.exitCode=1;
  }finally{if(app)try{await app.close()}catch{}}
})();