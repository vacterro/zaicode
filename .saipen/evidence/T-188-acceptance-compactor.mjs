// Compacts the raw T-188 acceptance log. The harness pushes a snapshot per account per
// poll; that is far too much to commit. Everything is kept verbatim here -- only the
// repetitive middle of the sweep run is thinned, never deleted without a survivor.
import { readFileSync, writeFileSync } from "node:fs";

const PATH = "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/.saipen/evidence/T-188-packaged-acceptance.json";
const raw = JSON.parse(readFileSync(PATH, "utf8"));
const sweeps = raw.steps.filter((s) => s.name === "sweep");
const other = raw.steps.filter((s) => s.name !== "sweep");
const KEEP_EVERY = 25;
const keptSweeps = sweeps.filter((s, i) => i % KEEP_EVERY === 0 || i === sweeps.length - 1);
const byIndex = new Map(keptSweeps.map((s) => [s.index, s]));

const out = {
  ...raw,
  compaction: {
    note: "sweep steps thinned to every 25th; first and last always kept; all non-sweep steps verbatim",
    rawSweepCount: sweeps.length,
    keptSweepCount: keptSweeps.length,
    by: "V:/_TEMP_/t188-accept/compact.mjs",
  },
  steps: [...other, ...keptSweeps].sort((a, b) => String(a.at).localeCompare(String(b.at))),
};
delete out.sweepIndexSample;
writeFileSync(PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ raw: sweeps.length, kept: keptSweeps.length, totalSteps: out.steps.length, bytes: JSON.stringify(out).length }));