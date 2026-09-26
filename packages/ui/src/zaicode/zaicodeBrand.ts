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
/** "Support Developer": the developer's sponsorship page (operator, SRC-049). */
export const ZAICODE_SUPPORT_URL = "https://buymeacoffee.com/vacuum34";
