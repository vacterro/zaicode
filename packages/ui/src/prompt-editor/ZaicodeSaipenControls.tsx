/* oxlint-disable eslint(max-lines) -- saipen controls bar wiring */
import { openZaicodeSaipenView } from "@/zaicode/zaicodeActions.js";
import { Button } from "@/components/ui/button.js";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ZAICODE_SAIPEN_START_COMMAND,
  useZaicodeAfterClear,
  useZaicodeClearSession,
  useZaicodeFreshSession,
  useZaicodeOpenSession,
  useZaicodeSaipen,
} from "@/zaicode/zaicodeSaipen.js";
import {
  useZaicodeProjectRuntime,
  zaicodeSaipenHeadline,
} from "@/zaicode/zaicodeProjectRuntime.js";
import {
  ZAICODE_SAIPEN_MODES,
  resolveZaicodeModeAction,
  useZaicodeMainSessionId,
  useZaicodeMainSessions,
  zaicodeMainSessionKey,
} from "@/zaicode/zaicodeMainSession.js";
import { useZaicodeRunningSessions } from "@/zaicode/zaicodeSidebarPrefs.js";
import { useZaicodeActiveEngine, useZaicodeEngines } from "@/zaicode/zaicodeEngines.js";
import { routeZaicodeSubscriptionPrompt } from "@/zaicode/zaicodeSubscriptionRoute.js";
import { useZaicodeSessionRoles } from "@/zaicode/zaicodeSessionRoles.js";
import { useZaicodeUiPrefs } from "@/zaicode/zaicodeUiPrefs.js";
import { registerZaicodeHotkeyHandler } from "@/zaicode/zaicodeHotkeys.js";
import { useZaicodeComposerPrefs } from "@/zaicode/zaicodeComposerPrefs.js";
import {
  ZaicodeComposerCompactToggle,
  ZaicodeSaipenCompactRow,
  ZaicodeSaipenLine,
  ZaicodeSaipenModesRow,
  ZaicodeSaipenSlotBadge,
} from "./ZaicodeSaipenCompact.js";
import { useZaicodeModeCommands } from "./useZaicodeModeCommands.js";
import { planZaicodeStart, zaicodeStartCopy } from "./zaicodeStartPlan.js";

/**
 * ZAICODE SAIPEN strip above the composer toolbar.
 *
 * Every project has one MAIN session (the "iron slot"): START sends
 * `/goal cc all` (continue and close every ticket that needs no human) in the
 * session that has focus -- a plain click never opens a new one; Shift+click
 * empties that session first and sends the goal once the clear is done; STEP
 * sends one `cc` here; CLEAR empties this session in place (Settings can switch
 * it to "open a new session"). Other sessions are side slots: while MAIN is
 * working, the subSaipens that are safe to run next to it (WIKI, TRANSL, TEST,
 * HUNT) are highlighted on Shift, so helper work stays separate from Core. The phase
 * chip is tinted by board state (red blocked, gold working, green done).
 * Projects without `.saipen/` get a one-click INIT.
 */
export function ZaicodeSaipenControls({
  workspacePath,
  workspaceIdentity,
  sessionId,
  disabled,
  onCommand,
  onDirectCommand,
  queueCount,
  endActions,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
  disabled: boolean;
  onCommand: (command: string) => boolean | void;
  onDirectCommand?: (command: string) => Promise<boolean | void> | boolean | void;
  queueCount?: number;
  endActions?: ReactNode;
}) {
  const saipen = useZaicodeSaipen(workspacePath, workspaceIdentity);
  const composer = useZaicodeComposerPrefs();
  // T-41: the chip shows the read model's one verdict (SAIPEN projection + what runs here).
  const runtime = useZaicodeProjectRuntime(workspacePath, workspaceIdentity, saipen);
  const mainKey = zaicodeMainSessionKey(workspacePath, workspaceIdentity);
  const mainId = useZaicodeMainSessionId(mainKey);
  const armMain = useZaicodeMainSessions((state) => state.arm);
  const setMain = useZaicodeMainSessions((state) => state.setMain);
  const claimIfArmed = useZaicodeMainSessions((state) => state.claimIfArmed);
  const openSession = useZaicodeOpenSession((state) => state.open);
  const mainWorking = useZaicodeRunningSessions((state) =>
    mainId ? state.sessions.some((session) => session.sessionId === mainId) : false,
  );
  const openFreshSession = useZaicodeFreshSession((state) => state.open);
  const { shiftPressed, runMode } = useZaicodeModeCommands({
    workspacePath,
    workspaceIdentity,
    sessionId,
    mainId,
    mainKey,
    mainWorking,
    disabled,
    onCommand,
    onDirectCommand,
    queueCount,
  });
  // START 从草稿发出后，草稿一旦变成真实会话，就成为本项目的 MAIN。
  const claimRoleIfArmed = useZaicodeSessionRoles((state) => state.claimIfArmed);
  useEffect(() => {
    if (sessionId) {
      claimIfArmed(mainKey, sessionId);
      claimRoleIfArmed(mainKey, sessionId);
    }
  }, [claimIfArmed, claimRoleIfArmed, mainKey, sessionId]);

  const activeEngineId = useZaicodeActiveEngine();
  const engineAccount =
    useZaicodeEngines().accounts.find((account) => account.id === activeEngineId) ?? null;
  const isMain = Boolean(sessionId) && sessionId === mainId;
  const isSideSlot = Boolean(mainId) && !isMain;
  const parallelHint = mainWorking && isSideSlot;

  /** Sends a SAIPEN work command; the first one in a project without MAIN makes this session MAIN. */
  const sendWork = (command: string) => {
    if (!mainId) {
      if (sessionId) setMain(mainKey, sessionId);
      else armMain(mainKey);
    }
    onCommand(command);
  };
  // T-318 Shift+START: the pane arms the goal once the in-place clear is
  // acknowledged; this composer is the one that submits it, like any command.
  const afterClear = useZaicodeAfterClear((state) => state.request);
  const takeAfterClear = useZaicodeAfterClear((state) => state.take);
  useEffect(() => {
    if (!afterClear || disabled || !sessionId || afterClear.sessionId !== sessionId) return;
    const command = takeAfterClear(sessionId);
    if (command) sendWork(command);
  }, [afterClear, disabled, sendWork, sessionId, takeAfterClear]);
  const start = (event?: { shiftKey: boolean }) => {
    const plan = planZaicodeStart({
      shiftKey: Boolean(event?.shiftKey),
      disabled,
      sessionId: sessionId ?? null,
      engineAccount,
    });
    // A subscription engine picked on the sidebar: START runs its CLI as a worker in this project.
    if (plan.kind === "worker" && engineAccount) {
      routeZaicodeSubscriptionPrompt(engineAccount, workspacePath);
      return;
    }
    if (plan.kind === "send") {
      sendWork(ZAICODE_SAIPEN_START_COMMAND);
      return;
    }
    if (plan.kind === "clearThenSend" && sessionId) {
      // Shift: wipe THIS session in place (never a new one), then let the pane
      // hand the goal back to this composer once the clear is acknowledged.
      requestClear(sessionId, ZAICODE_SAIPEN_START_COMMAND);
    }
  };
  const buttonClass =
    "h-6 shrink-0 border border-border bg-selected px-3 text-ui-xs text-foreground hover:bg-hover";
  const startCopy = zaicodeStartCopy(engineAccount);

  const clearMode = useZaicodeUiPrefs((state) => state.clearMode);
  const requestClear = useZaicodeClearSession((state) => state.clear);
  const clear = () => {
    if (!sessionId) return;
    if (clearMode === "new") openFreshSession(workspacePath, workspaceIdentity, null);
    else requestClear(sessionId);
  };
  const clearTitle =
    clearMode === "new"
      ? "CLEAR — start over in a fresh, empty session of this project (Settings → ZAICODE → Layout & home)"
      : "CLEAR — empty THIS session: stops the running turn, drops the goal and the queue, keeps the session (Settings → ZAICODE → Layout & home)";
  const clearButton = (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={!sessionId}
      onClick={clear}
      data-zaicode-sound="saipen.clear"
      aria-label={
        clearMode === "new"
          ? "Clear: start over in a new empty session"
          : "Clear: empty this session"
      }
      title={clearTitle}
      className={buttonClass}
    >
      CLEAR
    </Button>
  );

  // START / STEP / CLEAR hotkeys act on the composer that has focus: the strip
  // re-registers (and so wins) whenever focus enters its composer.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const host = stripRef.current?.parentElement;
      if (host && event.target instanceof Node && host.contains(event.target))
        setFocusTick((tick) => tick + 1);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  const canStep = Boolean(saipen) && !disabled;
  const hotkeyActions = useRef({ start, step: () => sendWork("cc"), clear, canStep });
  hotkeyActions.current = { start, step: () => sendWork("cc"), clear, canStep };
  useEffect(() => {
    const unregister = [
      registerZaicodeHotkeyHandler("saipen.start", () => hotkeyActions.current.start()),
      registerZaicodeHotkeyHandler("saipen.step", () => {
        if (hotkeyActions.current.canStep) hotkeyActions.current.step();
      }),
      registerZaicodeHotkeyHandler("saipen.clear", () => hotkeyActions.current.clear()),
    ];
    return () => unregister.forEach((dispose) => dispose());
  }, [focusTick]);

  const slotBadge = <ZaicodeSaipenSlotBadge
    isMain={isMain} isSideSlot={isSideSlot} mainWorking={mainWorking}
    onOpenMain={() => mainId && openSession(workspacePath, workspaceIdentity, mainId)}
  />;

  const orderedModes = ZAICODE_SAIPEN_MODES;
  const modesRow = (
    <ZaicodeSaipenModesRow
      modes={orderedModes}
      parallelHint={parallelHint}
      mainWorking={mainWorking}
      onMode={runMode}
      shiftPressed={shiftPressed}
    />
  );

  if (!saipen) {
    return (
      <div
        ref={stripRef}
        className="flex min-w-0 flex-col gap-1 border-t border-border pt-2 text-ui-xs"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {slotBadge}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => sendWork("saipen set")}
            title="saipen set — create .saipen/ memory for this project"
            className={buttonClass}
          >
            INIT SAIPEN
          </Button>
          {clearButton}
          {endActions}
          <span className="min-w-0 truncate text-foreground-subtlest">
            No .saipen/ in this project — SAIPEN memory not initialized.
          </span>
        </div>
      </div>
    );
  }

  const ticketTotal =
    saipen.counts.doing + saipen.counts.todo + saipen.counts.done + saipen.counts.blocked;
  // T-41: phase / next action / blocker / next ticket are SAIPEN's projection when it answered.
  const headline = zaicodeSaipenHeadline(saipen)!;
  const where = [headline.phase, headline.task].filter(Boolean).join(" · ") || "IDLE";
  const chipColor = runtime?.color ?? null;
  const chipStyle: CSSProperties | undefined = chipColor
    ? {
        borderColor: chipColor,
        color: `color-mix(in srgb, ${chipColor} 70%, var(--color-foreground))`,
        background: `color-mix(in srgb, ${chipColor} 14%, transparent)`,
      }
    : undefined;

  const nextLine = <ZaicodeSaipenLine label="NEXT" text={headline.nextAction ?? "—"} strong />;
  const chipTitle = [
    runtime ? `${runtime.verdict.label}: ${runtime.verdict.reason}` : null,
    `NEXT: ${headline.nextAction ?? "—"}`,
    headline.nextTicket ? `THEN: ${headline.nextTicket.id} ${headline.nextTicket.title}` : null,
    saipen.lastAction ? `LAST: ${saipen.lastAction}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  if (composer.compact) {
    return (
      <div
        ref={stripRef}
        className="flex min-w-0 flex-col gap-1 border-t border-border pt-1.5 text-ui-xs"
        data-zaicode-saipen-strip
        data-zaicode-compact
      >
        <ZaicodeSaipenCompactRow
          slot={composer.showSlot ? (isMain ? "main" : isSideSlot ? "side" : "none") : null}
          start={{
            label: startCopy.compact,
            disabled: sessionId ? false : disabled,
            onClick: start,
          }}
          step={{ disabled, onClick: () => sendWork("cc") }}
          clear={{ label: clearTitle, disabled: !sessionId, onClick: clear }}
          modes={
            composer.compactModes
              ? orderedModes.map((mode) => {
                  const action = resolveZaicodeModeAction(mode, shiftPressed);
                  return {
                    ...mode,
                    highlighted: action.parallel && (parallelHint || mainWorking),
                    dimmed: parallelHint && !action.parallel,
                  };
                })
              : null
          }
          onMode={runMode}
          shiftPressed={shiftPressed}
          endActions={endActions}
          blocker={headline.blocker ?? null}
          chip={
            composer.compactPhase
              ? {
                  text: where,
                  onClick: () => openZaicodeSaipenView(workspacePath, workspaceIdentity),
                  title: chipTitle,
                  style: chipStyle,
                  state: runtime?.verdict.state,
                  board: ticketTotal > 0 ? `${saipen.counts.done}/${ticketTotal}` : null,
                }
              : null
          }
        />
        {composer.compactNext ? nextLine : null}
      </div>
    );
  }

  return (
    <div
      ref={stripRef}
      className="flex min-w-0 flex-col gap-1.5 border-t border-border pt-2 text-ui-xs"
      data-zaicode-saipen-strip
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {composer.showSlot ? slotBadge : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={sessionId ? false : disabled}
          onClick={start}
          data-zaicode-sound="saipen.start"
          aria-label={startCopy.aria}
          title={startCopy.title}
          className={buttonClass}
        >
          START
          {engineAccount ? (
            <span className="ml-1 text-[var(--zaicode-highlight,var(--color-warning))]">
              ▸{engineAccount.short}
            </span>
          ) : null}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => sendWork("cc")}
          data-zaicode-sound="saipen.step"
          aria-label="Send cc — one SAIPEN continuation step"
          title="cc — one saipen continue step in this session"
          className={buttonClass}
        >
          STEP
        </Button>
        {clearButton}
        {composer.showPhase ? (
          <button
            type="button"
            onClick={() => openZaicodeSaipenView(workspacePath, workspaceIdentity)}
            aria-label="Open SAIPEN STATE, BOARD and LOG"
            className="shrink-0 border border-border px-1.5 tabular-nums text-foreground"
            style={chipStyle}
            data-zaicode-readiness={runtime?.verdict.state}
            title={[
              runtime ? `${runtime.verdict.label}: ${runtime.verdict.reason}` : null,
              runtime?.snapshot.protocol?.source === "files"
                ? "SAIPEN projection unavailable: read from the files"
                : null,
              saipen.updated ? `STATE updated ${saipen.updated}` : null,
            ]
              .filter(Boolean)
              .join(" — ")}
          >
            {where}
          </button>
        ) : null}
        {composer.showBoard && ticketTotal > 0 ? (
          <span
            className="shrink-0 tabular-nums text-foreground-subtlest"
            title={`Board: ${saipen.counts.done} done, ${saipen.counts.doing} doing, ${saipen.counts.todo} todo, ${saipen.counts.blocked} blocked`}
          >
            {saipen.counts.done}/{ticketTotal}
          </span>
        ) : null}
        <ZaicodeComposerCompactToggle />
        {endActions}
      </div>
      {composer.showModes ? modesRow : null}

      {composer.showEngineRoute && engineAccount && !sessionId ? (
        <span
          className="min-w-0 truncate text-[var(--zaicode-highlight,var(--color-warning))]"
          data-zaicode-engine-route
        >
          New prompts and START go to {engineAccount.short} {engineAccount.label}
          {" as a worker"} · pick a pool on the sidebar for the in-app agent
        </span>
      ) : null}
      {composer.showBlocker && headline.blocker ? (
        <span className="min-w-0 truncate text-destructive" title={headline.blocker}>
          BLOCKER: {headline.blocker}
        </span>
      ) : null}

      {composer.showNext || composer.showThen || composer.showLast ? (
        <div className="flex min-w-0 flex-col gap-0.5 border-t border-border/40 pt-1 text-foreground-subtlest">
          {composer.showNext ? nextLine : null}
          {composer.showThen && headline.nextTicket ? (
            <ZaicodeSaipenLine
              label="THEN"
              tag={headline.nextTicket.id}
              text={headline.nextTicket.title}
            />
          ) : null}
          {composer.showLast ? (
            <ZaicodeSaipenLine
              label={`LAST${saipen.lastActionTime ? ` ${saipen.lastActionTime}` : ""}`}
              text={saipen.lastAction ?? "—"}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
