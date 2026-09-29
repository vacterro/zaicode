import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ZAICODE_PROTRAIL_GLOBAL_OFF, type ZaicodeProtrailGlobalStatus } from "@zcode/shared";
import {
  runZaicodeProtrailGlobalConverge,
  zaicodeProtrailDesktopDraws,
  zaicodeProtrailGlobalConverged,
  zaicodeProtrailStatusLine,
  type ProtrailConvergePort,
} from "../src/zaicode/protrail/protrailGlobalConverge.js";

/**
 * T-129: "ProTrail is on at the start of the session, but I have to switch it off and on for it to work."
 * The window used to switch its own trail off the moment the desktop-wide mode was WANTED, and the
 * start-up loop stopped once the desktop said "running" with one overlay loaded. A desktop whose overlays
 * exist but do not draw therefore left ProTrail nowhere at all. The window now keeps drawing until every
 * monitor's overlay is confirmed by its own page, and the loop keeps asking until then.
 */

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8").replace(/\r\n/g, "\n");
const desktopSource = (path: string) => readFileSync(join(import.meta.dirname, "../../desktop/src", path), "utf8").replace(/\r\n/g, "\n");

const running = (patch: Partial<ZaicodeProtrailGlobalStatus> = {}): ZaicodeProtrailGlobalStatus => ({
  state: "running",
  input: "raw-input",
  displays: 3,
  verified: 3,
  monitors: 3,
  note: null,
  ...patch,
});

test("C1 the desktop draws only when every monitor's overlay is confirmed by its own page", () => {
  assert.equal(zaicodeProtrailDesktopDraws(running()), true);
  assert.equal(zaicodeProtrailDesktopDraws(running({ verified: 0 })), false, "loaded documents are not proof");
  assert.equal(zaicodeProtrailDesktopDraws(running({ verified: 2 })), false, "two monitors of three still leave one bare");
  assert.equal(zaicodeProtrailDesktopDraws(running({ displays: 2, verified: 2, monitors: 3 })), false, "an overlay that has not even loaded counts against it");
  assert.equal(zaicodeProtrailDesktopDraws({ ...running(), state: "starting" }), false);
  assert.equal(zaicodeProtrailDesktopDraws(ZAICODE_PROTRAIL_GLOBAL_OFF), false);
});

test("C2 a main process that does not check is taken at its word about loaded overlays, as before", () => {
  const legacy: ZaicodeProtrailGlobalStatus = { state: "running", input: "raw-input", displays: 3, note: null };
  assert.equal(zaicodeProtrailDesktopDraws(legacy), true);
  assert.equal(zaicodeProtrailDesktopDraws({ ...legacy, displays: 0 }), false);
});

test("C3 the start-up loop keeps asking while overlays are loaded but not confirmed, and stops when they are", async () => {
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const clock = {
    setTimeout(fn: () => void, ms = 0) {
      const id = ++seq;
      jobs.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: number) {
      jobs.delete(id);
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...jobs.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        jobs.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
  let calls = 0;
  const answers = [running({ verified: 0 }), running({ verified: 1 }), running({ verified: 3 })];
  const port: ProtrailConvergePort = {
    set: async () => answers[Math.min(calls++, answers.length - 1)]!,
    status: async () => running(),
  };
  runZaicodeProtrailGlobalConverge(port, {
    wanted: true,
    config: { color: "red" },
    onStatus: () => {},
    onRecovered: () => {},
    onUnavailable: () => {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  await clock.advance(60_000);
  assert.equal(calls, 3, "asked until the third answer confirmed every monitor, then not again");
  assert.equal(zaicodeProtrailGlobalConverged(answers[2]!, true), true);
  assert.equal(zaicodeProtrailGlobalConverged(answers[0]!, true), false);
});

test("C4 Settings says what is confirmed, not what is loaded", () => {
  assert.match(zaicodeProtrailStatusLine(running()), /^Drawing over 3 monitors, reading moves and clicks \(Raw Input\)\.$/);
  const checking = zaicodeProtrailStatusLine(running({ verified: 1 }));
  assert.match(checking, /Checking the overlays: 1 of 3 confirmed/);
  assert.match(checking, /drawn in this window meanwhile/, "and says where the trail is drawn meanwhile");
  assert.match(zaicodeProtrailStatusLine({ ...running(), state: "starting", displays: 0, verified: 0 }), /^Starting over 3 monitors…/);
  assert.match(zaicodeProtrailStatusLine(ZAICODE_PROTRAIL_GLOBAL_OFF), /Not drawing outside ZAICODE/);
  assert.match(zaicodeProtrailStatusLine({ ...running({ input: "cursor-poll" }) }), /the cursor only \(no clicks\)/);
});

test("C5 the window's own canvas idles only while the desktop is CONFIRMED, never merely wanted", () => {
  const sync = source("zaicode/protrail/zaicodeProtrailGlobal.ts");
  assert.match(sync, /return active && zaicodeProtrailDesktopDraws\(current\);/);
  assert.doesNotMatch(sync, /\n {2}return active;\n/, "the hook no longer answers with what is wanted");
  const overlay = source("zaicode/protrail/ZaicodeProtrailOverlay.tsx");
  assert.match(overlay, /const local = running && !global;/, "the window draws whenever the desktop is not confirmed");
});

test("C6 every overlay page answers the health probe with what it holds and whether it makes frames", () => {
  const page = desktopSource("renderer/src/zaicode-protrail.ts");
  assert.match(page, /window\.__zaicodeProtrailProbe = \(\) =>/);
  assert.match(page, /configured: runtime\.configured\(\)/);
  assert.match(page, /enabled: runtime\.active\(\)/);
  assert.match(page, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*?answer\(true\);/, "frames:true only if a frame callback really ran");
  assert.match(source("zaicode/protrail/protrailRuntime.ts"), /configured\(\): boolean \{\s+return this\.config !== null;/);
});
