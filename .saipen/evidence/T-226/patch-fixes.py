#!/usr/bin/env python3
"""T-226 fixes applied to the zcode working tree (run from workspace root).

1. Ctrl+Alt+B toggles the SAIPEN side pane again: the Usage sidebar default
   moves off the key, the old stored default is migrated once, conflict
   detection no longer hides the deliberate rebinding case.
2. Bevels on list rows: generic raised/pressed rules stop matching workspace
   rows, so the sub-toggle really toggles them in every presentation.
3. Save All allowlist: the durable families the T-223 audit named but the
   first allowlist missed (their stores read through readZaicodeSetting).
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path("zcode")
CRLF = "\r\n"


def patch(rel: str, edits: list[tuple[str, str]]) -> None:
    path = ROOT / rel
    with open(path, "r", encoding="utf-8", newline="") as handle:
        text = handle.read()
    for old, new in edits:
        count = text.count(old)
        if count != 1:
            print(f"MISMATCH {rel}: {count} matches for {old[:80]!r}", file=sys.stderr)
            sys.exit(1)
        text = text.replace(old, new, 1)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    print(f"patched {rel}")


# ---------------------------------------------------------------- fix 1
hotkeys = "packages/ui/src/zaicode/zaicodeHotkeys.ts"
MIGRATION = """const CHANGE_EVENT = "zaicode-hotkeys-changed";
/**
 * T-226 / SRC-156: the old default bound the Usage sidebar to Ctrl+Alt+B, the
 * historical side-pane key. The capture-phase dispatcher consumes a matching
 * ZAICODE action before the upstream listener sees it, so the SAIPEN side pane
 * could not be toggled with its own key. This one-shot marker moves a stored
 * OLD DEFAULT off the key exactly once; a deliberate rebinding afterwards is
 * respected, and the key now falls through to the upstream pane toggle (the
 * Always-everywhere / per-project visibility policy rides on it).
 */
const SIDE_PANE_KEY_REV = "zaicode-hotkeys-sidepane-rev";
const SIDE_PANE_KEY_REVALUE = "1";

function migrateStoredSidePaneHotkey(raw: string | null): string | null {
  try {
    if (typeof localStorage === "undefined") return raw;
    if (localStorage.getItem(SIDE_PANE_KEY_REV) === SIDE_PANE_KEY_REVALUE) return raw;
    localStorage.setItem(SIDE_PANE_KEY_REV, SIDE_PANE_KEY_REVALUE);
    if (!raw) return raw;
    const parsed = JSON.parse(raw) as { bindings?: Record<string, unknown> } | null;
    const bindings = parsed?.bindings;
    const usage = bindings?.["ui.usageSidebar"];
    if (!bindings || !Array.isArray(usage) || usage[0] !== "Ctrl+Alt+B") return raw;
    const next = JSON.stringify({
      ...parsed,
      bindings: { ...bindings, "ui.usageSidebar": ["", String(usage[1] ?? "")] },
    });
    localStorage.setItem(STORAGE_KEY, next);
    return next;
  } catch {
    return raw;
  }
}"""

patch(
    hotkeys,
    [
        (
            'hint: "Show or hide 9router Usage beside the chat", defaults: ["Ctrl+Alt+B", ""] },',
            'hint: "Show or hide 9router Usage beside the chat", defaults: ["", ""] },',
        ),
        (
            "    // Usage deliberately owns the old side-pane key in ZAICODE. The capture-phase\n"
            "    // dispatcher stops this event before the upstream listener; other assignments still conflict.\n"
            '    const usageOwnsSidePane = binding === "Ctrl+Alt+B" && unique.length === 1 && unique[0] === "ui.usageSidebar" && upstream.get(binding) === "toggleSidePane";\n'
            "    const shadowed = usageOwnsSidePane ? null : upstream.get(binding) ?? null;\n",
            "    const shadowed = upstream.get(binding) ?? null;\n",
        ),
        ('const CHANGE_EVENT = "zaicode-hotkeys-changed";', MIGRATION),
        (
            '    cached = normalizeZaicodeHotkeySettings(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));',
            '    const stored = migrateStoredSidePaneHotkey(readZaicodeSetting(STORAGE_KEY));\n'
            '    cached = normalizeZaicodeHotkeySettings(JSON.parse(stored ?? "null"));',
        ),
    ],
)

# ---------------------------------------------------------------- fix 2
bevels = "packages/ui/src/zaicode/zaicodeBevels.ts"
ROWS_DOC = '''/**
 * Sidebar rows (sub-option "list rows"): raised like FastPrompter's list; the
 * open one sunken. The generic raised/pressed rules above exclude the same row
 * prefix, so this sub-toggle owns the rows in every presentation: OFF is flat
 * (under Classic the generic role=button bevel used to keep them raised, which
 * is why the toggle looked dead) and ON outranks the presentation shadow kill.
 */'''

patch(
    bevels,
    [
        (
            "  '[role=\"button\"]',",
            "  '[role=\"button\"]:not([data-testid^=\"workspace-item-\"]),",
        ),
        (
            "  '[role=\"button\"]:active',",
            "  '[role=\"button\"]:active:not([data-testid^=\"workspace-item-\"]),",
        ),
        (
            '/** Sidebar rows (sub-option "list rows"): raised like FastPrompter\'s list; the open one sunken. */',
            ROWS_DOC,
        ),
    ],
)

# ---------------------------------------------------------------- fix 3
NEW_FAMILIES = [
    "zaicode-auto-continue-v1",
    "zaicode-auto-goal-v1",
    "zaicode-autostart-v1",
    "zaicode-change-floaters-v1",
    "zaicode-dispatch-prefs-v1",
    "zaicode-engine-bar-v1",
    "zaicode-header-title-v1",
    "zaicode-home-v1",
    "zaicode-icon-profiles-v1",
    "zaicode-size",
    "zaicode-presentation",
    "zaicode-active-engine",
    "zaicode-scheduler-marks-v1",
    "zaicode-session-text-v1",
    "zaicode-session-text-presets-v1",
    "zaicode-saipeggle-v1",
    "zaicode-presets-v1",
]
NOTE = (
    "  // T-226: the durable families the T-223 audit named but the first allowlist"
    + CRLF
    + "  // missed; each one's store reads through readZaicodeSetting, so the snapshot"
    + CRLF
    + "  // default actually lands (the other named families read raw localStorage and"
    + CRLF
    + "  // would be dead entries until their readers move to readZaicodeSetting)."
)
ADDED = CRLF.join(f'  "{key}",' for key in NEW_FAMILIES)

snapshot = "packages/ui/src/zaicode/zaicodeSettingsSnapshot.ts"
patch(
    snapshot,
    [
        (
            '  "zaicode-composer-prefs-v1",' + CRLF + '  "zaicode-saiasui-settings-v1",' + CRLF + '  "zaicode-protrail-v1",' + CRLF + "] as const;",
            '  "zaicode-composer-prefs-v1",'
            + CRLF
            + '  "zaicode-saiasui-settings-v1",'
            + CRLF
            + '  "zaicode-protrail-v1",'
            + CRLF
            + NOTE
            + CRLF
            + ADDED
            + CRLF
            + "] as const;",
        ),
    ],
)

t223 = "packages/ui/test/zaicodeT223SaveAllCoverage.test.ts"
patch(
    t223,
    [
        (
            '  "zaicode-composer-prefs-v1",' + CRLF + '  "zaicode-saiasui-settings-v1",' + CRLF + '  "zaicode-protrail-v1",' + CRLF + "];",
            '  "zaicode-composer-prefs-v1",'
            + CRLF
            + '  "zaicode-saiasui-settings-v1",'
            + CRLF
            + '  "zaicode-protrail-v1",'
            + CRLF
            + ADDED
            + CRLF
            + "];",
        ),
    ],
)

# ---------------------------------------------------------------- test pins
T225_ADDITION = CRLF + CRLF.join(
    [
        'test("T-226: the generic bevel rules leave the list rows to the rows sub-toggle", () => {',
        "  // OFF must mean flat in every presentation. Before T-226 the generic",
        "  // role=button raised rule matched the workspace row (div[role=button]) even",
        "  // with the rows class absent, so under Classic the toggle changed nothing.",
        "  assert.ok(",
        "    bevels.includes(`'[role=\"button\"]:not([data-testid^=\"workspace-item-\"])`),",
        '    "generic raised rule must exclude workspace rows",',
        "  );",
        "  assert.ok(",
        "    bevels.includes(`'[role=\"button\"]:active:not([data-testid^=\"workspace-item-\"])`),",
        '    "generic pressed rule must exclude workspace rows",',
        "  );",
        "  assert.ok(",
        "    !bevels.includes(`'[role=\"button\"]',`),",
        '    "no bare role=button entry may match a workspace row",',
        "  );",
        "});",
    ]
)

t225 = "packages/ui/test/zaicodeT225BevelRows.test.ts"
T225_TAIL = (
    '`shared test-ids must define the "${base}" base or the selector matches nothing`,'
    + CRLF
    + "    );"
    + CRLF
    + "  }"
    + CRLF
    + "});"
    + CRLF
)
patch(t225, [(T225_TAIL, T225_TAIL + T225_ADDITION + CRLF)])

hotkey_test = ROOT / "packages/ui/test/zaicodeT226HotkeySidePane.test.ts"
HOTKEY_TEST_LINES = CRLF.join(
        [
            "// T-226 / SRC-156 -- Ctrl+Alt+B toggles the SAIPEN side pane again.",
            "//",
            "// The old default bound the Usage sidebar to the historical side-pane key,",
            "// so the capture-phase ZAICODE dispatcher consumed Ctrl+Alt+B and the",
            "// upstream toggleSidePane (the right-side pane with the SAIPEN tab, whose",
            "// persistence is the Always-everywhere / per-project policy) never fired.",
            "// These tests pin: the default leaves the key free, the upstream map still",
            "// answers toggleSidePane on it, the old stored default is migrated once and",
            "// a deliberate rebinding afterwards is respected, and a deliberate Usage",
            "// binding on the key surfaces as a conflict instead of being hidden.",
            'import assert from "node:assert/strict";',
            'import test from "node:test";',
            "import {",
            "  defaultZaicodeHotkeySettings,",
            "  findZaicodeHotkeyConflicts,",
            "  readZaicodeHotkeySettings,",
            "  reloadZaicodeHotkeys,",
            "  ZAICODE_HOTKEY_ACTIONS,",
            "  zaicodeUpstreamShortcutBindings,",
            '} from "@/zaicode/zaicodeHotkeys.js";',
            "",
            'const SIDE_PANE_KEY = "Ctrl+Alt+B";',
            'const REV_KEY = "zaicode-hotkeys-sidepane-rev";',
            'const STORAGE_KEY = "zaicode-hotkeys-v1";',
            "",
            "interface StorageMock {",
            "  values: Map<string, string>;",
            "  restore: () => void;",
            "}",
            "",
            "function mockLocalStorage(initial: Record<string, string>): StorageMock {",
            "  const values = new Map(Object.entries(initial));",
            '  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");',
            '  Object.defineProperty(globalThis, "localStorage", {',
            "    configurable: true,",
            "    value: {",
            "      getItem: (key: string) => values.get(key) ?? null,",
            "      setItem: (key: string, value: string) => {",
            "        values.set(key, String(value));",
            "      },",
            "      removeItem: (key: string) => {",
            "        values.delete(key);",
            "      },",
            "    },",
            "  });",
            "  return {",
            "    values,",
            "    restore: () => {",
            '      if (previous) Object.defineProperty(globalThis, "localStorage", previous);',
            '      else Reflect.deleteProperty(globalThis, "localStorage");',
            "    },",
            "  };",
            "}",
            "",
            'test("T-226: no ZAICODE action owns Ctrl+Alt+B by default; the side pane does", () => {',
            "  for (const action of ZAICODE_HOTKEY_ACTIONS) {",
            "    assert.ok(",
            "      !action.defaults.includes(SIDE_PANE_KEY),",
            "      `${action.id} must not take ${SIDE_PANE_KEY} from the side pane`,",
            "    );",
            "  }",
            "  assert.equal(",
            "    zaicodeUpstreamShortcutBindings().get(SIDE_PANE_KEY),",
            '    "toggleSidePane",',
            "  );",
            "  assert.deepEqual(",
            '    defaultZaicodeHotkeySettings().bindings["ui.usageSidebar"],',
            '    ["", ""],',
            "  );",
            "});",
            "",
            'test("T-226: the old stored default moves off Ctrl+Alt+B exactly once", () => {',
            "  const oldStored = JSON.stringify({",
            "    enabled: true,",
            '    fKeys: "off",',
            '    bindings: { "ui.usageSidebar": [SIDE_PANE_KEY, ""] },',
            "  });",
            "  const mock = mockLocalStorage({ [STORAGE_KEY]: oldStored });",
            "  try {",
            "    reloadZaicodeHotkeys();",
            '    assert.deepEqual(readZaicodeHotkeySettings().bindings["ui.usageSidebar"], ["", ""]);',
            '    assert.equal(mock.values.get(REV_KEY), "1");',
            "    // A deliberate rebinding after the migration is respected, not migrated again.",
            "    mock.values.set(STORAGE_KEY, oldStored);",
            "    reloadZaicodeHotkeys();",
            '    assert.deepEqual(readZaicodeHotkeySettings().bindings["ui.usageSidebar"], [SIDE_PANE_KEY, ""]);',
            "  } finally {",
            "    mock.restore();",
            "    reloadZaicodeHotkeys();",
            "  }",
            "  // Another key was never touched by the migration in the first place.",
            "  const other = JSON.stringify({",
            "    enabled: true,",
            '    fKeys: "off",',
            '    bindings: { "ui.usageSidebar": ["Ctrl+Alt+U", ""] },',
            "  });",
            "  const fresh = mockLocalStorage({ [STORAGE_KEY]: other });",
            "  try {",
            "    reloadZaicodeHotkeys();",
            '    assert.deepEqual(readZaicodeHotkeySettings().bindings["ui.usageSidebar"], ["Ctrl+Alt+U", ""]);',
            "  } finally {",
            "    fresh.restore();",
            "    reloadZaicodeHotkeys();",
            "  }",
            "});",
            "",
            'test("T-226: a deliberate Usage binding on the pane key is reported, not hidden", () => {',
            "  const conflicts = findZaicodeHotkeyConflicts({",
            "    enabled: true,",
            '    fKeys: "off",',
            '    bindings: { "ui.usageSidebar": [SIDE_PANE_KEY, ""] },',
            "  });",
            "  const conflict = conflicts.find((entry) => entry.binding === SIDE_PANE_KEY);",
            '  assert.ok(conflict, "Ctrl+Alt+B must surface as a conflict when Usage takes it");',
            '  assert.deepEqual(conflict.actions, ["ui.usageSidebar"]);',
            '  assert.equal(conflict.upstream, "toggleSidePane");',
            "});",
            "",
        ]
    )
with open(hotkey_test, "w", encoding="utf-8", newline="") as handle:
    handle.write(HOTKEY_TEST_LINES)
print(f"wrote {hotkey_test.relative_to(ROOT.parent)}")
