import { cn } from "@/components/lib/utils.js";
import { ZaicodeHeaderToolsEditor, ZaicodeNavItemsEditor } from "@/zaicode/ZaicodeLayoutListEditor.js";
import { ZaicodePrefCheck, ZaicodePrefSegment } from "@/zaicode/ZaicodePrefControls.js";
import { ColorField } from "./ZaicodeColorParts.js";
import { ZaicodeTitleAlignPicker } from "./ZaicodeLayoutSettings.js";
import {
  useZaicodeSidebarPrefs,
  ZAICODE_SESSIONS_CONDITIONS,
  ZAICODE_SIDEBAR_ICON_SIZES,
  ZAICODE_SIDEBAR_TEXT_SIZES,
  ZAICODE_SLOT_GROUPS,
  normalizeZaicodeSidebarColor,
  type ZaicodeSessionsCondition,
  type ZaicodeSidebarIconSize,
  type ZaicodeSidebarTextSize,
  type ZaicodeSlotGroup,
} from "@/zaicode/zaicodeSidebarPrefs.js";

/**
 * Settings -> Sidebar (T-65, SRC-049): ONE section that owns everything
 * sidebar - every block listed, with visibility, order, font, colour, size,
 * position and condition controls, applied live and persisted per profile
 * (the sidebar prefs ride in every profile bundle).
 */

function Block({ title, hint, children, testId }: { title: string; hint: string; children: React.ReactNode; testId: string }) {
  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-4 text-ui-xs" data-zaicode-sidebar-settings={testId}>
      <div>
        <h2 className="text-ui-lg text-foreground">{title}</h2>
        <p className="mt-1 max-w-[580px] text-foreground-subtle">{hint}</p>
      </div>
      {children}
    </section>
  );
}

const SEGMENT_CLASS = "border border-border px-1.5 leading-5";

function SegmentRow<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-40 shrink-0 text-foreground-subtle">{label}</span>
      <span className="flex gap-px" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            title={option.hint ?? option.label}
            className={cn(
              SEGMENT_CLASS,
              value === option.value
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
                : "text-foreground-subtle hover:text-foreground",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}

export function ZaicodeSidebarSettings() {
  const prefs = useZaicodeSidebarPrefs();
  const setColor = (key: ZaicodeSlotGroup | "LIVE", hex: string | null) => {
    const next = { ...prefs.slotColors };
    const normalized = hex === null || hex === "" ? undefined : normalizeZaicodeSidebarColor(hex);
    if (normalized) next[key] = normalized;
    else delete next[key];
    prefs.update({ slotColors: next });
  };
  return (
    <div className="flex flex-col gap-4" data-zaicode-sidebar-settings-root>
      <Block
        title="Text and icons"
        hint="The whole sidebar's text size (whole pixels, so the bitmap font stays crisp) and icon scale, applied the moment you click."
        testId="text"
      >
        <SegmentRow<ZaicodeSidebarTextSize>
          label="Text size"
          value={prefs.textSize}
          options={ZAICODE_SIDEBAR_TEXT_SIZES.map((size) => ({ value: size, label: `${size}px` }))}
          onChange={(textSize) => prefs.update({ textSize })}
        />
        <SegmentRow<ZaicodeSidebarIconSize>
          label="Icons"
          value={prefs.iconSize}
          options={ZAICODE_SIDEBAR_ICON_SIZES.map((size) => ({
            value: size,
            label: size === "small" ? "Small" : size === "normal" ? "Normal" : "Large",
          }))}
          onChange={(iconSize) => prefs.update({ iconSize })}
        />
      </Block>

      <Block
        title="Header buttons"
        hint="The row at the top of the sidebar. Tick what shows, drag to order. Right-click the row itself for the same list."
        testId="header"
      >
        <ZaicodeHeaderToolsEditor />
      </Block>

      <Block
        title="Menu"
        hint="The lines under the header (New task, ZAICODE, …). Right-click the menu for the same list; the header's menu button hides the whole block."
        testId="menu"
      >
        <div className="flex flex-wrap gap-4">
          <ZaicodeNavItemsEditor />
          <ZaicodePrefCheck
            checked={prefs.navOpen}
            onChange={(navOpen) => prefs.update({ navOpen })}
            label="Show the menu block on start"
          />
        </div>
      </Block>

      <Block
        title="Project list"
        hint="How projects sit in the sidebar: tight or airy rows, priority slots, working projects first, and the row stands for its MAIN session (SRC-044)."
        testId="list"
      >
        <div className="flex max-w-[560px] flex-col gap-1.5">
          <ZaicodePrefCheck checked={prefs.compact} onChange={(compact) => prefs.update({ compact })} label="Compact rows (tight, no empty vertical space)" />
          <ZaicodePrefCheck checked={prefs.slots} onChange={(slots) => prefs.update({ slots })} label="Priority slots: group projects as MAIN0 / MAIN1 / SIDE0 … SIDE3" />
          <ZaicodePrefCheck checked={prefs.projectIsMain} onChange={(projectIsMain) => prefs.update({ projectIsMain })} label="A project row IS its MAIN session (click opens MAIN, helpers list below)" />
          <ZaicodePrefCheck checked={prefs.liveFirst} onChange={(liveFirst) => prefs.update({ liveFirst })} label="Working projects first" />
        </div>
        <div className="mt-1 border-t border-border pt-2">
          <span className="mb-1 block text-foreground-subtle">Title position</span>
          <ZaicodeTitleAlignPicker />
        </div>
      </Block>

      <Block
        title="Slot headers"
        hint="Every block header with its own accent colour (empty = the theme's highlight), the tint for MAIN slots, counts and folding."
        testId="slots"
      >
        <div className="grid gap-1 sm:grid-cols-2">
          {(["LIVE", ...ZAICODE_SLOT_GROUPS] as const).map((group) => (
            <div key={group} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-foreground-subtle">{group}</span>
              <ColorField
                value={prefs.slotColors[group] ?? ""}
                title={`${group} accent`}
                onChange={(hex) => setColor(group, hex)}
              />
              <button
                type="button"
                className={cn(SEGMENT_CLASS, "text-foreground-subtle hover:text-foreground")}
                disabled={!prefs.slotColors[group]}
                onClick={() => setColor(group, null)}
              >
                theme
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex max-w-[560px] flex-col gap-1.5">
          <ZaicodePrefCheck checked={prefs.tintMainSlots} onChange={(tintMainSlots) => prefs.update({ tintMainSlots })} label="Tint MAIN slot headers" />
          <ZaicodePrefCheck checked={prefs.showSlotCounts} onChange={(showSlotCounts) => prefs.update({ showSlotCounts })} label="Show project counts" />
          <ZaicodePrefCheck checked={prefs.hideEmptySlots} onChange={(hideEmptySlots) => prefs.update({ hideEmptySlots })} label="Hide empty slots" />
        </div>
        <SegmentRow
          label="Header name position"
          value={prefs.slotLabelAlign}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Center" },
            { value: "right", label: "Right" },
          ]}
          onChange={(slotLabelAlign) => prefs.update({ slotLabelAlign })}
        />
      </Block>

      <Block
        title="LIVE"
        hint="Projects with a running session: where they float, what counts as live, and how idle projects look next to them."
        testId="live"
      >
        <div className="flex max-w-[560px] flex-col gap-1.5">
          <ZaicodePrefCheck checked={prefs.liveProjectIndicator} onChange={(liveProjectIndicator) => prefs.update({ liveProjectIndicator })} label="Working icon + running count on the project row" />
          <ZaicodePrefCheck checked={prefs.liveIncludeWaiting} onChange={(liveIncludeWaiting) => prefs.update({ liveIncludeWaiting })} label="A session waiting for you (question / permission) counts as LIVE" />
          <ZaicodePrefCheck checked={prefs.liveDimIdle} onChange={(liveDimIdle) => prefs.update({ liveDimIdle })} label="Dim projects with nothing running" />
        </div>
        <SegmentRow
          label="LIVE order"
          value={prefs.liveOrder}
          options={[
            { value: "closest", label: "Closest to done", hint: "Fewest open tickets first" },
            { value: "furthest", label: "Furthest from done" },
            { value: "recent", label: "Most recently active" },
          ]}
          onChange={(liveOrder) => prefs.update({ liveOrder })}
        />
        <SegmentRow
          label="LIVE placement"
          value={prefs.liveScope}
          options={[
            { value: "slot", label: "Top of its own slot" },
            { value: "global", label: "One LIVE group above every slot" },
          ]}
          onChange={(liveScope) => prefs.update({ liveScope })}
        />
      </Block>

      <Block
        title="Sessions under a project"
        hint="When helper sessions are listed below a project row at all - a condition, not just on/off."
        testId="sessions"
      >
        <SegmentRow<ZaicodeSessionsCondition>
          label="List sessions"
          value={prefs.sessionsCondition}
          options={[
            { value: "always", label: "Always", hint: "Every helper session" },
            { value: "working", label: "Only working", hint: "Sessions with a running turn" },
            { value: "working-or-waiting", label: "Working + waiting", hint: "…or waiting for you (question / permission)" },
          ]}
          onChange={(sessionsCondition) => prefs.update({ sessionsCondition })}
        />
      </Block>
    </div>
  );
}
