const fs=require('fs'),path=require('path');
const re=new RegExp(process.argv[2]);
const exts=/\.(ts|tsx)$/;
function walk(p,acc){const st=fs.statSync(p);if(st.isDirectory()){for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);if(e.isDirectory()){if(!/node_modules|[\/]dist/.test(q))walk(q,acc);}else if(exts.test(e.name))acc.push(q);}}else acc.push(p);return acc;}
const files=process.argv.slice(3).flatMap(r=>walk(r,[]));
for(const f of files){const t=fs.readFileSync(f,'utf8').split(/\r?\n/);t.forEach((l,i)=>{if(re.test(l))console.log(f.split(path.sep).join('/')+':'+(i+1)+': '+l.trim().slice(0,190));});}
