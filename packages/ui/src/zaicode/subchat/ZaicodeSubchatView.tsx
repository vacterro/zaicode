import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import type { Theme } from "@/useTheme.js";
import {
  isZaicodeSubchatVendor,
  zaicodeSubchatUnavailableReason,
  type ZaicodeEngineAccount,
  type ZaicodeSubchatConversation,
  type ZaicodeSubchatMessage,
} from "@zcode/shared";
import { projectNameOf, useZaicodeCurrentWorkspace, useZaicodeEngines, visibleZaicodeAccounts } from "../zaicodeEngines.js";
import {
  createZaicodeSubchat,
  isZaicodeSubchatAvailable,
  removeZaicodeSubchat,
  selectZaicodeSubchat,
  sendZaicodeSubchat,
  stopZaicodeSubchat,
  useZaicodeSubchat,
  zaicodeSubchatRunningTurn,
} from "./zaicodeSubchatStore.js";

/**
 * SUBCHAT (T-51): the operator's Claude Code / Codex subscriptions as a plain
 * chat inside ZAICODE. Each account (A1, A2, C1, ...) is its own login; a chat
 * keeps its vendor session, so the next prompt continues it. The CLI runs
 * headless in the project folder: no worker, no terminal window.
 */

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function AccountTiles(props: { accounts: ZaicodeEngineAccount[]; projectPath: string | null }) {
  const { accounts, projectPath } = props;
  if (accounts.length === 0) {
    return (
      <p className="text-foreground-subtlest">
        No Claude Code or Codex login found. Settings → Engines &amp; limits adds one (several accounts each are fine).
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="New chat with">
      {accounts.map((account) => {
        const reason = zaicodeSubchatUnavailableReason(account) ?? (projectPath ? null : "Open a project first: the chat runs in its folder.");
        return (
          <button
            key={account.id}
            type="button"
            className="min-w-8 border border-border bg-card px-1.5 text-foreground enabled:hover:border-foreground-subtle disabled:opacity-40"
            disabled={Boolean(reason)}
            title={reason ?? `New chat with ${account.label} in ${projectNameOf(projectPath ?? "")}`}
            data-zaicode-subchat-account={account.short}
            onClick={() => {
              if (projectPath) createZaicodeSubchat(account, projectPath);
            }}
          >
            {account.short}
          </button>
        );
      })}
    </div>
  );
}

function ChatListRow(props: { conversation: ZaicodeSubchatConversation; active: boolean; running: boolean }) {
  const { conversation, active, running } = props;
  return (
    <button
      type="button"
      className={`flex w-full min-w-0 items-center gap-1.5 border-b border-border/40 px-2 py-1 text-left ${
        active ? "bg-card text-foreground" : "text-foreground-subtle hover:bg-card/60"
      }`}
      onClick={() => selectZaicodeSubchat(conversation.id)}
      data-zaicode-subchat-row={conversation.id}
    >
      <span className="w-7 shrink-0 text-center text-foreground">{conversation.short}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{conversation.title}</span>
        <span className="block truncate text-foreground-subtlest">{projectNameOf(conversation.projectPath)}</span>
      </span>
      {running ? <span className="shrink-0 text-[#e0a040]">…</span> : null}
      {!running && conversation.status === "failed" ? <span className="shrink-0 text-[#e05050]">!</span> : null}
    </button>
  );
}

function MessageRow(props: { message: ZaicodeSubchatMessage; conversation: ZaicodeSubchatConversation; theme: Theme }) {
  const { message, conversation } = props;
  switch (message.role) {
    case "user":
      return (
        <div className="flex flex-col gap-0.5 border-l-2 border-foreground-subtle pl-2" data-zaicode-subchat-role="user">
          <span className="text-foreground-subtlest">YOU</span>
          <div className="whitespace-pre-wrap break-words text-foreground">{message.text}</div>
        </div>
      );
    case "assistant":
      return (
        <div className="flex flex-col gap-0.5" data-zaicode-subchat-role="assistant">
          <span className="text-foreground-subtlest">{conversation.short}</span>
          <MessageResponse
            className="w-full min-w-0 break-words text-foreground"
            workspacePath={conversation.projectPath}
            theme={props.theme}
          >
            {message.text}
          </MessageResponse>
        </div>
      );
    case "tool":
      return (
        <div className="truncate font-mono text-foreground-subtlest" title={message.text} data-zaicode-subchat-role="tool">
          ▸ {message.text}
        </div>
      );
    case "error":
      return (
        <div className="whitespace-pre-wrap break-words text-[#e05050]" data-zaicode-subchat-role="error">
          {message.text}
        </div>
      );
    default:
      return <div className="text-foreground-subtlest">{message.text}</div>;
  }
}

function ChatPane(props: { conversation: ZaicodeSubchatConversation; running: boolean }) {
  const { conversation, running } = props;
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    const element = scroller.current;
    if (element && pinnedToBottom.current) element.scrollTop = element.scrollHeight;
  }, [conversation.messages.length, running]);

  const send = () => {
    const prompt = draft.trim();
    if (!prompt || running) return;
    setDraft("");
    pinnedToBottom.current = true;
    void sendZaicodeSubchat(conversation.id, prompt).then((result) => {
      if (!result.ok) toast(result.message);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  const usage = conversation.usage;

  return (
    <div className="flex h-full min-h-0 flex-col" data-zaicode-subchat-chat={conversation.id}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="border border-border px-1 text-foreground">{conversation.short}</span>
        <span className="text-foreground">{conversation.label}</span>
        <span className="truncate text-foreground-subtlest" title={conversation.projectPath}>
          {projectNameOf(conversation.projectPath)}
        </span>
        {conversation.model ? <span className="text-foreground-subtlest">{conversation.model}</span> : null}
        <span className="ml-auto tabular-nums text-foreground-subtlest" title="Tokens the vendor reported for this chat">
          {usage.input + usage.output > 0 ? `${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out` : ""}
        </span>
        {running ? (
          <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => void stopZaicodeSubchat(conversation.id)}>
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1"
            title="Delete this chat from ZAICODE (the vendor keeps its own session files)"
            onClick={() => removeZaicodeSubchat(conversation.id)}
          >
            Delete
          </Button>
        )}
      </header>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
          {conversation.messages.length === 0 ? (
            <p className="text-foreground-subtle">
              {conversation.label} answers here, in {projectNameOf(conversation.projectPath)}. It runs as its own CLI in the
              background, with its own tools and its own quota; the next prompt continues the same session.
            </p>
          ) : null}
          {conversation.messages.map((message) => (
            <MessageRow key={message.id} message={message} conversation={conversation} theme={theme} />
          ))}
          {running ? <div className="text-[#e0a040]">{conversation.short} is answering…</div> : null}
        </div>
      </div>
      <div className="border-t border-border px-3 py-2">
        <div className="mx-auto flex w-full max-w-4xl items-end gap-2">
          <textarea
            className="min-h-[52px] flex-1 resize-y border border-border bg-card px-2 py-1 text-foreground outline-none focus:border-foreground-subtle"
            placeholder={running ? `${conversation.short} is answering…` : `Message ${conversation.label} (Enter sends, Shift+Enter new line)`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            data-zaicode-subchat-input
          />
          <Button size="sm" className="h-7 px-3" disabled={running || !draft.trim()} onClick={send}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ZaicodeSubchatView() {
  const conversations = useZaicodeSubchat((state) => state.conversations);
  const activeId = useZaicodeSubchat((state) => state.activeId);
  const turns = useZaicodeSubchat((state) => state.turns);
  const engines = useZaicodeEngines();
  const workspace = useZaicodeCurrentWorkspace();
  const accounts = useMemo(
    () => visibleZaicodeAccounts(engines).filter((account) => isZaicodeSubchatVendor(account.vendor)),
    [engines],
  );
  const active = conversations.find((conversation) => conversation.id === activeId) ?? null;
  const available = isZaicodeSubchatAvailable();

  return (
    <div className="flex h-full min-h-0 flex-1 text-ui-xs" data-zaicode-subchat>
      <aside className="flex w-56 shrink-0 flex-col border-r border-border">
        <div className="flex flex-col gap-1 border-b border-border px-2 py-1.5">
          <div className="text-ui-lg text-foreground">SUBCHAT</div>
          <p className="text-foreground-subtlest">Your subscriptions as a chat. No worker, no terminal. New chat with:</p>
          {available ? (
            <AccountTiles accounts={accounts} projectPath={workspace?.path ?? null} />
          ) : (
            <p className="text-[#e0a040]">Subscription chat needs the ZAICODE desktop app.</p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {conversations.map((conversation) => (
            <ChatListRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeId}
              running={Boolean(zaicodeSubchatRunningTurn(conversation.id, turns))}
            />
          ))}
        </div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {active ? (
          <ChatPane key={active.id} conversation={active} running={Boolean(zaicodeSubchatRunningTurn(active.id, turns))} />
        ) : (
          <div className="m-auto max-w-md p-6 text-center text-foreground-subtle">
            Pick a subscription tile on the left to start a chat, or pick one on the sidebar and type in the composer: the
            prompt opens here (Settings → Engines &amp; limits → Workers, “Prompts for a picked subscription open a SUBCHAT”).
          </div>
        )}
      </section>
    </div>
  );
}
