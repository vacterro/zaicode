import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const product = resolve(here, '../../../zcode');
const require = createRequire(resolve(product, 'package.json'));
const { build } = require('esbuild');
const nothing = names => names.map(name => `export function ${name}(){return null}`).join('\n');
const stubs = {
  useInterfaceMode: 'export const useIsOfficeMode=()=>false;',
  'chat-loading': nothing(['ChatLoading']),
  display: nothing(['ChatApiRetryStatus']),
  checkbox: nothing(['Checkbox']),
  message: nothing(['MessageActions','MessageResponse']),
  ToolCallBlocks: nothing(['ToolCallBlock']),
  'cron-create': `${nothing(['CronCreateAutomationCard'])}; export const isCronAutomationCardToolCall=()=>false; export const readCronCreateAutomationSummary=()=>null;`,
  'offpeak-create': `${nothing(['OffPeakCreateTaskCard'])}; export const isOffPeakCreateToolCall=()=>false; export const readOffPeakCreateTaskSummary=()=>null;`,
  AssistantCodeCommentFeatureProvider: 'export const useAssistantCodeCommentFeatureEnabled=()=>false;',
  useAssistantPreviewCardsForRow: 'export const useAssistantPreviewCardsForAssistantTextRow=()=>[];',
  ConversationAgentToolCallRow: nothing(['ConversationAgentToolCallRow']),
  ConversationFileSummaryPanel: nothing(['ConversationFileSummaryPanel']),
  WorkflowNotificationToolRow: nothing(['WorkflowNotificationToolRow']),
  ConversationWorkflowDigests: nothing(['ConversationWorkflowDigests']),
  ConversationWorkflowCompletion: nothing(['ConversationWorkflowCompletion']),
  workflowTurnDigests: 'export const resolveWorkflowTurnDigests=()=>[];',
  workflowTurnCompletion: 'export const resolveWorkflowTurnCompletion=()=>undefined;',
  ConversationRowView: `${nothing(['ConversationAssistantTextActions'])}; export const readAssistantFeedback=()=>undefined;`,
  ConversationTurnRow: `import React from 'react'; export const resolveAssistantCopyText=row=>row.text;
    export function ConversationTurnRow({row}){globalThis.fixture.rowRenders++;return React.createElement('p',{'data-fixture-row':row.kind},row.text||row.reasoning||'history');}`,
  ConversationHookDetailsAction: nothing(['ConversationHookDetailsAction']),
  TerminalSession: `import React,{useEffect} from 'react'; export function TerminalSession(props){
    globalThis.fixture.terminalRenders++; globalThis.fixture.terminalExit=props.onExit;
    useEffect(()=>{globalThis.fixture.terminalMounts++;globalThis.fixture.inputs.push(props.initialInput)},[]);
    return React.createElement('div',{'data-fixture-terminal':true,style:{height:'100%',overflow:'auto'}},'Actual terminal rendering is a fixture leaf; duration wrapper is production.');}`,
  confirmDialogStore: 'export const useConfirmDialogStore={getState:()=>({requestConfirmation:async()=>true})};',
  toast: 'export const toast=()=>{};',
  zaicodeActions: 'export const openZaicodeSettings=()=>{};',
  zaicodeWorkers: `export const markZaicodeWorkerExited=(id,exitCode)=>globalThis.fixture.update({exitCode,endedAt:Date.now()});
    export const zaicodeWorkerTitle=w=>w.short; export const duplicateZaicodeWorker=()=>null;
    ${nothing(['dockZaicodeWorker','floatZaicodeWorker','focusZaicodeWorker','minimizeZaicodeWorker','raiseZaicodeWorker','removeZaicodeWorker'])}`,
  zaicodeWorkerPrefs: `export const useZaicodeWorkerPrefs=()=>({font:'profile',fontSize:14});
    useZaicodeWorkerPrefs.getState=()=>({confirmClose:true}); export const zaicodeWorkerFontFamily=()=>undefined;`,
  ZaicodeLimitViews: 'export const zaicodeVendorColor=()=>undefined;',
  terminalOutputTap: 'export const terminalControl=()=>null;',
};
Object.assign(stubs, { 'reasoning': nothing(['Reasoning','ReasoningContent','ReasoningTrigger']), ToolLayout: nothing(['ToolLayout']), ConversationUserInputBody: nothing(['ConversationUserInputBody']), ConversationUserInputContent: nothing(['ConversationUserInputContent']) });
const subjects = new Set(['packages/ui/src/v4/ConversationTurnGroup.tsx','packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx','packages/ui/src/v4/conversationTurnWorkSegments.ts','packages/ui/src/v4/conversationWorkDuration.ts']);
const result = await build({entryPoints:[resolve(here,'harness.tsx')],bundle:true,write:false,format:'iife',platform:'browser',
  absWorkingDir:product,nodePaths:[resolve(product,'node_modules'),resolve(product,'packages/ui/node_modules')],
  alias:{'@':resolve(product,'packages/ui/src'),react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))},
  define:{'process.env.NODE_ENV':'"development"','process.env.ZCODE_ZAICODE_MODE':'"1"'},
  plugins:[{name:'fixture-leaves',setup(build){
    build.onResolve({filter:/\.js$/},args=>{const name=args.path.split('/').at(-1).slice(0,-3);if(name in stubs)return {path:name,namespace:'fixture'};});
    build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js'}));
    if(process.env.T210_SUBJECT)build.onLoad({filter:/\.(ts|tsx)$/},args=>{const path=relative(product,args.path).replaceAll('\\','/');
      if(subjects.has(path))return {contents:execFileSync('git',['-C',product,'show',`${process.env.T210_SUBJECT}:${path}`],{encoding:'utf8'}),loader:'tsx'};});
  }}],
});
const html=`<!doctype html><meta charset="utf-8"><style>body{margin:12px;font:14px Verdana;background:#1a1810;color:#d4c89a}button{font:inherit;color:inherit;background:transparent;border:1px solid #75663d}section{box-sizing:border-box;max-width:100%}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.h-full{height:100%}.shrink-0{flex-shrink:0}.overflow-hidden{overflow:hidden}.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}[data-fixture-terminal]{border:1px solid #75663d}[data-case]{margin-bottom:24px}p{margin:8px 0}</style><div id="root"></div><script src="/fixture.js"></script>`;
createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'application/javascript':'text/html; charset=utf-8');res.end(req.url==='/fixture.js'?result.outputFiles[0].contents:html);}).listen(4210,'127.0.0.1',()=>console.log('T210 fixture http://127.0.0.1:4210'));
