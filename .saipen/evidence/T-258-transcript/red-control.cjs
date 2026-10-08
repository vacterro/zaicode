const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const root = "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode";
const files = ["packages/ui/src/ToolCallBlocks/ToolLayout.tsx", "packages/ui/src/components/ai-elements/reasoning.tsx"];
const originals = files.map((file) => fs.readFileSync(path.join(root, file)));
try {
  for (const file of files) {
    const old = spawnSync("git", ["show", "HEAD:" + file], { cwd: root });
    if (old.status !== 0) throw new Error(String(old.stderr));
    fs.writeFileSync(path.join(root, file), old.stdout);
  }
  const run = spawnSync(process.execPath, ["--import", "tsx", "--test", "test/zaicodeT258Transcript.test.ts"], {
    cwd: path.join(root, "packages/ui"), encoding: "utf8", timeout: 60_000,
  });
  process.stdout.write(run.stdout); process.stderr.write(run.stderr);
  if (run.status !== 1 || !run.stdout.includes("fail 2")) throw new Error("Original disclosure owners must reject both Full assertions");
} finally { files.forEach((file, index) => fs.writeFileSync(path.join(root, file), originals[index])); }
