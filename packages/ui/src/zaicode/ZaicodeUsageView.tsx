/* eslint-disable max-lines -- The 9router usage page reads as one panel: the live meter, its refresh rate, the trend and the breakdown table all poll the same snapshot. Splitting the table alone would leave the refresh state here and the rows in a sibling file. */
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { ArrowDown, ArrowUp, Database } from "lucide-react";
import {
  normalizeZaicodeRouterConnections,
  normalizeZaicodeRouterNodes,
  type ZaicodeOptimizationFindingDto,
  type ZaicodeOptimizationSummaryDto,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZaicodeCurrentWorkspace } from "./zaicodeEngines.js";
import { useZaicodeSessionNav } from "./zaicodeSessionNav.js";
import { useZaicodeSessionBriefs } from "./zaicodeContinue.js";
import { getZaicodeRouterBridge, useZaicodeRouter } from "./zaicodeRouter.js";
import {
  buildZaicodeUsageLabels,
  displayZaicodeUsageBreakdown,
  zaicodeUsageDisplayName,
  zaicodeUsageStatus,
  formatZaicodeUsageCount as number,
  formatZaicodeUsageCost as cost,
  formatZaicodeUsageExactCount as exactNumber,
} from "./zaicodeUsageLabels.js";
import {
  normalizeZaicodeUsage,
  normalizeZaicodeUsageChart,
  zaicodeUsageRouterProviderIds,
  zaicodeUsageSince,
  openZaicodeUsage,
  toggleZaicodeUsageSidebar,
  useZaicodeUsage,
  zaicodeUsageNameColumnPercent,
  zaicodeUsageRowNeedsWarning,
  formatRecentAgo,
  formatRecentTime,
  formatZaicodeUsageUpdated,
  zaicodeUsageFreshness,
  ZAICODE_USAGE_DEFAULT_REFRESH_SECONDS,
  ZAICODE_USAGE_PERIODS,
  ZAICODE_USAGE_REFRESH_SECONDS,
  type UsageCount,
  type ZaicodeUsageRefreshSeconds,
} from "./zaicodeUsage.js";
import { ZaicodeUsageEfficiency } from "./ZaicodeUsageEfficiency.js";

function UsageChoice({
  selected,
  ...props
}: ComponentProps<typeof Button> & { selected: boolean }) {
  return (
    <Button
      {...props}
      variant="ghost"
      size="sm"
      className={cn(
        "border text-ui-caption",
        selected
          ? "border-border-hover bg-selected text-foreground"
          : "border-transparent text-foreground-subtle",
        props.className,
      )}
    />
  );
}

export function ZaicodeUsageView({ sidebar = false }: { sidebar?: boolean }) {
  const period = useZaicodeUsage((state) => state.period);
  const scope = useZaicodeUsage((state) => state.scope);
  const recentTimeFormat = useZaicodeUsage((state) => state.recentTimeFormat);
  const setRecentTimeFormat = useZaicodeUsage((state) => state.setRecentTimeFormat);
  const detailedDiagnostics = useZaicodeUsage((state) => state.detailedDiagnostics);
  const setDetailedDiagnostics = useZaicodeUsage((state) => state.setDetailedDiagnostics);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const services = useOptionalServices();
  const workspace = useZaicodeCurrentWorkspace();
  const activeSessionId = useZaicodeSessionNav((state) => state.activeTaskId);
  const briefs = useZaicodeSessionBriefs((state) => state.sessions);
  const workspaceKey = workspace?.identity?.trim() || workspace?.path;
  const focusedSession = briefs.find((brief) => brief.sessionId === activeSessionId && brief.projectKey === workspaceKey);
  const projectPath = focusedSession?.workspacePath ?? workspace?.path ?? null;
  const sessionId = focusedSession?.sessionId ?? null;
  const scoped = scope !== "global";
  const [revision, setRevision] = useState(0);
  const [auto, setAuto] = useState(true);
  const [refreshSeconds, setRefreshSeconds] = useState<ZaicodeUsageRefreshSeconds>(
    ZAICODE_USAGE_DEFAULT_REFRESH_SECONDS,
  );
  // The model name is the column a long model ID hides in; the user drags it wider.
  const nameColumnPercent = useZaicodeUsage((state) => state.nameColumnPercent);
  const setNameColumnPercent = useZaicodeUsage((state) => state.setNameColumnPercent);
  const tableRef = useRef<HTMLTableElement>(null);
  // A first reading has nothing to show yet; every later one is a silent
  // background refresh that must not blank the meter or flash a status line.
  const [firstLoad, setFirstLoad] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failures, setFailures] = useState(0);
  const hasSnapshot = useRef(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [data, setData] = useState<ReturnType<typeof normalizeZaicodeUsage> | null>(null);
  const [chart, setChart] = useState<ReturnType<typeof normalizeZaicodeUsageChart>>([]);
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [tab, setTab] = useState<
    "recent" | "models" | "providers" | "accounts" | "efficiency"
  >("recent");
  const [optimizationSummary, setOptimizationSummary] =
    useState<ZaicodeOptimizationSummaryDto | null>(null);
  const [optimizationFindings, setOptimizationFindings] = useState<
    ZaicodeOptimizationFindingDto[]
  >([]);
  const [optimizationLoading, setOptimizationLoading] = useState(false);
  const [labels, setLabels] = useState(() => {
    const router = useZaicodeRouter.getState();
    return buildZaicodeUsageLabels(router.nodes, router.connections);
  });

  useEffect(() => {
    hasSnapshot.current = false;
    setData(null);
    setChart([]);
    setUpdatedAt(0);
    setError("");
    setFailures(0);
    setFirstLoad(true);
    setRefreshing(false);
    setOptimizationSummary(null);
    setOptimizationFindings([]);
    if (scope !== "global") setMetric("tokens");
  }, [scope, projectPath, sessionId]);

  // One slow tick ages the freshness dot even when polling is off or failing.
  // Deliberately far slower than the poll, so the 1s option never re-renders
  // this panel twice per second just to repaint a colour.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let disposed = false;
    const bridge = getZaicodeRouterBridge();
    if (!bridge?.callZaicodeRouter) return;
    // Names are metadata: read once per view, separately from the live metrics.
    void Promise.allSettled([
      bridge.callZaicodeRouter({ method: "GET", path: "/api/provider-nodes" }),
      bridge.callZaicodeRouter({ method: "GET", path: "/api/providers" }),
    ]).then(([nodes, connections]) => {
      if (disposed) return;
      const router = useZaicodeRouter.getState();
      setLabels(
        buildZaicodeUsageLabels(
          nodes.status === "fulfilled" && nodes.value.ok
            ? normalizeZaicodeRouterNodes(nodes.value.data)
            : router.nodes,
          connections.status === "fulfilled" && connections.value.ok
            ? normalizeZaicodeRouterConnections(connections.value.data)
            : router.connections,
        ),
      );
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    const readOptimization = async () => {
      // Only the efficiency tab shows these, and a read walks the whole event
      // table: an operator who never opens the tab never pays for it.
      if (tab !== "efficiency") return;
      if (!services?.zaicodeOptimizationService) return;
      setOptimizationLoading(true);
      try {
        const days = period === "today" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : 60;
        const filter = {
          project: scope === "global" ? null : projectPath,
          sessionId: scope === "session" ? sessionId : null,
          days,
        };
        const [summary, findings] = await Promise.all([
          services.zaicodeOptimizationService.getSummary(filter),
          services.zaicodeOptimizationService.getFindings({
            project: filter.project,
            sessionId: filter.sessionId,
          }),
        ]);
        if (!disposed) {
          setOptimizationSummary(summary);
          setOptimizationFindings(findings);
        }
      } catch {
        // Optimization errors never break usage reading
      } finally {
        if (!disposed) setOptimizationLoading(false);
      }
    };
    const read = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      inFlight = true;
      if (hasSnapshot.current) setRefreshing(true);
      else setFirstLoad(true);
      setNow(Date.now());
      void readOptimization();
      try {
        if (scope !== "global") {
          if (!projectPath || (scope === "session" && !sessionId)) throw new Error(scope === "session" ? "Open a session to see its router usage." : "Open a project to see its router usage.");
          if (!services?.zaicodeStatsService) throw new Error("Recorded router usage is unavailable in this workspace.");
          const view = await services.providerSettingsService.getView();
          const result = await services.zaicodeStatsService.getRouterUsage({
            providerIds: zaicodeUsageRouterProviderIds(view, useZaicodeRouter.getState().info?.url),
            project: projectPath, sessionId: scope === "session" ? sessionId : null, since: zaicodeUsageSince(period, Date.now()),
          });
          if (disposed) return;
          const stamp = Date.now();
          const names = new Map(view.providers.map((provider) => [provider.providerId, provider.providerName || provider.providerId]));
          const projected = normalizeZaicodeUsage(result.stats);
          projected.providers = projected.providers.map((row) => ({ ...row, name: names.get(row.name) ?? row.name }));
          projected.accounts = projected.accounts.map((row) => ({ ...row, name: names.get(row.name) ?? row.name }));
          hasSnapshot.current = true;
          setData(projected); setChart(normalizeZaicodeUsageChart(result.chart)); setError(""); setUpdatedAt(stamp); setNow(stamp); setFailures(0);
          return;
        }
        const bridge = getZaicodeRouterBridge();
        if (!bridge?.callZaicodeRouter)
          throw new Error("Usage requires the ZAICODE desktop connection to 9router.");
        const [stats, trend] = await Promise.all([
          bridge.callZaicodeRouter({ method: "GET", path: `/api/usage/stats?period=${period}` }),
          bridge.callZaicodeRouter({
            method: "GET",
            path: `/api/usage/chart?period=${period === "all" ? "60d" : period}`,
          }),
        ]);
        if (disposed) return;
        if (!stats.ok) throw new Error(stats.message || "9router usage is unavailable.");
        hasSnapshot.current = true;
        setData(normalizeZaicodeUsage(stats.data));
        setChart(trend.ok ? normalizeZaicodeUsageChart(trend.data) : []);
        setError(trend.ok ? "" : `Trend unavailable: ${trend.message}`);
        const stamp = Date.now();
        setUpdatedAt(stamp); setNow(stamp); setFailures(0);
      } catch (failure) {
        if (!disposed) {
          setError(failure instanceof Error ? failure.message : String(failure));
          setFailures((count) => count + 1);
        }
      } finally {
        inFlight = false;
        if (!disposed) {
          setFirstLoad(false);
          setRefreshing(false);
          if (auto) timer = setTimeout(() => void read(), refreshSeconds * 1000);
        }
      }
    };
    const visible = () => {
      if (auto && document.visibilityState === "visible") void read();
    };
    void read();
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [auto, period, refreshSeconds, revision, scope, projectPath, sessionId, services, tab]);

  const resizeNameColumn = useCallback((clientX: number) => {
    const table = tableRef.current;
    if (!table) return;
    const box = table.getBoundingClientRect();
    setNameColumnPercent(
      zaicodeUsageNameColumnPercent({
        clientX,
        tableLeft: box.left,
        tableWidth: box.width,
        current: useZaicodeUsage.getState().nameColumnPercent,
      }),
    );
  }, [setNameColumnPercent]);

  const totals = data?.totals;
  // The status line is one fixed strip: a colour-coded freshness dot plus a
  // label that only ever moves once a minute, so a background poll cannot make
  // the header jump or flash the word "reading" at the operator.
  const freshness = zaicodeUsageFreshness(updatedAt, now);
  const statusText = firstLoad
    ? "Reading usage…"
    : updatedAt
      ? `Updated ${formatZaicodeUsageUpdated(updatedAt)}`
      : error
        ? "9router is not answering"
        : "Waiting for 9router";
  const statusDot =
    freshness === "fresh"
      ? "bg-emerald-500"
      : freshness === "stale"
        ? "bg-amber-500"
        : "bg-foreground/30";
  const statusTitle = firstLoad
    ? "Reading 9router for the first time."
    : updatedAt
      ? `${freshness === "fresh" ? "Fresh" : "Getting old"} — last successful reading at ${formatZaicodeUsageUpdated(updatedAt)}.`
      : "No successful reading yet.";
  const values = chart.map((row) => row[metric]);
  const peak = Math.max(1, ...values);
  const points = values
    .map(
      (value, index) =>
        `${(index * 600) / Math.max(1, values.length - 1)},${110 - (value * 100) / peak}`,
    )
    .join(" ");
  const rows: UsageCount[] = data
    ? tab === "recent"
      ? data.recent
      : tab === "efficiency"
        ? []
        : displayZaicodeUsageBreakdown(data[tab], tab, labels)
    : [];

  return (
    <section
      data-zaicode-help="usage"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      data-zaicode-usage={sidebar ? "sidebar" : "page"}
      aria-label="9router Usage"
    >
      {/* The fixed global copy starts right under the window caption, where
          Electron treats the top strip as a window-drag area and swallows the
          click before the button sees it. Marking the whole row no-drag keeps
          Full page / Close live in that copy too. */}
      <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border p-2 pointer-events-auto [app-region:no-drag]">
        <strong className="mr-2">9router Usage</strong>
        <span
          data-zaicode-usage-scope-badge={scope}
          className={cn(
            "px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded border",
            scope === "global"
              ? "border-sky-500/40 bg-sky-500/10 text-sky-400"
              : scope === "project"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                : "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
          )}
        >
          {scope.toUpperCase()}
        </span>
        <div className="mr-auto" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => (sidebar ? openZaicodeUsage("page") : toggleZaicodeUsageSidebar())}
        >
          {sidebar ? "Full page" : "Sidebar"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openZaicodeUsage("closed")}>
          Close
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="mb-2 text-ui-caption text-foreground-subtle">
          {scoped ? (
            <>
              Recorded 9router traffic for this {scope}. Unmonitored direct provider routes bypass 9router. Unattributed traffic remains in{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground inline cursor-pointer"
                onClick={() => useZaicodeUsage.setState({ scope: "global" })}
              >
                Global
              </button>
              .
            </>
          ) : (
            "All traffic through this 9router, including ZAICODE and other clients."
          )}
        </p>
        <div className="mb-2 flex flex-wrap items-center gap-1" aria-label="Usage scope">
          {(["global", "project", "session"] as const).map((value) => <UsageChoice key={value} selected={scope === value}
            aria-pressed={scope === value} disabled={value === "project" ? !projectPath : value === "session" ? !sessionId : false}
            title={value === "project" ? projectPath ?? "Open a project" : value === "session" ? sessionId ?? "Open a session" : "All 9router clients"}
            onClick={() => useZaicodeUsage.setState({ scope: value })}>{value === "global" ? "Global" : value === "project" ? "Project" : "Session"}</UsageChoice>)}
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-1" aria-label="Usage period">
          {ZAICODE_USAGE_PERIODS.map((value) => (
            <UsageChoice
              key={value}
              selected={period === value}
              aria-pressed={period === value}
              onClick={() => useZaicodeUsage.setState({ period: value })}
            >
              {value === "today" ? "Today" : value === "all" ? "All" : value.toUpperCase()}
            </UsageChoice>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={firstLoad}
            aria-busy={refreshing}
            data-zaicode-usage-refresh-pending={refreshing ? "yes" : "no"}
            title={
              refreshing
                ? "Refreshing the reading now."
                : "Read the router again now (live polling continues on its own interval)."
            }
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh
          </Button>
          <label className="flex items-center gap-1 text-ui-caption cursor-pointer select-none">
            <Checkbox
              checked={auto}
              onCheckedChange={(val) => setAuto(Boolean(val))}
            />
            Live ·
            <select
              aria-label="Live refresh interval"
              data-zaicode-usage-refresh
              className="border border-border bg-background text-ui-caption"
              disabled={!auto}
              value={refreshSeconds}
              onChange={(event) => {
                const next = Number(event.target.value);
                if ((ZAICODE_USAGE_REFRESH_SECONDS as readonly number[]).includes(next)) {
                  setRefreshSeconds(next as ZaicodeUsageRefreshSeconds);
                }
              }}
            >
              {ZAICODE_USAGE_REFRESH_SECONDS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds}s
                </option>
              ))}
            </select>
          </label>
        </div>
        <p
          className="mb-2 flex min-h-[1rem] items-center gap-1.5 text-ui-caption"
          aria-live="polite"
          data-zaicode-usage-status={firstLoad ? "loading" : freshness}
        >
          <span
            aria-hidden="true"
            title={statusTitle}
            data-zaicode-usage-freshness={freshness}
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              statusDot,
              refreshing && "motion-safe:animate-pulse",
            )}
          />
          <span className="truncate">{statusText}</span>
        </p>
        {error ? (
          <p role="alert" className="mb-2 border border-destructive p-2 text-destructive">
            {error}
            {failures >= 3 ? " · 9router has missed several readings in a row." : ""}
            {updatedAt ? " · Showing the last successful reading." : ""}
          </p>
        ) : null}
        <div
          className={cn(
            "mb-3 grid gap-1.5",
            sidebar ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
          )}
        >
          <div className="min-w-0 border border-border p-2 bg-surface/30">
            <span className="block text-ui-caption text-foreground-subtle" title="Total completed model requests">
              Requests
            </span>
            <strong className="break-all tabular-nums text-ui-base font-semibold block" title={totals ? exactNumber(totals.requests) : undefined}>
              {totals?.requests === undefined ? "—" : number(totals.requests)}
            </strong>
          </div>
          <div className="min-w-0 border border-border p-2 bg-surface/30">
            <span
              className="inline-flex items-center gap-1 text-ui-caption text-foreground-subtle"
              title="Input tokens: prompt context sent to model (incoming direction)"
            >
              <ArrowDown className="size-3 text-sky-500 shrink-0" aria-label="Input direction" />
              <span>Input</span>
            </span>
            <strong className="break-all tabular-nums text-ui-base font-semibold block">
              {totals?.input === undefined ? "—" : number(totals.input)}
            </strong>
          </div>
          <div className="min-w-0 border border-border p-2 bg-surface/30">
            <span
              className="inline-flex items-center gap-1 text-ui-caption text-foreground-subtle"
              title="Cached tokens: reused prompt cache (cache read/write)"
            >
              <Database className="size-3 text-amber-500 shrink-0" aria-label="Cache indicator" />
              <span>Cached</span>
            </span>
            <strong className="break-all tabular-nums text-ui-base font-semibold block">
              {totals?.cached === undefined ? "—" : number(totals.cached)}
            </strong>
          </div>
          <div className="min-w-0 border border-border p-2 bg-surface/30">
            <span
              className="inline-flex items-center gap-1 text-ui-caption text-foreground-subtle"
              title="Output tokens: completion generated by model (outgoing direction)"
            >
              <ArrowUp className="size-3 text-emerald-500 shrink-0" aria-label="Output direction" />
              <span>Output</span>
            </span>
            <strong className="break-all tabular-nums text-ui-base font-semibold block">
              {totals?.output === undefined ? "—" : number(totals.output)}
            </strong>
          </div>
          <div
            className={cn(
              "min-w-0 border border-border p-2 bg-surface/30",
              sidebar && "col-span-2 sm:col-span-1",
            )}
          >
            <span className="block text-ui-caption text-foreground-subtle" title="Estimated cost in USD">
              Estimated cost
            </span>
            <strong className="break-all tabular-nums text-ui-base font-semibold block">
              {scoped || totals?.cost === undefined ? "—" : cost(totals.cost)}
            </strong>
          </div>
        </div>
        <p className="mb-2 text-ui-caption text-foreground-subtle">{scoped ? "Cost is unmeasured for recorded project and session traffic." : "Cost is an estimate, not a bill."}</p>
        {data?.active.length ? (
          <div className="mb-3 border border-border p-2">
            <strong className="text-ui-caption block mb-1">
              {scoped
                ? `Active requests (Global 9router · not filtered to current ${scope})`
                : "Active requests"}
            </strong>
            {data.active.map((row, index) => (
              <p key={index} className="truncate text-ui-caption">
                {zaicodeUsageDisplayName(row.name, "models", labels)} · {row.requests} running
              </p>
            ))}
          </div>
        ) : null}
        <div className="mb-3 border border-border p-2">
          <div className="flex gap-1">
            <UsageChoice
              selected={metric === "tokens"}
              aria-pressed={metric === "tokens"}
              onClick={() => setMetric("tokens")}
            >
              Tokens
            </UsageChoice>
            <UsageChoice
              selected={metric === "cost"}
              disabled={scoped}
              aria-pressed={metric === "cost"}
              onClick={() => setMetric("cost")}
            >
              Cost
            </UsageChoice>
            {period === "all" ? <span className="text-ui-caption">Trend · last 60 days</span> : null}
          </div>
          <svg
            viewBox="0 0 600 120"
            className="mt-2 h-32 w-full"
            role="img"
            aria-label={`${metric} usage trend`}
          >
            <polyline points={points} fill="none" stroke="var(--color-warning)" strokeWidth="2" />
          </svg>
          <div className="flex justify-between items-center gap-1 text-ui-caption text-foreground-subtle">
            <span>{chart[0]?.label ?? "No trend data"}</span>
            <span className="font-medium">
              {(() => {
                if (chart.length < 2) return null;
                const half = Math.floor(chart.length / 2);
                const firstHalf = chart.slice(0, half).reduce((sum, item) => sum + item.tokens, 0);
                const secondHalf = chart.slice(half).reduce((sum, item) => sum + item.tokens, 0);
                const trend = secondHalf > firstHalf * 1.1 ? "rising" : secondHalf < firstHalf * 0.9 ? "declining" : "steady";
                return `Trend: ${trend} · `;
              })()}
              {metric === "cost" ? cost(peak) : number(peak)} peak
            </span>
            <span>{chart.at(-1)?.label}</span>
          </div>
        </div>
        <div className="mb-1 flex flex-wrap items-center gap-1" role="tablist" aria-label="Usage breakdown">
          {(["recent", "models", "providers", "accounts", "efficiency"] as const).map((value) => (
            <UsageChoice
              key={value}
              role="tab"
              selected={tab === value}
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {value === "recent"
                ? "Recent requests"
                : value === "efficiency"
                  ? "Efficiency"
                  : value.charAt(0).toUpperCase() + value.slice(1)}
            </UsageChoice>
          ))}
          {tab === "recent" ? (
            <label className="ml-auto flex items-center gap-1 text-ui-caption cursor-pointer select-none text-foreground-subtle">
              <Checkbox
                checked={detailedDiagnostics}
                onCheckedChange={(val) => setDetailedDiagnostics(Boolean(val))}
              />
              Detailed diagnostics
            </label>
          ) : null}
        </div>
        {tab === "efficiency" ? (
          <ZaicodeUsageEfficiency
            summary={optimizationSummary}
            findings={optimizationFindings}
            loading={optimizationLoading}
          />
        ) : (
          <div className="max-w-full overflow-x-auto border border-border" role="tabpanel">
            <table ref={tableRef} className="w-full min-w-[384px] table-fixed text-left text-ui-base tabular-nums">
            <thead className="bg-surface text-foreground-subtle text-ui-caption">
              <tr>
                <th
                  className="relative px-2 py-1 font-normal"
                  style={{ width: `${nameColumnPercent}%` }}
                >
                  {tab === "recent" ? "Model" : "Name"}
                  {/* The name column is the one a long model ID hides in, so it is the one
                      the user drags. Pointer capture keeps the drag on this handle. */}
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize name column"
                    data-zaicode-usage-column-resize
                    className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none select-none hover:bg-[var(--color-brand)]"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        resizeNameColumn(event.clientX);
                      }
                    }}
                  />
                </th>
                <th
                  className={cn("px-1 py-1 text-right font-normal", tab === "recent" && "w-[24%]")}
                >
                  {tab === "recent" ? (
                    <span className="inline-flex items-center justify-end gap-1">
                      <button
                        type="button"
                        className={cn(
                          "cursor-pointer px-1 py-0.5 rounded text-ui-caption transition-colors",
                          recentTimeFormat === "time"
                            ? "font-semibold text-foreground underline decoration-1 underline-offset-2"
                            : "text-foreground-subtle hover:text-foreground",
                        )}
                        title="Show local clock time (HH:mm:ss)"
                        aria-pressed={recentTimeFormat === "time"}
                        onClick={() => setRecentTimeFormat("time")}
                      >
                        Time
                      </button>
                      <span className="text-foreground-subtle/40 select-none">/</span>
                      <button
                        type="button"
                        className={cn(
                          "cursor-pointer px-1 py-0.5 rounded text-ui-caption transition-colors",
                          recentTimeFormat === "ago"
                            ? "font-semibold text-foreground underline decoration-1 underline-offset-2"
                            : "text-foreground-subtle hover:text-foreground",
                        )}
                        title="Show relative elapsed duration (e.g. 12s ago, 3m ago)"
                        aria-pressed={recentTimeFormat === "ago"}
                        onClick={() => setRecentTimeFormat("ago")}
                      >
                        Ago
                      </button>
                    </span>
                  ) : (
                    <span title="Requests">Req.</span>
                  )}
                </th>
                <th className="px-1 py-1 text-right font-normal" title="Input tokens sent to model">
                  <span className="inline-flex items-center justify-end gap-0.5">
                    <ArrowDown className="size-2.5 text-sky-500 shrink-0" aria-label="Input" />
                    <span>In</span>
                  </span>
                </th>
                <th className="px-1 py-1 text-right font-normal" title="Output tokens generated by model">
                  <span className="inline-flex items-center justify-end gap-0.5">
                    <ArrowUp className="size-2.5 text-emerald-500 shrink-0" aria-label="Output" />
                    <span>Out</span>
                  </span>
                </th>
                <th className="px-1 py-1 text-right font-normal" title="Cached tokens reused">
                  <span className="inline-flex items-center justify-end gap-0.5">
                    <Database className="size-2.5 text-amber-500 shrink-0" aria-label="Cached" />
                    <span>Cache</span>
                  </span>
                </th>
                {tab !== "recent" ? (
                  <th className="px-1 py-1 text-right font-normal">Cost</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                // Compact default: one line per request. Upstream IDs, fallback
                // receipts and correlation IDs live in the expandable detail
                // (or the diagnostics toggle), never as routine row noise.
                // Unknown upstream attribution is metadata, not a warning.
                const status =
                  tab === "recent" && data
                    ? zaicodeUsageStatus(data.recent[index]?.status ?? "")
                    : "";
                const recentItem = tab === "recent" && data ? data.recent[index] : null;
                const rowKey = `${row.name}:${index}`;
                const expanded = expandedRow === rowKey;
                const showDetail = detailedDiagnostics || expanded;
                const needsWarning = recentItem ? zaicodeUsageRowNeedsWarning(recentItem) : false;
                return (
                <tr key={rowKey} className="border-t border-border">
                  <td className="px-2 py-1" style={{ width: `${nameColumnPercent}%` }}>
                    {tab === "recent" && recentItem ? (
                      <button
                        type="button"
                        className="block w-full cursor-pointer truncate text-left font-medium hover:underline"
                        title={
                          `Requested: ${recentItem.comboId ?? row.name}\n` +
                          `Upstream: ${recentItem.upstreamProvider ? `${recentItem.upstreamProvider}/` : ""}${recentItem.upstreamModel ?? "unknown"}\n` +
                          `Click for full diagnostic detail`
                        }
                        aria-expanded={expanded}
                        onClick={() => setExpandedRow(expanded ? null : rowKey)}
                      >
                        {tab === "recent"
                          ? zaicodeUsageDisplayName(row.name, "models", labels)
                          : row.name}
                      </button>
                    ) : (
                    <span
                      className="block truncate font-medium"
                      title={
                        tab === "recent"
                          ? zaicodeUsageDisplayName(row.name, "models", labels)
                          : row.name
                      }
                    >
                      {tab === "recent"
                        ? zaicodeUsageDisplayName(row.name, "models", labels)
                        : row.name}
                    </span>
                    )}
                    {needsWarning ? (
                      <span className="block truncate text-destructive text-ui-caption" title={recentItem?.failure ?? recentItem?.fallbackReason ?? status}>
                        ⚠ {recentItem?.failure || status || "Failed"}
                      </span>
                    ) : status ? (
                      <span className="block text-foreground-subtle">{status}</span>
                    ) : null}
                    {tab === "recent" && recentItem && showDetail ? (
                      <div className="flex flex-col gap-0.5 mt-0.5 text-foreground-subtle text-ui-caption">
                        <span
                          className="truncate"
                          title={
                            recentItem.upstreamModel
                              ? `Upstream: ${recentItem.upstreamProvider ? `${recentItem.upstreamProvider}/` : ""}${recentItem.upstreamModel}`
                              : "No x-router-upstream-model header returned by 9router."
                          }
                        >
                          {recentItem.upstreamModel ? (
                            <>
                              <span className="opacity-70">Upstream: </span>
                              <span className="text-foreground">{recentItem.upstreamModel}</span>
                            </>
                          ) : (
                            <span className="opacity-70">Upstream: unknown</span>
                          )}
                        </span>
                        <span className="truncate opacity-70" title={`Requested combo: ${recentItem.comboId ?? row.name}`}>
                          Combo: {recentItem.comboId ?? row.name}
                        </span>
                        {recentItem.fallbackReason ? (
                          <span
                            className="text-amber-400 truncate"
                            title={`Fallback receipt: ${recentItem.fallbackReason}`}
                          >
                            Fallback: {recentItem.fallbackReason}
                          </span>
                        ) : null}
                        {recentItem.routerRequestId || recentItem.id ? (
                          <span
                            className="opacity-50 text-[10px] font-mono truncate"
                            title={`Correlation ID: ${recentItem.routerRequestId || recentItem.id}`}
                          >
                            req:{recentItem.routerRequestId || recentItem.id}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td
                    className="whitespace-nowrap px-1 py-1 text-right text-ui-caption"
                    title={recentItem ? new Date(recentItem.timestamp).toISOString() : exactNumber(row.requests)}
                  >
                    {recentItem
                      ? recentTimeFormat === "time"
                        ? formatRecentTime(recentItem.timestamp)
                        : formatRecentAgo(recentItem.timestamp)
                      : number(row.requests)}
                  </td>
                  <td className="whitespace-nowrap px-1 py-1 text-right text-ui-caption" title={exactNumber(row.input)}>{number(row.input)}</td>
                  <td className="whitespace-nowrap px-1 py-1 text-right text-ui-caption" title={exactNumber(row.output)}>{number(row.output)}</td>
                  <td className="whitespace-nowrap px-1 py-1 text-right text-ui-caption" title={exactNumber(row.cached)}>{number(row.cached)}</td>
                  {tab !== "recent" ? (
                    <td className="whitespace-nowrap px-1 py-1 text-right text-ui-caption" title={!scoped && row.cost > 0 ? `$${row.cost} USD` : undefined}>{scoped ? "—" : cost(row.cost)}</td>
                  ) : null}
                </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td className="p-3 text-center" colSpan={6}>
                    {firstLoad ? (
                      <span className="text-foreground-subtle">Reading usage…</span>
                    ) : data ? (
                      <div className="flex flex-col items-center justify-center gap-1.5 py-3 text-ui-caption">
                        <p className="font-semibold text-foreground">No requests in this period.</p>
                        {scoped ? (
                          <div className="max-w-md text-foreground-subtle space-y-1 text-center">
                            <p>
                              Direct provider routes bypass 9router. File edits, shell commands, and internal tool calls do not generate model API requests.
                            </p>
                            <p>
                              Router traffic without session attribution is preserved in Global.
                            </p>
                            <div className="pt-1.5">
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-ui-caption h-7 px-2.5"
                                onClick={() => useZaicodeUsage.setState({ scope: "global" })}
                              >
                                Inspect Global traffic
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-foreground-subtle">No router traffic recorded for this period.</p>
                        )}
                      </div>
                    ) : (
                      <span className="text-foreground-subtle">Usage has not loaded.</span>
                    )}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        )}
        <Button
          className="mt-2"
          size="sm"
          variant="ghost"
          onClick={() => void getZaicodeRouterBridge()?.openZaicodeRouterDashboard?.("usage")}
        >
          Open 9router dashboard
        </Button>
      </div>
    </section>
  );
}
