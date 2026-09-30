import { Folder, Home, Plus, Settings } from "lucide-react";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useZaicodeMainSessions, zaicodeMainSessionIdOf } from "./zaicodeMainSession.js";
import { useZaicodeRunningSessions } from "./zaicodeSidebarPrefs.js";

/** Compact navigation over existing tab/session owners, without another project registry. */
export function ZaicodeProjectRail({ onHome, onNew }: { onHome: () => void; onNew: () => void }) {
  const tabs = useTabStore((s) => s.tabs);
  const active = useTabStore((s) => s.activeTabId);
  const activate = useTabStore((s) => s.activateTab);
  const settings = useTabStore((s) => s.openSettingsTab);
  const mains = useZaicodeMainSessions((s) => s.byWorkspace);
  const working = useZaicodeRunningSessions((s) => s.sessions);
  return (
    <nav className="flex h-full min-h-0 flex-col items-stretch gap-1 p-1 text-ui-xs" aria-label="Compact projects" data-zaicode-project-rail>
      <button type="button" className="flex h-8 items-center justify-center border border-border" title="SAIHOME" aria-label="SAIHOME" onClick={onHome}><Home className="size-4" /></button>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {tabs.filter(isWorkspaceTab).map((tab) => {
          const main = zaicodeMainSessionIdOf(mains, tab.workspaceIdentity || tab.workspacePath);
          const live = working.some((s) => (s.workspaceIdentity || s.workspacePath) === (tab.workspaceIdentity || tab.workspacePath));
          return <button key={tab.id} type="button" className="relative flex h-10 shrink-0 flex-col items-center justify-center overflow-hidden border border-border aria-[current=page]:bg-selected" aria-current={active === tab.id ? "page" : undefined} aria-label={tab.label || tab.workspacePath} title={tab.label || tab.workspacePath} onClick={() => activate(tab.id)}>
            {live ? <span className="absolute inset-y-0 left-0 w-0.5 bg-[var(--color-success)]" /> : null}
            <Folder className="size-3" />
            <span className="max-w-full truncate">{(tab.label || tab.workspacePath.split(/[\\/]/).pop() || "?").slice(0, 3)}</span>
            {main ? <span className="absolute right-0 top-0 text-[var(--zaicode-highlight,var(--color-warning))]" aria-label="MAIN session">◆</span> : null}
          </button>;
        })}
      </div>
      <button type="button" className="flex h-7 items-center justify-center border border-border" title="New session" aria-label="New session" onClick={onNew}><Plus className="size-4" /></button>
      <button type="button" className="flex h-7 items-center justify-center border border-border" title="Settings" aria-label="Settings" onClick={() => settings()}><Settings className="size-4" /></button>
    </nav>
  );
}
