import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/**
 * Ports for tests that run the real ProTrail main module (zaicodeProtrailGlobal.ts) in a vm with a fake
 * `require`: the module's own imports have to be answered, and its pure neighbour, the overlay health
 * rules, is loaded from source rather than faked, so a test sees the real repair decisions.
 */

const mainDir = join(import.meta.dirname, "../../src/main");

/** A `.ts` module of src/main that imports nothing at runtime, compiled and evaluated in isolation. */
export function loadPureMainModule(fileName: string): Record<string, unknown> {
  const source = readFileSync(join(mainDir, fileName), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled, { exports });
  return exports;
}

/** The overlay health rules, for the module's `./zaicodeProtrailHealth.js` import. */
export function healthPort(): Record<string, unknown> {
  return loadPureMainModule("zaicodeProtrailHealth.ts");
}
