import type { IZCodeAgentService, IZCodeTaskService } from "@zcode/services";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import type { ZaicodeContinueCommand, ZaicodeProjectContinueHandle } from "./zaicodeContinue.js";

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

  const sendCommand = async (sessionId: string, command: ZaicodeContinueCommand): Promise<void> => {
    const envelope: CommandEnvelope =
      command.kind === "goal"
        ? createCommandEnvelope({
            type: "sendGoalCommand",
            sessionId,
            payload: {
              text: command.objective,
              displayText: `/goal ${command.objective}`,
              heldQueueDisposition: "keepQueueAndSend",
            },
          })
        : createCommandEnvelope({
            type: "sendText",
            sessionId,
            payload: { text: command.text, heldQueueDisposition: "keepQueueAndSend" },
          });
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
    if (ack.status !== "accepted" && ack.status !== "duplicate") {
      throw new Error(ack.reasonCode ?? `host answered ${ack.status}`);
    }
  };

  return {
    send: async (sessionId, command) => {
      // A session nobody has open is cold in the agent: hydrate it first (idempotent when warm).
      await target.taskService.resumeTask({ ...scope, taskId: sessionId });
      await sendCommand(sessionId, command);
    },
    start: async (command) => {
      const task = await target.taskService.createTask({
        ...scope,
        // Headless create + first input, like the queue executor: the first command persists it.
        deferPersistenceUntilFirstPrompt: true,
      });
      await sendCommand(task.taskId, command);
      return task.taskId;
    },
  };
}
