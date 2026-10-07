const fs = require("fs");
const p = ".saipen/intake/coverage/SRC-151.json";
const doc = JSON.parse(fs.readFileSync(p, "utf8"));
const L = ".saipen/evidence/T-251-src163/verdict-ledger.md";
const H = ".saipen/evidence/T-251-src163/packaged/receipt.json";
const S = ".saipen/evidence/T-251-src163/packaged/surface-receipt.json";
const T = ".saipen/evidence/T-251-src163/packaged-t250/receipt.json";
const U = ".saipen/evidence/T-251-src163/";
/** id -> [disposition, evidence path, verification class] */
const M = {
  R001: ["VERIFIED", ".saipen/evidence/T-220/packaged-outage-2026-10-05T03-09-17-171Z/receipt.json", "PACKAGED-T220"],
  R002: ["SOLID", T, "PACKAGED-T250 (re-run on the T-251 build)"],
  R003: ["SOLID", L + "#R003", "SOURCE+UNIT"],
  R004: ["SOLID", S, "PACKAGED-R251-SURFACE"],
  R005: ["SOLID", T, "UNIT-T250"],
  R006: ["SOLID", H, "PACKAGED-R251-HUNT"],
  R007: ["THIN", L + "#R007", "SOURCE-R251"],
  R008: ["SOLID", L + "#R008", "SOURCE-R251"],
  R009: ["SOLID", H, "PACKAGED-R251-HUNT"],
  R010: ["SOLID", T, "PACKAGED-T250+UNIT"],
  R011: ["SOLID", T, "PACKAGED-T250+UNIT"],
  R012: ["SOLID", L + "#R012", "SOURCE-R251"],
  R013: ["SOLID", L + "#R013", "UNIT-R251"],
  R014: ["SOLID", U + "r014-test.log", "UNIT-R251+PACKAGED-T220"],
  R015: ["SOLID", L + "#R015", "SOURCE-R251"],
  R016: ["SOLID", S, "PACKAGED-R251-SURFACE+UNIT"],
  R017: ["SOLID", S, "PACKAGED-R251-SURFACE"],
  R018: ["SOLID", T, "PACKAGED-T250"],
  R019: ["SOLID", L + "#R019", "SOURCE+UNIT"],
  R020: ["SOLID", H, "PACKAGED-R251-HUNT"],
  R021: ["SOLID", L + "#R021", "SOURCE+UNIT"],
  R022: ["SOLID", S, "PACKAGED-R251-SURFACE"],
  R023: ["SOLID", L + "#R023", "SOURCE-R251"],
  R024: ["BLOCKED_EXTERNAL", L + "#R024", "SOURCE-R251 (no repro)"],
  R025: ["SOLID", S, "PACKAGED-R251-SURFACE"],
  R026: ["OBSOLETE", L + "#R026", "operator struck through"],
  R027: ["SOLID", S, "PACKAGED-R251-SURFACE"],
  R028: ["SOLID", S, "PACKAGED-R251-SURFACE"],
  R029: ["SOLID", L + "#R029", "SOURCE+UNIT"],
  R030: ["SOLID", S, "PACKAGED-R251-SURFACE"],
  R031: ["SOLID", S, "PACKAGED-R251-SURFACE"],
  R032: ["SOLID", T, "UNIT-T250+PACKAGED-T250"],
  R033: ["SOLID", L + "#R033", "UNIT"],
  R034: ["SOLID", S, "PACKAGED-R251-SURFACE"],
  R035: ["THIN", L + "#R035", "SOURCE+UNIT"],
  R036: ["SOLID", H, "PACKAGED-R251-HUNT"],
  R037: ["OBSOLETE", L + "#R037", "operator struck through"],
  R038: ["SOLID", S, "PACKAGED-R251-SURFACE"],
  R039: ["OBSOLETE", L + "#R039", "operator struck through"],
  R040: ["DUPLICATE_VERIFIED", T, "same owner as R005 (UNIT-T250)"],
  R041: ["SOLID", L + "#R041", "UNIT-R251"],
  R042: ["OBSOLETE", L + "#R042", "operator struck through"],
  R043: ["OBSOLETE", L + "#R043", "operator struck through"],
  R044: ["OBSOLETE", L + "#R044", "operator struck through"],
};
let n = 0;
for (const [id, [disp, ev, ver]] of Object.entries(M)) {
  const key = "SRC-151:" + id;
  const row = doc.requirements[key];
  if (!row) {
    console.error("MISSING " + key);
    continue;
  }
  row.disposition = disp;
  row.evidence = ev;
  row.verification = ver;
  row.work = "T-251";
  n += 1;
}
fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
console.log("updated", n, "rows of", Object.keys(doc.requirements).length);
const tally = {};
for (const row of Object.values(doc.requirements)) tally[row.disposition] = (tally[row.disposition] || 0) + 1;
console.log(JSON.stringify(tally));
