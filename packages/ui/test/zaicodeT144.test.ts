import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  isZaicodeLayoutEntryShown,
  normalizeZaicodeLayoutWhen,
} from "../src/zaicode/zaicodeLayoutPrefs.js";
import { normalizeZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import {
  isZaicodeSubOutboxRole,
  parseZaicodeOutbox,
  zaicodeCollectCommand,
  zaicodeOutboxCounts,
  zaicodeReadyProducers,
} from "../src/zaicode/zaicodeSubOutbox.js";

/**
 * T-144: SRC-112 (SubSaipen OUTBOX with a Collect button) and SRC-113
 * (Compact / Full, so no configured button or line stays hidden).
 */

const OUTBOX = `# OUTBOX

## HUNT-001: one safe-move check
- **status:** ready
- **summary:** the collector is the only writer of the receipt index
- **critical:** true
- **severity:** P0
- **producer:** saihunt
- **payload:** src/collector.ts

## WIKI-002: an already collected package
- **status:** reviewed
- **summary:** collected long ago; kept as history
- **producer:** saiwiki

## TRANSL-003: still writing
- **status:** draft
- **summary:** nothing to admit yet
- **producer:** saitranslate

## TEST-004: waiting on a machine fact
- **status:** blocked
- **summary:** cannot tell whether the fixture needs the new flag
- **producer:** saitest

## AUDIT-005: bound to an old charter
- **status:** stale
- **summary:** evidence proves it no longer describes the source
- **producer:** saiaudit

## BROKEN-006: status outside the enum
- **status:** finished
- **summary:** a producer wrote a word the protocol does not define
- **producer:** saihunt
`;

test("SRC-112: one OUTBOX file parses into its packages with their fields", () => {
  const packages = parseZaicodeOutbox(OUTBOX);
  assert.deepEqual(
    packages.map((entry) => entry.id),
    ["HUNT-001", "WIKI-002", "TRANSL-003", "TEST-004", "AUDIT-005", "BROKEN-006"],
  );
  const hunt = packages[0]!;
  assert.equal(hunt.status, "ready");
  assert.equal(hunt.title, "one safe-move check");
  assert.equal(hunt.producer, "saihunt");
  assert.equal(hunt.severity, "P0");
  assert.equal(hunt.critical, true);
  assert.equal(hunt.summary, "the collector is the only writer of the receipt index");
});

test("SRC-112: a status outside the enum is null, never a guess", () => {
  const broken = parseZaicodeOutbox(OUTBOX).at(-1)!;
  assert.equal(broken.id, "BROKEN-006");
  assert.equal(broken.status, null);
});

test("SRC-112: counts are per status and actionable is ready + blocked", () => {
  const counts = zaicodeOutboxCounts(parseZaicodeOutbox(OUTBOX));
  assert.equal(counts.ready, 1);
  assert.equal(counts.draft, 1);
  assert.equal(counts.blocked, 1);
  assert.equal(counts.reviewed, 1);
  assert.equal(counts.stale, 1);
  // A package with no valid status counts nowhere, so it can never inflate the row.
  assert.equal(counts.actionable, 2);
  assert.equal(zaicodeOutboxCounts([]).actionable, 0);
});

test("SRC-112: only ready packages are collect targets, sorted and de-duplicated", () => {
  assert.deepEqual(zaicodeReadyProducers(parseZaicodeOutbox(OUTBOX)), ["saihunt"]);
  const several = parseZaicodeOutbox(
    [
      "## B-002: b", "- **status:** ready", "- **producer:** saiwiki", "",
      "## A-001: a", "- **status:** ready", "- **producer:** saihunt", "",
      "## C-003: c", "- **status:** ready", "- **producer:** saihunt", "",
      "## D-004: no producer", "- **status:** ready",
    ].join("\n"),
  );
  assert.deepEqual(zaicodeReadyProducers(several), ["saihunt", "saiwiki"]);
});

test("SRC-112: the Collect button sends the canonical command, not its own protocol", () => {
  assert.equal(zaicodeCollectCommand("saihunt"), "saipen collect saihunt");
});

test("SRC-112: a SubSaipen role is a plain directory, not _shared and not hidden", () => {
  assert.equal(isZaicodeSubOutboxRole({ name: "saihunt", type: "directory" }), true);
  assert.equal(isZaicodeSubOutboxRole({ name: "_shared", type: "directory" }), false);
  assert.equal(isZaicodeSubOutboxRole({ name: ".git", type: "directory" }), false);
  assert.equal(isZaicodeSubOutboxRole({ name: "OUTBOX.md", type: "file" }), false);
});

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

test("SRC-112: ZAICODE only reads the OUTBOX, it never writes it", () => {
  for (const file of [
    "../src/zaicode/useZaicodeSubOutbox.ts",
    "../src/zaicode/ZaicodeSubOutboxChip.tsx",
  ]) {
    const source = sourceOf(file);
    for (const write of ["writeTextFile", "writeFile", "mkdir", "unlink", "rename"]) {
      assert.equal(source.includes(write), false, `${file} must not call ${write}`);
    }
  }
});

test("SRC-112: one reader per project, not one per open composer", () => {
  const source = sourceOf("../src/zaicode/useZaicodeSubOutbox.ts");
  // Ten sessions in a project is ten composers; without a shared poller that is
  // ten times the reads for one fact, and ten times the traffic on a remote host.
  assert.match(source, /const pollers = new Map<string, OutboxPoller>\(\)/);
  assert.match(source, /function acquirePoller\(/);
  assert.match(source, /if \(this\.listeners\.size === 1\) void this\.tick\(\)/);
  assert.match(source, /if \(poller\.idle\)/);
  // The read itself lives on the class, not in the hook's effect.
  assert.equal(source.split(/readTextFile\(\{ path: `\$\{root\}/).length - 1, 1);
});

test("SRC-112: the chip is mounted above the SAIPEN strip, Collect sends the collect command", () => {
  const chip = sourceOf("../src/zaicode/ZaicodeSubOutboxChip.tsx");
  assert.match(chip, /zaicodeCollectCommand\(producer\)/);
  assert.match(chip, /data-zaicode-sub-outbox-collect/);
  // Mounted beside the strip, not inside it: the strip has two layouts and the
  // chip must not be one that Compact can hide.
  const editor = sourceOf("../src/prompt-editor/ChatPromptEditor.tsx");
  assert.match(editor, /<ZaicodeSubOutboxChip/);
  assert.equal(editor.split(/<ZaicodeSubOutboxChip/g).length - 1, 1);
  // One sender for both, so a command goes out the same way either way.
  assert.equal(editor.split(/onCommand=\{sendProjectCommand\}/g).length - 1, 2);
  const strip = sourceOf("../src/prompt-editor/ZaicodeSaipenControls.tsx");
  assert.equal(strip.includes("ZaicodeSubOutboxChip"), false);
});

test("SRC-112: auto-continuation reuses the sidebar Auto switch, off by default", () => {
  const chip = sourceOf("../src/zaicode/ZaicodeSubOutboxChip.tsx");
  assert.match(chip, /useZaicodeAuditStore/);
  // The switch is read, never written: one meaning for "nothing acts by itself".
  assert.equal(/useZaicodeAuditStore[\s\S]{0,120}\.update\(/.test(chip), false);
  // A signature guard, so a poll that sees the same package twice sends once.
  assert.match(chip, /sent\.current === signature/);
});

test("SRC-113: Full shows a ticked entry whatever its own condition says", () => {
  const hover = { visible: true, when: "hover" } as const;
  const working = { visible: true, when: "working" } as const;
  const idle = { visible: true, when: "idle" } as const;
  // Compact keeps every condition exactly as configured.
  assert.equal(isZaicodeLayoutEntryShown(hover, { working: 0, hover: false }), false);
  assert.equal(isZaicodeLayoutEntryShown(hover, { working: 0, hover: true }), true);
  assert.equal(isZaicodeLayoutEntryShown(working, { working: 2, hover: false }), true);
  assert.equal(isZaicodeLayoutEntryShown(working, { working: 0, hover: false }), false);
  assert.equal(isZaicodeLayoutEntryShown(idle, { working: 0, hover: false }), true);
  // Full reveals what is configured; it does not add what was never ticked.
  for (const entry of [hover, working, idle]) {
    assert.equal(isZaicodeLayoutEntryShown(entry, { working: 0, hover: false, view: "full" }), true);
    assert.equal(isZaicodeLayoutEntryShown({ ...entry, visible: false }, { working: 2, hover: true, view: "full" }), false);
  }
});

test("SRC-113: the preference survives a stored value from an older build", () => {
  assert.equal(normalizeZaicodeUiPrefs(undefined).actionView, "compact");
  assert.equal(normalizeZaicodeUiPrefs({}).actionView, "compact");
  assert.equal(normalizeZaicodeUiPrefs({ actionView: "something-else" }).actionView, "compact");
  assert.equal(normalizeZaicodeUiPrefs({ actionView: "full" }).actionView, "full");
});

test("SRC-113: every call site passes the preference, so the switch reaches the screen", () => {
  for (const file of [
    "../src/zaicode/ZaicodeFooterTools.tsx",
    "../src/zaicode/ZaicodeHeaderToolbar.tsx",
    "../src/zaicode/ZaicodeSidebarNavBlock.tsx",
    "../src/zaicode/ZaicodeSidebarHeaderTools.tsx",
  ]) {
    const source = sourceOf(file);
    assert.match(source, /actionView/, `${file} must read the preference`);
    assert.match(source, /view: actionView/, `${file} must pass it into the rule`);
    assert.equal(
      (source.match(/isZaicodeLayoutEntryShown\(/g) ?? []).length,
      1,
      `${file} has one call site; all of them must be covered`,
    );
  }
});

test("SRC-113: the toggle sits in the header next to the buttons it governs", () => {
  assert.match(sourceOf("../src/zaicode/ZaicodeActionViewToggle.tsx"), /actionView: full \? "compact" : "full"/);
  assert.match(sourceOf("../src/zaicode/ZaicodeHeaderToolbar.tsx"), /ZaicodeActionViewToggle/);
});

test("SRC-113: an unknown condition is 'always', so nothing hides behind a bad value", () => {
  assert.equal(normalizeZaicodeLayoutWhen(undefined), "always");
  assert.equal(normalizeZaicodeLayoutWhen("sometimes"), "always");
  assert.equal(normalizeZaicodeLayoutWhen("hover"), "hover");
  // An absent condition therefore stays on screen even without the Full switch.
  assert.equal(isZaicodeLayoutEntryShown({ visible: true }, { working: 0, hover: false }), true);
});
