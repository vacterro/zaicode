import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listProviderQuotaCircuits,
  openProviderQuotaCircuit,
  providerQuotaCircuit,
  resetProviderQuotaCircuits,
  PROVIDER_QUOTA_CIRCUIT_DEFAULT_MS,
  PROVIDER_QUOTA_CIRCUIT_MAX_ESTIMATED_MS,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";
import { vendorResetAtForProvider } from "../src/zaicode/zaicodeQuotaRoute.js";

const HOUR = 60 * 60_000;
const NOW = 1_700_000_000_000;

/** A snapshot with one window; `resetsAt` is the vendor's reset, 0% means spent. */
const snapshot = (resetsAt: number | null, remainingPercent = 0): ZaicodeLimitSnapshot =>
  ({
    windows: [
      {
        key: "five_hour",
        label: "5h",
        group: "",
        groupLabel: "",
        remainingPercent,
        resetsAt,
        durationMinutes: 300,
        gatedBy: null,
        assumedFull: false,
      },
    ],
  }) as ZaicodeLimitSnapshot;

const accounts = [
  { id: "claude-1", vendor: "claude" },
  { id: "codex-1", vendor: "codex" },
];

test("T-190: the vendor's own reset is read off the snapshot, for that provider only", () => {
  const reset = NOW + 3 * HOUR;
  const at = vendorResetAtForProvider({
    providerId: "claude",
    accounts,
    limits: { "claude-1": snapshot(reset), "codex-1": snapshot(NOW + 9 * HOUR) },
    now: NOW,
  });
  assert.equal(at, reset, "a different provider's longer window must not be borrowed");
});

test("T-190: no proven reset is null -- never a guessed one", () => {
  // Nothing read yet.
  assert.equal(vendorResetAtForProvider({ providerId: "claude", accounts, limits: {}, now: NOW }), null);
  // Read, but the window is not spent: nothing has proven an exhaustion.
  assert.equal(
    vendorResetAtForProvider({
      providerId: "claude",
      accounts,
      limits: { "claude-1": snapshot(NOW + HOUR, 42) },
      now: NOW,
    }),
    null,
  );
  // Provider id casing is not a reason to miss the account.
  assert.equal(
    vendorResetAtForProvider({
      providerId: "CLAUDE",
      accounts,
      limits: { "claude-1": snapshot(NOW + HOUR) },
      now: NOW,
    }),
    NOW + HOUR,
  );
  assert.equal(
    vendorResetAtForProvider({
      providerId: "antigravity",
      accounts,
      limits: { "claude-1": snapshot(NOW + HOUR) },
      now: NOW,
    }),
    null,
    "a provider with no account has no vendor reset",
  );
});

test("T-190: with a vendor reset the route holds until the vendor's clock, not a local estimate", () => {
  resetProviderQuotaCircuits();
  const reset = NOW + 3 * HOUR;
  openProviderQuotaCircuit({ providerId: "glm", now: NOW, reason: "rate_limited", resetAt: reset });
  const circuit = providerQuotaCircuit("glm", NOW + HOUR);
  assert.ok(circuit, "a three-hour vendor reset is still in force one hour later");
  assert.equal(circuit.until, reset);
  assert.equal(circuit.resetSource, "vendor", "the UI must not call a guess a vendor reset");
  // It lapses on the vendor's clock, not on the 15-minute estimate.
  assert.equal(providerQuotaCircuit("glm", reset), null);
  assert.equal(listProviderQuotaCircuits(reset - 1).length, 1);
});

test("T-190: without a vendor reset the estimate still caps at six hours and still says so", () => {
  resetProviderQuotaCircuits();
  openProviderQuotaCircuit({ providerId: "glm", now: NOW, reason: "rate_limited" });
  const first = providerQuotaCircuit("glm", NOW);
  assert.ok(first);
  assert.equal(first.until, NOW + PROVIDER_QUOTA_CIRCUIT_DEFAULT_MS);
  assert.equal(first.resetSource, "estimated");

  // Repeated exhaustion doubles, and never past the ceiling.
  for (let i = 0; i < 20; i += 1) openProviderQuotaCircuit({ providerId: "glm", now: NOW, reason: "rate_limited" });
  const grown = providerQuotaCircuit("glm", NOW);
  assert.ok(grown);
  assert.equal(grown.until, NOW + PROVIDER_QUOTA_CIRCUIT_MAX_ESTIMATED_MS);
  assert.equal(grown.resetSource, "estimated");
});

test("T-190: a weekly plan resets at its real time, well past the estimate ceiling", () => {
  resetProviderQuotaCircuits();
  const weekly = NOW + 5 * 24 * HOUR;
  openProviderQuotaCircuit({ providerId: "glm", now: NOW, reason: "rate_limited", resetAt: weekly });
  const circuit = providerQuotaCircuit("glm", NOW + 4 * 24 * HOUR);
  assert.ok(circuit, "a real weekly reset is honoured rather than hammered every six hours");
  assert.equal(circuit.until, weekly);
  assert.ok(circuit.until > NOW + PROVIDER_QUOTA_CIRCUIT_MAX_ESTIMATED_MS);
});