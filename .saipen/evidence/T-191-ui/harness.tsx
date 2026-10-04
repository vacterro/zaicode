import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ZCodeIntlProvider } from '@/i18n/IntlProvider.js';
import { ConversationTurnGroup } from '@/v4/ConversationTurnGroup.js';
import { buildConversationTurnRenderUnits } from '@/v4/conversationTurnRenderUnits.js';
import { ZaicodeWorkerLabel, ZaicodeWorkerTerminal, useZaicodeNow } from '@/zaicode/ZaicodeWorkerParts.js';
const base=Date.now();
const hours=2*3600000+35*60000;
globalThis.fixture={rowRenders:0,terminalRenders:0,terminalMounts:0,inputs:[]};
function unit(id,state,duration=hours,guided=false){
  const header={kind:'turnHeader',rowId:0,turnId:id,executionKind:'agent',startedAt:base-duration,state:state==='running'?'running':state==='interrupted'?'completedInterrupted':'completedSuccess',...(state==='running'?{}:{endedAt:base,activeMs:duration})};
  if(guided)header.workSegments=[{triggerEntityId:'main',startedAt:base-hours,endedAt:base-30*60000},{triggerEntityId:'guide',startedAt:base-30*60000,endedAt:base}];
  const rows=[header,{kind:'userInput',rowId:1,turnId:id,entityId:'main',origin:'realUser',text:'Task input'},
    {kind:'reasoning',rowId:2,turnId:id,entityId:'reason',text:'Working history',state:'complete'},
    {kind:'assistantText',rowId:3,turnId:id,entityId:'result',text:'Final answer body',state:state==='running'?'streaming':'complete',actions:{}}];
  if(guided)rows.push({kind:'userInput',rowId:4,turnId:id,entityId:'guide',origin:'realUser',guided:true,text:'Guided input'},{kind:'assistantText',rowId:5,turnId:id,entityId:'next',text:'Guided final answer',state:'complete',actions:{}});
  if(state==='unknown'){delete header.activeMs;delete header.endedAt;}
  if(state==='control')header.executionKind='controlOnly';
  return buildConversationTurnRenderUnits(rows as never,{nowMs:base})[0]!;
}
function Worker({state}){
  const worker={id:'fixture-worker',short:'CLI',projectName:'duration fixture',projectPath:'V:/fixture',command:'fixture-original-command',startedAt:base-hours,endedAt:state.endedAt,exitCode:state.exitCode,placement:state.placement||'panel',vendor:null};
  const now=useZaicodeNow(30000,worker.exitCode===null);
  return <div data-case="worker" style={{height:180,display:'flex',flexDirection:'column'}}><header><ZaicodeWorkerLabel worker={worker as never} now={now}/></header><div style={{flex:1,minHeight:0}}><ZaicodeWorkerTerminal worker={worker as never} services={{} as never} visible/></div></div>;
}
function App(){
  const [state,setState]=useState({exitCode:null,endedAt:null,placement:'panel',finished:false,locale:'en-US'});
  globalThis.fixture.update=patch=>setState(s=>({...s,...patch}));
  const [units]=useState(()=>['running','completed','interrupted','unknown','control','guided'].map(id=>unit(id,id==='guided'?'completed':id,hours,id==='guided')));
  const runningUnit=state.finished?unit('running','completed'):units[0];
  const context={workspacePath:'V:/fixture',theme:'dark',messageStreamShowReasoning:true,chatLoadingBlockedByActiveWork:true};
  return <ZCodeIntlProvider key={state.locale} initialLocale={state.locale as never}><main>
    {units.map((u,i)=><div data-case={u.turnId} key={u.turnId}><h3>{u.turnId}</h3><ConversationTurnGroup unit={i===0?runningUnit:u} context={context as never}/></div>)}
    <Worker state={state}/>
  </main></ZCodeIntlProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
