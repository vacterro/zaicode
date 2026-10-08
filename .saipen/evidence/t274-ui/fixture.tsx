import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../zcode/packages/ui/src/styles.css";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ZaicodeRouterPools } from "@/settings/ZaicodeRouterPools.js";
import { useZaicodeRouter } from "@/zaicode/zaicodeRouter.js";
import { ZaicodeDispatchSettings } from "@/settings/ZaicodeDispatchSettings.js";
import { ZaicodeScheduleContinuation } from "@/zaicode/ZaicodeScheduleContinuation.js";
import { ZaicodeQueuePanel } from "@/zaicode/ZaicodeQueuePanel.js";
import { useZaicodeStore } from "@/zaicode/zaicodeStore.js";
import { ConversationTranscriptControl } from "@/v4/ConversationTranscriptControl.js";
import { TranscriptViewContext } from "@/lib/transcriptView.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { ExecuteOutput } from "@/ToolCallBlocks/renderers/ExecuteOutput.js";
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";

document.documentElement.classList.add("zaicode-product");
document.body.style.overflow = "auto";
document.getElementById("root")!.style.overflow = "auto";
let combo = { id: "fixture", name: "SAIFREN", models: ["free/first", "free/second", "free/third"], strategy: "fallback" };
const writes: any[] = [];
(window as any).writes = writes;
(window as any).zcode = { callZaicodeRouter: async (call: any) => {
  if (call.method === "PUT") { writes.push(call); await new Promise((r) => setTimeout(r, 40)); combo = { ...combo, models: call.body.models }; }
  const data = call.path === "/api/combos" ? { combos: [combo] } : call.path === "/api/settings" ? {} : call.path === "/api/version" ? { currentVersion: "fixture" } : [];
  return { ok: true, status: 200, data, message: "" };
}};
useZaicodeRouter.setState({ combos: [combo], settings: {}, busy: null });
let sourceJobs = [1, 2, 3].map((at) => ({ id: `job-${at}`, agentId: "agent", workspaceKey: "fixture", title: `Queued ${at}`, instructions: "fixture", status: "queued", priority: 0, sortOrder: at, createdAt: at, attempt: 0 }));
useZaicodeStore.setState({ jobs: sourceJobs as any });
const services: any = {
  agents: { list: async () => ({ agents: [], diagnostics: [] }), listTemplates: async () => [] },
  jobs: {
    list: async () => ({ jobs: sourceJobs, diagnostics: [] }), getMaxConcurrency: async () => 1, getAutoRun: async () => false,
    reorder: async (id: string, direction: string) => {
      const at = sourceJobs.findIndex((j) => j.id === id), target = at + (direction === "up" ? -1 : 1);
      if (at < 0 || target < 0 || target >= sourceJobs.length) return false;
      const a = sourceJobs[at], b = sourceJobs[target]; [a.sortOrder, b.sortOrder] = [b.sortOrder, a.sortOrder];
      sourceJobs = [...sourceJobs].sort((a, b) => a.sortOrder - b.sortOrder); return true;
    },
  },
};
function Fixture() {
  const [view, setView] = useState<any>("full");
  const [stream, setStream] = useState(0);
  const [underlying, setUnderlying] = useState(0);
  const jobs = useZaicodeStore((s) => s.jobs);
  const [job, setJob] = useState<any>({ engineId: "a1", onlyMarked: false, continuation: { enabled: true, runnerIds: ["a2", "c1", "c2"], delayMinutes: 1, returnToPreferred: false, recoveryDelayMinutes: 1 }, continuationRuns: [] });
  const runners = [{ id: "a1", label: "A1" }, { id: "a2", label: "A2" }, { id: "c1", label: "C1" }, { id: "c2", label: "C2" }];
  return <ZCodeIntlProvider initialLocale="en-US"><main style={{ padding: 16, maxWidth: 950, color: "#D4C89A", background: "#1A1810" }}>
    <ZaicodeRouterPools />
    <section id="fallback"><ZaicodeScheduleContinuation job={job} runners={runners} onChange={(patch) => setJob({ ...job, ...patch })} /></section>
    <ZaicodeDispatchSettings />
    <section id="queue"><ZaicodeQueuePanel jobs={jobs} agents={[]} diagnostics={[]} selectedJobId={null} autoRun={false} onSelectJob={() => {}} onCreateAgent={() => {}} onCreateJob={() => {}} onDispatch={() => {}} onCancel={() => {}} onRetry={() => {}} onResume={() => {}} onRemove={() => {}} onMove={() => {}} onMoveTo={(id, target) => void useZaicodeStore.getState().reorderJobTo(services, { workspaceKey: "fixture" } as any, id, target)} /></section>
    <div data-transcript-view={view}><ConversationTranscriptControl view={view} onChange={setView} /><TranscriptViewContext.Provider value={view}>
      <ToolLayout toolId="fixture-output" icon={null} kindLabel="Tool" primaryText="Long output" content={<ExecuteOutput text={Array.from({ length: 100 }, (_, at) => `output-${at}`).join("\n") + `\nstream-${stream}`} running={true} />} />
    </TranscriptViewContext.Provider></div>
    <button id="stream" onClick={() => setStream(stream + 1)}>Stream one line</button>
    <button id="underlying" onClick={() => setUnderlying(underlying + 1)}>Underlying {underlying}</button>
    <Dialog><DialogTrigger asChild><button id="modal">Open modal</button></DialogTrigger><DialogContent><DialogTitle>Transparent backdrop test</DialogTitle><p>Modal input blocking stays active.</p></DialogContent></Dialog>
  </main></ZCodeIntlProvider>;
}
createRoot(document.getElementById("root")!).render(<ServiceProvider services={services}><TabStoreProvider><Fixture /></TabStoreProvider></ServiceProvider>);
