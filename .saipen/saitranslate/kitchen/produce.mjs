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

const KITCHEN = import.meta.dirname;
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
  return spawnSync(process.execPath, [join(KITCHEN, script), ...args], { encoding: "utf8" });
}

function glossary() {
  return [
    "Keep these in Latin exactly as written: ZAICODE, ZCode, SAIPEN, SAIMAIL, SAIFREN, SAIOPP, SAIRoute, SAIHOME,",
    "9router, Claude, Codex, Antigravity, Coding Plan, Start Plan, Lite, Pro, Max, Computer Use, MCP, API, CLI, Git,",
    "GitHub, JSON, YAML, URL, SSH, PID, MAIN, SIDE, YOLO, ProTrail, A3, HORSE, and any product or file name.",
    "Keep keyboard keys and shortcuts (Ctrl, Shift, Alt, Enter, Esc, Tab, Cmd) as written.",
  ].join(" ");
}

function prompt(batch, feedback) {
  const lines = batch.keys.map((key, index) => `${index + 1}|${JSON.stringify(batch.messages[key])}`);
  const system = [
    `You translate the user interface of ZAICODE, a desktop app for AI coding agents, from English into ${LANGUAGES[locale]}.`,
    "Input: numbered lines N|\"English\" (the English is a JSON string).",
    "Output: exactly one line per input line, in the same order, and nothing else: N|\"translation\" as a JSON string",
    "(escape quotes and backslashes; keep \\n as \\n).",
    "Rules: translate every word a user reads; natural, concise UI wording; same tone as the source.",
    "Placeholders {name}, {{name}} and ${name} must appear exactly as in the source, untranslated.",
    "If the whole value is a brand, code, unit or file name that stays identical in every language, output N|= instead.",
    "If the English is empty (\"\"), output N|\"\".",
    glossary(),
  ].join("\n");
  const user = (feedback ? `Your previous answer was rejected:\n${feedback}\nFix exactly these problems.\n\n` : "") + lines.join("\n");
  return { system, user };
}

async function ask(batch, feedback) {
  const { system, user } = prompt(batch, feedback);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const response = await fetch(`${router}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${routerKey()}` },
      body: JSON.stringify({
        model,
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

async function one() {
  const issued = await withLock(() => node("runner.mjs", ["batch", locale, String(size)]));
  const match = /issued (\S+):/.exec(issued.stdout);
  if (!match) {
    log(`nothing issued: ${(issued.stdout + issued.stderr).trim().split(/\r?\n/).at(-1)}`);
    return "done";
  }
  const id = match[1];
  const batch = JSON.parse(readFileSync(join(OUTBOX, `${id}.json`), "utf8"));
  let feedback = "";
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const started = Date.now();
    let answer;
    try {
      answer = await ask(batch, feedback);
    } catch (error) {
      feedback = "";
      log(`${id} attempt ${attempt}: model call failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const lines = answerLines(answer.text, batch.keys.length);
    const file = join(OUTBOX, `${id}.txt`);
    writeFileSync(file, lines.join("\n") + "\n");
    const done = await withLock(() => node("tools.mjs", ["done", id, file]));
    const output = (done.stdout + done.stderr).trim();
    if (done.status === 0 && /ACCEPTED/.test(output)) {
      log(`${id} attempt ${attempt} ACCEPTED in ${((Date.now() - started) / 1000).toFixed(1)} s via ${answer.servedBy}: ${output.split(/\r?\n/).at(-1)}`);
      return "accepted";
    }
    feedback = output.split(/\r?\n/).slice(0, 25).join("\n");
    log(`${id} attempt ${attempt} rejected via ${answer.servedBy}: ${feedback.split(/\r?\n/)[0]}`);
  }
  log(`${id} gave up after ${retries} attempts (resumable: the keys stay pending)`);
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
log(`producer finished: ${accepted} batch(es) accepted this run`);
