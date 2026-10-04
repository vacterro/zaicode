const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const {execFileSync}=require('node:child_process');
const root=process.env.T209_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T209_PACKAGED_EXE),out=process.env.T209_PACKAGED_OUT;
if(!out)throw new Error('T209_PACKAGED_OUT required');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t209-'));
const project=path.join(profile,'workers-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const counter=path.join(profile,'counter.cjs');
fs.writeFileSync(counter,`const fs=require('node:fs'),marker=require('node:crypto').randomUUID();let count=0;const startedAt=Date.now();const tick=()=>{const final=fs.existsSync(process.argv[3]);const r={pid:process.pid,marker,startedAt,count:++count,final};fs.appendFileSync(process.argv[2],JSON.stringify(r)+'\\n');console.log((final?'T209-FINAL:':'T209-COUNTER:')+JSON.stringify(r));if(final||count>1200)process.exit(0)};tick();setInterval(tick,250);`);
const records=id=>{try{return fs.readFileSync(path.join(profile,id+'.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))}catch{return[]}};
const quote=s=>`'${s.replaceAll("'","''")}'`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,good,name,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const v=await read();if(good(v))return v;await pause(40)}throw new Error('Timed out: '+name)}
const checks=[],check=(name,pass,detail)=>checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});
const kill=pid=>{if(Number.isInteger(pid)&&pid>0)try{execFileSync(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}};
(async()=>{
  let app,page,pid,before,stage='boot';const errors=[],workerPids=[];
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T209 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];
  try{
    app=await _electron.launch({executablePath:exe,args:['--user-data-dir='+profile],env,timeout:90000});pid=app.process().pid;
    page=await until(()=>app.windows(),ws=>ws.some(w=>w.url().includes('/out/renderer/index.html')),'main renderer',60000).then(ws=>ws.find(w=>w.url().includes('/out/renderer/index.html')));
    page.on('pageerror',e=>errors.push({stage,stack:String(e.stack||e)}));
    await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    check('positive: isolated packaged profile',path.resolve(await app.evaluate(({app})=>app.getPath('userData')))===path.resolve(profile));
    const launchers=['A','B','K'].map(id=>({id:id.toLowerCase(),label:'Counter '+id,short:id,command:`& ${quote(process.execPath)} ${quote(counter)} ${quote(path.join(profile,id+'.jsonl'))} ${quote(path.join(profile,id+'.stop'))}; exit $LASTEXITCODE`}));
    await page.evaluate(launchers=>{
      localStorage.setItem('zcode-locale-preference','en-US');
      localStorage.setItem('zaicode-protrail-v1',JSON.stringify({trail:{enabled:false},click:{enabled:false}}));
      localStorage.setItem('zaicode-bevels','0');
      localStorage.setItem('zaicode-workers-prefs-v1',JSON.stringify({panelLayout:'split',panelHeight:300,panelWidth:520,panelDock:'bottom',panelCollapsed:false,font:'profile',confirmClose:false}));
      localStorage.setItem('zaicode-dispatch-prefs-v1',JSON.stringify({where:'panel',launchers}));
      localStorage.setItem('zaicode-layout-v1',JSON.stringify({footerTools:[{id:'dispatch',visible:true},{id:'settings',visible:true},{id:'workers',visible:true}]}));
    },launchers);
    await page.reload();await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});await page.setViewportSize({width:1280,height:900});
    await app.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]})},project);
    await page.getByTestId('project-add').click();await page.getByRole('menuitem',{name:'Open folder',exact:true}).click();
    const row=page.locator('[data-testid^="workspace-item"]').filter({hasText:'workers-project'}).first();await row.waitFor({state:'visible'});await row.click();
    const composer=page.locator('[contenteditable="true"]:visible').last();await composer.waitFor({state:'visible',timeout:30000});await composer.fill('T209 retained draft');
    for(const id of ['A','B']){
      await page.getByTestId('zaicode-dispatch').last().click();const dispatch=page.locator('[data-zaicode-dispatch]');
      await dispatch.getByRole('radio',{name:'WORKERS panel',exact:true}).click();await dispatch.locator(`[data-zaicode-dispatch-launcher="${id.toLowerCase()}"]`).click();
      await page.locator(`[data-zaicode-worker-terminal="${id}"] .xterm`).waitFor({state:'visible',timeout:30000});
      const rs=await until(()=>records(id),r=>r.length>=3,id+' native worker');workerPids.push(rs[0].pid);
      check(id+' positive: native output with one run identity',rs.every(r=>r.pid===rs[0].pid&&r.marker===rs[0].marker&&r.startedAt===rs[0].startedAt));
    }
    const panel=()=>page.locator('[data-zaicode-workers-panel]');
    const body=()=>panel().locator('[data-zaicode-workers-body]');
    const arrow=()=>panel().getByRole('button',{name:/^(Hide|Collapse|Expand) the panel/}).last();
    const metrics=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/out/renderer/index.html')).webContents.getOSProcessId());
    const nonce=crypto.randomUUID();await page.evaluate(n=>window.__t209Nonce=n,nonce);
    before={appPid:pid,rendererPid:await metrics(),workers:Object.fromEntries(['A','B'].map(id=>[id,records(id)[0]]))};
    const reopen=async()=>{if(await panel().count())await arrow().click();else await page.getByTitle('Show the WORKERS panel',{exact:true}).click();await body().waitFor({state:'visible'})};
    const live=async name=>{
      for(const id of ['A','B']){const last=records(id).at(-1);const rs=await until(()=>records(id),r=>r.at(-1)?.count>last.count,id+' advances');check(name+': '+id+' original process continues',rs.every(r=>r.pid===before.workers[id].pid&&r.marker===before.workers[id].marker&&r.startedAt===before.workers[id].startedAt))}
      check(name+': app and renderer survive',app.process().pid===before.appPid&&await metrics()===before.rendererPid&&await page.evaluate(n=>window.__t209Nonce===n,nonce));
    };
    check('positive: split shows two terminals',await panel().locator('[data-zaicode-worker-terminal]:visible').count()===2);
    await panel().getByTitle('Tabs: one worker at a time',{exact:true}).click();check('Tabs pointer click changes real layout',await panel().getAttribute('data-zaicode-workers-panel')==='tabs'&&await panel().locator('[data-zaicode-worker-terminal]:visible').count()===1);
    await panel().getByTitle('Split: all docked workers side by side',{exact:true}).click();check('Split pointer click restores both terminals',await panel().getAttribute('data-zaicode-workers-panel')==='split'&&await panel().locator('[data-zaicode-worker-terminal]:visible').count()===2);
    for(const dock of ['bottom','right','left','top']){
      stage=dock+' collapse/expand';
      check(dock+': configured dock visible',await panel().getAttribute('data-zaicode-workers-panel-dock')===dock);
      const expanded=await panel().boundingBox();const main=await page.locator('[data-zaicode-workers-dock]').boundingBox();
      await arrow().click();await pause(180);
      const compact=await panel().count()?await panel().boundingBox():null;
      check(dock+': collapse retains compact header',!!compact&&compact.height<=26,compact);
      check(dock+': body actually disappears',!(await body().isVisible().catch(()=>false)));
      if(compact)check(dock+': compact panel reclaims side width',compact.width>=main.width-2);
      await live(dock+' collapsed');await reopen();
      const restored=await panel().boundingBox();
      check(dock+': original dock geometry restores',Math.abs(restored.width-expanded.width)<2&&Math.abs(restored.height-expanded.height)<2,{expanded,restored});
      check(dock+': same two terminal subtrees restore',await panel().locator('[data-zaicode-worker-terminal]:visible').count()===2);
      await panel().getByRole('button',{name:/^Docked:/}).click();
    }
    stage='resize';const resize=panel().getByRole('separator',{name:'Resize the WORKERS panel (double-click: maximize)'});const r=await resize.boundingBox();
    await page.mouse.move(r.x+r.width/2,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+r.width/2,r.y+r.height/2-67,{steps:8});await page.mouse.up();await pause(100);
    const resized=await panel().boundingBox();check('native pointer resize changes expanded height',resized.height>340,resized);
    await arrow().click();check('collapsed flag uses existing persistent owner',await page.evaluate(()=>JSON.parse(localStorage.getItem('zaicode-workers-prefs-v1')).panelCollapsed)===true);await reopen();
    check('collapse preserves resized expanded height',Math.abs((await panel().boundingBox()).height-resized.height)<2);
    stage='single minimize/restore';await page.locator('[data-zaicode-worker-terminal="A"]').locator('../..').getByTitle('Minimize to a chip (keeps running)').click();
    check('single worker minimize leaves the other body expanded',await body().isVisible()&&await panel().locator('[data-zaicode-worker-terminal]:visible').count()===1);
    await page.locator('[data-zaicode-worker-chip="A"]').click();check('single worker restore retains original second terminal',await panel().locator('[data-zaicode-worker-terminal]:visible').count()===2);await live('after minimize and restore');
    check('unsent draft remains',await composer.innerText()==='T209 retained draft');
    stage='natural completion';for(const id of ['A','B']){fs.writeFileSync(path.join(profile,id+'.stop'),'finish same process');await until(()=>records(id),r=>r.at(-1)?.final,id+' final');const footer=page.locator(`[data-zaicode-worker-terminal="${id}"] [data-zaicode-worker-duration="end"]`);await until(()=>footer.innerText(),s=>s.startsWith('exited 0 after '),id+' final attached');check(id+' final belongs to original native run',records(id).at(-1).pid===before.workers[id].pid&&records(id).at(-1).marker===before.workers[id].marker)}
    await page.getByTestId('zaicode-dispatch').last().click();
    await page.locator('[data-zaicode-dispatch-launcher="k"]').click();
    const killed=await until(()=>records('K'),r=>r.length>=3,'safe kill worker');workerPids.push(killed[0].pid);
    await page.locator('[data-zaicode-worker-terminal="K"]').locator('../..').getByTitle('Stop this worker and close it',{exact:true}).click();
    stage='explicit kill';
    const alive=()=>{try{process.kill(killed[0].pid,0);return true}catch{return false}};
    await until(alive,v=>!v,'explicit kill closes native process');
    check('kill removes only its worker and native process',await page.locator('[data-zaicode-worker-terminal="K"]').count()===0&&!alive());
    check('kill retains both other final result terminals',await panel().locator('[data-zaicode-worker-terminal]:visible').count()===2);
    check('zero renderer exceptions',errors.length===0,errors);await page.screenshot({path:out+'-after.png'});
  }catch(e){checks.push({name:'packaged scenario completed',pass:false,detail:String(e.stack||e).slice(0,1800)});if(page&&!page.isClosed())await page.screenshot({path:out+'-failure.png'}).catch(()=>{})}
  finally{for(const id of ['A','B','K'])fs.writeFileSync(path.join(profile,id+'.stop'),'fixture cleanup');if(app)await app.close().catch(()=>{});kill(pid);for(const workerPid of workerPids)kill(workerPid)}
  const report={at:new Date().toISOString(),executablePath:exe,profile,before,checks,errors,pass:checks.every(c=>c.pass),verifier:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'.saipen/evidence/T-209-packaged.cjs'))).digest('hex'),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')};
  fs.writeFileSync(out+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,checks:checks.length,failed:checks.filter(c=>!c.pass).map(c=>c.name),receipt:out+'.json'}));process.exitCode=report.pass?0:1;
})().catch(e=>{console.error(e);process.exitCode=1});
