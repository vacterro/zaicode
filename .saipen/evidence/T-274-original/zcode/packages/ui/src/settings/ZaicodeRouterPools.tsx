import { useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import {
  isZaicodeComboNameValid,
  moveZaicodeComboModel,
  withZaicodeComboStrategy,
  type ZaicodeComboStrategy,
  type ZaicodeRouterCombo,
} from "@zcode/shared";
import { useZaicodeRouter, zaicodeRouterChange } from "@/zaicode/zaicodeRouter.js";

/**
 * Router -> Pools: 9router combos, the pools ZAICODE runs on. Order is the
 * fallback order; the strategy says how 9router walks the list. Each change
 * is saved to 9router at once and read back.
 */

const inputClass = "min-w-0 border border-border bg-background px-1 py-0.5 text-foreground";

const STRATEGIES: readonly { value: ZaicodeComboStrategy; label: string; hint: string }[] = [
  { value: "fallback", label: "Fallback", hint: "Tries models in order; the next one on failure" },
  { value: "round-robin", label: "Round robin", hint: "Rotates models across requests to spread load" },
  { value: "fusion", label: "Fusion", hint: "Asks every model, a judge merges one answer (costs N+1 calls)" },
];

function saveModels(combo: ZaicodeRouterCombo, models: string[]) {
  return zaicodeRouterChange("Saving pool", { method: "PUT", path: `/api/combos/${combo.id}`, body: { models } }).then((result) => {
    if (!result.ok) toast(`${combo.name}: ${result.message}`);
  });
}

function PoolCard({ combo, modelIds }: { combo: ZaicodeRouterCombo; modelIds: readonly string[] }) {
  const settings = useZaicodeRouter((state) => state.settings);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setStrategy = (strategy: ZaicodeComboStrategy) => {
    const current = (settings?.comboStrategies ?? {}) as Record<string, unknown>;
    void zaicodeRouterChange("Saving strategy", {
      method: "PATCH",
      path: "/api/settings",
      body: { comboStrategies: withZaicodeComboStrategy(current, combo.name, strategy) },
    }).then((result) => {
      if (!result.ok) toast(`${combo.name}: ${result.message}`);
    });
  };
  const add = () => {
    const model = adding.trim();
    if (!model) return;
    if (combo.models.includes(model)) {
      toast(`${model} is already in ${combo.name}`);
      return;
    }
    setAdding("");
    void saveModels(combo, [...combo.models, model]);
  };
  const listId = `zaicode-router-models-${combo.id}`;
  return (
    <div className="flex flex-col gap-1 border border-border p-2" data-zaicode-router-pool={combo.name}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="font-semibold text-foreground hover:underline" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} {combo.name}
        </button>
        <span className="text-foreground-subtlest">{combo.models.length} models</span>
        <span className="flex gap-px" role="radiogroup" aria-label={`${combo.name} strategy`}>
          {STRATEGIES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={combo.strategy === option.value}
              title={option.hint}
              className={cn(
                "border px-1",
                combo.strategy === option.value
                  ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                  : "border-border text-foreground-subtle hover:text-foreground",
              )}
              onClick={() => setStrategy(option.value)}
            >
              {option.label}
            </button>
          ))}
        </span>
        <span className="ml-auto">
          {confirmDelete ? (
            <span className="flex items-center gap-1">
              <span className="text-destructive">Delete the pool {combo.name}?</span>
              <Button
                size="sm"
                variant="secondary"
                className="h-5 px-1"
                onClick={() => {
                  setConfirmDelete(false);
                  void zaicodeRouterChange("Deleting pool", { method: "DELETE", path: `/api/combos/${combo.id}` }).then((result) =>
                    toast(result.ok ? `${combo.name} deleted` : result.message),
                  );
                }}
              >
                Delete
              </Button>
              <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => setConfirmDelete(true)}>
              Delete…
            </Button>
          )}
        </span>
      </div>
      {!open ? (
        <div className="truncate text-foreground-subtle" title={combo.models.join("\n")}>
          {combo.models.slice(0, 4).join(" · ")}
          {combo.models.length > 4 ? ` · +${combo.models.length - 4} more` : ""}
        </div>
      ) : (
        <>
          <ol className="flex max-h-[320px] flex-col overflow-y-auto border border-border">
            {combo.models.map((model, index) => (
              <li key={model} className="flex items-center gap-1 border-b border-border/40 px-1 last:border-b-0">
                <span className="w-7 shrink-0 text-right tabular-nums text-foreground-subtlest">{index + 1}.</span>
                <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={model}>
                  {model}
                </span>
                <Button size="sm" variant="ghost" className="h-5 px-1" disabled={index === 0} onClick={() => void saveModels(combo, moveZaicodeComboModel(combo.models, model, -index))} title="To the top">
                  ⤒
                </Button>
                <Button size="sm" variant="ghost" className="h-5 px-1" disabled={index === 0} onClick={() => void saveModels(combo, moveZaicodeComboModel(combo.models, model, -1))} title="Up">
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1"
                  disabled={index === combo.models.length - 1}
                  onClick={() => void saveModels(combo, moveZaicodeComboModel(combo.models, model, 1))}
                  title="Down"
                >
                  ↓
                </Button>
                <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => void saveModels(combo, combo.models.filter((item) => item !== model))} title="Remove from this pool">
                  ✕
                </Button>
              </li>
            ))}
            {combo.models.length === 0 ? <li className="px-2 py-1 text-foreground-subtlest">Empty: add a model below.</li> : null}
          </ol>
          <div className="flex items-center gap-1">
            <input
              className={`${inputClass} flex-1 font-mono`}
              list={listId}
              value={adding}
              placeholder="prefix/model (type to search 9router's models)"
              onChange={(event) => setAdding(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
              }}
            />
            <datalist id={listId}>
              {modelIds.slice(0, 2000).map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <Button size="sm" variant="secondary" disabled={!adding.trim()} onClick={add}>
              Add
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function ZaicodeRouterPools() {
  const combos = useZaicodeRouter((state) => state.combos);
  const models = useZaicodeRouter((state) => state.models);
  const [name, setName] = useState("");
  const modelIds = useMemo(() => models.map((model) => model.id).sort(), [models]);
  const create = () => {
    const trimmed = name.trim();
    if (!isZaicodeComboNameValid(trimmed)) {
      toast("Pool names: letters, digits, - _ . only");
      return;
    }
    void zaicodeRouterChange("Creating pool", { method: "POST", path: "/api/combos", body: { name: trimmed, models: [] } }).then((result) => {
      toast(result.ok ? `${trimmed} created: add its models` : result.message);
      if (result.ok) setName("");
    });
  };
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-3 text-ui-xs" data-zaicode-router-pools>
      <div>
        <h2 className="text-ui-lg text-foreground">Pools</h2>
        <p className="mt-0.5 max-w-[640px] text-foreground-subtle">
          A pool is one model name for ZAICODE (SAIRoute / SAIFREN) that 9router serves from a list: first model first, the next one when it fails.
        </p>
      </div>
      {combos.map((combo) => (
        <PoolCard key={combo.id} combo={combo} modelIds={modelIds} />
      ))}
      <div className="flex items-center gap-1">
        <input className={inputClass} value={name} placeholder="NEWPOOL" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && create()} />
        <Button size="sm" variant="secondary" disabled={!name.trim()} onClick={create}>
          Create pool
        </Button>
      </div>
    </section>
  );
}
