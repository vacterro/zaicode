// Extract CLI strings without evaluating code; preserve all original functions and expressions.
// Docs are paragraph catalogs, with code/URLs protected as exact interpolation tokens.
import ts from '../../../zcode/node_modules/typescript/lib/typescript.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = resolve(import.meta.dirname, '../../..');
const KITCHEN = import.meta.dirname;
const CLI = join(ROOT, 'zcode/apps/zcode-cli/packages/i18n/src/locales/en-US.ts');
const DOCS = ['README.md', 'docs/ZAICODE_INSTALL.md', 'docs/ZAICODE_SAIPEN_CLOUD.md'];
const digest = (text) => createHash('sha256').update(text).digest('hex');
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
function protectedText(text) {
  const tokens = [];
  const value = text.replace(/`[^`]+`|https?:\/\/[^\s)"<>]+|--[A-Za-z][\w-]*|\/[a-z][a-z-]*(?=[\s\[|,;.]|$)/g, (token) => {
    const placeholder = `{protected${tokens.length}}`;
    tokens.push(token);
    return placeholder;
  });
  return { value, tokens };
}
function cliEntries(text) {
  const source = ts.createSourceFile(CLI, text, ts.ScriptTarget.Latest, true);
  const entries = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'locale') return;
    if (ts.isImportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      let value;
      let expressions = [];
      if (ts.isTemplateExpression(node)) {
        expressions = node.templateSpans.map((span) => span.expression.getText(source));
        value = node.head.text + node.templateSpans.map((span, i) => `{expression${i}}${span.literal.text}`).join('');
      } else value = node.text;
      // Keys and string constants without language are not translated.
      if (node.parent.name === node || !/[A-Za-z]{2}/.test(value.replace(/\{expression\d+\}/g, ''))) return;
      const protectedValue = protectedText(value);
      entries.push({ key: `cli.s${String(entries.length + 1).padStart(4, '0')}`, start: node.getStart(source), end: node.end, value: protectedValue.value, tokens: protectedValue.tokens, expressions });
      if (ts.isTemplateExpression(node)) {
        node.templateSpans.forEach((span, expressionIndex) => {
          function nested(child) {
            if (ts.isStringLiteral(child) && /[A-Za-z]{2}/.test(child.text)) {
              entries.push({ key: `cli.s${String(entries.length + 1).padStart(4, '0')}`, parentStart: node.getStart(source), expressionIndex, start: child.getStart(source) - span.expression.getStart(source), end: child.end - span.expression.getStart(source), value: child.text, tokens: [], expressions: [] });
            } else ts.forEachChild(child, nested);
          }
          nested(span.expression);
        });
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return entries;
}
function literalCatalog(file, objectName) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let catalog;
  function visit(node) {
    const name = node.name?.getText(source).replace(/^"|"$/g, '');
    if (name === objectName && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      catalog = Object.fromEntries(node.initializer.properties.map(property => {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) throw new Error(`nonliteral catalog ${file}`);
        return [property.name.text ?? property.name.getText(source), property.initializer.text];
      }));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!catalog) throw new Error(`missing object ${objectName} in ${file}`);
  return { catalog, file, source_digest: digest(text) };
}
function auxiliaryCatalog() {
  const file='zcode/packages/ui/src/lib/builtinSkillI18n.ts';
  const text=readFileSync(join(ROOT,file),'utf8');
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const catalog={
    'aux.platform.openZCode':'Open in ZCode',
    'aux.platform.openZAICODE':'Open in ZAICODE',
    'aux.share.importedPrefix':'From Share: ',
    'aux.skillScope.workspace':'Workspace',
    'aux.skillScope.plugin':'Plugin',
    'aux.skillScope.user':'User',
  };
  function visit(node) {
    if(node.name?.getText(source)==='BUILTIN_SKILL_DESCRIPTIONS'&&node.initializer&&ts.isObjectLiteralExpression(node.initializer)) {
      for(const property of node.initializer.properties) {
        if(!ts.isPropertyAssignment(property)||!ts.isObjectLiteralExpression(property.initializer))throw new Error('unexpected builtin skill table');
        const english=property.initializer.properties.find(value=>value.name?.getText(source)==='"en-US"');
        if(!english||!ts.isStringLiteral(english.initializer))throw new Error('missing English builtin skill description');
        catalog[`aux.skill.${property.name.text??property.name.getText(source)}`]=english.initializer.text;
      }
      return;
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
  return { catalog, file, source_digest:digest(text) };
}
function docsEntries() {
  return DOCS.map((file) => {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const parts = text.split(/(\r?\n\s*\r?\n)/);
    let fenced = false;
    const entries = [];
    parts.forEach((part, index) => {
      const fenceCount = (part.match(/^```/gm) ?? []).length;
      const skip = fenced || fenceCount > 0;
      if (fenceCount % 2) fenced = !fenced;
      if (skip || !part.trim() || /^\s*</.test(part) || !/[A-Za-z]{2}/.test(part)) return;
      // An indented fenced command is an opaque source token, never model-written code.
      const result = /^ {1,3}```/m.test(part) ? { value: '{protected0}', tokens: [part] } : protectedText(part);
      entries.push({ key: `docs.${file.replace(/[^A-Za-z0-9]/g, '_')}.p${String(index).padStart(4, '0')}`, index, value: result.value, tokens: result.tokens });
    });
    return { file, source_digest: digest(text), parts, entries };
  });
}
function restore(value, entry) {
  entry.tokens.forEach((token, index) => { value = value.replaceAll(`{protected${index}}`, token); });
  return value;
}
const [command, locale] = process.argv.slice(2);
if (command === 'scan') {
  const cliText = readFileSync(CLI, 'utf8');
  const cli = cliEntries(cliText);
  const docs = docsEntries();
  for (const [surface, entries, manifest] of [
    ['cli', cli, { source_digest: digest(cliText), entries: cli }],
    ['docs', docs.flatMap((doc) => doc.entries), { docs }],
  ]) {
    const dir = join(KITCHEN, surface);
    mkdirSync(dir, { recursive: true });
    save(join(dir, 'source.json'), Object.fromEntries(entries.map((entry) => [entry.key, entry.value])));
    save(join(dir, 'manifest.json'), manifest);
    console.log(`${surface}: ${entries.length} source strings/paragraphs`);
  }
  const game = literalCatalog('zcode/packages/ui/src/i18n/locales/saiasui.ts', 'saiasuiEnglish');
  const native = literalCatalog('zcode/packages/shared/src/desktopMenu.ts', 'en-US');
  const auxiliary = auxiliaryCatalog();
  const extraDir = join(KITCHEN, 'extras');
  mkdirSync(extraDir, { recursive: true });
  save(join(extraDir, 'source.json'), { ...game.catalog, ...Object.fromEntries(Object.entries(native.catalog).map(([key,value]) => [`native.${key}`,value])), ...auxiliary.catalog });
  save(join(extraDir, 'manifest.json'), { sources: [game, native, auxiliary] });
  console.log(`extras: ${Object.keys(game.catalog).length} game + ${Object.keys(native.catalog).length} native menu + ${Object.keys(auxiliary.catalog).length} auxiliary strings`);
} else if (command === 'emit' && locale) {
  const cliDir = join(KITCHEN, 'cli');
  const docDir = join(KITCHEN, 'docs');
  const cliManifest = JSON.parse(readFileSync(join(cliDir, 'manifest.json'), 'utf8'));
  const source = readFileSync(CLI, 'utf8');
  if (digest(source) !== cliManifest.source_digest) throw new Error('CLI source changed; rescan and translate changes');
  const translations = JSON.parse(readFileSync(join(cliDir, 'drafts', `${locale}.json`), 'utf8'));
  let output = source;
  for (const entry of [...cliManifest.entries].reverse()) {
    if (entry.parentStart !== undefined) continue;
    if (typeof translations[entry.key] !== 'string') throw new Error(`missing ${locale} ${entry.key}`);
    let value = restore(translations[entry.key], entry);
    let replacement;
    if (entry.expressions.length) {
      value = value.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
      entry.expressions.forEach((expression, index) => {
        const nested = cliManifest.entries.filter((child) => child.parentStart === entry.start && child.expressionIndex === index);
        for (const child of nested.reverse()) {
          if (typeof translations[child.key] !== 'string') throw new Error(`missing ${child.key}`);
          expression = expression.slice(0, child.start) + JSON.stringify(translations[child.key]) + expression.slice(child.end);
        }
        value = value.replaceAll(`{expression${index}}`, '${' + expression + '}');
      });
      replacement = '`' + value + '`';
    } else replacement = JSON.stringify(value);
    output = output.slice(0, entry.start) + replacement + output.slice(entry.end);
  }
  output = output.replace('export const enUS:', 'export const copy:').replace('locale: "en-US"', `locale: ${JSON.stringify(locale)}`);
  const payload = join(KITCHEN, 'payload', locale);
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, 'cli.ts'), output);
  const docManifest = JSON.parse(readFileSync(join(docDir, 'manifest.json'), 'utf8'));
  const docTranslations = JSON.parse(readFileSync(join(docDir, 'drafts', `${locale}.json`), 'utf8'));
  for (const doc of docManifest.docs) {
    if (digest(readFileSync(join(ROOT, doc.file), 'utf8')) !== doc.source_digest) throw new Error(`${doc.file} changed`);
    const parts = [...doc.parts];
    for (const entry of doc.entries) {
      if (typeof docTranslations[entry.key] !== 'string') throw new Error(`missing ${locale} ${entry.key}`);
      parts[entry.index] = restore(docTranslations[entry.key], entry);
    }
    const path = join(payload, doc.file);
    mkdirSync(resolve(path, '..'), { recursive: true });
    const normalized = readFileSync(join(ROOT, doc.file), 'utf8').replace(/\d+\.\d+\.\d+[0-9A-Za-z]*/g, 'VERSION');
    writeFileSync(path, parts.join('') + `\n<!-- source-digest: ${doc.file} sha256:${digest(normalized).slice(0, 16)} -->\n`);
  }
  console.log(`emitted ${locale} CLI and docs in kitchen payload only`);
} else throw new Error('usage: node surfaces.mjs scan | emit <locale>');
