import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ZAICODE_SOUND_ECHO_MS,
  ZAICODE_SOUND_NAV_ECHO_MS,
  admitZaicodeSound,
  createZaicodeSoundMemory,
  zaicodeNavigationEcho,
} from "../src/zaicode/zaicodeSoundBus.js";
import { isZaicodeChokeGroup } from "../src/zaicode/zaicodeSoundVoices.js";

// SRC-062: "look through the conditions of every sound, with animations on
// and off: some sounds pile on each other, very noticeable in the sidebar
// when moving between projects".

test("one navigation is one sound: the session a project switch lands on stays silent", () => {
  const t = 10_000;
  assert.equal(zaicodeNavigationEcho({ workspaceChanged: true, taskChanged: true }, t, Number.NEGATIVE_INFINITY), "sidebar.project");
  // The next render reports the session of that same move.
  assert.equal(zaicodeNavigationEcho({ workspaceChanged: false, taskChanged: true }, t + 900, t), null);
  // A later, separate session switch speaks again.
  assert.equal(
    zaicodeNavigationEcho({ workspaceChanged: false, taskChanged: true }, t + ZAICODE_SOUND_NAV_ECHO_MS + 1, t),
    "session.open",
  );
  assert.equal(zaicodeNavigationEcho({ workspaceChanged: false, taskChanged: false }, t, t), null);
});

test("a slow session load stays inside the click's navigation echo window", () => {
  const memory = createZaicodeSoundMemory();
  assert.equal(admitZaicodeSound("ui.expand", false, 1000, memory), true);
  // 1.1 s later (a cold session opened): with the old 700 ms window this echo played as a second sound.
  assert.equal(admitZaicodeSound("session.open", true, 2100, memory), true, "the default window lets it through");
  const fresh = createZaicodeSoundMemory();
  admitZaicodeSound("ui.expand", false, 1000, fresh);
  assert.equal(admitZaicodeSound("session.open", true, 2100, fresh, ZAICODE_SOUND_NAV_ECHO_MS), false);
  assert.ok(ZAICODE_SOUND_NAV_ECHO_MS > ZAICODE_SOUND_ECHO_MS);
});

test("interface sounds choke each other; agent, engine and mail sounds always mix", () => {
  // The event table and its normalizer moved to the asset-free model in Wave 3.
  const model = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "zaicodeSoundSettingsModel.ts"), "utf8");
  const engine = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "zaicodeSoundEvents.ts"), "utf8");
  const groupOf = new Map([...model.matchAll(/\{ id: "([a-zA-Z.]+)", group: "([A-Za-z &]+)"/g)].map((match) => [match[1]!, match[2]!]));
  const chokes = (id: string) => isZaicodeChokeGroup(groupOf.get(id) ?? "?");
  for (const id of ["ui.button", "ui.expand", "ui.menuItem", "sidebar.project", "session.open", "session.new", "window.picker"]) {
    assert.equal(chokes(id), true, id);
  }
  for (const id of ["agent.done", "changes.heal", "worker.exit", "saimail.new", "limits.refill"]) {
    assert.equal(chokes(id), false, id);
  }
  assert.match(model, /interfaceOneAtATime: record\.interfaceOneAtATime !== false/, "on unless switched off");
  assert.match(model, /whenFocused: true,\s+interfaceOneAtATime: true/, "on by default");
  // The choked sound fades over a few ms instead of clicking off.
  assert.match(engine, /linearRampToValueAtTime\(0, ctx\.currentTime \+ CHOKE_FADE_S\)/);
  // The overlap rule (zaicodeSoundOverlap.test.ts) applies it: in "mix" an interface sound cuts the other interface sounds.
  assert.match(engine, /const request = \{ key: id, interface: isZaicodeInterfaceSound\(id\), replaceOwn: row\.mode === "replace" \};/);
  assert.match(engine, /interfaceOneAtATime: settings\.interfaceOneAtATime \}/);
});

test("the project row that opens MAIN speaks with its own voice, not the orchestra's 'expand'", () => {
  const row = readFileSync(join(import.meta.dirname, "..", "src", "WorkspaceSidebarItem.tsx"), "utf8");
  assert.match(row, /playZaicodeSound\("sidebar\.project"\);\s*onSelectTask\(tab\.workspacePath, decision\.sessionId/);
});
