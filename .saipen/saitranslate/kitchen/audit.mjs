import ts from '../../../zcode/node_modules/typescript/lib/typescript.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { technicalTokens, suspiciousTranslation } from './tokens.mjs';
export { technicalTokens } from './tokens.mjs';
const root=resolve(import.meta.dirname,'../../..');
const kitchen=import.meta.dirname;
const hash=value=>createHash('sha256').update(value).digest('hex');
export function literalCatalog(file,objectName) {
  const text=readFileSync(file,'utf8');
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  let catalog;
  function visit(node) {
    if(node.name?.getText(source).replace(/^"|"$/g,'')===objectName&&node.initializer&&ts.isObjectLiteralExpression(node.initializer)) {
      catalog={};
      for(const property of node.initializer.properties) {
        if(ts.isSpreadAssignment(property))continue;
        if(!ts.isPropertyAssignment(property)||!ts.isStringLiteral(property.initializer))throw new Error(`nonliteral ${file}`);
        const key=property.name.text??property.name.getText(source);
        if(key in catalog)throw new Error(`duplicate ${file}/${key}`);
        catalog[key]=property.initializer.text;
      }
      return;
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
  if(!catalog)throw new Error(`missing ${objectName}`);
  return catalog;
}
export const placeholders=value=>[...value.matchAll(/\$\{[^}]+\}|\{\{[^}]+\}\}|\{\w+\}/g)].map(match=>match[0]).sort();
export function sourceCatalog() { return literalCatalog(join(root,'zcode/packages/ui/src/i18n/locales/en-US.ts'),'enUS'); }
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'))) {
  const locales=[...readFileSync(join(kitchen,'locale-registry.ts'),'utf8').split('] as const;')[0].matchAll(/"([a-z]{2}-[A-Z]{2}|ded)"/g)].map(match=>match[1]).filter(locale=>locale!=='en-US');
  const sources={ui:sourceCatalog(),cli:JSON.parse(readFileSync(join(kitchen,'cli/source.json'),'utf8')),docs:JSON.parse(readFileSync(join(kitchen,'docs/source.json'),'utf8')),extras:JSON.parse(readFileSync(join(kitchen,'extras/source.json'),'utf8'))};
  const report={checkedAt:new Date().toISOString(),sources:Object.fromEntries(Object.entries(sources).map(([surface,source])=>[surface,{keys:Object.keys(source).length,digest:hash(JSON.stringify(source))}])),locales:{}};
  let failures=0;
  for(const locale of locales) {
    const info={};
    for(const [surface,source] of Object.entries(sources)) {
      if(surface==='ui'&&locale==='zh-CN')continue;
      const dir=surface==='ui'?kitchen:join(kitchen,surface);
      const path=join(dir,'drafts',`${locale}.json`);
      const draft=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
      const missing=Object.keys(source).filter(key=>!(key in draft));
      const extra=Object.keys(draft).filter(key=>!(key in source));
      const broken=[];
      const technical=[];
      const suspicious=[];
      for(const [key,value] of Object.entries(draft)) {
        if(!(key in source))continue;
        if(typeof value!=='string'||placeholders(source[key]).join('|')!==placeholders(value).join('|'))broken.push(key);
        if(technicalTokens(source[key]).some(token=>!value.includes(token)))technical.push(key);
        if(suspiciousTranslation(source[key],value))suspicious.push(key);
      }
      info[surface]={keys:Object.keys(draft).length,target:Object.keys(source).length,missing,extra,broken,technical,suspicious,digest:hash(JSON.stringify(draft))};
      if(missing.length||extra.length||broken.length||technical.length||suspicious.length)failures++;
    }
    report.locales[locale]=info;
    console.log(`${locale}: `+Object.entries(info).map(([surface,v])=>`${surface} ${v.keys}/${v.target} bad=${v.broken.length} tokens=${v.technical.length} short=${v.suspicious.length}`).join(', '));
  }
  writeFileSync(join(kitchen,'audit.json'),JSON.stringify(report,null,2)+'\n');
  process.exitCode=failures?1:0;
}
