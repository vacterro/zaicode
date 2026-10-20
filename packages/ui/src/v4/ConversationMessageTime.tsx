import { memo, useMemo } from "react";
import { cn } from "@/components/lib/utils.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { useZaicodeGatedNow } from "@/zaicode/zaicodeNowGate.js";
import { formatMessageElapsedLabel, formatMessageTimeLabel } from "./messageTimeLabel.js";

const unknownHostClock = () => null;

/** 独立的只读叶子：年龄更新不重渲染正文，也不写回消息的创建时间。 */
export const ConversationMessageTime = memo(function ConversationMessageTime({
  createdAt,
  locale,
  intl,
  className,
  readHostNow = unknownHostClock,
}: {
  createdAt: number;
  locale: string;
  intl: IntlInstance;
  className?: string;
  readHostNow?: () => number | null;
}) {
  const now = useZaicodeGatedNow(
    (clock) => (clock - createdAt < 60_000 ? 1_000 : 60_000),
    Number.isFinite(createdAt) ? createdAt : 0,
    readHostNow,
  );
  const fullTime = useMemo(() => {
    const date = new Date(createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0 || Number.isNaN(date.getTime())) return null;
    return {
      iso: date.toISOString(),
      local: date.toLocaleString(locale === "ded" ? "ru-RU" : locale, {
        dateStyle: "medium",
        timeStyle: "long",
      }),
    };
  }, [createdAt, locale]);
  if (!fullTime) return null;
  const absolute = now === null ? fullTime.local : formatMessageTimeLabel(createdAt, locale, intl, now);
  const elapsed = now === null ? null : formatMessageElapsedLabel(createdAt, locale, now);
  if (!absolute) return null;
  return (
    <time
      dateTime={fullTime.iso}
      title={fullTime.local}
      data-conversation-message-time={createdAt}
      data-conversation-age-clock={now === null ? "unavailable" : "host"}
      data-zaicode-pixel-snap
      className={cn(
        "mt-1 flex max-w-full flex-wrap gap-x-1 text-ui-xs tabular-nums text-foreground-subtle",
        className,
      )}
    >
      <span>{absolute}</span>
      {elapsed ? <><span aria-hidden="true">·</span><span>{elapsed}</span></> : null}
    </time>
  );
});
