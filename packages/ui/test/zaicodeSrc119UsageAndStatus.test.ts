import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { attachTaskListRowActivity } from "../src/v4/taskListRowActivity.js";
import {
  setZaicodeLiveRun,
  reconcileZaicodeLiveRuns,
  useZaicodeLiveRuns,
  zaicodeLiveRunIdsIn,
} from "../src/zaicode/zaicodeLiveRuns.js";
import {
  normalizeZaicodeUsage,
  normalizeZaicodeUsageChart,
  openZaicodeUsage,
  toggleZaicodeUsageSidebar,
  useZaicodeUsage,
} from "../src/zaicode/zaicodeUsage.js";
import {
  openProviderQuotaCircuit,
  resetProviderQuotaCircuits,
  resolveProviderQuotaRoute,
  pickZaicodeFallbackPool,
  providerQuotaCircuit,
} from "@zcode/shared";
import { pickZaicodeFallbackModel } from "../src/zaicode/zaicodeModelFallback.js";
import { composerQuotaFailureKind, noteComposerQuotaExhaustion, routeComposerSelection } from "../src/zaicode/zaicodeQuotaRoute.js";
import { isZaicodeAutoRetryableError } from "../src/zaicode/zaicodeAutoRetry.js";
import { openZaicodeSaipenView, useZaicodeActions } from "../src/zaicode/zaicodeActions.js";
import type { SessionErrorInfo } from "@zcode/shared/zcode-protocol-v4";

afterEach(() => {
  useZaicodeLiveRuns.setState({ runs: {} });
  openZaicodeUsage("closed");
  resetProviderQuotaCircuits();
  useZaicodeActions.setState({ openSaipen: null, saipenSidebar: null });
});

test("a running project survives a view change and old or missing index activity, then settles from fresh facts", () => {
  setZaicodeLiveRun("saituls-session", "V:/Projects/Saituls", true);
  const task = { taskId: "saituls-session", updatedAt: Date.now() + 10_000 } as ZCodeTaskMeta;
  const since = useZaicodeLiveRuns.getState().runs[task.taskId]!.since;
  reconcileZaicodeLiveRuns([task]);
  reconcileZaicodeLiveRuns([
    attachTaskListRowActivity(task, {
      phase: "completedSuccess",
      lastActivityAt: since - 1,
      hasBackgroundWork: false,
    }),
  ]);
  assert.deepEqual(
    zaicodeLiveRunIdsIn(useZaicodeLiveRuns.getState().runs, "v:\\projects\\SAITULS\\"),
    [task.taskId],
  );
  reconcileZaicodeLiveRuns([
    attachTaskListRowActivity(task, {
      phase: "completedSuccess",
      lastActivityAt: since + 1,
      hasBackgroundWork: true,
    }),
  ]);
  assert.ok(useZaicodeLiveRuns.getState().runs[task.taskId], "background work remains running");
  reconcileZaicodeLiveRuns([
    attachTaskListRowActivity(task, {
      phase: "completedSuccess",
      lastActivityAt: since + 2,
      hasBackgroundWork: false,
    }),
  ]);
  assert.deepEqual(useZaicodeLiveRuns.getState().runs, {});
});

test("Usage shows the router's totals and external clients without retaining request bodies or unbounded history", () => {
  const metrics = {
    requests: 2,
    promptTokens: 3,
    completionTokens: 4,
    cachedTokens: 1,
    cost: 0.02,
  };
  const raw = {
    totalRequests: 27,
    totalPromptTokens: 200,
    totalCompletionTokens: 500,
    totalCost: 0.1,
    byProvider: { external: metrics },
    byModel: { SAIFREN: metrics },
    byAccount: { "external client": metrics },
    recentRequests: Array.from({ length: 1000 }, () => ({
      ...metrics,
      model: "external-model",
      provider: "external",
      timestamp: "2026-10-03T00:00:00Z",
      status: "success",
      requestBody: "secret prompt",
      accessToken: "secret",
    })),
    activeRequests: [{ model: "external-model", provider: "external", count: 1 }],
  };
  const view = normalizeZaicodeUsage(raw);
  assert.equal(view.totals.requests, 27);
  assert.equal(view.providers[0]?.name, "external");
  assert.equal(view.accounts[0]?.name, "external client");
  assert.equal(view.active[0]?.requests, 1);
  assert.equal(view.recent.length, 100);
  assert.doesNotMatch(JSON.stringify(view), /secret/);
  assert.equal(
    normalizeZaicodeUsageChart(
      Array.from({ length: 2000 }, () => ({ label: "now", tokens: 1, cost: 2 })),
    ).length,
    120,
  );
  assert.equal(normalizeZaicodeUsage({ totalRequests: Infinity, totalCost: -1 }).totals.cost, 0);
});

test("Usage page, sidebar and close are explicit modes; the sidebar shortcut toggles it", () => {
  openZaicodeUsage();
  assert.equal(useZaicodeUsage.getState().mode, "page");
  toggleZaicodeUsageSidebar();
  assert.equal(useZaicodeUsage.getState().mode, "sidebar");
  toggleZaicodeUsageSidebar();
  assert.equal(useZaicodeUsage.getState().mode, "closed");
});

test("quota fallback chooses SAIFREN ahead of paid preferences and skips every held provider", () => {
  const now = Date.now();
  const providers = [
    { providerId: "paid", models: [{ modelId: "paid-model" }] },
    { providerId: "pool", models: [{ modelId: "SAIFREN" }] },
    { providerId: "reserve", models: [{ modelId: "SAIOPP" }] },
  ];
  const view = { providers, preferredSelection: { providerId: "paid", modelId: "paid-model" } };
  assert.deepEqual(pickZaicodeFallbackModel(view, "glm", now), {
    providerId: "pool",
    modelId: "SAIFREN",
  });
  openProviderQuotaCircuit({ providerId: "pool", now });
  assert.deepEqual(pickZaicodeFallbackModel(view, "glm", now), {
    providerId: "reserve",
    modelId: "SAIOPP",
  });
  assert.deepEqual(pickZaicodeFallbackPool(providers, undefined, { now }), {
    providerId: "reserve",
    modelId: "SAIOPP",
  });
  openProviderQuotaCircuit({ providerId: "glm", now });
  const requested = { providerId: "glm", modelId: "GLM" };
  assert.equal(
    resolveProviderQuotaRoute({
      requested,
      fallback: { providerId: "pool", modelId: "SAIFREN" },
      now,
    }).fallback,
    false,
    "a held fallback is never dispatched",
  );
  openProviderQuotaCircuit({ providerId: "reserve", now });
  openProviderQuotaCircuit({ providerId: "paid", now });
  assert.equal(pickZaicodeFallbackModel(view, "glm", now), null);
});

test("a quota circuit releases at its advertised reset and repeated exhaustion backs off", () => {
  const now = Date.now();
  const first = openProviderQuotaCircuit({ providerId: "glm", now });
  assert.ok(providerQuotaCircuit("glm", first.until - 1));
  assert.equal(providerQuotaCircuit("glm", first.until), null);
  const again = openProviderQuotaCircuit({ providerId: "glm", now: first.until });
  assert.equal(again.until - again.openedAt, 30 * 60_000);
  const reset = again.until + 10_000;
  const vendor = openProviderQuotaCircuit({ providerId: "glm", now: again.until, resetAt: reset });
  assert.equal(vendor.until, again.until + 60_000, "protocol minimum hold is a minute");
  assert.equal(providerQuotaCircuit("glm", vendor.until), null);
});

test("a replayed old quota error cannot renew the circuit or double its backoff", () => {
  const now = Date.now();
  const failure = { providerId: "glm", kind: "provider-limited", failedAt: now, failureId: "error-1" };
  noteComposerQuotaExhaustion({ ...failure, now });
  const first = providerQuotaCircuit("glm", now)!;
  noteComposerQuotaExhaustion({ ...failure, now: now + 120_000 });
  assert.equal(providerQuotaCircuit("glm", now + 120_000), first);
  noteComposerQuotaExhaustion({ ...failure, now: first.until + 1 });
  assert.equal(providerQuotaCircuit("glm", first.until + 1), null);
  openProviderQuotaCircuit({ providerId: "glm", now: first.until + 2, failureId: "error-2" });
  noteComposerQuotaExhaustion({ ...failure, now: first.until + 3 });
  assert.equal(providerQuotaCircuit("glm", first.until + 3)?.failures, 2);
});

test("any provider's proven quota can switch to SAIFREN; tool and network text cannot close a route", () => {
  const now = Date.now();
  const error: SessionErrorInfo = {
    code: "USAGE_LIMIT", message: "Plan usage limit reached", at: now,
    source: "provider", recoverable: true, attribution: { providerId: "antigravity" },
  };
  const kind = composerQuotaFailureKind(error, null);
  assert.equal(kind, "provider-limited");
  assert.equal(composerQuotaFailureKind({ ...error, source: "tool" }, null), null);
  assert.equal(composerQuotaFailureKind({ ...error, source: "network" }, null), null);
  noteComposerQuotaExhaustion({ providerId: error.attribution!.providerId, kind, now, failedAt: error.at, failureId: "ag-error" });
  const view = { providers: [{ providerId: "pool", models: [{ modelId: "SAIFREN" }] }] };
  const route = routeComposerSelection({ providerId: "antigravity", modelId: "paid" }, view, now);
  assert.equal(route.fallback, true);
  assert.deepEqual(route.selection, { providerId: "pool", modelId: "SAIFREN" });
  assert.equal(isZaicodeAutoRetryableError(error), false, "the exhausted route stays blocked");
  assert.equal(isZaicodeAutoRetryableError(error, true), true, "a different usable selection may resume automatically");
  assert.equal(providerQuotaCircuit("pool", now), null, "the failed route's error never fences SAIFREN");
});

test("Phase opens the visible workspace inspector or a sidebar for the exact draft project", () => {
  assert.equal(openZaicodeSaipenView("V:/draft-project", "remote-a"), true);
  assert.deepEqual(useZaicodeActions.getState().saipenSidebar, {
    workspacePath: "V:/draft-project", workspaceIdentity: "remote-a",
  });
  let opened = 0;
  useZaicodeActions.getState().setOpenSaipen((target) => {
    if (target?.workspacePath !== "V:/active-project") return false;
    opened += 1;
    return true;
  });
  openZaicodeSaipenView("V:/active-project");
  assert.equal(opened, 1);
  assert.equal(useZaicodeActions.getState().saipenSidebar, null);
  openZaicodeSaipenView("V:/other-project");
  assert.equal(opened, 1, "another project's chip never opens the active project's files");
  assert.equal(useZaicodeActions.getState().saipenSidebar?.workspacePath, "V:/other-project");
});
