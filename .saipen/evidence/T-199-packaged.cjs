const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const root=process.env.T199_PROJECT_ROOT||'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const {_electron}=createRequire(path.join(root,'zcode/packages/desktop/package.json'))('playwright-core');
const exe=path.resolve(process.env.T199_PACKAGED_EXE||path.join(root,'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe'));
const out=process.env.T199_PACKAGED_OUT||path.join(os.tmpdir(),'t199-packaged');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'zaicode-t199-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[];const check=(name,pass,detail)=>{checks.push({name,pass:!!pass,...(detail===undefined?{}:{detail})});};
(async()=>{
  let app,page,stage='boot';const errors=[];
  const env={...process.env,ZCODE_ZAICODE_MODE:'1',ZAICODE_UPDATES:'off',ZCODE_DESKTOP_APPLICATION_NAME:'ZAICODE T199 '+path.basename(profile),ZCODE_DESKTOP_HOME_DIR:profile,ZCODE_DESKTOP_USER_DATA_DIR:profile,ZCODE_DESKTOP_SESSION_DATA_DIR:path.join(profile,'session'),ZCODE_DATA_BASE_DIR:profile,ZCODE_HOME:path.join(profile,'.zcode'),USERPROFILE:profile,HOME:profile,APPDATA:path.join(profile,'AppData/Roaming'),LOCALAPPDATA:path.join(profile,'AppData/Local'),ZAICODE_CUSTOMIZATION_DIR:path.join(profile,'customization')};
  delete env.TZ;delete env.SAIMAIL_WORKSPACE;delete env.ZAICODE_INSTALL_ROOT;
  for(const key of Object.keys(env))if(/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key))delete env[key];

  // What the operator sees is pixels, not tokens: read the painted control itself.
  const paint=async(locator)=>{
    const box=await locator.boundingBox();
    if(!box)return null;
    const png=await locator.screenshot();
    return await page.evaluate(async(data)=>{
      const img=new Image();img.src='data:image/png;base64,'+data;
      await img.decode();
      const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
      const {data:pixels}=ctx.getImageData(0,0,canvas.width,canvas.height);
      let light=0,total=0,sum=0,max=0;
      for(let i=0;i<pixels.length;i+=4){
        const r=pixels[i],g=pixels[i+1],b=pixels[i+2],a=pixels[i+3];
        if(a<8)continue;
        total++;
        const l=(0.2126*r+0.7152*g+0.0722*b)/255;
        sum+=l;if(l>max)max=l;if(l>0.85)light++;
      }
      return{width:canvas.width,height:canvas.height,pixels:total,mean:total?Number((sum/total).toFixed(3)):0,max:Number(max.toFixed(3)),lightShare:total?Number((light/total).toFixed(3)):0};
    },png.toString('base64'));
  };

  try{
    app=await _electron.launch({executablePath:exe,args:['--user-data-dir='+profile],env,timeout:90000});
    page=await (async()=>{const end=Date.now()+60000;while(Date.now()<end){const ws=app.windows();const hit=ws.find(w=>w.url().includes('/out/renderer/index.html'));if(hit)return hit;await pause(60)}throw new Error('Timed out: main renderer')})();
    page.on('pageerror',e=>errors.push({stage,stack:String(e.stack||e)}));
    await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    check('the packaged app runs on an isolated profile',path.resolve(await app.evaluate(({app})=>app.getPath('userData')))===path.resolve(profile));
    await page.evaluate(()=>localStorage.setItem('zcode-locale-preference','en-US'));
    await page.reload();await page.locator('[data-workspace-shell="true"]').waitFor({timeout:60000});
    await page.setViewportSize({width:1400,height:900});

    stage='the native controls in Settings';
    const scheme=await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme);
    check('the document declares the dark surface to Chromium',/dark/.test(scheme),{scheme});

    await page.locator("button[aria-label='Settings']").first().click({timeout:10000});
    const nav=page.locator('nav').filter({hasText:'Keyboard Shortcuts'}).first();
    await nav.waitFor({timeout:15000});
    const entries=await nav.locator('button').evaluateAll(nodes=>nodes.map(n=>(n.textContent??'').trim().replace(/\s+/g,' ')));
    let slider=null,sliderSection='',checkbox=null;
    for(const [index,name] of entries.entries()){
      const entry=nav.locator('button').nth(index);
      if(!(await entry.isVisible().catch(()=>false)))await entry.evaluate(n=>{const f=n.closest('details');if(f)f.open=true;}).catch(()=>{});
      try{await entry.click({timeout:8000});}catch{continue;}
      await pause(500);
      const ranges=page.locator('input[type="range"]');
      if(!(await ranges.count()))continue;
      for(let i=0;i<await ranges.count();i++){const r=ranges.nth(i);if(await r.isVisible().catch(()=>false)){slider=r;sliderSection=name;break;}}
      if(slider)break;
    }
    check('a Settings slider was found to look at',!!slider,{section:sliderSection});

    stage='the slider paint';
    if(slider){
      await slider.scrollIntoViewIfNeeded();await pause(400);
      const before=await paint(slider);
      check('the slider is not a white slab on a dark theme',before&&before.lightShare<0.02,before);
      const accent=await slider.evaluate(node=>getComputedStyle(node).accentColor);
      check('the slider carries the theme tint, not the browser default',!!accent&&accent!=='auto'&&accent!=='rgb(0, 0, 0)',{accent});
      const boxes=page.locator('input[type="checkbox"]');
      for(let i=0;i<await boxes.count();i++){const c=boxes.nth(i);if(await c.isVisible().catch(()=>false)){checkbox=c;break;}}
    }
    stage='the checkbox paint';
    if(checkbox){
      await checkbox.scrollIntoViewIfNeeded();await pause(400);
      const painted=await paint(checkbox);
      check('other native controls are not white either',painted&&painted.lightShare<0.25,painted);
    }

    check('zero renderer exceptions while looking',errors.length===0,errors);
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