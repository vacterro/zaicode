// Localized documents keep source commands and rebase relative links to their installed locations.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join,resolve,dirname,relative,posix} from 'node:path';
import {createHash} from 'node:crypto';
const kitchen=import.meta.dirname;
const root=resolve(kitchen,'../../..');
const stage=join(kitchen,'integration-workspace');
const audit=JSON.parse(readFileSync(join(kitchen,'audit.json'),'utf8'));
const locales=Object.keys(audit.locales);
const files=[];
const hash=data=>createHash('sha256').update(data).digest('hex');
function output(file,text){const target=join(stage,file);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,text);files.push({file,before:existsSync(join(root,file))?hash(readFileSync(join(root,file))):null,after:hash(text)});}
const docs=['README.md','docs/ZAICODE_INSTALL.md','docs/ZAICODE_SAIPEN_CLOUD.md'];
function links(text,source,target,locale){
  function rebase(link){
    if(/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(link))return link;
    const [path,anchor]=link.split('#');
    const sourcePath=posix.normalize(posix.join(posix.dirname(source),path));
    const localized=docs.includes(sourcePath)?`docs/locales/${locale}/${posix.basename(sourcePath)}`:sourcePath;
    const result=relative(dirname(target),localized).replaceAll('\\','/');
    return result+(anchor?'#'+anchor:'');
  }
  return text.replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g,(_,a,link,b)=>a+rebase(link)+b).replace(/((?:src|href)=")([^"\s]+)(")/g,(_,a,link,b)=>a+rebase(link)+b);
}
function nav(target){return ['en-US',...locales].map(locale=>{
  const destination=locale==='en-US'?'README.md':`docs/locales/${locale}/README.md`;
  return `[${locale}](${relative(dirname(target),destination).replaceAll('\\','/')})`;
}).join(' · ');}
for(const locale of locales)for(const source of docs){
  const target=`docs/locales/${locale}/${posix.basename(source)}`;
  const text=readFileSync(join(kitchen,'payload',locale,source),'utf8');
  output(target,links(text,source,target,locale));
}
for(const [locale,target]of [['et-EE','README.ee.md'],['ded','README.ded.md'],['ja-JP','README.ja.md']]){
  let text=links(readFileSync(join(kitchen,'payload',locale,'README.md'),'utf8'),'README.md',target,locale);
  text=text.replace(/^(# ZAICODE\r?\n)/,'$1\n'+nav(target)+'\n');
  output(target,text);
}
output('docs/locales/README.md','# ZAICODE languages\n\nComplete UI and CLI catalogs are selectable in Settings → Language or with `--locale <tag>`. DED is an explicit Russian voice. Arabic and Hebrew switch document direction to RTL.\n\n'+['en-US',...locales].map(locale=>`- [${locale}](${locale==='en-US'?'../../README.md':locale+'/README.md'})`).join('\n')+'\n\nEach locale also contains ZAICODE_INSTALL.md and ZAICODE_SAIPEN_CLOUD.md. Commands and URLs retain their source text; translated documents carry a normalized source digest.\n');
writeFileSync(join(stage,'manifest.json'),JSON.stringify({locales,files},null,2)+'\n');
console.log(`staged ${files.length} workspace documents`);
