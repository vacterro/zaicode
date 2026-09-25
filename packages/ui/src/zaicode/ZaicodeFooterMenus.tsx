import { useState } from "react";
import {
  ActivityIcon,
  BookOpenIcon,
  CircleHelpIcon,
  ImageOff,
  ImageUp,
  InfoIcon,
  Palette,
  Plus,
  Trash2,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { DesktopCommandIds } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ZAICODE_PROFILE_ICON_SLOTS, ZaicodeIcon } from "./zaicodeIconSlots.js";
import { ZAICODE_PALETTES, ZAICODE_PALETTE_NONE } from "./zaicodePalettes.js";
import { useZaicodeColorStudio } from "./zaicodeColorStudio.js";
import { openZaicodeHelp, openZaicodeSettings } from "./zaicodeActions.js";
import { setZaicodeCrisp, setZaicodePalette, useZaicodeAppearance } from "./zaicodeAppearance.js";
import {
  ZAICODE_DEFAULT_AVATARS,
  addZaicodeAvatarUpload,
  addZaicodeProfile,
  readZaicodeAvatarFile,
  removeZaicodeAvatarUpload,
  removeZaicodeProfile,
  resolveZaicodeAvatarUrl,
  selectZaicodeProfile,
  updateZaicodeProfile,
  useZaicodeAvatarUploads,
  useZaicodeProfiles,
  type ZaicodeProfile,
} from "./zaicodeProfiles.js";

/** Profile picture: the chosen/uploaded avatar, otherwise the generic icon. */
export function ZaicodeProfileAvatar({
  profile,
  className,
}: {
  profile: Pick<ZaicodeProfile, "icon" | "avatar">;
  className?: string;
}) {
  const url = resolveZaicodeAvatarUrl(profile.avatar);
  if (url) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        className={cn("size-4 shrink-0 object-cover [image-rendering:auto]", className)}
      />
    );
  }
  return <ZaicodeIcon slot={profile.icon} className={className} />;
}

/** Footer badge content: active local profile picture + name (replaces "Connect"). */
export function ZaicodeProfileBadge() {
  const { active } = useZaicodeProfiles();
  const hasAvatar = Boolean(resolveZaicodeAvatarUrl(active.avatar));
  return (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden border border-border bg-background text-foreground">
        <ZaicodeProfileAvatar profile={active} className={hasAvatar ? "size-8" : undefined} />
      </span>
      <div className="min-w-0 flex-1 overflow-hidden text-left">
        <span className="block min-w-0 truncate text-ui-base font-semibold text-foreground">
          {active.name}
        </span>
      </div>
    </>
  );
}

export function ZaicodeProfileMenuSub() {
  const { intl } = useZCodeIntl();
  const { profiles, activeId, active } = useZaicodeProfiles();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploads = useZaicodeAvatarUploads();
  // Right-click on an uploaded photo asks first; nothing is deleted without the confirm click.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // 文件框用临时 input 打开：菜单关闭/重挂载不会丢掉 onchange（固定挂在菜单里的 input 会随菜单卸载）。
  const pickPhoto = () => {
    const profileId = active.id;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void readZaicodeAvatarFile(file)
        .then((avatar) => {
          addZaicodeAvatarUpload(avatar);
          updateZaicodeProfile(profileId, { avatar });
          setUploadError(null);
        })
        .catch((error: unknown) =>
          setUploadError(error instanceof Error ? error.message : String(error)),
        );
    };
    input.click();
  };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <ZaicodeIcon slot="footer.profiles" />
        {intl.formatMessage({ id: "zaicode.profiles.title" })}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        <p className="px-2 py-1 text-ui-xs text-foreground-subtle" data-zaicode-profile-hint>
          Each profile keeps all its own settings: theme and colours, fonts, sounds, hotkeys, layout,
          highlights, meters, SAIHOME. Switching saves this one and reloads the window with the other.
          A new profile starts as a copy of the current one.
        </p>
        <DropdownMenuRadioGroup value={activeId} onValueChange={selectZaicodeProfile}>
          {profiles.map((profile) => (
            <DropdownMenuRadioItem key={profile.id} value={profile.id}>
              <ZaicodeProfileAvatar profile={profile} />
              {profile.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuItem onSelect={addZaicodeProfile}>
          <Plus className="size-4" />
          {intl.formatMessage({ id: "zaicode.profiles.add" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{intl.formatMessage({ id: "zaicode.profiles.name" })}</DropdownMenuLabel>
        <div className="px-2 pb-1">
          <Input
            value={active.name}
            // 菜单的 typeahead 会吞掉按键，输入框内的按键不能冒泡到菜单。
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => updateZaicodeProfile(active.id, { name: event.target.value })}
          />
        </div>
        <DropdownMenuLabel>{intl.formatMessage({ id: "zaicode.profiles.icon" })}</DropdownMenuLabel>
        <div className="grid grid-cols-6 gap-1 px-2 pb-1">
          {ZAICODE_PROFILE_ICON_SLOTS.map((slot) => (
            <button
              key={slot}
              type="button"
              aria-pressed={active.icon === slot}
              title={slot}
              className={
                active.icon === slot
                  ? "flex size-7 items-center justify-center border border-border-hover bg-selected"
                  : "flex size-7 items-center justify-center border border-transparent hover:bg-hover"
              }
              onClick={() => updateZaicodeProfile(active.id, { icon: slot, avatar: null })}
            >
              <ZaicodeIcon slot={slot} />
            </button>
          ))}
        </div>
        <DropdownMenuLabel>Picture</DropdownMenuLabel>
        <div className="grid grid-cols-6 gap-1 px-2 pb-1" data-zaicode-avatar-grid>
          {ZAICODE_DEFAULT_AVATARS.map((avatar) => (
            <button
              key={avatar.id}
              type="button"
              aria-pressed={active.avatar === avatar.id}
              title={avatar.label}
              className={cn(
                "flex size-7 items-center justify-center overflow-hidden border",
                active.avatar === avatar.id
                  ? "border-[var(--zaicode-highlight,var(--color-border-hover))]"
                  : "border-transparent hover:border-border",
              )}
              onClick={() => updateZaicodeProfile(active.id, { avatar: avatar.id })}
            >
              <img src={avatar.url} alt="" className="size-full object-cover [image-rendering:auto]" />
            </button>
          ))}
        </div>
        {uploads.length > 0 ? (
          <>
            <DropdownMenuLabel title="Photos you uploaded. Click: use. Right-click: delete (asks first).">
              My photos
            </DropdownMenuLabel>
            <div className="grid grid-cols-6 gap-1 px-2 pb-1" data-zaicode-avatar-uploads>
              {uploads.map((upload) => (
                <button
                  key={upload.id}
                  type="button"
                  aria-pressed={active.avatar === upload.dataUri}
                  title="Click: use this photo · Right-click: delete"
                  className={cn(
                    "flex size-7 items-center justify-center overflow-hidden border",
                    pendingDelete === upload.id
                      ? "border-destructive"
                      : active.avatar === upload.dataUri
                        ? "border-[var(--zaicode-highlight,var(--color-border-hover))]"
                        : "border-transparent hover:border-border",
                  )}
                  onClick={() => {
                    setPendingDelete(null);
                    updateZaicodeProfile(active.id, { avatar: upload.dataUri });
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setPendingDelete(upload.id);
                  }}
                >
                  <img src={upload.dataUri} alt="" className="size-full object-cover [image-rendering:auto]" />
                </button>
              ))}
            </div>
            {pendingDelete ? (
              <div role="alertdialog" aria-label="Delete this photo?" className="flex items-center gap-1 px-2 pb-1 text-ui-xs">
                <span className="min-w-0 flex-1 text-foreground-subtle">Delete this photo from the list?</span>
                <button
                  type="button"
                  className="border border-destructive px-1.5 text-destructive hover:bg-hover"
                  onClick={() => {
                    removeZaicodeAvatarUpload(pendingDelete);
                    setPendingDelete(null);
                  }}
                >
                  Delete
                </button>
                <button type="button" className="border border-border px-1.5 hover:bg-hover" onClick={() => setPendingDelete(null)}>
                  Keep
                </button>
              </div>
            ) : null}
          </>
        ) : null}
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            pickPhoto();
          }}
        >
          <ImageUp className="size-4" />
          Upload my photo…
        </DropdownMenuItem>
        {active.avatar ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              updateZaicodeProfile(active.id, { avatar: null });
            }}
          >
            <ImageOff className="size-4" />
            Remove picture (use icon)
          </DropdownMenuItem>
        ) : null}
        {uploadError ? (
          <div role="alert" className="px-2 pb-1 text-ui-xs text-destructive">
            {uploadError}
          </div>
        ) : null}
        {profiles.length > 1 ? (
          <DropdownMenuItem onSelect={() => removeZaicodeProfile(active.id)}>
            <Trash2 className="size-4" />
            {intl.formatMessage({ id: "zaicode.profiles.remove" })}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function ZaicodePaletteMenuSub() {
  const { intl } = useZCodeIntl();
  const { palette, crisp } = useZaicodeAppearance();
  const { customs } = useZaicodeColorStudio();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Palette className="size-4" />
        {intl.formatMessage({ id: "zaicode.palette.title" })}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[70vh] w-56 overflow-y-auto">
        <DropdownMenuCheckboxItem
          checked={crisp}
          onCheckedChange={(checked) => setZaicodeCrisp(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {intl.formatMessage({ id: "zaicode.palette.crisp" })}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void openZaicodeSettings("zaicodeColors")}>
          <Palette className="size-4" />
          Color Studio…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={palette} onValueChange={setZaicodePalette}>
          {[...customs, ...ZAICODE_PALETTES].map((candidate) => (
            <DropdownMenuRadioItem key={candidate.slug} value={candidate.slug}>
              <span
                aria-hidden
                className="size-3 shrink-0 border border-border"
                style={{ background: candidate.tokens.background }}
              />
              <span
                aria-hidden
                className="size-3 shrink-0 border border-border"
                style={{ background: candidate.tokens.textPrimary }}
              />
              {candidate.label}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuRadioItem value={ZAICODE_PALETTE_NONE}>
            {intl.formatMessage({ id: "zaicode.palette.none" })}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * Help & about, moved out of the title bar into the operator menu (ZAICODE
 * keeps only the SAIMAIL envelope up there): ZAICODE's own Help, the resource
 * manager and About. Upstream's vendor docs, issue form, community and
 * feedback links are not ZAICODE's and are left out.
 */
export function ZaicodeHelpMenuSub({ isDesktop }: { isDesktop: boolean }) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <CircleHelpIcon className="size-4" />
        Help &amp; about
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        <DropdownMenuItem onSelect={() => void openZaicodeHelp()}>
          <BookOpenIcon className="size-4" />
          ZAICODE Help (F1)
        </DropdownMenuItem>
        {isDesktop ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void platform.executeDesktopCommand(DesktopCommandIds.OpenResourceManager)}
            >
              <ActivityIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.resourceManager" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void platform.executeDesktopCommand(DesktopCommandIds.ShowAbout)}
            >
              <InfoIcon className="size-4" />
              {intl.formatMessage({ id: "titleBar.menu.help.about" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
