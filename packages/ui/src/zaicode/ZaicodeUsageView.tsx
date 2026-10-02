import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { getZaicodeRouterBridge } from "./zaicodeRouter.js";
import {
  normalizeZaicodeUsage,
  normalizeZaicodeUsageChart,
  openZaicodeUsage,
  toggleZaicodeUsageSidebar,
  useZaicodeUsage,
  ZAICODE_USAGE_PERIODS,
  type UsageCount,
} from "./zaicodeUsage.js";

const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });
const cost = (value: number) => `$${value.toFixed(4)}`;

export function ZaicodeUsageView({ sidebar = false }: { sidebar?: boolean }) {
  const period = useZaicodeUsage((state) => state.period);
  const [revision, setRevision] = useState(0);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [data, setData] = useState<ReturnType<typeof normalizeZaicodeUsage> | null>(null);
  const [chart, setChart] = useState<ReturnType<typeof normalizeZaicodeUsageChart>>([]);
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [tab, setTab] = useState<"recent" | "models" | "providers" | "accounts">("recent");

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
          if (auto) timer = setTimeout(() => void read(), 10_000);
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
  }, [auto, period, revision]);

  const totals = data?.totals;
  const values = chart.map((row) => row[metric]);
  const peak = Math.max(1, ...values);
  const points = values
    .map(
      (value, index) =>
        `${(index * 600) / Math.max(1, values.length - 1)},${110 - (value * 100) / peak}`,
    )
    .join(" ");
  const rows: UsageCount[] = data ? (tab === "recent" ? data.recent : data[tab]) : [];

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
          onClick={() => (sidebar ? openZaicodeUsage("page") : toggleZaicodeUsageSidebar())}
        >
          {sidebar ? "Full page" : "Sidebar"}
        </Button>
        <Button size="sm" onClick={() => openZaicodeUsage("closed")}>
          Close
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="mb-2 text-ui-xs text-foreground-subtle">
          All traffic through this 9router, including ZAICODE and other clients.
        </p>
        <div className="mb-2 flex flex-wrap items-center gap-1" aria-label="Usage period">
          {ZAICODE_USAGE_PERIODS.map((value) => (
            <Button
              key={value}
              size="sm"
              aria-pressed={period === value}
              onClick={() => useZaicodeUsage.setState({ period: value })}
            >
              {value === "today" ? "Today" : value === "all" ? "All" : value.toUpperCase()}
            </Button>
          ))}
          <Button size="sm" disabled={loading} onClick={() => setRevision((value) => value + 1)}>
            Refresh
          </Button>
          <label className="flex items-center gap-1 text-ui-xs">
            <input
              type="checkbox"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
            />
            Live · 10s
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
            <div key={label} className="min-w-0 border border-border bg-surface p-2">
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
              <p key={index} className="break-all text-ui-xs">
                {row.provider} / {row.name} · {row.requests} running
              </p>
            ))}
          </div>
        ) : null}
        <div className="mb-3 border border-border p-2">
          <div className="flex gap-1">
            <Button
              size="sm"
              aria-pressed={metric === "tokens"}
              onClick={() => setMetric("tokens")}
            >
              Tokens
            </Button>
            <Button size="sm" aria-pressed={metric === "cost"} onClick={() => setMetric("cost")}>
              Cost
            </Button>
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
            <Button
              key={value}
              role="tab"
              aria-selected={tab === value}
              size="sm"
              onClick={() => setTab(value)}
            >
              {value === "recent"
                ? "Recent requests"
                : value.charAt(0).toUpperCase() + value.slice(1)}
            </Button>
          ))}
        </div>
        <div className="max-w-full overflow-x-auto border border-border" role="tabpanel">
          <table className="w-full text-left text-ui-xs tabular-nums">
            <thead>
              <tr>
                <th className="p-1">{tab === "recent" ? "Model / status" : "Name"}</th>
                <th className="p-1">{tab === "recent" ? "Time" : "Requests"}</th>
                <th className="p-1">Input</th>
                <th className="p-1">Output</th>
                <th className="p-1">Cached</th>
                {tab !== "recent" ? <th className="p-1">Cost</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.name}:${index}`} className="border-t border-border">
                  <td className="max-w-60 break-all p-1" title={row.name}>
                    {row.name}
                    {tab === "recent" && data ? (
                      <span className="block text-foreground-subtle">
                        {data.recent[index]?.provider} · {data.recent[index]?.status}
                      </span>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap p-1">
                    {tab === "recent" && data
                      ? new Date(data.recent[index]!.timestamp).toLocaleTimeString()
                      : number(row.requests)}
                  </td>
                  <td className="p-1">{number(row.input)}</td>
                  <td className="p-1">{number(row.output)}</td>
                  <td className="p-1">{number(row.cached)}</td>
                  {tab !== "recent" ? <td className="p-1">{cost(row.cost)}</td> : null}
                </tr>
              ))}
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
          onClick={() => void getZaicodeRouterBridge()?.openZaicodeRouterDashboard?.("usage")}
        >
          Open 9router dashboard
        </Button>
      </div>
    </section>
  );
}
