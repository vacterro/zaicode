import { create } from "zustand";
import {
  applyZaicodeSubchatEvent,
  appendZaicodeSubchatMessage,
  createUuid,
  isZaicodeSubchatVendor,
  normalizeZaicodeSubchatConversations,
  zaicodeSubchatTitle,
  zaicodeSubchatUnavailableReason,
  ZAICODE_SUBCHAT_MAX_CONVERSATIONS,
  type ZaicodeEngineAccount,
  type ZaicodeSubchatConversation,
  type ZaicodeSubchatEvent,
} from "@zcode/shared";
import { openZaicodeSubchatView } from "../zaicodeActions.js";
import { readZaicodeEnginesState } from "../zaicodeEngines.js";
import { playZaicodeSound } from "../zaicodeSoundBus.js";

/**
 * Subscription chat, renderer half (T-51): the chats, which turn belongs to
 * which chat, and the bridge to the desktop main process that runs each turn
 * as the account's CLI in headless mode. Chats persist in localStorage
 * (bounded); a turn is never persisted as running.
 */

interface ZaicodeSubchatBridge {
  runZaicodeSubchatTurn?(request: {
    turnId: string;
    accountId: string;
    projectPath: string;
    prompt: string;
    sessionId: string | null;
  }): Promise<{ ok: boolean; message: string }>;
  cancelZaicodeSubchatTurn?(turnId: string): Promise<boolean>;
  onZaicodeSubchatEvent?(callback: (payload: unknown) => void): () => void;
}

function bridge(): ZaicodeSubchatBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { zcode?: ZaicodeSubchatBridge }).zcode;
}

export function isZaicodeSubchatAvailable(): boolean {
  return typeof bridge()?.runZaicodeSubchatTurn === "function";
}

const STORAGE_KEY = "zaicode-subchats";
/** localStorage holds ~5 MB per origin; chats never take more than half of it. */
const STORAGE_BUDGET_CHARS = 2_500_000;

interface ZaicodeSubchatState {
  conversations: ZaicodeSubchatConversation[];
  activeId: string | null;
  /** Running turn id -> chat id. */
  turns: Record<string, string>;
}

function load(): ZaicodeSubchatConversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeZaicodeSubchatConversations(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export const useZaicodeSubchat = create<ZaicodeSubchatState>(() => {
  const conversations = load();
  return { conversations, activeId: conversations[0]?.id ?? null, turns: {} };
});

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Newest chats first; the oldest go first when the budget is exceeded. */
function persist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const running = new Set(Object.values(useZaicodeSubchat.getState().turns));
    let list = useZaicodeSubchat
      .getState()
      .conversations.map((conversation) => (running.has(conversation.id) ? { ...conversation, status: "running" as const } : conversation));
    let json = JSON.stringify(list);
    while (json.length > STORAGE_BUDGET_CHARS && list.length > 1) {
      list = list.slice(0, Math.max(1, Math.floor(list.length * 0.75)));
      json = JSON.stringify(list);
    }
    try {
      localStorage.setItem(STORAGE_KEY, json);
    } catch {
      // the chats last for this window
    }
  }, 400);
}

function update(id: string, change: (conversation: ZaicodeSubchatConversation) => ZaicodeSubchatConversation): void {
  useZaicodeSubchat.setState((state) => ({
    conversations: state.conversations.map((conversation) => (conversation.id === id ? change(conversation) : conversation)),
  }));
  persist();
}

let listening = false;

function listen(): void {
  if (listening) return;
  const subscribe = bridge()?.onZaicodeSubchatEvent;
  if (!subscribe) return;
  listening = true;
  subscribe((payload) => {
    const value = payload as { turnId?: unknown; event?: ZaicodeSubchatEvent } | null;
    if (typeof value?.turnId !== "string" || !value.event || typeof value.event.type !== "string") return;
    const turnId = value.turnId;
    const event = value.event;
    const chatId = useZaicodeSubchat.getState().turns[turnId];
    if (!chatId) return;
    update(chatId, (conversation) => applyZaicodeSubchatEvent(conversation, event, Date.now(), createUuid()));
    if (event.type === "result") {
      useZaicodeSubchat.setState((state) => {
        const turns = { ...state.turns };
        delete turns[turnId];
        return { turns };
      });
      playZaicodeSound(event.ok ? "subchat.done" : "subchat.fail");
    }
  });
}

export function zaicodeSubchatRunningTurn(chatId: string, turns: Record<string, string>): string | null {
  return Object.entries(turns).find(([, id]) => id === chatId)?.[0] ?? null;
}

/** Sends one prompt in a chat. The answer streams into the chat; the result is only "did it start". */
export async function sendZaicodeSubchat(chatId: string, prompt: string): Promise<{ ok: boolean; message: string }> {
  const text = prompt.trim();
  const conversation = useZaicodeSubchat.getState().conversations.find((item) => item.id === chatId);
  if (!conversation || !text) return { ok: false, message: "Nothing to send." };
  if (zaicodeSubchatRunningTurn(chatId, useZaicodeSubchat.getState().turns)) {
    return { ok: false, message: `${conversation.short} is still answering. Stop it or wait.` };
  }
  const run = bridge()?.runZaicodeSubchatTurn;
  if (!run) return { ok: false, message: "Subscription chat needs the ZAICODE desktop app." };
  listen();
  const turnId = `subchat-${createUuid()}`;
  const now = Date.now();
  useZaicodeSubchat.setState((state) => ({ turns: { ...state.turns, [turnId]: chatId } }));
  update(chatId, (current) => ({
    ...appendZaicodeSubchatMessage(current, { id: createUuid(), role: "user", text, at: now }),
    title: current.messages.some((message) => message.role === "user") ? current.title : zaicodeSubchatTitle(text),
    status: "running",
  }));
  let started: { ok: boolean; message: string };
  try {
    started = await run({
      turnId,
      accountId: conversation.accountId,
      projectPath: conversation.projectPath,
      prompt: text,
      sessionId: conversation.sessionId,
    });
  } catch (error) {
    started = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  if (!started.ok) {
    useZaicodeSubchat.setState((state) => {
      const turns = { ...state.turns };
      delete turns[turnId];
      return { turns };
    });
    update(chatId, (current) =>
      applyZaicodeSubchatEvent(current, { type: "result", ok: false, message: started.message }, Date.now(), createUuid()),
    );
  }
  return started;
}

export async function stopZaicodeSubchat(chatId: string): Promise<void> {
  const turnId = zaicodeSubchatRunningTurn(chatId, useZaicodeSubchat.getState().turns);
  if (turnId) await bridge()?.cancelZaicodeSubchatTurn?.(turnId);
}

export function selectZaicodeSubchat(chatId: string | null): void {
  useZaicodeSubchat.setState({ activeId: chatId });
}

export function removeZaicodeSubchat(chatId: string): void {
  if (zaicodeSubchatRunningTurn(chatId, useZaicodeSubchat.getState().turns)) return;
  useZaicodeSubchat.setState((state) => {
    const conversations = state.conversations.filter((conversation) => conversation.id !== chatId);
    return { conversations, activeId: state.activeId === chatId ? (conversations[0]?.id ?? null) : state.activeId };
  });
  persist();
}

/** A new, empty chat with this account in this project (becomes the active chat). */
export function createZaicodeSubchat(account: ZaicodeEngineAccount, projectPath: string): ZaicodeSubchatConversation | null {
  if (!isZaicodeSubchatVendor(account.vendor)) return null;
  const now = Date.now();
  const conversation: ZaicodeSubchatConversation = {
    id: createUuid(),
    accountId: account.id,
    vendor: account.vendor,
    short: account.short,
    label: account.label,
    projectPath,
    sessionId: null,
    model: null,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    usage: { input: 0, output: 0, cached: 0 },
    messages: [],
  };
  useZaicodeSubchat.setState((state) => ({
    conversations: [conversation, ...state.conversations].slice(0, ZAICODE_SUBCHAT_MAX_CONVERSATIONS),
    activeId: conversation.id,
  }));
  persist();
  return conversation;
}

/**
 * True when a prompt for this picked subscription opens an in-app chat: the
 * setting says chat, the desktop bridge is there and the account can chat
 * headless. False = the caller starts a worker as before.
 */
export function zaicodeSubscriptionPromptGoesToChat(account: ZaicodeEngineAccount): boolean {
  return (
    readZaicodeEnginesState().config.subscriptionPrompts === "chat" &&
    isZaicodeSubchatAvailable() &&
    zaicodeSubchatUnavailableReason(account) === null
  );
}

/**
 * The composer / START path: a prompt for a picked subscription tile opens a
 * new in-app chat with that account and sends it. Returns null when this
 * account cannot chat (the caller starts a worker instead), else the outcome.
 */
export async function startZaicodeSubchat(params: {
  account: ZaicodeEngineAccount;
  projectPath: string;
  prompt: string;
}): Promise<{ ok: boolean; message: string } | null> {
  if (!isZaicodeSubchatAvailable() || zaicodeSubchatUnavailableReason(params.account)) return null;
  const conversation = createZaicodeSubchat(params.account, params.projectPath);
  if (!conversation) return null;
  openZaicodeSubchatView();
  return sendZaicodeSubchat(conversation.id, params.prompt);
}
