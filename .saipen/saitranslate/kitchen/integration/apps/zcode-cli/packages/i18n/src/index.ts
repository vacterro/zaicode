import type { UiLocale, SupportedLocale } from "@zcode/contracts";
import { enUS as locale0 } from "./locales/en-US.js";
import { copy as locale1 } from "./locales/ru-RU.js";
import { copy as locale2 } from "./locales/et-EE.js";
import { copy as locale3 } from "./locales/uk-UA.js";
import { copy as locale4 } from "./locales/ja-JP.js";
import { copy as locale5 } from "./locales/ded.js";
import { zhCN as locale6 } from "./locales/zh-CN.js";
import { copy as locale7 } from "./locales/de-DE.js";
import { copy as locale8 } from "./locales/fr-FR.js";
import { copy as locale9 } from "./locales/es-ES.js";
import { copy as locale10 } from "./locales/it-IT.js";
import { copy as locale11 } from "./locales/pt-BR.js";
import { copy as locale12 } from "./locales/nl-NL.js";
import { copy as locale13 } from "./locales/pl-PL.js";
import { copy as locale14 } from "./locales/sv-SE.js";
import { copy as locale15 } from "./locales/da-DK.js";
import { copy as locale16 } from "./locales/fi-FI.js";
import { copy as locale17 } from "./locales/nb-NO.js";
import { copy as locale18 } from "./locales/ko-KR.js";
import { copy as locale19 } from "./locales/th-TH.js";
import { copy as locale20 } from "./locales/vi-VN.js";
import { copy as locale21 } from "./locales/ar-SA.js";
import { copy as locale22 } from "./locales/he-IL.js";
import { copy as locale23 } from "./locales/tr-TR.js";
import { copy as locale24 } from "./locales/hi-IN.js";
import { copy as locale25 } from "./locales/id-ID.js";
import { copy as locale26 } from "./locales/el-GR.js";
import { copy as locale27 } from "./locales/cs-CZ.js";
import { copy as locale28 } from "./locales/ro-RO.js";
import { copy as locale29 } from "./locales/hu-HU.js";
import { copy as locale30 } from "./locales/bg-BG.js";
import { copy as locale31 } from "./locales/sk-SK.js";
import { copy as locale32 } from "./locales/hr-HR.js";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
import type { ZCodeCopy } from "./types.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
};
export type { LocaleDetectionInput } from "./locale.js";
export type { CliCopy, TuiCopy, UiLocale, SupportedLocale, ZCodeCopy } from "./types.js";

const CATALOGS: Record<SupportedLocale, ZCodeCopy> = {
"en-US": locale0,
"ru-RU": locale1,
"et-EE": locale2,
"uk-UA": locale3,
"ja-JP": locale4,
"ded": locale5,
"zh-CN": locale6,
"de-DE": locale7,
"fr-FR": locale8,
"es-ES": locale9,
"it-IT": locale10,
"pt-BR": locale11,
"nl-NL": locale12,
"pl-PL": locale13,
"sv-SE": locale14,
"da-DK": locale15,
"fi-FI": locale16,
"nb-NO": locale17,
"ko-KR": locale18,
"th-TH": locale19,
"vi-VN": locale20,
"ar-SA": locale21,
"he-IL": locale22,
"tr-TR": locale23,
"hi-IN": locale24,
"id-ID": locale25,
"el-GR": locale26,
"cs-CZ": locale27,
"ro-RO": locale28,
"hu-HU": locale29,
"bg-BG": locale30,
"sk-SK": locale31,
"hr-HR": locale32
};

export function getZCodeCopy(locale?: UiLocale | string, detected?: string | null): ZCodeCopy {
  return CATALOGS[resolveLocale(locale, detected)];
}
