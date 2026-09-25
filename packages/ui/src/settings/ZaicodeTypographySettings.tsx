import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import {
  ZAICODE_CODE_FONT_OPTIONS,
  ZAICODE_UI_FONT_OPTIONS,
  resetZaicodeTypography,
  setZaicodeListLabelWidth,
  setZaicodeTypography,
  useZaicodeAppearance,
} from "@/zaicode/zaicodeAppearance.js";

export function ZaicodeTypographySettings() {
  const { intl } = useZCodeIntl();
  const { typography, listLabelWidth } = useZaicodeAppearance();
  const code = useZCodeStore((state) => state.codePreviewSettings);
  const setCode = useZCodeStore((state) => state.setCodePreviewSettings);
  const uiSize = useZCodeStore((state) => state.uiFontSizePx);
  const setUiSize = useZCodeStore((state) => state.setUiFontSizePx);
  const label = (id: string) => intl.formatMessage({ id: `zaicode.font.${id}` });

  return (
    <section className="border border-border bg-card p-4" aria-label={label("title")}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-ui-lg text-foreground">{label("title")}</h2>
          <p className="text-ui-xs text-foreground-subtle">{label("description")}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            resetZaicodeTypography();
            setZaicodeListLabelWidth(112);
            setCode({ fontSizePx: 16, wrapLongLines: true, showLineNumbers: true });
          }}
        >
          {label("reset")}
        </Button>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-ui-xs">
          <span>{label("codeFamily")}</span>
          <select
            className="w-full border border-border bg-background p-2 text-foreground"
            value={typography.codeFont}
            onChange={(event) => setZaicodeTypography({ codeFont: event.target.value })}
          >
            {ZAICODE_CODE_FONT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-ui-xs">
          <span>{label("uiFamily")}</span>
          <select
            className="w-full border border-border bg-background p-2 text-foreground"
            value={typography.uiFont}
            onChange={(event) => setZaicodeTypography({ uiFont: event.target.value })}
          >
            {ZAICODE_UI_FONT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {typography.codeFont === "custom" ? (
          <label className="flex flex-col gap-1 text-ui-xs">
            <span>{label("customCode")}</span>
            <input
              className="border border-border bg-background p-2 text-foreground"
              maxLength={80}
              value={typography.customCodeFont}
              onChange={(event) => setZaicodeTypography({ customCodeFont: event.target.value })}
            />
          </label>
        ) : null}
        {typography.uiFont === "custom" ? (
          <label className="flex flex-col gap-1 text-ui-xs">
            <span>{label("customUi")}</span>
            <input
              className="border border-border bg-background p-2 text-foreground"
              maxLength={80}
              value={typography.customUiFont}
              onChange={(event) => setZaicodeTypography({ customUiFont: event.target.value })}
            />
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-ui-xs">
          <span>
            {label("codeSize")}: {code.fontSizePx}px
          </span>
          <input
            type="range"
            min="12"
            max="24"
            step="1"
            value={code.fontSizePx}
            onChange={(event) => setCode({ fontSizePx: Number(event.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-ui-xs">
          <span>
            {label("inlineSize")}: {typography.inlineCodeSize}px
          </span>
          <input
            type="range"
            min="12"
            max="22"
            step="1"
            value={typography.inlineCodeSize}
            onChange={(event) =>
              setZaicodeTypography({ inlineCodeSize: Number(event.target.value) })
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-ui-xs">
          <span>
            {label("lineHeight")}: {typography.codeLineHeight.toFixed(1)}
          </span>
          <input
            type="range"
            min="1.1"
            max="2"
            step="0.1"
            value={typography.codeLineHeight}
            onChange={(event) =>
              setZaicodeTypography({ codeLineHeight: Number(event.target.value) })
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-ui-xs">
          <span>
            {label("uiSize")}: {uiSize}px
          </span>
          <input
            type="range"
            min="12"
            max="20"
            step="1"
            value={uiSize}
            onChange={(event) => setUiSize(Number(event.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1 text-ui-xs">
          <span>
            {intl.formatMessage(
              { id: "zaicode.settings.listLabelWidth" },
              { width: listLabelWidth },
            )}
          </span>
          <input
            type="range"
            min="64"
            max="220"
            step="4"
            value={listLabelWidth}
            onChange={(event) => setZaicodeListLabelWidth(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-ui-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={code.wrapLongLines}
            onChange={(event) => setCode({ wrapLongLines: event.target.checked })}
          />
          {label("wrap")}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={code.showLineNumbers}
            onChange={(event) => setCode({ showLineNumbers: event.target.checked })}
          />
          {label("numbers")}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={typography.ligatures}
            onChange={(event) => setZaicodeTypography({ ligatures: event.target.checked })}
          />
          {label("ligatures")}
        </label>
      </div>
      <div className="mt-3 min-w-0 overflow-x-auto border border-border bg-background p-3">
        <div className="text-ui-xs text-foreground-subtle">{label("preview")}</div>
        <pre
          className="mt-2 min-w-0 whitespace-pre-wrap break-words text-foreground"
          style={{ fontSize: code.fontSizePx }}
        >
          {"const answer = (value: number) => value + 42;\n// 0 O 1 l I  |  [] {}  кириллица"}
        </pre>
      </div>
      <p className="mt-2 text-ui-xs text-foreground-subtle">{label("installedHint")}</p>
    </section>
  );
}
