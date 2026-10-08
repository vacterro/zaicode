const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../../zcode');
const {register}=createRequire(path.join(root,'package.json'))('tsx/cjs/api');register();
const starter=require(path.join(root,'packages/desktop/src/main/zaicodeWindowStarter.ts'));
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'t268-claude-wire-'));
const requests=[];
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;let body={};try{body=JSON.parse(raw)}catch{}
 requests.push({path:req.url,max_tokens:body.max_tokens,thinking:body.thinking,tools:body.tools?.length,model:body.model});
 if(req.url.startsWith('/v1/messages/count_tokens')){res.setHeader('content-type','application/json');res.end('{"input_tokens":10}');return;}
 if(!req.url.startsWith('/v1/messages')){res.setHeader('content-type','application/json');res.end('{}');return;}
 if(![1,8].includes(body.max_tokens)){res.writeHead(400,{'content-type':'application/json'});res.end('{"error":{"type":"invalid_request_error","message":"probe cap missing"}}');return;}
 const stop=process.env.T268_WIRE_STOP||'end_turn';
 const msg={id:'msg_fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'ok'}],stop_reason:stop,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}};
 if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(msg));return;}
 res.setHeader('content-type','text/event-stream');
 for(const [event,data] of [
  ['message_start',{type:'message_start',message:{...msg,content:[],stop_reason:null,usage:{input_tokens:10,output_tokens:0}}}],
  ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
  ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ok'}}],
  ['content_block_stop',{type:'content_block_stop',index:0}],
  ['message_delta',{type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:1}}],
  ['message_stop',{type:'message_stop'}],
 ])res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');res.end();
});
(async()=>{server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const env={...process.env,...starter.claudeWindowStartEnv(),...(process.env.T268_WIRE_OUTPUT?{CLAUDE_CODE_MAX_OUTPUT_TOKENS:process.env.T268_WIRE_OUTPUT}:{}),CLAUDE_CONFIG_DIR:folder,ANTHROPIC_API_KEY:'fixture-not-a-real-key',ANTHROPIC_BASE_URL:'http://127.0.0.1:'+server.address().port,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_ENABLE_TELEMETRY:'0'};
 delete env.CLAUDE_CODE_OAUTH_TOKEN;delete env.ANTHROPIC_AUTH_TOKEN;
 const child=spawn('C:/Users/vac34/.local/bin/claude.exe',starter.claudeWindowStartArgs(),{cwd:folder,env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stdin.end();
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const timeout=setTimeout(()=>child.kill(),25000);const exit=await new Promise(r=>child.once('exit',r));clearTimeout(timeout);server.close();
 const modelRequests=requests.filter(r=>r.path.startsWith('/v1/messages')&&!r.path.includes('count_tokens'));
 const outcome=starter.readClaudeWindowStart(exit===0,stdout,stderr);
 const pass=modelRequests.length===1&&modelRequests[0].max_tokens===Number(process.env.T268_WIRE_OUTPUT||starter.claudeWindowStartEnv().CLAUDE_CODE_MAX_OUTPUT_TOKENS)&&(!modelRequests[0].thinking||modelRequests[0].thinking.type==='disabled')&&(modelRequests[0].tools??0)===0&&outcome.ok;
 const receipt={pass,exit,requests,outcome,stdout,stderr,fixtureOnly:true,noVendorInference:true};fs.writeFileSync(path.join(__dirname,'T-268-claude-wire.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({...receipt,stdout:stdout.slice(-1000),stderr:stderr.slice(-300)}));if(!pass)process.exitCode=1;
})().catch(e=>{server.close();console.error(String(e));process.exitCode=1});
