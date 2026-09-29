import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  describeZaicodeResetOutcome,
  parseCodexConsumeOutcome,
  parseCodexResetCredits,
  zaicodeNextResetCreditExpiry,
  zaicodePickResetCredit,
  zaicodeResetCreditsUsable,
  type ZaicodeLimitSnapshot,
  type ZaicodeLimitWindow,
  type ZaicodeResetCredits,
} from "@zcode/shared";

/**
 * SRC-093 (T-130): "there are Codex reset credits but nowhere are they shown; read them for ZCode Coding Plans, Claude Code and Codex
 * together, and let me use them from ZAICODE quickly". The Codex app-server sends them next to the windows; ZAICODE dropped them.
 * These tests are that data becoming what the person sees, and the one action that spends something.
 */

const NOW = Date.UTC(2026, 8, 29, 20, 0, 0);
const DAY = 86_400_000;

const codexAnswer = (block: unknown) => ({ rateLimits: { planType: "plus" }, rateLimitResetCredits: block });
const credit = (id: string, patch: Record<string, unknown> = {}) => ({ id, status: "available", grantedAt: (NOW - DAY) / 1000, expiresAt: (NOW + 29 * DAY) / 1000, title: "Full reset (Weekly + 5 hr)", description: "One free reset.", resetType: "codexRateLimits", ...patch });

test("C1 the credits block becomes counts, dates in milliseconds and titles; a missing block is unknown, a zero is a real zero", () => {
  assert.equal(parseCodexResetCredits({ rateLimits: {} }), null, "the vendor sent none: unknown");
  assert.equal(parseCodexResetCredits(null), null);
  assert.deepEqual(parseCodexResetCredits(codexAnswer({ availableCount: 0, credits: [] })), { availableCount: 0, credits: [] });
  assert.deepEqual(parseCodexResetCredits(codexAnswer({ availableCount: 3 })), { availableCount: 3, credits: null }, "only the count is known");
  const parsed = parseCodexResetCredits(codexAnswer({ availableCount: 1, credits: [credit("credit-1")] }))!;
  assert.deepEqual(parsed.credits, [
    { id: "credit-1", title: "Full reset (Weekly + 5 hr)", description: "One free reset.", grantedAt: NOW - DAY, expiresAt: NOW + 29 * DAY, status: "available" },
  ]);
});

test("C2 hostile or half-broken credit rows are dropped or tidied, never trusted", () => {
  const parsed = parseCodexResetCredits(
    codexAnswer({
      availableCount: -4,
      credits: [
        credit("ok"),
        credit("ok"),
        credit("spent", { status: "redeemed" }),
        credit("", {}),
        credit("x".repeat(300)),
        { id: "odd", status: "who-knows", grantedAt: "yesterday", expiresAt: null, title: "  Two   words \n here  " },
        "not an object",
        null,
      ],
    }),
  )!;
  assert.equal(parsed.availableCount, 0, "a negative count is nothing");
  assert.deepEqual(parsed.credits!.map((entry) => entry.id), ["ok", "odd"], "duplicates, spent, blank and oversized ids are gone");
  const odd = parsed.credits!.find((entry) => entry.id === "odd")!;
  assert.deepEqual([odd.status, odd.grantedAt, odd.expiresAt, odd.title], ["unknown", 0, null, "Two words here"]);
});

test("C3 what can be spent now: the vendor's count less the credits that ran out; the one that expires first is used first", () => {
  const credits: ZaicodeResetCredits = {
    availableCount: 3,
    credits: [
      { id: "late", title: null, description: null, grantedAt: NOW - 5 * DAY, expiresAt: NOW + 20 * DAY, status: "available" },
      { id: "gone", title: null, description: null, grantedAt: NOW - 9 * DAY, expiresAt: NOW - DAY, status: "available" },
      { id: "soon", title: null, description: null, grantedAt: NOW - 2 * DAY, expiresAt: NOW + 3 * DAY, status: "available" },
    ],
  };
  assert.equal(zaicodeResetCreditsUsable(credits, NOW), 2);
  assert.equal(zaicodeNextResetCreditExpiry(credits, NOW), NOW + 3 * DAY);
  assert.equal(zaicodePickResetCredit(credits, NOW)!.id, "soon");
  assert.equal(zaicodeResetCreditsUsable({ availableCount: 2, credits: null }, NOW), 2, "count only: trust the count");
  assert.equal(zaicodePickResetCredit({ availableCount: 2, credits: null }, NOW), null, "nothing to name: the backend picks");
  assert.equal(zaicodeResetCreditsUsable(null, NOW), 0);
  assert.equal(zaicodeResetCreditsUsable({ availableCount: 0, credits: [] }, NOW), 0);
  const noExpiry: ZaicodeResetCredits = { availableCount: 1, credits: [{ id: "a", title: null, description: null, grantedAt: 1, expiresAt: null, status: "available" }] };
  assert.equal(zaicodeNextResetCreditExpiry(noExpiry, NOW), null);
  assert.equal(zaicodePickResetCredit(noExpiry, NOW)!.id, "a");
});

test("C4 the answers of the spend call are told apart, and every one has its own sentence naming the account", () => {
  assert.equal(parseCodexConsumeOutcome({ outcome: "reset" }), "reset");
  assert.equal(parseCodexConsumeOutcome({ outcome: "nothingToReset" }), "nothingToReset");
  assert.equal(parseCodexConsumeOutcome({ outcome: "noCredit" }), "noCredit");
  assert.equal(parseCodexConsumeOutcome({ outcome: "alreadyRedeemed" }), "alreadyRedeemed");
  for (const bad of [{ outcome: "RESET" }, { outcome: "" }, {}, null, "reset", 5]) assert.equal(parseCodexConsumeOutcome(bad), null);
  const sentences = (["reset", "nothingToReset", "noCredit", "alreadyRedeemed", "unavailable"] as const).map((outcome) => describeZaicodeResetOutcome("Codex 2", outcome, "boom"));
  assert.equal(new Set(sentences).size, 5);
  assert.ok(sentences.every((sentence) => sentence.startsWith("Codex 2:")));
  assert.match(sentences[4]!, /\(boom\)\. Nothing was spent\./);
});

// ---------------------------------------------------------------- rows and the question

const windowOf = (patch: Partial<ZaicodeLimitWindow>): ZaicodeLimitWindow => ({
  key: "weekly",
  label: "weekly",
  group: "",
  groupLabel: "",
  remainingPercent: 100,
  resetsAt: NOW + 3 * DAY,
  durationMinutes: 10080,
  gatedBy: null,
  assumedFull: false,
  ...patch,
});

const snapshot = (id: string, windows: ZaicodeLimitWindow[], resetCredits?: ZaicodeResetCredits | null): ZaicodeLimitSnapshot => ({
  accountId: id,
  windows,
  plan: "plus",
  fetchedAt: NOW,
  checkedAt: NOW,
  error: null,
  source: "test",
  ...(resetCredits === undefined ? {} : { resetCredits }),
});

const accounts = [
  { id: "codex:1", short: "C1", label: "Codex 1", vendor: "codex" as const },
  { id: "codex:2", short: "C2", label: "Codex 2", vendor: "codex" as const },
  { id: "claude:1", short: "A1", label: "Claude 1", vendor: "claude" as const },
];

const oneCredit = (expiresInDays: number): ZaicodeResetCredits => ({
  availableCount: 1,
  credits: [{ id: `c-${expiresInDays}`, title: "Full reset (Weekly + 5 hr)", description: null, grantedAt: NOW - DAY, expiresAt: NOW + expiresInDays * DAY, status: "available" }],
});

const { zaicodeResetCreditRows, zaicodeResetCreditRequest, zaicodeResetCreditsTotal, spendZaicodeResetCredit } = await import("../src/zaicode/zaicodeResetCredits.js");

test("C5 the rows: only accounts with something to spend, the blocked one first, what a reset would refill named", () => {
  const limits = {
    "codex:1": snapshot("codex:1", [windowOf({ remainingPercent: 60 })], oneCredit(5)),
    "codex:2": snapshot("codex:2", [windowOf({ key: "five_hour", label: "5h", remainingPercent: 0 }), windowOf({ remainingPercent: 0 })], oneCredit(29)),
    "claude:1": snapshot("claude:1", [windowOf({})]),
  };
  const rows = zaicodeResetCreditRows(accounts, limits, NOW);
  assert.deepEqual(rows.map((row) => row.accountId), ["codex:2", "codex:1"], "the blocked account comes first, then by expiry");
  assert.deepEqual(rows[0]!.spentWindows, ["5h", "weekly"]);
  assert.deepEqual(rows[1]!.spentWindows, []);
  assert.equal(rows[0]!.credit?.id, "c-29");
  assert.equal(rows[0]!.nextExpiresAt, NOW + 29 * DAY);
  assert.equal(zaicodeResetCreditsTotal(rows), 2);
  assert.deepEqual(zaicodeResetCreditRows(accounts, { "codex:1": snapshot("codex:1", [], { availableCount: 0, credits: [] }), "codex:2": snapshot("codex:2", [], null) }, NOW), [], "zero and unknown show nothing");
  assert.deepEqual(zaicodeResetCreditRows(accounts, {}, NOW), []);
  assert.deepEqual(
    zaicodeResetCreditRows(accounts, { "codex:1": snapshot("codex:1", [], { availableCount: 1, credits: [{ id: "old", title: null, description: null, grantedAt: 1, expiresAt: NOW - 1, status: "available" }] }) }, NOW),
    [],
    "a credit that ran out is not offered",
  );
});

test("C6 the question before a credit is used up says what refills, that it is gone, and how many stay; the button is red", () => {
  const [row] = zaicodeResetCreditRows(accounts, { "codex:2": snapshot("codex:2", [windowOf({ remainingPercent: 0 })], oneCredit(29)) }, NOW);
  const request = zaicodeResetCreditRequest(row!);
  assert.equal(request.title, "Use one Codex 2 reset?");
  assert.match(request.description ?? "", /Full reset \(Weekly \+ 5 hr\)\. weekly is spent: they refill now\. The credit is used up\. It was the last one\./);
  assert.equal(request.confirmLabel, "Use the reset");
  assert.equal(request.confirmVariant, "destructive");
  const many = zaicodeResetCreditRequest({ ...row!, usable: 3, spentWindows: ["5h", "weekly"] });
  assert.match(many.description ?? "", /5h and weekly are spent: they refill now\..*2 more stay available\./);
  assert.match(zaicodeResetCreditRequest({ ...row!, spentWindows: [] }).description ?? "", /No window is spent right now, so a reset may gain nothing\./);
});

// ---------------------------------------------------------------- spending

const { useConfirmDialogStore } = await import("../src/store/confirmDialogStore.js");

interface Bridge {
  calls: { accountId: string; creditId: string | null }[];
}

function withBridge(answer: () => Promise<unknown>, confirms: boolean) {
  const bridge: Bridge = { calls: [] };
  const asked: unknown[] = [];
  (globalThis as Record<string, unknown>)["window"] = {
    zcode: {
      consumeZaicodeResetCredit: (request: { accountId: string; creditId: string | null }) => {
        bridge.calls.push(request);
        return answer();
      },
    },
  };
  useConfirmDialogStore.setState({
    requestConfirmation: async (payload) => {
      asked.push(payload);
      return confirms;
    },
  });
  return { bridge, asked };
}

const said: { message: string; warning: boolean }[] = [];
const notify = (message: string, options: { durationMs: number; variant?: "warning" }) => void said.push({ message, warning: options.variant === "warning" });

const spendRow = zaicodeResetCreditRows(accounts, { "codex:2": snapshot("codex:2", [windowOf({ remainingPercent: 0 })], oneCredit(29)) }, NOW)[0]!;

test("C7 nothing is spent without the 'Use the reset' click: declined means the main process is never asked", async () => {
  const { bridge, asked } = withBridge(async () => ({ outcome: "reset", message: "x" }), false);
  assert.equal(await spendZaicodeResetCredit(spendRow, notify), null);
  assert.equal(asked.length, 1, "the question was asked");
  assert.deepEqual(bridge.calls, []);
});

test("C8 confirmed: the credit the row named is spent, once, and a second click while it runs is ignored", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { bridge } = withBridge(async () => {
    await gate;
    return { outcome: "reset", message: "Codex 2: reset used. The spent windows are refilled." };
  }, true);
  const first = spendZaicodeResetCredit(spendRow, notify);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await spendZaicodeResetCredit(spendRow, notify);
  assert.equal(second, null, "the same account is busy");
  release();
  const result = await first;
  assert.equal(result?.outcome, "reset");
  assert.deepEqual(said.at(-1), { message: "Codex 2: reset used. The spent windows are refilled.", warning: false }, "a used reset is told as good news");
  assert.deepEqual(bridge.calls, [{ accountId: "codex:2", creditId: "c-29" }]);
});

test("C9 a bridge that throws is 'nothing was spent', and the account is free to try again", async () => {
  withBridge(async () => {
    throw new Error("ipc gone");
  }, true);
  const failed = await spendZaicodeResetCredit(spendRow, notify);
  assert.equal(failed?.outcome, "unavailable");
  assert.match(failed?.message ?? "", /ipc gone.*Nothing was spent/);
  assert.equal(said.at(-1)?.warning, true, "a failure is told as a warning");
  const { bridge } = withBridge(async () => ({ outcome: "noCredit", message: "Codex 2: no reset credit is left." }), true);
  assert.equal((await spendZaicodeResetCredit(spendRow, notify))?.outcome, "noCredit");
  assert.equal(said.at(-1)?.warning, true, "an answer that refilled nothing is a warning too");
  assert.equal(bridge.calls.length, 1, "the busy flag was released");
});

test("C10 without the desktop bridge nothing happens (the web build has no Codex to ask)", async () => {
  (globalThis as Record<string, unknown>)["window"] = {};
  assert.equal(await spendZaicodeResetCredit(spendRow, notify), null);
});

// ---------------------------------------------------------------- what the person sees

const { ZaicodeResetCreditsSection } = await import("../src/zaicode/ZaicodeResetCreditsSection.js");

test("C11 the section lists each account with count, what is spent, expiry and a button; Claude gets one honest line; nothing to spend draws nothing", () => {
  const rows = zaicodeResetCreditRows(accounts, { "codex:2": snapshot("codex:2", [windowOf({ remainingPercent: 0 })], oneCredit(29)) }, NOW);
  const html = renderToStaticMarkup(createElement(ZaicodeResetCreditsSection, { rows, now: NOW, hasClaude: true }));
  assert.match(html, /data-zaicode-reset-credits="1"/);
  assert.match(html, /Reset credits you can use/);
  assert.match(html, />Codex 2</);
  assert.match(html, /×1/);
  assert.match(html, /Full reset \(Weekly \+ 5 hr\) · weekly spent/);
  assert.match(html, /expires in 29d 0h/, "days and hours, so 28d 23h is not shown as 28d");
  assert.match(html, /data-zaicode-reset-credit-button="codex:2"/);
  assert.match(html, />Reset now</);
  assert.match(html, /Claude Code has no reset credits to read\./);
  assert.doesNotMatch(renderToStaticMarkup(createElement(ZaicodeResetCreditsSection, { rows, now: NOW, hasClaude: false })), /Claude Code has no reset credits/);
  assert.equal(renderToStaticMarkup(createElement(ZaicodeResetCreditsSection, { rows: [], now: NOW, hasClaude: true })), "");
});

// ---------------------------------------------------------------- wiring

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const source = (path: string): string => readFileSync(join(srcRoot, path), "utf8").replace(/\r\n/g, "\n");

test("C12 the reset list, its badge and every account block show the credits", () => {
  const timer = source("zaicode/ZaicodeResetTimer.tsx");
  assert.match(timer, /<ZaicodeResetCreditsSection rows=\{creditRows\}/);
  assert.match(timer, /const spendable = planResets\.total \+ zaicodeResetCreditsTotal\(creditRows\);/, "one badge counts the Coding Plan's and Codex's");
  assert.match(timer, /if \(!next && rows\.length === 0 && spendable === 0\) return null;/, "the timer shows for an account whose only news is a credit");
  const views = source("zaicode/ZaicodeLimitViews.tsx");
  assert.match(views, /data-zaicode-account-reset-credits=\{account\.id\}/);
  assert.match(views, /<ZaicodeResetCreditButton row=\{credits\} \/>/);
  assert.match(source("zaicode/zaicodeEngines.ts"), /consumeZaicodeResetCredit\?\(request/);
});
