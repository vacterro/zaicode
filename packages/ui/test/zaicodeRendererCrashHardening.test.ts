import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSanitizedCrashReport,
  formatSanitizedCrashReportText,
} from "../src/ErrorBoundary.js";
import { isLoggerLevelEnabled } from "../src/logger.js";
import { queuePauseKinds } from "../src/v4/queueActionOutcome.js";
import {
  archiveAndRemoveSourceMapFilesInDirectory,
} from "../../desktop/scripts/packaged-sourcemap-cleanup.mjs";

test("T-375 RED-1: logger retains error level in production renderer builds", () => {
  const previousEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.equal(
      isLoggerLevelEnabled("error"),
      true,
      "logger.error must remain enabled in production builds to avoid blind renderer crashes",
    );
    assert.equal(
      isLoggerLevelEnabled("info"),
      false,
      "logger.info remains disabled in production builds to reduce renderer overhead",
    );
    assert.equal(
      isLoggerLevelEnabled("warn"),
      false,
      "logger.warn remains disabled in production builds",
    );
    assert.equal(
      isLoggerLevelEnabled("debug"),
      false,
      "logger.debug remains disabled in production builds",
    );
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});

test("T-375 RED-2: buildSanitizedCrashReport formats error name, message, stack, build ID, and component stack", () => {
  const err = new Error("Simulated renderer crash");
  err.name = "TypeError";
  const componentStack = "\n    at SessionPane (styles-BxEh5NVb.js:854:58603)\n    at div\n";
  const report = buildSanitizedCrashReport({
    error: err,
    componentStack,
    scope: "workbench-pane:test-pane",
  });

  assert.equal(report.errorName, "TypeError");
  assert.equal(report.errorMessage, "Simulated renderer crash");
  assert.ok(report.errorStack?.includes("Simulated renderer crash"));
  assert.ok(report.componentStack?.includes("SessionPane"));
  assert.equal(report.scope, "workbench-pane:test-pane");
  assert.ok(report.build.version, "must have build version");
  assert.ok(report.build.commit, "must have build commit");
  assert.ok(report.timestamp, "must have ISO timestamp");

  const formattedText = formatSanitizedCrashReportText(report);
  assert.ok(formattedText.includes("=== ZAICODE CRASH REPORT ==="));
  assert.ok(formattedText.includes("TypeError: Simulated renderer crash"));
  assert.ok(formattedText.includes("Scope: workbench-pane:test-pane"));
  assert.ok(formattedText.includes("SessionPane (styles-BxEh5NVb.js:854:58603)"));
  assert.ok(formattedText.includes("--- Error Stack ---"));
  assert.ok(formattedText.includes("--- Component Stack ---"));
});

test("T-375 RED-3: packaged-sourcemap-cleanup archives private sourcemaps before stripping", async () => {
  const tempBase = mkdtempSync(join(tmpdir(), "zcode-test-sourcemap-"));
  const stagingDir = join(tempBase, "staging");
  const archiveDir = join(tempBase, "private-sourcemaps");
  mkdirSync(stagingDir, { recursive: true });

  const jsFile = join(stagingDir, "styles-test.js");
  const mapFile = join(stagingDir, "styles-test.js.map");
  writeFileSync(jsFile, "function test() {}\n//# sourceMappingURL=styles-test.js.map");
  writeFileSync(mapFile, JSON.stringify({ version: 3, file: "styles-test.js", sources: ["SessionPane.tsx"] }));

  try {
    const summary = archiveAndRemoveSourceMapFilesInDirectory(stagingDir, archiveDir);
    assert.equal(summary.filesRemoved, 1, "map file removed from staging");
    assert.equal(summary.filesArchived, 1, "map file archived to private archive");
    assert.equal(existsSync(mapFile), false, "map file no longer exists in staging");
    assert.equal(existsSync(join(archiveDir, "styles-test.js.map")), true, "map file preserved in private archive");

    const archivedContent = JSON.parse(readFileSync(join(archiveDir, "styles-test.js.map"), "utf8"));
    assert.equal(archivedContent.file, "styles-test.js");
  } finally {
    rmSync(tempBase, { recursive: true, force: true });
  }
});

test("T-375 RED-4: queuePauseKinds handles undefined queue safely without throwing", () => {
  const result = queuePauseKinds({
    autoDrain: true,
    goalStatus: null,
  });
  assert.equal(result.queuePaused, false);
  assert.equal(result.sessionPaused, false);
});

test("T-375 RED-5: SessionPane and WorkbenchPane wire ScopedErrorBoundary around panes", () => {
  const workbenchSrc = readFileSync(join(import.meta.dirname, "../src/v4/WorkbenchPane.tsx"), "utf8");
  assert.ok(
    workbenchSrc.includes("<ScopedErrorBoundary") && workbenchSrc.includes("workbench-pane:"),
    "WorkbenchPane must wrap leaf panes in ScopedErrorBoundary for isolation",
  );

  const sessionPaneSrc = readFileSync(join(import.meta.dirname, "../src/v4/SessionPane.tsx"), "utf8");
  assert.ok(
    sessionPaneSrc.includes("snapshot?.queue?.autoDrain ?? true"),
    "SessionPane must use optional chaining for snapshot.queue.autoDrain",
  );
  assert.ok(
    sessionPaneSrc.includes("lease?.store?.getSubscriptionDiagnostics?.()"),
    "SessionPane must use optional chaining for getSubscriptionDiagnostics",
  );
});

test("T-376 RED-6: buildSanitizedCrashReport redacts secrets, tokens, headers and credentials", () => {
  const sensitiveError = new Error(
    "Failed to fetch https://admin:password999@api.example.com/query?token=secret_token_12345 with Authorization: Bearer sk-ant-api03-1234567890abcdef1234567890",
  );
  sensitiveError.stack = `Error: 401 Unauthorized apiKey: super_secret_val_xyz
    Authorization: Bearer my_jwt_token_here_12345
    at SessionPane (V:/project/SessionPane.tsx:550:2)
    at https://user:secretpass@host.org/v1/auth`;

  const report = buildSanitizedCrashReport({
    error: sensitiveError,
    componentStack: "    at SessionPane (styles-BxEh5NVb.js:854:58603)\n",
    scope: "workbench-pane:test",
  });

  // Verify redaction in errorMessage
  assert.equal(report.errorMessage.includes("password999"), false, "password redacted from url");
  assert.equal(report.errorMessage.includes("secret_token_12345"), false, "token param redacted");
  assert.equal(report.errorMessage.includes("sk-ant-api03-1234567890abcdef1234567890"), false, "api key redacted");
  assert.ok(report.errorMessage.includes("<redacted>"), "contains redaction placeholder");

  // Verify redaction in errorStack
  assert.equal(report.errorStack?.includes("super_secret_val_xyz"), false, "apiKey redacted");
  assert.equal(report.errorStack?.includes("my_jwt_token_here_12345"), false, "bearer token redacted");
  assert.equal(report.errorStack?.includes("secretpass"), false, "url credential redacted");
  assert.ok(report.errorStack?.includes("SessionPane.tsx:550:2"), "source code line number preserved");

  const formatted = formatSanitizedCrashReportText(report);
  assert.equal(formatted.includes("password999"), false);
  assert.equal(formatted.includes("super_secret_val_xyz"), false);
});
