import { formatZaicodeWindowReset, type ZaicodeLimitSnapshot } from "@zcode/shared";

export interface ZaicodeWorkerQuota {
  key: string;
  label: "5h" | "W";
  state: "known" | "unknown" | "stale";
  percent: number | null;
  detail: string;
}

/** Vendor observations only: crossing a reset is not proof of refill. */
export function zaicodeWorkerQuota(snapshot: ZaicodeLimitSnapshot | undefined, now: number, staleMs = 15 * 60_000): ZaicodeWorkerQuota[] {
  const windows = snapshot?.windows.filter((window) => /^(five_hour|weekly)(?:@|$|_)/.test(window.key)) ?? [];
  if (!windows.length) return ["5h", "W"].map((label) => ({ key: label, label: label as "5h" | "W", state: "unknown", percent: null, detail: `${label === "W" ? "Weekly" : label} quota unknown — no vendor observation` }));
  return windows.map((window) => {
    const label = window.key.startsWith("five_hour") ? "5h" : "W";
    const raw = window.remainingPercent;
    const stale = Boolean(snapshot?.error || snapshot?.fetchedAt === null || now - (snapshot?.fetchedAt ?? 0) > staleMs || (window.resetsAt !== null && now >= window.resetsAt && !window.startsOnUse));
    // 全局限额视图可以标注推测 refill；worker 的健康条不能把推测当成厂商余额。
    const unknown = window.assumedFull || raw === null || !Number.isFinite(raw);
    const state = unknown ? "unknown" : stale ? "stale" : "known";
    const percent = state === "known" ? Math.min(100, Math.max(0, raw!)) : null;
    const detail = `${window.groupLabel ? `${window.groupLabel} · ` : ""}${window.label}: ${state === "known" ? `${Math.round(percent!)}% remaining` : `${state}${raw !== null ? ` (last reported ${Math.round(raw)}%)` : ""}`} · ${formatZaicodeWindowReset(window, now)}${snapshot?.error ? ` · ${snapshot.error}` : ""}`;
    return { key: window.key, label, state, percent, detail };
  });
}
