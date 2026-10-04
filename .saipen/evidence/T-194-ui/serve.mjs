import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
const here=import.meta.dirname, product=resolve(here,'../../../zcode');
const require=createRequire(resolve(product,'package.json'));
const {build}=require('esbuild');
const stubs={
  logger:'export const logger={debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}}; export const logMemoryDiagnostics=()=>{};',
  useWorkspaceServices:'const services={zcodeTaskService:{},zcodeAgentService:{}}; export const useWorkspaceServices=()=>services; export const useBaseWorkspaceServices=()=>({}); export const useWorkspaceOrContextServices=()=>services; export const useOptionalBaseWorkspaceServices=()=>null;',
  useConfirmDialog:'export const useConfirmDialog=()=>async()=>false;',
  zcodeSessionStore:'import {create} from "zustand"; const noop=()=>{}; export const useZCodeSessionStore=create(()=>({activeTaskId:"helper",startDraft:noop,removeTaskState:noop,upsertOptimisticTaskListItem:noop,removeOptimisticTaskListItem:noop,setTaskUnreadIndicator:noop})); export const selectWorkspaceZCodeState=state=>state;',
  TabStoreProvider:'export const useTabStore=sel=>sel({openSettingsTab:()=>{}}); export const useOptionalTabStore=()=>false;',
  tabStore:'export const isWorkspaceReadOnly=()=>false; export const isWorkspaceTab=tab=>tab.type==="workspace";',
  ZaicodeProjectEngines:'export const ZaicodeProjectEngineMenuItems=()=>null; export const ZaicodeProjectWorkerChips=()=>null;',
  zaicodeProjectRuntime:'export const useZaicodeProjectRuntime=()=>null;',
  zaicodeSaipen:'export const ZAICODE_SAIPEN_START_COMMAND="/goal cc all"; export const useZaicodeSaipen=()=>null; export const useZaicodePendingCommand=sel=>sel({queue:()=>{}}); export const useZaicodeFreshSession={getState:()=>({open:()=>{}})};',
  toast:'export const toast=()=>{};',
  RemoteSyncActions:'export const RemoteSyncDialogs=()=>null; export const RemoteSyncMenuItems=()=>null; export const shouldShowRemoteSyncActions=()=>false;',
};
const subjects=new Set(['packages/ui/src/WorkspaceSidebarItem.tsx','packages/ui/src/TaskListItem.tsx','packages/ui/src/zaicode/zaicodeProjectClick.ts','packages/ui/src/v4/taskListRowActivity.ts','packages/ui/src/lib/taskListItemPresentation.ts','packages/ui/src/zaicode/zaicodeStall.ts']);
const result=await build({entryPoints:[resolve(here,'harness.tsx')],bundle:true,write:false,format:'iife',platform:'browser',absWorkingDir:product,
  nodePaths:[resolve(product,'node_modules'),resolve(product,'packages/ui/node_modules')],loader:{'.png':'dataurl','.svg':'dataurl'},
  alias:{'@':resolve(product,'packages/ui/src'),react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))},
  define:{'process.env.NODE_ENV':'"development"','process.env.ZCODE_ZAICODE_MODE':'"1"'},
  plugins:[{name:'fixture-host-ports',setup(b){
    b.onResolve({filter:/\.js$/},args=>{const name=args.path.split('/').at(-1).slice(0,-3);if(name in stubs)return {path:name,namespace:'fixture'}});
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js',resolveDir:resolve(product,'packages/ui')}));
    if(process.env.T194_UI_SUBJECT)b.onLoad({filter:/\.(ts|tsx)$/},args=>{const path=relative(product,args.path).replaceAll('\\','/');if(subjects.has(path))return {contents:execFileSync('git',['-C',product,'show',`${process.env.T194_UI_SUBJECT}:${path}`],{encoding:'utf8'}),loader:path.endsWith('tsx')?'tsx':'ts'}});
  }}]});
const html='<!doctype html><meta charset="utf-8"><style>body{margin:20px;background:#1a1810;color:#d4c89a;font:14px Verdana}button{margin:4px}svg{height:16px;width:16px}ul{padding-left:16px}article,section{border:1px solid #75663d;padding:10px}.flex{display:flex}.flex-col{flex-direction:column}.items-center{align-items:center}.gap-1{gap:4px}.gap-2{gap:8px}.shrink-0{flex-shrink:0}.min-w-0{min-width:0}.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hidden{display:none}.opacity-0{opacity:0}.pointer-events-none{pointer-events:none}.group:hover .group-hover\\:opacity-100{opacity:1}</style><div id="root"></div><script src="/fixture.js"></script>';
createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'application/javascript':'text/html; charset=utf-8');res.end(req.url==='/fixture.js'?result.outputFiles[0].contents:html)}).listen(Number(process.env.T194_UI_PORT||4194),'127.0.0.1',()=>console.log('T194 fixture ready http://127.0.0.1:4194'));
