import {
  MousePointer2,
  Monitor,
  Moon,
  Settings,
  Settings2,
  Package,
  Bot,
  Cpu,
  Gauge,
  Network,
  Volume2,
  Palette,
  PanelLeft,
  Sun,
  BarChart3,
  Terminal,
  AlarmClock,
  Anchor,
  Brain,
  Blocks,
  Globe2,
  Cable,
  WandSparkles,
  Keyboard,
  FileSearch,
  LayoutPanelTop,
  SquareTerminal,
  Bell,
  Timer,
  Command,
  LifeBuoy,
  Sparkle,
  Type,
} from "lucide-react";
import { isSettingsSectionEnabled, resolveSettingsSection, type SettingsSectionId } from "@/lib/settingsNavigation.js";
import type { Theme } from "@/useTheme.js";

export const THEME_MODES: Array<{
  mode: Theme;
  icon: typeof Sun;
}> = [
  { mode: "system", icon: Monitor },
  { mode: "zai-dark", icon: Moon },
  { mode: "zai-light", icon: Sun },
];

type SettingsSectionGroupId = "basics" | "zaicode" | "agentCapabilities" | "dataAndStats";

interface SettingsSectionDefinition {
  id: SettingsSectionId;
  icon: typeof Settings;
  titleId: string;
  contentTitleId?: string;
  titleBadgeId?: string;
  groupId: SettingsSectionGroupId;
  /**
   * 低频设置：仍然一眼可达，但收进分组末尾默认折叠的「高级」块。
   * 用户按重要性自上而下扫读，装饰性与可选集成不该占住第一屏。
   */
  advanced?: boolean;
  /**
   * The words someone actually types to find this section. Section titles are fixed labels;
   * nobody looking for the thing that changes their font size is going to guess "Appearance".
   * Kept next to the section rather than in a separate index so the two cannot drift apart.
   */
  keywords?: readonly string[];
}

const BASE_SETTINGS_SECTION_GROUPS: Array<{
  id: SettingsSectionGroupId;
  titleId: string;
}> = [
  { id: "basics", titleId: "settings.sidebar.group.basics" },
  // ZAICODE: every ZAICODE page in one group, in the order people look for them.
  { id: "zaicode", titleId: "settings.sidebar.group.zaicode" },
  {
    id: "agentCapabilities",
    titleId: "settings.sidebar.group.agentCapabilities",
  },
  { id: "dataAndStats", titleId: "settings.sidebar.group.dataAndStats" },
];

const BASE_SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "general",
    keywords: ["language","locale","startup","update","proxy","reset","default"],
    icon: Settings2,
    titleId: "settings.systemTitle",
    groupId: "basics",
  },
  {
    id: "appearance",
    keywords: ["theme","color","colors","font","font size","dark","light","style","zoom","contrast"],
    icon: Palette,
    titleId: "settings.appearanceTitle",
    groupId: "basics",
  },
  {
    id: "modelProvider",
    keywords: ["model","provider","api key","token","openai","anthropic","claude","gemini","ollama","llm","free models"],
    icon: Package,
    titleId: "settings.modelProviderTitle",
    groupId: "basics",
  },
  {
    id: "memory",
    keywords: ["memory","context","claude md","agents md","instructions","rules"],
    icon: Brain,
    titleId: "settings.memory",
    groupId: "agentCapabilities",
  },
  {
    id: "subagents",
    keywords: ["subagent","sub agent","agent","agents","delegate","parallel"],
    icon: Bot,
    titleId: "settings.subagents.title",
    groupId: "agentCapabilities",
  },
  {
    id: "zaicode",
    keywords: ["zaicode","core","product"],
    icon: Cpu,
    titleId: "settings.zaicode.title",
    groupId: "zaicode",
  },
  {
    id: "zaicodeSidebar",
    keywords: ["sidebar","left bar","rail","panel"],
    icon: PanelLeft,
    titleId: "settings.zaicodeSidebar.title",
    groupId: "zaicode",
  },
  {
    id: "zaicodeLayout",
    keywords: ["layout","footer","toolbar","header","position"],
    icon: LayoutPanelTop,
    titleId: "settings.zaicodeLayout.title",
    groupId: "zaicode",
  },
  {
    id: "zaicodeEngines",
    keywords: ["engine","engines","limit","reset","quota","pool"],
    icon: Gauge,
    titleId: "settings.zaicodeEngines.title",
    groupId: "zaicode",
  },
  {
    id: "zaicodeRouter",
    keywords: ["router","routing","9router","proxy","model routing"],
    icon: Network,
    titleId: "settings.zaicodeRouter.title",
    groupId: "zaicode",
  },
  {
    id: "zaicodeWorkers",
    keywords: ["worker","workers","scheduled","terminal","sai"],
    icon: SquareTerminal,
    titleId: "settings.zaicodeWorkers.title",
    groupId: "zaicode",
  },
  // 以下 ZAICODE 分区是装饰与可选集成，不是日常配置：收进分组末尾的高级块。
  {
    id: "zaicodeSounds",
    keywords: ["sound","sounds","audio","beep","chime","mute"],
    icon: Volume2,
    titleId: "settings.zaicodeSounds.title",
    groupId: "zaicode",
    advanced: true,
  },
  {
    id: "zaicodeNotifications",
    keywords: ["notification","notifications","bell","alert","toast"],
    icon: Bell,
    titleId: "settings.zaicodeNotifications.title",
    groupId: "zaicode",
    advanced: true,
  },
  {
    id: "zaicodeColors",
    keywords: ["color","colors","accent","tint","highlight"],
    icon: Palette,
    titleId: "settings.zaicodeColors.title",
    groupId: "zaicode",
    advanced: true,
  },
  {
    id: "zaicodeLights",
    keywords: ["light","lights","glow","shine","sparkle"],
    icon: Sparkle,
    titleId: "settings.zaicodeLights.title",
    groupId: "zaicode",
    advanced: true,
  },
  {
    id: "zaicodeSessionText",
    keywords: ["text","font","font size","typography"],
    icon: Type,
    titleId: "settings.zaicodeSessionText.title",
    groupId: "zaicode",
    advanced: true,
  },
  {
    id: "zaicodeProtrail",
    keywords: ["protrail","trail","cursor","mouse trail"],
    icon: MousePointer2,
    titleId: "settings.zaicodeProtrail.title",
    groupId: "zaicode",
    advanced: true,
  },
  {
    id: "zaicodeTimers",
    keywords: ["timer","timers","clock","countdown","reminder"],
    icon: Timer,
    titleId: "settings.zaicodeTimers.title",
    groupId: "zaicode",
  },
  {
    id: "zaicodeHotkeys",
    keywords: ["hotkey","hotkeys","keybinding","shortcut"],
    icon: Command,
    titleId: "settings.zaicodeHotkeys.title",
    groupId: "zaicode",
  },
  {
    id: "zaicodeHelp",
    keywords: ["help","support","docs","about","github"],
    icon: LifeBuoy,
    titleId: "settings.zaicodeHelp.title",
    groupId: "zaicode",
  },
  {
    id: "plugin",
    keywords: ["plugin","plugins","extension","marketplace","store"],
    icon: Blocks,
    titleId: "settings.plugins.title",
    groupId: "agentCapabilities",
  },
  {
    id: "mcp",
    keywords: ["mcp","server","servers","stdio"],
    icon: Cable,
    titleId: "settings.mcpTitle",
    groupId: "agentCapabilities",
  },
  {
    id: "skill",
    keywords: ["skill","skills","capability","prompt"],
    icon: WandSparkles,
    titleId: "settings.skills.title",
    groupId: "agentCapabilities",
  },
  {
    id: "commands",
    keywords: ["command","commands","slash","cli"],
    icon: Terminal,
    titleId: "settings.commands.title",
    groupId: "agentCapabilities",
  },
  {
    id: "automations",
    keywords: ["automation","automations","scheduled","cron","timer"],
    icon: AlarmClock,
    titleId: "settings.automations.title",
    titleBadgeId: "settings.automations.betaBadge",
    groupId: "agentCapabilities",
  },
  {
    id: "hooks",
    keywords: ["hook","hooks","trigger","event"],
    icon: Anchor,
    titleId: "settings.hooks.title",
    groupId: "agentCapabilities",
  },
  {
    id: "browser",
    keywords: ["browser","chrome","playwright","web","page"],
    icon: Globe2,
    titleId: "settings.browser.title",
    groupId: "basics",
  },
  // 电脑控制紧跟「浏览器」：两者都是给 Agent 用的本机操控入口，
  // 放在基础设置里让用户在同一处理解「控制浏览器 / 控制整台电脑」的关系。
  {
    id: "computerUse",
    keywords: ["computer","screen","mouse","desktop","click"],
    icon: Monitor,
    titleId: "settings.computerUse.title",
    groupId: "basics",
  },
  // 键盘快捷键紧跟「电脑控制」：同属本机操控/效率配置，收纳在基础设置尾部。
  {
    id: "shortcuts",
    keywords: ["shortcut","shortcuts","keybinding","hotkey","keyboard"],
    icon: Keyboard,
    titleId: "settings.shortcuts.title",
    groupId: "basics",
  },
  // 工作区搜索范围（.zcodeignore）：面向所有用户的基础工作区行为配置，收在基础设置末尾。
  {
    id: "workspaceFileSearch",
    keywords: ["search","ignore","zcodeignore","file search","exclude","files"],
    icon: FileSearch,
    titleId: "settings.workspaceFileSearch.title",
    groupId: "basics",
  },
  {
    id: "usage",
    keywords: ["usage","tokens","spend","cost","9router","statistics","stats"],
    icon: BarChart3,
    titleId: "settings.usageTitle",
    groupId: "dataAndStats",
  },
];

// 兼容既有只读消费者：默认配置代表不带桌面平台能力的 Web 视图；
// macOS/Windows/Linux 必须继续通过 createSettingsPageConfig 动态加入 Computer Use。
export const SETTINGS_SECTIONS = BASE_SETTINGS_SECTIONS.filter(
  (section) => section.id !== "computerUse" && isSettingsSectionEnabled(section.id),
);

interface SettingsPageConfigOptions {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}

export function createSettingsPageConfig({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
}: SettingsPageConfigOptions = {}) {
  const showComputerUse = isDesktop || isMacDesktop || isWindowsDesktop;
  const settingsSections = BASE_SETTINGS_SECTIONS.filter((section) => {
    if (section.id === "computerUse" && !showComputerUse) return false;
    return isSettingsSectionEnabled(section.id);
  });
  const settingsSectionGroups = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: settingsSections.filter(
      (section) => section.groupId === group.id && !section.advanced,
    ),
    advancedSections: settingsSections.filter(
      (section) => section.groupId === group.id && section.advanced,
    ),
  })).filter((group) => group.sections.length > 0 || group.advancedSections.length > 0);

  return { settingsSectionGroups, settingsSections };
}

export function resolveSettingsSectionForPlatform(
  section: SettingsSectionId,
  visibleSections: ReadonlyArray<Pick<SettingsSectionDefinition, "id">>,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  section = resolveSettingsSection(section, fallbackSection);
  if (visibleSections.some((candidate) => candidate.id === section)) return section;
  if (visibleSections.some((candidate) => candidate.id === fallbackSection)) {
    return fallbackSection;
  }
  return visibleSections[0]?.id ?? "general";
}

export type { SettingsSectionId };

/** One section as the search sees it: the label the operator actually reads, plus its keywords. */
export interface SettingsSectionSearchEntry {
  id: SettingsSectionId;
  title: string;
  keywords: readonly string[];
}

/**
 * The sections that answer what was typed, in the order they were offered.
 *
 * Every whitespace-separated token has to hit somewhere in the section's title or its keywords,
 * which is what makes "dark font" find Appearance rather than everything containing one of the two
 * words. An empty query is not a filter: it returns the list untouched, so clearing the box cannot
 * silently reorder or drop a section the operator could see a moment ago.
 */
export function searchSettingsSections<T extends SettingsSectionSearchEntry>(
  entries: readonly T[],
  query: string,
): T[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = `${entry.title} ${entry.keywords.join(" ")}`.toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}
