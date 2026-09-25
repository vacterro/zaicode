import { useSyncExternalStore } from "react";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { readZaicodeActiveEngine, setZaicodeActiveEngine } from "./zaicodeEngines.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelection } from "@zcode/shared/model-selection";

/**
 * ZAICODE default model for NEW sessions (sidebar "DEFAULT" switch, e.g.
 * SAIRoute / SAIFREN vs SAIRoute / SAIOPP). Renderer-local preference: it
 * wins over the per-project "last used" model when a fresh draft is seeded,
 * so every new session starts on the model the operator picked, predictably.
 */
export interface ZaicodeDefaultModel {
  providerId: string;
  modelId: string;
}

const STORAGE_KEY = "zaicode-default-model";
const CHANGE_EVENT = "zaicode-default-model-changed";

let cached: ZaicodeDefaultModel | null | undefined;

export function readZaicodeDefaultModel(): ZaicodeDefaultModel | null {
  if (cached !== undefined) return cached;
  try {
    const parsed = JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null") as unknown;
    cached =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as ZaicodeDefaultModel).providerId === "string" &&
      typeof (parsed as ZaicodeDefaultModel).modelId === "string"
        ? {
            providerId: (parsed as ZaicodeDefaultModel).providerId,
            modelId: (parsed as ZaicodeDefaultModel).modelId,
          }
        : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function setZaicodeDefaultModel(value: ZaicodeDefaultModel | null): void {
  cached = value;
  try {
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Preference lasts for this window only when storage is unavailable.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * The operator picked a model in a composer. The pick is the one rule for
 * what runs next: it becomes the default for fresh sessions (START opens
 * one) and it releases a subscription engine selected on the sidebar, so
 * START never opens a CLI terminal the operator did not ask for. Returns
 * true when an engine selection was released (the caller tells the user).
 */
export function adoptZaicodeComposerModel(providerId: string, modelId: string): boolean {
  if (!providerId || !modelId) return false;
  const current = readZaicodeDefaultModel();
  if (current?.providerId !== providerId || current.modelId !== modelId) {
    setZaicodeDefaultModel({ providerId, modelId });
  }
  if (!readZaicodeActiveEngine()) return false;
  setZaicodeActiveEngine(null);
  return true;
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cached = undefined;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useZaicodeDefaultModel(): ZaicodeDefaultModel | null {
  return useSyncExternalStore(subscribe, readZaicodeDefaultModel, readZaicodeDefaultModel);
}

/** Middle-of-the-road reasoning level the model actually supports. */
function defaultReasoningLevel(values: readonly string[]): string | undefined {
  if (values.includes("medium")) return "medium";
  return values[0];
}

/**
 * The configured default as a complete selection valid in `view`, or null
 * when no default is set or the model is gone (the caller then falls back).
 */
export function resolveZaicodeDefaultSelection(view: ModelSelectionView): ModelSelection | null {
  const preferred = readZaicodeDefaultModel();
  if (!preferred) return null;
  const model = view.providers
    .find((provider) => provider.providerId === preferred.providerId)
    ?.models.find((candidate) => candidate.modelId === preferred.modelId);
  if (!model) return null;
  const reasoningLevel = defaultReasoningLevel(model.config.optionSpecs.reasoningLevel.values);
  return {
    providerId: preferred.providerId,
    modelId: preferred.modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}
