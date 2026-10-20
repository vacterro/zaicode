import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  describeZaicodeEffortSwitchPhase,
  zaicodeEffortSwitchPhase,
  zaicodeEffortSwitchPlan,
  zaicodeLiveSwitchAckIsCurrent,
} from "../src/zaicode/zaicodeLiveConfigSwitch.js";

/**
 * T-396 (SRC-298 Wave 2): changing Effort during an active task must reach the runtime.
 *
 * Before this ticket `handleSelectThought` only rewrote the composer draft
 * (`SessionPane.tsx:3851`), so an operator who picked a higher effort on a running
 * session saw the picker change while every request kept the old level until they
 * happened to send another message. The session's selection is runtime state; a live
 * change is a `switchModelConfig` command, and its result is only true once the
 * runtime projection says so -- not when the ACK comes back.
 */

const SOURCE = (path: string) =>
  readFileSync(join(import.meta.dirname, "..", "src", path), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["low", "medium", "high"] as const;

test("T-396: a thought change on a bound session dispatches switchModelConfig", () => {
  const src = SOURCE("v4/SessionPane.tsx");
  const handler = src.slice(
    src.indexOf("const handleSelectThought = useCallback("),
    src.indexOf("const handleRecoverCustomModelSelection"),
  );
  assert.ok(handler.includes('dispatchConfigCas("switchModelConfig"'), "the Effort picker must send the config command for a bound session");
  assert.ok(
    /configCommandBarrier\s*\.enqueue/.test(handler),
    "the command must ride the same barrier as sendText, so a send cannot overtake it",
  );
  assert.match(
    handler,
    /thought:\s*(?:thought|plan\.thought)/,
    "the command carries the picked level in its thought field",
  );
});

test("T-396: draft-only before a session exists, command once it does", () => {
  const live = { liveProvider: "router", liveModel: "SAIFREN" };
  assert.deepEqual(
    zaicodeEffortSwitchPlan({
      sessionId: null,
      readOnly: false,
      thought: "high",
      ...live,
      pinnedThought: "low",
      supportedThoughtLevels: LEVELS,
    }),
    { kind: "draft", thought: "high" },
    "an unbound composer has nothing to switch: the first send carries the choice",
  );
  assert.deepEqual(
    zaicodeEffortSwitchPlan({
      sessionId: "s-1",
      readOnly: true,
      thought: "high",
      ...live,
      pinnedThought: "low",
      supportedThoughtLevels: LEVELS,
    }),
    { kind: "draft", thought: "high" },
    "a read-only pane never mutates the session",
  );
  assert.deepEqual(
    zaicodeEffortSwitchPlan({
      sessionId: "s-1",
      readOnly: false,
      thought: "high",
      ...live,
      pinnedThought: "low",
      supportedThoughtLevels: LEVELS,
    }),
    { kind: "dispatch", thought: "high" },
  );
  assert.deepEqual(
    zaicodeEffortSwitchPlan({
      sessionId: "s-1",
      readOnly: false,
      thought: "high",
      liveProvider: null,
      liveModel: null,
      pinnedThought: "low",
      supportedThoughtLevels: LEVELS,
    }),
    { kind: "draft", thought: "high" },
    "no projection yet means no authoritative provider/model to switch",
  );
});

test("T-396: no command for the level the session already pins", () => {
  assert.deepEqual(
    zaicodeEffortSwitchPlan({
      sessionId: "s-1",
      readOnly: false,
      thought: " high ",
      liveProvider: "router",
      liveModel: "SAIFREN",
      pinnedThought: "high",
      supportedThoughtLevels: LEVELS,
    }),
    { kind: "draft", thought: "high" },
    "the handler would answer config.unchanged; sending it would only churn revisions",
  );
});

test("T-396: a level the model does not offer is refused before any CAS", () => {
  assert.deepEqual(
    zaicodeEffortSwitchPlan({
      sessionId: "s-1",
      readOnly: false,
      thought: "max",
      liveProvider: "router",
      liveModel: "SAIFREN",
      pinnedThought: "low",
      supportedThoughtLevels: LEVELS,
    }),
    { kind: "unsupported", thought: "max" },
    "spending the command only to learn what the projection already states is wrong",
  );
});

test("T-396: the strip reports runtime truth, not the ACK", () => {
  const base = { requested: "high", unsupported: false, error: null, effectiveThought: "low" };
  assert.equal(
    zaicodeEffortSwitchPhase({ ...base, acknowledged: false }),
    "REQUESTED",
  );
  assert.equal(
    zaicodeEffortSwitchPhase({ ...base, acknowledged: true }),
    "APPLYING",
    "an accepted command that the projection has not applied yet is not APPLIED",
  );
  assert.equal(
    zaicodeEffortSwitchPhase({ ...base, acknowledged: true, effectiveThought: "high" }),
    "APPLIED",
    "only the runtime's effective level proves the switch",
  );
  assert.equal(
    zaicodeEffortSwitchPhase({ ...base, acknowledged: true, error: "provider.notInRegistry" }),
    "REJECTED",
  );
  assert.equal(
    zaicodeEffortSwitchPhase({ ...base, acknowledged: false, unsupported: true }),
    "UNSUPPORTED",
  );
  assert.equal(
    zaicodeEffortSwitchPhase({ ...base, requested: null, acknowledged: true }),
    null,
    "no outstanding request means no strip",
  );
});

test("T-396: a stale ACK cannot overwrite a newer request", () => {
  assert.equal(zaicodeLiveSwitchAckIsCurrent(3, 3), true);
  assert.equal(zaicodeLiveSwitchAckIsCurrent(2, 3), false, "the older request's ACK is dropped");
});

test("T-396: the strip renders the runtime's effective level, not the request", () => {
  const src = SOURCE("v4/SessionPane.tsx");
  const strip = src.slice(
    src.indexOf('data-zaicode-live-effort={phase.toLowerCase()}'),
    src.indexOf("data-zaicode-live-effort-effective"),
  );
  assert.ok(strip.length > 0, "the strip must carry a phase attribute for the operator and the tests");
  const block = src.slice(
    src.indexOf("const phase = zaicodeEffortSwitchPhase({"),
    src.indexOf('data-zaicode-live-effort={phase.toLowerCase()}'),
  );
  assert.match(
    block,
    /effectiveThought:\s*snapshot\.config\.thought/,
    "APPLIED can only be claimed from the runtime projection's effective thought",
  );
  // The provider/model that the command names must come from THIS session's projection:
  // an unbound or stale snapshot would otherwise send another session's model identity.
  const handler = src.slice(
    src.indexOf("const handleSelectThought = useCallback("),
    src.indexOf("const handleRecoverCustomModelSelection"),
  );
  assert.match(
    handler,
    /projected\?\.sessionId === sessionId \? projected\.config : undefined/,
    "the switch reads only the matching session's config",
  );
});

test("T-396: a pick right after a model switch targets the model just picked", () => {
  const src = SOURCE("v4/SessionPane.tsx");
  const handler = src.slice(
    src.indexOf("const handleSelectThought = useCallback("),
    src.indexOf("const handleRecoverCustomModelSelection"),
  );
  // The projection has not caught up with the model switch yet. Naming the old model in
  // the thought command would revert the switch the operator just made.
  assert.match(
    handler,
    /const pendingModel\s*=\s*liveModelSwitchTargetRef\.current\?\.sessionId === sessionId/,
    "an in-flight model switch outranks the projection",
  );
  assert.match(
    handler,
    /const targetProvider = pendingModel\?\.provider \?\? projectedConfig\?\.provider/,
    "the command names the pending model when one exists",
  );
  assert.match(
    handler,
    /const applied = await pendingModel\.settled;/,
    "the thought command waits for that switch's ACK before choosing its target",
  );
  assert.match(
    handler,
    /if \(!applied\)/,
    "a rejected model switch must not be resurrected by the thought command",
  );
});

test("T-396: a late model-switch ACK cannot repaint a newer switch's strip", () => {
  const src = SOURCE("v4/SessionPane.tsx");
  const modelSwitch = src.slice(
    src.indexOf("const switchFlight = dispatchConfigCas"),
    src.indexOf("const handleSelectThought = useCallback("),
  );
  assert.match(
    modelSwitch,
    /zaicodeLiveSwitchAckIsCurrent\(switchSeq, liveModelSwitchSeqRef\.current\)/,
    "the model strip needs the same stale-ACK guard the effort strip has",
  );
  assert.match(
    modelSwitch,
    /current\.provider === resolvedProvider &&\s*current\.model === model/,
    "only the switch that still owns the pending target may clear it",
  );
  assert.match(
    modelSwitch,
    /switchSeq === liveModelSwitchSeqRef\.current/,
    "the same model picked twice is still two switches: only the newest may clear the target",
  );
});

test("T-396: a strip from another session never renders over the current one", () => {
  const src = SOURCE("v4/SessionPane.tsx");
  assert.match(
    src,
    /liveEffortSwitch\.sessionId === sessionId\s*\n?\s*\?\s*\(\(\) => \{/,
    "the strip is bound to the session whose request it describes",
  );
  assert.match(
    src,
    /setLiveEffortSwitch\(\{\s*\n\s*sessionId,\s*\n\s*requested:\s*plan\.thought/,
    "a dispatched request records its owning session",
  );
  assert.match(
    src,
    /if \(liveModelSwitchTargetRef\.current\?\.sessionId !== sessionId\) \{\s*\n\s*liveModelSwitchTargetRef\.current = null;/,
    "a pending model target dies with its session",
  );
});

test("T-396: the strip says where a deferred switch applies", () => {
  assert.match(
    describeZaicodeEffortSwitchPhase("APPLYING", {
      requested: "high",
      effectiveThought: "low",
      executing: true,
    }),
    /next request; in-flight keeps low/,
    "an in-flight request keeps its level; the new one applies at the next boundary",
  );
  assert.match(
    describeZaicodeEffortSwitchPhase("REJECTED", {
      requested: "high",
      effectiveThought: "low",
      executing: false,
      error: "config.unchanged",
    }),
    /config\.unchanged/,
  );
});
