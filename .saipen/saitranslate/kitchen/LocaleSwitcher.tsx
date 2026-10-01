import { SUPPORTED_LOCALES, LOCALE_NATIVE_NAMES, isLocale } from "@zcode/shared";
import { TID_LOCALE_TOGGLE } from "@zcode/shared";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { useZCodeIntl } from "./IntlProvider.js";

/** Direct selection stays usable with 33 catalogs and long native names. */
export function LocaleSwitcher() {
  const { intl, locale, setLocale } = useZCodeIntl();
  return (
    <Select value={locale} onValueChange={(value) => { if (isLocale(value)) setLocale(value); }}>
      <SelectTrigger
        data-testid={TID_LOCALE_TOGGLE}
        aria-label={intl.formatMessage({ id: "locale.switchLanguage" })}
        className="min-w-0 max-w-[180px]"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LOCALES.map((tag) => (
          <SelectItem key={tag} value={tag}>{LOCALE_NATIVE_NAMES[tag]}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
