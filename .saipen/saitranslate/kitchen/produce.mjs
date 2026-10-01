#!/usr/bin/env node
// SAITRANSLATE producer: drives runner.mjs batches through a model behind the local 9router.
//
// It never judges a translation: runner.mjs accept stays the only gate (exact keys, placeholder
// parity, no English copies, current source digest). This file only moves batches:
//   issue (runner batch) -> ask the model -> write outbox/<id>.txt -> tools.mjs done (accept)
// A rejected batch is retried with the runner's error list, up to --retries times; then the
// producer stops that locale and says so. Nothing is lost: drafts/ holds every accepted key and
// the next run issues only what is still missing (resumable by construction).
//
// Several producers may run at once on DIFFERENT locales: every runner call that touches
// state.json holds an exclusive lock directory (kitchen/.lock), the model call does not.
//
//   node produce.mjs <locale> [--model M] [--size N] [--router URL] [--batches N] [--retries N]
//
// Router key: %APPDATA%/ZAICODE/zaicode-router-key.json (ZAICODE's own key for that router).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const KITCHEN = process.env.SAITRANSLATE_KITCHEN_DIR ?? import.meta.dirname;
const OUTBOX = join(KITCHEN, "outbox");
const LOCK = join(KITCHEN, ".lock");
const LOG = join(KITCHEN, "produce.log");

const LANGUAGES = {
  "ru-RU": "Russian", "et-EE": "Estonian", "uk-UA": "Ukrainian", "ja-JP": "Japanese",
  ded: "Russian in the voice of a blunt, street-smart old man from a 1990s Russian neighbourhood (\"дед\"): short, colloquial, mildly cheeky, never obscene, still perfectly clear as UI text",
  "zh-CN": "Simplified Chinese", "de-DE": "German", "fr-FR": "French", "es-ES": "Spanish (Spain)",
  "it-IT": "Italian", "pt-BR": "Brazilian Portuguese", "nl-NL": "Dutch", "pl-PL": "Polish",
  "sv-SE": "Swedish", "da-DK": "Danish", "fi-FI": "Finnish", "nb-NO": "Norwegian Bokmål",
  "ko-KR": "Korean", "th-TH": "Thai", "vi-VN": "Vietnamese", "ar-SA": "Arabic", "he-IL": "Hebrew",
  "tr-TR": "Turkish", "hi-IN": "Hindi", "id-ID": "Indonesian", "el-GR": "Greek", "cs-CZ": "Czech",
  "ro-RO": "Romanian", "hu-HU": "Hungarian", "bg-BG": "Bulgarian", "sk-SK": "Slovak", "hr-HR": "Croatian",
};

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const locale = process.argv[2];
const model = option("--model", "SAIFREN");
const size = Number(option("--size", "100"));
const router = option("--router", "http://127.0.0.1:20128").replace(/\/+$/, "");
const maxBatches = Number(option("--batches", "1000"));
const retries = Number(option("--retries", "3"));
if (!locale || !LANGUAGES[locale]) {
  console.error(`usage: node produce.mjs <locale> [--model M] ...  (known: ${Object.keys(LANGUAGES).join(", ")})`);
  process.exit(2);
}

function routerKey() {
  const file = join(process.env.APPDATA ?? "", "ZAICODE", "zaicode-router-key.json");
  const keys = JSON.parse(readFileSync(file, "utf8"));
  const key = keys[router];
  if (!key) throw new Error(`no ZAICODE key for ${router} in ${file}`);
  return key;
}

function log(line) {
  const stamped = `${new Date().toISOString()} ${locale} ${line}`;
  console.log(stamped);
  appendFileSync(LOG, stamped + "\n");
}

async function withLock(fn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(LOCK);
      break;
    } catch {
      // A lock older than 2 minutes belongs to a producer that died mid-call.
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 120_000) rmSync(LOCK, { recursive: true, force: true });
      } catch {
        // gone already
      }
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 200));
      if (attempt > 2000) throw new Error("kitchen lock never came free");
    }
  }
  try {
    return fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

function node(script, args) {
  return spawnSync(process.execPath, [join(import.meta.dirname, script), ...args], { encoding: "utf8" });
}

function glossary() {
  return [
    "Keep these in Latin exactly as written: ZAICODE, ZCode, SAIPEN, SAIMAIL, SAIFREN, SAIOPP, SAIRoute, SAIHOME,",
    "9router, Claude, Codex, Antigravity, Coding Plan, Start Plan, Lite, Pro, Max, Computer Use, MCP, API, CLI, Git,",
    "GitHub, JSON, YAML, URL, SSH, PID, MAIN, SIDE, YOLO, ProTrail, A3, HORSE, and any product or file name.",
    "Keep keyboard keys and shortcuts (Ctrl, Shift, Alt, Enter, Esc, Tab, Cmd) as written.",
  ].join(" ");
}

function prompt(batch, feedback, numbers) {
  const wanted = numbers ?? batch.keys.map((_, index) => index + 1);
  const draftFile = join(KITCHEN, 'drafts', `${locale}.json`);
  const review = process.env.SAITRANSLATE_POLISH === '1';
  const draft = review && existsSync(draftFile) ? JSON.parse(readFileSync(draftFile, 'utf8')) : {};
  const lines = wanted.map((number) => `${number}|${JSON.stringify(review ? { English: batch.messages[batch.keys[number - 1]], draft: draft[batch.keys[number - 1]] } : batch.messages[batch.keys[number - 1]])}`);
  const system = [
    `You translate ${process.env.SAITRANSLATE_SURFACE_DESCRIPTION ?? "the user interface"} of ZAICODE, a desktop app for AI coding agents, from English into ${LANGUAGES[locale]}.`,
    "Input: numbered lines N|\"English\" (the English is a JSON string).",
    ...(process.env.SAITRANSLATE_SOURCE_CATALOG?.includes('docs') ? ['Output one JSON object and nothing else. Its keys are the input numbers as strings, and each value is the complete translated paragraph as a JSON string. Escape newlines inside strings as \\n.'] : ["Output: exactly one line per input line, in the same order, and nothing else: N|\"translation\" as a JSON string"]),
    "(escape quotes and backslashes; keep \\n as \\n).",
    "Rules: translate every word a user reads; natural, concise UI wording; same tone as the source.",
    "Placeholders {name}, {{name}} and ${name} must appear exactly as in the source, untranslated.",
    "If the whole value is a brand, code, unit or file name that stays identical in every language, output N|= instead.",
    "Never use = for ordinary words or sentences such as Save, Cancel, Agent, Running, Settings, or Help. Translate them. Preserve Markdown syntax, commands, command flags, URLs and code; translate their human-readable descriptions.",
    "If the English is empty (\"\"), output N|\"\".",
    glossary(),
    ...(review ? ["Input includes an English source and a previous translation. Proofread and improve the draft against the source: correct meaning, fluent native grammar, spelling and natural terminology. Avoid literal word-by-word calques and invented words. Preserve accurate technical detail, every placeholder and all Markdown. Output the complete corrected translation even when no correction is needed."] : []),
  ].join("\n");
  const user = (feedback ? `Your previous answer was rejected:\n${feedback}\nFix exactly these problems.\n\n` : "") + lines.join("\n");
  return { system, user };
}

async function ask(batch, feedback, numbers, requestedModel = model) {
  const { system, user } = prompt(batch, feedback, numbers);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const response = await fetch(`${router}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${routerKey()}` },
      body: JSON.stringify({
        model: requestedModel,
        stream: false,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`router ${response.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    return { text: data.choices?.[0]?.message?.content ?? "", servedBy: data.model ?? model };
  } finally {
    clearTimeout(timer);
  }
}

function answerLines(answer, count) {
  const out = [];
  if (process.env.SAITRANSLATE_SOURCE_CATALOG?.includes('docs')) {
    try {
      const object = JSON.parse(answer.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
      if (object && typeof object === 'object' && !Array.isArray(object)) {
        return Object.entries(object).filter(([number, value]) => Number.isInteger(Number(number)) && Number(number) >= 1 && Number(number) <= count && typeof value === 'string').map(([number, value]) => `${number}|${JSON.stringify(value)}`);
      }
    } catch { /* Retry through the numbered transport parser. */ }
  }
  for (const raw of answer.split(/\r?\n/)) {
    const line = raw.trim().replace(/^```\w*$/, "");
    const match = /^(\d+)\|(.*)$/.exec(line);
    if (!match) continue;
    const number = Number(match[1]);
    if (number < 1 || number > count) continue;
    out.push(`${number}|${match[2].trim()}`);
  }
  return out;
}

/** Batch line numbers the runner or the line mapper refused, from their own output. */
function refusedNumbers(batch, output) {
  const numbers = new Set();
  for (const line of output.split(/\r?\n/)) {
    const missing = /missing number (\d+)/.exec(line);
    if (missing) numbers.add(Number(missing[1]));
    const bad = /line (\d+): not a JSON string/.exec(line);
    if (bad) numbers.add(Number(bad[1]));
    const duplicate = /duplicate number (\d+)/.exec(line);
    if (duplicate) numbers.add(Number(duplicate[1]));
    const keyed = /^\s*-\s+([^:\s]+):/.exec(line);
    if (keyed) {
      const index = batch.keys.indexOf(keyed[1]);
      if (index >= 0) numbers.add(index + 1);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

async function one() {
  const repair = option('--repair', null);
  const issued = await withLock(() => node("runner.mjs", repair ? ['repair', locale, repair] : ["batch", locale, String(size)]));
  const match = /issued (\S+):/.exec(issued.stdout);
  if (!match) {
    log(`nothing issued: ${(issued.stdout + issued.stderr).trim().split(/\r?\n/).at(-1)}`);
    return "done";
  }
  const id = match[1];
  const batch = JSON.parse(readFileSync(join(OUTBOX, `${id}.json`), "utf8"));
  const started = Date.now();
  // Accepted-looking answer lines by batch number; a retry asks ONLY for the numbers still wrong.
  const answers = new Map();
  // Opaque code blocks and placeholder-only values have no translatable prose.
  // Preserve them deterministically through the same acceptance gate.
  batch.keys.forEach((key, index) => {
    if (/^\{protected\d+\}$/.test(batch.messages[key])) answers.set(index + 1, `${index + 1}|${JSON.stringify(batch.messages[key])}`);
  });
  let feedback = "";
  let servedBy = model;
  let requestedModel = model;
  for (let attempt = 1; attempt <= retries + 2; attempt += 1) {
    const missing = batch.keys.map((_, index) => index + 1).filter((number) => !answers.has(number));
    if (missing.length > 0) {
      let answer;
      try {
        answer = await ask(batch, feedback, missing.length === batch.keys.length ? undefined : missing, requestedModel);
      } catch (error) {
        log(`${id} attempt ${attempt}: model call failed: ${error instanceof Error ? error.message : String(error)}`);
        if (requestedModel !== 'SAIFREN') {
          requestedModel = 'SAIFREN';
          log(`${id}: direct free model unavailable; retry through the authorized SAIFREN pool`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      servedBy = answer.servedBy;
      for (const line of answerLines(answer.text, batch.keys.length)) {
        const number = Number(line.slice(0, line.indexOf("|")));
        if (missing.includes(number)) answers.set(number, line);
      }
    }
    const file = join(OUTBOX, `${id}.txt`);
    writeFileSync(file, [...answers.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line).join("\n") + "\n");
    const done = await withLock(() => node("tools.mjs", ["done", id, file]));
    const output = (done.stdout + done.stderr).trim();
    if (/source digest drifted|batch \S+ is bound to/.test(output)) {
      log(`${id}: source changed during model call; re-issue a fresh batch`);
      return 'failed';
    }
    if (done.status === 0 && /ACCEPTED/.test(output)) {
      log(`${id} attempt ${attempt} ACCEPTED in ${((Date.now() - started) / 1000).toFixed(1)} s via ${servedBy}: ${output.split(/\r?\n/).at(-1)}`);
      return "accepted";
    }
    const refused = refusedNumbers(batch, output);
    for (const number of refused) answers.delete(number);
    feedback = output.split(/\r?\n/).slice(0, 25).join("\n");
    log(`${id} attempt ${attempt} rejected via ${servedBy}: ${refused.length} line(s) to redo; ${feedback.split(/\r?\n/)[0]}`);
    if (refused.length === 0) answers.clear();
  }
  log(`${id} gave up after ${retries + 2} attempts (resumable: the keys stay pending)`);
  return "failed";
}

let accepted = 0;
let failures = 0;
for (let n = 0; n < maxBatches; n += 1) {
  const result = await one();
  if (result === "done") break;
  if (result === "accepted") {
    accepted += 1;
    failures = 0;
  } else if (++failures >= 3) {
    log("three batches in a row failed: stopping this locale");
    process.exitCode = 1;
    break;
  }
}
if (failures > 0) process.exitCode = 1;
log(`producer finished: ${accepted} batch(es) accepted this run`);
