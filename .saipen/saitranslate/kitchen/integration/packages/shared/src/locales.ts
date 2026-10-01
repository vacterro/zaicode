/** Complete collected locale set; DED is an explicit voice, never an OS language. */
export const SUPPORTED_LOCALES = [
  "en-US", "ru-RU", "et-EE", "uk-UA", "ja-JP", "ded", "zh-CN", "de-DE",
  "fr-FR", "es-ES", "it-IT", "pt-BR", "nl-NL", "pl-PL", "sv-SE", "da-DK",
  "fi-FI", "nb-NO", "ko-KR", "th-TH", "vi-VN", "ar-SA", "he-IL", "tr-TR",
  "hi-IN", "id-ID", "el-GR", "cs-CZ", "ro-RO", "hu-HU", "bg-BG", "sk-SK", "hr-HR",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_NATIVE_NAMES: Record<SupportedLocale, string> = {
  "en-US": "🇺🇸 English", "ru-RU": "🇷🇺 Русский", "et-EE": "🇪🇪 Eesti",
  "uk-UA": "🇺🇦 Українська", "ja-JP": "🇯🇵 日本語", ded: "Дед",
  "zh-CN": "🇨🇳 中文简体", "de-DE": "🇩🇪 Deutsch", "fr-FR": "🇫🇷 Français",
  "es-ES": "🇪🇸 Español", "it-IT": "🇮🇹 Italiano", "pt-BR": "🇧🇷 Português",
  "nl-NL": "🇳🇱 Nederlands", "pl-PL": "🇵🇱 Polski", "sv-SE": "🇸🇪 Svenska",
  "da-DK": "🇩🇰 Dansk", "fi-FI": "🇫🇮 Suomi", "nb-NO": "🇳🇴 Norsk bokmål",
  "ko-KR": "🇰🇷 한국어", "th-TH": "🇹🇭 ไทย", "vi-VN": "🇻🇳 Tiếng Việt",
  "ar-SA": "🇸🇦 العربية", "he-IL": "🇮🇱 עברית", "tr-TR": "🇹🇷 Türkçe",
  "hi-IN": "🇮🇳 हिन्दी", "id-ID": "🇮🇩 Bahasa Indonesia", "el-GR": "🇬🇷 Ελληνικά",
  "cs-CZ": "🇨🇿 Čeština", "ro-RO": "🇷🇴 Română", "hu-HU": "🇭🇺 Magyar",
  "bg-BG": "🇧🇬 Български", "sk-SK": "🇸🇰 Slovenčina", "hr-HR": "🇭🇷 Hrvatski",
};

export function isLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function resolveSupportedLocale(value: string | null | undefined): SupportedLocale | undefined {
  if (!value) return undefined;
  const tag = value.trim().replaceAll("_", "-").toLowerCase();
  const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === tag);
  if (exact) return exact;
  const language = tag.split("-")[0];
  // 挪威语系统可能报告 no 而非 nb；DED 不参与自然语言推断。
  if (language === "no" || language === "nn") return "nb-NO";
  return SUPPORTED_LOCALES.find((locale) => locale !== "ded" && locale.split("-")[0] === language);
}

export function localeDirection(locale: SupportedLocale): "ltr" | "rtl" {
  return locale === "ar-SA" || locale === "he-IL" ? "rtl" : "ltr";
}
