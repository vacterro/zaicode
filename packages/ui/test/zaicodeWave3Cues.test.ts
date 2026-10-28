import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  ZAICODE_DEFAULT_CUE_GATE,
  ZAICODE_ACTION_CUE_DEFS,
  ZAICODE_ACTION_CUE_IDS,
  ZAICODE_ALWAYS_CUE_IDS,
  admitZaicodeActionCue,
  createZaicodeCueGateMemory,
  zaicodeActionCueForReasoning,
  zaicodeActionCueForSessionStatus,
  zaicodeActionCueForToolCall,
} from "@/zaicode/zaicodeActionCues.js";
import {
  ZAICODE_FLOATER_DEFAULTS,
  normalizeZaicodeFloaterPrefs,
  zaicodeFloatersFor,
  zaicodeSpawnedFiles,
} from "@/zaicode/zaicodeChangeFloaters.js";
import {
  applyZaicodeNormalization,
  collectZaicodeNormalizeTargets,
  runZaicodeNormalizePass,
  undoZaicodeNormalization,
} from "@/zaicode/zaicodeSoundNormalize.js";
import { planZaicodeNormalization, type ZaicodeSoundAnalysis } from "@/zaicode/zaicodeSoundAnalysis.js";
import { defaultZaicodeSoundSettings, normalizeZaicodeSoundSettings, type ZaicodeSoundSettings } from "@/zaicode/zaicodeSoundSettingsModel.js";

/**
 * Wave 3, parts C and D plus the normalize pass. Everything here is pure, so
 * the claims are checked directly: the same tool always maps to the same cue,
 * noise is bounded, a new file spawns exactly once, and a rejected file never
 * takes the run down with it.
 */

test("Wave 3 C: a tool maps to its cue by identity, never by its output text", () => {
  assert.equal(zaicodeActionCueForToolCall({ name: "Read", family: "file-read" }), "agent.read");
  assert.equal(zaicodeActionCueForToolCall({ name: "Grep", family: "search" }), "agent.search");
  assert.equal(zaicodeActionCueForToolCall({ name: "Glob", family: "search" }), "agent.search");
  assert.equal(zaicodeActionCueForToolCall({ name: "Bash", family: "shell" }), "agent.shell");
  assert.equal(zaicodeActionCueForToolCall({ name: "TodoWrite", family: "plan-guidance" }), "agent.plan");
  assert.equal(zaicodeActionCueForToolCall({ name: "Edit", family: "file-write" }), "agent.edit");
  assert.equal(zaicodeActionCueForToolCall({ name: "SomethingElse" }), "agent.tool", "a tool with no specific mapping still has a cue");

  // The same call in any language maps identically: the tool NAME is the only
  // input, so an Estonian or Japanese answer cannot change the cue.
  const first = zaicodeActionCueForToolCall({ name: "Read", family: "file-read" });
  assert.equal(zaicodeActionCueForToolCall({ name: "Read", family: "file-read" }), first);
});

test("Wave 3 C: a file that did not exist is a create, not an edit", () => {
  assert.equal(zaicodeActionCueForToolCall({ name: "Write", family: "file-write", createdFile: true }), "agent.create");
  assert.equal(zaicodeActionCueForToolCall({ name: "Write", family: "file-write", createdFile: false }), "agent.edit");
});

test("Wave 3 C: reasoning and session state have their own cues", () => {
  assert.equal(zaicodeActionCueForReasoning({ streaming: true }), "agent.reasoning.start");
  assert.equal(zaicodeActionCueForReasoning({ streaming: false }), "agent.reasoning.end");
  assert.equal(zaicodeActionCueForSessionStatus("permission_request"), "agent.attention");
  assert.equal(zaicodeActionCueForSessionStatus("failed"), "agent.failure");
  assert.equal(zaicodeActionCueForSessionStatus("completed"), "agent.response.end");
  assert.equal(zaicodeActionCueForSessionStatus("running", "running"), null, "an unchanged status is not an event");
});

test("Wave 3 C: 500 tiny reads do not make 500 sounds", () => {
  const memory = createZaicodeCueGateMemory();
  let played = 0;
  for (let index = 0; index < 500; index += 1) {
    // 500 reads spread over one second, the worst case an agent can produce.
    if (admitZaicodeActionCue("agent.read", index * 2, memory)) played += 1;
  }
  assert.ok(played <= 4, `reads are rate limited, got ${played} sounds for 500 reads`);
});

test("Wave 3 C: a completion or a failure is never swallowed by the limiter", () => {
  const memory = createZaicodeCueGateMemory();
  for (const cue of ZAICODE_ALWAYS_CUE_IDS) {
    for (let index = 0; index < 50; index += 1) {
      assert.equal(admitZaicodeActionCue(cue, index, memory), true, `${cue} must always get through`);
    }
  }
  // ... and it does not spend the noisy budget either: after 200 always-cues
  // the burst allowance is untouched, so reads still get their full three.
  const after = createZaicodeCueGateMemory();
  for (let index = 0; index < 200; index += 1) admitZaicodeActionCue("agent.failure", index, after);
  assert.deepEqual(
    [0, 1, 2, 3].map(() => admitZaicodeActionCue("agent.read", 500, after, { ...ZAICODE_DEFAULT_CUE_GATE, perEventWindowMs: 0 })),
    [true, true, true, false],
  );
});

test("Wave 3 C: every declared cue has a row, and every row is a known cue", () => {
  const ids = new Set<string>(ZAICODE_ACTION_CUE_IDS);
  assert.equal(ZAICODE_ACTION_CUE_DEFS.length, ZAICODE_ACTION_CUE_IDS.length);
  for (const cue of ZAICODE_ACTION_CUE_DEFS) {
    assert.ok(ids.has(cue.id), `${cue.id} is declared`);
    assert.ok(cue.label.length > 0 && cue.hint.length > 0, `${cue.id} is labelled for a human`);
  }
  for (const required of ["agent.reasoning.start", "agent.read", "agent.search", "agent.edit", "agent.create", "agent.shell", "agent.tool", "agent.plan", "agent.response.start", "agent.response.end", "agent.attention"]) {
    assert.ok(ids.has(required), `the wave asks for ${required}`);
  }
});

test("Wave 3 D: a new file spawns exactly once, and a re-read never again", () => {
  const before = [{ path: "a.ts", kind: "modified" as const }];
  const first = [{ path: "a.ts", kind: "modified" as const }, { path: "b.ts", kind: "added" as const }];
  assert.deepEqual(zaicodeSpawnedFiles(before, first), ["b.ts"]);
  // The same snapshot arriving again (a poll, a re-render, a resync).
  assert.deepEqual(zaicodeSpawnedFiles(first, first), []);
  // A file that grows from 1 line to 900 is still not new.
  assert.deepEqual(zaicodeSpawnedFiles(before, [{ path: "a.ts", kind: "modified" as const }]), []);
});

test("Wave 3 D: a rename or a move is not a spawn", () => {
  const before = [{ path: "old/name.ts", kind: "modified" as const }];
  const renamed = [{ path: "new/name.ts", kind: "renamed" as const }];
  assert.deepEqual(zaicodeSpawnedFiles(before, renamed), [], "a renamed path is the same file");
  // If a backend truly reports the move as an add, that IS a new identity.
  assert.deepEqual(zaicodeSpawnedFiles(before, [{ path: "new/name.ts", kind: "added" as const }]), ["new/name.ts"]);
  // A delete never spawns.
  assert.deepEqual(zaicodeSpawnedFiles(before, [{ path: "old/name.ts", kind: "deleted" as const }]), []);
});

test("Wave 3 D: the first reading of a scope never spawns a backlog", () => {
  const many = [{ path: "a.ts", kind: "added" as const }, { path: "b.ts", kind: "added" as const }];
  assert.deepEqual(zaicodeSpawnedFiles(null, many), [], "a new scope starts silent");
  assert.deepEqual(zaicodeSpawnedFiles([], many), ["a.ts", "b.ts"], "an empty previous reading is a real baseline");
});

test("Wave 3 D: a batch coalesces into one number with an exact count", () => {
  const floaters = zaicodeFloatersFor({ heal: 0, damage: 0, spawned: ["a.ts", "b.ts", "c.ts"] }, ZAICODE_FLOATER_DEFAULTS);
  const spawn = floaters.find((floater) => floater.kind === "spawn");
  assert.equal(floaters.length, 1, "a batch is one number, not three");
  assert.equal(spawn!.amount, 3);
  assert.equal(spawn!.text, "NEW 3");
  assert.equal(spawn!.files!.length, 3);
  // The label is the operator's.
  const renamed = zaicodeFloatersFor({ heal: 0, damage: 0, spawned: ["a.ts"] }, normalizeZaicodeFloaterPrefs({ spawnLabel: "FILE" }));
  assert.equal(renamed[0]!.text, "FILE 1");
  // ... and it can be switched off without touching heal or damage.
  const off = zaicodeFloatersFor({ heal: 4, damage: 0, spawned: ["a.ts"] }, normalizeZaicodeFloaterPrefs({ showSpawn: false }));
  assert.equal(off.length, 1);
  assert.equal(off[0]!.kind, "heal");
});

test("Wave 3 A: one undecodable sound does not take the pass down", async () => {
  const settings: ZaicodeSoundSettings = defaultZaicodeSoundSettings();
  settings.events["agent.done"] = { ...settings.events["agent.done"]!, sound: "fastprompter:ok.wav" };
  settings.events["agent.failed"] = { ...settings.events["agent.failed"]!, sound: "fastprompter:broken.wav" };
  const targets = collectZaicodeNormalizeTargets(settings);
  assert.ok(targets.some((target) => target.sound === "fastprompter:ok.wav"));

  const result = await runZaicodeNormalizePass(targets, {
    decode: async (sound) =>
      sound === "fastprompter:broken.wav"
        ? null
        : { samples: new Float32Array(4800).fill(0.5), sampleRate: 48000 },
  });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]!.sound, "fastprompter:broken.wav");
  assert.ok(result.inputs.length > 0, "the rest of the set was still measured");
});

test("Wave 3 A: the pass yields between files, so a big table cannot block the window", async () => {
  const settings = defaultZaicodeSoundSettings();
  const targets = Array.from({ length: 12 }, (_value, index) => ({ eventId: `e${index}`, sound: `s${index}.wav` }));
  let yields = 0;
  await runZaicodeNormalizePass(targets, {
    decode: async () => ({ samples: new Float32Array(480).fill(0.25), sampleRate: 48000 }),
    yieldTo: async () => {
      yields += 1;
    },
  });
  assert.equal(yields, targets.length, "one hand-back per file, not one at the end");
});

test("Wave 3 A: apply is one change per event, and undo leaves the operator's own choices alone", () => {
  const settings = defaultZaicodeSoundSettings();
  settings.events["agent.done"] = { ...settings.events["agent.done"]!, gainDb: -6, sound: "fastprompter:mine.wav" };
  const analysis = (db: number): ZaicodeSoundAnalysis => ({ loudnessDb: db, peakDb: db, measured: true, keptBlocks: 1, blocks: 1 });
  const plan = planZaicodeNormalization(
    [
      { id: "agent.done", analysis: analysis(-30) },
      { id: "agent.failed", analysis: analysis(-10) },
    ],
    { profile: "standard", attenuationCapDb: -24 },
  );
  const applied = applyZaicodeNormalization(plan, settings);
  const done = applied.events["agent.done"]!;
  assert.equal(done.sound, "fastprompter:mine.wav", "the operator's choice survives normalization");
  assert.equal(done.gainDb, -6, "so does the operator's own gain");
  assert.ok(done.normalizeDb > 0, "the compensation is separate and applied on top");
  assert.equal(applied.events["agent.failed"]!.normalizeDb < 0, true);

  const undone = undoZaicodeNormalization(applied);
  assert.equal(undone.events["agent.done"]!.normalizeDb, 0);
  assert.equal(undone.events["agent.done"]!.sound, "fastprompter:mine.wav");
  assert.equal(undone.events["agent.done"]!.gainDb, -6);
});

test("Wave 3 A: the settings screen really offers the controls the wave asks for", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "settings", "ZaicodeSoundNormalizePanel.tsx"), "utf8");
  for (const hook of [
    "data-zaicode-normalize-run", // the one action
    "data-zaicode-normalize-apply", // atomic apply
    "data-zaicode-normalize-undo", // undo that keeps the operator's own choices
    "data-zaicode-normalize-preview", // hear it BEFORE it is stored
  ]) {
    assert.ok(source.includes(hook), `the panel offers ${hook}`);
  }
  // The preview must play at the PROPOSED level, not the current one.
  assert.match(source, /gainDb: zaicodeEffectiveGainDb\(event\) \+ row\.gainDb/);
  // Profile and the negative cap are on the same panel, not buried.
  assert.match(source, /ZAICODE_NORMALIZE_ATTENUATION_CAP_MIN/);
  assert.match(source, /ZAICODE_NORMALIZE_ATTENUATION_CAP_MAX/);
  assert.match(source, /Before/);
  assert.match(source, /After/);
  // And it never writes a file: the only effect is a per-event dB.
  const model = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "zaicodeSoundAnalysis.ts"), "utf8");
  assert.doesNotMatch(model, /writeFile|createWriteStream|ffmpeg/);
});

test("Wave 3 B: the row really offers single and pool, with live shares", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "settings", "ZaicodeSoundPoolControls.tsx"), "utf8");
  // SRC-087: the two labelled buttons became one cell in the row that flips between the two modes.
  // T-127: the flip goes through the action that seeds a new pool with the current sound and keeps the heaviest one going back
  // (zaicodeSrc90PoolBuild.test.ts runs it); the row still offers both single and pool.
  assert.match(source, /setZaicodeSoundSelectionMode\(event\.id, pool \? "single" : "pool"\)/, "the row still offers both single and pool");
  // T-127 moved the member list, without its audio, into ZaicodePoolMembers so it renders on its own.
  const members = readFileSync(join(import.meta.dirname, "..", "src", "settings", "ZaicodePoolMembers.tsx"), "utf8");
  assert.match(members, /normalizeZaicodePool\(row\.pool\)/, "the shown shares come from the same normalizer the pick uses");
  assert.match(members, /share\.percent\.toFixed\(2\)\}/, "the effective probability is displayed, not the raw weight");
  assert.match(members, /missing/, "a file that cannot be found is marked");
  assert.match(members, /locked/, "an entry can be pinned against redistribution");
});

test("Wave 3 A: a table saved before Wave 3 still loads, with the new fields defaulted", () => {
  const legacy = { masterVolume: 60, events: { "agent.done": { enabled: true, sound: "fastprompter:x.wav", gainDb: -3, mode: "overlay" } } };
  const normalized = normalizeZaicodeSoundSettings(legacy);
  const row = normalized.events["agent.done"]!;
  assert.equal(row.normalizeDb, 0);
  assert.equal(row.soundMode, "single");
  assert.deepEqual(row.pool, []);
  assert.equal(row.gainDb, -3);
});
