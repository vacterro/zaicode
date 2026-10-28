import { useState } from "react";
import { Mail } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import { useZaicodeSaipen } from "@/zaicode/zaicodeSaipen.js";
import { useZaicodeSaimailDesk } from "@/zaicode/zaicodeSaimail.js";
import { ZaicodeAnchoredCard } from "@/zaicode/ZaicodeAnchoredCard.js";
import { ZaicodeSaimailReaderPopover } from "@/zaicode/ZaicodeSaimailReaderPopover.js";
import { ZaicodeSaimailSettingsPanel } from "@/zaicode/ZaicodeHomeScreen.js";
import { ZaicodeRightClickSettings } from "@/zaicode/ZaicodePrefControls.js";
import { useZaicodeUiPrefs } from "@/zaicode/zaicodeUiPrefs.js";
import { playZaicodeSound } from "@/zaicode/zaicodeSoundBus.js";
import {
  ZAICODE_SAIMAIL_KIND_WORDS,
  getAtmosphericSaimailEmptyText,
  readSaimailHistory,
  saimailAge,
  saimailBriefPrompt,
  saimailKindShort,
} from "@/zaicode/zaicodeSaimailModel.js";

const PANEL_WIDTH = 320;

/** One-line answer to "what is SAIMAIL?" shown in the envelope tooltip and in Settings. */
export const ZAICODE_SAIMAIL_WHAT =
  "A quiet local post desk on this PC. Agents leave dispatches and telegrams for you and each other. The envelope lights up when a new letter arrives.";

export function ZaicodeSaimailHeaderButton({
  workspacePath,
  workspaceIdentity,
  useWindowsCaptionSpacing = false,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  useWindowsCaptionSpacing?: boolean;
}) {
  const saipen = useZaicodeSaipen(workspacePath, workspaceIdentity);
  const currentTask = saipen?.task ?? null;
  const { mailbox, desk } = useZaicodeSaimailDesk(currentTask);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  // SRC-161:REQ-003: keep the trigger ELEMENT, never a rect snapshot. A snapshot
  // goes stale on scroll/resize and reports a zero box after detach; the element
  // is re-read every pass and yields "no box" instead of a card at the origin.
  const [previewEl, setPreviewEl] = useState<HTMLElement | null>(null);
  const [readerEl, setReaderEl] = useState<HTMLElement | null>(null);
  const prefs = useZaicodeUiPrefs();
  const unread = desk?.unread.length ?? 0;
  const ready = Boolean(mailbox && desk);

  const openSettings = () => {
    setPendingSettingsSection("zaicode");
    openSettingsTab();
  };
  const draftBrief = () => {
    if (!mailbox || !desk) return;
    useZCodeSessionStore
      .getState()
      .requestComposerTextInsert(
        workspacePath,
        saimailBriefPrompt({ projectRoot: workspacePath, workspace: mailbox, seat: desk.seat }),
        workspaceIdentity,
        undefined,
        "replace",
      );
  };
  const show = (element: HTMLElement) => setPreviewEl(element);

  const label = !mailbox
    ? "SAIMAIL is off. Click to set up your mailbox."
    : !desk
      ? "SAIMAIL: this folder is not a mailbox yet. Click to create it in Settings."
      : `SAIMAIL: ${unread} unread telegram(s)`;

  return (
    <>
      <ZaicodeRightClickSettings title="SAIMAIL envelope" preferenceKey="saimail" hint="Choose what the envelope shows and does" panel={<ZaicodeSaimailSettingsPanel onOpenSettings={openSettings} />} align="end">
      <Button
        type="button"
        variant="ghost"
        size={ready && unread > 0 && prefs.saimailShowCount ? "default" : "icon-md"}
        data-zaicode-saimail-button={ready ? (unread > 0 ? "unread" : "idle") : "off"}
        data-zaicode-help="saimail"
        aria-label={label}
        className={cn(
          "gap-1 tabular-nums [app-region:no-drag] hover:bg-hover",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
          !ready && "text-foreground-subtlest opacity-70 hover:opacity-100",
          ready && unread === 0 && "text-foreground-subtle hover:text-foreground",
          ready &&
            unread > 0 &&
            // Unread mail carries the header outline (moved off "Open in editor"): a solid
            // gold ring so an incoming telegram is the loudest thing in the title bar.
            prefs.saimailUnreadRing && "border border-[var(--zaicode-highlight,var(--color-warning))] text-[var(--zaicode-highlight,var(--color-warning))] hover:text-[var(--zaicode-highlight,var(--color-warning))]",
        )}
        onMouseEnter={(event) => { if (prefs.saimailHoverPreview) show(event.currentTarget); }}
        onMouseLeave={() => setPreviewEl(null)}
        onFocus={(event) => { if (prefs.saimailHoverPreview) show(event.currentTarget); }}
        onBlur={() => setPreviewEl(null)}
        onContextMenu={() => setPreviewEl(null)}
        onClick={(event) => {
          setPreviewEl(null);
          playZaicodeSound("saimail.open");
          if (ready && prefs.saimailClick === "reader") {
            // Hold the element NOW: React clears event.currentTarget once the handler
            // returns, and the updater below runs later -- reading it there was the
            // crash the moment the mailbox was opened (SRC-085). The reader measures
            // this element itself on every pass (SRC-161:REQ-003).
            const trigger = event.currentTarget;
            setReaderEl((current) => (current ? null : trigger));
          } else if (ready && prefs.saimailClick === "brief") draftBrief();
          else openSettings();
        }}
      >
        <Mail className="size-4" />
        {ready && unread > 0 && prefs.saimailShowCount ? <span className="text-ui-xs">{unread}</span> : null}
        {ready && desk && desk.onCurrentWork > 0 ? (
          <span className="text-ui-xs text-foreground">·{desk.onCurrentWork}</span>
        ) : null}
      </Button>
      </ZaicodeRightClickSettings>
      {readerEl && desk && ready ? (
        <ZaicodeSaimailReaderPopover
          desk={desk}
          currentTask={currentTask}
          anchorEl={readerEl}
          onClose={() => setReaderEl(null)}
        />
      ) : null}
      {previewEl && prefs.saimailHoverPreview
        ? (
          <ZaicodeAnchoredCard
            anchor={previewEl.getBoundingClientRect()}
            anchorEl={previewEl}
            width={PANEL_WIDTH}
            side="bottom"
            ariaLabel="SAIMAIL mailbox preview"
          >
              <div className="flex items-center gap-2 border-b border-[var(--zaicode-bevel-dark,var(--color-border))] px-2 py-1">
                <Mail className="size-3" />
                <strong className="font-normal">SAIMAIL{desk ? ` · ${desk.seat}` : ""}</strong>
                <span className="ml-auto text-tooltip-tag-foreground">
                  {!ready ? "not set up" : unread === 0 ? "Empty" : `${unread} unread`}
                </span>
              </div>
              {ready && unread === 0 ? (
                (() => {
                  const empty = getAtmosphericSaimailEmptyText(readSaimailHistory().opened);
                  return (
                    <div className="flex flex-col gap-2 py-3 pr-3 text-left" data-zaicode-saimail-empty>
                      <div className="pl-4 text-ui-base text-foreground opacity-90">{empty.title}</div>
                      <div className="pl-8 text-ui-xs italic text-tooltip-tag-foreground">{empty.subtitle}</div>
                    </div>
                  );
                })()
              ) : (
                <div className="border-b border-[var(--zaicode-bevel-dark,var(--color-border))] px-2 py-1 text-tooltip-tag-foreground">
                  {ZAICODE_SAIMAIL_WHAT}
                </div>
              )}
              {ready && desk
                ? desk.unread.slice(0, prefs.saimailPreviewRows).map((header) => {
                    const onWork = Boolean(currentTask) && header.topic === currentTask;
                    return (
                      <div
                        key={header.envelopeId}
                        className={cn(
                          "flex items-center gap-2 px-2 py-0.5",
                          onWork && "bg-selected",
                        )}
                        title={ZAICODE_SAIMAIL_KIND_WORDS[header.kind]}
                      >
                        <span className="w-9 shrink-0 border border-[var(--zaicode-bevel-light,var(--color-border))] text-center text-[10px] leading-4">
                          {saimailKindShort(header.kind)}
                        </span>
                        <span className="min-w-0 shrink-0 truncate">{header.from}</span>
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate text-tooltip-tag-foreground",
                            onWork && "text-[var(--zaicode-highlight,var(--color-warning))]",
                          )}
                        >
                          {header.topic ?? "no topic"}
                        </span>
                        <span className="shrink-0 tabular-nums text-tooltip-tag-foreground">
                          {saimailAge(header.receivedAt, Date.now())}
                        </span>
                      </div>
                    );
                  })
                : null}
              {ready && unread > prefs.saimailPreviewRows ? (
                <div className="px-2 py-0.5 text-tooltip-tag-foreground">
                  +{unread - prefs.saimailPreviewRows} more
                </div>
              ) : null}
              <div className="border-t border-[var(--zaicode-bevel-dark,var(--color-border))] px-2 py-1 text-tooltip-tag-foreground">
                {ready
                  ? "Headers only. Open a letter to read it."
                  : "Local agent post office. Click: Settings -> ZAICODE -> SAIMAIL."}
              </div>
          </ZaicodeAnchoredCard>
        )
        : null}
    </>
  );
}
