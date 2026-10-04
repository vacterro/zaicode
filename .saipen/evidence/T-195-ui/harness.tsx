import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ZCodeIntlProvider} from '@/i18n/IntlProvider.js';
import {SwitchModeToolCallBlock} from '@/ToolCallBlocks/renderers/switch-mode.js';
import {resolveAssistantCopyText} from '@/v4/ConversationTurnRow.js';
const params=new URLSearchParams(location.search);
function App(){
  const [product,setProduct]=useState(params.get('product')!=='off');
  const [failure,setFailure]=useState(params.get('error')==='on');
  (globalThis as any).__ZAICODE_PRODUCT_MODE__=product;
  const row={kind:'toolCall',id:'plan-row',toolCallId:'plan-tool',toolName:'ExitPlanMode',status:'success',inputText:'',input:{plan:'# Historical plan\nReview then implement.'},output:{approved:true,plan:'# Historical plan\nReview then implement.'},inputTruncated:false,outputTruncated:false};
  const assistant={kind:'assistantText',text:'Implemented and verified.'};
  const copy=resolveAssistantCopyText({assistantWorkRows:[row],assistantTextRows:[assistant],latestAssistantTextRow:assistant} as never);
  (globalThis as any).fixture={product,failure,copy,ready:true};
  const context={workspacePath:'V:/fixture',theme:'dark',toolCallNode:{toolCall:{toolId:'plan-tool',toolName:'ExitPlanMode',status:failure?'failed':'completed',input:row.input,output:row.output,...(failure?{error:'Fixture planning failure'}:{})},childToolCalls:[]},onOpenPlanDetail:()=>{(globalThis as any).fixture.opened=true}};
  return <ZCodeIntlProvider initialLocale="en-US"><main>
    <button id="toggle-product" onClick={()=>setProduct(v=>!v)}>Toggle product</button>
    <button id="toggle-error" onClick={()=>setFailure(v=>!v)}>Toggle failure</button>
    <div id="plan-slot"><SwitchModeToolCallBlock {...context as never}/></div>
    <p id="normal-answer">Implemented and verified.</p>
  </main></ZCodeIntlProvider>;
}
createRoot(document.getElementById('root')!).render(<App/>);
