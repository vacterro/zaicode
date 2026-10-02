import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { useZaicodeActions } from "./zaicodeActions.js";
import { useZaicodeUsage } from "./zaicodeUsage.js";
import { ZaicodeUsageView } from "./ZaicodeUsageView.js";
import { ZaicodeSaipenSidePane } from "./ZaicodeSaipenSidePane.js";

/** Inspectors also work over a centered draft, before a workspace pane is visible. */
export function ZaicodeGlobalSidebars() {
  const target = useZaicodeActions((state) => state.saipenSidebar);
  const setTarget = useZaicodeActions((state) => state.setSaipenSidebar);
  const workspaceOpener = useZaicodeActions((state) => state.openSaipen);
  const usageMode = useZaicodeUsage((state) => state.mode);
  const usage = usageMode !== "closed" && !workspaceOpener;
  if (!target && !usage) return null;
  return createPortal(
    <aside
      className="fixed right-0 top-10 bottom-0 z-40 flex min-h-0 flex-col border-l border-border bg-background text-foreground shadow-lg"
      style={{ width: usage && usageMode === "page" ? "100%" : "min(480px,50vw)" }}
      aria-label={usage ? `9router Usage ${usageMode}` : "SAIPEN sidebar"}
    >
      {usage ? (
        <ScopedErrorBoundary scope="zaicode-global-usage" resetKeys={[usageMode]} variant="panel" className="h-full">
          <ZaicodeUsageView sidebar={usageMode === "sidebar"} />
        </ScopedErrorBoundary>
      ) : target ? (
        <>
          <header className="flex shrink-0 items-center gap-2 border-b border-border p-2 text-ui-xs">
            <strong className="mr-auto truncate" title={target.workspacePath}>SAIPEN · {target.workspacePath}</strong>
            <button type="button" aria-label="Close SAIPEN sidebar" onClick={() => setTarget(null)}>
              <X className="size-4" />
            </button>
          </header>
          <ScopedErrorBoundary scope="zaicode-global-saipen" resetKeys={[target.workspacePath, target.workspaceIdentity]} variant="panel" className="min-h-0 flex-1">
            <ZaicodeSaipenSidePane workspacePath={target.workspacePath} workspaceIdentity={target.workspaceIdentity} className="h-full" />
          </ScopedErrorBoundary>
        </>
      ) : null}
    </aside>, document.body,
  );
}
