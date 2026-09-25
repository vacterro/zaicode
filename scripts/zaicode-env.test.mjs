import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDesktopProductFlavor,
  resolveDesktopProductIdentity,
} from "../packages/desktop/scripts/desktop-product-identity.mjs";
import {
  assertZaicodeEnv,
  withZaicodeEnv,
  ZCODE_ZAICODE_MODE_ENV,
} from "./zaicode-env.mjs";

const identityEnv = "ZCODE_ZAICODE_IDENTITY";

test("canonical ZAICODE environment sets both product switches and standalone identity", () => {
  const env = withZaicodeEnv({ ZCODE_ENV: "production" });

  assert.equal(env[ZCODE_ZAICODE_MODE_ENV], "1");
  assert.equal(env[identityEnv], "1");
  assert.doesNotThrow(() => assertZaicodeEnv(env));
  assert.equal(resolveDesktopProductFlavor(env), "zaicode");
  assert.deepEqual(resolveDesktopProductIdentity(env), {
    flavor: "zaicode",
    appId: "dev.zaicode.app",
    productName: "ZAICODE",
    linuxExecutableName: "zaicode",
    linuxPackageName: "zaicode",
    cuaHelperInstallVariant: "zaicode",
  });
});

test("canonical assertion rejects a missing product mode", () => {
  assert.throws(
    () => assertZaicodeEnv({ [identityEnv]: "1" }),
    new RegExp(`requires ${ZCODE_ZAICODE_MODE_ENV}=1`),
  );
});

test("canonical assertion rejects a missing identity switch", () => {
  assert.throws(
    () => assertZaicodeEnv({ [ZCODE_ZAICODE_MODE_ENV]: "1" }),
    new RegExp(`requires ${identityEnv}=1`),
  );
});

test("malformed ZAICODE identity switch is rejected", () => {
  const env = { [ZCODE_ZAICODE_MODE_ENV]: "1", [identityEnv]: "true" };
  assert.throws(() => assertZaicodeEnv(env), new RegExp(`requires ${identityEnv}=1`));
  assert.throws(() => resolveDesktopProductFlavor({ [identityEnv]: "true" }), /invalid/);
});

test("normal production and test identities remain production and preview", () => {
  assert.equal(resolveDesktopProductFlavor({ ZCODE_ENV: "production" }), "production");
  assert.equal(resolveDesktopProductFlavor({ ZCODE_ENV: "test" }), "preview");
});
