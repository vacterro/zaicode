import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  ZaicodePrefCheck,
  ZaicodePrefHeading,
  ZaicodePrefSegment,
  ZaicodeRightClickSettings,
} from "./ZaicodePrefControls.js";
import {
  ZAICODE_SLOT_GROUPS,
  useZaicodeSidebarPrefs,
  type ZaicodeProjectSectionGroup,
  type ZaicodeSlotGroup,
} from "./zaicodeSidebarPrefs.js";

const toggleClass = (on: boolean) =>
  cn(
    "border px-1 leading-4",
    on
      ? "border-border bg-selected text-foreground"
      : "border-transparent text-foreground-subtlest hover:text-foreground",
  );

const SLOT_OPTIONS = ZAICODE_SLOT_GROUPS.map((group) => ({ value: group, label: group }));

/** SLOTS toggle in the Projects header. Left click: on/off. Right click: every slot option. */
export function ZaicodeSlotsToggle() {
  const prefs = useZaicodeSidebarPrefs();
  return (
    <ZaicodeRightClickSettings
      title="SLOTS"
      hint="Priority groups for projects. Drag a project onto one in another slot, right-click a project to pick its slot, Ctrl+click to send it down."
      panel={
        <>
          <ZaicodePrefCheck
            checked={prefs.slots}
            onChange={(slots) => prefs.update({ slots })}
            label="Group projects into slots"
          />
          <ZaicodePrefSegment
            label="Slot name position"
            value={prefs.slotLabelAlign}
            options={[
              { value: "left", label: "Left" },
              { value: "center", label: "Center" },
              { value: "right", label: "Right" },
            ]}
            onChange={(slotLabelAlign) => prefs.update({ slotLabelAlign })}
          />
          <ZaicodePrefSegment
            label="Project name position"
            value={prefs.projectTitleAlign}
            options={[
              { value: "left", label: "⇤ Left" },
              { value: "center", label: "↔ Middle" },
              { value: "right", label: "Right ⇥" },
            ]}
            onChange={(projectTitleAlign) => prefs.update({ projectTitleAlign })}
          />
          <ZaicodePrefSegment
            label="Session title position"
            value={prefs.sessionTitleAlign}
            options={[
              { value: "left", label: "⇤ Left" },
              { value: "center", label: "↔ Middle" },
              { value: "right", label: "Right ⇥" },
            ]}
            onChange={(sessionTitleAlign) => prefs.update({ sessionTitleAlign })}
          />
          <ZaicodePrefCheck
            checked={prefs.hideEmptySlots}
            onChange={(hideEmptySlots) => prefs.update({ hideEmptySlots })}
            label="Hide empty slots"
            hint="Off: empty slots stay as thin drop lines."
          />
          <ZaicodePrefCheck
            checked={prefs.showSlotCounts}
            onChange={(showSlotCounts) => prefs.update({ showSlotCounts })}
            label="Show project count on each slot line"
          />
          <ZaicodePrefCheck
            checked={prefs.tintMainSlots}
            onChange={(tintMainSlots) => prefs.update({ tintMainSlots })}
            label="Highlight MAIN slots"
          />
          <ZaicodePrefCheck
            checked={prefs.compact}
            onChange={(compact) => prefs.update({ compact })}
            label="Compact rows"
          />
          <ZaicodePrefHeading>MOVING PROJECTS</ZaicodePrefHeading>
          <ZaicodePrefSegment
            label="Ctrl+click on a project sends it to"
            value={prefs.ctrlClickSlot}
            options={SLOT_OPTIONS}
            onChange={(ctrlClickSlot) => prefs.update({ ctrlClickSlot })}
          />
          <ZaicodePrefSegment
            label="New / unsorted projects live in"
            value={prefs.defaultSlot}
            options={SLOT_OPTIONS}
            onChange={(defaultSlot) => prefs.update({ defaultSlot })}
          />
          <ZaicodePrefHeading>FOLDED SLOTS (click a slot line to fold it)</ZaicodePrefHeading>
          <div className="flex flex-wrap gap-px">
            {ZAICODE_SLOT_GROUPS.map((group) => {
              const folded = prefs.collapsedSlots.includes(group);
              return (
                <button
                  key={group}
                  type="button"
                  aria-pressed={folded}
                  className={toggleClass(folded)}
                  onClick={() => prefs.toggleSlotCollapsed(group)}
                >
                  {folded ? "▸" : "▾"} {group}
                </button>
              );
            })}
          </div>
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              className="border border-border px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground"
              title="Every project goes back to the default slot"
              onClick={() => prefs.resetGroups()}
            >
              Reset all project slots
            </button>
          </div>
        </>
      }
    >
      <button
        type="button"
        aria-pressed={prefs.slots}
        title="SLOTS: group projects by priority MAIN0 / MAIN1 / SIDE0..SIDE3. Right-click: slot settings."
        className={toggleClass(prefs.slots)}
        onClick={() => prefs.update({ slots: !prefs.slots })}
      >
        SLOTS
      </button>
    </ZaicodeRightClickSettings>
  );
}

/** LIVE toggle in the Projects header. Left click: on/off. Right click: live ordering options. */
export function ZaicodeLiveToggle() {
  const prefs = useZaicodeSidebarPrefs();
  return (
    <ZaicodeRightClickSettings
      title="LIVE"
      hint="Projects where something is happening right now come first."
      panel={
        <>
          <ZaicodePrefCheck
            checked={prefs.liveFirst}
            onChange={(liveFirst) => prefs.update({ liveFirst })}
            label="Working projects first"
          />
          <ZaicodePrefSegment
            label="Where they go"
            value={prefs.liveScope}
            disabled={!prefs.liveFirst}
            options={[
              { value: "slot", label: "Top of their slot", hint: "A project never leaves its slot" },
              { value: "global", label: "LIVE group on top", hint: "One LIVE line above every slot" },
            ]}
            onChange={(liveScope) => prefs.update({ liveScope })}
          />
          <ZaicodePrefSegment
            label="Order"
            value={prefs.liveOrder}
            disabled={!prefs.liveFirst}
            options={[
              { value: "closest", label: "Closest to done", hint: "Most todo items finished first" },
              { value: "furthest", label: "Least done", hint: "Just-started work first" },
              { value: "recent", label: "Most recent", hint: "Latest activity first" },
            ]}
            onChange={(liveOrder) => prefs.update({ liveOrder })}
          />
          <ZaicodePrefCheck
            checked={prefs.liveIncludeWaiting}
            onChange={(liveIncludeWaiting) => prefs.update({ liveIncludeWaiting })}
            label="Waiting for me counts as live (and comes first)"
            hint="A session asking a question or a permission."
          />
          <ZaicodePrefHeading>INDICATORS</ZaicodePrefHeading>
          <ZaicodePrefCheck
            checked={prefs.liveProjectIndicator}
            onChange={(liveProjectIndicator) => prefs.update({ liveProjectIndicator })}
            label="Spinning working icon + running count on the project row"
          />
          <ZaicodePrefCheck
            checked={prefs.liveDimIdle}
            onChange={(liveDimIdle) => prefs.update({ liveDimIdle })}
            label="Dim projects where nothing runs"
            disabled={!prefs.liveFirst}
          />
        </>
      }
    >
      <button
        type="button"
        aria-pressed={prefs.liveFirst}
        title="LIVE: projects working right now move to the top. Right-click: live settings."
        className={toggleClass(prefs.liveFirst)}
        onClick={() => prefs.update({ liveFirst: !prefs.liveFirst })}
      >
        LIVE
      </button>
    </ZaicodeRightClickSettings>
  );
}

/** The thin "——— MAIN0 ———" line above each slot's projects. Click folds the slot. */
export function ZaicodeSlotGroupHeader({
  group,
  count,
}: {
  group: ZaicodeProjectSectionGroup;
  count: number;
}) {
  const prefs = useZaicodeSidebarPrefs();
  const slot = group === "LIVE" ? null : (group as ZaicodeSlotGroup);
  const folded = slot ? prefs.collapsedSlots.includes(slot) : false;
  const align = prefs.slotLabelAlign;
  const highlighted = group === "LIVE" || (prefs.tintMainSlots && group.startsWith("MAIN"));
  const Chevron = folded ? ChevronRight : ChevronDown;
  const label = (
    <span
      className={cn(
        "flex shrink-0 items-center gap-0.5",
        highlighted && count > 0 && "text-[var(--zaicode-highlight,var(--color-foreground))]",
      )}
    >
      {slot && (folded || count > 0) ? <Chevron className="size-3" /> : null}
      {group}
      {prefs.showSlotCounts && count > 0 ? (
        <span className="tabular-nums text-foreground-subtlest">·{count}</span>
      ) : null}
    </span>
  );
  const line = <span className="h-px min-w-3 flex-1 bg-border" />;
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-1.5 px-2 text-ui-xs tracking-wide",
        count > 0 ? "pt-1 text-foreground-subtle" : "text-foreground-subtlest/60",
        slot ? "cursor-pointer hover:text-foreground" : "cursor-default",
      )}
      data-zaicode-slot-group={group}
      title={
        slot
          ? `${group}: ${count} project(s). Click to ${folded ? "unfold" : "fold"}. Drag a project onto one in another slot, right-click a project, or Ctrl+click it to move it.`
          : "Projects working right now"
      }
      onClick={() => {
        if (slot) prefs.toggleSlotCollapsed(slot);
      }}
    >
      {align !== "left" ? line : null}
      {label}
      {align !== "right" ? line : null}
    </button>
  );
}
