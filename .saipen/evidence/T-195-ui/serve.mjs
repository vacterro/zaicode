import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
const here=import.meta.dirname,product=resolve(here,'../../../zcode');
const require=createRequire(resolve(product,'package.json'));
const {build}=require('esbuild');
const stubs={
  logger:'export const logger={debug:()=>{},info:()=>{},warn:()=>{},error:()=>{}};',
  message:'import React from "react"; export const MessageResponse=p=>React.createElement("div",null,p.children);',
  'code-block':'import React from "react"; export const CodeBlock=p=>React.createElement("pre",null,p.code);',
  ConversationRowView:'export const ConversationRowView=()=>null;',
};
const subjects=new Set(['packages/ui/src/ToolCallBlocks/renderers/switch-mode.tsx','packages/ui/src/v4/ConversationTurnRow.tsx']);
const result=await build({entryPoints:[resolve(here,'harness.tsx')],bundle:true,write:false,format:'iife',platform:'browser',absWorkingDir:product,
  nodePaths:[resolve(product,'node_modules'),resolve(product,'packages/ui/node_modules')],
  alias:{'@':resolve(product,'packages/ui/src'),react:dirname(require.resolve('react/package.json')),'react-dom':dirname(require.resolve('react-dom/package.json'))},
  define:{'process.env.NODE_ENV':'"development"','process.env.ZCODE_ZAICODE_MODE':'"1"'},
  plugins:[{name:'fixture-ports',setup(b){
    b.onResolve({filter:/\.js$/},args=>{const name=args.path.split('/').at(-1).slice(0,-3);if(name in stubs)return {path:name,namespace:'fixture'}});
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js'}));
    if(process.env.T195_UI_SUBJECT)b.onLoad({filter:/\.(ts|tsx)$/},args=>{const path=relative(product,args.path).replaceAll('\\','/');if(subjects.has(path))return {contents:execFileSync('git',['-C',product,'show',`${process.env.T195_UI_SUBJECT}:${path}`],{encoding:'utf8'}),loader:path.endsWith('tsx')?'tsx':'ts'}});
  }}]});
const html='<!doctype html><meta charset="utf-8"><style>body{margin:20px;background:#1a1810;color:#d4c89a;font:14px Verdana}button{margin:10px}section{border:1px solid #75663d;padding:10px}svg{height:16px;width:16px}</style><div id="root"></div><script src="/fixture.js"></script>';
createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'application/javascript':'text/html; charset=utf-8');res.end(req.url==='/fixture.js'?result.outputFiles[0].contents:html)}).listen(Number(process.env.T195_UI_PORT||4195),'127.0.0.1',()=>console.log('T195 fixture ready'));
