import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..'), product = join(root, 'zcode');
let script = readFileSync(join(root, '.saipen/evidence/T-209-packaged.cjs'), 'utf8');
script = script.slice(0, script.indexOf('    const panel=()=>'));
script = script.replaceAll('T209', 'T212').replaceAll('t209', 't212');
script = script.replace('let count=0;', 'let count=0;process.stdin.setRawMode?.(true);process.stdin.resume();process.stdin.on("data",data=>fs.appendFileSync(process.argv[2],JSON.stringify({pid:process.pid,marker,startedAt,count,input:data.toString()})+"\\\\n"));');
// Instrument repair: the dispatch panel closes itself when a launcher run reports, so the
// fixed sequence used to toggle it shut and then wait 30s on a launcher that was never
// actionable. Open it only when it is actually closed, wait for it, and wait for the
// launcher to be enabled instead of letting .click() time out. No check predicate changes.
script = script.replace("      await page.getByTestId('zaicode-dispatch').last().click();const dispatch=page.locator('[data-zaicode-dispatch]');", "      const dispatch=page.locator('[data-zaicode-dispatch]');\n      if(!(await dispatch.isVisible().catch(()=>false)))await page.getByTestId('zaicode-dispatch').last().click();\n      await dispatch.waitFor({state:'visible',timeout:30000});");
script = script.replace("      await dispatch.getByRole('radio',{name:'WORKERS panel',exact:true}).click();await dispatch.locator(`[data-zaicode-dispatch-launcher=\"${id.toLowerCase()}\"]`).click();", "      await dispatch.getByRole('radio',{name:'WORKERS panel',exact:true}).click();const launcher=dispatch.locator('[data-zaicode-dispatch-launcher=\"'+id.toLowerCase()+'\"]');await until(()=>launcher.isEnabled().catch(()=>false),v=>v===true,id+' dispatch launcher enabled',15000);await launcher.click();");
script += `
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
`;
writeFileSync(join(root, '.saipen/evidence/T-212-packaged.cjs'), script);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const base=execFileSync('git',['rev-parse','HEAD'],{cwd:product,encoding:'utf8'}).trim();
const sources=['packages/ui/src/terminal/TerminalSession.tsx','packages/ui/src/terminal/sidePaneTerminalSessionRegistry.ts'];
const paths=[...sources,'packages/ui/test/zaicodeT212TerminalExit.test.ts','specs/zaicode-t212-terminal-exit-input.md'];
const owned=Object.fromEntries(paths.map(p=>[p,hash(readFileSync(join(product,p)))]));
const foreign=JSON.parse(readFileSync(join(root,'.saipen/evidence/T-209-subject-final.json'),'utf8')).foreign;
const instruments=Object.fromEntries(['zcode/packages/ui/test/zaicodeT212TerminalExit.test.ts','.saipen/evidence/T-212-packaged.cjs'].map(p=>[p,hash(readFileSync(join(root,p)))]));
const red=Object.fromEntries(sources.map(p=>[p,hash(execFileSync('git',['show',base+':'+p],{cwd:product}))]));
const regression={verifier:hash(JSON.stringify(instruments)),redSubject:hash(JSON.stringify(red)),greenSubject:hash(JSON.stringify(Object.fromEntries(sources.map(p=>[p,owned[p]]))))};
writeFileSync(join(root,'.saipen/evidence/T-212-subject-final.json'),JSON.stringify({base,owned,foreign,instruments,regression},null,2));
const gate=readFileSync(join(root,'.saipen/evidence/T-209-gate.mjs'),'utf8').replaceAll('T-209','T-212').replaceAll('T209','T212').replaceAll('t209','t212').replace("'--skip-build']", "'--skip-build', '--skip-prepare']").replace("ZCODE_DESKTOP_DIST_DIR: '.release-work/t212-20261004'", "ZCODE_DESKTOP_DIST_DIR: process.env.T212_DIST_DIR || '.release-work/t212-20261004'");
writeFileSync(join(root,'.saipen/evidence/T-212-gate.mjs'),gate);
console.log(JSON.stringify({base,owned:paths.length,instruments,...regression}));
