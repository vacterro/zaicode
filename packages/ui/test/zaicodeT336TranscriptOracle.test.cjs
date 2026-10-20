const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const path = require("node:path");
const test = require("node:test");

// Context construction is inert here; these cases execute the real pure projection and preference functions.
const source = readFileSync(path.resolve(__dirname, "../src/lib/transcriptView.tsx"), "utf8");
const reactImport = /^import \{[^\n]+\} from "react";\r?\n/gm;
assert.equal([...source.matchAll(reactImport)].length, 1);
const code =
  "const createContext = value => ({defaultValue:value}); const useContext = () => { throw new Error('hooks are outside this pure oracle'); };\n" +
  stripTypeScriptTypes(source.replace(reactImport, ""), { mode: "strip" });
const api = import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
const keys = ["user", "assistant", "thoughts", "tools"];
const rows = [
  { rowId: 1, kind: "turnHeader" },
  { rowId: 2, kind: "userInput", text: "user" },
  { rowId: 3, kind: "reasoning", text: "thoughts" },
  { rowId: 4, kind: "toolCall", status: "success" },
  { rowId: 41, kind: "artifact" },
  { rowId: 42, kind: "subagent" },
  { rowId: 43, kind: "hookInvocation" },
  { rowId: 5, kind: "assistantText", text: "agent" },
  { rowId: 6, kind: "timelineMarker", marker: { type: "goalVerify", outcome: "failed" } },
];
const options = (mask, scroll = 0) => ({
  kind: "sections",
  expanded: true,
  sections: Object.fromEntries(
    keys.map((key, i) => [
      key,
      { visible: Boolean(mask & (1 << i)), scroll: Boolean(scroll & (1 << i)) },
    ]),
  ),
});

test("all sixteen visibility combinations preserve selected chronology and essential failure", async () => {
  const m = await api;
  for (let mask = 0; mask < 16; mask++) {
    const before = JSON.stringify(rows),
      view = options(mask);
    const expected = [
      ...(mask ? [1] : []),
      ...(mask & 1 ? [2] : []),
      ...(mask & 4 ? [3] : []),
      ...(mask & 8 ? [4, 41, 42, 43] : []),
      ...(mask & 2 ? [5] : []),
      6,
    ];
    assert.deepEqual(
      m.projectTranscriptRows(rows, view).map((row) => row.rowId),
      expected,
      String(mask),
    );
    assert.equal(JSON.stringify(rows), before);
  }
});

test("all sixteen scroll combinations remain independent of visibility", async () => {
  const m = await api;
  for (let scroll = 0; scroll < 16; scroll++)
    for (let mask = 0; mask < 16; mask++) {
      const view = options(mask, scroll);
      for (let i = 0; i < keys.length; i++)
        assert.equal(
          m.isUnboundedTranscriptView(view, keys[i]),
          !(scroll & (1 << i)),
          keys[i] + ":" + scroll + ":" + mask,
        );
    }
});

test("custom preference roundtrip retains every flag and expansion", async () => {
  const m = await api;
  for (let mask = 0; mask < 16; mask++)
    for (let scroll = 0; scroll < 16; scroll++) {
      const view = options(mask, scroll);
      assert.deepEqual(m.normalizeTranscriptView(JSON.parse(JSON.stringify(view))), view);
      assert.equal(m.isExpandedTranscriptView(view), true);
      assert.equal(m.isExpandedTranscriptView({ ...view, expanded: false }), false);
    }
});

test("legacy values keep their accepted projections and unknown values stay safe", async () => {
  const m = await api;
  for (const view of [
    "compact",
    "full",
    "full-unbounded",
    "only-text",
    "only-thoughts",
    "only-tools",
  ])
    assert.equal(m.normalizeTranscriptView(view), view);
  assert.equal(m.projectTranscriptRows(rows, "compact"), rows);
  assert.equal(m.projectTranscriptRows(rows, "full"), rows);
  assert.deepEqual(
    m.projectTranscriptRows(rows, "only-text").map((row) => row.rowId),
    [1, 2, 5, 6],
  );
  assert.deepEqual(
    m.projectTranscriptRows(rows, "only-thoughts").map((row) => row.rowId),
    [1, 3],
  );
  assert.deepEqual(
    m.projectTranscriptRows(rows, "only-tools").map((row) => row.rowId),
    [1, 4],
  );
  for (const value of [null, undefined, "UNKNOWN", {}, [], 12])
    assert.equal(m.normalizeTranscriptView(value), "compact");
});
