// Bounded parallel transport for the CLI/doc producer; the ordinary runner remains the gate.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = import.meta.dirname;
const locales = ['ru-RU','et-EE','ded','uk-UA','ja-JP','de-DE','fr-FR','es-ES','it-IT','pt-BR','nl-NL','pl-PL','sv-SE','da-DK','fi-FI','nb-NO','zh-CN','ko-KR','th-TH','vi-VN','ar-SA','he-IL','tr-TR','hi-IN','id-ID','el-GR','cs-CZ','ro-RO','hu-HU','bg-BG','sk-SK','hr-HR'];
const selectedSurfaces = process.argv.includes('--extras') ? ['extras'] : ['cli','docs'];
const pending = locales.flatMap(locale => selectedSurfaces.map(surface => ({ locale, surface })));
function count(surface, locale) {
  const path = join(root, surface, 'drafts', `${locale}.json`);
  return existsSync(path) ? Object.keys(JSON.parse(readFileSync(path, 'utf8'))).length : 0;
}
function run(locale, surface) {
  const env = { ...process.env, SAITRANSLATE_KITCHEN_DIR: join(root, surface), SAITRANSLATE_SOURCE_CATALOG: join(root, surface, 'source.json'), SAITRANSLATE_SURFACE_DESCRIPTION: surface === 'cli' ? 'the terminal UI and CLI help' : 'the user-facing documentation (preserve Markdown, HTML, links and command examples)' };
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(root,'produce.mjs'),locale,'--size',surface === 'docs' ? '10' : '40','--retries','5'], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    child.stdout.on('data', chunk => appendFileSync(join(root, 'surfaces.log'), chunk));
    child.stderr.on('data', chunk => appendFileSync(join(root, 'surfaces.log'), chunk));
    child.on('exit', code => resolve(code));
  });
}
async function worker() {
  while (pending.length) {
    const {locale,surface} = pending.shift();
    const target = Object.keys(JSON.parse(readFileSync(join(root,surface,'source.json'),'utf8'))).length;
    for (let attempt = 0; attempt < 3 && count(surface,locale) < target; attempt++) await run(locale,surface);
    appendFileSync(join(root,'surfaces.log'), `${new Date().toISOString()} ${surface}/${locale} completed ${count(surface,locale)}/${target}\n`);
  }
}
await Promise.all(Array.from({length:6},worker));
