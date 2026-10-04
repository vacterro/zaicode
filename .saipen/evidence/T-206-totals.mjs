import { readFileSync } from "node:fs";

// The \d below is doubled on purpose: inside a JS string literal a single \d collapses to a
// literal 'd', the regex then matches nothing and every total reads 0 -- which would make the
// assertion pass for the wrong reason instead of measuring the suite.
const text = readFileSync(process.argv[2], "utf8");
const total = name => [...text.matchAll(new RegExp("ℹ " + name + " (\\d+)", "g"))].reduce((s, m) => s + Number(m[1]), 0);
console.log(JSON.stringify({ tests: total("tests"), passed: total("pass"), failed: total("fail"), skipped: total("skipped") }));