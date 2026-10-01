// saihunt scratch: signal 6, orphan-file sweep. Read-only over the repo; writes nothing there.
const fs = require("node:fs");
const path = require("node:path");

const ZAICODE = process.argv[2];
process.chdir(ZAICODE);

const TARGET_ROOTS = [
  "packages/ui/src/zaicode",
  "packages/desktop/src/host",
  "packages/desktop/src/main",
  "apps/zcode-cli/packages/core/src",
];
const SCAN_ROOTS = [
  "packages/ui/src",
  "packages/desktop/src",
  "packages/services/src",
  "packages/provider/src",
  "packages/shared/src",
  "packages/client/src",
  "apps/zcode-cli/packages",
];

function walk(dir, out, filter) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, filter);
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

const candidates = [];
for (const root of TARGET_ROOTS) {
  walk(
    root,
    candidates,
    (name) => /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) && !/\.d\.ts$/.test(name),
  );
}

const corpus = [];
for (const root of SCAN_ROOTS) {
  walk(root, corpus, (name) => /\.(ts|tsx)$/.test(name));
}
const texts = corpus.map((file) => [file, fs.readFileSync(file, "utf8")]);

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const orphans = [];
for (const file of candidates) {
  const base = path.basename(file).replace(/\.(ts|tsx)$/, "");
  const pattern = new RegExp(`\\b${escapeRe(base)}\\b`, "g");
  let outside = 0;
  let inside = 0;
  for (const [other, text] of texts) {
    const count = (text.match(pattern) || []).length;
    if (other === file) inside += count;
    else outside += count;
  }
  if (outside === 0) orphans.push({ file, selfRefs: inside });
}

console.log(`candidates: ${candidates.length}, corpus files: ${texts.length}`);
console.log(`no reference outside themselves: ${orphans.length}`);
for (const orphan of orphans) {
  console.log(`  ${orphan.file}  (self refs: ${orphan.selfRefs})`);
}