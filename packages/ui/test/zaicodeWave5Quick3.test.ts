import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ZAICODE_AUDIT_QUICK3_PROFILE,
  ZAICODE_AUDIT_ROLE_CONTRACT,
  buildZaicodeQuick3WavePrompt,
  zaicodeAuditCombinedFileName,
  zaicodeAuditNextWaveId,
  zaicodeAuditProfileManifestHash,
  zaicodeAuditQuick3Wave,
  zaicodeAuditWaveFileName,
} from "@zcode/shared/zaicode-audit-quick3";
import {
  validateZaicodeAuditArtifact,
  zaicodeAuditCampaignBinding,
  zaicodeAuditProgress,
  type ZaicodeAuditArtifactContext,
} from "@zcode/shared/zaicode-audit-validate";

/**
 * Wave 5: the canonical Quick3 profile and the report gate. The gate is the
 * thing the operator's complaint is about -- the old system accepted a plan
 * and moved on -- so most of these cases are ways a report can be WRONG and
 * must not advance a wave.
 */

const PROJECT = "ZAICODE";
const RUN = "run-2026-09-29-a3";

const context = (patch: Partial<ZaicodeAuditArtifactContext> = {}): ZaicodeAuditArtifactContext => ({
  projectName: PROJECT,
  runId: RUN,
  waveId: "core",
  artifactExists: true,
  ...patch,
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function coreReport(patch: { findings?: boolean; noFindings?: boolean; tail?: string } = {}): string {
  const findings = patch.findings === false ? [] : [
    "### CORE-1 Sessions are keyed by the display name",
    "EVIDENCE: packages/ui/src/store/tabStore.ts:34 renames the key on rename.",
    "DEFECT: A renamed project loses its history silently.",
    "REPAIR: Mint a stable id on first sight and key by that.",
    "VERIFY: A control renames a project and reads its history back.",
  ];
  const noFindings = patch.noFindings ? "NO VERIFIED CORE DEFECTS." : "";
  const tail = patch.tail ?? "STATUS: AUDIT_CORE: COMPLETE";
  return [
    `# AUDIT CORE`,
    `Project: ${PROJECT}`,
    `Run: ${RUN}`,
    `CORE_DONE_WHEN: every core wave finding carries EVIDENCE, DEFECT, REPAIR and VERIFY.`,
    ...findings,
    noFindings,
    tail,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

test("Wave 5: a well-formed Core report is valid and names the next wave", () => {
  const verdict = validateZaicodeAuditArtifact(coreReport(), context());
  assert.equal(verdict.valid, true, verdict.detail);
  assert.equal(verdict.reason, undefined);
  assert.deepEqual(verdict.tickets, ["CORE-1 Sessions are keyed by the display name"]);
  assert.equal(verdict.nextWaveId, "second");
});

test("Wave 5: a Core report with no findings is valid when it says so with the exact sentence", () => {
  const text = coreReport({ findings: false, noFindings: true });
  const verdict = validateZaicodeAuditArtifact(text, context());
  assert.equal(verdict.valid, true, verdict.detail);
  assert.deepEqual(verdict.tickets, []);
});

test("Wave 5: missing STATUS keeps the wave at 0/3", () => {
  const verdict = validateZaicodeAuditArtifact(coreReport({ tail: "Next steps: run the second wave." }), context());
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "missing-terminal-line");
  assert.equal(zaicodeAuditProgress({}).label, "0/3");
});

test("Wave 5: the STATUS line has to be the last line, not merely present", () => {
  const verdict = validateZaicodeAuditArtifact(`${coreReport()}\n\nA closing thought.`, context());
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "terminal-line-not-last");
});

test("Wave 5: plan-shaped output is rejected by name and never advances the wave", () => {
  const plan = [
    `# AUDIT CORE`,
    `Project: ${PROJECT}`,
    `Run: ${RUN}`,
    `CORE_DONE_WHEN: the core wave is complete.`,
    "Here's my plan: I will first read the project's own docs, then walk the state ownership,",
    "and finally produce a prioritized list for the implementation agent.",
    "STATUS: AUDIT_CORE: COMPLETE",
  ].join("\n");
  const verdict = validateZaicodeAuditArtifact(plan, context());
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "plan-shaped");
  assert.match(verdict.detail, /plan does not advance a wave/);
});

test("Wave 5: a report with neither findings nor the no-findings sentence is rejected", () => {
  const verdict = validateZaicodeAuditArtifact(
    [
      `# AUDIT CORE`,
      `Project: ${PROJECT}`,
      `Run: ${RUN}`,
      `CORE_DONE_WHEN: done.`,
      "The code looked reasonable to me.",
      "STATUS: AUDIT_CORE: COMPLETE",
    ].join("\n"),
    context(),
  );
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "no-findings-marker-and-no-tickets");
});

test("Wave 5: a finding missing any required field is rejected", () => {
  const text = coreReport().replace("VERIFY: A control renames a project and reads its history back.", "");
  const verdict = validateZaicodeAuditArtifact(text, context());
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "ticket-missing-fields");
  assert.match(verdict.detail, /VERIFY/);
});

test("Wave 5: the wrong project or the wrong run is rejected", () => {
  assert.equal(validateZaicodeAuditArtifact(coreReport(), context({ projectName: "OTHER" })).reason, "missing-identity");
  assert.equal(validateZaicodeAuditArtifact(coreReport(), context({ runId: "run-older" })).reason, "wrong-run");
});

test("Wave 5: a chained wave must carry its predecessor's hash", () => {
  const second = [
    `# AUDIT SECOND WAVE`,
    `Project: ${PROJECT}`,
    `Run: ${RUN}`,
    `Predecessor sha256: ${SHA_A}`,
    `SECOND_WAVE_DONE_WHEN: every second-wave finding carries its evidence.`,
    "### W2-1 Cleanup runs twice on restart",
    `EVIDENCE: tools/saipen_engine/operations.py:88 re-queues an already dispatched job.`,
    "DEFECT: The same logical run starts twice.",
    "REPAIR: Reconcile against the existing run after recovery.",
    "VERIFY: A control restarts after dispatch and counts the runs.",
    "STATUS: SECOND_WAVE: COMPLETE",
  ].join("\n");

  assert.equal(validateZaicodeAuditArtifact(second, context({ waveId: "second", predecessorSha256: SHA_A })).valid, true);
  // The hash from a different predecessor is a different campaign.
  assert.equal(validateZaicodeAuditArtifact(second, context({ waveId: "second", predecessorSha256: SHA_B })).reason, "wrong-predecessor");
  // A dependent wave with no predecessor at all is refused, not waved through.
  assert.equal(validateZaicodeAuditArtifact(second, context({ waveId: "second" })).reason, "wrong-predecessor");
});

test("Wave 5: a performance finding must be classified", () => {
  const perf = (classified: boolean) =>
    [
      `# AUDIT PERFORMANCE / STABILITY / EFFECTIVENESS`,
      `Project: ${PROJECT}`,
      `Run: ${RUN}`,
      `Predecessor sha256: ${SHA_A}`,
      `PERFORMANCE_DONE_WHEN: every performance finding is classified.`,
      "### PERF-1 The sidebar re-scans every row on each store write",
      "EVIDENCE: packages/ui/src/WorkspaceSidebar.tsx:410 rebuilds the section list per render.",
      "ISSUE: Work grows with rows times writes.",
      "OPTIMIZE: Memoize the section builder on its own inputs.",
      "GUARDRAIL: A control renders N rows and counts builder calls.",
      ...(classified ? ["This is a PROVEN BOTTLENECK."] : []),
      "VERIFY: The guard fails if the builder runs twice per write.",
      "STATUS: PERFORMANCE: COMPLETE",
    ].join("\n");

  assert.equal(validateZaicodeAuditArtifact(perf(true), context({ waveId: "performance", predecessorSha256: SHA_A })).valid, true);
  const unclassified = validateZaicodeAuditArtifact(perf(false), context({ waveId: "performance", predecessorSha256: SHA_A }));
  assert.equal(unclassified.valid, false);
  assert.equal(unclassified.reason, "ticket-unclassified");
});

test("Wave 5: a missing file is SAVING/ERROR, never READY", () => {
  const verdict = validateZaicodeAuditArtifact(coreReport(), context({ artifactExists: false }));
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "artifact-missing");
  assert.equal(zaicodeAuditProgress({ core: true }).label, "1/3");
  assert.equal(zaicodeAuditProgress({ core: true, second: true }).label, "2/3");
  assert.equal(zaicodeAuditProgress({ core: true, second: true, performance: true }).nextWaveId, null);
});

test("Wave 5: a digest that is not a sha256 is refused", () => {
  assert.equal(validateZaicodeAuditArtifact(coreReport(), context({ artifactSha256: "not-a-hash" })).reason, "artifact-hash-mismatch");
  assert.equal(validateZaicodeAuditArtifact(coreReport(), context({ artifactSha256: SHA_B })).valid, true);
});

test("Wave 5: the validator never repairs -- a missing marker stays missing", () => {
  const text = coreReport().replace("CORE_DONE_WHEN:", "done when:");
  const verdict = validateZaicodeAuditArtifact(text, context());
  assert.equal(verdict.valid, false);
  assert.equal(verdict.reason, "missing-done-marker");
  assert.ok(!text.includes("CORE_DONE_WHEN:"), "the report is unchanged by validation");
});

test("Wave 5: the profile holds every string the wave is judged by, in one place", () => {
  const profile = ZAICODE_AUDIT_QUICK3_PROFILE;
  assert.equal(profile.version, "1.0.0");
  const core = zaicodeAuditQuick3Wave("core")!;
  assert.equal(core.ticketPrefix, "CORE-");
  assert.equal(core.terminalLine, "STATUS: AUDIT_CORE: COMPLETE");
  assert.equal(core.doneMarker, "CORE_DONE_WHEN:");
  assert.equal(core.noFindingsMarker, "NO VERIFIED CORE DEFECTS.");
  assert.deepEqual(core.findingFields, ["EVIDENCE", "DEFECT", "REPAIR", "VERIFY"]);

  const second = zaicodeAuditQuick3Wave("second")!;
  assert.equal(second.ticketPrefix, "W2-");
  assert.equal(second.terminalLine, "STATUS: SECOND_WAVE: COMPLETE");
  assert.equal(second.noFindingsMarker, "NO NEW VERIFIED SECOND-WAVE DEFECTS.");
  assert.deepEqual(second.dependsOn, ["core"]);

  const performance = zaicodeAuditQuick3Wave("performance")!;
  assert.equal(performance.ticketPrefix, "PERF-");
  assert.equal(performance.terminalLine, "STATUS: PERFORMANCE: COMPLETE");
  assert.equal(performance.noFindingsMarker, "NO MATERIAL PERFORMANCE/STABILITY FINDINGS.");
  assert.deepEqual(performance.findingFields, ["EVIDENCE", "ISSUE", "OPTIMIZE", "GUARDRAIL", "VERIFY"]);
  assert.deepEqual(performance.classifications, ["PROVEN BOTTLENECK", "STRONGLY EVIDENCED WASTE", "LOW-RISK SIMPLIFICATION"]);
  assert.deepEqual(performance.dependsOn, ["core", "second"]);

  // The wave order and the file names come from the same place.
  assert.equal(zaicodeAuditNextWaveId("core"), "second");
  assert.equal(zaicodeAuditNextWaveId("second"), "performance");
  assert.equal(zaicodeAuditNextWaveId("performance"), null);
  assert.equal(zaicodeAuditWaveFileName("<Project>", "core"), "__01_AUDIT_CORE.md".replace("__", "<Project>__"));
  assert.equal(zaicodeAuditWaveFileName("ZAICODE", "second"), "ZAICODE__02_AUDIT_SECOND_WAVE.md");
  assert.equal(zaicodeAuditWaveFileName("ZAICODE", "performance"), "ZAICODE__03_AUDIT_PERFORMANCE.md");
  assert.equal(zaicodeAuditCombinedFileName("ZAICODE"), "ZAICODE__00_AUDIT_ALL_3.md");
});

test("Wave 5: the manifest hash is stable and moves when the contract does", () => {
  const first = zaicodeAuditProfileManifestHash();
  assert.equal(first, zaicodeAuditProfileManifestHash(), "the same profile hashes the same");
  assert.match(first, /^fnv1a64:[0-9a-f]{8}$/);
  const changed = { ...ZAICODE_AUDIT_QUICK3_PROFILE, version: "1.0.1" };
  assert.notEqual(zaicodeAuditProfileManifestHash(changed), first, "a different contract, a different stamp");

  const binding = zaicodeAuditCampaignBinding();
  assert.equal(binding.profileVersion, "1.0.0");
  assert.equal(binding.manifestHash, first);
  assert.deepEqual(binding.waveIds, ["core", "second", "performance"]);
});

test("Wave 5: the prompt states the read-only contract and says a plan will not count", () => {
  const prompt = buildZaicodeQuick3WavePrompt({
    waveId: "core",
    projectName: "ZAICODE",
    projectPath: "V:/repo",
    sourceIdentity: "git:abc123+dirty",
  });
  for (const clause of ZAICODE_AUDIT_ROLE_CONTRACT) {
    const head = clause.split(/[.,:]/)[0]!.slice(0, 24);
    assert.ok(prompt.includes(head), `the prompt must carry the clause about ${head}`);
  }
  assert.match(prompt, /INVALID and the wave will not advance/);
  assert.match(prompt, /CORE-1/);
  assert.match(prompt, /EVIDENCE, DEFECT, REPAIR, VERIFY/);
  assert.match(prompt, /NO VERIFIED CORE DEFECTS\./);
  assert.match(prompt, /git:abc123\+dirty/);

  // A dependent wave is told what to read first.
  const second = buildZaicodeQuick3WavePrompt({
    waveId: "second",
    projectName: "ZAICODE",
    projectPath: "V:/repo",
    sourceIdentity: "git:abc123",
    predecessorArtifactName: "ZAICODE__01_AUDIT_CORE.md",
    predecessorSha256: SHA_A,
  });
  assert.match(second, /ZAICODE__01_AUDIT_CORE\.md/);
  assert.match(second, new RegExp(SHA_A));
});
