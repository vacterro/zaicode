import { useZaicodeEngines } from "./zaicodeEngines.js";
import { zaicodeWorkerQuota } from "./zaicodeWorkerQuota.js";
import { cn } from "@/components/lib/utils.js";
import { useEffect, useState } from "react";

export function ZaicodeWorkerQuotaMeters({ accountId, now }: { accountId: string | null; now: number }) {
  const engines = useZaicodeEngines();
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!accountId) return;
    // 已退出 worker 的执行时钟会冻结，限额读数仍必须继续老化，不能永远显示健康。
    const timer = window.setInterval(() => setClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [accountId]);
  if (!accountId) return null;
  const meters = zaicodeWorkerQuota(engines.limits[accountId], Math.max(now, clock, Date.now()), Math.max(15, engines.config.intervalMinutes * 3) * 60_000);
  return (
    <span className="grid shrink-0 grid-cols-2 items-center gap-x-1 gap-y-0.5" data-zaicode-worker-quota={accountId}>
      {meters.map((meter) => (
        <span key={meter.key} className="inline-flex shrink-0 items-center gap-0.5 text-ui-xs" title={meter.detail}>
          <span className="text-foreground-subtle">{meter.label}</span>
          <span role="progressbar" aria-label={meter.detail} aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter.percent ?? undefined} aria-valuetext={meter.percent === null ? meter.state : `${Math.round(meter.percent)}% remaining`} data-quota-state={meter.state} className={cn("relative inline-block h-1.5 w-7 overflow-hidden border border-border bg-hover", meter.percent === 0 && "border-destructive bg-destructive/40", meter.percent === null && "border-dashed opacity-50")}>
            {meter.percent !== null ? <span className="absolute inset-y-0 left-0" style={{ width: `${meter.percent}%`, background: meter.label === "5h" ? "var(--zaicode-highlight,var(--color-brand))" : "var(--color-foreground-subtle)" }} /> : null}
          </span>
          {meter.percent === 0 ? <span className="text-destructive">0</span> : null}
        </span>
      ))}
    </span>
  );
}
