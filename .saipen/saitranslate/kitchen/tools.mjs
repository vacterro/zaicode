#!/usr/bin/env node
// SAITRANSLATE kitchen helper: a compact way to move one issued batch through the runner.
//
// It changes only the TRANSPORT of a batch, never its judgement: `runner.mjs accept` still decides whether the batch counts.
//
//   node tools.mjs view <batchId>              -> N|"English value"      one line per key, JSON-quoted, in batch order
//   node tools.mjs done <batchId> <file.txt>   -> file lines N|"translation" are mapped back to the batch's keys;
//                                                 a line `N|=` keeps the English value on purpose (a brand, a code, a unit; short values only);
//                                                 outbox/<batchId>.done.json is written and `runner.mjs accept` is run.
//
// Numbers are the position in the batch (1-based). A missing, duplicated or unknown number is refused before anything is written.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KITCHEN = process.env.SAITRANSLATE_KITCHEN_DIR ?? import.meta.dirname;
const OUTBOX = join(KITCHEN, "outbox");

function loadBatch(id) {
  const path = join(OUTBOX, `${id}.json`);
  if (!existsSync(path)) throw new Error(`no issued batch ${id}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const [command, id, file] = process.argv.slice(2);
if (command === "next") {
  // next <locale> [size]: issue the next batch and show it, in one step.
  const issued = spawnSync(process.execPath, [join(import.meta.dirname, "runner.mjs"), "batch", id, file ?? "200"], { encoding: "utf8" });
  const match = /issued (\S+):/.exec(issued.stdout);
  if (!match) {
    process.stdout.write(issued.stdout);
    process.stderr.write(issued.stderr);
    process.exit(issued.status ?? 1);
  }
  console.log(`# ${match[1]}`);
  const batch = loadBatch(match[1]);
  batch.keys.forEach((key, index) => console.log(`${index + 1}|${JSON.stringify(batch.messages[key])}`));
} else if (command === "view") {
  const batch = loadBatch(id);
  batch.keys.forEach((key, index) => console.log(`${index + 1}|${JSON.stringify(batch.messages[key])}`));
} else if (command === "done") {
  const batch = loadBatch(id);
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  const translation = {};
  const kept = [];
  const problems = [];
  for (const line of lines) {
    const at = line.indexOf("|");
    const number = Number(line.slice(0, at));
    if (at < 1 || !Number.isInteger(number) || number < 1 || number > batch.keys.length) {
      problems.push(`bad line: ${line.slice(0, 60)}`);
      continue;
    }
    const key = batch.keys[number - 1];
    if (key in translation) problems.push(`duplicate number ${number}`);
    if (line.slice(at + 1).trim() === "=") {
      translation[key] = batch.messages[key];
      kept.push(key);
      continue;
    }
    try {
      translation[key] = JSON.parse(line.slice(at + 1));
    } catch {
      problems.push(`line ${number}: not a JSON string`);
    }
  }
  batch.keys.forEach((key, index) => {
    if (!(key in translation)) problems.push(`missing number ${index + 1} (${key})`);
  });
  if (problems.length > 0) {
    console.error(`NOT WRITTEN ${id}: ${problems.length} problem(s)`);
    for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const target = join(OUTBOX, `${id}.done.json`);
  writeFileSync(target, JSON.stringify({ id, translation, ...(kept.length > 0 ? { kept } : {}) }, null, 2) + "\n");
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "runner.mjs"), "accept", target], { encoding: "utf8" });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
} else {
  console.error("usage: node tools.mjs view <batchId> | done <batchId> <file.txt>");
  process.exit(2);
}
