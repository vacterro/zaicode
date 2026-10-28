import type { ZaicodeUpdateComponent, ZaicodeUpdateComponentId, ZaicodeUpdateStatus } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import {
  applyZaicodeUpdates,
  checkZaicodeUpdates,
  setZaicodeUpdateAuto,
  useZaicodeUpdates,
  zaicodeUpdatesAvailable,
} from "@/zaicode/zaicodeUpdatesStore.js";

/**
 * Settings -> ZAICODE -> Updates (T-134): ZAICODE is four repositories that
 * work as one -- the workspace (launcher, installer), the app, SAIPEN and
 * SAIMAIL. Each row updates on its own, by hand or by itself; local work in a
 * clone is never touched (it is reported and left as it is).
 */

const STATUS_TEXT: Record<ZaicodeUpdateStatus, { label: string; tone: "good" | "news" | "warn" | "dim" | "bad" }> = {
  current: { label: "up to date", tone: "good" },
  available: { label: "update ready", tone: "news" },
  updated: { label: "updated", tone: "good" },
  ahead: { label: "newer than GitHub", tone: "dim" },
  diverged: { label: "local commits", tone: "warn" },
  "local-changes": { label: "local changes kept", tone: "warn" },
  missing: { label: "not in this install", tone: "dim" },
  offline: { label: "GitHub not reached", tone: "warn" },
  failed: { label: "failed", tone: "bad" },
};

const TONE: Record<"good" | "news" | "warn" | "dim" | "bad", string> = {
  good: "text-[var(--color-success)]",
  news: "text-[var(--zaicode-highlight,var(--color-warning))]",
  warn: "text-[var(--color-warning)]",
  dim: "text-foreground-subtlest",
  bad: "text-[var(--color-destructive)]",
};

function ago(at: number | null): string {
  if (!at) return "never";
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : new Date(at).toLocaleDateString();
}

function Row({
  entry,
  auto,
  busy,
  managed,
}: {
  entry: ZaicodeUpdateComponent;
  auto: boolean;
  busy: boolean;
  managed: boolean;
}) {
  const status = STATUS_TEXT[entry.status];
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 py-2 first:border-t-0" data-zaicode-update-component={entry.id} data-status={entry.status}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-40 text-ui-sm text-foreground">{entry.title}</span>
        <span className="text-ui-xs tabular-nums text-foreground-subtle" title={entry.head ?? ""}>
          {entry.version !== "unknown" ? entry.version : ""}
          {entry.head ? ` · ${entry.head.slice(0, 8)}` : ""}
          {entry.branch ? ` · ${entry.branch}` : ""}
        </span>
        <span className={cn("text-ui-xs", TONE[status.tone])} title={entry.detail}>
          {busy ? "working…" : status.label}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1 text-ui-xs text-foreground-subtle" title={managed ? "Update this part by itself when something new is out" : "A developer checkout: turn on only if these clones hold no work of yours"}>
            <Switch checked={auto} onCheckedChange={(checked) => void setZaicodeUpdateAuto(entry.id, checked)} aria-label={`Update ${entry.title} by itself`} />
            by itself
          </label>
          <Button size="sm" variant="outline" disabled={busy || entry.status !== "available"} onClick={() => void applyZaicodeUpdates([entry.id])}>
            Update
          </Button>
        </span>
      </div>
      {entry.detail && entry.status !== "current" ? <p className="text-ui-xs text-foreground-subtlest">{entry.detail}</p> : null}
      {entry.subjects.length > 0 && entry.status === "available" ? (
        <ul className="ml-3 list-disc text-ui-xs text-foreground-subtle">
          {entry.subjects.map((line, index) => (
            <li key={index} className="truncate">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ZaicodeUpdatesSettings() {
  const state = useZaicodeUpdates((store) => store.state);
  const error = useZaicodeUpdates((store) => store.error);
  if (!zaicodeUpdatesAvailable()) return null;
  const busy = state?.busy ?? null;
  const busyIds = new Set<ZaicodeUpdateComponentId>(state?.busyComponents ?? []);
  const ready = (state?.components ?? []).filter((entry) => entry.status === "available");
  return (
    <section className="border border-border bg-card p-4" data-zaicode-updates>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-ui-lg text-foreground">Updates: ZAICODE, SAIPEN, SAIMAIL</h2>
        <span className="text-ui-xs text-foreground-subtlest">
          checked {ago(state?.lastCheckAt ?? null)}
          {state?.lastUpdateAt ? ` · last update ${ago(state.lastUpdateAt)}` : ""}
        </span>
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" disabled={Boolean(busy) || !state?.installRoot} onClick={() => void checkZaicodeUpdates()}>
            {busy === "check" ? "Checking…" : "Check now"}
          </Button>
          <Button size="sm" disabled={Boolean(busy) || ready.length === 0} onClick={() => void applyZaicodeUpdates(ready.map((entry) => entry.id))}>
            {busy === "update" ? "Updating…" : ready.length > 1 ? `Update all (${ready.length})` : "Update all"}
          </Button>
        </span>
      </div>
      <p className="mt-1 text-ui-xs text-foreground-subtle">
        Four parts, four GitHub repositories, one ZAICODE. Each one updates on its own: by hand here, or by itself (checked a few
        minutes after the start and every six hours). A new app build is prepared while ZAICODE runs and starts with the next start;
        SAIPEN and SAIMAIL apply at once. Your own edits in a clone are never overwritten.
      </p>
      {state && !state.managed && state.installRoot ? (
        <p className="mt-1 text-ui-xs text-[var(--color-warning)]">
          Developer checkout ({state.installRoot}): updates only report here unless you switch a part to "by itself".
        </p>
      ) : null}
      {state?.error || error ? <p className="mt-1 text-ui-xs text-[var(--color-destructive)]">{state?.error ?? error}</p> : null}
      <div className="mt-2">
        {(state?.components ?? []).length === 0 ? (
          <p className="text-ui-xs text-foreground-subtlest">{busy ? "Asking GitHub…" : "Not checked yet: press Check now."}</p>
        ) : (
          state!.components.map((entry) => (
            <Row key={entry.id} entry={entry} auto={state!.auto[entry.id]} busy={busyIds.has(entry.id)} managed={state!.managed} />
          ))
        )}
      </div>
    </section>
  );
}
