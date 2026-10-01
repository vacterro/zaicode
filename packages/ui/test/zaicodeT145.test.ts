import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { HelpTopic } from "../src/settings/zaicodeHelpContent.js";
import {
  ZAICODE_HELP_CURRICULUM,
  resolveZaicodeHelpChapters,
  zaicodeHelpOrderedTopics,
} from "../src/settings/zaicodeHelpOrder.js";
import {
  describeZaicodeSaipenReadError,
  isZaicodeSaipenMissingFileError,
} from "../src/zaicode/zaicodeSaipenModel.js";

const SRC = join(import.meta.dirname, "../src");

function readSource(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), "utf-8");
}

const TOPIC_FILES = ["settings/zaicodeHelpTopicsCore.ts", "settings/zaicodeHelpTopicsAdvanced.ts"];

function idsIn(relativePath: string): string[] {
  return [...readSource(relativePath).matchAll(/^ {4}id: "([a-z0-9]+)",$/gm)].map((m) => m[1]!);
}

/** The topic ids as declared, read from the source: loading the content module
 *  here would pull the whole component tree (and its .mp3/.svg assets) into a test.
 *  The order is the one zaicodeHelpContent.ts concatenates them in. */
function declaredTopicIds(): string[] {
  return [...idsIn(TOPIC_FILES[0]), ...idsIn(TOPIC_FILES[1])];
}

const CHAPTERS = resolveZaicodeHelpChapters(
  declaredTopicIds().map((id) => ({ id, title: id, what: "", lines: [] }) as HelpTopic),
);
const ORDERED = zaicodeHelpOrderedTopics(CHAPTERS);

test("SRC-114 help: a newcomer meets the basics first, not the game", () => {
  const ids = ORDERED.map((topic) => topic.id);
  assert.equal(ids[0], "start", "the first card must be 'Start here'");
  assert.equal(ids.at(-1), "saipeggle", "the pixel game is a reward, not a foundation");
  assert.ok(
    ids.indexOf("composer") < ids.indexOf("saipeggle"),
    "the composer is explained long before the game",
  );
});

test("SRC-114 help: every topic is filed exactly once", () => {
  const ordered = ORDERED.map((topic) => topic.id);
  const declared = declaredTopicIds();
  assert.equal(new Set(ordered).size, ordered.length, "no topic appears twice");
  assert.deepEqual(new Set(ordered), new Set(declared), "no topic is lost by the ordering");
  assert.equal(ordered.length, declared.length, "and none is invented");
});

test("SRC-114 help: chapters are contiguous and none is empty", () => {
  assert.equal(CHAPTERS.length, ZAICODE_HELP_CURRICULUM.length, "no card is left unfilled");
  for (const chapter of CHAPTERS) {
    assert.ok(chapter.topics.length > 0, `${chapter.title} is empty`);
    assert.ok(chapter.what.length > 0, `${chapter.title} does not say what it covers`);
  }
  // The chapters render top to bottom exactly as the flat list reads.
  const flat = CHAPTERS.flatMap((chapter) => chapter.topics.map((topic) => topic.id));
  assert.deepEqual(flat, ORDERED.map((topic) => topic.id));
});

test("SRC-114 help: a topic nobody filed is kept, in a chapter that says so", () => {
  const withStray = resolveZaicodeHelpChapters([
    ...declaredTopicIds().map((id) => ({ id, title: id, what: "", lines: [] }) as HelpTopic),
    { id: "brand-new-surface", title: "Brand new", what: "", lines: [] } as HelpTopic,
  ]);
  const last = withStray.at(-1)!;
  assert.deepEqual(
    last.topics.map((topic) => topic.id),
    ["brand-new-surface"],
    "a new card must never disappear because nobody filed it",
  );
  assert.match(last.title, /Not filed yet/);
});

test("SRC-114 help: a filtered search is a subsequence, not a reshuffle", () => {
  const order = ORDERED.map((topic) => topic.id);
  const hits = order.filter((id) => /meter|timer/.test(id));
  assert.ok(hits.length > 0, "the fixture must find something");
  const positions = hits.map((id) => order.indexOf(id));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("SRC-114 reporting: bug and feature requests land in the project's own repository", () => {
  // Read from the source: zaicodeBrand.ts imports the logo PNG, and a test runner
  // has no loader for it.
  const brand = readSource("zaicode/zaicodeBrand.ts");
  assert.match(brand, /ZAICODE_REPO_URL = "https:\/\/github\.com\/vacterro\/zaicode"/);
  assert.match(brand, /ZAICODE_ISSUE_URL = `\$\{ZAICODE_REPO_URL\}\/issues\/new\?labels=bug&template=bug_report\.yml`/);
  assert.match(
    brand,
    /ZAICODE_FEATURE_URL = `\$\{ZAICODE_REPO_URL\}\/issues\/new\?labels=enhancement&template=feature_request\.yml`/,
  );
  assert.doesNotMatch(brand, /zcode\.z\.ai/, "no vendor route may survive in the brand module");
});

test("SRC-114 help menu: no help route leads to the vendor documentation site", () => {
  for (const file of ["lib/helpMenuActions.ts", "WorkspaceHelpMenuButton.tsx"]) {
    assert.doesNotMatch(
      readSource(file),
      /zcode\.z\.ai/,
      `${file} still sends help to the vendor site`,
    );
  }
  // The Help item opens ZAICODE's own encyclopedia, not a web page.
  assert.match(readSource("lib/helpMenuActions.ts"), /openZaicodeHelp\(\)/);
});

test("SRC-114 issue templates: the links point at templates that exist", () => {
  for (const template of ["bug_report.yml", "feature_request.yml"]) {
    const path = join(import.meta.dirname, "../../../.github/ISSUE_TEMPLATE", template);
    assert.ok(readFileSync(path, "utf-8").includes("name:"), `${template} has no form`);
  }
});

test("SRC-114 saipen: a directory that cannot be read is not reported as absent", () => {
  assert.equal(isZaicodeSaipenMissingFileError({ code: "ENOENT", message: "gone" }), true);
  assert.equal(isZaicodeSaipenMissingFileError(new Error("ENOENT: no such file or directory")), true);
  assert.equal(isZaicodeSaipenMissingFileError({ code: "EACCES", message: "permission denied" }), false);
  assert.equal(isZaicodeSaipenMissingFileError(new Error("EPERM: operation not permitted")), false);
  assert.equal(isZaicodeSaipenMissingFileError(undefined), false, "no error is not a missing file");

  assert.equal(
    describeZaicodeSaipenReadError(new Error("EACCES: permission denied")),
    "EACCES: permission denied",
  );
  assert.equal(describeZaicodeSaipenReadError(new Error("   ")), "unknown error", "never an empty message");
  assert.equal(describeZaicodeSaipenReadError(null), "unknown error");
});