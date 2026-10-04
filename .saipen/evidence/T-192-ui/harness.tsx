import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ZCodeIntlProvider} from '@/i18n/IntlProvider.js';
import {ZaicodeWorkerMenuItems, ZaicodeWorkerTerminal} from '@/zaicode/ZaicodeWorkerParts.js';
import {ContextMenu,ContextMenuTrigger,ContextMenuContent} from '@/components/ui/context-menu.js';
import {sidePaneTerminalSessionRegistry} from '@/terminal/sidePaneTerminalSessionRegistry.js';
import {terminalControl} from '@/terminal/terminalOutputTap.js';
const mode=new URLSearchParams(location.search).get('mode')||'success';
const worker={id:'handoff-fixture',generation:1,kind:'worker',short:'CLI',projectName:'handoff fixture',projectPath:'V:/fixture',command:'original-fixture-command',startedAt:Date.now(),exitCode:mode==='exited'?0:null,placement:'panel',vendor:null};
const fixture=globalThis.fixture={mode,workers:[worker],calls:0,creates:[],writes:[],disposed:[],removed:[],toasts:[],complete:()=>{},start:()=>{},getControl:()=>!!terminalControl(worker.id)?.extractToPowerShell};
let firstPrompt=false;
const terminalService={
  create:async params=>{fixture.creates.push(params);return {id:'fixture-pty',shell:'powershell.exe',fontFamily:'monospace',fontFamilySource:'default',canExtractToPowerShell:mode!=='missing'}},
  write:async ({data})=>{fixture.writes.push(data);if(mode==='nostart')await new Promise(resolve=>{fixture.start=resolve})},
  resize:async()=>{},dispose:async({id})=>{fixture.disposed.push(id)},
  onDynamicData:()=>listener=>{if(!firstPrompt){firstPrompt=true;setTimeout(()=>listener('PS V:\\fixture> '),20)}return {dispose:()=>{}}},
  onDynamicExit:()=>()=>({dispose:()=>{}}),
  extractToPowerShell:async()=>{fixture.calls++;if(mode==='failure')throw new Error('Fixture external launch refused');return await new Promise(resolve=>{fixture.complete=()=>resolve({pid:12345})})},
};
function App(){
  const [current,setCurrent]=useState(worker);
  fixture.replace=()=>{const next={...worker,generation:2};fixture.workers=[next];setCurrent(next)};
  fixture.remount=()=>setCurrent(w=>({...w,placement:w.placement==='panel'?'window':'panel'}));
  fixture.remove=id=>{fixture.removed.push(id);fixture.workers=[];sidePaneTerminalSessionRegistry.release(id);setCurrent(null)};
  return <ZCodeIntlProvider initialLocale="en-US"><main>
    {current&&<><ContextMenu><ContextMenuTrigger><header data-worker-menu>CLI handoff fixture</header></ContextMenuTrigger><ContextMenuContent><ZaicodeWorkerMenuItems worker={current as never}/></ContextMenuContent></ContextMenu>
      <div style={{width:700,height:220}}><ZaicodeWorkerTerminal worker={current as never} services={{terminalService} as never} visible/></div></>}
  </main></ZCodeIntlProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
