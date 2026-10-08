import { Switch } from "@/components/ui/switch.js";
import type { ZaicodeContinuingJob, ZaicodeContinuationPolicy } from "@zcode/shared";
import { SortableProviderModelList } from "@/settings/model-provider-section/SortableProviderModelList.js";

/** Configure the ordered runners in the existing job; no parallel automation state. */
export function ZaicodeScheduleContinuation({ job, runners, onChange }: { job: ZaicodeContinuingJob; runners: readonly { id: string; label: string }[]; onChange: (patch: Partial<ZaicodeContinuingJob>) => void }) {
  const policy = job.continuation;
  const update = (patch: Partial<ZaicodeContinuationPolicy>) => onChange({ continuation: { ...policy, ...patch } });
  const selected = policy.runnerIds.filter((id) => id !== job.engineId);
  const unavailable = job.onlyMarked || job.engineId.startsWith("agent:");
  return <div className="flex flex-col gap-1 text-ui-xs text-foreground-subtle" data-zaicode-continuation-settings>
    <label className="flex items-center gap-1"><Switch checked={policy.enabled} disabled={unavailable} onCheckedChange={(enabled) => update({ enabled })} />Continue automatically when a subscription reaches its limit</label>
    {unavailable ? <p>Select a subscription or in-app project runner and turn off “only marked sessions” to use automatic handoff.</p> : null}
    {policy.enabled ? <>
      <p>Preferred: {runners.find((runner) => runner.id === job.engineId)?.label ?? job.engineId}. Fallbacks run in the order below.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label>Handoff delay <input aria-label="Handoff delay in minutes" className="w-14 border border-border bg-background px-1" type="number" min={0} max={1440} value={policy.delayMinutes} onChange={(event) => update({ delayMinutes: Math.max(0, Math.min(1440, Number(event.target.value))) })} /> min</label>
        <label className="flex items-center gap-1"><Switch checked={policy.returnToPreferred} onCheckedChange={(returnToPreferred) => update({ returnToPreferred })} />Return after fresh quota recovery</label>
        {policy.returnToPreferred ? <label>Return delay <input aria-label="Return delay in minutes" className="w-14 border border-border bg-background px-1" type="number" min={0} max={1440} value={policy.recoveryDelayMinutes} onChange={(event) => update({ recoveryDelayMinutes: Math.max(0, Math.min(1440, Number(event.target.value))) })} /> min</label> : null}
      </div>
      <SortableProviderModelList modelIds={selected} dragLabel="Drag to reorder fallbacks" onReorder={(runnerIds) => update({ runnerIds })} renderModel={(id, index) => <div className="flex items-center gap-1 py-1">
        <span>{index + 1}. {runners.find((runner) => runner.id === id)?.label ?? id}</span>
        <button type="button" disabled={index === 0} aria-label={`Move ${id} earlier`} onClick={() => { const next = [...selected]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; update({ runnerIds: next }); }}>↑</button>
        <button type="button" aria-label={`Remove fallback ${id}`} onClick={() => update({ runnerIds: selected.filter((value) => value !== id) })}>Remove</button>
      </div>} />
      <select aria-label="Add fallback runner" className="max-w-full border border-border bg-background px-1" value="" onChange={(event) => { if (event.target.value) update({ runnerIds: [...selected, event.target.value] }); }}>
        <option value="">Add a subscription or in-app model, including SAIFREN</option>
        {runners.filter((runner) => runner.id !== job.engineId && !selected.includes(runner.id) && !runner.id.startsWith("agent:") && runner.id !== "pool:start").map((runner) => <option key={runner.id} value={runner.id}>{runner.label}</option>)}
      </select>
    </> : null}
    {job.continuationRuns.filter((run) => !["complete", "stopped"].includes(run.state)).map((run) => <p className="break-words" key={`${run.occurrence}/${run.workspaceKey}`} data-zaicode-continuation-run={run.state}>{run.projectPath}: {run.state} · {runners.find((runner) => runner.id === run.runnerId)?.label ?? run.runnerId} · {run.result}</p>)}
  </div>;
}
