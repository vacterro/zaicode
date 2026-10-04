import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { createZaicodeAutostartJob } from "@zcode/shared";
import { ZaicodeSubOutboxChip } from "../../../zcode/packages/ui/src/zaicode/ZaicodeSubOutboxChip";
import { parseZaicodeOutbox, zaicodeOutboxCounts, zaicodeReadyProducers } from "../../../zcode/packages/ui/src/zaicode/zaicodeSubOutbox";
import { ControlHintTooltip } from "../../../zcode/packages/ui/src/ControlHintTooltip";
import { ZaicodeSchedulerNavButton } from "../../../zcode/packages/ui/src/zaicode/ZaicodeSchedulerBits";
import { ZaicodeSchedulerPanel } from "../../../zcode/packages/ui/src/zaicode/ZaicodeSchedulerPanel";
import { ZaicodeHomeScheduler } from "../../../zcode/packages/ui/src/zaicode/home/ZaicodeHomeCards";
import { useZaicodeAutostartRunner, publishZaicodeQueueServices, addZaicodeAutostartJob, readZaicodeAutostartJobs, updateZaicodeAutostartJob } from "../../../zcode/packages/ui/src/zaicode/zaicodeAutostart";
import { publishZaicodeKnownProjects, zaicodeUpcomingSchedules } from "../../../zcode/packages/ui/src/zaicode/zaicodeScheduler";

const world = (globalThis as any).fixture = {
  auto: true, autopilot: false, disabled: false, reject: false, workspace: "V:/fixture/a",
  identity: undefined, mount: 0, commands: [] as string[], outbox: null as any, launches: 0, stops: 0, enables: 0,
  jobs: [createZaicodeAutostartJob({ id: "night", projectPath: "V:/fixture/a", engineId: "agent:night", trigger: "interval", intervalMinutes: 120 })],
};
function outbox(id: string, source = "head-a", producer = "saihunt") {
  return `## ${id}: Fixture package\n- **status:** ready\n- **producer:** ${producer}\n- **source_head:** ${source}\n- **source_tree_fingerprint:** tree-a\n- **role_revision:** role-a\n`;
}
function snapshot(content: string) {
  const packages = parseZaicodeOutbox(content);
  return { packages, counts: zaicodeOutboxCounts(packages), producers: zaicodeReadyProducers(packages) };
}
world.outbox = snapshot(outbox("HUNT-001"));
publishZaicodeKnownProjects([{ path: "V:/fixture/a", key: "V:/fixture/a", name: "fixture" }]);
publishZaicodeQueueServices({ jobs: { getAutoRun: async () => world.autopilot } } as any);
world.arm = () => addZaicodeAutostartJob({ id: "runtime", projectPath: "V:/fixture/a", engineId: "pool:start", trigger: "at", at: Date.now() + 1000, onlyWhenIdle: false });
world.runtimeJobs = readZaicodeAutostartJobs;
world.stopAtNextMinute = () => {
  const job = readZaicodeAutostartJobs()[0];
  const stop = new Date(Date.now() + 60000);
  updateZaicodeAutostartJob(job.id, { stopAt: `${String(stop.getHours()).padStart(2, "0")}:${String(stop.getMinutes()).padStart(2, "0")}` });
};

function Fixture() {
  useZaicodeAutostartRunner();
  const [, redraw] = useState(0);
  world.update = (patch: any) => { Object.assign(world, patch); redraw((n) => n + 1); };
  world.packages = (ids: string[], source = "head-a", producer = "saihunt") => {
    world.update({ outbox: snapshot(ids.map((id) => outbox(id, source, producer)).join("\n")) });
  };
  return <main>
    <h1>ZAICODE T-186 regression fixture</h1>
    <ZaicodeSchedulerNavButton className="scheduler" />
    <div id="outbox">
      <ZaicodeSubOutboxChip key={world.mount} workspacePath={world.workspace} workspaceIdentity={world.identity}
        disabled={world.disabled} onCommand={(command) => {
          if (world.reject) return false;
          world.commands.push(command);
          return true;
        }} />
    </div>
    <section id="hints">
      <ControlHintTooltip standalone title="Model settings"><button id="label">Model settings</button></ControlHintTooltip>
      <ControlHintTooltip standalone title="Model settings"><button id="icon" aria-label="Model settings"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5" /></svg></button></ControlHintTooltip>
      <ControlHintTooltip standalone title="Model settings"><button id="clipped"><span style={{ display: "block", width: 35, overflow: "hidden", whiteSpace: "nowrap" }}>Model settings</span></button></ControlHintTooltip>
      <ControlHintTooltip standalone title="Model settings"><button id="clamped"><span style={{ display: "block", width: 50, height: 14, overflow: "hidden", whiteSpace: "normal" }}>Model settings</span></button></ControlHintTooltip>
      <ControlHintTooltip standalone title="Model settings" description="Choose the model for new tasks"><button id="description">Model settings</button></ControlHintTooltip>
      <ControlHintTooltip standalone title="Model settings" shortcut="Ctrl+,"><button id="shortcut">Model settings</button></ControlHintTooltip>
      <ControlHintTooltip standalone title="Model settings"><button id="hidden"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5" /></svg><span className="sr-only">Model settings</span></button></ControlHintTooltip>
      <ControlHintTooltip standalone title="Model settings" triggerClassName="plain-label">Model settings</ControlHintTooltip>
    </section>
    <ZaicodeSchedulerPanel agents={[]} onEnableAutopilot={() => { world.enables++; world.update({ autopilot: true }); }} />
    <ZaicodeHomeScheduler now={Date.now()} upcoming={zaicodeUpcomingSchedules(world.jobs, () => ({ state: "waiting-time", dueAt: Date.now() + 7200000, eventId: "next", reason: "" }), world.autopilot)} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
