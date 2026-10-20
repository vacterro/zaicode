import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  resolveTranscriptSections,
  updateTranscriptSection,
  TRANSCRIPT_SECTIONS,
  type TranscriptSectionsView,
  type TranscriptView,
} from "@/lib/transcriptView.js";
import { cn } from "@/components/lib/utils.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import {
  ConversationSessionCopyButton,
  type ConversationSessionCopyAction,
} from "./ConversationSessionCopyButton.js";

const LABELS = { user: "User", assistant: "Agent", thoughts: "Thoughts", tools: "Tools" };
function text(
  intl: IntlInstance | undefined,
  key: string,
  fallback: string,
  section?: string,
): string {
  const id = "chat.transcript." + key;
  const translated = intl?.formatMessage({ id }, section ? { section } : undefined);
  return translated && translated !== id
    ? translated
    : fallback.replaceAll("{section}", section ?? "");
}

function TranscriptOptions({
  view,
  onChange,
  intl,
  menu = false,
}: {
  view: TranscriptSectionsView;
  onChange: (view: TranscriptView) => void;
  intl?: IntlInstance;
  menu?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn("flex gap-2", menu ? "flex-col" : "items-center whitespace-nowrap")}>
      {TRANSCRIPT_SECTIONS.map((section) => {
        const label = text(intl, section, LABELS[section]);
        const values = view.sections[section];
        return (
          <fieldset
            key={section}
            aria-label={label}
            className={cn("flex min-w-0 shrink-0 items-center gap-2", menu && "justify-between")}
          >
            <label
              htmlFor={id + "-" + section + "-visible"}
              className="inline-flex min-h-6 cursor-pointer items-center gap-1 whitespace-nowrap"
            >
              <Checkbox
                id={id + "-" + section + "-visible"}
                aria-label={text(intl, "showSection", "Show {section}", label)}
                checked={values.visible}
                data-transcript-visible={section}
                onCheckedChange={(checked) =>
                  onChange(updateTranscriptSection(view, section, { visible: checked === true }))
                }
              />
              {label}
            </label>
            <label
              htmlFor={id + "-" + section + "-scroll"}
              className={cn(
                "inline-flex min-h-6 items-center gap-1 whitespace-nowrap",
                !values.visible && "text-foreground-subtlest",
              )}
              title={text(
                intl,
                values.visible ? "scrollHint" : "scrollDisabled",
                values.visible
                  ? "Limit this section's height and scroll its content. Off shows all loaded content."
                  : "Show this section to change its scroll setting.",
              )}
            >
              <Checkbox
                id={id + "-" + section + "-scroll"}
                aria-label={text(intl, "scrollSection", "Scroll {section}", label)}
                checked={values.scroll}
                disabled={!values.visible}
                data-transcript-scroll={section}
                onCheckedChange={(checked) =>
                  onChange(updateTranscriptSection(view, section, { scroll: checked === true }))
                }
              />
              {text(intl, "scroll", "Scroll")}
            </label>
          </fieldset>
        );
      })}
      <label
        htmlFor={id + "-expanded"}
        className="inline-flex min-h-6 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap"
        title={text(intl, "expandHint", "Keep thoughts and tool details expanded.")}
      >
        <Checkbox
          id={id + "-expanded"}
          aria-label={text(intl, "expand", "Expand details")}
          checked={view.expanded}
          data-transcript-expand
          onCheckedChange={(checked) => onChange({ ...view, expanded: checked === true })}
        />
        {text(intl, "expand", "Expand details")}
      </label>
    </div>
  );
}

export function ConversationTranscriptControl({
  view,
  onChange,
  sessionCopyAction,
  intl,
}: {
  view: TranscriptView;
  onChange: (view: TranscriptView) => void;
  sessionCopyAction?: ConversationSessionCopyAction;
  intl?: IntlInstance;
}) {
  const options = useMemo(() => resolveTranscriptSections(view), [view]);
  const host = useRef<HTMLDivElement>(null);
  const inline = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(true);
  const [fits, setFits] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const inlineVisible = fits && !menuOpen;
  useLayoutEffect(() => {
    const measure = () => {
      const available = host.current?.clientWidth ?? 0;
      const wanted = inline.current?.scrollWidth ?? 0;
      setFits(available > 0 && wanted > 0 && wanted + 2 <= available);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (host.current) observer?.observe(host.current);
    if (inline.current) observer?.observe(inline.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const count = TRANSCRIPT_SECTIONS.filter((section) => options.sections[section].visible).length;
  return (
    <div
      role="group"
      aria-label="Transcript view"
      data-transcript-control="true"
      className="flex min-w-14 flex-1 items-center gap-1 text-ui-xs"
    >
      <span className="mr-1 shrink-0 text-foreground-subtle @max-[460px]/transcript:hidden">
        {text(intl, "title", "Transcript")}
      </span>
      <div
        ref={host}
        className="relative min-w-0 flex-1"
        style={{ overflow: inlineVisible ? "visible" : "hidden" }}
      >
        {/* 隐藏的同源行只用于量取真实宽度；inert 防止窄屏留下不可见的键盘控件。 */}
        <div
          ref={inline}
          className="w-max"
          aria-hidden={!inlineVisible || undefined}
          inert={!inlineVisible}
          style={
            inlineVisible
              ? undefined
              : { position: "absolute", visibility: "hidden", pointerEvents: "none" }
          }
        >
          <TranscriptOptions view={options} onChange={onChange} intl={intl} />
        </div>
        <Popover
          open={menuOpen}
          onOpenChange={(open) => {
            if (open) restoreFocus.current = true;
            setMenuOpen(open);
          }}
        >
          {!inlineVisible ? (
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={text(intl, "filters", "Transcript filters")}
                data-transcript-filters-menu
                className="inline-flex min-h-6 max-w-full items-center gap-1 whitespace-nowrap border border-border bg-card px-1 text-foreground hover:bg-hover"
              >
                {text(intl, "filter", "Filter")} {count}/4 <span aria-hidden="true">▾</span>
              </button>
            </PopoverTrigger>
          ) : null}
          <PopoverContent
            align="start"
            collisionPadding={8}
            aria-label={text(intl, "filters", "Transcript filters")}
            className="w-auto max-w-[calc(100vw-16px)] gap-2 rounded-none p-2 text-ui-xs shadow-none [animation:none] [transition:none]"
            onInteractOutside={() => {
              restoreFocus.current = false;
            }}
            onCloseAutoFocus={(event) => {
              if (!fits) return;
              event.preventDefault();
              if (restoreFocus.current)
                inline.current?.querySelector<HTMLElement>('[role="checkbox"]')?.focus();
            }}
          >
            <strong>{text(intl, "title", "Transcript")}</strong>
            <TranscriptOptions view={options} onChange={onChange} intl={intl} menu />
          </PopoverContent>
        </Popover>
      </div>
      {sessionCopyAction ? <ConversationSessionCopyButton action={sessionCopyAction} /> : null}
    </div>
  );
}
