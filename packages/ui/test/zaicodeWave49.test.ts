import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_HIGHLIGHT_DEFAULTS,
  ZAICODE_WORKING_ICON_DEFAULTS,
  normalizeZaicodeLights,
  normalizeZaicodeWorkingIcon,
  withZaicodeHighlight,
  zaicodeHighlightAttrs,
  zaicodeWorkingIconStyle,
} from "../src/zaicode/zaicodeHighlights.js";
import { ZAICODE_MOTION_CSS } from "../src/zaicode/zaicodeMotionCss.js";
import { dragZaicodeSoundTabs, nextZaicodeSoundTabs, zaicodeSoundInTabs } from "../src/zaicode/zaicodeSoundTabs.js";
import {
  ZAICODE_SOUND_DEDUPE_MS,
  ZAICODE_SOUND_ECHO_MS,
  admitZaicodeSound,
  createZaicodeSoundMemory,
} from "../src/zaicode/zaicodeSoundBus.js";
import { zaicodeSnapOffset } from "../src/zaicode/zaicodePixelSnap.js";
import { ZAICODE_COMPOSER_DEFAULT_PREFS, normalizeZaicodeComposerPrefs } from "../src/zaicode/zaicodeComposerPrefs.js";
import {
  ZAICODE_POOL_CONTEXT_WINDOW,
  ZAICODE_POOL_MAX_OUTPUT,
  zaicodePoolModelConfig,
  zaicodePoolNeedsRaise,
} from "../src/zaicode/zaicodeRouterSetup.js";
import { normalizeZaicodeSidebarPrefs } from "../src/zaicode/zaicodeSidebarPrefs.js";
import { clampZaicodeWindowRect } from "../src/zaicode/zaicodeWorkerLayout.js";

type Style = Record<string, unknown>;

test("highlights: off gives nothing; an effect animates its channel; steady does not move", () => {
  const off = { ...ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking, enabled: false };
  assert.equal(zaicodeHighlightAttrs("sessionWorking", off), null);

  const pulse = zaicodeHighlightAttrs("sessionWorking", { ...off, enabled: true, effects: ["pulse"], seconds: 1.5 });
  assert.ok(pulse);
  assert.equal(pulse["data-zh"], "sessionWorking");
  assert.match(String((pulse.style as Style)["--zh-anim"]), /^zh-pulse 1\.5s ease-in-out infinite$/);
  assert.equal(pulse["data-zh-keep"], "", "keep moving is on by default");

  const steady = zaicodeHighlightAttrs("sessionWorking", { ...off, enabled: true, effects: ["steady"] });
  assert.ok(steady);
  assert.equal((steady.style as Style)["--zh-anim"], undefined);
  assert.equal(steady["data-zh-keep"], undefined, "nothing to keep moving");
});

test("highlights: colours -- theme, state (with a runtime override), own, rainbow adds a hue walk", () => {
  const base = { ...ZAICODE_HIGHLIGHT_DEFAULTS.sessionWaiting, enabled: true, effects: ["steady" as const] };
  assert.equal((zaicodeHighlightAttrs("sessionWaiting", { ...base, color: "state" })!.style as Style)["--zh-color"], "#e0a040");
  assert.equal((zaicodeHighlightAttrs("sessionWaiting", { ...base, color: "state" }, "#ff0000")!.style as Style)["--zh-color"], "#ff0000");
  assert.equal((zaicodeHighlightAttrs("sessionWaiting", { ...base, color: "custom", custom: "#123456" })!.style as Style)["--zh-color"], "#123456");
  const rainbow = zaicodeHighlightAttrs("sessionWaiting", { ...base, color: "rainbow" })!;
  assert.match(String((rainbow.style as Style)["--zh-anim"]), /zh-hue/);
  assert.equal(rainbow["data-zh-keep"], "");
});

test("highlights merge into an element's own class, title and style", () => {
  const lights = zaicodeHighlightAttrs("projectWorking", { ...ZAICODE_HIGHLIGHT_DEFAULTS.projectWorking, enabled: true, shapes: ["box" as const] });
  const merged = withZaicodeHighlight({ className: "x", title: "t", style: { color: "red" } }, lights) as Record<string, unknown>;
  assert.equal(merged.className, "x");
  assert.equal(merged.title, "t");
  assert.equal((merged.style as Style).color, "red");
  assert.equal(merged["data-zh-shape"], "box");
  assert.deepEqual(withZaicodeHighlight({ className: "y" }, null), { className: "y" });
});

test("lights normalize: bad values fall back or clamp; an own picture that is missing falls back to the mark", () => {
  const lights = normalizeZaicodeLights({
    highlights: { sessionWorking: { effect: "disco", strength: 900, seconds: -3, shape: "glow", custom: "red" } },
    working: { image: "custom", customImage: null, seconds: 99, steps: 1, motion: "swing" },
  });
  const rule = lights.highlights.sessionWorking;
  assert.deepEqual(rule.effects, ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking.effects);
  assert.equal(rule.strength, 100);
  assert.equal(rule.seconds, 0.1);
  assert.deepEqual(rule.shapes, ["glow"], "a pre-SRC-043 single shape is read as a one-item mix");
  assert.equal(rule.custom, ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking.custom);
  assert.deepEqual(lights.working.images, ["saipen"]);
  assert.equal(lights.working.seconds, 20);
  assert.equal(lights.working.steps, 2);
  assert.deepEqual(lights.working.motions, ["swing"]);
  assert.equal(Object.keys(lights.highlights).length, Object.keys(ZAICODE_HIGHLIGHT_DEFAULTS).length);
});

test("working icon: direction, ticks, still, keep-moving marker and size", () => {
  const cw = zaicodeWorkingIconStyle(ZAICODE_WORKING_ICON_DEFAULTS) as Style;
  assert.equal(cw["--zw-anim"], "zw-spin 2.4s linear infinite normal");
  const ccw = zaicodeWorkingIconStyle({ ...ZAICODE_WORKING_ICON_DEFAULTS, direction: "ccw", easing: "steps", steps: 12 }) as Style;
  assert.equal(ccw["--zw-anim"], "zw-spin 2.4s steps(var(--zw-steps), end) infinite reverse");
  assert.equal(ccw["--zw-steps"], "12");
  const still = zaicodeWorkingIconStyle({ ...ZAICODE_WORKING_ICON_DEFAULTS, motions: ["none" as const] }) as Style;
  assert.equal(still.animation, "none");
  const swing = zaicodeWorkingIconStyle({ ...ZAICODE_WORKING_ICON_DEFAULTS, motions: ["swing" as const], amplitude: 50, size: 150 }) as Style;
  assert.equal(swing["--zw-deg"], "90deg");
  assert.equal(swing.scale, "1.5");
  assert.equal(normalizeZaicodeWorkingIcon({ keepMoving: false }).keepMoving, false);
});

test("motion CSS: the calm interface keeps only marked things moving; crisp mode cannot erase a highlight", () => {
  assert.match(ZAICODE_MOTION_CSS, /html\.zaicode-no-motion \[data-zaicode-working-icon\]\[data-zw-keep\] \{\s*animation: var\(--zw-anim\) !important;/);
  assert.match(ZAICODE_MOTION_CSS, /html\.zaicode-no-motion \[data-zh-keep\]\[data-zh\] \{\s*animation: var\(--zh-anim\) !important;/);
  // html.zaicode-crisp * { box-shadow/text-shadow: none !important } is (0,1,1); shapes use (0,2,1).
  assert.match(ZAICODE_MOTION_CSS, /html \[data-zh\]\[data-zh-shape~="glow"\] \{\s*text-shadow:[^}]*!important/);
  assert.match(ZAICODE_MOTION_CSS, /@property --zh-k/);
  assert.match(ZAICODE_MOTION_CSS, /--radix-popover-content-available-height/);
});

test("sound picker tabs: click picks one, Shift/Ctrl adds and removes, drag collects, All resets", () => {
  assert.deepEqual(nextZaicodeSoundTabs(["click"], "alert", false), ["alert"]);
  assert.deepEqual(nextZaicodeSoundTabs(["click"], "alert", true), ["click", "alert"]);
  assert.deepEqual(nextZaicodeSoundTabs(["click", "alert"], "alert", true), ["click"]);
  assert.deepEqual(nextZaicodeSoundTabs(["click"], "click", true), ["all"], "removing the last one shows everything");
  assert.deepEqual(nextZaicodeSoundTabs(["all"], "voice", true), ["voice"]);
  assert.deepEqual(nextZaicodeSoundTabs(["click", "voice"], "all", true), ["all"]);
  assert.deepEqual(dragZaicodeSoundTabs(["click"], "jingle"), ["click", "jingle"]);
  assert.deepEqual(dragZaicodeSoundTabs(["click", "jingle"], "jingle"), ["click", "jingle"], "a drag never removes");
  const favorites = new Set(["fav"]);
  assert.equal(zaicodeSoundInTabs({ id: "a", kind: "alert" }, ["click", "alert"], favorites), true);
  assert.equal(zaicodeSoundInTabs({ id: "v", kind: "voice" }, ["click", "alert"], favorites), false);
  assert.equal(zaicodeSoundInTabs({ id: "fav", kind: "voice" }, ["favorites"], favorites), true);
  assert.equal(zaicodeSoundInTabs({ id: "v", kind: "voice" }, ["all"], favorites), true);
});

test("sounds: New task in another project plays one sound, not New task + Switch project", () => {
  const memory = createZaicodeSoundMemory();
  assert.equal(admitZaicodeSound("session.new", false, 1000, memory), true);
  assert.equal(admitZaicodeSound("sidebar.project", true, 1000 + 40, memory), false, "the echo of that action is silent");
  assert.equal(admitZaicodeSound("sidebar.project", true, 1000 + ZAICODE_SOUND_ECHO_MS + 10, memory), true, "a later switch alone plays");
  assert.equal(admitZaicodeSound("session.open", false, 5000, memory), true);
  assert.equal(admitZaicodeSound("session.open", false, 5000 + ZAICODE_SOUND_DEDUPE_MS - 1, memory), false, "one event twice at once is one sound");
  assert.equal(admitZaicodeSound("session.open", false, 5000 + ZAICODE_SOUND_DEDUPE_MS + 1, memory), true);
});

test("pixel snap: a column on a half pixel moves to a whole one; repeated calls converge", () => {
  assert.equal(zaicodeSnapOffset(300.5, 0, 1), 0.5, "Math.round(300.5) = 301");
  assert.equal(zaicodeSnapOffset(300, 0, 1), 0);
  assert.equal(zaicodeSnapOffset(300.25, 0, 1), -0.25);
  // After applying -0.25 the element measures at 300.0; the offset stays -0.25 (no drift).
  assert.equal(zaicodeSnapOffset(300, -0.25, 1), -0.25);
  // 125 % display scale: 241.2 css px = 301.5 device px -> +0.4 css px makes it 302 device px.
  assert.equal(zaicodeSnapOffset(241.2, 0, 1.25), 0.4);
  assert.equal(zaicodeSnapOffset(10.004, 0, 1), 0, "below 1/64 px is left alone");
});

test("message box: compact off by default, every part on, unknown values ignored", () => {
  const prefs = normalizeZaicodeComposerPrefs({ compact: true, showModes: false, bogus: 1, showNext: "yes" });
  assert.equal(prefs.compact, true);
  assert.equal(prefs.showModes, false);
  assert.equal(prefs.showNext, true);
  assert.equal("bogus" in prefs, false);
  assert.equal(normalizeZaicodeComposerPrefs(null).compact, ZAICODE_COMPOSER_DEFAULT_PREFS.compact);
});

test("SAIROUTE pools: 1M context and 131k output; only ZAICODE's old 128k is raised", () => {
  const config = zaicodePoolModelConfig();
  assert.equal(config.properties.contextWindow, 1_000_000);
  assert.equal(config.optionSpecs.maxOutputTokens.max, 131_072);
  assert.equal(ZAICODE_POOL_CONTEXT_WINDOW, 1_000_000);
  assert.equal(ZAICODE_POOL_MAX_OUTPUT, 131_072);
  assert.equal(zaicodePoolNeedsRaise({ properties: { contextWindow: 128_000 } }), true);
  assert.equal(zaicodePoolNeedsRaise({ properties: { contextWindow: 200_000 } }), false, "the operator's own value stays");
  assert.equal(zaicodePoolNeedsRaise({}), false);
});

test("title position: projects and sessions keep their own alignment, bad values fall back to left", () => {
  const prefs = normalizeZaicodeSidebarPrefs({ projectTitleAlign: "center", sessionTitleAlign: "diagonal" });
  assert.equal(prefs.projectTitleAlign, "center");
  assert.equal(prefs.sessionTitleAlign, "left");
});

test("worker windows land on whole pixels after a drag on a scaled display", () => {
  const rect = clampZaicodeWindowRect({ x: 100.4, y: 50.6, width: 640.5, height: 400.2 }, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(rect, { x: 100, y: 51, width: 641, height: 400 });
});
