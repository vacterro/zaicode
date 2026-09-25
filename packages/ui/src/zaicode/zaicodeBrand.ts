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
