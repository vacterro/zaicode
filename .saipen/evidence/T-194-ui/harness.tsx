import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkspaceSidebarItem } from "@/WorkspaceSidebarItem.js";
import { MemoTaskItem } from "@/TaskListItem.js";
import { ZaicodeScheduleContinuation } from "@/zaicode/ZaicodeScheduleContinuation.js";
import { normalizeZaicodeContinuingJobs } from "@zcode/shared";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { useZaicodeMainSessions } from "@/zaicode/zaicodeMainSession.js";
import { useZaicodeSidebarPrefs } from "@/zaicode/zaicodeSidebarPrefs.js";
import { useZaicodeLights } from "@/zaicode/zaicodeHighlights.js";
import { reconcileZaicodeLiveRuns } from "@/zaicode/zaicodeLiveRuns.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

const path = "C:/fixture-project";
const params = new URLSearchParams(location.search);
(globalThis as any).__ZAICODE_PRODUCT_MODE__ = true;
useZaicodeSidebarPrefs.setState({ projectIsMain: params.get("folder") !== "yes", sessionsCondition: "working", compact: params.get("compact") !== "no" } as never);
useZaicodeMainSessions.getState().setMain(path, "main");
const runners = [{ id: "C1", label: "Codex 1" }, { id: "C2", label: "Codex 2" }, { id: "pool:route/SAIFREN", label: "SAIRoute / SAIFREN (in-app)" }];
const initialJob = normalizeZaicodeContinuingJobs([{ id: "fixture-job", engineId: "C1", projectPath: path, continuation: { enabled: true, runnerIds: ["C2"], delayMinutes: 1, recoveryDelayMinutes: 1 } }])[0]!;
const noop = () => {};
function App() {
  const [selected, setSelected] = useState("helper");
  const [expanded, setExpanded] = useState(true);
  const [tests, setTests] = useState(true);
  const [job, setJob] = useState(initialJob);
  const [clicks, setClicks] = useState<string[]>([]);
  const [empty, setEmpty] = useState(false);
  const at = Date.now();
  const task = (id: string, running: boolean) => attachTaskListRowActivity({ taskId: id, workspacePath: path, title: id === "main" ? "Project main conversation" : "Helper test conversation", createdAt: 1, updatedAt: at, mode: "build", provider: "route", model: "route/SAIFREN" } as never, { phase: tests && running ? "running" : "completedSuccess", sessionEnded: !(tests && running), hasBackgroundWork: tests && running, lastActivityAt: at, hasAssistantOutput: true, ...(tests && running ? { testActivity: { count: 1, commands: ["pnpm test"] } } : {}) });
  const tasks = empty ? [] : [task("main", false), task("helper", true)];
  reconcileZaicodeLiveRuns(tasks);
  const select = (_path: string, id: string) => { setSelected(id); setClicks((current) => [...current, id]); useZCodeSessionStore.setState({ activeTaskId: id } as never); };
  (globalThis as any).fixture = { ready: true, selected, expanded, tests, job, clicks, setTests, setEmpty, setProjectEffect: () => useZaicodeLights.getState().setHighlight("projectTests", { effects: ["blink"] }) };
  return <ZCodeIntlProvider initialLocale="en-US"><TooltipProvider><main>
    <button id="end-tests" onClick={() => setTests(false)}>End tests</button>
    <button id="empty-project" onClick={() => { useZaicodeMainSessions.getState().clearMain(path); setEmpty(true); }}>Empty project</button>
    <button id="project-effect" onClick={() => useZaicodeLights.getState().setHighlight("projectTests", { effects: ["blink"] })}>Change project test motion</button>
    <ul id="sidebar"><WorkspaceSidebarItem tab={{ id: "fixture-tab", workspacePath: path, label: "Fixture project", type: "workspace" } as never} activateTab={noop} closeTab={noop} isActiveWorkspace isExpanded={expanded} toggleWorkspaceExpanded={() => setExpanded((value) => !value)} onSelectTask={select} onStartDraftInWorkspace={() => { setSelected("draft"); setClicks((current) => [...current, "draft"]); }} taskItems={tasks} taskListLoading={false} taskListHasMore={false} onShowMoreTasks={noop} reconnectingRemoteWorkspaceKeys={[]} remoteWorkspaceErrorByWorkspaceKey={{}} reconnectingRemoteWorkspaceLogsByWorkspaceKey={{}} onReconnectRemoteWorkspace={async () => {}} /></ul>
    <article id="conversation" data-selected={selected}>{selected === "draft" ? "New conversation ready" : `${selected} conversation content`}</article>
    <ul id="timeline"><MemoTaskItem workspacePath={path} task={task("helper", true)} variant="timeline" isActive={false} isPinned={false} isArchiveConfirming={false} onSelectTask={(id: string) => select(path, id)} onArchiveTaskInline={noop} onCancelArchiveConfirm={noop} onTogglePinTask={noop} onStartRenameTask={noop} onArchiveTask={noop} onMarkTaskAsUnread={noop} intl={{ formatMessage: ({ id }: { id: string }) => id }} /></ul>
    <section id="schedule"><ZaicodeScheduleContinuation job={job} runners={runners} onChange={(patch) => setJob((current) => ({ ...current, ...patch }))} /></section>
  </main></TooltipProvider></ZCodeIntlProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
