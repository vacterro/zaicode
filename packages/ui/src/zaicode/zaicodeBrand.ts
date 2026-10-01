import { isZaicodeProductMode } from "@zcode/shared";
import upstreamAppLogoUrl from "@/assets/provider-icons/logo-zai.svg";
import zaicodeAppLogoUrl from "@/assets/zaicode-logo-20.png";

/**
 * App logo shown in the window chrome (sidebar header, collapsed rail,
 * settings title). ZAICODE uses the operator's SAIPEN mark (pre-scaled to the
 * 20px slot so pixel mode stays sharp); upstream keeps the Z.ai logo.
 */
export function appLogoUrl(): string {
  return isZaicodeProductMode() ? zaicodeAppLogoUrl : upstreamAppLogoUrl;
}

/** The public repository (Settings sidebar link; the Onboard wizard's old place, SRC-049). */
export const ZAICODE_REPO_URL = "https://github.com/vacterro/zaicode";
/**
 * SRC-114: reporting that actually lands somewhere. The in-app feedback dialog
 * has no inbox behind it, so a bug found in ZAICODE ended in a dead end. These
 * open GitHub with the kind and the version already in the form, which is what
 * makes a report usable instead of merely filed.
 */
export const ZAICODE_ISSUE_URL = `${ZAICODE_REPO_URL}/issues/new?labels=bug&template=bug_report.yml`;
export const ZAICODE_FEATURE_URL = `${ZAICODE_REPO_URL}/issues/new?labels=enhancement&template=feature_request.yml`;
/** "Support Developer": the developer's sponsorship page (operator, SRC-049). */
export const ZAICODE_SUPPORT_URL = "https://buymeacoffee.com/vacuum34";
/** The SAIPEN community Discord invite (Settings sidebar bottom link). */
export const ZAICODE_DISCORD_URL = "https://discord.gg/SEYaYkuVgN";
