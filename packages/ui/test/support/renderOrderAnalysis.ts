import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Render-order (temporal dead zone) analysis.
 *
 * TypeScript reports a block-scoped variable used before its declaration only
 * when the use is not inside a nested function. `useMemo(() => <X y={later} />)`
 * is inside a nested function, so tsc accepts it, yet React calls that factory
 * synchronously during render: the read happens before `const later` has run and
 * the whole section dies with "Cannot access '<minified>' before initialization".
 * That is exactly how Wave 3 shipped an app that could not start (the packaged
 * bundle showed it as `Cannot access 'Pr' before initialization`).
 *
 * The analysis knows which callbacks run synchronously in the render path:
 * `useMemo`, `useState`, `useReducer` init, `useSyncExternalStore` snapshots,
 * immediately invoked functions and inline array-method callbacks. A callback
 * that is merely stored or handed to an event, an effect or `useCallback` runs
 * later, when every binding is initialised, and is deliberately not reported.
 */

export interface RenderOrderFinding {
  file: string;
  line: number;
  name: string;
  declarationLine: number;
  via: string;
}

/** Hooks whose callback arguments (by index) run during the call itself. */
const SYNC_HOOK_ARGUMENTS = new Map<string, readonly number[]>([
  ["useMemo", [0]],
  ["useState", [0]],
  ["useReducer", [2]],
  ["useSyncExternalStore", [1, 2]],
]);

const SYNC_ARRAY_METHODS = new Set([
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "forEach",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "some",
  "every",
  "flatMap",
  "sort",
  "toSorted",
]);

type FunctionLike =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function isInlineFunction(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return Boolean(node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)));
}

function unwrapParentheses(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function nearestScopeNode(node: ts.Node): ts.Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isFunctionLike(parent) || ts.isSourceFile(parent)) return parent;
  }
  return undefined;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Inline callbacks that run synchronously as part of `call`. */
function synchronousCallbacks(call: ts.CallExpression): { fn: ts.ArrowFunction | ts.FunctionExpression; via: string }[] {
  const found: { fn: ts.ArrowFunction | ts.FunctionExpression; via: string }[] = [];
  const callee = unwrapParentheses(call.expression);
  if (isInlineFunction(callee)) found.push({ fn: callee, via: "an immediately invoked function" });
  const name = calleeName(call);
  if (!name) return found;
  const hookArguments = SYNC_HOOK_ARGUMENTS.get(name);
  if (hookArguments && (ts.isIdentifier(call.expression) || ts.isPropertyAccessExpression(call.expression))) {
    for (const index of hookArguments) {
      const argument = call.arguments[index];
      if (isInlineFunction(argument)) found.push({ fn: argument, via: name });
    }
  } else if (ts.isPropertyAccessExpression(call.expression) && SYNC_ARRAY_METHODS.has(name)) {
    for (const argument of call.arguments) {
      if (isInlineFunction(argument)) found.push({ fn: argument, via: `.${name}()` });
    }
  }
  return found;
}

/** A nested function that runs as part of the enclosing synchronous callback. */
function runsSynchronously(fn: ts.Node): boolean {
  let child: ts.Node = fn;
  let parent = fn.parent;
  while (parent && ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (parent.expression === child) return true;
  return (
    ts.isPropertyAccessExpression(parent.expression) &&
    SYNC_ARRAY_METHODS.has(parent.expression.name.text) &&
    parent.arguments.includes(child as ts.Expression)
  );
}

function isTypePosition(node: ts.Node): boolean {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isTypeNode(ancestor) && !ts.isExpressionWithTypeArguments(ancestor)) return true;
    if (ts.isStatement(ancestor) || isFunctionLike(ancestor)) return false;
  }
  return false;
}

/** True for an identifier that reads a variable, not one that names a property or a declaration. */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isQualifiedName(parent) && parent.right === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (
    (ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (ts.isJsxAttribute(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return false;
  if (
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isJsxClosingElement(parent)
  ) {
    return false;
  }
  return !isTypePosition(id);
}

/** The `const`/`let`/`class` declaration behind a symbol, when it is not a parameter or an import. */
function blockScopedDeclaration(symbol: ts.Symbol): ts.Node | null {
  if (symbol.flags & ts.SymbolFlags.Alias) return null;
  for (const declaration of symbol.declarations ?? []) {
    if (ts.isClassDeclaration(declaration)) return declaration;
    let variable: ts.Node | undefined;
    if (ts.isVariableDeclaration(declaration)) variable = declaration;
    else if (ts.isBindingElement(declaration)) {
      let ancestor: ts.Node | undefined = declaration.parent;
      while (ancestor && (ts.isObjectBindingPattern(ancestor) || ts.isArrayBindingPattern(ancestor) || ts.isBindingElement(ancestor))) {
        ancestor = ancestor.parent;
      }
      if (ancestor && ts.isVariableDeclaration(ancestor)) variable = ancestor;
    }
    if (variable && ts.getCombinedNodeFlags(variable as ts.VariableDeclaration) & ts.NodeFlags.BlockScoped) return variable;
  }
  return null;
}

export function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") visit(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

/** Reads of a not-yet-initialised block-scoped variable by a callback that React runs during render. */
export function findRenderOrderViolations(files: readonly string[]): RenderOrderFinding[] {
  const program = ts.createProgram([...files], {
    // Binding is enough to resolve local symbols; following imports would cost
    // seconds per run for no gain, because only locals can be uninitialised.
    noResolve: true,
    noLib: true,
    skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const wanted = new Set(files.map((file) => ts.sys.resolvePath(file).replace(/\\/g, "/").toLowerCase()));
  const findings: RenderOrderFinding[] = [];
  const seen = new Set<string>();

  const symbolOf = (id: ts.Identifier): ts.Symbol | undefined =>
    ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
      ? checker.getShorthandAssignmentValueSymbol(id.parent)
      : checker.getSymbolAtLocation(id);

  for (const sourceFile of program.getSourceFiles()) {
    if (!wanted.has(sourceFile.fileName.replace(/\\/g, "/").toLowerCase())) continue;
    const lineOf = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line + 1;

    const checkCallback = (callback: ts.Node, scope: ts.Node, call: ts.CallExpression, via: string) => {
      const visit = (node: ts.Node) => {
        if (isFunctionLike(node) && node !== callback && !runsSynchronously(node)) return;
        if (ts.isIdentifier(node) && isValueReference(node)) {
          const symbol = symbolOf(node);
          const declaration = symbol ? blockScopedDeclaration(symbol) : null;
          if (declaration && nearestScopeNode(declaration) === scope && declaration.getEnd() > call.getStart(sourceFile)) {
            const key = `${sourceFile.fileName}:${node.getStart(sourceFile)}`;
            if (!seen.has(key)) {
              seen.add(key);
              findings.push({
                file: sourceFile.fileName,
                line: lineOf(node.getStart(sourceFile)),
                name: node.text,
                declarationLine: lineOf(declaration.getStart(sourceFile)),
                via,
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(callback);
    };

    const scanScope = (scope: ts.Node) => {
      const walk = (node: ts.Node) => {
        if (node !== scope && isFunctionLike(node)) return;
        if (ts.isCallExpression(node)) {
          for (const { fn, via } of synchronousCallbacks(node)) checkCallback(fn, scope, node, via);
        }
        ts.forEachChild(node, walk);
      };
      ts.forEachChild(scope, walk);
    };

    const findScopes = (node: ts.Node) => {
      if (isFunctionLike(node) && node.body) scanScope(node);
      ts.forEachChild(node, findScopes);
    };
    findScopes(sourceFile);
  }
  return findings;
}
