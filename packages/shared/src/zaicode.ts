export const ZAICODE_PRODUCT_MODE_ENV = "ZCODE_ZAICODE_MODE";

interface ZaicodeRuntimeGlobals {
  __ZAICODE_PRODUCT_MODE__?: boolean;
  process?: { env?: Record<string, string | undefined> };
}

function readTruthy(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

export function isZaicodeProductMode(): boolean {
  const globals = globalThis as ZaicodeRuntimeGlobals;
  if (typeof globals.__ZAICODE_PRODUCT_MODE__ === "boolean") {
    return globals.__ZAICODE_PRODUCT_MODE__;
  }
  return readTruthy(globals.process?.env?.[ZAICODE_PRODUCT_MODE_ENV]);
}
