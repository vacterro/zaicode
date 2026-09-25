import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { WorkspaceTerminalToggleButton } from "@/WorkspaceTerminalToggleButton.js";
import { cn } from "@/components/lib/utils.js";
import type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { isZaicodeProductMode } from "@zcode/shared";
import { ZaicodeSaimailHeaderButton } from "@/zaicode/ZaicodeSaimailHeaderButton.js";
import { ZaicodeLimitMeter } from "@/zaicode/ZaicodeLimitMeter.js";
import { ZaicodeTopbarClock } from "@/zaicode/ZaicodeTopbarClock.js";

export type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeaderActionSection({
  variant = "task",
  activeTaskId,
  user,
  readOnlyReason,
  workspaceAbsPath,
  workspaceIdentity,
  remoteTarget,
  isDesktop,
  isTerminalOpen,
  isSidePaneOpen,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onSelectedEditorChange,
  simplifyForNarrowRemote = false,
  hideHelpMenu = false,
  showWindowControls = false,
  useWindowsCaptionSpacing = false,
}: WorkspaceHeaderActionSectionProps) {
  // ZAICODE：标题栏首位留给 SAIMAIL 信封（操作员最常看的信号），
  // 「在编辑器/资源管理器中打开」移到终端按钮之后。
  const zaicode = isZaicodeProductMode();
  const editorButtons =
    variant === "task" ? (
      <WorkspaceEditorButtonGroup
        disabledReason={readOnlyReason}
        workspaceAbsPath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        remoteTarget={remoteTarget}
        onSelectedEditorChange={onSelectedEditorChange}
      />
    ) : null;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center [app-region:no-drag]",
        // Windows header 内容区有 p-2，普通工具栏按钮 hover 只覆盖 32px 高度。
        // 标题栏按钮需要抵消这层垂直内边距，和原生窗控/右侧菜单保持同一个 48px hover 面。
        useWindowsCaptionSpacing ? "-my-2 h-12 gap-0" : "gap-0.5",
      )}
    >
      {zaicode ? <ZaicodeTopbarClock useWindowsCaptionSpacing={useWindowsCaptionSpacing} /> : null}
      {zaicode ? <ZaicodeLimitMeter useWindowsCaptionSpacing={useWindowsCaptionSpacing} /> : null}
      {zaicode && workspaceAbsPath ? (
        <ZaicodeSaimailHeaderButton
          workspacePath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {zaicode ? null : editorButtons}
      {/* 分享发布接口依赖登录态；未登录时隐藏入口，避免用户打开后只能得到鉴权失败。
          ZAICODE 无账号、无对外分享，这个企业化入口从标题栏里彻底移除。 */}
      {!zaicode && activeTaskId && user && isDesktop !== false ? (
        <ConversationShareMenu
          taskId={activeTaskId}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {!simplifyForNarrowRemote ? (
        <>
          {/* ZAICODE：帮助菜单移入左下角用户菜单（Help & about），标题栏这组只留 SAIMAIL 信封。 */}
          {!hideHelpMenu && !zaicode ? <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} /> : null}
          {/* 远程控制移动端头部空间过窄，终端入口在这里会和核心操作争抢宽度。*/}
          <WorkspaceTerminalToggleButton
            isTerminalOpen={isTerminalOpen}
            onToggleTerminal={onToggleTerminal}
            disabledReason={readOnlyReason}
            useWindowsCaptionSpacing={useWindowsCaptionSpacing}
          />
        </>
      ) : null}
      {zaicode ? editorButtons : null}
      {/* 远程控制移动端只保留图标，避免 diff 数字把按钮撑宽导致标题拥挤。 */}
      {!isSidePaneOpen ? (
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen={isSidePaneOpen}
          onToggleSidePane={onToggleSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {showWindowControls && !isSidePaneOpen ? <DesktopWindowControls /> : null}
    </div>
  );
}
