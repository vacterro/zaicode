import type { IPlatformService } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { openZaicodeHelp } from "@/zaicode/zaicodeActions.js";
import { ZAICODE_ISSUE_URL, ZAICODE_FEATURE_URL, ZAICODE_REPO_URL } from "@/zaicode/zaicodeBrand.js";

interface HelpMenuActionHandlers {
  /** SRC-114: the Help line opens ZAICODE's own encyclopedia, not the vendor's docs site. */
  openZaicodeHelp: () => void;
  openIssueReport: () => Promise<void>;
  /** SRC-114: a GitHub issue that already knows what it is about. */
  openGitHubIssue: () => void;
  openGitHubFeature: () => void;
  openRepository: () => void;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
  openSubmit,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
  openSubmit: (draft?: FeedbackSubmitDraft) => void;
}): HelpMenuActionHandlers {
  return {
    openZaicodeHelp: () => {
      // The old line opened the upstream vendor's documentation site, which
      // documents a product ZAICODE is not. ZAICODE's own Help is the right target.
      openZaicodeHelp();
    },
    openIssueReport: async () => {
      openSubmit({
        type: "bug",
        module: "其它",
        severity: "P2-中",
        includeLogs: false,
        screenshots: [],
      });
    },
    openGitHubIssue: () => {
      platform.openExternal(ZAICODE_ISSUE_URL);
    },
    openGitHubFeature: () => {
      platform.openExternal(ZAICODE_FEATURE_URL);
    },
    openRepository: () => {
      platform.openExternal(ZAICODE_REPO_URL);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}