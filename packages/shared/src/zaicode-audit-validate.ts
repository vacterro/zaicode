import {
  ZAICODE_AUDIT_QUICK3_PROFILE,
  zaicodeAuditNextWaveId,
  zaicodeAuditProfileManifestHash,
  zaicodeAuditQuick3Wave,
  type ZaicodeAuditQuick3Profile,
  type ZaicodeAuditQuick3Wave,
} from "./zaicode-audit-quick3.js";

/**
 * What counts as a finished audit wave (Wave 5).
 *
 * This is the gate the operator's complaint turns on: the old system accepted
 * something that merely described how it would audit, and moved on. A report
 * is valid only when it carries the wave's own terminal line, its done
 * marker, and either at least one correctly formed finding with every
 * required field, or that wave's exact no-findings sentence -- AND it belongs
 * to this run, this project, and is chained to the predecessor's hash.
 *
 * Two rules the validator will not bend:
 *
 * 1. It never REPAIRS. A missing STATUS line is a rejection with a reason, not
 *    an invitation to inject one. Injecting the marker would make the gate
 *    agree with a report the model did not write.
 * 2. Plan-shaped output is rejected explicitly, by name, so the operator sees
 *    why the wave did not advance instead of watching it stall.
 */

export type ZaicodeAuditRejectReason =
  | "empty"
  | "missing-terminal-line"
  | "terminal-line-not-last"
  | "missing-done-marker"
  | "missing-identity"
  | "wrong-identity"
  | "wrong-run"
  | "wrong-predecessor"
  | "no-findings-marker-and-no-tickets"
  | "malformed-ticket"
  | "ticket-missing-fields"
  | "ticket-unclassified"
  | "plan-shaped"
  | "artifact-missing"
  | "artifact-hash-mismatch";

export interface ZaicodeAuditArtifactContext {
  /** The project the campaign is for, as the report must name it. */
  projectName: string;
  runId: string;
  waveId: string;
  /** sha256 of the durable predecessor artifact, when the wave depends on one. */
  predecessorSha256?: string;
  /** sha256 of THIS artifact, computed where crypto lives. */
  artifactSha256?: string;
  /** False when the file is not on disk at all. */
  artifactExists?: boolean;
  profile?: ZaicodeAuditQuick3Profile;
}

export interface ZaicodeAuditValidation {
  valid: boolean;
  reason?: ZaicodeAuditRejectReason;
  detail: string;
  tickets: string[];
  /** Present when the wave is valid and not final. */
  nextWaveId?: "core" | "second" | "performance" | null;
}

/** PLAN- shaped output: prose about auditing or implementing, not findings. */
const PLAN_SHAPED = [
  /\bhere'?s? (?:how|the plan|my plan|what i would|i would)\b/i,
  /\bplan for (?:this|the) (?:audit|review|wave)\b/i,
  /\b(?:i|we) (?:will|would) (?:then )?(?:run|perform|start) (?:the )?audit\b/i,
  /\bnext steps? to (?:implement|fix|audit)\b/i,
];

function linesWithPrefix(text: string, prefix: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
}

/**
 * Every finding this wave files, as (ticket, fieldsFound). A ticket is a
 * heading or a bullet whose text starts with the wave's prefix; the fields are
 * then collected until the next ticket.
 */
function parseTickets(text: string, wave: ZaicodeAuditQuick3Wave): { ticket: string; fields: string[]; classified: boolean }[] {
  const out: { ticket: string; fields: string[]; classified: boolean }[] = [];
  const all = text.split("\n").map((line) => line.trim());
  // Reports write a ticket as a heading or a bullet, not at column 0, so the
  // markdown decoration in front of the id is stripped first. Prose that merely
  // MENTIONS an id mid-sentence is not a ticket header.
  const header = (line: string) =>
    line
      .replace(/^[#>*\-\s]+/, "")
      .replace(/^\*\*|\*\*$/g, "")
      .trim();
  const indexes = all
    .map((line, index) => ({ line, index }))
    .filter((entry) => header(entry.line).startsWith(wave.ticketPrefix));
  indexes.forEach((entry, position) => {
    const end = position + 1 < indexes.length ? indexes[position + 1]!.index : all.length;
    const body = all.slice(entry.index, end);
    const fields = new Set<string>();
    let classified = false;
    for (const line of body) {
      for (const field of wave.findingFields) {
        if (line.startsWith(`${field}:`) || line.startsWith(`- **${field}**:`) || line.startsWith(`**${field}**:`)) {
          fields.add(field);
        }
      }
      if (wave.classifications?.some((value) => line.includes(value))) classified = true;
    }
    out.push({ ticket: header(entry.line), fields: [...fields], classified });
  });
  return out;
}

export function validateZaicodeAuditArtifact(
  text: string,
  context: ZaicodeAuditArtifactContext,
): ZaicodeAuditValidation {
  const profile = context.profile ?? ZAICODE_AUDIT_QUICK3_PROFILE;
  const wave = zaicodeAuditQuick3Wave(context.waveId);
  const reject = (reason: ZaicodeAuditRejectReason, detail: string): ZaicodeAuditValidation => ({
    valid: false,
    reason,
    detail,
    tickets: [],
  });

  if (!wave) return reject("wrong-identity", `unknown wave ${context.waveId}`);
  if (context.artifactExists === false) {
    return reject("artifact-missing", `the ${wave.id} artifact file is not on disk`);
  }
  if (!text || !text.trim()) return reject("empty", "the report is empty");

  const trimmed = text.trim();
  const allLines = trimmed.split("\n").map((line) => line.trim());

  // 1. The terminal line, and it must END the report.
  if (!trimmed.includes(wave.terminalLine)) {
    return reject("missing-terminal-line", `the report does not contain "${wave.terminalLine}"`);
  }
  const lastMeaningful = [...allLines].reverse().find((line) => line.length > 0) ?? "";
  if (lastMeaningful !== wave.terminalLine) {
    return reject("terminal-line-not-last", `"${wave.terminalLine}" is present but is not the last line of the report`);
  }

  // 2. The done marker.
  if (!linesWithPrefix(trimmed, wave.doneMarker).length) {
    return reject("missing-done-marker", `the report does not contain a "${wave.doneMarker}" line`);
  }

  // 3. Identity: this run, this project, this wave.
  if (context.projectName && !trimmed.includes(context.projectName)) {
    return reject("missing-identity", `the report does not name the project (${context.projectName})`);
  }
  if (context.runId && !trimmed.includes(context.runId)) {
    return reject("wrong-run", `the report does not name this run (${context.runId})`);
  }

  // 4. Chain to the predecessor.
  if (wave.dependsOn.length > 0) {
    if (!context.predecessorSha256) {
      return reject("wrong-predecessor", `${wave.id} depends on ${wave.dependsOn.join(", ")} but no predecessor hash was supplied`);
    }
    if (!trimmed.includes(context.predecessorSha256)) {
      return reject("wrong-predecessor", `the report does not carry the predecessor artifact hash ${context.predecessorSha256}`);
    }
  }

  // 5. Findings, or the wave's exact no-findings sentence.
  const hasNoFindings = trimmed.includes(wave.noFindingsMarker);
  const tickets = parseTickets(trimmed, wave);
  if (!hasNoFindings && tickets.length === 0) {
    // A report with neither is either empty of substance or a plan. Say which.
    const looksLikePlan = PLAN_SHAPED.some((pattern) => pattern.test(trimmed));
    if (looksLikePlan) {
      return reject(
        "plan-shaped",
        "the response describes how it would audit or implement instead of reporting verified findings; a plan does not advance a wave",
      );
    }
    return reject(
      "no-findings-marker-and-no-tickets",
      `the report has no "${wave.ticketPrefix}N" finding and does not contain "${wave.noFindingsMarker}"`,
    );
  }

  if (!hasNoFindings) {
    for (const entry of tickets) {
      const missing = wave.findingFields.filter((field) => !entry.fields.includes(field));
      if (missing.length > 0) {
        return reject("ticket-missing-fields", `${entry.ticket} is missing ${missing.join(", ")}`);
      }
      if (wave.classifications && !entry.classified) {
        return reject("ticket-unclassified", `${entry.ticket} is not classified as one of ${wave.classifications.join(", ")}`);
      }
    }
  }

  // 6. The digest the campaign will record.
  if (context.artifactSha256 !== undefined && !/^[0-9a-f]{64}$/.test(context.artifactSha256)) {
    return reject("artifact-hash-mismatch", `artifact sha256 ${context.artifactSha256} is not a sha256`);
  }

  return {
    valid: true,
    detail: hasNoFindings
      ? `${wave.id} reported no verified findings, and said so with the exact marker`
      : `${wave.id} reported ${tickets.length} verified finding(s) with every required field`,
    tickets: tickets.map((entry) => entry.ticket),
    nextWaveId: zaicodeAuditNextWaveId(wave.id),
  };
}

/** Progress is derived from durable, validated artifacts -- never from optimism. */
export function zaicodeAuditProgress(
  validated: Readonly<Record<string, boolean>>,
  profile: ZaicodeAuditQuick3Profile = ZAICODE_AUDIT_QUICK3_PROFILE,
): { done: number; total: number; label: string; nextWaveId: string | null } {
  const done = profile.waves.filter((wave) => validated[wave.id] === true).length;
  const next = profile.waves.find((wave) => validated[wave.id] !== true) ?? null;
  return {
    done,
    total: profile.waves.length,
    label: `${done}/${profile.waves.length}`,
    nextWaveId: next?.id ?? null,
  };
}

/** The manifest stamp a campaign records so a later report is judged by the same contract. */
export function zaicodeAuditCampaignBinding(profile: ZaicodeAuditQuick3Profile = ZAICODE_AUDIT_QUICK3_PROFILE) {
  return {
    profileId: profile.id,
    profileVersion: profile.version,
    manifestHash: zaicodeAuditProfileManifestHash(profile),
    waveIds: profile.waves.map((wave) => wave.id),
  };
}
