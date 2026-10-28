import { toast } from "@/components/ui/toast.js";
import { readZaicodeQueueServices } from "./zaicodeAutostart.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { useZaicodeAuditStore } from "./zaicodeAuditStore.js";
import { useZaicodeWorkspaceTab } from "./zaicodeScheduler.js";
import {
  createZaicodeA3Starter,
  planZaicodeA3,
  zaicodeA3ProjectName,
  type ZaicodeA3Target,
} from "./zaicodeA3Core.js";

/**
 * `/a3` in the composer (Wave 5): one invocation, ONE Quick3 campaign, on the
 * active project. The decision lives in `zaicodeA3Core` (pure, tested); this
 * file is only the wiring — services, toast, the Audits panel.
 *
 * The command is an AppSlashCommand, so selecting it RUNS this and the
 * composer never submits: a `/a3` can never become a chat message.
 */

const starter = createZaicodeA3Starter();

export type { ZaicodeA3Target };
export { planZaicodeA3, createZaicodeA3Starter, zaicodeA3ProjectName };

export type ZaicodeA3Outcome =
  | { kind: "started"; campaignId: string }
  | { kind: "existing"; campaignId: string; currentWave: number }
  | { kind: "unavailable"; reason: string };

function openAudits(): void {
  useZaicodeWorkspaceTab.getState().setTab("audits");
}

export async function runZaicodeA3(target: ZaicodeA3Target): Promise<ZaicodeA3Outcome> {
  const services = readZaicodeQueueServices();
  const audits = services?.audits ?? null;
  // Checked BEFORE the latch, and before anything is awaited. Asking the
  // decision about a service that is not there is how this used to throw a
  // TypeError instead of saying "the host is not connected".
  if (!audits) {
    toast("/a3 needs the local ZAICODE host: it is not connected.");
    return { kind: "unavailable", reason: "the local ZAICODE host is not connected" };
  }

  // One at a time, process-wide. A double Enter is refused here, before any
  // service call, so it cannot even ask the service to start a second one.
  const result = await starter.once(async () => {
    const state = await audits.getState();
    const decision = planZaicodeA3(state.campaigns, target, true);
    if (decision.kind === "unavailable") return decision;
    if (decision.kind === "open-existing") {
      openAudits();
      void useZaicodeAuditStore.getState().refresh(audits);
      toast(`A3 is already ${decision.status} for this project — wave ${decision.currentWave} of 3.`);
      return {
        kind: "existing" as const,
        campaignId: decision.campaignId,
        currentWave: decision.currentWave,
      };
    }
    const campaign = await audits.start({
      workspaceKey: target.workspaceKey,
      workspacePath: target.workspacePath,
      projectName: zaicodeA3ProjectName(target),
    });
    await useZaicodeAuditStore.getState().refresh(audits);
    if (!campaign) return { kind: "unavailable" as const, reason: "the audit service returned no campaign" };
    openAudits();
    playZaicodeSound("audit.start");
    toast(
      `A3 started for ${zaicodeA3ProjectName(target)}: wave 1 (AUDIT CORE) is on the queue, then Second Wave, then Performance.`,
    );
    return { kind: "started" as const, campaignId: campaign.campaignId };
  });

  if (!result.ran) {
    return { kind: "unavailable", reason: "an A3 campaign is already starting" };
  }
  return result.value;
}

/** The composer command. Selecting it starts an audit; it never sends text. */
export function buildZaicodeA3Command(target: ZaicodeA3Target) {
  return {
    value: "a3",
    description: "Start an A3 (AUDAPACK Quick3) audit of this project: three chained read-only waves",
    keywords: ["a3", "audit", "quick3", "аудит", "проверка", "a3 audit"],
    run: () => {
      void runZaicodeA3(target);
    },
  };
}
