import { useState } from "react";
import type { IZaicodeAuditService } from "@zcode/services";
import { resolveZaicodeAutoPolicy, type ZaicodeAutoPolicy } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ZaicodePrefCheck, ZaicodePrefSegment, ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { useZaicodeAuditStore } from "./zaicodeAuditStore.js";

/** One persisted audit policy, exposed by both AUTO and the audit centre. */
export function ZaicodeAutoSettingsPanel({ audits, workspaceKey = "", projectName = "" }: {
  audits: IZaicodeAuditService | null;
  workspaceKey?: string;
  projectName?: string;
}) {
  const auto = useZaicodeAuditStore();
  const [scope, setScope] = useState<"global" | "project">("global");
  const [saving, setSaving] = useState(false);
  const key = workspaceKey.trim();
  const editingProject = scope === "project";
  const effective = resolveZaicodeAutoPolicy(auto, key);
  const values = editingProject ? effective : auto;
  const overrides = key ? auto.autoProjects[key] : undefined;
  const disabled = !audits || saving || auto.policySaving || (editingProject && !key);
  const save = async (action: () => Promise<void>) => {
    setSaving(true);
    try { await action(); } finally { setSaving(false); }
  };
  const update = (patch: Partial<ZaicodeAutoPolicy>) => {
    if (!audits || disabled) return;
    void save(async () => {
      if (editingProject) await auto.setProjectAutoSettings(audits, key, patch);
      else if (patch.smartMode !== undefined) await auto.setSmartMode(audits, patch.smartMode);
      else if (patch.autoAudits !== undefined) await auto.setAutoAudits(audits, patch.autoAudits);
      else if (patch.maxCycles !== undefined) await auto.setMaxCycles(audits, patch.maxCycles);
    });
  };
  return (
    <div className="flex flex-col gap-2" data-zaicode-auto-settings>
      <ZaicodePrefSegment
        label="Apply AUTO settings to"
        value={scope}
        options={[{ value: "global", label: "Global" }, { value: "project", label: "Current project" }]}
        disabled={saving || auto.policySaving}
        onChange={setScope}
      />
      <p data-zaicode-auto-edit-scope={scope} className="text-foreground-subtle">
        {editingProject
          ? key ? `Editing current project: ${projectName || key}` : "Select a current project to edit its AUTO settings."
          : "Editing global defaults for all projects. Explicit project overrides are preserved."}
      </p>
      {key ? <p data-zaicode-auto-effective className="text-foreground-subtlest">
        Current project: {effective.smartMode ? "ON" : "OFF"} · {overrides?.smartMode !== undefined ? "Project override" : "Inherited from Global"}
      </p> : null}
      <ZaicodePrefCheck
        label="AUTO continue project work"
        hint={editingProject ? "Applies only to the current project." : "Default for every project without an explicit AUTO override."}
        checked={values.smartMode}
        disabled={disabled}
        onChange={(smartMode) => update({ smartMode })}
      />
      <ZaicodePrefCheck
        label="Run A3 audits after project work"
        hint="Off: AUTO continues existing work without creating audits. Manual audits keep working."
        checked={values.autoAudits}
        disabled={disabled}
        onChange={(autoAudits) => update({ autoAudits })}
      />
      <label className="flex flex-wrap items-center gap-2 text-foreground-subtle">
        Maximum automatic audits per project
        <select
          aria-label="Maximum automatic audits per project"
          className="h-5 border border-border bg-background px-1 text-foreground"
          value={values.maxCycles}
          disabled={disabled || !values.autoAudits}
          onChange={(event) => {
            const count = Number(event.target.value);
            update({ maxCycles: count });
          }}
        >
          {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => <option key={count} value={count}>{count}</option>)}
        </select>
      </label>
      {editingProject && key ? <button
        type="button"
        className="min-h-6 border border-border px-1 text-left text-foreground hover:bg-hover"
        disabled={disabled || !overrides}
        onClick={() => { if (audits) void save(() => auto.setProjectAutoSettings(audits, key, null)); }}
      >Use global settings for this project</button> : null}
      <div className="mt-2 border-t border-border pt-1.5 text-ui-xs text-foreground-subtle">
        <p className="font-semibold text-foreground">AUTOMATION SYSTEMS</p>
        <ul className="mt-1 list-disc pl-4 space-y-0.5 text-[11px] leading-tight">
          <li><strong>AUTO:</strong> SAIPEN project continuation & automatic audits.</li>
          <li><strong>SCHEDULER AUTOPILOT:</strong> Time-based and quota-reset launches.</li>
          <li><strong>AUTO RETRY:</strong> Retry failed turns with same model/prompt.</li>
          <li><strong>AUTO GOAL:</strong> Prepare /goal cc all in new task drafts.</li>
          <li><strong>CONTINUE ALL:</strong> Explicit operator action across eligible projects.</li>
        </ul>
      </div>
      {auto.error ? <p role="alert" className="text-error">{auto.error}</p> : null}
    </div>
  );
}

export function ZaicodeSidebarAutoButton({ audits, className, workspaceKey = "", projectName = "" }: {
  audits: IZaicodeAuditService | null;
  className: string;
  workspaceKey?: string;
  projectName?: string;
}) {
  const auto = useZaicodeAuditStore();
  const key = workspaceKey.trim();
  const policy = resolveZaicodeAutoPolicy(auto, key);
  const projectMode = key && auto.autoProjects[key]?.smartMode !== undefined;
  const source = projectMode ? "Project" : "Global";
  const behavior = policy.autoAudits
    ? `Continue open project work, then run A3 audits after SAIPEN reports DONE. Up to ${policy.maxCycles} audit cycles per project.`
    : "Continue open project work. Automatic A3 audits are off.";
  return (
    <ZaicodeRightClickSettings key={key} title="AUTO settings" preferenceKey="sessionActions" panel={<ZaicodeAutoSettingsPanel audits={audits} workspaceKey={key} projectName={projectName} />} className="min-w-0">
      <button
        type="button"
        className={cn(className, "w-full flex-col justify-center gap-0.5 py-1 px-1 min-w-0 overflow-hidden leading-tight", policy.smartMode
          ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
          : "border-border text-foreground-subtle")}
        aria-pressed={policy.smartMode}
        aria-label={`Auto ${policy.smartMode ? "ON" : "OFF"} · ${source}`}
        disabled={!audits || auto.policySaving}
        title={`Auto ${policy.smartMode ? "ON" : "OFF"}: ${source}${key ? ` · ${projectName || key}` : " default"}.\n${behavior}\nRight-click: choose Global or Current project settings.`}
        onClick={() => {
          if (!audits) return;
          if (projectMode) void auto.setProjectAutoSettings(audits, key, { smartMode: !policy.smartMode });
          else void auto.setSmartMode(audits, !policy.smartMode);
        }}
        data-zaicode-auto-scope={source.toLowerCase()}
        data-zaicode-auto-audits={policy.autoAudits ? "on" : "off"}
      >
        <span className="truncate max-w-full text-center leading-tight">Auto {policy.smartMode ? "ON" : "OFF"}</span>
        <span className="truncate max-w-full text-center text-ui-xs font-normal leading-tight opacity-80">{source}</span>
      </button>
    </ZaicodeRightClickSettings>
  );
}
