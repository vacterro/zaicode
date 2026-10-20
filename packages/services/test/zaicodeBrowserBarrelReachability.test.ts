import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * The root entry `@zcode/services` is imported by the renderer as a VALUE
 * (remoteServiceAccess.ts reads descriptor `.channelName` off it), so every
 * value export behind that barrel is bundled into the browser chunk. One
 * Node-only implementation module is enough to kill the whole app at module
 * initialization: T-296's staged build died on
 * `TypeError: (0, lEt.homedir) is not a function` because the barrel
 * re-exported `ZaicodeAuditLoopService`, which imports `getAppConfigDir` from
 * `../paths.js`, which calls `homedir()` at module scope.
 *
 * This walks the barrel's value-only relative import graph and fails when any
 * of it reaches a `node:` builtin. Type-only statements are erased by the
 * bundler and are followed by nothing.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES_SRC = resolve(HERE, "..", "src");
const ROOT_ENTRY = join(SERVICES_SRC, "index.ts");
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function valueSpecifiers(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier;
      if (!ts.isStringLiteral(specifier)) continue;
      const clause = statement.importClause;
      // `import type ...` is erased; a bare `import "./x.js"` is a kept side effect.
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        if (bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)) {
          continue;
        }
      }
      specifiers.push(specifier.text);
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        if (clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)) {
          continue;
        }
      }
      specifiers.push(specifier.text);
    }
  }
  return specifiers;
}

function resolveRelative(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  const stem = EXTENSIONS.some((extension) => base.endsWith(extension))
    ? base.slice(0, base.lastIndexOf("."))
    : base;
  const candidates = [
    ...EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...EXTENSIONS.map((extension) => join(stem, `index${extension}`)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Every `node:` builtin the value graph under `entry` can reach, with its importer. */
export function reachableNodeBuiltins(entry: string): { file: string; specifier: string }[] {
  const seen = new Set<string>();
  const leaks: { file: string; specifier: string }[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const specifier of valueSpecifiers(file, readFileSync(file, "utf8"))) {
      if (specifier.startsWith("node:")) {
        leaks.push({ file, specifier });
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelative(file, specifier);
      if (target) pending.push(target);
    }
  }
  return leaks;
}

test("the browser-safe @zcode/services barrel reaches no node: builtin", () => {
  assert.deepEqual(
    reachableNodeBuiltins(ROOT_ENTRY).map((leak) => `${leak.file} -> ${leak.specifier}`),
    [],
    "a value export behind the renderer-visible barrel must not reach a node: builtin",
  );
});

test("the walker follows a value re-export and erases type-only ones (negative control)", () => {
  const root = mkdtempSync(join(tmpdir(), "zcode-barrel-walk-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "impl.ts"), 'import { homedir } from "node:os";\nexport const impl = homedir;\n');
    writeFileSync(join(root, "nested", "u.ts"), 'import { tmpdir } from "node:os";\nexport type U = string;\n');
    writeFileSync(join(root, "nested", "v.ts"), 'import { userInfo } from "node:os";\nexport type V = string;\n');
    writeFileSync(
      join(root, "entry.ts"),
      [
        'export { impl } from "./impl.js";',
        'export type { U } from "./nested/u.js";',
        'export { type V } from "./nested/v.js";',
      ].join("\n"),
    );
    assert.deepEqual(
      reachableNodeBuiltins(join(root, "entry.ts")).map((leak) => leak.specifier),
      ["node:os"],
      "the value re-export is followed; type-only statements are erased and are not followed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
