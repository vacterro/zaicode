import { cn } from "@/components/lib/utils.js";
import { parseZaicodeModelIdentity, setZaicodeModelAppearance, useZaicodeModelAppearancePrefs, zaicodeModelIdentityKey } from "./zaicodeModelAppearance.js";

/** One compact tab strip over the existing full icon and highlight editors. */
export function ZaicodeModelAppearanceSettings({ seenModels, model, onModel }: {
  seenModels: readonly string[];
  model: string | null;
  onModel: (model: string | null) => void;
}) {
  const prefs = useZaicodeModelAppearancePrefs();
  const identities = new Map<string, { value: string; label: string; provider: string }>();
  for (const value of [...seenModels, ...Object.keys(prefs.models).map((key) => key.replace("::", "/"))]) {
    const identity = parseZaicodeModelIdentity(value);
    if (!identity) continue;
    const key = zaicodeModelIdentityKey(identity);
    if (!identities.has(key)) identities.set(key, { value, label: identity.modelId, provider: identity.providerId });
  }
  const identity = parseZaicodeModelIdentity(model);
  const selectedKey = zaicodeModelIdentityKey(identity);
  const separate = prefs.models[selectedKey]?.mode === "separate";
  return (
    <div className="flex min-w-0 flex-col gap-1" data-zaicode-model-appearance>
      <div role="tablist" aria-label="Model appearance" className="flex flex-wrap gap-px">
        {[{ key: "", value: null, label: "Default", provider: "Every model" },
          ...[...identities].map(([key, entry]) => ({ key, ...entry }))].map((entry) => (
          <button key={entry.key} type="button" role="tab" aria-selected={selectedKey === entry.key}
            aria-controls="zaicode-model-appearance-editor" id={`zaicode-appearance-tab-${encodeURIComponent(entry.key)}`}
            title={`${entry.provider} / ${entry.label}`} onClick={() => onModel(entry.value)}
            className={cn("min-h-6 border border-border px-2 text-ui-xs", selectedKey === entry.key ? "bg-selected text-foreground border-[var(--zaicode-highlight,var(--color-border-hover))]" : "text-foreground-subtle hover:bg-hover")}>
            {entry.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle">
        <span>{identity ? `${identity.providerId} · ${separate ? "Own appearance" : "Uses Default · editing creates its own appearance"}` : "Shared icon, motion and highlights for every model"}</span>
        {identity && separate ? (
          <button type="button" className="border border-border px-1.5 py-px hover:bg-hover"
            onClick={() => setZaicodeModelAppearance(identity, null)} title="Remove this model’s overrides and follow Default">
            Use Default
          </button>
        ) : null}
      </div>
    </div>
  );
}
