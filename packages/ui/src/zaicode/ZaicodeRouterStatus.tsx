import { useZaicodeRouterSetup, zaicodeRouterSupervisorLabel } from "./zaicodeRouterSetup.js";

/** Read-only projection of the main router owner, visible while the operator works. */
export function ZaicodeRouterStatus({ compact = false }: { compact?: boolean }) {
  const host = useZaicodeRouterSetup((value) => value.host);
  const state = host?.supervisor;
  if (!state || (compact && state.status === "preferred")) return null;
  const label = zaicodeRouterSupervisorLabel(host);
  return <div role="status" data-zaicode-router-supervisor={state.status} title={state.failure ?? label ?? undefined} className={`${compact ? "shrink-0 truncate border-b border-border px-2 py-1 text-ui-xs " : ""}${state.status === "unavailable" ? "text-destructive" : "text-foreground-subtle"}`}>{label}</div>;
}
