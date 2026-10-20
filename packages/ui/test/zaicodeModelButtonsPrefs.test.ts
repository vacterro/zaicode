import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  ZAICODE_COMPOSER_MODEL_BUTTONS_STORAGE_KEY,
  normalizeZaicodeComposerModelButtonsPrefs,
  useZaicodeComposerModelButtonsPrefs,
} from "../src/zaicode/zaicodeComposerModelButtonsPrefs.js";
import {
  ZAICODE_MODEL_BUTTONS_MAX,
  zaicodeFilterVisibleModelButtons,
  zaicodeToolbarModelButtons,
  type ZaicodeModelButton,
} from "../src/zaicode/zaicodeModelButtonsModel.js";
import {
  ZAICODE_ENGINE_BAR_MAX_MODELS,
  useZaicodeEngineBarPrefs,
} from "../src/zaicode/zaicodeEngineBarPrefs.js";

type Globals = { __ZAICODE_PRODUCT_MODE__?: boolean };
const globals = globalThis as Globals;
let savedMode: boolean | undefined;

beforeEach(() => {
  savedMode = globals.__ZAICODE_PRODUCT_MODE__;
  globals.__ZAICODE_PRODUCT_MODE__ = true;
  useZaicodeComposerModelButtonsPrefs.getState().reset();
  try {
    localStorage.clear();
  } catch {
    // sandbox
  }
});

afterEach(() => {
  if (savedMode === undefined) delete globals.__ZAICODE_PRODUCT_MODE__;
  else globals.__ZAICODE_PRODUCT_MODE__ = savedMode;
  useZaicodeComposerModelButtonsPrefs.getState().reset();
});

const sampleButtons: readonly ZaicodeModelButton[] = [
  { value: "SAIRoute/SAIFREN", label: "SAIFREN", title: "SAIRoute · SAIFREN", owner: "SAIRoute" },
  { value: "SAIRoute/SAIOPP", label: "SAIOPP", title: "SAIRoute · SAIOPP", owner: "SAIRoute" },
  { value: "Z.ai/GLM-5", label: "GLM-5", title: "Z.ai · GLM-5", owner: "Z.ai" },
  { value: "Anthropic/claude-3-5", label: "claude-3-5", title: "Anthropic · claude-3-5", owner: "Anthropic" },
];

test("normalization cleanses and deduplicates hidden buttons", () => {
  assert.deepEqual(normalizeZaicodeComposerModelButtonsPrefs(null), { hiddenButtons: null });
  assert.deepEqual(normalizeZaicodeComposerModelButtonsPrefs({}), { hiddenButtons: null });
  assert.deepEqual(
    normalizeZaicodeComposerModelButtonsPrefs({
      hiddenButtons: ["SAIRoute/SAIFREN", "  ", "", "SAIRoute/SAIFREN", "Z.ai/GLM-5"],
    }),
    { hiddenButtons: ["SAIRoute/SAIFREN", "Z.ai/GLM-5"] },
  );
});

test("toggling button visibility updates hiddenButtons and resets correctly", () => {
  const store = useZaicodeComposerModelButtonsPrefs.getState();
  assert.equal(store.hiddenButtons, null);

  // Hide one button
  store.toggleButton("SAIRoute/SAIFREN", false);
  assert.deepEqual(useZaicodeComposerModelButtonsPrefs.getState().hiddenButtons, [
    "SAIRoute/SAIFREN",
  ]);

  // Hide second button
  store.toggleButton("Z.ai/GLM-5", false);
  assert.deepEqual(useZaicodeComposerModelButtonsPrefs.getState().hiddenButtons, [
    "SAIRoute/SAIFREN",
    "Z.ai/GLM-5",
  ]);

  // Show first button again
  store.toggleButton("SAIRoute/SAIFREN", true);
  assert.deepEqual(useZaicodeComposerModelButtonsPrefs.getState().hiddenButtons, [
    "Z.ai/GLM-5",
  ]);

  // Reset to defaults
  store.reset();
  assert.equal(useZaicodeComposerModelButtonsPrefs.getState().hiddenButtons, null);
});

test("zaicodeFilterVisibleModelButtons hides unchecked buttons but preserves currently selected model", () => {
  // With no prefs, all show
  const all = zaicodeFilterVisibleModelButtons(sampleButtons, null);
  assert.equal(all.length, 4);

  // Hide SAIFREN and claude-3-5
  const filtered = zaicodeFilterVisibleModelButtons(
    sampleButtons,
    { hiddenButtons: ["SAIRoute/SAIFREN", "Anthropic/claude-3-5"] },
    "SAIRoute/SAIOPP", // selected is SAIOPP
  );
  assert.deepEqual(
    filtered.map((b) => b.value),
    ["SAIRoute/SAIOPP", "Z.ai/GLM-5"],
  );

  // Selected model is SAIFREN (which is in hiddenButtons!) -> MUST BE PRESERVED
  const preserved = zaicodeFilterVisibleModelButtons(
    sampleButtons,
    { hiddenButtons: ["SAIRoute/SAIFREN", "Anthropic/claude-3-5"] },
    "SAIRoute/SAIFREN",
  );
  assert.deepEqual(
    preserved.map((b) => b.value),
    ["SAIRoute/SAIFREN", "SAIRoute/SAIOPP", "Z.ai/GLM-5"],
  );
});

test("zaicodeToolbarModelButtons falls back to null (retaining model picker) when all buttons are hidden", () => {
  const groups = [
    {
      key: "SAIRoute",
      label: "SAIRoute",
      items: [
        { key: "fren", value: "SAIRoute/SAIFREN", name: "SAIFREN" },
        { key: "opp", value: "SAIRoute/SAIOPP", name: "SAIOPP" },
      ],
    },
  ];

  // Default: returns 2 buttons
  const defaults = zaicodeToolbarModelButtons(groups);
  assert.equal(defaults?.length, 2);

  // Hide both with no selected model matching
  const allHidden = zaicodeToolbarModelButtons(
    groups,
    { hiddenButtons: ["SAIRoute/SAIFREN", "SAIRoute/SAIOPP"] },
    "some-other-model",
  );
  assert.equal(allHidden, null);

  // Hide both BUT SAIFREN is selected -> preserves SAIFREN so row is never empty
  const preserved = zaicodeToolbarModelButtons(
    groups,
    { hiddenButtons: ["SAIRoute/SAIFREN", "SAIRoute/SAIOPP"] },
    "SAIRoute/SAIFREN",
  );
  assert.equal(preserved?.length, 1);
  assert.equal(preserved?.[0]?.value, "SAIRoute/SAIFREN");
});

test("storage separation: composer buttons and engine bar use distinct storage keys and thresholds", () => {
  assert.equal(ZAICODE_COMPOSER_MODEL_BUTTONS_STORAGE_KEY, "zaicode-composer-model-buttons-v1");
  assert.equal(ZAICODE_MODEL_BUTTONS_MAX, 6);
  assert.equal(ZAICODE_ENGINE_BAR_MAX_MODELS, 8);

  const composerStore = useZaicodeComposerModelButtonsPrefs.getState();
  const engineStore = useZaicodeEngineBarPrefs.getState();

  composerStore.update({ hiddenButtons: ["SAIRoute/SAIFREN"] });
  assert.deepEqual(useZaicodeComposerModelButtonsPrefs.getState().hiddenButtons, [
    "SAIRoute/SAIFREN",
  ]);

  // Engine bar preferences must remain untouched
  assert.equal(useZaicodeEngineBarPrefs.getState().showSubs, engineStore.showSubs);
});
