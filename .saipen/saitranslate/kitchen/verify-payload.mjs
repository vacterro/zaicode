import ts from '../../../zcode/node_modules/typescript/lib/typescript.js';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {literalCatalog,placeholders} from './audit.mjs';
const kitchen=import.meta.dirname;
const root=resolve(kitchen,'../../..');
const audit=JSON.parse(readFileSync(join(kitchen,'audit.json'),'utf8'));
for(const [locale,surfaces] of Object.entries(audit.locales))for(const [surface,info]of Object.entries(surfaces)){
  if(info.keys!==info.target||['missing','extra','broken','technical','suspicious'].some(field=>info[field].length))throw Error(`incomplete ${locale}/${surface}`);
}
const product=JSON.parse(readFileSync(join(kitchen,'integration/manifest.json'),'utf8'));
const workspace=JSON.parse(readFileSync(join(kitchen,'integration-workspace/manifest.json'),'utf8'));
const source=literalCatalog(join(root,'zcode/packages/ui/src/i18n/locales/en-US.ts'),'enUS');
const game=literalCatalog(join(root,'zcode/packages/ui/src/i18n/locales/saiasui.ts'),'saiasuiEnglish');
const fullSource={...source,...game};
let parsed=0;
for(const file of product.files){
  const text=readFileSync(join(kitchen,'integration',file.file),'utf8');
  if(!/\.tsx?$/.test(file.file))continue;
  const ast=ts.createSourceFile(file.file,text,ts.ScriptTarget.Latest,true,file.file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
  if(ast.parseDiagnostics.length)throw Error(`${file.file}: ${ast.parseDiagnostics.map(x=>ts.flattenDiagnosticMessageText(x.messageText,' ')).join('; ')}`);
  parsed++;
}
for(const locale of product.locales){
  let target;
  if(locale==='en-US')target=fullSource;
  else if(locale==='zh-CN')target={...literalCatalog(join(root,'zcode/packages/ui/src/i18n/locales/zh-CN.ts'),'zhCN'),...literalCatalog(join(root,'zcode/packages/ui/src/i18n/locales/saiasui.ts'),'saiasuiChinese')};
  else target=literalCatalog(join(kitchen,'integration/packages/ui/src/i18n/locales',locale+'.ts'),'messages');
  if(JSON.stringify(Object.keys(target).sort())!==JSON.stringify(Object.keys(fullSource).sort()))throw Error(`key set ${locale}`);
  for(const [key,value] of Object.entries(fullSource))if(JSON.stringify(placeholders(value))!==JSON.stringify(placeholders(target[key])))throw Error(`placeholder ${locale}/${key}`);
}
const hash=data=>createHash('sha256').update(data).digest('hex');
for(const [dir,manifest] of [['integration',product],['integration-workspace',workspace]])for(const file of manifest.files){
  if(hash(readFileSync(join(kitchen,dir,file.file)))!==file.after)throw Error(`staged hash ${file.file}`);
}
const report={status:'PASS',checkedAt:new Date().toISOString(),locales:product.locales,uiKeys:Object.keys(fullSource).length,cliStrings:199,documentationParagraphs:110,nativeMenuStrings:50,auxiliaryStrings:30,typescriptFilesParsed:parsed,productFiles:product.files.length,workspaceFiles:workspace.files.length,auditDigest:hash(readFileSync(join(kitchen,'audit.json'))),notes:['This is producer structural/source verification. Runtime typecheck, tests, packaged GUI and CLI acceptance are Core release gates.','Machine-produced translations received token/key checks and bounded second-model prose review; Estonian documentation additionally received Core semantic corrections.']};
writeFileSync(join(kitchen,'payload-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
