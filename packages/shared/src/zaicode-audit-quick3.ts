/**
 * AUDAPACK Quick3 v1.0.0, as data (Wave 5).
 *
 * Every string an audit wave is judged by lives HERE: the ticket prefix, the
 * terminal STATUS line, the done marker, the finding field names, the
 * no-findings sentence and the output filename. The wave prompt, the report
 * validator, the panel and the composer command all read this profile, so
 * changing what "a valid Core report" means is a change in one file and
 * nothing else can drift away from it.
 *
 * The profile is frozen. A campaign binds to a manifest hash at its start,
 * and a report is validated against the profile the campaign started with --
 * not the one on disk now -- so a mid-campaign edit cannot retroactively
 * decide that yesterday's artifact was fine after all.
 */

export const ZAICODE_AUDIT_QUICK3_ID = "quick3";
export const ZAICODE_AUDIT_QUICK3_VERSION = "1.0.0";

export type ZaicodeAuditFieldName = "EVIDENCE" | "DEFECT" | "REPAIR" | "VERIFY" | "ISSUE" | "OPTIMIZE" | "GUARDRAIL";

export interface ZaicodeAuditQuick3Wave {
  id: "core" | "second" | "performance";
  ordinal: 1 | 2 | 3;
  slug: string;
  title: string;
  /** The prefix every ticket this wave files carries. */
  ticketPrefix: string;
  /** The exact line that ends a valid report. */
  terminalLine: string;
  /** The marker that must appear for the wave to count as done. */
  doneMarker: string;
  dependsOn: readonly ("core" | "second" | "performance")[];
  scope: string;
  findingFields: readonly ZaicodeAuditFieldName[];
  /** Performance findings are classified, not merely described. */
  classifications?: readonly string[];
  noFindingsMarker: string;
  /** `<Project>__NN_SLUG.md`; the placeholder is filled per campaign. */
  outputFile: string;
  finalizer: boolean;
}

/** The read-only contract every wave prompt states, in the model's own terms. */
export const ZAICODE_AUDIT_ROLE_CONTRACT = [
  "You are a READ-ONLY auditor. You do not implement, repair, refactor or tidy anything.",
  "Inspect the supplied project or snapshot deeply, and report only defects you can point at with evidence.",
  "The expected answer is the audit artifact itself -- NOT a plan for how an audit or an implementation would go.",
  "A response that merely describes how you would audit, or how you would implement, does not advance this wave.",
  "Do not modify implementation files, project metadata or configuration during the audit.",
  "Do not invent evidence. If the target cannot be read, say so and report it as unreadable rather than guessing.",
  "You may run tests or commands to gather evidence when it is safe to do so, and you must report their results truthfully, including failures.",
  "Speculative cleanup is not a finding. If it is not wrong today, it is not a defect today.",
  "Return a repair handoff for a SEPARATE implementation agent, naming file and line, the smallest safe fix, and how to verify it.",
] as const;

export const ZAICODE_AUDIT_QUICK3_PROFILE = {
  id: ZAICODE_AUDIT_QUICK3_ID,
  version: ZAICODE_AUDIT_QUICK3_VERSION,
  label: "AUDAPACK Quick3",
  description: "Three read-only audit waves, chained and hash-verified, then one combined implementation handoff.",
  combinedFile: "<Project>__00_AUDIT_ALL_3.md",
  roleContract: ZAICODE_AUDIT_ROLE_CONTRACT,
  waves: [
    {
      id: "core",
      ordinal: 1,
      slug: "AUDIT_CORE",
      title: "AUDIT CORE",
      ticketPrefix: "CORE-",
      terminalLine: "STATUS: AUDIT_CORE: COMPLETE",
      doneMarker: "CORE_DONE_WHEN:",
      dependsOn: [],
      scope:
        "System map, invariants, correctness, state ownership, persistence, validation, error paths, tests.",
      findingFields: ["EVIDENCE", "DEFECT", "REPAIR", "VERIFY"],
      noFindingsMarker: "NO VERIFIED CORE DEFECTS.",
      outputFile: "<Project>__01_AUDIT_CORE.md",
      finalizer: false,
    },
    {
      id: "second",
      ordinal: 2,
      slug: "AUDIT_SECOND_WAVE",
      title: "AUDIT SECOND WAVE",
      ticketPrefix: "W2-",
      terminalLine: "STATUS: SECOND_WAVE: COMPLETE",
      doneMarker: "SECOND_WAVE_DONE_WHEN:",
      dependsOn: ["core"],
      scope:
        "Lifecycle, startup/shutdown/cleanup, unusual boundaries, multiple writers, duplicate dispatch, cancellation/retry, partial writes, parser/serializer asymmetry, swallowed errors, duplicate truth.",
      findingFields: ["EVIDENCE", "DEFECT", "REPAIR", "VERIFY"],
      noFindingsMarker: "NO NEW VERIFIED SECOND-WAVE DEFECTS.",
      outputFile: "<Project>__02_AUDIT_SECOND_WAVE.md",
      finalizer: false,
    },
    {
      id: "performance",
      ordinal: 3,
      slug: "AUDIT_PERFORMANCE",
      title: "AUDIT PERFORMANCE / STABILITY / EFFECTIVENESS",
      ticketPrefix: "PERF-",
      terminalLine: "STATUS: PERFORMANCE: COMPLETE",
      doneMarker: "PERFORMANCE_DONE_WHEN:",
      dependsOn: ["core", "second"],
      scope:
        "Repeated parsing/serialization, O(n^2) paths, reflow/scans, event/listener leaks, async races, unbounded queues/maps/buffers, startup I/O and low-risk hot-path simplification.",
      findingFields: ["EVIDENCE", "ISSUE", "OPTIMIZE", "GUARDRAIL", "VERIFY"],
      classifications: ["PROVEN BOTTLENECK", "STRONGLY EVIDENCED WASTE", "LOW-RISK SIMPLIFICATION"],
      noFindingsMarker: "NO MATERIAL PERFORMANCE/STABILITY FINDINGS.",
      outputFile: "<Project>__03_AUDIT_PERFORMANCE.md",
      finalizer: true,
    },
  ] as readonly ZaicodeAuditQuick3Wave[],
} as const;

export type ZaicodeAuditQuick3Profile = typeof ZAICODE_AUDIT_QUICK3_PROFILE;

export function zaicodeAuditQuick3Wave(waveId: string): ZaicodeAuditQuick3Wave | null {
  return (ZAICODE_AUDIT_QUICK3_PROFILE.waves.find((wave) => wave.id === waveId) as ZaicodeAuditQuick3Wave | undefined) ?? null;
}

/** The wave that runs after `waveId`, or null at the end of the campaign. */
export function zaicodeAuditNextWaveId(waveId: string): "core" | "second" | "performance" | null {
  const wave = zaicodeAuditQuick3Wave(waveId);
  if (!wave) return null;
  return wave.ordinal < 3 ? (ZAICODE_AUDIT_QUICK3_PROFILE.waves[wave.ordinal]?.id as "core" | "second" | "performance") : null;
}

export function zaicodeAuditWaveFileName(projectName: string, waveId: string): string {
  const wave = zaicodeAuditQuick3Wave(waveId);
  if (!wave) throw new Error(`unknown audit wave ${waveId}`);
  return `${projectName}__${String(wave.ordinal).padStart(2, "0")}_${wave.slug}.md`;
}

export function zaicodeAuditCombinedFileName(projectName: string): string {
  return projectName.replace("<Project>", "") + "__00_AUDIT_ALL_3.md";
}

/**
 * A stable hash of the profile itself, so a campaign can prove which contract
 * it was judged against. FNV-1a rather than SHA-256 on purpose: this runs in
 * the renderer on every read, must be synchronous, and the value is an
 * identity stamp, not a security claim. Artifact digests are SHA-256 and are
 * computed where crypto lives.
 */
export function zaicodeAuditProfileManifestHash(
  profile: ZaicodeAuditQuick3Profile = ZAICODE_AUDIT_QUICK3_PROFILE,
): string {
  const canonical = JSON.stringify({
    id: profile.id,
    version: profile.version,
    combinedFile: profile.combinedFile,
    roleContract: profile.roleContract,
    waves: profile.waves.map((wave) => ({
      id: wave.id,
      ordinal: wave.ordinal,
      slug: wave.slug,
      title: wave.title,
      ticketPrefix: wave.ticketPrefix,
      terminalLine: wave.terminalLine,
      doneMarker: wave.doneMarker,
      dependsOn: wave.dependsOn,
      scope: wave.scope,
      findingFields: wave.findingFields,
      classifications: wave.classifications ?? null,
      noFindingsMarker: wave.noFindingsMarker,
      outputFile: wave.outputFile,
      finalizer: wave.finalizer,
    })),
  });
  let hash = 0xcbf29ce484222325;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x100000001b3);
  }
  return `fnv1a64:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * The prompt for one wave. It states the role contract, the wave's own scope
 * and field names, and -- explicitly -- that an implementation plan does not
 * count. It never mentions a filename the caller has to remember: the
 * validator decides validity, and the prompt only has to get a real audit out
 * of the model.
 */
export function buildZaicodeQuick3WavePrompt(input: {
  waveId: string;
  projectName: string;
  projectPath: string;
  sourceIdentity: string;
  predecessorArtifactName?: string;
  predecessorSha256?: string;
}): string {
  const wave = zaicodeAuditQuick3Wave(input.waveId);
  if (!wave) throw new Error(`unknown audit wave ${input.waveId}`);
  const lines: string[] = [
    `# ${wave.title}`,
    "",
    "## Your role",
    ...ZAICODE_AUDIT_ROLE_CONTRACT.map((line) => `- ${line}`),
    "",
    "## This wave",
    `- Project: ${input.projectName} (${input.projectPath})`,
    `- Source identity: ${input.sourceIdentity}`,
    `- Scope: ${wave.scope}`,
    `- File every finding under a ticket titled exactly \`${wave.ticketPrefix}N\` -- for example \`${wave.ticketPrefix}1\`.`,
    `- Each finding must carry these fields, in this order: ${wave.findingFields.join(", ")}.`,
    ...(wave.classifications
      ? [`- Each performance finding must be classified as one of: ${wave.classifications.join(", ")}.`]
      : []),
    `- If you verify nothing, the report must contain exactly this line: \`${wave.noFindingsMarker}\``,
    "",
    "## How the report is judged",
    `- It must contain the line \`${wave.terminalLine}\` -- the last line of the report.`,
    `- It must contain \`${wave.doneMarker}\` followed by what would make this wave provably complete.`,
    `- A report that only proposes how to audit or how to implement is INVALID and the wave will not advance.`,
  ];
  if (wave.dependsOn.length > 0 && input.predecessorArtifactName) {
    lines.push(
      "",
      "## What the previous wave found",
      `Read ${input.predecessorArtifactName} (sha256 ${input.predecessorSha256 ?? "unknown"}) first. Do not repeat its findings; build on them.`,
    );
  }
  return lines.join("\n");
}
