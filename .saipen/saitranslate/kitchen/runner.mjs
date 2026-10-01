#!/usr/bin/env node
// SAITRANSLATE batch runner -- deterministic, resumable, digest-guarded.
//
// The engine the producer charter asks for: it never translates anything
// itself. It extracts the source catalog from the nested product tree
// (read-only), hands out batches with stable identities, and is the single
// judge of whether a completed batch counts:
//   - exact key set (no unknown keys, no missing keys, no duplicates)
//   - placeholder/token parity with the source value
//   - a value that actually differs from the source English
//   - current source digest at every step (a stale batch is refused, never
//     silently refreshed)
// Drafts live only in this kitchen; the product tree stays untouched.
//
// Usage:
//   node runner.mjs status
//   node runner.mjs batch <locale> [size]     -> writes outbox/<id>.json
//   node runner.mjs accept outbox/<id>.json   -> validates + merges + records
//
// A batch id is stable: <locale>.b<index> (zero-padded 4). Its identity is
// bound to the source digest; accept re-verifies both.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { technicalTokens, suspiciousTranslation } from './tokens.mjs';

const KITCHEN = process.env.SAITRANSLATE_KITCHEN_DIR ?? import.meta.dirname;
const STATE = join(KITCHEN, "state.json");
const DRAFTS = join(KITCHEN, "drafts");
const OUTBOX = join(KITCHEN, "outbox");
const SOURCE = join(
  KITCHEN, "..", "..", "..",
  "zcode", "packages", "ui", "src", "i18n", "locales", "en-US.ts",
);

// The locale set is NOT guessed here: it mirrors the resolved protocol list
// (phases/translate.md, 32 languages + Дед) that packages/ui/test/zaicodeLocaleParity.test.ts
// enforces against the installed protocol file. Keep both in lockstep.
const LOCALES = new Set([
  "en-US", "ru-RU", "et-EE", "uk-UA", "ja-JP", "ded",
  "zh-CN", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "nl-NL", "pl-PL",
  "sv-SE", "da-DK", "fi-FI", "nb-NO", "ko-KR", "th-TH", "vi-VN", "ar-SA",
  "he-IL", "tr-TR", "hi-IN", "id-ID", "el-GR", "cs-CZ", "ro-RO", "hu-HU",
  "bg-BG", "sk-SK", "hr-HR",
]);
const SOURCE_LOCALE = "en-US";

function unescape(inner, quote) {
  // The catalog is hand-written TS: single- and double-quoted strings, values
  // sometimes on the line after the key. Draft-grade unescape of the common
  // escapes; the product parity gate stays the final authority at integration.
  return inner
    .replace(/\\(['"`])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\\\/g, "\\")
    .replace(quote === "'" ? /"/g : /'/g, (c) => c);
}

function extractCatalog(text) {
  const entries = new Map();
  const re = /^\s*"([^"\s]+)":\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (entries.has(m[1])) throw new Error(`duplicate source key ${m[1]}`);
    entries.set(m[1], m[2] !== undefined ? unescape(m[2], "'") : unescape(m[3], '"'));
  }
  return entries;
}

function placeholders(value) {
  return [
    ...value.matchAll(/\{(\w+)\}/g),
    ...value.matchAll(/\$\{[^}]+\}/g),
    ...value.matchAll(/\{\{[^}]+\}\}/g),
  ].map((x) => x[0]).sort();
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sourceDigest(catalog) {
  // Digest over the normalized corpus, not the file bytes: formatting-only
  // source edits must not invalidate 30 finished batches.
  const body = [...catalog.entries()].map(([k, v]) => `${k}\u0000${v}`).join("\u0001");
  return sha256(body);
}

function loadState() {
  if (!existsSync(STATE)) return null;
  return JSON.parse(readFileSync(STATE, "utf8"));
}

function saveState(state) {
  state.updated = new Date().toISOString();
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
}

function readSource() {
  if (process.env.SAITRANSLATE_SOURCE_CATALOG) {
    const catalog = new Map(Object.entries(JSON.parse(readFileSync(process.env.SAITRANSLATE_SOURCE_CATALOG, "utf8"))));
    if (!catalog.size || [...catalog.values()].some((value) => typeof value !== "string")) {
      throw new Error("custom source catalog must contain nonempty string entries");
    }
    return { catalog, digest: sourceDigest(catalog), order: [...catalog.keys()] };
  }
  const text = readFileSync(SOURCE, "utf8");
  const catalog = extractCatalog(text);
  if (catalog.size < 5000) throw new Error(`source catalog implausibly small: ${catalog.size}`);
  return { catalog, digest: sourceDigest(catalog), order: [...catalog.keys()] };
}

function localeState(state, locale, digest) {
  if (!state.locales[locale]) {
    state.locales[locale] = {
      digest,
      accepted: 0,
      batches_accepted: [],
      throughput: { keys: 0, seconds: 0 },
      issued: 0,
    };
  }
  state.locales[locale].digest = digest;
  return state.locales[locale];
}

function cmdStatus() {
  const src = readSource();
  const state = loadState();
  console.log(`source keys: ${src.catalog.size}`);
  console.log(`source digest: sha256:${src.digest}`);
  if (!state || state.source_digest !== src.digest) {
    console.log("state: STALE or absent -- run a batch to (re)bind");
    return;
  }
  for (const [locale, ls] of Object.entries(state.locales)) {
    const pct = ((ls.accepted / src.catalog.size) * 100).toFixed(1);
    const rate = ls.throughput.seconds > 0
      ? (ls.throughput.keys / ls.throughput.seconds).toFixed(3) : "n/a";
    console.log(
      `${locale}: ${ls.accepted}/${src.catalog.size} (${pct}%) accepted=${ls.batches_accepted.length} rate=${rate} keys/s`,
    );
  }
}

function cmdBatch(locale, sizeArg, repairKeys) {
  if (!LOCALES.has(locale)) throw new Error(`unknown locale ${locale}`);
  if (locale === SOURCE_LOCALE) throw new Error("the source locale needs no batches");
  const size = Math.max(1, Math.min(200, Number(sizeArg) || 40));
  const src = readSource();
  let state = loadState();
  if (!state || state.source_digest !== src.digest) {
    if (state) console.log("source digest changed: preserving accepted drafts, rebinding; final audit must verify them against the current source");
    state = {
      source_keys: src.catalog.size,
      source_digest: src.digest,
      bound_at: new Date().toISOString(),
      locales: state && state.locales ? state.locales : {},
    };
    saveState(state);
  }
  const ls = localeState(state, locale, src.digest);
  const draftPath = join(DRAFTS, `${locale}.json`);
  const done = existsSync(draftPath) ? new Set(Object.keys(JSON.parse(readFileSync(draftPath, "utf8")))) : new Set();
  if (repairKeys && (!Array.isArray(repairKeys) || repairKeys.some(key => !src.catalog.has(key)))) {
    throw new Error("repair keys must be an array of current source keys");
  }
  const pending = repairKeys ? [...new Set(repairKeys)].slice(0, 200) : src.order.filter((k) => !done.has(k) && !ls.batches_active?.includes?.(k)).slice(0, size);
  if (pending.length === 0) {
    console.log(`${locale}: nothing pending (${done.size} drafted)`);
    return;
  }
  const index = ls.issued + 1;
  const id = `${locale}.b${String(index).padStart(4, "0")}`;
  mkdirSync(OUTBOX, { recursive: true });
  const batch = {
    id,
    locale,
    source_digest: `sha256:${src.digest}`,
    issued_at: new Date().toISOString(),
    keys: pending,
    messages: Object.fromEntries(pending.map((k) => [k, src.catalog.get(k)])),
  };
  writeFileSync(join(OUTBOX, `${id}.json`), JSON.stringify(batch, null, 2) + "\n");
  ls.issued = index;
  saveState(state);
  console.log(`issued ${id}: ${pending.length} keys -> outbox/${id}.json`);
}

/** Every accepted value that is still an English copy with words in it and was not kept on purpose. */
function cmdAudit(locale) {
  const src = readSource();
  const draftPath = join(DRAFTS, `${locale}.json`);
  if (!existsSync(draftPath)) throw new Error(`no draft for ${locale}`);
  const draft = JSON.parse(readFileSync(draftPath, "utf8"));
  const keptPath = join(DRAFTS, `${locale}.kept.json`);
  const kept = new Set(existsSync(keptPath) ? JSON.parse(readFileSync(keptPath, "utf8")) : []);
  const stale = [];
  for (const [key, value] of Object.entries(draft)) {
    const source = src.catalog.get(key);
    if (source === undefined || value !== source) continue;
    const rest = value.replace(/\{\{[^}]+\}\}|\$\{[^}]+\}|\{\w+\}/g, "");
    if (/\p{L}/u.test(rest) && !kept.has(key)) stale.push([key, value]);
  }
  console.log(`${locale}: ${Object.keys(draft).length} drafted, ${stale.length} unchanged English copies not kept on purpose`);
  for (const [key, value] of stale) console.log(`  ${key} = ${JSON.stringify(value)}`);
}

function cmdAccept(path) {
  const src = readSource();
  const state = loadState();
  if (!state) throw new Error("no state; run a batch first");
  if (state.source_digest !== src.digest) {
    throw new Error("source digest drifted since the batch was issued; re-issue against current source");
  }
  let batch = JSON.parse(readFileSync(path, "utf8"));
  // A completed batch may arrive as translation-only; its identity, key set
  // and digest binding live in the issued manifest under outbox/.
  if (!Array.isArray(batch.keys) || !batch.source_digest) {
    const manifest = join(OUTBOX, `${batch.id}.json`);
    const issued = JSON.parse(readFileSync(manifest, "utf8"));
    batch = { ...issued, translation: batch.translation, kept: batch.kept };
  }
  if (batch.source_digest !== `sha256:${src.digest}`) {
    throw new Error(`batch ${batch.id} is bound to ${batch.source_digest}, not the current source`);
  }
  const ls = state.locales[batch.locale];
  if (!ls) throw new Error(`locale ${batch.locale} has no state`);
  if (ls.batches_accepted.includes(batch.id)) {
    throw new Error(`batch ${batch.id} already accepted (idempotent refusal)`);
  }
  const translated = batch.translation;
  if (!translated || typeof translated !== "object") {
    throw new Error("batch carries no .translation object");
  }
  const errors = [];
  const keys = batch.keys;
  const seen = new Set();
  for (const key of Object.keys(translated)) {
    if (!keys.includes(key)) errors.push(`unknown key ${key}`);
  }
  for (const key of keys) {
    const value = translated[key];
    if (seen.has(key)) errors.push(`duplicate key ${key}`);
    seen.add(key);
    // A source value that is empty on purpose stays empty in every language: there is nothing to translate.
    if (src.catalog.get(key) === "") {
      if (value !== "") errors.push(`${key}: the source value is empty, so the translation must be empty`);
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`${key}: empty or non-string value`);
      continue;
    }
    const want = placeholders(src.catalog.get(key) ?? "");
    const got = placeholders(value);
    if (want.join("|") !== got.join("|")) {
      errors.push(`${key}: placeholders ${want.join(",") || "(none)"} != ${got.join(",") || "(none)"}`);
    }
    const sourceValue = src.catalog.get(key) ?? '';
    const missingTokens = technicalTokens(sourceValue).filter(token => !value.includes(token));
    if (missingTokens.length) errors.push(`${key}: technical tokens missing: ${missingTokens.join(', ')}`);
    if (suspiciousTranslation(sourceValue,value)) errors.push(`${key}: translation is a transport marker or suspiciously truncated; provide the full meaning`);
    if (value === src.catalog.get(key)) {
      // A value made only of placeholders, punctuation, digits and units carries no words to translate.
      const rest = value.replace(/\{\{[^}]+\}\}|\$\{[^}]+\}|\{\w+\}/g, "");
      const wordless = !/\p{L}/u.test(rest);
      // A brand, a code or a unit is the same in every language: the translator says so per key (`kept`), and only a short value may be kept.
      const keptOnPurpose = Array.isArray(batch.kept) && batch.kept.includes(key) && value.length <= 40;
      if (!wordless && !keptOnPurpose) errors.push(`${key}: value is an unchanged English copy`);
    }
  }
  if (errors.length > 0) {
    console.error(`REJECTED ${batch.id}: ${errors.length} error(s)`);
    for (const e of errors.slice(0, 20)) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(DRAFTS, { recursive: true });
  const draftPath = join(DRAFTS, `${batch.locale}.json`);
  const draft = existsSync(draftPath) ? JSON.parse(readFileSync(draftPath, "utf8")) : {};
  Object.assign(draft, translated);
  writeFileSync(draftPath, JSON.stringify(draft, null, 2) + "\n");
  if (Array.isArray(batch.kept) && batch.kept.length > 0) {
    const keptPath = join(DRAFTS, `${batch.locale}.kept.json`);
    const known = existsSync(keptPath) ? JSON.parse(readFileSync(keptPath, "utf8")) : [];
    writeFileSync(keptPath, JSON.stringify([...new Set([...known, ...batch.kept])], null, 2) + "\n");
  }

  // Wall time from issue to accept: that IS the model production time for
  // this batch, so it is measured, never hand-reported.
  const seconds = Math.max(
    0,
    (Date.now() - Date.parse(batch.issued_at)) / 1000,
  );
  ls.accepted = Object.keys(draft).length;
  ls.batches_accepted.push(batch.id);
  ls.throughput.keys += keys.length;
  ls.throughput.seconds += seconds;
  saveState(state);
  const rate = ls.throughput.seconds > 0
    ? (ls.throughput.keys / ls.throughput.seconds).toFixed(3) : "n/a";
  console.log(
    `ACCEPTED ${batch.id}: +${keys.length} -> ${ls.accepted}/${src.catalog.size} (${((ls.accepted / src.catalog.size) * 100).toFixed(1)}%) rate=${rate} keys/s`,
  );
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "status") cmdStatus();
else if (cmd === "batch") cmdBatch(a, b);
else if (cmd === "repair") cmdBatch(a, 200, JSON.parse(readFileSync(b, "utf8")));
else if (cmd === "accept") cmdAccept(a);
else if (cmd === "audit") cmdAudit(a);
else {
  console.error("usage: node runner.mjs status | batch <locale> [size] | accept <batch-file>");
  process.exitCode = 1;
}
