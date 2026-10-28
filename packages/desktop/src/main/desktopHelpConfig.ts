import { net } from "electron";
import {
  buildHelpAppConfigUrl,
  buildZCodeSourceHeadersFromContext,
  createHelpAppConfigReader,
  ZCODE_ENV,
} from "@zcode/shared";

export function createDesktopHelpConfigReader(options: {
  resolveEndpointOrigin: () => Promise<string>;
  appVersion: string;
  deviceMid: string;
}) {
  // net.fetch's first arg is string | Request (no URL); the DOM fetch signature the
  // reader types against also allows URL. Normalise URL -> string at the boundary.
  const read = createHelpAppConfigReader({
    fetchImpl: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
  });
  return async () => {
    const endpointOrigin = await options.resolveEndpointOrigin();
    return read(
      buildHelpAppConfigUrl(
        endpointOrigin,
        options.appVersion,
        `${process.platform}-${process.arch}`,
      ),
      buildZCodeSourceHeadersFromContext({
        endpointOrigin,
        appVersion: options.appVersion,
        deviceMid: options.deviceMid,
        platform: process.platform,
        arch: process.arch,
        releaseChannel: ZCODE_ENV,
        sourceTitle: "electron",
      }),
    );
  };
}
