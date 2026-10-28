import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// T-130 (SRC-093): the main half of the engines cannot be loaded without Electron, so the rules that keep a spent reset from
// being a mistake are pinned in its source: who may be asked, one spend at a time, a key per attempt, a fresh read afterwards.

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, "..", "..", relative), "utf8").replace(/\r\n/g, "\n");

const engines = read("desktop/src/main/zaicodeEngines.ts");
const ipc = read("desktop/src/main/desktopMainIpcPlatform.ts");
const preload = read("desktop/src/preload/index.ts");
const channels = read("shared/src/channels.ts");
const platform = read("shared/src/platform.ts");

/** The body of the function called `name`, up to the next top-level declaration. */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(name);
  assert.ok(start >= 0, `${name} exists`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end < 0 ? undefined : end);
}

test("the spend channel crosses all four layers with a contract", () => {
  assert.ok(channels.includes('ConsumeZaicodeResetCredit: "zaicode:consume-reset-credit"'));
  assert.ok(channels.includes("[PlatformChannels.ConsumeZaicodeResetCredit]: {"));
  assert.ok(ipc.includes("ipcMain.handle(PlatformChannels.ConsumeZaicodeResetCredit,"));
  assert.ok(ipc.includes("consumeZaicodeResetCredit(record.accountId, record.creditId)"));
  assert.ok(preload.includes("ipcRenderer.invoke(PlatformChannels.ConsumeZaicodeResetCredit, request)"));
  assert.ok(platform.includes("consumeZaicodeResetCredit?("));
});

test("only a ready Codex account can be asked, one spend per account at a time, each attempt has its own key", () => {
  const spend = bodyOf(engines, "export async function consumeZaicodeResetCredit");
  assert.ok(spend.includes('account.vendor !== "codex"'), "other vendors are refused");
  assert.ok(spend.includes('account.status === "ready"'), "an account that is not ready is refused");
  assert.ok(spend.includes("spendingResets.has(account.id)") && spend.includes("spendingResets.add(account.id)") && spend.includes("spendingResets.delete(account.id)"), "single flight, released in a finally");
  assert.ok(spend.includes("finally {"));
  assert.ok(spend.includes("randomUUID()"), "a fresh idempotency key per attempt");
  assert.ok(spend.includes("creditIdValue.length <= 200"), "the credit id is bounded");
});

test("after any answer the vendor's own numbers are read again; a failed read keeps the last credits", () => {
  const spend = bodyOf(engines, "export async function consumeZaicodeResetCredit");
  assert.ok(spend.includes('result.outcome !== "unavailable"'));
  assert.ok(spend.includes("refreshZaicodeEngines(account.id)"));
  assert.ok(engines.includes("resetCredits: parseCodexResetCredits(answer.result)"), "the read keeps the credits");
  assert.ok(engines.includes("...(outcome.resetCredits !== undefined ? { resetCredits: outcome.resetCredits } : {})"), "a good read stores them");
  assert.ok(engines.includes("...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {})"), "a failed read does not forget them");
});

test("reading the quota never spends: the quota read asks the read method only", () => {
  const probe = bodyOf(engines, "async function probeCodex");
  assert.ok(probe.includes('codexRpcCall(options, "account/rateLimits/read")'));
  assert.ok(!probe.includes("rateLimitResetCredit/consume"));
  // The only place that names the spending method is the RPC helper the spend goes through.
  assert.equal(engines.split("rateLimitResetCredit/consume").length - 1, 0);
  assert.ok(read("desktop/src/main/zaicodeCodexRpc.ts").includes('"account/rateLimitResetCredit/consume"'));
});
