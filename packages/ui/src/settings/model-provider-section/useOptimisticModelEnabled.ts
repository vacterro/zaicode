import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ModelEnabledChange { modelId: string; enabled: boolean }
interface PendingChange extends ModelEnabledChange { operationId: number; acknowledged: boolean }

/** Pending clicks are a UI projection; the existing provider owner still accepts every write. */
export function useOptimisticModelEnabled<T extends { modelId: string; config: { enabled?: boolean | null } }>({
  scopeKey, scopeOwner, models, persist,
}: {
  scopeKey: string;
  scopeOwner?: object;
  models: readonly T[];
  persist: (changes: ModelEnabledChange[]) => Promise<void>;
}) {
  const [pending, setPending] = useState<Record<string, PendingChange>>({});
  const owner = useRef({ scopeKey, scopeOwner, nextId: 0, tail: Promise.resolve() as Promise<void> });
  useLayoutEffect(() => {
    if (owner.current.scopeKey === scopeKey && owner.current.scopeOwner === scopeOwner) return;
    owner.current = { scopeKey, scopeOwner, nextId: 0, tail: Promise.resolve() };
    setPending({});
  }, [scopeKey, scopeOwner]);
  useEffect(() => {
    setPending((current) => {
      const authoritative = new Map(models.map((model) => [model.modelId, model.config.enabled !== false]));
      const next = { ...current };
      let changed = false;
      for (const [id, intent] of Object.entries(current)) {
        if (!authoritative.has(id) || (intent.acknowledged && authoritative.get(id) === intent.enabled)) {
          delete next[id]; changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [models, pending]);
  const commit = useCallback((changes: ModelEnabledChange[]) => {
    const active = owner.current;
    const operationId = ++active.nextId;
    // 过去等待磁盘/Registry 才更新开关，看起来一行一行慢慢变；先投影整个点击意图。
    setPending((current) => {
      const next = { ...current };
      for (const change of changes) next[change.modelId] = { ...change, operationId, acknowledged: false };
      return next;
    });
    const operation = active.tail.catch(() => undefined).then(() => persist(changes));
    active.tail = operation;
    const settle = (success: boolean) => {
      if (owner.current !== active) return;
      setPending((current) => {
        const next = { ...current };
        for (const change of changes) {
          if (next[change.modelId]?.operationId !== operationId) continue;
          if (success) next[change.modelId] = { ...next[change.modelId]!, acknowledged: true };
          else delete next[change.modelId];
        }
        return next;
      });
    };
    return operation.then(() => settle(true), (error: unknown) => { settle(false); throw error; });
  }, [persist]);
  const renderedModels = models.map((model) => {
    const intent = owner.current.scopeKey === scopeKey && owner.current.scopeOwner === scopeOwner ? pending[model.modelId] : undefined;
    return intent ? { ...model, config: { ...model.config, enabled: intent.enabled } } : model;
  });
  return { renderedModels, commit };
}
