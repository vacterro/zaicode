import {
  freezeZaicodeRuntimeIdentity,
  zaicodeProjectTopology,
  type ZaicodeProjectTopology,
  type ZaicodeRuntimeIdentity,
  type ZaicodeSubchatConversation,
} from "@zcode/shared";
import { readZaicodeWorkerIdentities, type ZaicodeWorkerIdentity } from "./zaicodeWorkerRecords.js";
import { useZaicodeSubchat } from "./subchat/zaicodeSubchatStore.js";

/**
 * The runtime registry (T-42): every execution ZAICODE started itself -- CLI
 * workers and subscription chat turns -- as one list of runtime identities.
 * It reads identity records only; where a worker is shown (panel, window,
 * chip) or which sidebar slot a project sits in is not an input, so no layout
 * change can alter an answer here. Agent sessions keep their identity in the
 * agent runtime (task id, host owner / lease); MAIN is a pointer to one of
 * them, not an execution authority.
 */

/** The ZAICODE window holds a worker's PTY; the desktop main process holds a headless chat turn. */
export const ZAICODE_WORKER_LEASE_HOLDER = "zaicode-window";
export const ZAICODE_SUBCHAT_LEASE_HOLDER = "zaicode-main";

export function zaicodeWorkerRuntimeIdentity(worker: ZaicodeWorkerIdentity): ZaicodeRuntimeIdentity {
  const running = worker.exitCode === null;
  return freezeZaicodeRuntimeIdentity({
    runtimeId: worker.id,
    workId: null,
    owner: worker.accountId,
    role: worker.kind,
    generation: worker.generation,
    engine: worker.vendor,
    projectPath: worker.projectPath,
    lease: running ? { holder: ZAICODE_WORKER_LEASE_HOLDER, since: worker.startedAt } : null,
    health: running ? "running" : worker.exitCode === 0 ? "exited" : "failed",
  });
}

/** Running subscription chat turns: one identity per turn, its chat is the work. */
export function zaicodeSubchatRuntimeIdentities(
  conversations: readonly ZaicodeSubchatConversation[],
  turns: Readonly<Record<string, string>>,
): ZaicodeRuntimeIdentity[] {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  return Object.entries(turns).flatMap(([turnId, chatId]) => {
    const chat = byId.get(chatId);
    if (!chat) return [];
    const asked = chat.messages.filter((message) => message.role === "user");
    return [
      freezeZaicodeRuntimeIdentity({
        runtimeId: turnId,
        workId: chat.id,
        owner: chat.accountId,
        role: "subchat",
        generation: Math.max(1, asked.length),
        engine: chat.vendor,
        projectPath: chat.projectPath,
        lease: { holder: ZAICODE_SUBCHAT_LEASE_HOLDER, since: asked.at(-1)?.at ?? chat.updatedAt },
        health: "running",
      }),
    ];
  });
}

export function readZaicodeRuntimeRegistry(): ZaicodeRuntimeIdentity[] {
  const subchat = useZaicodeSubchat.getState();
  return [
    ...readZaicodeWorkerIdentities().map(zaicodeWorkerRuntimeIdentity),
    ...zaicodeSubchatRuntimeIdentities(subchat.conversations, subchat.turns),
  ];
}

export function readZaicodeProjectTopology(projectPath: string): ZaicodeProjectTopology {
  return zaicodeProjectTopology(readZaicodeRuntimeRegistry(), projectPath);
}
