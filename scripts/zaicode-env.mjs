import {
  ZCODE_ZAICODE_IDENTITY_ENV,
  resolveDesktopProductFlavor,
  resolveDesktopProductIdentity,
} from "../packages/desktop/scripts/desktop-product-identity.mjs";

export const ZCODE_ZAICODE_MODE_ENV = "ZCODE_ZAICODE_MODE";

export function withZaicodeEnv(env = process.env) {
  return {
    ...env,
    [ZCODE_ZAICODE_MODE_ENV]: "1",
    [ZCODE_ZAICODE_IDENTITY_ENV]: "1",
  };
}

export function assertZaicodeEnv(env = process.env) {
  const mode = env[ZCODE_ZAICODE_MODE_ENV]?.trim() ?? "";
  const identity = env[ZCODE_ZAICODE_IDENTITY_ENV]?.trim() ?? "";
  if (mode !== "1") {
    throw new Error(
      `ZAICODE build lane requires ${ZCODE_ZAICODE_MODE_ENV}=1, got ${JSON.stringify(mode)}`,
    );
  }
  if (identity !== "1") {
    throw new Error(
      `ZAICODE build lane requires ${ZCODE_ZAICODE_IDENTITY_ENV}=1, got ${JSON.stringify(identity)}`,
    );
  }
  const flavor = resolveDesktopProductFlavor(env);
  if (flavor !== "zaicode") {
    throw new Error(`ZAICODE lane resolved flavor=${flavor}, want zaicode`);
  }
  const identity2 = resolveDesktopProductIdentity(env);
  if (identity2.appId !== "dev.zaicode.app" || identity2.productName !== "ZAICODE") {
    throw new Error(
      `ZAICODE lane identity mismatch appId=${identity2.appId} productName=${identity2.productName}`,
    );
  }
}

if (process.argv.includes("--check")) {
  try {
    assertZaicodeEnv(withZaicodeEnv(process.env));
    console.log("zaicode-env: flavor=zaicode appId=dev.zaicode.app productName=ZAICODE ok");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
