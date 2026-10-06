import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// SRC-085: opening the mailbox showed "This section ran into a problem: Cannot read properties of
// null (reading 'getBoundingClientRect')". The envelope's click handler read event.currentTarget
// inside a setState updater; React clears currentTarget when the handler returns, and the updater
// runs after that.

const SRC = join(import.meta.dirname, "../src");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path));
    else if (name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

test("the envelope reads its anchor before it sets state, never inside the updater", () => {
  const button = readFileSync(join(SRC, "zaicode/ZaicodeSaimailHeaderButton.tsx"), "utf8").replace(/\r\n/g, "\n");
  // SRC-161:REQ-003 changed WHAT is held: the trigger element instead of a rect
  // snapshot, because a snapshot goes stale on scroll and reports a zero box
  // after detach. The SRC-085 rule it must still satisfy is the same one -- the
  // element is captured before the updater runs, and the updater never touches
  // the synthetic event.
  assert.match(button, /const trigger = event\.currentTarget;\s*\n\s*setReaderEl\(\(current\) => \(current \? null : trigger\)\);/);
  assert.doesNotMatch(button, /setReaderEl\(\(current\) => \([^)]*event\.currentTarget/);
  assert.match(button, /anchorEl=\{readerEl\}/, "the reader measures the live element, not a stored rect");
});

test("no component reads a synthetic event's currentTarget inside a state updater", () => {
  const offenders: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/\bset[A-Z]\w*\(\s*\(?\w*\)?\s*=>[^;]*\b(?:event|e)\.currentTarget\b/.test(line)) offenders.push(`${file.slice(SRC.length + 1)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `event.currentTarget is null by the time an updater runs: ${offenders.join(", ")}`);
});
