import { Button } from "@/components/ui/button.js";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ZAICODE_SAIPEN_START_COMMAND,
  hasZaicodePendingCommand,
  useZaicodeClearSession,
  useZaicodeFreshSession,
  useZaicodeOpenSession,
  useZaicodePendingCommand,
  useZaicodeSaipen,
} from "@/zaicode/zaicodeSaipen.js";
import { useZaicodeProjectRuntime, zaicodeSaipenHeadline } from "@/zaicode/zaicodeProjectRuntime.js";
import {
  ZAICODE_SAIPEN_MODES,
  useZaicodeMainSessionId,
  useZaicodeMainSessions,
  zaicodeMainSessionKey,
} from "@/zaicode/zaicodeMainSession.js";
import { useZaicodeRunningSessions } from "@/zaicode/zaicodeSidebarPrefs.js";
import { useZaicodeActiveEngine, useZaicodeEngines } from "@/zaicode/zaicodeEngines.js";
import { useZaicodeSessionRoles, zaicodeRoleForCommand } from "@/zaicode/zaicodeSessionRoles.js";
import { launchZaicodeWorker } from "@/zaicode/zaicodeWorkers.js";
import { toast } from "@/components/ui/toast.js";
import { useZaicodeUiPrefs } from "@/zaicode/zaicodeUiPrefs.js";
import { registerZaicodeHotkeyHandler } from "@/zaicode/zaicodeHotkeys.js";
import { useZaicodeComposerPrefs } from "@/zaicode/zaicodeComposerPrefs.js";
import {
  ZaicodeComposerCompactToggle,
  ZaicodeSaipenCompactRow,
  ZaicodeSaipenLine,
  ZaicodeSaipenModesRow,
} from "./ZaicodeSaipenCompact.js";

/**
 * ZAICODE SAIPEN strip above the composer toolbar.
 *
 * Every project has one MAIN session (the "iron slot"): START runs
 * `/goal cc all` (continue and close every ticket that needs no human) in a
 * FRESH session and makes it MAIN; STEP sends one `cc` here; CLEAR empties
 * this session in place (Settings can switch it to "open a new session"). Other sessions are side slots: while MAIN is working,
 * the subSaipens that are safe to run next to it (WIKI, TRANSL, TEST, AUDIT)
 * are highlighted there, so parallel work is one click away. The phase chip
 * is tinted by board state (red blocked, gold working, green done). Projects
 * without `.saipen/` get a one-click INIT.
 */
export function ZaicodeSaipenControls({
  workspacePath,
  workspaceIdentity,
  sessionId,
  disabled,
  onCommand,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
  disabled: boolean;
  onCommand: (command: string) => void;
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
  // 项目行 START：新草稿挂载后，一旦可提交就发送排队的命令（只消费一次）。
  const hasPending = useZaicodePendingCommand((state) =>
    hasZaicodePendingCommand(state, workspacePath),
  );
  const takePending = useZaicodePendingCommand((state) => state.take);
  const openFreshSession = useZaicodeFreshSession((state) => state.open);
  useEffect(() => {
    if (!hasPending || disabled || sessionId) return;
    const command = takePending(workspacePath);
    if (command) onCommand(command);
  }, [disabled, hasPending, onCommand, sessionId, takePending, workspacePath]);
  // START 从草稿发出后，草稿一旦变成真实会话，就成为本项目的 MAIN。
  const armRole = useZaicodeSessionRoles((state) => state.arm);
  const claimRoleIfArmed = useZaicodeSessionRoles((state) => state.claimIfArmed);
  useEffect(() => {
    if (sessionId) claimIfArmed(mainKey, sessionId);
    if (sessionId) claimRoleIfArmed(mainKey, sessionId);
  }, [claimIfArmed, claimRoleIfArmed, mainKey, sessionId]);

  const activeEngineId = useZaicodeActiveEngine();
  const engineAccount = useZaicodeEngines().accounts.find((account) => account.id === activeEngineId) ?? null;
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
  const start = () => {
    // A subscription engine picked on the sidebar: START runs that CLI as a worker here.
    if (engineAccount) {
      void launchZaicodeWorker({ account: engineAccount, projectPath: workspacePath }).then((result) =>
        toast(result.message),
      );
      return;
    }
    // START 永远在新会话里跑目标，并把那个会话设为 MAIN。
    armMain(mainKey);
    if (sessionId) openFreshSession(workspacePath, workspaceIdentity, ZAICODE_SAIPEN_START_COMMAND);
    else onCommand(ZAICODE_SAIPEN_START_COMMAND);
  };
  const runMode = (command: string) => {
    // The helper's session keeps its role icon even after it is renamed.
    const role = zaicodeRoleForCommand(command);
    if (role) armRole(mainKey, role);
    // 侧槽的空草稿里直接跑子角色；已有会话或 MAIN 里则另开一个新会话，互不打扰。
    if (!sessionId && !isMainDraftCandidate()) onCommand(command);
    else openFreshSession(workspacePath, workspaceIdentity, command);
  };
  /** A draft in a project without MAIN is where MAIN will be born: keep it for START. */
  function isMainDraftCandidate(): boolean {
    return !sessionId && !mainId;
  }
  const buttonClass =
    "h-6 shrink-0 border border-border bg-selected px-3 text-ui-xs text-foreground hover:bg-hover";

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
      aria-label={clearMode === "new" ? "Clear: start over in a new empty session" : "Clear: empty this session"}
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
      if (host && event.target instanceof Node && host.contains(event.target)) setFocusTick((tick) => tick + 1);
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

  const slotBadge = isMain ? (
    <span
      className="shrink-0 border border-[var(--zaicode-highlight,var(--color-warning))] px-1 text-[var(--zaicode-highlight,var(--color-warning))]"
      title="MAIN session of this project: the work starts and is planned here. Side sessions run helpers in parallel."
      data-zaicode-slot="main"
    >
      ◆ MAIN
    </span>
  ) : isSideSlot ? (
    <button
      type="button"
      className="shrink-0 border border-border px-1 text-foreground-subtle hover:bg-hover hover:text-foreground"
      title={`Side slot. ${mainWorking ? "The MAIN session is working right now." : "The MAIN session is idle."} Click to open MAIN.`}
      onClick={() => mainId && openSession(workspacePath, workspaceIdentity, mainId)}
      data-zaicode-slot="side"
    >
      {mainWorking ? "SIDE · MAIN working →" : "SIDE · → MAIN"}
    </button>
  ) : (
    <span
      className="shrink-0 border border-dashed border-border px-1 text-foreground-subtlest"
      title="This project has no MAIN session yet. START (or the first STEP) makes this session MAIN."
      data-zaicode-slot="none"
    >
      ◇ MAIN?
    </span>
  );

  const orderedModes = parallelHint
    ? [...ZAICODE_SAIPEN_MODES].sort((left, right) => Number(right.parallel) - Number(left.parallel))
    : ZAICODE_SAIPEN_MODES;
  const modesRow = (
    <ZaicodeSaipenModesRow
      modes={orderedModes}
      parallelHint={parallelHint}
      mainWorking={mainWorking}
      runsHere={!sessionId && !isMainDraftCandidate()}
      onMode={runMode}
    />
  );

  if (!saipen) {
    return (
      <div ref={stripRef} className="flex min-w-0 flex-col gap-1 border-t border-border pt-2 text-ui-xs">
        <div className="flex min-w-0 items-center gap-2">
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
            label: engineAccount
              ? `START with ${engineAccount.short} (worker)`
              : `START — ${ZAICODE_SAIPEN_START_COMMAND} in a fresh MAIN session`,
            disabled: sessionId ? false : disabled,
            onClick: start,
          }}
          step={{ disabled, onClick: () => sendWork("cc") }}
          clear={{ label: clearTitle, disabled: !sessionId, onClick: clear }}
          modes={
            composer.compactModes
              ? orderedModes.map((mode) => ({
                  label: mode.label,
                  hint: mode.hint,
                  command: mode.command,
                  role: zaicodeRoleForCommand(mode.command),
                  highlighted: mode.parallel && (parallelHint || mainWorking),
                  dimmed: parallelHint && !mode.parallel,
                }))
              : null
          }
          onMode={runMode}
          blocker={headline.blocker ?? null}
          chip={
            composer.compactPhase
              ? {
                  text: where,
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
      <div className="flex min-w-0 flex-col gap-1">
        {/* SRC-035: a narrow composer wraps these buttons instead of cutting them off. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {composer.showSlot ? slotBadge : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={sessionId ? false : disabled}
            onClick={start}
            data-zaicode-sound="saipen.start"
            aria-label={
              engineAccount
                ? `Start ${engineAccount.label} as a worker in this project`
                : "Start SAIPEN goal in a fresh MAIN session: continue and finish all tickets"
            }
            title={
              engineAccount
                ? `START with ${engineAccount.short} ${engineAccount.label}: its CLI starts as a worker in this project (WORKERS panel). Pick the engine on the sidebar.`
                : `${ZAICODE_SAIPEN_START_COMMAND} — fresh session that becomes MAIN; continue and close every ticket possible without a human`
            }
            className={buttonClass}
          >
            START{engineAccount ? <span className="ml-1 text-[var(--zaicode-highlight,var(--color-warning))]">▸{engineAccount.short}</span> : null}
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
          <span className="ml-auto" />
          {composer.showPhase ? (
          <span
            className="shrink-0 border border-border px-1.5 tabular-nums text-foreground"
            style={chipStyle}
            data-zaicode-readiness={runtime?.verdict.state}
            title={[
              runtime ? `${runtime.verdict.label}: ${runtime.verdict.reason}` : null,
              runtime?.snapshot.protocol?.source === "files" ? "SAIPEN projection unavailable: read from the files" : null,
              saipen.updated ? `STATE updated ${saipen.updated}` : null,
            ]
              .filter(Boolean)
              .join(" — ")}
          >
            {where}
          </span>
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
        </div>
        {composer.showModes ? modesRow : null}
      </div>

      {composer.showEngineRoute && engineAccount && !sessionId ? (
        <span className="min-w-0 truncate text-[var(--zaicode-highlight,var(--color-warning))]" data-zaicode-engine-route>
          New prompts and START go to {engineAccount.short} {engineAccount.label} as a worker · pick a pool on the sidebar
          for the in-app agent
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
            <ZaicodeSaipenLine label="THEN" tag={headline.nextTicket.id} text={headline.nextTicket.title} />
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

