import { useState } from "react";
import { Eye, RotateCcw } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import { ZAICODE_HIGHLIGHT_TARGETS } from "@/zaicode/zaicodeHighlights.js";
import { readZaicodeWorkingMedia } from "@/zaicode/zaicodeWorkingMedia.js";
import {
  ZAICODE_SHIPPED_WORKER_ICON,
  listZaicodeModelOverrides,
  parseZaicodeModelIdentity,
  readZaicodeModelAppearancePrefs,
  resolveZaicodeWorkerIconUrl,
  setZaicodeGlobalAppearance,
  setZaicodeModelAppearance,
  zaicodeModelIdentityKey,
  type ZaicodeModelAppearancePrefs,
  type ZaicodeModelIdentity,
} from "@/zaicode/zaicodeModelAppearance.js";
import zaicodeWorkingUrl from "@/assets/zaicode-working.png?url";

/**
 * Highlights -> per-model appearance (Wave 4, part C).
 *
 * One global Default is configured once, and any model can then choose to
 * diverge. SAIFREN and SAIOPP are not special-cased: they are entries in the
 * same list as any other model, entered by the same control, stored under the
 * same key, resolved by the same fallback chain.
 *
 * The identity is provider id + model id, taken from the model string the
 * runtime actually used. A model the operator has never configured shows as
 * "Uses the default" rather than a blank row, so the list grows with what
 * actually works rather than with what someone pre-declared.
 */

function ModelRow({ identity, prefs }: { identity: ZaicodeModelIdentity; prefs: ZaicodeModelAppearancePrefs }) {
  const key = zaicodeModelIdentityKey(identity);
  const override = prefs.models[key];
  const separate = override?.mode === "separate";
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);

  return (
    <div className="flex flex-col gap-1 border border-border/60 p-2" data-zaicode-model-row={key}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground" title={`${identity.providerId} / ${identity.modelId}`}>
          {identity.modelId}
          <span className="ml-1 text-foreground-subtlest">{identity.providerId}</span>
        </span>
        <ZaicodePrefSegment
          label="Appearance"
          value={separate ? "separate" : "default"}
          options={[
            { value: "default", label: "Default", hint: "Follow the global appearance above" },
            { value: "separate", label: "Separate", hint: "Its own highlight and worker icon" },
          ]}
          onChange={(mode) => {
            if (pending) return;
            setPending(true);
            setZaicodeModelAppearance(identity, { mode: mode as "default" | "separate" });
            setPending(false);
          }}
        />
      </div>
      {separate ? (
        <div className="flex flex-col gap-1.5 pl-1">
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {ZAICODE_HIGHLIGHT_TARGETS.map((target) => (
              <label key={target.id} className="flex items-center justify-between gap-2" title={target.hint}>
                <span className="truncate text-foreground-subtle">{target.label}</span>
                <input
                  type="color"
                  className="h-5 w-9 shrink-0 cursor-pointer border border-border bg-card p-0"
                  aria-label={`${target.label} colour for ${identity.modelId}`}
                  title="Leave unchanged to keep the global colour"
                  value={override?.highlight?.[target.id]?.custom || "#c0b080"}
                  onChange={(event) =>
                    setZaicodeModelAppearance(identity, {
                      highlight: {
                        ...(override?.highlight ?? {}),
                        [target.id]: { ...(override?.highlight?.[target.id] ?? {}), color: "custom", custom: event.target.value },
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-foreground-subtle">Worker icon</span>
            <img
              src={resolveZaicodeWorkerIconUrl(prefs, `${identity.providerId}/${identity.modelId}`, zaicodeWorkingUrl)}
              alt=""
              className="size-5 shrink-0 border border-border bg-background object-contain"
              // The box is fixed so switching models cannot make the row jump.
            />
            <label className="cursor-pointer border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover hover:text-foreground">
              {uploading ? "Reading…" : "Choose image"}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  setUploading(true);
                  try {
                    // The existing safe-asset reader: allow-listed types, a
                    // size cap, and dimension checks. No new upload path.
                    const media = await readZaicodeWorkingMedia(file);
                    setZaicodeModelAppearance(identity, { workerIcon: media });
                    toast(`Worker icon for ${identity.modelId} updated`);
                  } catch (error) {
                    toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
                  } finally {
                    setUploading(false);
                  }
                }}
              />
            </label>
            {override?.workerIcon ? (
              <button
                type="button"
                className="flex items-center gap-1 border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover"
                title="Fall back to the global worker icon"
                onClick={() => setZaicodeModelAppearance(identity, { workerIcon: "" })}
              >
                <RotateCcw className="size-3" />
                Use the global icon
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ZaicodeModelAppearanceSettings({
  seenModels,
  className,
}: {
  /** Model strings the runtime has actually used, newest first if available. */
  seenModels: readonly string[];
  className?: string;
}) {
  const prefs = readZaicodeModelAppearancePrefs();
  const identities: ZaicodeModelIdentity[] = [];
  const seenKeys = new Set<string>();
  for (const model of seenModels) {
    const identity = parseZaicodeModelIdentity(model);
    const key = zaicodeModelIdentityKey(identity);
    if (!identity || seenKeys.has(key)) continue;
    seenKeys.add(key);
    identities.push(identity);
  }

  return (
    <section className={cn("flex flex-col gap-2 border border-border bg-card p-3", className)} data-zaicode-model-appearance>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-ui-sm text-foreground">
          <Eye className="size-3" />
          Per-model appearance
        </span>
        <span className="text-foreground-subtlest">
          The model that actually runs the work decides how it looks -- not the one highlighted in a picker.
        </span>
      </div>

      <div className="flex flex-col gap-1.5 border border-border/60 p-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-ui-sm text-foreground">Every model (global default)</span>
          <img
            src={resolveZaicodeWorkerIconUrl(prefs, null, zaicodeWorkingUrl)}
            alt=""
            className="size-5 shrink-0 border border-border bg-background object-contain"
          />
          <button
            type="button"
            className="border border-border px-1.5 py-px text-foreground-subtle hover:bg-hover hover:text-foreground"
            title="Choose the worker icon every model uses unless it has its own"
            onClick={async () => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = "image/*";
              input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) return;
                try {
                  const media = await readZaicodeWorkingMedia(file);
                  setZaicodeGlobalAppearance({ workerIcon: media });
                } catch (error) {
                  toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
                }
              };
              input.click();
            }}
          >
            Worker icon
          </button>
        </div>
        <p className="text-foreground-subtlest">
          Set once here; any model below can leave it alone or diverge.
        </p>
      </div>

      {identities.length === 0 ? (
        <p className="text-foreground-subtlest">
          No model has run yet. Models appear here as soon as one works, so this list grows from real use.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {identities.map((identity) => (
            <ModelRow key={zaicodeModelIdentityKey(identity)} identity={identity} prefs={prefs} />
          ))}
        </div>
      )}

      {listZaicodeModelOverrides(prefs).length > identities.length ? (
        <details className="text-foreground-subtlest">
          <summary className="cursor-pointer">
            {listZaicodeModelOverrides(prefs).length} configured model(s) that have not run recently
          </summary>
          <div className="mt-1 flex flex-col gap-1.5">
            {listZaicodeModelOverrides(prefs)
              .filter((entry) => !seenKeys.has(entry.key))
              .map((entry) => {
                const [providerId, modelId] = entry.key.split("::");
                if (!providerId || !modelId) return null;
                return (
                  <ModelRow
                    key={entry.key}
                    identity={{ providerId, modelId }}
                    prefs={readZaicodeModelAppearancePrefs()}
                  />
                );
              })}
          </div>
        </details>
      ) : null}

      <p className="text-foreground-subtlest">
        A model set to Separate falls back to this global default for every target it does not name, and to what the
        product ships for the rest ({ZAICODE_SHIPPED_WORKER_ICON} when nothing sets an icon).
      </p>
    </section>
  );
}
