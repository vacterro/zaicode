import { ZaicodePrefCheck, ZaicodePrefHeading } from "./ZaicodePrefControls.js";
import { ZAICODE_COMPOSER_PARTS, useZaicodeComposerPrefs } from "./zaicodeComposerPrefs.js";

/**
 * Every part of the message box's SAIPEN strip, on / off (SRC-038). The same
 * panel sits in Settings -> Layout & home and on a right-click of the strip's
 * compact button.
 */
export function ZaicodeComposerPartsPanel() {
  const prefs = useZaicodeComposerPrefs();
  const full = ZAICODE_COMPOSER_PARTS.filter((part) => !part.compact);
  const compact = ZAICODE_COMPOSER_PARTS.filter((part) => part.compact);
  return (
    <div className="flex flex-col gap-1.5 text-ui-xs" data-zaicode-composer-parts>
      <ZaicodePrefCheck
        checked={prefs.compact}
        onChange={(on) => prefs.update({ compact: on })}
        label="Compact: one row of small square buttons"
        hint="START, STEP, CLEAR and the modes become icons; the words move into their tooltips"
      />
      <ZaicodePrefHeading>FULL STRIP SHOWS</ZaicodePrefHeading>
      {full.map((part) => (
        <ZaicodePrefCheck
          key={part.key}
          checked={prefs[part.key]}
          onChange={(on) => prefs.update({ [part.key]: on })}
          label={part.label}
          hint={part.hint}
        />
      ))}
      <ZaicodePrefHeading>COMPACT ROW SHOWS</ZaicodePrefHeading>
      {compact.map((part) => (
        <ZaicodePrefCheck
          key={part.key}
          checked={prefs[part.key]}
          onChange={(on) => prefs.update({ [part.key]: on })}
          label={part.label}
          hint={part.hint}
        />
      ))}
      <button
        type="button"
        className="self-start border border-border px-1.5 py-0.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
        onClick={prefs.reset}
      >
        Back to defaults
      </button>
    </div>
  );
}
