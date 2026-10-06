import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Mail } from "lucide-react";
import {
  zaicodeAnchorBox,
  zaicodeTooltipCornerPlacement,
  zaicodeTooltipPixel,
  type IPlatformService,
  type ZaicodeTooltipAnchor,
  type ZaicodeTooltipViewport,
} from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { cn } from "@/components/lib/utils.js";
import { zaicodeDevicePx } from "./zaicodePixelSnap.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { refreshZaicodeSaimail } from "./zaicodeSaimail.js";
import type { ZaicodeSaimailSnapshot } from "./zaicodeSaimailModel.js";
import {
  applyZaicodeSaimailOpenedLetter,
  emptyZaicodeSaimailReaderState,
  saimailAge,
  saimailKindShort,
  ZAICODE_SAIMAIL_KIND_WORDS,
} from "./zaicodeSaimailModel.js";

/**
 * The operator's letter reader (SRC-079): one explicit click per letter, the
 * canonical saimail-local open/reopen behind it. Listing here is metadata-only;
 * a body exists in this component's state only between the operator's
 * Open/Reopen and the popover closing, and read state is never faked locally —
 * the backend result is the truth and the poller re-syncs the unread list.
 */

const PANEL_WIDTH = 360;

function LetterRow({
  from,
  kind,
  topic,
  receivedAt,
  actionLabel,
  busy,
  failure,
  onAction,
  onCurrentWork,
  children,
}: {
  from: string;
  kind: string;
  topic: string | null;
  receivedAt: string | null;
  actionLabel: string;
  busy: boolean;
  failure: string | null;
  onAction: () => void;
  onCurrentWork: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-[var(--zaicode-bevel-dark,var(--color-border))] px-2 py-1" data-zaicode-saimail-letter>
      <div className="flex items-center gap-2">
        <span
          className="w-9 shrink-0 border border-[var(--zaicode-bevel-light,var(--color-border))] text-center text-[10px] leading-4"
          title={ZAICODE_SAIMAIL_KIND_WORDS[kind] ?? kind}
        >
          {saimailKindShort(kind)}
        </span>
        <span className="min-w-0 shrink-0 truncate">{from}</span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-tooltip-tag-foreground",
            onCurrentWork && "text-[var(--zaicode-highlight,var(--color-warning))]",
          )}
        >
          {topic ?? "no topic"}
        </span>
        <span className="shrink-0 tabular-nums text-tooltip-tag-foreground">
          {saimailAge(receivedAt, Date.now())}
        </span>
        <button
          type="button"
          className="shrink-0 border border-border px-1.5 text-ui-xs hover:bg-hover disabled:opacity-60"
          disabled={busy}
          data-zaicode-saimail-letter-open={actionLabel.toLowerCase()}
          onClick={onAction}
        >
          {busy ? "…" : actionLabel}
        </button>
      </div>
      {failure ? (
        <div className="pt-1 text-ui-xs text-[var(--zaicode-highlight,var(--color-warning))]" data-zaicode-saimail-letter-failure>
          {failure}
        </div>
      ) : null}
      {children}
    </div>
  );
}

const ZERO_VIEWPORT: ZaicodeTooltipViewport = { width: 0, height: 0 };
const ZERO_ANCHOR: ZaicodeTooltipAnchor = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

export function ZaicodeSaimailReaderPopover({
  desk,
  currentTask,
  anchorEl,
  onClose,
}: {
  desk: ZaicodeSaimailSnapshot;
  currentTask: string | null;
  /**
   * The trigger element (SRC-161:REQ-003). Passed as an element rather than a
   * rect so the panel can be re-measured: it follows the envelope when the
   * window moves, and renders nothing at all once the envelope is gone.
   */
  anchorEl: HTMLElement;
  onClose: () => void;
}) {
  const platform: IPlatformService | undefined = usePlatform();
  // Re-read the trigger on every move/resize instead of trusting the rect that
  // was true at click time. This single source is also the anchor contract's
  // gate: no box on the trigger means no panel, never a panel in the corner.
  const [anchor, setAnchor] = useState<ZaicodeTooltipAnchor | null>(() =>
    typeof window === "undefined" ? null : zaicodeAnchorBox(anchorEl.getBoundingClientRect()),
  );
  const [viewport, setViewport] = useState<ZaicodeTooltipViewport>(() =>
    typeof window === "undefined" ? ZERO_VIEWPORT : { width: window.innerWidth, height: window.innerHeight },
  );
  const [readLetters, setReadLetters] = useState<
    { envelopeId: string; from: string; kind: string; topic: string | null; receivedAt: string | null }[] | null
  >(null);
  const [showRead, setShowRead] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [readerState, setReaderState] = useState(emptyZaicodeSaimailReaderState);
  const [capability, setCapability] = useState<boolean | null>(null);

  useEffect(() => {
    setCapability(Boolean(platform?.openZaicodeSaimailLetter && platform?.listZaicodeSaimailReadLetters));
  }, [platform]);

  // A panel is fixed to the viewport, so both the trigger and the window are
  // re-read on every pass; the trigger wins, because it can move without the
  // window changing at all (a scrolling header, a resized sidebar).
  useEffect(() => {
    const measure = () => {
      setAnchor(zaicodeAnchorBox(anchorEl.getBoundingClientRect()));
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorEl]);

  const placement = zaicodeTooltipCornerPlacement(
    anchor ?? ZERO_ANCHOR,
    { width: PANEL_WIDTH, height: 0 },
    viewport,
    "end",
  );

  const loadRead = useCallback(async () => {
    if (!platform?.listZaicodeSaimailReadLetters) return;
    const result = await platform.listZaicodeSaimailReadLetters();
    setReadLetters(result.ok ? result.letters : []);
  }, [platform]);

  useEffect(() => {
    if (showRead && readLetters === null) void loadRead();
  }, [showRead, readLetters, loadRead]);

  const openLetter = useCallback(
    async (envelopeId: string, state: "UNREAD" | "READ") => {
      if (!platform?.openZaicodeSaimailLetter) return;
      setBusyId(envelopeId);
      try {
        const result = await platform.openZaicodeSaimailLetter({ envelopeId, state });
        // One fold: a failed open records only the refusal; a successful one
        // stores the body and raises needsRefresh when the backend moved the
        // letter UNREAD -> READ, so the poller re-syncs the count, not a guess.
        let refresh = false;
        setReaderState((current) => {
          const next = applyZaicodeSaimailOpenedLetter(current, envelopeId, result);
          refresh = next.needsRefresh && !current.needsRefresh;
          return next;
        });
        if (result.ok) playZaicodeSound("saimail.open");
        if (refresh) refreshZaicodeSaimail();
      } finally {
        setBusyId(null);
      }
    },
    [platform],
  );

  const close = () => {
    // Plaintext lifetime ends with the popover: dropping this state is the
    // whole rule, so a reopened reader never shows a previous visit's body.
    setReaderState(emptyZaicodeSaimailReaderState());
    onClose();
  };

  const row = (
    envelopeId: string,
    from: string,
    kind: string,
    topic: string | null,
    receivedAt: string | null,
    actionLabel: string,
    state: "UNREAD" | "READ",
  ) => (
    <LetterRow
      key={envelopeId}
      from={from}
      kind={kind}
      topic={topic}
      receivedAt={receivedAt}
      actionLabel={actionLabel}
      busy={busyId === envelopeId}
      failure={readerState.failures[envelopeId] ?? null}
      onCurrentWork={Boolean(currentTask) && topic === currentTask}
      onAction={() => void openLetter(envelopeId, state)}
    >
      {readerState.opened[envelopeId] ? (
        <div className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border border-[var(--zaicode-bevel-light,var(--color-border))] bg-black/20 p-1.5 text-ui-xs" data-zaicode-saimail-letter-body>
          {readerState.opened[envelopeId]!.body ?? readerState.opened[envelopeId]!.message}
        </div>
      ) : null}
    </LetterRow>
  );

  const stillListed = new Set<string>([
    ...desk.unread.map((header) => header.envelopeId),
    ...(readLetters ?? []).map((header) => header.envelopeId),
  ]);
  const openedGone = Object.entries(readerState.opened)
    .filter(([envelopeId]) => !stillListed.has(envelopeId))
    .map(([envelopeId, result]) => ({ envelopeId, result }));

  // The anchor contract, enforced: a trigger with no box (detached, hidden, not
  // laid out yet) produces no panel at all. Before this the corner clamp drew
  // the reader at the 8px margin -- the top-left corner in the report.
  if (!placement) return null;

  return createPortal(
    <div className="fixed inset-0 z-[190]" onClick={close}>
      <div
        role="dialog"
        aria-label="SAIMAIL letters"
        className="absolute flex w-[var(--reader-w)] flex-col overflow-auto border border-[var(--zaicode-highlight,var(--color-border))] bg-tooltip text-ui-xs text-tooltip-foreground shadow-md"
        style={{
          ["--reader-w" as string]: `${PANEL_WIDTH}px`,
          left: zaicodeDevicePx(placement.left, window.devicePixelRatio || 1),
          top: zaicodeDevicePx(placement.top, window.devicePixelRatio || 1),
          // Capped by the room on the side it actually landed on, and it flips
          // when the corner it wanted has none (SRC-161:REQ-003).
          maxHeight: `${Math.floor(placement.maxHeight)}px`,
        }}
        data-zaicode-saimail-reader="open"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--zaicode-bevel-dark,var(--color-border))] px-2 py-1">
          <Mail className="size-3" />
          <strong className="font-normal">SAIMAIL · {desk.seat}</strong>
          <span className="ml-auto text-tooltip-tag-foreground">{desk.unread.length} unread</span>
          <button
            type="button"
            className="border border-border px-1.5 hover:bg-hover"
            onClick={close}
            data-zaicode-saimail-reader-close=""
          >
            Close
          </button>
        </div>
        {capability === false ? (
          <div className="px-2 py-2 text-tooltip-tag-foreground" data-zaicode-saimail-reader-degraded>
            This build cannot open letters directly. Update ZAICODE, or read them from the SAIMAIL desk.
          </div>
        ) : null}
        {desk.unread.length === 0 ? (
          <div className="px-2 py-2 text-tooltip-tag-foreground">No unread letters.</div>
        ) : (
          desk.unread.map((header) =>
            row(header.envelopeId, header.from, header.kind, header.topic, header.receivedAt, "Open", "UNREAD"),
          )
        )}
        {openedGone.length > 0 ? (
          <div className="border-b border-[var(--zaicode-bevel-dark,var(--color-border))]">
            <div className="bg-surface px-2 py-0.5 text-tooltip-tag-foreground">Opened this visit</div>
            {openedGone.map(({ envelopeId, result }) => (
              <div key={envelopeId} className="px-2 py-1" data-zaicode-saimail-letter-opened-gone>
                <div className="whitespace-pre-wrap border border-[var(--zaicode-bevel-light,var(--color-border))] bg-black/20 p-1.5">
                  {result.body ?? result.message}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="flex items-center gap-2 border-t border-[var(--zaicode-bevel-dark,var(--color-border))] px-2 py-1 text-left text-tooltip-tag-foreground hover:bg-hover"
          data-zaicode-saimail-reader-toggle-read=""
          onClick={() => setShowRead((value) => !value)}
        >
          {showRead ? "▾" : "▸"} Already read {readLetters ? `(${readLetters.length})` : ""}
        </button>
        {showRead ? (
          readLetters === null ? (
            <div className="px-2 py-1 text-tooltip-tag-foreground">Listing…</div>
          ) : readLetters.length === 0 ? (
            <div className="px-2 py-1 text-tooltip-tag-foreground">No read letters.</div>
          ) : (
            readLetters.map((header) =>
              row(header.envelopeId, header.from, header.kind, header.topic, header.receivedAt, "Reopen", "READ"),
            )
          )
        ) : null}
        <div className="border-t border-[var(--zaicode-bevel-dark,var(--color-border))] px-2 py-1 text-tooltip-tag-foreground">
          Bodies open only by your click; closing the reader forgets them.
        </div>
      </div>
    </div>,
    document.body,
  );
}
