import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..", "src");
const source = readFileSync(join(root, "zaicode", "zaicodeSoundEvents.ts"), "utf8");

test("every default event sound ships in the FastPrompter library", () => {
  const files = [...source.matchAll(/fp\("([^"]+)"\)/g)].map((match) => match[1]!);
  assert.ok(files.length >= 35, `expected many defaults, got ${files.length}`);
  const missing = files.filter((file) => !existsSync(join(root, "assets", "fastprompter-sounds", file)));
  assert.deepEqual(missing, []);
});

test("sound event ids are unique and every group is known", () => {
  const ids = [...source.matchAll(/\{ id: "([^"]+)", group: "([^"]+)"/g)];
  const unique = new Set(ids.map((match) => match[1]));
  assert.equal(unique.size, ids.length);
  const groups = new Set(["Agent", "Sessions", "Composer", "Sidebar", "Window", "Engines", "SAIMAIL", "Interface"]);
  for (const match of ids) assert.ok(groups.has(match[2]!), `unknown group ${match[2]}`);
  // Every former cue keeps a row, so migrated settings land somewhere.
  for (const cue of ["done", "failed", "question", "human", "update", "started"]) assert.ok(unique.has(`agent.${cue}`));
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "assets" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("every Sounds-table row has a place that plays it", () => {
  const texts = sourceFiles(root).map((file) => readFileSync(file, "utf8"));
  const everything = texts.join("\n");
  // A row is live when its id appears somewhere besides its own definition line.
  const uses = (id: string) => everything.split(`"${id}"`).length - 1;
  const missing = (id: string) =>
    id.startsWith("agent.") ? !everything.includes("playZaicodeSoundAsync(`agent.${event}`") : uses(id) < 2;
  const ids = [...source.matchAll(/\{ id: "([^"]+)", group:/g)].map((match) => match[1]!);
  assert.deepEqual(ids.filter(missing), []);
  // The instrument itself: an id nobody plays is reported.
  assert.equal(missing("session.never-played"), true);
});
