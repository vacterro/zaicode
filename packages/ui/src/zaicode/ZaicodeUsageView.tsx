/* eslint-disable max-lines -- The 9router usage page reads as one panel: the live meter, its refresh rate, the trend and the breakdown table all poll the same snapshot. Splitting the table alone would leave the refresh state here and the rows in a sibling file. */
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { normalizeZaicodeRouterConnections, normalizeZaicodeRouterNodes } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { getZaicodeRouterBridge, useZaicodeRouter } from "./zaicodeRouter.js";
import {
  buildZaicodeUsageLabels,
  displayZaicodeUsageBreakdown,
  zaicodeUsageDisplayName,
  zaicodeUsageStatus,
} from "./zaicodeUsageLabels.js";
import {
  normalizeZaicodeUsage,
  normalizeZaicodeUsageChart,
  openZaicodeUsage,
  toggleZaicodeUsageSidebar,
  useZaicodeUsage,
  zaicodeUsageNameColumnPercent,
  ZAICODE_USAGE_DEFAULT_REFRESH_SECONDS,
  ZAICODE_USAGE_PERIODS,
  ZAICODE_USAGE_REFRESH_SECONDS,
  type UsageCount,
  type ZaicodeUsageRefreshSeconds,
} from "./zaicodeUsage.js";

const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });
const cost = (value: number) => `$${value.toFixed(4)}`;

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
        "border text-ui-xs",
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
  const [revision, setRevision] = useState(0);
  const [auto, setAuto] = useState(true);
  const [refreshSeconds, setRefreshSeconds] = useState<ZaicodeUsageRefreshSeconds>(
    ZAICODE_USAGE_DEFAULT_REFRESH_SECONDS,
  );
  // The model name is the column a long model ID hides in; the user drags it wider.
  const [nameColumnPercent, setNameColumnPercent] = useState(34);
  const tableRef = useRef<HTMLTableElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [data, setData] = useState<ReturnType<typeof normalizeZaicodeUsage> | null>(null);
  const [chart, setChart] = useState<ReturnType<typeof normalizeZaicodeUsageChart>>([]);
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [tab, setTab] = useState<"recent" | "models" | "providers" | "accounts">("recent");
  const [labels, setLabels] = useState(() => {
    const router = useZaicodeRouter.getState();
    return buildZaicodeUsageLabels(router.nodes, router.connections);
  });

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
    const read = async () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      clearTimeout(timer);
      inFlight = true;
      setLoading(true);
      try {
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
        setData(normalizeZaicodeUsage(stats.data));
        setChart(trend.ok ? normalizeZaicodeUsageChart(trend.data) : []);
        setError(trend.ok ? "" : `Trend unavailable: ${trend.message}`);
        setUpdatedAt(Date.now());
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        inFlight = false;
        if (!disposed) {
          setLoading(false);
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
  }, [auto, period, refreshSeconds, revision]);

  const resizeNameColumn = useCallback((clientX: number) => {
    const table = tableRef.current;
    if (!table) return;
    const box = table.getBoundingClientRect();
    setNameColumnPercent((current) =>
      zaicodeUsageNameColumnPercent({
        clientX,
        tableLeft: box.left,
        tableWidth: box.width,
        current,
      }),
    );
  }, []);

  const totals = data?.totals;
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
      : displayZaicodeUsageBreakdown(data[tab], tab, labels)
    : [];

  return (
    <section
      data-zaicode-help="usage"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      data-zaicode-usage={sidebar ? "sidebar" : "page"}
      aria-label="9router Usage"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-2">
        <strong className="mr-auto">9router Usage</strong>
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
        <p className="mb-2 text-ui-xs text-foreground-subtle">
          All traffic through this 9router, including ZAICODE and other clients.
        </p>
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
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh
          </Button>
          <label className="flex items-center gap-1 text-ui-xs">
            <input
              type="checkbox"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
            />
            Live ·
            <select
              aria-label="Live refresh interval"
              data-zaicode-usage-refresh
              className="border border-border bg-background text-ui-xs"
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
        <p className="mb-2 text-ui-xs" aria-live="polite">
          {loading
            ? "Reading usage…"
            : updatedAt
              ? `Updated ${new Date(updatedAt).toLocaleTimeString()}`
              : "Waiting for 9router"}
        </p>
        {error ? (
          <p role="alert" className="mb-2 border border-destructive p-2 text-destructive">
            {error}
            {updatedAt ? " · Showing the last successful reading." : ""}
          </p>
        ) : null}
        <div
          className={cn("mb-3 grid gap-1", sidebar ? "grid-cols-2" : "grid-cols-2 lg:grid-cols-5")}
        >
          {(
            [
              ["Requests", totals?.requests],
              ["Input tokens", totals?.input],
              ["Cached tokens", totals?.cached],
              ["Output tokens", totals?.output],
              ["Estimated cost", totals?.cost],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="min-w-0 border border-border p-2">
              <span className="block text-ui-xs text-foreground-subtle">{label}</span>
              <strong className="break-all tabular-nums">
                {value === undefined
                  ? "—"
                  : label === "Estimated cost"
                    ? cost(value)
                    : number(value)}
              </strong>
            </div>
          ))}
        </div>
        <p className="mb-2 text-ui-xs text-foreground-subtle">Cost is an estimate, not a bill.</p>
        {data?.active.length ? (
          <div className="mb-3 border border-border p-2">
            <strong className="text-ui-xs">Active requests</strong>
            {data.active.map((row, index) => (
              <p key={index} className="truncate text-ui-xs">
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
              aria-pressed={metric === "cost"}
              onClick={() => setMetric("cost")}
            >
              Cost
            </UsageChoice>
            {period === "all" ? <span className="text-ui-xs">Trend · last 60 days</span> : null}
          </div>
          <svg
            viewBox="0 0 600 120"
            className="mt-2 h-32 w-full"
            role="img"
            aria-label={`${metric} usage trend`}
          >
            <polyline points={points} fill="none" stroke="var(--color-warning)" strokeWidth="2" />
          </svg>
          <div className="flex justify-between gap-1 text-ui-xs text-foreground-subtle">
            <span>{chart[0]?.label ?? "No trend data"}</span>
            <span>{metric === "cost" ? cost(peak) : number(peak)} peak</span>
            <span>{chart.at(-1)?.label}</span>
          </div>
        </div>
        <div className="mb-1 flex flex-wrap gap-1" role="tablist" aria-label="Usage breakdown">
          {(["recent", "models", "providers", "accounts"] as const).map((value) => (
            <UsageChoice
              key={value}
              role="tab"
              selected={tab === value}
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {value === "recent"
                ? "Recent requests"
                : value.charAt(0).toUpperCase() + value.slice(1)}
            </UsageChoice>
          ))}
        </div>
        <div className="max-w-full overflow-x-auto border border-border" role="tabpanel">
          <table ref={tableRef} className="w-full table-fixed text-left text-ui-xs tabular-nums">
            <thead className="bg-surface text-foreground-subtle">
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
                  className={cn("px-1 py-1 text-right font-normal", tab === "recent" && "w-[18%]")}
                >
                  {tab === "recent" ? "Time" : "Requests"}
                </th>
                <th className="px-1 py-1 text-right font-normal">Input</th>
                <th className="px-1 py-1 text-right font-normal">Output</th>
                <th className="px-1 py-1 text-right font-normal">Cached</th>
                {tab !== "recent" ? (
                  <th className="px-1 py-1 text-right font-normal">Cost</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                // Success says nothing; only a row that failed or is still running needs a
                // word under the name, so an empty status renders no line at all.
                const status =
                  tab === "recent" && data
                    ? zaicodeUsageStatus(data.recent[index]?.status ?? "")
                    : "";
                return (
                <tr key={`${row.name}:${index}`} className="border-t border-border">
                  <td className="px-2 py-1" style={{ width: `${nameColumnPercent}%` }}>
                    <span
                      className="block truncate"
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
                    {status ? (
                      <span className="block text-foreground-subtle">{status}</span>
                    ) : null}
                  </td>
                  <td className="break-all px-1 py-1 text-right text-foreground-subtle">
                    {tab === "recent" && data
                      ? new Date(data.recent[index]!.timestamp).toLocaleTimeString(undefined, {
                          hour12: false,
                        })
                      : number(row.requests)}
                  </td>
                  <td className="break-all px-1 py-1 text-right">{number(row.input)}</td>
                  <td className="break-all px-1 py-1 text-right">{number(row.output)}</td>
                  <td className="break-all px-1 py-1 text-right">{number(row.cached)}</td>
                  {tab !== "recent" ? (
                    <td className="break-all px-1 py-1 text-right">{cost(row.cost)}</td>
                  ) : null}
                </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td className="p-2" colSpan={6}>
                    {loading
                      ? "Reading…"
                      : data
                        ? "No requests in this period."
                        : "Usage has not loaded."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
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
