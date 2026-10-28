import { Folder, Home, Plus, Settings } from "lucide-react";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useZaicodeMainSessions, zaicodeMainSessionIdOf } from "./zaicodeMainSession.js";
import { useZaicodeRunningSessions } from "./zaicodeSidebarPrefs.js";
import { ZaicodeRailControl } from "./ZaicodeRailControl.js";
import { zaicodeRailControlLayout } from "./zaicodeRailLayout.js";

/**
 * Compact navigation over existing tab/session owners, without another project registry.
 *
 * T-224 / SRC-154:R001: the rail is the vertical presentation of the sidebar. Every
 * control renders through ZaicodeRailControl from the rail layout contract — one box,
 * one icon slot, icon-only with the full name in the tooltip and aria-label — so no
 * control keeps its own heights or corner offsets. The live strip and the MAIN marker
 * sit inside the box in normal flow; the scroll region keeps the primary entries
 * reachable in a short window instead of squeezing them.
 */
export function ZaicodeProjectRail({ onHome, onNew }: { onHome: () => void; onNew: () => void }) {
  const tabs = useTabStore((s) => s.tabs);
  const active = useTabStore((s) => s.activeTabId);
  const activate = useTabStore((s) => s.activateTab);
  const settings = useTabStore((s) => s.openSettingsTab);
  const mains = useZaicodeMainSessions((s) => s.byWorkspace);
  const working = useZaicodeRunningSessions((s) => s.sessions);
  const layout = zaicodeRailControlLayout("vertical");
  return (
    <nav className="flex h-full min-h-0 flex-col items-stretch gap-1 p-1 text-ui-xs" aria-label="Compact projects" data-zaicode-project-rail data-zaicode-rail-axis="vertical">
      <ZaicodeRailControl layout={layout} label="SAIHOME" icon={<Home className="size-4" />} onActivate={onHome} testId="zaicode-rail-home" />
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" data-zaicode-rail-scroll="">
        {tabs.filter(isWorkspaceTab).map((tab) => {
          const name = tab.label || tab.workspacePath;
          const main = zaicodeMainSessionIdOf(mains, tab.workspaceIdentity || tab.workspacePath);
          const live = working.some((s) => (s.workspaceIdentity || s.workspacePath) === (tab.workspaceIdentity || tab.workspacePath));
          return (
            <ZaicodeRailControl
              key={tab.id}
              layout={layout}
              label={name}
              tag={(tab.label || tab.workspacePath.split(/[\\/]/).pop() || "?").slice(0, 3)}
              icon={<Folder className="size-4" />}
              active={active === tab.id}
              leading={live ? <span className="absolute inset-y-0 left-0 w-0.5 bg-[var(--color-success)]" aria-hidden="true" /> : null}
              trailing={main ? <span className="text-[var(--zaicode-highlight,var(--color-warning))]" aria-label="MAIN session">◆</span> : null}
              onActivate={() => activate(tab.id)}
            />
          );
        })}
      </div>
      <ZaicodeRailControl layout={layout} label="New session" icon={<Plus className="size-4" />} onActivate={onNew} testId="zaicode-rail-new" />
      <ZaicodeRailControl layout={layout} label="Settings" icon={<Settings className="size-4" />} onActivate={() => settings()} testId="zaicode-rail-settings" />
    </nav>
  );
}
