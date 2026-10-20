import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProjectDiscovery,
  driftReceiptRetirement,
  isHostUnavailableError,
  partitionSessionsForParts,
  redactSecrets,
  resolveDriftEvidenceState,
  summarizeDiscovery,
  summarizeProjectTotals,
} from "../src/zaicode/zaicodeDriftCaptureContract.js";

// SAIHANDOFF: the drift capture center must never report a partial capture as a
// complete one, and must never show a green badge for evidence that is missing
// or corrupt on disk.

test("24 projects with 3 discovery failures are PARTIAL, never COMPLETE", () => {
  const receipts = Array.from({ length: 24 }, (_, index) =>
    index < 21
      ? classifyProjectDiscovery({
          project: { path: `C:/p${index}`, name: `p${index}` },
          sessions: [{ id: index }],
        })
      : classifyProjectDiscovery({
          project: { path: `C:/p${index}`, name: `p${index}` },
          error: new Error("listSessions failed"),
        }),
  );
  const summary = summarizeDiscovery(receipts);
  assert.equal(summary.status, "PARTIAL");
  assert.equal(summary.failedProjects, 3);
  assert.equal(summary.receipts.length, 24);
  assert.equal(summary.selectedProjects.length, 24, "every selected project stays in the manifest");
  assert.equal(
    summary.receipts.filter((r) => r.status === "DISCOVERY_FAILED").length,
    3,
    "each failure keeps its own receipt",
  );
  for (const receipt of summary.receipts.filter((r) => r.status === "DISCOVERY_FAILED")) {
    assert.match(receipt.error ?? "", /listSessions failed/);
  }
});

test("a project whose host is unavailable is not the same as an empty project", () => {
  const hostDown = classifyProjectDiscovery({
    project: { path: "C:/a" },
    error: new Error("Host unavailable: rpc disconnected"),
  });
  assert.equal(hostDown.status, "HOST_UNAVAILABLE");
  const empty = classifyProjectDiscovery({ project: { path: "C:/b" }, sessions: [] });
  assert.equal(empty.status, "EMPTY_PROJECT");
  assert.equal(
    summarizeDiscovery([hostDown]).status,
    "FAILED",
    "nothing was captured, so the batch is not a success",
  );
});

test("rejected sessions make a project partial, not successful", () => {
  const receipt = classifyProjectDiscovery({
    project: { path: "C:/a" },
    sessions: [{ id: 1 }],
    rejectedSessions: 2,
  });
  assert.equal(receipt.status, "DISCOVERY_PARTIAL");
  assert.equal(receipt.discoveredSessions, 1);
  assert.equal(receipt.rejectedSessions, 2);
});

test("a complete discovery stays complete", () => {
  const receipts = [
    classifyProjectDiscovery({ project: { path: "C:/a" }, sessions: [{ id: 1 }] }),
    classifyProjectDiscovery({ project: { path: "C:/b" }, sessions: [] }),
  ];
  const summary = summarizeDiscovery(receipts);
  assert.equal(summary.status, "COMPLETE");
  assert.equal(summary.emptyProjects, 1);
});

test("missing evidence is never a saved badge", () => {
  assert.equal(
    resolveDriftEvidenceState({
      capturing: false,
      receipt: { sha256: "abc" },
      file: { exists: false },
    }),
    "FILE_MISSING",
  );
  assert.equal(
    resolveDriftEvidenceState({
      capturing: false,
      receipt: { sha256: "abc" },
      file: { exists: true, sha256: "different" },
    }),
    "INTEGRITY_FAILED",
  );
  assert.equal(
    resolveDriftEvidenceState({
      capturing: false,
      receipt: { sha256: "abc" },
      file: { exists: true },
    }),
    "INTEGRITY_FAILED",
    "an unverifiable file is not a verified one",
  );
});

test("new activity after the capture is visible, a clean file is verified", () => {
  assert.equal(
    resolveDriftEvidenceState({
      capturing: false,
      receipt: { sha256: "abc", watermarkUpdatedAt: 10 },
      file: { exists: true, sha256: "abc" },
      sessionUpdatedAt: 11,
    }),
    "SAVED_WITH_NEW_ACTIVITY",
  );
  assert.equal(
    resolveDriftEvidenceState({
      capturing: false,
      receipt: { sha256: "abc", watermarkUpdatedAt: 10 },
      file: { exists: true, sha256: "abc" },
      sessionUpdatedAt: 10,
    }),
    "SAVED_VERIFIED",
  );
});

test("capturing, failed and never captured states stay distinct", () => {
  assert.equal(resolveDriftEvidenceState({ capturing: true }), "CAPTURING");
  assert.equal(
    resolveDriftEvidenceState({ capturing: false, receipt: { captureFailed: true } }),
    "CAPTURE_FAILED",
  );
  assert.equal(resolveDriftEvidenceState({ capturing: false }), "NOT_CAPTURED");
  assert.equal(
    resolveDriftEvidenceState({ capturing: false, receipt: { verification: "UNVERIFIED" } }),
    "UNVERIFIED",
  );
});

test("project totals separate verified, changed and failed sessions", () => {
  const totals = summarizeProjectTotals([
    {
      sessionId: "1",
      workspacePath: "C:/p",
      verification: "SAVED_VERIFIED",
    },
    { sessionId: "2", workspacePath: "C:/p", verification: "SAVED_WITH_NEW_ACTIVITY" },
    { sessionId: "3", workspacePath: "C:/p", verification: "FILE_MISSING" },
    { sessionId: "4", workspacePath: "C:/p", verification: "INTEGRITY_FAILED" },
    { sessionId: "5", workspacePath: "C:/p", captureFailed: true },
  ]);
  assert.equal(totals.length, 1);
  assert.equal(totals[0].sessions, 5);
  assert.equal(totals[0].verified, 1);
  assert.equal(totals[0].changed, 1);
  assert.equal(totals[0].failed, 3);
});

test("split packages respect the size bound and never drop a session", () => {
  const items = [10, 10, 10, 10, 10];
  const parts = partitionSessionsForParts(items, (size) => size, 30);
  assert.equal(parts.length, 2);
  assert.equal(parts.flat().length, 5);
  for (const part of parts) {
    const total = part.reduce((sum, size) => sum + size, 0);
    assert.ok(total <= 30, "a part stays inside the bound");
  }
  assert.deepEqual(partitionSessionsForParts([], () => 1, 10), []);
  assert.equal(partitionSessionsForParts([99], () => 99, 10).length, 1, "an oversized item still lands in a part");
});

test("exported copies never carry raw credentials", () => {
  const text = [
    "token: ghp_abcdefghijklmnopqrstuvwxyz012345",
    'api_key = "sk-0123456789abcdefghij"',
    "Authorization: Bearer abcdefghijklmnop",
    "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const cleaned = redactSecrets(text);
  assert.doesNotMatch(cleaned, /ghp_abcdefghijklmnopqrstuvwxyz012345/);
  assert.doesNotMatch(cleaned, /sk-0123456789abcdefghij/);
  assert.doesNotMatch(cleaned, /Bearer abcdefghijklmnop/);
  assert.doesNotMatch(cleaned, /BEGIN RSA PRIVATE KEY/);
  assert.match(cleaned, /\[REDACTED/);
});

test("host unavailability is detected from the error text", () => {
  assert.equal(isHostUnavailableError(new Error("Host unavailable")), true);
  assert.equal(isHostUnavailableError(new Error("rpc disconnected")), true);
  assert.equal(isHostUnavailableError(new Error("listSessions failed")), false);
});

test("a receipt is retired only when every evidence file behind it is gone", () => {
  const entries = [
    { paths: ["C:/vault/a.md", "C:/vault/a.meta.json"] },
    { paths: ["C:/vault/b.md"] },
    { paths: [] },
  ];
  const retirement = driftReceiptRetirement(entries, {
    deleted: ["C:/vault/a.md", "C:/vault/a.meta.json"],
    missing: ["C:/vault/b.md"],
  });
  assert.deepEqual(retirement.retired, [true, true, true]);
  assert.equal(retirement.retiredCount, 3);
  assert.equal(retirement.keptCount, 0);
});

test("a failed delete keeps the archive marker of that receipt", () => {
  const entries = [
    { paths: ["C:/vault/a.md"] },
    { paths: ["C:/vault/b.md", "C:/vault/b.sha256.txt"] },
  ];
  const retirement = driftReceiptRetirement(entries, {
    deleted: ["C:/vault/a.md"],
    missing: [],
  });
  // The first receipt is gone from disk and retires; the second one still has
  // a live file, so its marker must survive the failed delete.
  assert.deepEqual(retirement.retired, [true, false]);
  assert.equal(retirement.retiredCount, 1);
  assert.equal(retirement.keptCount, 1);
});
