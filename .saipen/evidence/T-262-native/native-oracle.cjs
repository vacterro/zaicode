const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const { _electron } = createRequire(path.join(root, 'zcode/package.json'))('playwright-core');
const executablePath = process.env.T262_EXE || path.join(root, 'zcode/packages/desktop/dist-t262/win-unpacked/ZAICODE.exe');
const out = process.env.T262_OUT || path.join(root, '.saipen/evidence/T-262-native/fixed');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zaicode-t262-profile-'));
fs.mkdirSync(out, { recursive: true });
let app, page, stage = 'launch'; const checks = [], errors = [], requests = [];
let nodes = [{ id: 'acme', prefix: 'acme', name: 'Acme Fixture', baseUrl: 'https://fixture.example/v1' }];
let connections = [{ id: 'acme-key', provider: 'acme', name: 'Acme Fixture', isActive: true }];
let combos = [{ id: 'free', name: 'SAIFREN', models: ['manual/first', 'manual/second'] }, { id: 'own', name: 'SAIOPP', models: [] }];
let custom = [], rows = [], lateEdit = false, lastRequestAt = Date.now();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, pass, detail) => { checks.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); if (!pass) throw new Error(name); };
const server = http.createServer(async (req,res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {}; const url = req.url; lastRequestAt = Date.now();
    requests.push({ method: req.method, path: url }); let data = {};
    if (url === '/api/health') data = { status: 'ok' };
    else if (url === '/api/version') data = { currentVersion: '0.5.91' };
    else if (url === '/api/keys') data = req.method === 'POST' ? { key: 'fixture-router-key' } : { keys: [{ key: 'fixture-router-key', isActive: true }] };
    else if (url === '/api/provider-nodes') { if (req.method === 'POST') { const node={...body,id:'node-'+nodes.length}; nodes.push(node);data={node}; } else data={nodes}; }
    else if (url === '/api/providers') { if (req.method === 'POST') { const connection={...body,id:'key-'+connections.length,isActive:true};connections.push(connection);data={connection}; } else data={connections}; }
    else if (url === '/api/combos') { if (req.method === 'POST') { const combo={...body,id:'combo-'+combos.length};combos.push(combo);data={combo}; } else data={combos}; }
    else if (url.startsWith('/api/combos/') && req.method === 'PUT') { const id=url.split('/').pop();combos=combos.map(c=>c.id===id?{...c,...body}:c);data=combos.find(c=>c.id===id)||{}; }
    else if (url === '/api/models') data={models:[{provider:'opencode',model:'old-free',routedModel:'oc/old-free'},...custom.map(m=>({provider:m.providerAlias,model:m.id,routedModel:m.providerAlias+'/'+m.id}))]};
    else if (url === '/api/models/custom') { if (req.method === 'POST' && !custom.some(m=>m.providerAlias===body.providerAlias&&m.id===body.id)) custom.push(body);data={models:custom,success:true}; }
    else if (url === '/api/providers/acme-key/models') { if(lateEdit){combos[0].models=['external/first','manual/second','manual/first',...combos[0].models.filter(m=>!['manual/first','manual/second'].includes(m))];lateEdit=false;}data={models:rows}; }
    else if (/^\/api\/providers\/[^/]+\/models$/.test(url)) data={models:[],warning:'Fixture has no live listing for this account'};
    else if (url === '/api/settings') data = {};
    else if (url === '/v1/models') data={data:[{id:'SAIFREN',object:'model'}]};
    else if (/\/v1\/(chat\/completions|responses)/.test(url)) data={id:'fixture-probe',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'Fixture ready.'},finish_reason:'stop'}]};
    res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
  } catch(e) { errors.push('fixture: '+e);if(!res.headersSent)res.writeHead(500);res.end(); }
});
(async()=>{
 const receipt={ticket:'T-262',executablePath,profile,checks};
 try {
  server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url='http://127.0.0.1:'+server.address().port;
  fs.writeFileSync(path.join(profile,'zaicode-engines.json'),JSON.stringify({keepWindowsRolling:false}));
  fs.writeFileSync(path.join(profile,'zaicode-router-host.json'),JSON.stringify({mode:'shared',port:20148}));
  const credential=path.join(profile,'AppData/Roaming/9router');fs.mkdirSync(path.join(credential,'auth'),{recursive:true});
  fs.writeFileSync(path.join(credential,'machine-id'),'isolated-fixture-machine');fs.writeFileSync(path.join(credential,'auth/cli-secret'),'isolated-fixture-secret');
  const env={...process.env,ZCODE_DESKTOP_APPLICATION_NAME:'T262 fixture '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,
   ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,
   ZCODE_HOME:path.join(profile,'.zcode'),HOME:profile,USERPROFILE:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),
   ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZAICODE_ROUTER_URL:url,SAIPEN_HOME:''};
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW|ELECTRON_RUN_AS_NODE|SAIMAIL_WORKSPACE|ZAICODE_INSTALL_ROOT)/i.test(key))delete env[key];
  delete env.TZ;
  app=await _electron.launch({executablePath,args:['--user-data-dir='+profile],env,timeout:90000});
  check('app owns isolated profile',path.resolve(await app.evaluate(({app})=>app.getPath('userData')))===path.resolve(profile));
  const deadline=Date.now()+90000;while(!page&&Date.now()<deadline){page=app.windows().find(w=>w.url().includes('/out/renderer/index.html'));if(!page)await pause(150);}
  if(!page)throw new Error('No renderer');page.on('pageerror',e=>errors.push(String(e)));
  await page.locator('[data-workspace-shell=true]').waitFor({timeout:90000});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('/out/renderer/index.html')).setContentSize(1200,850));
  await page.evaluate(()=>localStorage.setItem('zcode-locale-preference','en-US'));
  await page.reload();await page.locator('[data-workspace-shell=true]').waitFor();
  stage='settings';await page.locator("button[aria-label='Settings']").first().click();
  await page.getByTestId('settings-section-nav-zaicodeRouter').click();
  await page.locator('[data-zaicode-router-quickstart]').waitFor();
  const control=page.locator('[data-zaicode-router-model-check]');
  check('visible explicit zero-token Check',await control.count()===1);
  await page.waitForFunction(()=>!document.querySelector('[data-zaicode-router-model-check]')?.disabled,{},{timeout:90000});
  const add=page.getByRole('button',{name:'Add models',exact:true});
  check('visible Add models action',await add.count()===1);
  await add.waitFor();await page.waitForFunction(()=>!document.querySelector('[data-zaicode-router-model-check]')?.disabled,{},{timeout:90000});
  await pause(700);requests.length=0;
  rows=[{id:'new-free',pricing:{prompt:'0',completion:'0'}},{id:'paid-free',pricing:{prompt:'1',completion:'2'}}];
  const before=JSON.stringify(combos);stage='check';await control.click();
  await page.waitForFunction(()=>!document.querySelector('[data-zaicode-router-model-check]')?.disabled,{},{timeout:90000});
  await page.locator('[data-zaicode-router-model-checks] summary').click();
  await page.getByText('Acme Fixture (acme)',{exact:true}).waitFor();
  check('Check leaves combos untouched',JSON.stringify(combos)===before);
  check('Check only sends GET metadata requests',requests.length>0&&requests.every(r=>r.method==='GET'),structuredClone(requests));
  check('Check displays zero tokens and scope',await page.locator('[data-zaicode-router-quickstart]').innerText().then(t=>/0 generated tokens/.test(t)&&/Generation and remaining quota/.test(t)));
  check('Check covers provider outside starter list',requests.some(r=>r.path==='/api/providers/acme-key/models'));
  await page.screenshot({path:path.join(out,'check.png')});
  stage='add';lateEdit=true;await add.click();
  await page.waitForFunction(()=>!document.querySelector('[data-zaicode-router-model-check]')?.disabled,{},{timeout:90000});
  check('new free model appended',combos[0].models.includes('acme/new-free'));
  check('paid free suffix kept out of SAIFREN',!combos[0].models.includes('acme/paid-free'));
  check('late external ordering preserved',JSON.stringify(combos[0].models.slice(0,3))===JSON.stringify(['external/first','manual/second','manual/first']),combos[0].models.slice(0,3));
  check('paid supported model becomes selectable',custom.some(m=>m.providerAlias==='acme'&&m.id==='paid-free'));
  check('native OpenCode free discovered without zen node',combos[0].models.some(m=>m.startsWith('oc/'))&&!nodes.some(n=>n.prefix==='zen'));
  await page.screenshot({path:path.join(out,'added.png')});
  const after=JSON.stringify(combos);await add.click();await page.waitForFunction(()=>!document.querySelector('[data-zaicode-router-model-check]')?.disabled,{},{timeout:90000});
  check('second Add models is idempotent',JSON.stringify(combos)===after);
  check('Check/Add models generate zero inference requests',!requests.some(r=>/\/v1\/(chat|responses|completions|embeddings)/.test(r.path)),requests.filter(r=>r.method!=='GET'));
  check('zero renderer and fixture errors',errors.length===0,errors);
  receipt.pass=true;
 } catch(e) {receipt.pass=false;receipt.error=String(e);receipt.stage=stage;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1;}
 finally {receipt.errors=errors;receipt.requests=requests;receipt.asarSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(executablePath),'resources/app.asar'))).digest('hex');receipt.verifierSha256=crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({pass:receipt.pass,checks:checks.length,error:receipt.error}));if(app)await app.close();server.close();}
})();
