import type { IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import { zaicodeProjectContinueHandle, type ZaicodeContinueCommand, type ZaicodeProjectContinueHandle, type ZaicodeContinueOptions } from "./zaicodeContinue.js";
import { readZaicodeLocalServices } from "./home/zaicodeHomeFeed.js";

/**
 * How a project row reaches its own host to continue a session it does not
 * show (SRC-043). Same path as the off-peak "resume" dispatch: resumeTask
 * hydrates a cold session, then one v4 command goes in -- `sendGoalCommand`
 * for a goal (a real goal, not "/goal ..." as prose), `sendText` otherwise.
 * An existing held queue is kept and the input sent after it, like the
 * composer's "keep queue and send".
 */
export function createZaicodeContinueHandle(target: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  taskService: Pick<IZCodeTaskService, "resumeTask" | "createTask">;
  agentService: Pick<IZCodeAgentService, "sendConversationCommandV4" | "helloConversationV4" | "initializeConversationV4">;
}): ZaicodeProjectContinueHandle {
  const scope = {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };

  const sendCommand = async (sessionId: string, command: ZaicodeContinueCommand, options?: ZaicodeContinueOptions): Promise<void> => {
    const selection = options?.modelSelection ? { modelSelection: options.modelSelection, mode: "yolo" as const, planEnabled: false } : {};
    const envelope: CommandEnvelope =
      command.kind === "goal"
        ? createCommandEnvelope({
            type: "sendGoalCommand",
            sessionId,
            payload: {
              text: command.objective,
              displayText: `/goal ${command.objective}`,
              heldQueueDisposition: "keepQueueAndSend",
              ...selection,
            },
          })
        : createCommandEnvelope({
            type: "sendText",
            sessionId,
            payload: { text: command.text, heldQueueDisposition: "keepQueueAndSend", ...selection },
          });
    if (options?.commandId) envelope.commandId = options.commandId;
    pendingCommandRegistry.record(envelope);
    await ensureAgentV4ConnectionHandshake(target.agentService);
    if (options?.canDispatch && !options.canDispatch()) {
      pendingCommandRegistry.settle(envelope.sessionId, envelope.commandId);
      throw new Error("Scheduled dispatch was cancelled");
    }
    let ack: CommandAck;
    try {
      ack = await target.agentService.sendConversationCommandV4({
        ...scope,
        ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
        envelope,
      });
    } catch (error) {
      pendingCommandRegistry.settle(envelope.sessionId, envelope.commandId);
      throw error;
    }
    pendingCommandRegistry.applyAck(envelope, ack);
    if (ack.status !== "accepted" && ack.status !== "duplicate") {
      throw new Error(ack.reasonCode ?? `host answered ${ack.status}`);
    }
  };

  /** A control command (stop, clear): "noop" is fine, the session was already in that state. */
  const sendControl = async (envelope: CommandEnvelope, guarded = false): Promise<void> => {
    pendingCommandRegistry.record(envelope);
    await ensureAgentV4ConnectionHandshake(target.agentService);
    let ack: CommandAck;
    try {
      ack = await target.agentService.sendConversationCommandV4({
        ...scope,
        ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
        envelope,
      });
    } catch (error) {
      pendingCommandRegistry.settle(envelope.sessionId, envelope.commandId);
      throw error;
    }
    pendingCommandRegistry.applyAck(envelope, ack);
    // 带执行代号的 stop 若被主机拒为 noop，不能当作停机成功再启动回退。
    if (ack.status !== "accepted" && ack.status !== "duplicate" && (guarded || ack.status !== "noop")) {
      throw new Error(ack.reasonCode ?? `host answered ${ack.status}`);
    }
  };

  return {
    send: async (sessionId, command, options) => {
      // A session nobody has open is cold in the agent: hydrate it first (idempotent when warm).
      await target.taskService.resumeTask({ ...scope, taskId: sessionId });
      await sendCommand(sessionId, command, options);
    },
    stop: (sessionId, expectedForegroundExecutionId) => sendControl(createCommandEnvelope({ type: "stop", sessionId, payload: expectedForegroundExecutionId ? { expectedForegroundExecutionId } : {} }), Boolean(expectedForegroundExecutionId)),
    clear: async (sessionId) => {
      // Same as the composer's CLEAR in place, for a session no pane shows: hydrate, then clearConversation.
      await target.taskService.resumeTask({ ...scope, taskId: sessionId });
      await sendControl(createCommandEnvelope({ type: "clearConversation", sessionId, payload: {} }));
    },
    start: async (command, options) => {
      const task = await target.taskService.createTask({
        ...scope,
        // Headless create + first input, like the queue executor: the first command persists it.
        deferPersistenceUntilFirstPrompt: true,
      });
      options?.onCreated?.(task.taskId);
      await sendCommand(task.taskId, command, options);
      return task.taskId;
    },
  };
}

/**
 * The handle for a project from anywhere (SRC-046): its sidebar row's own when
 * the row is mounted; for a local project otherwise one built on the local host
 * services, so the SCHEDULER and the crash auto-continue also work in the Group
 * view or with folded slots. A remote project needs its row (its own host).
 */
export function zaicodeContinueHandleFor(target: { key: string; path: string; identity?: string }): ZaicodeProjectContinueHandle | null {
  const registered = zaicodeProjectContinueHandle(target.key);
  if (registered) return registered;
  if (target.identity?.trim()) return null;
  const services = readZaicodeLocalServices();
  if (!services) return null;
  return createZaicodeContinueHandle({
    workspacePath: target.path,
    taskService: services.zcodeTaskService,
    agentService: services.zcodeAgentService,
  });
}
