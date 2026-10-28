import assert from "node:assert/strict";
import test from "node:test";
import { ZAICODE_PRODUCT_MODE_ENV } from "@zcode/shared";
import { getZCodeDataRootDir, getAppConfigDir, getConversationWorkspaceDir } from "../src/paths.js";

test("packaged data isolation: ZAICODE and production roots are disjoint", () => {
  const originalEnv = process.env[ZAICODE_PRODUCT_MODE_ENV];
  try {
    process.env[ZAICODE_PRODUCT_MODE_ENV] = "1";
    const zaicodeRoot = getZCodeDataRootDir();
    const zaicodeConfig = getAppConfigDir();
    const zaicodeWorkspace = getConversationWorkspaceDir();

    assert.ok(zaicodeRoot.endsWith(".zaicode"), `ZAICODE root must end with .zaicode, got ${zaicodeRoot}`);
    assert.ok(zaicodeConfig.includes(".zaicode"), `ZAICODE config dir must reside within .zaicode, got ${zaicodeConfig}`);
    assert.ok(zaicodeWorkspace.includes(".zaicode"), `ZAICODE workspace dir must reside within .zaicode, got ${zaicodeWorkspace}`);

    process.env[ZAICODE_PRODUCT_MODE_ENV] = "0";
    const prodRoot = getZCodeDataRootDir();
    const prodConfig = getAppConfigDir();
    const prodWorkspace = getConversationWorkspaceDir();

    assert.ok(prodRoot.endsWith(".zcode"), `Production root must end with .zcode, got ${prodRoot}`);
    assert.ok(prodConfig.includes(".zcode"), `Production config dir must reside within .zcode, got ${prodConfig}`);
    assert.ok(prodWorkspace.includes(".zcode"), `Production workspace dir must reside within .zcode, got ${prodWorkspace}`);

    assert.notEqual(zaicodeRoot, prodRoot, "ZAICODE and production data root directories must never collide");
  } finally {
    if (originalEnv === undefined) {
      delete process.env[ZAICODE_PRODUCT_MODE_ENV];
    } else {
      process.env[ZAICODE_PRODUCT_MODE_ENV] = originalEnv;
    }
  }
});
