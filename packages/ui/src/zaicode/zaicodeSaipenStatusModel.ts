import { isZaicodeHumanBlocker, type ZaicodeProjectRuntimeVerdict } from "@zcode/shared";
import type { ZaicodeSaipenSnapshot } from "./zaicodeSaipenModel.js";

export function extractZaicodeSaipenResult(snapshot: ZaicodeSaipenSnapshot | null): string {
  if (!snapshot) return "Not reported";
  const lastAction = snapshot.lastAction ?? "";
  const matchResult = /^RESULT:\s*(.+)$/im.exec(lastAction);
  if (matchResult?.[1]) return matchResult[1].trim();
  const matchVerify = /verify\s*->\s*(PASS|FAIL)(?:\s*\[target:\s*([^\]]+)\])?/i.exec(lastAction);
  if (matchVerify && matchVerify[1]) {
    const verdict = matchVerify[1].toUpperCase();
    const target = matchVerify[2];
    return `${verdict}${target ? ` (${target})` : ""}`;
  }
  const matchReview = /review\s*->\s*(APPROVED|REJECTED)(?:\s*\[target:\s*([^\]]+)\])?/i.exec(lastAction);
  if (matchReview && matchReview[1]) {
    const verdict = matchReview[1].toUpperCase();
    const target = matchReview[2];
    return `${verdict}${target ? ` (${target})` : ""}`;
  }
  const matchFinish = /ticket finished.*?([A-Z]-\d+)?/i.exec(lastAction);
  if (matchFinish) {
    return `Finished ${matchFinish[1] ?? ""}`.trim();
  }
  return "Not reported";
}

export function extractZaicodeSaipenRefusal(snapshot: ZaicodeSaipenSnapshot | null): string | null {
  if (!snapshot) return null;
  const blocker = snapshot.blocker ?? snapshot.projection?.blocker ?? "";
  if (/^REFUSE(?:_|\s*\[|\b)/i.test(blocker)) return blocker;
  if (snapshot.readError && /^REFUSE/i.test(snapshot.readError)) return snapshot.readError;
  return null;
}

export function isZaicodeNeedUser(snapshot: ZaicodeSaipenSnapshot | null): boolean {
  if (!snapshot) return false;
  const blocker = snapshot.blocker ?? snapshot.projection?.blocker;
  if (isZaicodeHumanBlocker(blocker) || /^\s*(?:WAIT_OPERATOR|WAIT_USER)\b/i.test(blocker ?? "")) return true;
  const phase = (snapshot.phase ?? snapshot.projection?.phase ?? "").toUpperCase();
  if (phase === "WAIT_OPERATOR" || phase === "WAIT_USER") return true;
  return false;
}

export function resolveZaicodeLiveStatus(
  snapshot: ZaicodeSaipenSnapshot | null,
  verdict: ZaicodeProjectRuntimeVerdict | null,
): { status: string; variant: "default" | "running" | "warning" | "danger" | "success" } {
  if (!snapshot) {
    return { status: "NO SAIPEN", variant: "default" };
  }
  if (snapshot.readError) {
    return { status: "UNAVAILABLE", variant: "danger" };
  }
  if (snapshot.projection?.recoveryPending) {
    return { status: "RECOVERY", variant: "danger" };
  }
  if (isZaicodeNeedUser(snapshot)) {
    return { status: "WAIT_OPERATOR", variant: "warning" };
  }
  if (snapshot.blocker && !isZaicodeHumanBlocker(snapshot.blocker)) {
    return { status: "BLOCKED", variant: "danger" };
  }
  if (verdict?.state === "working") {
    return { status: "RUNNING", variant: "running" };
  }
  const phase = (snapshot.phase ?? snapshot.projection?.phase ?? "").trim().toUpperCase();
  if (phase) {
    if (phase === "DONE") return { status: "DONE", variant: "success" };
    return { status: phase, variant: "running" };
  }
  if (snapshot.counts.doing > 0) {
    return { status: "DOING", variant: "running" };
  }
  if (snapshot.counts.todo === 0 && snapshot.counts.doing === 0) {
    return { status: "DONE", variant: "success" };
  }
  return { status: "IDLE", variant: "default" };
}

export function formatFreshness(timestamp?: number | string | null): string {
  if (!timestamp) return "fresh";
  const ms = typeof timestamp === "string" ? Date.parse(timestamp) : timestamp;
  if (!ms || Number.isNaN(ms)) return "fresh";
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  return `${diffHours}h ago`;
}
