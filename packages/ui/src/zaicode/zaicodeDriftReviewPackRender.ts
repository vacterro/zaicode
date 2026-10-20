import type {
  DriftReviewPackProblem,
  DriftReviewPackRedactionPolicy,
  DriftReviewPackSession,
} from "./zaicodeDriftCaptureTypes.js";

/**
 * Human-readable pack documents.
 *
 * The pack must be readable without any ZAICODE tooling, so these renderers
 * emit plain Markdown that states exactly what was verified and what was not.
 */

export function renderProblems(problems: readonly DriftReviewPackProblem[]): string {
  const lines = ["# Missing or unverified sources", ""];
  if (problems.length === 0) {
    lines.push("None. Every captured session was re-hashed from disk before export.", "");
    return lines.join("\n");
  }
  lines.push(
    "These sessions are NOT included as verified evidence. They are listed so the",
    "review pack never looks more complete than the vault actually is.",
    "",
  );
  for (const problem of problems) {
    lines.push(`- ${problem.sessionId} · ${problem.workspacePath} · ${problem.reason}`);
    if (problem.sourcePath) lines.push(`  - source: ${problem.sourcePath}`);
    if (problem.expectedSha256) lines.push(`  - expected sha256: ${problem.expectedSha256}`);
    if (problem.actualSha256) lines.push(`  - actual sha256: ${problem.actualSha256}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderIndex(input: {
  generatedAt: string;
  scope: string;
  partIndex: number;
  partCount: number;
  coverage: Record<string, unknown>;
  sessions: readonly DriftReviewPackSession[];
  problems: readonly DriftReviewPackProblem[];
  redaction: DriftReviewPackRedactionPolicy;
  allowUnredacted: boolean;
}): string {
  const coverage = input.coverage as {
    projects?: readonly { projectPath: string; status: string; discoveredSessions: number; rejectedSessions: number; error?: string }[];
    sessions?: Record<string, number>;
  };
  const lines = [
    "# ZAICODE drift review pack",
    "",
    `Generated: ${input.generatedAt}`,
    `Scope: ${input.scope}`,
    `Part: ${input.partIndex + 1} of ${input.partCount}`,
    "",
    "This folder is self-contained. Every evidence file was re-hashed from disk when",
    "the pack was assembled; `manifest.json` stores relative paths only. Run",
    "`node verify.mjs` here (or read `checksums.sha256.txt`) to re-check every file.",
    "The pack contains transcript text references for attachments; binary attachment",
    "bytes and credentials are not included.",
    renderRedactionLine(input.redaction, input.allowUnredacted),
    "",
    "## Coverage",
    "",
    `- Verified sessions: ${input.sessions.length}`,
    `- Missing: ${input.problems.filter((p) => p.reason === "FILE_MISSING").length}`,
    `- Integrity failed: ${input.problems.filter((p) => p.reason === "INTEGRITY_FAILED").length}`,
    `- Capture failed: ${input.problems.filter((p) => p.reason === "CAPTURE_FAILED").length}`,
    `- Unverified: ${input.problems.filter((p) => p.reason === "UNVERIFIED").length}`,
    `- Excluded, redaction failed: ${input.problems.filter((p) => p.reason === "REDACTION_FAILED").length}`,
    `- Excluded, over the scan budget: ${input.problems.filter((p) => p.reason === "REDACTION_SKIPPED_OVERSIZE").length}`,
    "",
  ];
  if (coverage.projects?.length) {
    lines.push("## Project discovery", "", "| Project | State | Sessions | Rejected |", "| --- | --- | --- | --- |");
    for (const project of coverage.projects) {
      lines.push(
        `| ${escapeCell(project.projectPath)} | ${project.status}${project.error ? ` (${escapeCell(project.error)})` : ""} | ${project.discoveredSessions} | ${project.rejectedSessions} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Sessions", "");
  if (input.sessions.length === 0) {
    lines.push("_No verified sessions in this part._", "");
  } else {
    lines.push("| Session | Workspace | Messages | Characters | Evidence |", "| --- | --- | --- | --- | --- |");
    for (const session of input.sessions) {
      lines.push(
        `| ${escapeCell(session.sessionId)} | ${escapeCell(session.workspacePath)} | ${session.messages} | ${session.characters} | [${redactionLabel(session.redaction)}](${session.evidence}) |`,
      );
    }
    lines.push("");
  }
  if (input.problems.length > 0) {
    lines.push("## Not included", "");
    for (const problem of input.problems) {
      lines.push(`- ${problem.sessionId} · ${problem.reason}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function renderRootIndex(input: {
  generatedAt: string;
  coverage: Record<string, unknown>;
  partCount: number;
  zipPaths: readonly string[];
  problems: readonly DriftReviewPackProblem[];
}): string {
  const lines = [
    "# ZAICODE drift review pack (index)",
    "",
    `Generated: ${input.generatedAt}`,
    `Parts: ${input.partCount}`,
    "",
    "Each part is self-contained and can be copied to another computer on its own.",
    "",
  ];
  for (let i = 0; i < input.partCount; i += 1) {
    const folder = `part-${String(i + 1).padStart(2, "0")}`;
    lines.push(`- [${folder}](${folder}/index.md)`);
  }
  if (input.zipPaths.length) {
    lines.push("", "## ZIP archives", "");
    for (const zip of input.zipPaths) lines.push(`- [${zip}](${zip})`);
  }
  lines.push("", `Problems: ${input.problems.length} (see [missing-sources.md](missing-sources.md))`, "");
  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function redactionLabel(state: DriftReviewPackSession["redaction"]): string {
  switch (state) {
    case "REDACTED":
      return "redacted";
    case "SCANNED_UNCHANGED":
      return "scanned, no secrets";
    case "UNREDACTED_AUTHORIZED":
      return "unredacted (operator)";
    default:
      return "exact";
  }
}

/**
 * One line that states what the scan actually did.
 *
 * "Scanned and clean" and "nobody scanned this" are different claims, so the
 * index never collapses them into a single "redacted yes/no".
 */
function renderRedactionLine(
  policy: DriftReviewPackRedactionPolicy,
  allowUnredacted: boolean,
): string {
  if (!policy.requested) {
    return "Redaction was disabled; evidence copies are byte-identical to the vault.";
  }
  const budget = `Sources larger than ${policy.maxScannedBytes} bytes cannot be scanned.`;
  return allowUnredacted
    ? `Credential patterns were scanned (up to ${policy.maxScannedBytes} bytes). ${budget} The operator explicitly authorized unredacted copies for unscannable sources.`
    : `Credential patterns were scanned (up to ${policy.maxScannedBytes} bytes). ${budget} Those sources are excluded and listed as problems.`;
}
