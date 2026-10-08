import { BotIcon, UserIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  answerRowVisible,
  latestTurnAnchors,
  type ConversationAnswerSource,
  type ConversationLatestAnswer,
} from "./conversationLatestAnswer.js";

/**
 * SRC-139 + SRC-161:REQ-009 — the paired "back to my message / back to the answer"
 * affordance.
 *
 * SRC-139 put a zero-height sticky overlay over the transcript's top edge. The
 * packaged UI proved that strategy wrong: an overlay that owns no layout geometry
 * paints over whatever happens to be under it, and the report shows it colliding with
 * the header row. REQ-009 replaces the strategy, not the numbers: this is now a REAL
 * layout lane — a `shrink-0` strip in the timeline's own column, directly above the
 * scrolling viewport. It owns its height, so it cannot cover the project title, the
 * header buttons, a transcript row, a status chip, a meter or the composer: the
 * scroller below starts exactly where the strip ends.
 *
 * Each chip jumps through the timeline's own anchor (`scrollToQuery` ->
 * `[data-row-id="<rowId>"]`) using the row's stable id, derived fresh from the render
 * units on every render. Nothing is remembered, so a newer turn replaces its own chip,
 * a conversation switch resets both, and a second strip cannot exist. The two chips
 * are independent targets: a side with nothing to offer simply stays empty.
 *
 * Deliberate ceilings, named so they are visible:
 *   - the lane is present whenever at least one anchor exists, and it has one constant
 *     height, so it appears once per conversation instead of resizing underfoot.
 *   - a chip no longer disappears on narrow layouts: it drops its preview text and
 *     stays an icon target. Hiding a navigation affordance with no replacement is
 *     exactly what REQ-009 forbids.
 *   - the accessible name reuses `chat.turnNavigator.jumpToQuery`, the position
 *     address the turn navigator already uses ("jump to query N"). Dedicated keys
 *     would read better and cost 34 locale files; they can be added when the chips
 *     earn their own wording.
 */
export const CONVERSATION_LATEST_ANSWER_TESTID = "v4-latest-answer";
export const CONVERSATION_LATEST_USER_TESTID = "v4-latest-user";
export const CONVERSATION_TURN_NAV_TESTID = "v4-turn-nav";

export function ConversationTurnNavStrip({
  units,
  getScrollRoot,
  onJumpToRow,
  className,
}: {
  units: readonly ConversationAnswerSource[];
  /** The scrolling element, read at click time (a ref is stale inside a handler). */
  getScrollRoot: () => HTMLElement | null;
  onJumpToRow: (target: { unitIndex: number; rowId: number }) => void;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const { user, assistant } = latestTurnAnchors(units);
  if (!user && !assistant) return null;

  const jump = (anchor: ConversationLatestAnswer) => {
    const root = getScrollRoot();
    const row = root?.querySelector<HTMLElement>(`[data-row-id="${anchor.rowId}"]`) ?? null;
    // Already on screen: nothing to do, and the transcript must not move.
    if (root && row) {
      if (answerRowVisible(row.getBoundingClientRect(), root.getBoundingClientRect())) return;
    }
    onJumpToRow({ unitIndex: anchor.unitIndex, rowId: anchor.rowId });
  };
  const label = (anchor: ConversationLatestAnswer) =>
    intl.formatMessage({ id: "chat.turnNavigator.jumpToQuery" }, { index: anchor.unitIndex + 1 });
  const chipClass = cn(
    "pointer-events-auto flex min-w-0 max-w-[24%] cursor-pointer items-center gap-1 rounded-full",
    "border border-border bg-card px-2 py-0.5 text-ui-xs text-foreground-subtle shadow-sm",
    "hover:bg-card-selected hover:text-foreground",
  );

  return (
    <div
      data-testid={CONVERSATION_TURN_NAV_TESTID}
      data-v4-turn-nav-strip="true"
      // ZAICODE 把两枚芯片放进 Transcript 那一行：contents 让它们成为该行的直接子项，
      // 与其余按钮一起均匀分布；行本身仍是滚动视口上方的真实布局带。
      className={cn("contents", className)}
    >
      {user ? (
        <button
          type="button"
          data-testid={CONVERSATION_LATEST_USER_TESTID}
          data-v4-latest-user-row-id={user.rowId}
          data-v4-latest-user-identity={user.identity}
          aria-label={label(user)}
          title={user.preview}
          className={chipClass}
          onClick={() => jump(user)}
        >
          <UserIcon className="size-3 shrink-0" />
          <span className="truncate @max-[864px]/conversation:hidden">{user.preview}</span>
        </button>
      ) : null}
      {assistant ? (
        <button
          type="button"
          data-testid={CONVERSATION_LATEST_ANSWER_TESTID}
          data-v4-latest-answer-row-id={assistant.rowId}
          data-v4-latest-answer-identity={assistant.identity}
          aria-label={label(assistant)}
          title={assistant.preview}
          className={chipClass}
          onClick={() => jump(assistant)}
        >
          <BotIcon className="size-3 shrink-0" />
          <span className="truncate @max-[864px]/conversation:hidden">{assistant.preview}</span>
        </button>
      ) : null}
    </div>
  );
}
