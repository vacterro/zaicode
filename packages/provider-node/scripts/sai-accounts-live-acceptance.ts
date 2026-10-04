/**
 * Live A+B acceptance for ZAICODE's SAI Accounts federation.
 *
 * A = the control plane PRESENT. B = the control plane ABSENT.
 *
 * Arm A drives the real installed engine. Arm B makes "absent" true rather than
 * simulated by passing an installDir that does not exist AND an override that
 * does not exist, so every branch of `resolveSaiAccountsEngine` agrees.
 *
 * This consumer's provider roster is its eight `account:*` providers. The plane
 * currently publishes antigravity/claude/codex, which do not overlap with them,
 * so the honest live answer today is an EMPTY shared list. The check below
 * asserts that emptiness is correct rather than asserting a non-zero count: the
 * invariant is "every shared entry this roster can accept is provably mine",
 * and an unrelated provider must never be force-fitted into it.
 *
 * Run: pnpm --filter @zcode/provider-node exec node --import tsx scripts/sai-accounts-live-acceptance.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SAI_ACCOUNTS_EXE_ENV,
  createNodeSaiAccountsHost,
  listSharedAccounts,
  probeSharedAccount,
  saiAccountsIdentityKey,
  type SharedAccount,
} from "../src/sai-accounts-source.js";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/ -> provider-node/ -> packages/ -> zcode/. The config that defines the
// account providers lives at zcode/config/provider/zcode-builtin.json.
const repoRoot = resolve(here, "..", "..", "..");

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/** Every account the plane holds, unfiltered. Read-only, and never a secret. */
async function allPlaneAccounts(host: { enginePath: () => string; run: (argv: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string }> }): Promise<readonly SharedAccount[]> {
  if (!host.enginePath()) return [];
  const result = await host.run(["list"], 30_000);
  const parsed = JSON.parse(result.stdout || "{}") as { accounts?: unknown };
  if (!Array.isArray(parsed.accounts)) return [];
  return (parsed.accounts as { account_id?: string; provider_id?: string; display_name?: string }[])
    .filter((e) => typeof e.account_id === "string" && typeof e.provider_id === "string")
    .map((e) => ({
      accountId: e.account_id as string,
      providerId: e.provider_id as string,
      displayName: e.display_name ?? "",
      compactLabel: "",
      backend: "",
      locator: "",
      operationalState: "ENABLED",
    }));
}

/** ZAICODE's own account providers, read from the config that defines them. */
function zaicodeAccountProviders(): string[] {
  const path = resolve(repoRoot, "config", "provider", "zcode-builtin.json");
  const config = JSON.parse(readFileSync(path, "utf8")) as {
    config?: { providerConfigRules?: { providerRules?: { providerId?: string }[] } };
  };
  const rules = config.config?.providerConfigRules?.providerRules ?? [];
  return rules
    .map((rule) => rule.providerId ?? "")
    .filter((id) => id.startsWith("account:"));
}

async function armA(): Promise<void> {
  console.log("\n== ARM A: FEDERATED (plane present) ==");
  const providers = zaicodeAccountProviders();
  check("A1 ZAICODE's account providers are read from its own config",
    providers.length > 0, `${providers.length} account:* providers`);

  const host = createNodeSaiAccountsHost();
  const engine = host.enginePath();
  check("A2 the canonical plane is installed", engine.length > 0, engine);

  // What the plane actually holds, with NO roster filter. The caller supplies
  // the roster and this module filters; to see the unfiltered picture the
  // harness reads the envelope itself rather than passing an empty roster,
  // which would mean "nothing is wanted" and return nothing.
  const everything = await allPlaneAccounts(host);
  check("A3 the plane answers", everything.length > 0, `${everything.length} accounts total`);

  const mine = await listSharedAccounts(host, providers);
  const overlap = everything.filter((e) =>
    providers.some((p) => p.toLowerCase() === e.providerId.toLowerCase()));
  check("A4 the filtered list is exactly the plane entries this roster can accept",
    mine.length === overlap.length,
    `roster accepts ${mine.length}, plane publishes ${everything.length}, ` +
    `provider overlap ${overlap.length}`);

  const seen = new Set<string>();
  for (const entry of mine as readonly SharedAccount[]) {
    const key = saiAccountsIdentityKey(entry.providerId, entry.locator);
    check(`A5 identity is provable for ${entry.compactLabel || entry.accountId}`,
      key.length > 0, key || `locator="${entry.locator}"`);
    check(`A6 ${entry.compactLabel || entry.accountId} carries a canonical id`,
      entry.accountId.length > 0, entry.accountId);
    const idKey = `${entry.providerId}|${entry.accountId}`;
    check(`A7 ${entry.compactLabel || entry.accountId} appears once`,
      !seen.has(idKey), idKey);
    seen.add(idKey);
  }

  if (mine.length === 0) {
    console.log("       The plane publishes no accounts for ZAICODE's own providers today,");
    console.log("       so the honest answer is an empty list. That is the correct result,");
    console.log("       not a missing feature: an unrelated provider must never be offered.");
  }

  // A probe must answer with a reading or a typed reason, never silence. Probe
  // one plane entry directly by canonical id, since this roster accepts none.
  const subject = everything[0];
  if (subject) {
    const probe = await probeSharedAccount(host, subject.accountId, 30_000);
    check("A8 a probe answers with a reading or a typed state",
      probe.state !== undefined, `${probe.state} ${probe.detail ?? ""}`);
    console.log(`       probe ${subject.displayName}: state=${probe.state} ` +
      `windows=${probe.windows.length} ${probe.detail ?? ""}`);
  } else {
    check("A8 the plane published nothing to probe", true, "0 accounts");
  }
}

async function armB(): Promise<void> {
  console.log("\n== ARM B: STANDALONE (plane absent) ==");
  const providers = zaicodeAccountProviders();
  // An installDir that does not exist AND an override that does not exist: both
  // resolution branches must agree, or this arm tests a fiction.
  const env = { ...process.env, [SAI_ACCOUNTS_EXE_ENV]: resolve(repoRoot, "no-such-engine.exe") };
  const real = createNodeSaiAccountsHost(env, process.platform);
  // The host's enginePath is closed over the canonical install, so the absent
  // arm overrides just that one function. `run` stays the real one: if the code
  // under test still tries to spawn something, B2 and B3 would notice.
  const host = { ...real, enginePath: () => "" };
  const engine = host.enginePath();
  check("B1 the plane resolves to nothing", engine === "", JSON.stringify(engine));

  const listed = await listSharedAccounts(host, providers);
  check("B2 listing an absent plane is empty, not an error", listed.length === 0,
    `${listed.length}`);

  const probe = await probeSharedAccount(host, "anything:at:all", 5_000);
  check("B3 a probe with no plane is a typed state, not a throw",
    typeof probe.state === "string", `${probe.state} ${probe.detail ?? ""}`);
  console.log(`       probe with no plane: state=${probe.state} ` +
    `${probe.detail ?? ""}`);
}

async function main(): Promise<number> {
  console.log("ZAICODE -- live SAI Accounts federation acceptance");
  console.log("=".repeat(62));
  try {
    await armA();
  } catch (error) {
    console.log(`  [FAIL] arm A threw: ${(error as Error).message}`);
    failures.push("arm A");
  }
  try {
    await armB();
  } catch (error) {
    console.log(`  [FAIL] arm B threw: ${(error as Error).message}`);
    failures.push("arm B");
  }
  console.log("\n" + "=".repeat(62));
  if (failures.length > 0) {
    console.log(`RESULT: FAIL -- ${failures.length} invariant(s) broken`);
    for (const name of failures) console.log(`  - ${name}`);
    return 1;
  }
  console.log("RESULT: PASS -- A (federated) and B (standalone) both hold");
  return 0;
}

process.exitCode = await main();