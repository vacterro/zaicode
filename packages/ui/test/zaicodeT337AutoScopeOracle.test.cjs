const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { stripTypeScriptTypes } = require("node:module");
const path = require("node:path");
const test = require("node:test");

const source = readFileSync(path.resolve(__dirname, "../../shared/src/zaicode-audits.ts"), "utf8");
// The audit-wave dependency is inert: these cases execute only real AUTO policy functions.
const imports = /^import \{[^\n]+\} from "\.\/zaicode-audit-quick3\.js";\r?\n/gm;
assert.equal([...source.matchAll(imports)].length, 1);
const code = "const ZAICODE_AUDIT_QUICK3_PROFILE = []; const zaicodeAuditQuick3Wave = () => { throw new Error('audit profiles are outside this policy oracle'); };\n" +
  stripTypeScriptTypes(source.replace(imports, ""), { mode: "strip" });
const api = import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

test("project mode overrides global defaults in every boolean combination without leaking to peers", async () => {
  const m = await api;
  for (const global of [false, true]) for (const local of [false, true]) {
    const settings = { smartMode: global, autoAudits: true, maxCycles: 10,
      autoProjects: { "host-A/project": { smartMode: local } } };
    assert.equal(m.resolveZaicodeAutoPolicy(settings, "host-A/project").smartMode, local);
    assert.equal(m.resolveZaicodeAutoPolicy(settings, "host-B/project").smartMode, global);
    assert.equal(m.resolveZaicodeAutoPolicy(settings, "").smartMode, global);
    assert.deepEqual(settings.autoProjects, { "host-A/project": { smartMode: local } });
  }
});

test("partial project policy inherits untouched fields and clearing an override restores inheritance", async () => {
  const m = await api;
  const settings = { smartMode: true, autoAudits: false, maxCycles: 7,
    autoProjects: { project: { autoAudits: true, maxCycles: 2 } } };
  assert.deepEqual(m.resolveZaicodeAutoPolicy(settings, "project"), { smartMode: true, autoAudits: true, maxCycles: 2 });
  assert.deepEqual(m.resolveZaicodeAutoPolicy({ ...settings, autoProjects: {} }, "project"), { smartMode: true, autoAudits: false, maxCycles: 7 });
  assert.deepEqual(m.resolveZaicodeAutoPolicy({ ...settings, smartMode: false }, "project"), { smartMode: false, autoAudits: true, maxCycles: 2 });
});

test("old profiles and malformed overrides retain safe global policy", async () => {
  const m = await api;
  const base = { smartMode: true, autoAudits: false, maxCycles: 4 };
  for (const value of [null, undefined, [], 12, "project", { p: [] }, { p: { smartMode: "yes", autoAudits: 1, maxCycles: "2" } }]) {
    const autoProjects = m.normalizeZaicodeAutoProjects(value);
    assert.deepEqual(autoProjects, {});
    assert.deepEqual(m.resolveZaicodeAutoPolicy({ ...base, autoProjects }, "p"), base);
  }
});

test("project normalization keeps explicit false, clamps integer limits and preserves identities", async () => {
  const m = await api;
  const raw = JSON.parse('{"host-A/p":{"smartMode":false,"autoAudits":false,"maxCycles":0,"foreign":true},"host-B/p":{"smartMode":true,"maxCycles":99},"":{"smartMode":true},"empty":{}}');
  assert.deepEqual(m.normalizeZaicodeAutoProjects(raw), {
    "host-A/p": { smartMode: false, autoAudits: false, maxCycles: 1 },
    "host-B/p": { smartMode: true, maxCycles: 10 },
  });
});
