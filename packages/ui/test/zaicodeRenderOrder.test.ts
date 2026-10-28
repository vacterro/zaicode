import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findRenderOrderViolations, listSourceFiles } from "./support/renderOrderAnalysis.js";

/**
 * Render order (Wave 3 regression: "Cannot access 'Pr' before initialization").
 *
 * `useMemo(() => <Watcher files={gitSpawnFiles} />)` ran during render, but
 * `const gitSpawnFiles` was declared 330 lines further down the component. tsc
 * accepts a read inside a closure, the 765 unit tests never render the shell,
 * and the packaged app opened on an error card. The gate below reads every
 * source file and refuses a synchronous render callback that touches a
 * block-scoped variable before it exists. It fails loudly instead of
 * shipping a window that cannot start.
 */

const PACKAGES = join(import.meta.dirname, "..", "..");

function analyse(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "zaicode-render-order-"));
  try {
    const file = join(directory, "Snippet.tsx");
    writeFileSync(file, source);
    return findRenderOrderViolations([file]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const names = (source: string) => analyse(source).map((finding) => `${finding.name}@${finding.via}`);

test("the shipped Wave 3 bug is reported: a useMemo factory reads a const declared below it", () => {
  const found = analyse(`
    import { useMemo } from "react";
    export function Shell() {
      const header = useMemo(() => <Watcher files={gitSpawnFiles} />, []);
      const gitSpawnFiles = useMemo(() => [], []);
      return header;
    }
  `);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.name, "gitSpawnFiles");
  assert.equal(found[0]!.via, "useMemo");
  assert.equal(found[0]!.line, 4);
  assert.equal(found[0]!.declarationLine, 5);
});

test("every synchronous render callback shape is covered, not just useMemo", () => {
  assert.deepEqual(
    names(`
      import { useState } from "react";
      export function A() {
        const [value] = useState(() => later);
        const later = 1;
        return value;
      }`),
    ["later@useState"],
    "useState initializer",
  );
  assert.deepEqual(
    names(`
      import { useReducer } from "react";
      export function A() {
        const [state] = useReducer((s: number) => s, 0, () => later);
        const later = 1;
        return state;
      }`),
    ["later@useReducer"],
    "useReducer init",
  );
  assert.deepEqual(
    names(`
      import * as React from "react";
      export function A() {
        const value = React.useMemo(() => later, []);
        const later = 1;
        return value;
      }`),
    ["later@useMemo"],
    "React.useMemo",
  );
  assert.deepEqual(
    names(`
      export function A() {
        const value = (() => later)();
        const later = 1;
        return value;
      }`),
    ["later@an immediately invoked function"],
    "immediately invoked function",
  );
  assert.deepEqual(
    names(`
      export function A(items: number[]) {
        const rows = items.map((item) => item + offset);
        const offset = 1;
        return rows;
      }`),
    ["offset@.map()"],
    "inline array callback",
  );
  assert.deepEqual(
    names(`
      import { useMemo } from "react";
      export function A(items: number[]) {
        return useMemo(() => items.map((item) => item + offset), [items]);
        const offset = 1;
      }`),
    ["offset@useMemo"],
    "array callback nested in a factory",
  );
  assert.deepEqual(
    names(`
      import { useMemo } from "react";
      export function A() {
        const value = useMemo(() => value + 1, []);
        return value;
      }`),
    ["value@useMemo"],
    "a memo that reads its own result",
  );
  assert.deepEqual(
    names(`
      import { useMemo } from "react";
      export function A() {
        const bag = useMemo(() => ({ later }), []);
        const later = 1;
        return bag;
      }`),
    ["later@useMemo"],
    "shorthand property",
  );
  assert.deepEqual(
    names(`
      import { useMemo } from "react";
      export function A() {
        const value = useMemo(() => first + second, []);
        const [first, second] = [1, 2];
        return value;
      }`),
    ["first@useMemo", "second@useMemo"],
    "destructured declaration",
  );
});

test("code that runs later is not reported: the variable exists by then", () => {
  assert.deepEqual(
    names(`
      import { useCallback, useEffect, useMemo } from "react";
      export function A() {
        const onPick = useCallback(() => later, []);
        useEffect(() => { void later; }, []);
        const node = useMemo(() => <button onClick={() => later} />, []);
        const timer = () => setTimeout(() => later, 1);
        const stored = () => later;
        const later = 1;
        return [onPick, node, timer, stored];
      }`),
    [],
    "callbacks, effects, handlers and stored closures",
  );
  assert.deepEqual(
    names(`
      import { useMemo } from "react";
      export function A() {
        const early = 1;
        const value = useMemo(() => early, []);
        return value;
      }`),
    [],
    "a variable declared above",
  );
});

test("shadowing, names that are not reads, types and hoisting do not fool it", () => {
  assert.deepEqual(
    names(`
      import { useMemo } from "react";
      export function A(items: number[]) {
        const a = useMemo(() => items.map((later) => later), [items]);
        const b = useMemo(() => { const later = 1; return later; }, []);
        const c = useMemo(() => ({ later: 1 }).later, []);
        const d = useMemo(() => ({}) as typeof later, []);
        const e = useMemo(() => later2(), []);
        const f = useMemo(() => legacy, []);
        function later2() { return 1; }
        var legacy = 1;
        const later = 1;
        return [a, b, c, d, e, f];
      }`),
    [],
  );
});

test("no synchronous render callback in the product reads a variable before it is initialised", () => {
  const roots = ["ui", "desktop", "shared", "services", "web", "client"].map((name) => join(PACKAGES, name, "src"));
  const files = roots.flatMap((root) => listSourceFiles(root));
  assert.ok(files.length > 1500, `the scan must see the whole tree, saw ${files.length} files`);
  const findings = findRenderOrderViolations(files);
  assert.deepEqual(
    findings.map(
      (finding) =>
        `${finding.file.replace(/\\/g, "/").replace(/^.*\/packages\//, "packages/")}:${finding.line} reads '${finding.name}' in ${finding.via} before its declaration on line ${finding.declarationLine}`,
    ),
    [],
  );
});
