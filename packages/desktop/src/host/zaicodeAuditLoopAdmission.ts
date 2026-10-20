/**
 * Audit Loop admission (T-289, SRC-202) — the host's half of "start only from an
 * authoritative execution completion event".
 *
 * The one place in the host that knows a job really ended is the terminal
 * outcome callback in `zaicodeRunDispatch.ts`, right where `reportRunOutcome`
 * succeeds. This adapter is handed that event and nothing else: no chat text,
 * no idle timer, no model claim that the work is done. It resolves the durable
 * services for that workspace, asks the project's own automatic-audit switch
 * whether auditing is permitted, and admits one run.
 *
 * Everything the loop itself decides -- stable source evidence, no overlapping
 * worker, no conflicting loop, one reviewer, one remediation -- lives in the
 * service; this file only carries the event across the process boundary.
 */
import { basename } from "node:path";
import {
  IZaicodeAuditLoopService,
  IZaicodeAuditService,
  type ServiceCollection,
} from "@zcode/services";
// 常量住在实现模块里，只能从 host 入口取：根入口必须保持 browser-safe。
import { AUDIT_LOOP_JOB_PREFIX } from "@zcode/services/node";
import type { ZaicodeTerminalOutcomeEvent } from "./zaicodeRunDispatch.js";

export interface ZaicodeAuditLoopAdmissionDeps {
  resolveServices: (request: { workspacePath: string; workspaceIdentity?: string }) => ServiceCollection;
  logWarn: (message: string, error?: unknown) => void;
}

/** Fire-and-forget: a terminal outcome never waits on the audit layer. */
export function createZaicodeAuditLoopAdmission(
  deps: ZaicodeAuditLoopAdmissionDeps,
): (event: ZaicodeTerminalOutcomeEvent) => void {
  return (event) => {
    void (async () => {
      try {
        // The loop dispatches ordinary queue jobs of its own. Their completion is
        // never a new audit subject: it is the signal that the EXISTING run may take
        // its next step. The run is located by the DURABLE job id it recorded, never
        // by the title, so a duplicate or stale notification finds no run and is a
        // no-op. A failed reviewer or fix job resumes too, because that is how the
        // run reaches its own terminal state instead of waiting for a poller.
        if (event.title.startsWith(AUDIT_LOOP_JOB_PREFIX)) {
          const loopServices = deps.resolveServices({ workspacePath: event.workspacePath });
          const ownedLoops = loopServices.getOptional(IZaicodeAuditLoopService);
          if (ownedLoops?.resumeFromTerminalJob) {
            await ownedLoops.resumeFromTerminalJob({
              workspaceKey: event.workspaceKey,
              jobId: event.jobId,
              terminalDisposition: `job ${event.jobId} ${event.outcome}`,
            });
          }
          return;
        }
        if (event.outcome !== "succeeded") return;
        const services = deps.resolveServices({ workspacePath: event.workspacePath });
        const loops = services.getOptional(IZaicodeAuditLoopService);
        if (!loops) return;
        // The EXISTING A3 automatic-audit switch is the operator's permission to
        // audit this project automatically. The loop reuses it rather than
        // introducing a second preference.
        const audits = services.getOptional(IZaicodeAuditService);
        const settings = audits ? await audits.getState().catch(() => null) : null;
        const admitted = await loops.admit({
          workspaceKey: event.workspaceKey,
          workspacePath: event.workspacePath,
          projectName: basename(event.workspacePath) || event.workspacePath,
          executor: { agentId: event.agentId, jobId: event.jobId, sessionId: event.sessionId },
          taskId: event.taskId,
          goalId: null,
          terminalDisposition: `job ${event.jobId} completed`,
          authorityRef: null,
          autoAudits: settings?.autoAudits === true,
        });
        if (!admitted.ok) {
          // A refusal is a decision, not an incident: an operator who switched
          // auditing off must not get a warning on every finished job.
          if (admitted.code !== "AUDIT_MODE_DISABLED" && admitted.code !== "CONFLICTING_LOOP") {
            deps.logWarn(`ZAICODE audit loop: admission refused (${admitted.code}): ${admitted.reason}`);
          }
          return;
        }
        await loops.advance(admitted.run.loopId);
      } catch (error) {
        deps.logWarn("ZAICODE audit loop: admission failed", error);
      }
    })();
  };
}
