const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const {execFileSync}=require('node:child_process');
const root=process.env.T212_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T212_PACKAGED_EXE),out=process.env.T212_PACKAGED_OUT;
if(!out)throw new Error('T212_PACKAGED_OUT required');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t212-'));
const project=path.join(profile,'workers-project');fs.mkdirSync(project);
fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
const counter=path.join(profile,'counter.cjs');
fs.writeFileSync(counter,`const fs=require('node:fs'),marker=require('node:crypto').randomUUID();let count=0;process.stdin.setRawMode?.(true);process.stdin.resume();process.stdin.on("data",data=>fs.appendFileSync(process.argv[2],JSON.stringify({pid:process.pid,marker,startedAt,count,input:data.toString()})+"\\n"));const startedAt=Date.now();const tick=()=>{const final=fs.existsSync(process.argv[3]);const r={pid:process.pid,marker,startedAt,count:++count,final};fs.appendFileSync(process.argv[2],JSON.stringify(r)+'\\n');console.log((final?'T212-FINAL:':'T212-COUNTER:')+JSON.stringify(r));if(final||count>1200)process.exit(0)};tick();setInterval(tick,250);`);
const records=id=>{try{return fs.readFileSync(path.join(profile,id+'.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))}catch{return[]}};
const quote=s=>`'${s.replaceAll("'","''")}'`;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,good,name,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const v=await read();if(good(v))return v;await pause(40)}throw new Error('Timed out: '+name)}
const checks=[],check=(name,pass,detail)=>checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});
const kill=pid=>{if(Number.isInteger(pid)&&pid>0)try{execFileSync(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/PID',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}};
(async()=>{
  let app,page,pid,before,stage='boot';const errors=[],workerPids=[];
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T212 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
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
    const composer=page.locator('[contenteditable="true"]:visible').last();await composer.waitFor({state:'visible',timeout:30000});await composer.fill('T212 retained draft');
    for(const id of ['A','B']){
      const dispatch=page.locator('[data-zaicode-dispatch]');
      if(!(await dispatch.isVisible().catch(()=>false)))await page.getByTestId('zaicode-dispatch').last().click();
      await dispatch.waitFor({state:'visible',timeout:30000});
      await dispatch.getByRole('radio',{name:'WORKERS panel',exact:true}).click();const launcher=dispatch.locator('[data-zaicode-dispatch-launcher="'+id.toLowerCase()+'"]');await until(()=>launcher.isEnabled().catch(()=>false),v=>v===true,id+' dispatch launcher enabled',15000);await launcher.click();
      await page.locator(`[data-zaicode-worker-terminal="${id}"] .xterm`).waitFor({state:'visible',timeout:30000});
      const rs=await until(()=>records(id),r=>r.length>=3,id+' native worker');workerPids.push(rs[0].pid);
      check(id+' positive: native output with one run identity',rs.every(r=>r.pid===rs[0].pid&&r.marker===rs[0].marker&&r.startedAt===rs[0].startedAt));
    }

    stage='live input';
    const terminal=id=>page.locator('[data-zaicode-worker-terminal="'+id+'"]');
    const initial=Object.fromEntries(['A','B'].map(id=>[id,records(id)[0]]));
    for(const id of ['A','B']){
      const input=terminal(id).locator('.xterm-helper-textarea');await input.focus();await input.pressSequentially('T212-live');
      await until(()=>records(id).filter(r=>r.input).map(r=>r.input).join(''),v=>v.includes('T212-live'),id+' actual live native input');
      check(id+' positive: original native process receives typing',true);
    }
    stage='native exit';
    for(const id of ['A','B']){
      fs.writeFileSync(path.join(profile,id+'.stop'),'same native run exits');
      await until(()=>records(id),r=>r.at(-1)?.final,id+' final');
      const footer=terminal(id).locator('[data-zaicode-worker-duration="end"]');
      await until(()=>footer.innerText(),s=>s.startsWith('exited 0 after '),id+' final attached');
      check(id+' positive: original run final identity retained',records(id).at(-1).pid===initial[id].pid&&records(id).at(-1).marker===initial[id].marker);
      stage=id+' post-exit input';const input=terminal(id).locator('.xterm-helper-textarea');await input.focus();await input.pressSequentially('late-query-response');
      await pause(200);check(id+' final history still visible after late input',await footer.isVisible()&&await terminal(id).locator('.xterm').isVisible());
    }
    await pause(300);check('zero renderer exceptions after native exit and late input',errors.length===0,errors);
    await page.screenshot({path:out+'.png'});
    const receipt={at:new Date().toISOString(),executablePath:exe,profile,checks,errors,pass:checks.every(c=>c.pass),verifier:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),asarSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex')};
    fs.writeFileSync(out+'.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({pass:receipt.pass,checks:checks.length,failed:checks.filter(c=>!c.pass).map(c=>c.name),receipt:out+'.json'}));process.exitCode=receipt.pass?0:1;
  }catch(error){fs.writeFileSync(out+'.json',JSON.stringify({pass:false,checks,errors,error:String(error.stack||error),profile,executablePath:exe},null,2));console.error(String(error));process.exitCode=1;
  }finally{for(const id of ['A','B','K'])fs.writeFileSync(path.join(profile,id+'.stop'),'cleanup');if(app)try{await app.close()}catch{}for(const worker of workerPids)kill(worker);kill(pid)}
})();
