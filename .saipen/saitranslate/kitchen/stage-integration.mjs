// Producer preparation writes only staged payload. Core applies it after canonical collection.
import ts from '../../../zcode/node_modules/typescript/lib/typescript.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sourceCatalog } from './audit.mjs';
const kitchen = import.meta.dirname;
const root = resolve(kitchen, '../../..');
const repo = join(root, 'zcode');
const stage = join(kitchen, 'integration');
const files = [];
const hash = text => createHash('sha256').update(text).digest('hex');
const locales = [...readFileSync(join(kitchen, 'locale-registry.ts'),'utf8').split('] as const;')[0].matchAll(/"([a-z]{2}-[A-Z]{2}|ded)"/g)].map(match=>match[1]);
const quoted = locales.map(locale=>JSON.stringify(locale)).join(', ');
const localeHelp = text => text.replace(/en-US[^\n]{1,12}?zh-CN/g,locales.join(', '));
function output(file, text) {
  const path = join(stage, file);
  mkdirSync(resolve(path, '..'), {recursive:true});
  writeFileSync(path,text);
  files.push({file, before:existsSync(join(repo,file)) ? hash(readFileSync(join(repo,file))) : null, after:hash(text)});
}
function replace(text, before, after) {
  if (!text.includes(before)) throw new Error(`missing integration anchor ${before.slice(0,100)}`);
  return text.replace(before, after);
}
function edit(file, fn) { output(file, fn(readFileSync(join(repo,file),'utf8').replace(/\r\n/g,'\n'))); }
function sharedImport(text, names) {
  const source=ts.createSourceFile('source.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const node=source.statements.find(node=>ts.isImportDeclaration(node)&&node.moduleSpecifier.text==='@zcode/shared'&&!node.importClause?.isTypeOnly&&ts.isNamedImports(node.importClause?.namedBindings));
  if (!node) return `import { ${names.join(', ')} } from "@zcode/shared";\n`+text;
  const binding=node.importClause.namedBindings;
  const have=binding.elements.map(element=>element.name.text);
  const missing=names.filter(name=>!have.includes(name));
  const at=binding.getStart(source)+1;
  return text.slice(0,at)+' '+missing.join(', ')+(missing.length ? ',' : '')+text.slice(at);
}

output('packages/shared/src/locales.ts',readFileSync(join(kitchen,'locale-registry.ts'),'utf8'));
edit('packages/shared/src/protocol.ts', text => replace(text, 'export type Locale = "zh-CN" | "en-US";', 'export type Locale = import("./locales.js").SupportedLocale;'));
edit('packages/shared/src/index.ts',text=>text+'\nexport { SUPPORTED_LOCALES, LOCALE_NATIVE_NAMES, isLocale, resolveSupportedLocale, localeDirection } from "./locales.js";\n');
edit('packages/shared/src/validationAppSettings.ts',text=> {
  text='import { SUPPORTED_LOCALES } from "./locales.js";\n'+text;
  text=replace(text,'z.enum(["zh-CN", "en-US"])','z.enum(SUPPORTED_LOCALES)');
  return replace(text,'z.enum(["system", "zh-CN", "en-US"])','z.enum(["system", ...SUPPORTED_LOCALES])');
});
edit('packages/ui/src/i18n/IntlProvider.tsx',text=>{
  text=sharedImport(text,['isLocale','resolveSupportedLocale','localeDirection']);
  text=replace(text,'import zhCN from "./locales/zh-CN.js";\nimport enUS from "./locales/en-US.js";','import { MESSAGES } from "./messages.js";');
  text=text.replace(/\/\*\* 语言 → 翻译消息映射 \*\/\s*const MESSAGES:[\s\S]*?\n};\s*/,'');
  text=text.replace(/function isLocale\(value: unknown\): value is Locale \{[\s\S]*?\n}\s*/,'');
  text=replace(text,'return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";','return resolveSupportedLocale(language) ?? "en-US";');
  text=replace(text,'  const intl = useMemo(() => createIntl(locale), [locale]);',`  useEffect(() => {
    // 语言与方向由同一个已解析 locale 驱动，离开 RTL 时必须恢复 LTR。
    document.documentElement.lang = locale === "ded" ? "ru" : locale;
    document.documentElement.dir = localeDirection(locale);
  }, [locale]);

  const intl = useMemo(() => createIntl(locale), [locale]);`);
  return text;
});
output('packages/ui/src/i18n/LocaleSwitcher.tsx',readFileSync(join(kitchen,'LocaleSwitcher.tsx'),'utf8'));
edit('packages/ui/src/settingsPageHelpers.tsx',text=>{
  text=sharedImport(text,['SUPPORTED_LOCALES','LOCALE_NATIVE_NAMES']);
  const begin=text.indexOf('                <SelectItem\n                  value="zh-CN"');
  const end=text.indexOf('              </SelectContent>',begin);
  if(begin<0||end<0)throw new Error('settings locale options anchor missing');
  text=text.slice(0,begin)+`                {SUPPORTED_LOCALES.map((tag) => (
                  <SelectItem key={tag} value={tag} data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, tag)}>
                    {LOCALE_NATIVE_NAMES[tag]}
                  </SelectItem>
                ))}
`+text.slice(end);
  text=replace(text,'{intl.formatMessage({ id: `settings.locale.${localePreference}` })}', '{localePreference === "system" ? intl.formatMessage({ id: "settings.locale.system" }) : LOCALE_NATIVE_NAMES[localePreference]}');
  return replace(text,'className="w-[260px] min-w-0 justify-between"','className="w-[260px] max-w-full min-w-0 justify-between"');
});
for(const file of ['packages/ui/src/SettingsPage.tsx','packages/ui/src/WorkspaceSidebar.tsx']) {
  edit(file,text=>replace(sharedImport(text,['isLocale']),'value === "zh-CN" || value === "en-US"','isLocale(value)'));
}
edit('packages/ui/src/WorkspaceSidebarFooter.tsx',text=>{
  text=sharedImport(text,['SUPPORTED_LOCALES','LOCALE_NATIVE_NAMES']);
  const begin=text.indexOf('                  {(\n                    [\n                      ["system", "Auto"]');
  const end=text.indexOf('                </div>',begin);
  if(begin<0||end<0)throw new Error('inline locale anchor missing');
  text=text.slice(0,begin)+`                  <select
                    aria-label={intl.formatMessage({ id: "settings.locale" })}
                    value={localeMenuValue}
                    onChange={(event) => onLocaleChange(event.target.value)}
                    className="h-6 min-w-0 max-w-[180px] border border-border bg-background px-1 text-foreground"
                  >
                    <option value="system">{intl.formatMessage({ id: "settings.locale.system" })}</option>
                    {SUPPORTED_LOCALES.map((tag) => <option key={tag} value={tag}>{LOCALE_NATIVE_NAMES[tag]}</option>)}
                  </select>
`+text.slice(end);
  const start=text.indexOf('                  <DropdownMenuRadioItem value="en-US">');
  const last=text.indexOf('                </DropdownMenuRadioGroup>',start);
  if(start<0||last<0)throw new Error('sidebar locale submenu anchor missing');
  return text.slice(0,start)+`                  {SUPPORTED_LOCALES.map((tag) => (
                    <DropdownMenuRadioItem key={tag} value={tag}>{LOCALE_NATIVE_NAMES[tag]}</DropdownMenuRadioItem>
                  ))}
`+text.slice(last);
});
edit('packages/ui/src/ErrorBoundary.tsx',text=>{
  text=sharedImport(text,['isLocale','resolveSupportedLocale']);
  text=replace(text,'import zhCN from "@/i18n/locales/zh-CN.js";\nimport enUS from "@/i18n/locales/en-US.js";','import { MESSAGES } from "@/i18n/messages.js";');
  text=replace(text,'storedPreference === "zh-CN" || storedPreference === "en-US"','isLocale(storedPreference)');
  text=replace(text,'return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";','return resolveSupportedLocale(navigator.language) ?? "en-US";');
  return replace(text,'const messages = locale === "en-US" ? enUS : zhCN;','const messages = MESSAGES[locale];');
});
edit('packages/desktop/src/main/desktopApplicationMenu.ts',text=>replace(sharedImport(text,['resolveSupportedLocale']),'return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";','return resolveSupportedLocale(systemLocale) ?? "en-US";'));
edit('apps/zcode-cli/packages/contracts/src/config/index.ts',text=>replace(text,'export type SupportedLocale = "en-US" | "zh-CN";',`export const CLI_SUPPORTED_LOCALES = [${quoted}] as const;\nexport type SupportedLocale = (typeof CLI_SUPPORTED_LOCALES)[number];`));
edit('apps/zcode-cli/packages/shared-types/src/index.ts',text=>replace(text,'export type GlobalLocale = "auto" | "en-US" | "zh-CN";',`export type GlobalLocale = "auto" | ${locales.map(locale=>JSON.stringify(locale)).join(' | ')};`));
edit('apps/zcode-cli/packages/adapters/src/config/schema.ts',text=>{
  text='import { CLI_SUPPORTED_LOCALES } from "@zcode/contracts";\n'+text;
  return replace(text,'z.enum(["auto", "en-US", "zh-CN"])','z.enum(["auto", ...CLI_SUPPORTED_LOCALES])');
});
edit('apps/zcode-cli/packages/i18n/src/locale.ts',text=>{
  text='import { CLI_SUPPORTED_LOCALES } from "@zcode/contracts";\n'+text;
  text=replace(text,'["en-US", "zh-CN"] as const satisfies readonly SupportedLocale[]','CLI_SUPPORTED_LOCALES');
  text=replace(text,'return value === "en-US" || value === "zh-CN";','return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);');
  text=replace(text,'  if (lower === "en" || lower.startsWith("en-")) return "en-US";\n  if (lower === "zh" || lower.startsWith("zh-")) return "zh-CN";',`  const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === lower);
  if (exact) return exact;
  const language = lower.split("-")[0];
  if (language === "no" || language === "nn") return "nb-NO";
  const supported = SUPPORTED_LOCALES.find((locale) => locale !== "ded" && locale.split("-")[0] === language);
  if (supported) return supported;`);
  return text;
});

if(!process.argv.includes('--structure')) {
  // Refuse partial catalogs rather than filling gaps with the source language.
  const sourceFile=readFileSync(join(repo,'packages/ui/src/i18n/locales/en-US.ts'),'utf8');
  const sourceKeys=Object.keys(sourceCatalog());
  const extrasSource=JSON.parse(readFileSync(join(kitchen,'extras/source.json'),'utf8'));
  const messages=[];
  const menus=[];
  const copies=[];
  for(const [index,locale] of locales.entries()) {
    const name=`locale${index}`;
    messages.push(`import ${name} from "./locales/${locale}.js";`);
    copies.push(`import { ${locale==='en-US'?'enUS':locale==='zh-CN'?'zhCN':'copy'} as ${name} } from "./locales/${locale}.js";`);
    if(locale==='en-US') continue;
    const extra=JSON.parse(readFileSync(join(kitchen,'extras/drafts',`${locale}.json`),'utf8'));
    if(Object.keys(extra).length!==Object.keys(extrasSource).length)throw new Error(`incomplete ${locale} extras`);
    menus.push(`${JSON.stringify(locale)}: ${JSON.stringify(Object.fromEntries(Object.entries(extra).filter(([key])=>key.startsWith('native.')).map(([key,value])=>[key.slice(7),value])),null,2)}`);
    if(locale!=='zh-CN') {
      const ui=JSON.parse(readFileSync(join(kitchen,'drafts',`${locale}.json`),'utf8'));
      if(sourceKeys.some(key=>!(key in ui))||Object.keys(ui).length!==sourceKeys.length)throw new Error(`incomplete ${locale} UI`);
      const game=Object.fromEntries(Object.entries(extra).filter(([key])=>key.startsWith('saiasui.')));
      output(`packages/ui/src/i18n/locales/${locale}.ts`,`/** Complete collected translation; source binding is recorded in locale-manifest.json. */\nconst messages: Record<string,string> = ${JSON.stringify({...ui,...game},null,2)};\nexport default messages;\n`);
      output(`apps/zcode-cli/packages/i18n/src/locales/${locale}.ts`,localeHelp(readFileSync(join(kitchen,'payload',locale,'cli.ts'),'utf8')));
    }
  }
  for(const locale of ['en-US','zh-CN'])edit(`apps/zcode-cli/packages/i18n/src/locales/${locale}.ts`,localeHelp);
  output('packages/ui/src/i18n/messages.ts',`import type { Locale } from "@zcode/shared";\n${messages.join('\n')}\nexport const MESSAGES: Record<Locale, Record<string,string>> = {\n${locales.map((locale,index)=>`${JSON.stringify(locale)}: locale${index}`).join(',\n')}\n};\n`);
  output('packages/shared/src/expandedDesktopMenuMessages.ts',`/** Native menu translations collected with the UI catalogs. */\nexport const expandedDesktopMenuMessages = {\n${menus.join(',\n')}\n};\n`);
  const auxiliaries=Object.fromEntries(locales.map(locale=>[locale,Object.fromEntries(Object.entries(locale==='en-US'?extrasSource:JSON.parse(readFileSync(join(kitchen,'extras/drafts',`${locale}.json`),'utf8'))).filter(([key])=>key.startsWith('aux.')).map(([key,value])=>[key.slice(4),value]))]));
  output('packages/shared/src/auxiliaryLocaleMessages.ts',`import type { Locale } from "./protocol.js";\nconst messages: Record<Locale, Record<string,string>> = ${JSON.stringify(auxiliaries,null,2)};\nexport function getLocalizedAuxiliaryMessage(locale: Locale, key: string): string | undefined { return messages[locale]?.[key]; }\n`);
  // Keep existing source-language text and the external website's two routes.
  edit('packages/shared/src/index.ts',text=>text+'\nexport { SUPPORTED_LOCALES, LOCALE_NATIVE_NAMES, isLocale, resolveSupportedLocale, localeDirection } from "./locales.js";\nexport { getLocalizedAuxiliaryMessage } from "./auxiliaryLocaleMessages.js";\n');
  edit('packages/shared/src/conversation-share.ts',text=>replace(replace(text,'Readonly<Record<Locale, string>>','Readonly<Partial<Record<Locale, string>>>'),'${CONVERSATION_SHARE_LOCALE_PATH_PREFIX[locale]}','${CONVERSATION_SHARE_LOCALE_PATH_PREFIX[locale] ?? ""}'));
  edit('packages/desktop/src/main/desktopFinderOpenFolderWorkflow.ts',text=>{
    text=sharedImport(text,['getLocalizedAuxiliaryMessage']);
    text=replace(text,'Record<Locale, string>','Partial<Record<Locale, string>>');
    return replace(text,'SERVICES_MENU_LABELS[locale] ?? SERVICES_MENU_LABELS["en-US"]','SERVICES_MENU_LABELS[locale] ?? getLocalizedAuxiliaryMessage(locale, "platform.openZCode") ?? "Open in ZCode"');
  });
  edit('packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.ts',text=>{
    text=sharedImport(text,['getLocalizedAuxiliaryMessage']).replaceAll('Record<Locale, string>','Partial<Record<Locale, string>>');
    return replace(text,'labels[locale] ?? labels["en-US"]','labels[locale] ?? getLocalizedAuxiliaryMessage(locale, isZaicodeProductMode() ? "platform.openZAICODE" : "platform.openZCode") ?? "Open in ZCode"');
  });
  edit('packages/services/src/conversation-share/conversationShareService.ts',text=>{
    text=sharedImport(text,['getLocalizedAuxiliaryMessage']).replaceAll('Readonly<Record<Locale, string>>','Readonly<Partial<Record<Locale, string>>>');
    return text.replace(/IMPORTED_SHARE_TITLE_PREFIX\[locale \?\? "zh-CN"\]/g,'(IMPORTED_SHARE_TITLE_PREFIX[locale ?? "zh-CN"] ?? getLocalizedAuxiliaryMessage(locale ?? "zh-CN", "share.importedPrefix") ?? "From Share: ")');
  });
  edit('packages/ui/src/lib/builtinSkillI18n.ts',text=>{
    text=sharedImport(text,['getLocalizedAuxiliaryMessage']);
    text=replace(text,'Record<string, Record<Locale, string>>','Record<string, Partial<Record<Locale, string>>>');
    text=replace(text,'  if (scope === "workspace") return "Workspace";', '  const translated = locale ? getLocalizedAuxiliaryMessage(locale, `skillScope.${scope}`) : undefined;\n  if (translated) return translated;\n  if (scope === "workspace") return "Workspace";');
    return replace(text,'BUILTIN_SKILL_DESCRIPTIONS[skill.name]?.[locale ?? "en-US"]','(BUILTIN_SKILL_DESCRIPTIONS[skill.name]?.[locale ?? "en-US"] ?? getLocalizedAuxiliaryMessage(locale ?? "en-US", `skill.${skill.name}`))');
  });
  edit('packages/ui/src/test-actions.ts',text=>'import type { Locale } from "@zcode/shared";\n'+text.replaceAll('"zh-CN" | "en-US"','Locale'));
  edit('packages/ui/src/feedback/feedbackSubmitSubmission.ts',text=>{
    text='import type { Locale } from "@zcode/shared";\n'+replace(text,'locale: "zh-CN" | "en-US";','locale: Locale;');
    return replace(text,'      locale,','      locale: locale === "zh-CN" ? "zh-CN" : "en-US",');
  });
  edit('apps/zcode-cli/packages/cli/src/cli-types.ts',text=>replace(text,'Promise<{ locale: "en-US" | "zh-CN" }>','Promise<{ locale: Exclude<UiLocale, "auto"> }>'));
  edit('packages/shared/src/zcode-slash-command-help.ts',text=>replace(text,'/locale [auto|en-US|zh-CN]','/locale [auto|language-tag]'));
  edit('packages/shared/src/desktopMenu.ts',text=>{
    text='import { expandedDesktopMenuMessages } from "./expandedDesktopMenuMessages.js";\n'+text;
    return replace(text,'export const desktopMenuMessages: Record<Locale, DesktopMenuLocaleMessages> = {','export const desktopMenuMessages: Record<Locale, DesktopMenuLocaleMessages> = {\n  ...expandedDesktopMenuMessages,');
  });
  edit('apps/zcode-cli/packages/i18n/src/index.ts',text=>{
    text=text.replace('import { enUS } from "./locales/en-US.js";\nimport { zhCN } from "./locales/zh-CN.js";',copies.join('\n'));
    return text.replace(/const CATALOGS: Record<SupportedLocale, ZCodeCopy> = \{[\s\S]*?\n};/,`const CATALOGS: Record<SupportedLocale, ZCodeCopy> = {\n${locales.map((locale,index)=>`${JSON.stringify(locale)}: locale${index}`).join(',\n')}\n};`);
  });
  const audit=JSON.parse(readFileSync(join(kitchen,'audit.json'),'utf8'));
  output('packages/ui/src/i18n/locale-manifest.json',JSON.stringify({schema_version:1,locales,source:{ui:audit.sources.ui,extras:audit.sources.extras,cli:audit.sources.cli},verification:'Exact source key/placeholder/technical token coverage; generated catalogs must pass zaicodeLocaleParity.test.ts before release.'},null,2)+'\n');
}
output('packages/ui/test/zaicodeLocaleParity.test.ts',readFileSync(join(kitchen,'zaicodeLocaleParity.test.ts'),'utf8'));
writeFileSync(join(stage,'manifest.json'),JSON.stringify({locales,files:[...new Map(files.map(file=>[file.file,file])).values()]},null,2)+'\n');
console.log(`staged ${files.length} product files; main tree untouched`);
