import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
const here=import.meta.dirname;
const product=resolve(here,'../../../zcode');
const require=createRequire(resolve(product,'package.json'));
const {build}=require('esbuild');
const stubs={
  logger:'export const logger={debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}}; export const logMemoryDiagnostics=()=>{};',
  terminalTheme:'export const mergeTerminalTheme=()=>({background:"#1a1810",foreground:"#d4c89a"});',
  confirmDialogStore:'export const useConfirmDialogStore={getState:()=>({requestConfirmation:async()=>true})};',
  toast:'export const toast=text=>globalThis.fixture.toasts.push(text);',
  zaicodeActions:'export const openZaicodeSettings=()=>{};',
  zaicodeWorkers:`export const readZaicodeWorkers=()=>({workers:globalThis.fixture.workers}); export const removeZaicodeWorker=id=>globalThis.fixture.remove(id);
    export const zaicodeWorkerTitle=w=>w.short;export const duplicateZaicodeWorker=()=>null;
    export const dockZaicodeWorker=()=>{};export const floatZaicodeWorker=()=>{};export const focusZaicodeWorker=()=>{};export const minimizeZaicodeWorker=()=>{};export const raiseZaicodeWorker=()=>{};export const markZaicodeWorkerExited=()=>{};`,
  zaicodeWorkerPrefs:`export const useZaicodeWorkerPrefs=()=>({font:'profile',fontSize:14});useZaicodeWorkerPrefs.getState=()=>({confirmClose:true});export const zaicodeWorkerFontFamily=()=>undefined;`,
  ZaicodeLimitViews:'export const zaicodeVendorColor=()=>undefined;',
};
const subjects=new Set(['packages/ui/src/terminal/TerminalSession.tsx','packages/ui/src/terminal/terminalOutputTap.ts','packages/ui/src/zaicode/ZaicodeWorkerParts.tsx']);
const result=await build({entryPoints:[resolve(here,'harness.tsx')],bundle:true,write:false,format:'iife',platform:'browser',absWorkingDir:product,
  nodePaths:[resolve(product,'node_modules'),resolve(product,'packages/ui/node_modules')],
  alias:{'@':resolve(product,'packages/ui/src'),react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))},
  define:{'process.env.NODE_ENV':'"development"','process.env.ZCODE_ZAICODE_MODE':'"1"'},
  plugins:[{name:'fixture-ports',setup(b){
    b.onResolve({filter:/\.js$/},args=>{const name=args.path.split('/').at(-1).slice(0,-3);if(name in stubs)return {path:name,namespace:'fixture'}});
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js'}));
    if(process.env.T192_UI_SUBJECT)b.onLoad({filter:/\.(ts|tsx)$/},args=>{const path=relative(product,args.path).replaceAll('\\','/');if(subjects.has(path))return {contents:execFileSync('git',['-C',product,'show',`${process.env.T192_UI_SUBJECT}:${path}`],{encoding:'utf8'}),loader:path.endsWith('tsx')?'tsx':'ts'}});
  }}]});
const css=await readFile(resolve(dirname(require.resolve('@xterm/xterm/package.json')),'css/xterm.css'),'utf8');
const html=`<!doctype html><meta charset="utf-8"><style>${css}\nbody{margin:12px;background:#1a1810;color:#d4c89a;font:14px Verdana}header{padding:10px;border:1px solid #75663d;width:680px}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.h-full{height:100%}.overflow-hidden{overflow:hidden}[role=menu]{background:#302a1a;border:1px solid #75663d;padding:4px}[role=menuitem]{display:flex;padding:4px;gap:6px}[aria-disabled=true]{opacity:.45}[data-highlighted]{background:#78622f}svg{height:16px;width:16px}</style><div id="root"></div><script src="/fixture.js"></script>`;
createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'application/javascript':'text/html; charset=utf-8');res.end(req.url==='/fixture.js'?result.outputFiles[0].contents:html)}).listen(4192,'127.0.0.1',()=>console.log('T192 fixture http://127.0.0.1:4192'));
