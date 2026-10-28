import {
  ZAICODE_AUDIT_QUICK3_PROFILE,
  zaicodeAuditCombinedFileName,
  zaicodeAuditNextWaveId,
  zaicodeAuditProfileManifestHash,
  zaicodeAuditQuick3Wave,
  zaicodeAuditWaveFileName,
  type ZaicodeAuditQuick3Profile,
  type ZaicodeAuditQuick3Wave,
} from "./zaicode-audit-quick3.js";

/**
 * The durable campaign (Wave 5, matching AUDAPACK Quick3's semantics on
 * ZAICODE's own queue rather than its browser-click transport).
 *
 * Everything here exists because a green UI is not evidence. Progress is a
 * function of artifacts that are ON DISK and hash-verified; a wave that was
 * dispatched is remembered by an idempotency key, so a restart can tell "never
 * dispatched" (safe to dispatch once) from "already dispatched" (observe the
 * existing run, never dispatch a second Core); a failure retries the SAME wave
 * with a higher attempt number and never skips a wave index; and cancelling
 * stops progression while leaving finished artifacts exactly as they are.
 *
 * A new run is a clean slate. Old artifacts on disk cannot satisfy it, because
 * every artifact carries its run id and the campaign checks it.
 */

export type ZaicodeAuditWaveStatus = "pending" | "dispatched" | "saved" | "failed" | "cancelled";

export interface ZaicodeAuditWaveState {
  waveId: string;
  ordinal: number;
  status: ZaicodeAuditWaveStatus;
  attempt: number;
  /** Stable across retries of the SAME wave; that is what makes a retry the same dispatch. */
  idempotencyKey: string;
  artifactFile?: string;
  artifactSha256?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface ZaicodeAuditCampaignState {
  runId: string;
  projectId: string;
  projectName: string;
  profileId: string;
  profileVersion: string;
  manifestHash: string;
  /** Frozen at start: HEAD plus dirty digest, or a snapshot hash. */
  sourceIdentity: string;
  /** The model that will actually run the audit. */
  modelIdentity: string;
  waves: ZaicodeAuditWaveState[];
  cancelled: boolean;
  combined?: { file: string; kind: string; sha256: string; synthesizedAt: string };
}

export interface ZaicodeAuditCampaignInput {
  runId: string;
  projectId: string;
  projectName: string;
  sourceIdentity: string;
  modelIdentity: string;
  profile?: ZaicodeAuditQuick3Profile;
}

/** The key a dispatch is made under. Stable per (run, wave) -- never per attempt. */
export function zaicodeAuditIdempotencyKey(runId: string, waveId: string): string {
  return `a3:${runId}:${waveId}`;
}

function initialWave(wave: ZaicodeAuditQuick3Wave, runId: string): ZaicodeAuditWaveState {
  return {
    waveId: wave.id,
    ordinal: wave.ordinal,
    status: "pending",
    attempt: 0,
    idempotencyKey: zaicodeAuditIdempotencyKey(runId, wave.id),
  };
}

/** A new campaign starts from nothing: no wave carries state from a previous run. */
export function createZaicodeAuditCampaign(input: ZaicodeAuditCampaignInput): ZaicodeAuditCampaignState {
  const profile = input.profile ?? ZAICODE_AUDIT_QUICK3_PROFILE;
  return {
    runId: input.runId,
    projectId: input.projectId,
    projectName: input.projectName,
    profileId: profile.id,
    profileVersion: profile.version,
    manifestHash: zaicodeAuditProfileManifestHash(profile),
    sourceIdentity: input.sourceIdentity,
    modelIdentity: input.modelIdentity,
    waves: profile.waves.map((wave) => initialWave(wave, input.runId)),
    cancelled: false,
  };
}

export type ZaicodeAuditCampaignPhase = "ready-to-dispatch" | "in-flight" | "saving" | "error" | "cancelled" | "done";

export interface ZaicodeAuditCampaignStatus {
  phase: ZaicodeAuditCampaignPhase;
  label: string;
  done: number;
  total: number;
  currentWaveId: string | null;
  /** The wave a dispatch would be made for, or null when there is nothing to do. */
  nextDispatchWaveId: string | null;
  finalArtifactPresent: boolean;
}

/**
 * Where the campaign really is. `done` counts waves whose artifact is SAVED,
 * never waves that were merely dispatched, and READY requires the synthesized
 * final file as well -- a campaign with three saved waves and no combined
 * artifact is SAVING, which is exactly the state the old system never had.
 */
export function zaicodeAuditCampaignStatus(
  state: ZaicodeAuditCampaignState,
  env: { combinedFileExists?: boolean } = {},
): ZaicodeAuditCampaignStatus {
  const total = state.waves.length;
  const saved = state.waves.filter((wave) => wave.status === "saved");
  const done = saved.length;
  const finalArtifactPresent = Boolean(state.combined) && env.combinedFileExists !== false;
  const current = state.waves.find((wave) => wave.status === "dispatched") ?? null;
  const failed = state.waves.find((wave) => wave.status === "failed") ?? null;

  let phase: ZaicodeAuditCampaignPhase;
  if (state.cancelled) phase = "cancelled";
  else if (done === total && finalArtifactPresent) phase = "done";
  else if (done === total) phase = "saving";
  else if (failed) phase = "error";
  else if (current) phase = "saving";
  else phase = "ready-to-dispatch";

  // With nothing saved the first wave is the one to run; after that it is the
  // successor of the last one that is. Asking an empty campaign for "the wave
  // after the last saved wave" returns nothing, which is why this is explicit.
  const nextWaveId = state.cancelled
    ? null
    : saved.length === 0
      ? (state.waves[0]?.waveId ?? null)
      : zaicodeAuditNextWaveId(saved[saved.length - 1]!.waveId);
  return {
    phase,
    label: `${done}/${total}`,
    done,
    total,
    currentWaveId: current?.waveId ?? failed?.waveId ?? null,
    nextDispatchWaveId: phase === "ready-to-dispatch" || phase === "error" ? nextWaveId : null,
    finalArtifactPresent,
  };
}

/** The one dispatch a campaign may make for a wave, or null when it may not. */
export function zaicodeAuditPlanDispatch(
  state: ZaicodeAuditCampaignState,
): { waveId: string; idempotencyKey: string; attempt: number } | null {
  if (state.cancelled) return null;
  const status = zaicodeAuditCampaignStatus(state);
  if (!status.nextDispatchWaveId) return null;
  const wave = state.waves.find((entry) => entry.waveId === status.nextDispatchWaveId);
  if (!wave || wave.status === "saved" || wave.status === "dispatched") return null;
  return { waveId: wave.waveId, idempotencyKey: wave.idempotencyKey, attempt: wave.attempt + 1 };
}

export function markZaicodeAuditDispatched(
  state: ZaicodeAuditCampaignState,
  waveId: string,
  at: string,
): ZaicodeAuditCampaignState {
  return {
    ...state,
    waves: state.waves.map((wave) =>
      wave.waveId === waveId ? { ...wave, status: "dispatched", attempt: wave.attempt + 1, startedAt: at, error: undefined } : wave,
    ),
  };
}

/**
 * Restart recovery. `dispatched` is what the durable log says was actually
 * sent. A wave in that set comes back DISPATCHED (observe it, do not send it
 * again); a wave not in it comes back PENDING, and may be dispatched once.
 */
export function recoverZaicodeAuditCampaign(
  state: ZaicodeAuditCampaignState,
  evidence: { dispatched: readonly { waveId: string }[]; saved?: readonly { waveId: string; file: string; sha256: string; at: string }[] },
): ZaicodeAuditCampaignState {
  const dispatched = new Set(evidence.dispatched.map((entry) => entry.waveId));
  const saved = new Map((evidence.saved ?? []).map((entry) => [entry.waveId, entry]));
  return {
    ...state,
    waves: state.waves.map((wave) => {
      const durable = saved.get(wave.waveId);
      if (durable) {
        return { ...wave, status: "saved", artifactFile: durable.file, artifactSha256: durable.sha256, completedAt: durable.at };
      }
      if (dispatched.has(wave.waveId)) return { ...wave, status: "dispatched" };
      // The durable log outranks what this process remembered. A wave the log
      // does not list was never really sent, so it goes back to pending and
      // may be dispatched once -- including when the in-memory state claimed
      // "dispatched", which is exactly the over-claim a crash can leave.
      if (wave.status === "dispatched") {
        return { ...wave, status: "pending", attempt: Math.max(0, wave.attempt - 1), startedAt: undefined };
      }
      return { ...wave, status: wave.status === "saved" ? "pending" : wave.status };
    }),
  };
}

export function recordZaicodeAuditFailure(
  state: ZaicodeAuditCampaignState,
  waveId: string,
  reason: string,
): ZaicodeAuditCampaignState {
  return {
    ...state,
    waves: state.waves.map((wave) => (wave.waveId === waveId ? { ...wave, status: "failed", error: reason } : wave)),
  };
}

/** Retry the SAME wave. The wave index never moves: a failure is not progress. */
export function retryZaicodeAuditWave(
  state: ZaicodeAuditCampaignState,
  waveId: string,
): ZaicodeAuditCampaignState {
  if (state.cancelled) return state;
  return {
    ...state,
    waves: state.waves.map((wave) =>
      wave.waveId === waveId
        ? { ...wave, status: "pending", error: undefined, idempotencyKey: zaicodeAuditIdempotencyKey(state.runId, waveId) }
        : wave,
    ),
  };
}

export function cancelZaicodeAuditCampaign(state: ZaicodeAuditCampaignState): ZaicodeAuditCampaignState {
  return {
    ...state,
    cancelled: true,
    // Saved artifacts stay exactly as they are: cancelling stops progression,
    // it does not undo what was already proven.
    waves: state.waves.map((wave) =>
      wave.status === "pending" || wave.status === "dispatched" ? { ...wave, status: "cancelled" } : wave,
    ),
  };
}

export function zaicodeAuditSourceUnchanged(state: ZaicodeAuditCampaignState, currentSourceIdentity: string): boolean {
  return state.sourceIdentity === currentSourceIdentity;
}

/** A run may only be judged by artifacts carrying ITS run id. */
export function zaicodeAuditArtifactsBelongToRun(
  state: ZaicodeAuditCampaignState,
  artifacts: readonly { waveId: string; runId: string; projectId: string }[],
): { accepted: string[]; rejected: string[] } {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.runId === state.runId && artifact.projectId === state.projectId) accepted.push(artifact.waveId);
    else rejected.push(artifact.waveId);
  }
  return { accepted, rejected };
}

export interface ZaicodeAuditSynthesisInput {
  state: ZaicodeAuditCampaignState;
  /** The durable text of each saved wave artifact, by wave id. */
  contents: Readonly<Record<string, string>>;
  /** sha256 per saved wave, exactly as the campaign recorded it. */
  digests: Readonly<Record<string, string>>;
  /** The hash function the host uses; SHA-256 lives in the service, not here. */
  sha256: (text: string) => string;
  synthesizedAt: string;
}

/**
 * The combined handoff, synthesized only once every wave artifact is durable
 * and hash-verified. It is the implementation agent's source, so findings are
 * carried VERBATIM: the header says what this is, and the three reports follow
 * in wave order. Nothing is summarised away, and a mismatch is refused rather
 * than patched over.
 */
export function synthesizeZaicodeAuditCombined(input: ZaicodeAuditSynthesisInput): {
  ok: boolean;
  reason?: string;
  markdown?: string;
  sha256?: string;
} {
  const { state, contents, digests, sha256, synthesizedAt } = input;
  const saved = state.waves.filter((wave) => wave.status === "saved");
  if (saved.length !== state.waves.length) {
    return { ok: false, reason: `only ${saved.length} of ${state.waves.length} wave artifacts are durable` };
  }
  for (const wave of saved) {
    const text = contents[wave.waveId];
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, reason: `${wave.waveId} has no durable content` };
    }
    if (wave.artifactSha256 && digests[wave.waveId] && digests[wave.waveId] !== wave.artifactSha256) {
      return { ok: false, reason: `${wave.waveId} content does not match the hash the campaign recorded` };
    }
  }

  const header = [
    `# AUDIT ALL 3 -- ${state.projectName}`,
    "",
    `- Artifact kind: ${ZAICODE_AUDIT_QUICK3_PROFILE.combinedKind}`,
    `- Profile: ${state.profileId} ${state.profileVersion} (manifest ${state.manifestHash})`,
    `- Run: ${state.runId}`,
    `- Project: ${state.projectName} (${state.projectId})`,
    `- Source identity: ${state.sourceIdentity}`,
    `- Audit model: ${state.modelIdentity}`,
    `- Synthesized: ${synthesizedAt}`,
    "",
    "## Waves",
    ...state.waves.map((wave) => `- ${zaicodeAuditWaveFileName(state.projectName, wave.waveId)} -- sha256 ${digests[wave.waveId] ?? "(unknown)"}`),
    "",
  ].join("\n");

  const bodies = state.waves.map((wave) => {
    const heading = `## ${zaicodeAuditQuick3Wave(wave.waveId)?.title ?? wave.waveId}`;
    return [heading, "", contents[wave.waveId]!.trim(), ""].join("\n");
  });

  const markdown = [header, ...bodies].join("\n");
  return { ok: true, markdown, sha256: sha256(markdown) };
}

export function zaicodeAuditCombinedFile(state: ZaicodeAuditCampaignState): string {
  return zaicodeAuditCombinedFileName(state.projectName);
}
