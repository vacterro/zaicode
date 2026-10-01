import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SUPPORTED_LOCALES, isLocale, resolveSupportedLocale, localeDirection } from "../../shared/src/locales.js";
import { localeSchema, appSettingsSchema } from "../../shared/src/validationAppSettings.js";
import { desktopMenuMessages } from "../../shared/src/desktopMenu.js";
import { MESSAGES } from "../src/i18n/messages.js";
import { resolveLocale, detectLocale, SUPPORTED_LOCALES as CLI_LOCALES } from "../../../apps/zcode-cli/packages/i18n/src/locale.js";
import { getZCodeCopy } from "../../../apps/zcode-cli/packages/i18n/src/index.js";

const EXPECTED = ["en-US", "ru-RU", "et-EE", "uk-UA", "ja-JP", "ded", "zh-CN", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "nl-NL", "pl-PL", "sv-SE", "da-DK", "fi-FI", "nb-NO", "ko-KR", "th-TH", "vi-VN", "ar-SA", "he-IL", "tr-TR", "hi-IN", "id-ID", "el-GR", "cs-CZ", "ro-RO", "hu-HU", "bg-BG", "sk-SK", "hr-HR"];
const tokens = (value: string) => [...value.matchAll(/\$\{[^}]+\}|\{\{[^}]+\}\}|\{\w+\}/g)].map(match=>match[0]).sort();

test("complete collected catalogs match all 32 languages and the DED voice", () => {
  assert.deepEqual([...SUPPORTED_LOCALES], EXPECTED);
  assert.deepEqual([...CLI_LOCALES], EXPECTED);
  assert.deepEqual(Object.keys(MESSAGES).sort(), [...EXPECTED].sort());
  const source = MESSAGES["en-US"];
  assert.equal(Object.keys(source).length, 5880, "includes Unicode severity keys, 27 SAIASUI strings, four T-141 model controls and the T-167 quota-hold route line");
  for (const locale of SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), Object.keys(source).sort(), locale);
    for (const [key, value] of Object.entries(source)) {
      assert.deepEqual(tokens(MESSAGES[locale][key]!), tokens(value), `${locale}/${key}`);
    }
    const file = join(import.meta.dirname, "../src/i18n/locales", `${locale}.ts`);
    const keys = [...readFileSync(file,"utf8").matchAll(/^\s*"([^"\s]+)":/gm)].map(match=>match[1]);
    assert.equal(new Set(keys).size, keys.length, `${locale}: duplicate literal keys`);
  }
});

test("preferences accept every catalog and retain explicit validation for unknown input", () => {
  for (const locale of SUPPORTED_LOCALES) {
    assert.ok(isLocale(locale));
    assert.equal(localeSchema.parse(locale),locale);
    const settings = appSettingsSchema.parse({ locale, localePreference: locale });
    assert.equal(settings.locale,locale);
    assert.equal(settings.localePreference,locale);
  }
  for (const value of [undefined,null,"ru","xx-XX","",{},"DED"]) assert.equal(isLocale(value),false);
  assert.equal(localeSchema.safeParse("xx-XX").success,false);
});

test("system and CLI detection resolve natural-language tags without choosing a voice", () => {
  for (const [input, expected] of [["ru_RU","ru-RU"],["et-EE","et-EE"],["pt-PT","pt-BR"],["de-AT","de-DE"],["zh-Hant-TW","zh-CN"],["no-NO","nb-NO"],["he","he-IL"],["ja","ja-JP"]]) {
    assert.equal(resolveSupportedLocale(input),expected);
    assert.equal(resolveLocale("auto",input),expected);
  }
  assert.equal(detectLocale({env:{LC_ALL:"de_DE.UTF-8",LANG:"ru_RU"}}),"de-DE");
  assert.equal(detectLocale({env:{LANGUAGE:"xx:ja_JP"}}),"ja-JP");
  assert.equal(resolveLocale("xx-XX"),"en-US");
  assert.equal(resolveSupportedLocale("ru"),"ru-RU");
  assert.equal(localeDirection("ar-SA"),"rtl");
  assert.equal(localeDirection("he-IL"),"rtl");
  assert.equal(localeDirection("et-EE"),"ltr");
  assert.equal(localeDirection("ded"),"ltr");
});

test("native menus retain every translated label and interpolation", () => {
  const source=desktopMenuMessages["en-US"];
  for(const locale of SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(desktopMenuMessages[locale]).sort(),Object.keys(source).sort(),locale);
    for(const key of Object.keys(source) as Array<keyof typeof source>) assert.deepEqual(tokens(desktopMenuMessages[locale][key]),tokens(source[key]),`${locale}/${key}`);
  }
});

test("CLI catalogs preserve dynamic values and both plural/retry branches", () => {
  for(const locale of SUPPORTED_LOCALES) {
    const copy=getZCodeCopy(locale);
    assert.equal(copy.locale,locale);
    assert.ok(copy.cli.help("VERSION_MARKER").includes("VERSION_MARKER"),locale);
    assert.ok(copy.cli.help("VERSION_MARKER").includes("--locale"),locale);
    assert.ok(copy.tui.model.requestFailed("ERROR_MARKER").includes("ERROR_MARKER"),locale);
    assert.ok(copy.tui.model.retryScheduled({attempt:2,maxAttempts:4,delay:"DELAY_MARKER",reason:"REASON_MARKER"}).includes("2/3"),locale);
    for(const count of [1,2]) {
      assert.ok(copy.tui.sidebar.mcp.tools(count).includes(String(count)),locale);
      assert.ok(copy.tui.input.queuedTitle(count).includes(String(count)),locale);
    }
    assert.ok(copy.tui.transcript.compact.retrying({attempt:2,maxAttempts:3}).includes("2/3"),locale);
    assert.ok(copy.tui.transcript.compact.retrying({attempt:2,maxAttempts:0}).length>0,locale);
  }
});
