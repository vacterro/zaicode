import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  ZAICODE_ORGANIZATION_DEFAULTS,
  ZAICODE_UNFILED,
  createFolder,
  deleteFolder,
  folderCounts,
  folderOfProject,
  groupProjectsByFolder,
  isPinned,
  mintProjectId,
  moveProjectToFolder,
  normalizeProjectOrganization,
  orderProjectRows,
  renameFolder,
  reorderFolders,
  resolveProjectId,
  setFolderCollapsed,
  setPinned,
  type ZaicodeProjectOrganization,
} from "@/zaicode/zaicodeProjectFolders.js";
import {
  ZAICODE_PROJECT_DESTRUCTIVE_LABELS,
  buildProjectOrganizationView,
  describeMoveTarget,
  isFolderHidingRows,
  moveTargetsFor,
  orderSectionTabs,
} from "@/zaicode/zaicodeProjectOrganization.js";
import {
  ZAICODE_MODEL_APPEARANCE_DEFAULTS,
  ZAICODE_MODEL_APPEARANCE_KEYS,
  normalizeZaicodeModelAppearancePrefs,
  parseZaicodeModelIdentity,
  resolveZaicodeModelAppearance,
  readZaicodeModelAppearancePrefs,
  resolveZaicodeWorkerIconUrl,
  setZaicodeGlobalAppearance,
  setZaicodeModelAppearance,
  zaicodeModelIdentityKey,
} from "@/zaicode/zaicodeModelAppearance.js";

/**
 * Wave 4: virtual folders, pins, and per-model appearance. The invariants
 * that matter are the ones a user would notice being violated: a folder action
 * that touches the disk, a deleted folder that takes its projects with it, a
 * pin that changes grouping, and an appearance that follows the picker
 * instead of the work.
 */

const SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "zaicodeProjectFolders.ts"), "utf8");

const org = (patch: Partial<ZaicodeProjectOrganization> = {}): ZaicodeProjectOrganization => ({
  ...ZAICODE_ORGANIZATION_DEFAULTS,
  ...patch,
});

const withFolders = () => {
  let state = org();
  state = createFolder(state, "Daily drivers");
  state = createFolder(state, "Long shots");
  return state;
};

test("Wave 4 A: organizing a project never touches the filesystem", () => {
  // The guarantee, asserted on the source rather than promised in a comment:
  // there is no way for this module to move, rename or delete a directory.
  assert.doesNotMatch(SOURCE, /renameSync|rmdirSync|unlinkSync|rmSync|copyFile|mkdirSync|createWriteStream/);
  assert.doesNotMatch(SOURCE, /from "node:fs"|from "fs"|require\(["']fs["']\)/);
  assert.match(SOURCE, /localStorage/, "it persists organization, not files");
});

test("Wave 4 A: a project gets a stable id, and the same key always mints the same one", () => {
  const first = mintProjectId({}, "C:/work/zaicode");
  assert.match(first, /^project-/);
  assert.equal(mintProjectId({ "C:/work/zaicode": first }, "C:/work/zaicode"), first);
  // A dropped store cannot re-order a project by inventing a new id.
  assert.equal(mintProjectId({}, "C:/work/zaicode"), first);
  assert.notEqual(mintProjectId({}, "C:/work/other"), first);
  assert.equal(resolveProjectId(org(), "C:/work/x"), resolveProjectId(org(), "C:/work/x"));
});

test("Wave 4 A: create, rename and reorder folders, with stable ids and a persistent order", () => {
  let state = withFolders();
  assert.deepEqual(state.folders.map((folder) => folder.name), ["Daily drivers", "Long shots"]);
  const [first, second] = state.folders;
  assert.ok(first && second);

  const renamed = renameFolder(state, first!.id, "  Everyday   work  ");
  assert.equal(renamed.folders[0]!.name, "Everyday work", "the name is cleaned, not stored raw");
  assert.equal(renamed.folders[0]!.id, first!.id, "renaming keeps the id, so membership survives");

  const reordered = reorderFolders(renamed, [second!.id, first!.id]);
  assert.deepEqual(reordered.folders.map((folder) => folder.id), [second!.id, first!.id]);
  assert.deepEqual(reordered.folders.map((folder) => folder.order), [0, 1]);

  // A folder named like an existing one gets its own id rather than merging.
  let dupes = createFolder(org(), "A");
  dupes = createFolder(dupes, "A");
  assert.equal(dupes.folders.length, 2);
  assert.notEqual(dupes.folders[0]!.id, dupes.folders[1]!.id);
});

test("Wave 4 A: deleting a folder keeps every project and files them under Unfiled", () => {
  let state = withFolders();
  const [first, second] = state.folders;
  state = moveProjectToFolder(state, "project-a", first!.id);
  state = moveProjectToFolder(state, "project-b", first!.id);
  state = moveProjectToFolder(state, "project-c", second!.id);

  const after = deleteFolder(state, first!.id);
  assert.deepEqual(after.folders.map((folder) => folder.id), [second!.id]);
  assert.equal(folderOfProject(after, "project-a"), ZAICODE_UNFILED, "no project is deleted with the folder");
  assert.equal(folderOfProject(after, "project-b"), ZAICODE_UNFILED);
  assert.equal(folderOfProject(after, "project-c"), second!.id, "other folders are untouched");
  assert.deepEqual(after.folders.map((folder) => folder.order), [0], "order stays dense");
});

test("Wave 4 A: a project moves between folders and back to Unfiled, and a bad target is refused", () => {
  let state = withFolders();
  const [first, second] = state.folders;
  state = moveProjectToFolder(state, "project-a", first!.id);
  assert.equal(folderOfProject(state, "project-a"), first!.id);
  state = moveProjectToFolder(state, "project-a", second!.id);
  assert.equal(folderOfProject(state, "project-a"), second!.id);
  state = moveProjectToFolder(state, "project-a", null);
  assert.equal(folderOfProject(state, "project-a"), ZAICODE_UNFILED);
  // A folder that does not exist cannot swallow a project.
  const before = moveProjectToFolder(state, "project-a", "folder-nope");
  assert.equal(folderOfProject(before, "project-a"), ZAICODE_UNFILED);
});

test("Wave 4 A: collapse and expand are per folder and persist in the shape", () => {
  let state = withFolders();
  const [first, second] = state.folders;
  state = setFolderCollapsed(state, first!.id, true);
  assert.equal(state.folders.find((folder) => folder.id === first!.id)!.collapsed, true);
  assert.equal(state.folders.find((folder) => folder.id === second!.id)!.collapsed, false);
  const round = normalizeProjectOrganization(JSON.parse(JSON.stringify(state)));
  assert.equal(round.folders.find((folder) => folder.id === first!.id)!.collapsed, true);
});

test("Wave 4 A: a stored shape that lost a folder self-heals instead of ghosting", () => {
  const stored = {
    ids: { "C:/work/a": "project-a", "": "project-x" },
    folders: [{ id: "folder-gone", name: "Deleted", order: 0, collapsed: true }, { id: "", name: "bad" }],
    membership: { "project-a": "folder-gone", "project-z": "folder-never" },
    pins: { "project-a": { pinnedAt: 5 }, "project-b": { pinnedAt: "nope" } },
  };
  const healed = normalizeProjectOrganization(stored);
  assert.deepEqual(healed.folders.map((folder) => folder.id), ["folder-gone"]);
  assert.deepEqual(
    healed.membership,
    { "project-a": "folder-gone" },
    "membership into a folder nobody can see is dropped; a folder that exists keeps its members",
  );
  assert.deepEqual(healed.pins, { "project-a": { pinnedAt: 5 } });
  assert.equal(healed.ids[""], undefined, "an empty workspace key is not an identity");
});

test("Wave 4 B: pins and folders are independent -- pinning does not unfile a project", () => {
  let state = withFolders();
  const [first] = state.folders;
  state = moveProjectToFolder(state, "project-a", first!.id);
  const pinned = setPinned(state, "project-a", true, 1000);

  assert.equal(isPinned(pinned, "project-a"), true);
  assert.equal(folderOfProject(pinned, "project-a"), first!.id, "pinning keeps folder membership");

  const unpinned = setPinned(pinned, "project-a", false);
  assert.equal(isPinned(unpinned, "project-a"), false);
  assert.equal(folderOfProject(unpinned, "project-a"), first!.id, "unpinning restores normal grouping");
});

test("Wave 4 B: pinned projects come first, in a stable order among themselves", () => {
  const rows = [
    { projectId: "a", folderId: ZAICODE_UNFILED, pinned: false, pinnedAt: 0 },
    { projectId: "b", folderId: ZAICODE_UNFILED, pinned: true, pinnedAt: 30 },
    { projectId: "c", folderId: ZAICODE_UNFILED, pinned: false, pinnedAt: 0 },
    { projectId: "d", folderId: ZAICODE_UNFILED, pinned: true, pinnedAt: 10 },
    { projectId: "e", folderId: ZAICODE_UNFILED, pinned: true, pinnedAt: 10 },
  ];
  const ordered = orderProjectRows(rows).map((row) => row.projectId);
  assert.deepEqual(ordered, ["d", "e", "b", "a", "c"], "pins first, by pin time, ties stable");
  // The caller's own order survives untouched inside each group.
  assert.deepEqual(orderProjectRows([...rows].reverse()).slice(3).map((row) => row.projectId), ["c", "a"]);
});

test("Wave 4 B: re-pinning does not silently move a project, and counts are per folder", () => {
  let state = setPinned(org(), "project-a", true, 100);
  state = setPinned(state, "project-a", true, 900);
  assert.deepEqual(state.pins["project-a"], { pinnedAt: 100 }, "pinnedAt is the order, so it is not overwritten");

  let withFolder = withFolders();
  withFolder = moveProjectToFolder(withFolder, "project-a", withFolder.folders[0]!.id);
  withFolder = moveProjectToFolder(withFolder, "project-b", withFolder.folders[0]!.id);
  withFolder = moveProjectToFolder(withFolder, "project-c", null);
  const counts = folderCounts(withFolder, ["project-a", "project-b", "project-c"]);
  assert.equal(counts[withFolder.folders[0]!.id], 2);
  assert.equal(counts[ZAICODE_UNFILED], 1);
});

test("Wave 4 A: rows are folded into their folders, Unfiled first and only when non-empty", () => {
  let state = withFolders();
  state = moveProjectToFolder(state, "project-a", state.folders[1]!.id);
  const groups = groupProjectsByFolder(state, [
    { projectId: "project-a", folderId: folderOfProject(state, "project-a"), pinned: false, pinnedAt: 0 },
    { projectId: "project-b", folderId: ZAICODE_UNFILED, pinned: true, pinnedAt: 1 },
  ]);
  assert.equal(groups[0]!.folder, null, "Unfiled leads when it has rows");
  assert.deepEqual(groups[0]!.rows.map((row) => row.projectId), ["project-b"]);
  assert.equal(groups[1]!.folder!.id, state.folders[0]!.id);
  assert.deepEqual(groups[1]!.rows, [], "an empty folder is still shown, so it can be dropped into");
  assert.equal(groups[2]!.folder!.id, state.folders[1]!.id);
});

test("Wave 4 C: appearance follows the model that ran the work, not the label", () => {
  const saifren = parseZaicodeModelIdentity("custom-12/SAIFREN$enabled");
  const saiopp = parseZaicodeModelIdentity("custom-12/SAIOPP$enabled");
  assert.deepEqual(saifren, { providerId: "custom-12", modelId: "SAIFREN" });
  assert.equal(zaicodeModelIdentityKey(saifren), "custom-12::saifren", "keyed by identity, not display text");
  assert.notEqual(zaicodeModelIdentityKey(saifren), zaicodeModelIdentityKey(saiopp));
  assert.equal(parseZaicodeModelIdentity(null), null);

  // The resolver takes the model's own string. It has no parameter and no
  // import for the picker's selection, so it cannot be swayed by one.
  const source = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "zaicodeModelAppearance.ts"), "utf8");
  const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(
    !imports.some((path) => path.includes("zaicodeDefaultModel")),
    `the picker must not reach the appearance resolver; it imports ${imports.join(", ")}`,
  );
});

test("Wave 4 C: the fallback chain is exact model Separate, then global Default, then shipped", () => {
  const prefs = normalizeZaicodeModelAppearancePrefs({
    global: { mode: "default", highlight: { projectWorking: { color: "custom", custom: "#112233" } }, workerIcon: "data:image/png;base64,AAA" },
    models: {
      "custom-12::saiopp": { mode: "separate", highlight: { projectWorking: { color: "custom", custom: "#445566" } } },
      "custom-12::sairen": { mode: "separate", highlight: { sessionWorking: { strength: 90 } }, workerIcon: "data:image/png;base64,BBB" },
    },
  });

  // SAIFREN was never given an override in this scenario: it inherits Default.
  const inherited = resolveZaicodeModelAppearance(prefs, "custom-12/SAIFREN$enabled");
  assert.equal(inherited.mode, "default");
  assert.equal(inherited.highlight.projectWorking!.custom, "#112233");

  // SAIOPP says Separate, and overrides exactly the target it named.
  const separate = resolveZaicodeModelAppearance(prefs, "custom-12/SAIOPP$enabled");
  assert.equal(separate.mode, "separate");
  assert.equal(separate.highlight.projectWorking!.custom, "#445566");
  assert.equal(separate.workerIcon, "", "no icon override, so the global one is used");

  // An unknown model falls through to the global Default, not to nothing.
  const unknown = resolveZaicodeModelAppearance(prefs, "other-provider/other-model");
  assert.equal(unknown.mode, "default");
  assert.equal(unknown.highlight.projectWorking!.custom, "#112233");

  // Nothing configured at all: the shipped fallback, and the shipped rule set.
  const empty = resolveZaicodeModelAppearance(ZAICODE_MODEL_APPEARANCE_DEFAULTS, "custom-12/SAIFREN$enabled");
  assert.equal(empty.mode, "default");
  assert.deepEqual(empty.highlight, {});
  assert.equal(empty.workerIcon, "");
});

test("Wave 4 C: any model can be Separate, not just the two shipped ones", () => {
  const prefs = normalizeZaicodeModelAppearancePrefs({
    models: { "acme::turbo": { mode: "separate", workerIcon: "https://cdn.example/icon.png" } },
  });
  assert.equal(resolveZaicodeModelAppearance(prefs, "acme/turbo").mode, "separate");
  assert.deepEqual(Object.keys(prefs.models), ["acme::turbo"]);
});

test("Wave 4 C: the worker icon falls back down the chain and never renders a broken asset", () => {
  const shipped = "/assets/zaicode-working.png";
  const prefs = normalizeZaicodeModelAppearancePrefs({
    global: { mode: "default", workerIcon: "builtin:global.png" },
    models: { "acme::turbo": { mode: "separate", workerIcon: "builtin:model.png" } },
  });
  const bundled = (id: string) => (id === "model.png" ? "/b/model.png" : null);

  assert.equal(resolveZaicodeWorkerIconUrl(prefs, "acme/turbo", shipped, bundled), "/b/model.png");

  // The model's bundled icon is missing: the chain walks to the GLOBAL one,
  // which does resolve here. Nothing broken is rendered in between.
  assert.equal(
    resolveZaicodeWorkerIconUrl(prefs, "acme/turbo", shipped, (id) => (id === "global.png" ? "/b/global.png" : null)),
    "/b/global.png",
  );
  // Nothing resolves at all: the shipped icon, never a literal "builtin:..." src.
  assert.equal(resolveZaicodeWorkerIconUrl(prefs, "acme/turbo", shipped, () => null), shipped);
  // No model override at all: the global icon, then the shipped one.
  assert.equal(resolveZaicodeWorkerIconUrl(prefs, "other/model", shipped, (id) => (id === "global.png" ? "/b/global.png" : null)), "/b/global.png");
  assert.equal(
    resolveZaicodeWorkerIconUrl(ZAICODE_MODEL_APPEARANCE_DEFAULTS, "other/model", shipped, () => null),
    shipped,
  );
});

test("Wave 4 C: a stored appearance is sanitized -- unknown targets, bad colours and code-like assets are refused", () => {
  const prefs = normalizeZaicodeModelAppearancePrefs({
    global: { mode: "separate", workerIcon: "javascript:alert(1)" },
    models: {
      "acme::turbo": {
        mode: "separate",
        highlight: { notATarget: { color: "custom" }, projectWorking: { color: "chartreuse", custom: "url(x)" } },
        workerIcon: "<img onerror=1>",
      },
    },
  });
  assert.equal(prefs.global.workerIcon, "", "an asset that is not an image reference is not stored");
  assert.equal(prefs.models["acme::turbo"]!.workerIcon, undefined, "markup is not an asset");
  assert.deepEqual(prefs.models["acme::turbo"]!.highlight!.notATarget, undefined, "an unknown target is dropped");
  // Every field of that rule was junk, so the whole rule is dropped rather
  // than stored as an empty one that would read as "set to nothing".
  assert.equal(
    prefs.models["acme::turbo"]!.highlight!.projectWorking,
    undefined,
    "a rule with nothing valid left in it is not stored at all",
  );
});

test("Wave 4 C: the shipped default keys exist for the targets the editor offers", () => {
  assert.ok(ZAICODE_MODEL_APPEARANCE_KEYS.length > 0);
  const prefs = normalizeZaicodeModelAppearancePrefs(null);
  assert.deepEqual(prefs, ZAICODE_MODEL_APPEARANCE_DEFAULTS);
});

test("Wave 4 C: an appearance override is stored per model and survives a reload", () => {
  const values = new Map<string, string>();
  // The operator may have saved model overrides as bundled defaults. Isolate this round trip.
  values.set("zaicode-model-appearance-v1", JSON.stringify(ZAICODE_MODEL_APPEARANCE_DEFAULTS));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });

  setZaicodeGlobalAppearance({ mode: "default", workerIcon: "builtin:global.png" });
  setZaicodeModelAppearance({ providerId: "custom-12", modelId: "SAIOPP" }, {
    mode: "separate",
    highlight: { projectWorking: { color: "custom", custom: "#445566" } },
  });

  // What was written is the normalizer's output, not the caller's input.
  const stored = JSON.parse(values.get("zaicode-model-appearance-v1") ?? "{}") as {
    models: Record<string, { mode: string }>;
  };
  assert.deepEqual(Object.keys(stored.models), ["custom-12::saiopp"]);
  assert.equal(stored.models["custom-12::saiopp"]!.mode, "separate");

  // Reading it back resolves the same way it did before the write.
  const reloaded = readZaicodeModelAppearancePrefs();
  assert.equal(resolveZaicodeModelAppearance(reloaded, "custom-12/SAIOPP$enabled").mode, "separate");
  assert.equal(resolveZaicodeModelAppearance(reloaded, "custom-12/SAIFREN$enabled").mode, "default");

  // Clearing an override returns that model to the global default.
  setZaicodeModelAppearance({ providerId: "custom-12", modelId: "SAIOPP" }, null);
  assert.deepEqual(readZaicodeModelAppearancePrefs().models, {});
  assert.equal(resolveZaicodeModelAppearance(readZaicodeModelAppearancePrefs(), "custom-12/SAIOPP$enabled").mode, "default");
});

test("Wave 4 A+B: the render plan is pins first, then folders, and nothing is hidden", () => {
  const sections = [
    { group: "MAIN0", tabs: ["tab-a", "tab-b"], folded: false },
    { group: null, tabs: ["tab-c", "tab-d"], folded: false },
  ];
  let org = withFolders();
  const [daily, long] = org.folders;
  // project-d stays in Unfiled on purpose: an empty Unfiled is not rendered.
  org = moveProjectToFolder(org, "project-b", long!.id);
  org = moveProjectToFolder(org, "project-c", long!.id);
  org = setPinned(org, "project-c", true, 50);
  const idOf = (tab: unknown) => `project-${String(tab).slice(-1)}`;

  const view = buildProjectOrganizationView(org, sections, idOf);
  const unfiled = view.folders.find((folder) => folder.unfiled)!;
  assert.deepEqual(unfiled.projects, ["project-a", "project-d"], "Unfiled leads and holds what is not filed");
  assert.equal(unfiled.collapsed, false, "Unfiled cannot be collapsed away: it holds live projects");

  const dailyView = view.folders.find((folder) => folder.folder?.id === daily!.id)!;
  const longView = view.folders.find((folder) => folder.folder?.id === long!.id)!;
  assert.deepEqual(dailyView.projects, [], "a folder with no projects is still rendered, so it can be dropped into");
  assert.deepEqual(longView.projects, ["project-c", "project-b"], "the pinned project leads its folder");

  // Every project appears exactly once: organizing never hides one.
  const all = view.folders.flatMap((folder) => folder.projects);
  assert.equal(all.length, 4);
  assert.equal(new Set(all).size, 4);
  assert.equal(view.rowByProject.get("project-c")!.pinned, true, "pin state travels with the plan row");
  assert.equal(view.rowByProject.get("project-c")!.group, null, "the slot section is preserved");
});

test("Wave 4 A: a project whose folder is not in the folder list shows up under Unfiled, not gone", () => {
  const sections = [{ group: null, tabs: ["tab-a", "tab-b"], folded: false }];
  // Hand-built on purpose: a shape where membership names a folder id that is
  // not in `folders`, which is what a hand-edited or half-migrated store looks
  // like. The normalizer drops that membership; the plan must not lose the
  // project even if it is handed one directly.
  const org = {
    ...ZAICODE_ORGANIZATION_DEFAULTS,
    folders: [{ id: "folder-here", name: "Here", order: 0, collapsed: false }],
    membership: { "project-a": "folder-vanished", "project-b": "folder-here" },
  };
  const view = buildProjectOrganizationView(org, sections, (tab) => `project-${String(tab).slice(-1)}`);
  const unfiled = view.folders.find((folder) => folder.unfiled)!;
  assert.deepEqual(unfiled.projects, ["project-a"], "a vanished folder files its project under Unfiled");
  const here = view.folders.find((folder) => folder.folder?.id === "folder-here")!;
  assert.deepEqual(here.projects, ["project-b"]);
  const all = view.folders.flatMap((folder) => folder.projects);
  assert.equal(new Set(all).size, 2, "both projects are still listed exactly once");
});

test("Wave 4 B+D: the move targets are keyboard-usable, and destructive actions are named apart", () => {
  let org = withFolders();
  org = moveProjectToFolder(org, "project-a", org.folders[0]!.id);
  const targets = moveTargetsFor(org);
  assert.equal(targets[0]!.id, ZAICODE_UNFILED, "moving back out of a folder is always offered");
  assert.deepEqual(targets.slice(1).map((target) => target.label), ["Daily drivers", "Long shots"]);
  assert.equal(describeMoveTarget(org.folders[1]!.id, org), "Long shots");
  assert.equal(describeMoveTarget(ZAICODE_UNFILED, org), "No folder");

  // The wave asks for these four to be distinguishable in a menu.
  const labels = Object.values(ZAICODE_PROJECT_DESTRUCTIVE_LABELS);
  assert.equal(new Set(labels).size, labels.length, "no two destructive actions share a name");
  assert.match(ZAICODE_PROJECT_DESTRUCTIVE_LABELS.deleteFolder, /projects are kept/i);
});

test("Wave 4 B: a pinned project is drawn first, and pinning one disturbs nothing else", () => {
  const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const pinned = new Set(["c"]);
  const pinnedOf = (tab: { id: string }) => pinned.has(tab.id);

  // The regression: the plan ordered pins first, but the sidebar drew the
  // caller's order anyway, so pinning a project did nothing visible.
  assert.deepEqual(orderSectionTabs(tabs, pinnedOf).map((tab) => tab.id), ["c", "a", "b", "d"]);

  // Pinning is a permutation, not a filter: no project is lost or duplicated.
  const ordered = orderSectionTabs(tabs, pinnedOf);
  assert.equal(ordered.length, tabs.length);
  assert.deepEqual(new Set(ordered.map((t) => t.id)).size, tabs.length);
  assert.deepEqual(tabs.map((t) => t.id), ["a", "b", "c", "d"], "the caller's own array is not mutated");

  // Two pins keep the caller's relative order among themselves.
  const two = new Set(["d", "b"]);
  assert.deepEqual(
    orderSectionTabs(tabs, (tab) => two.has(tab.id)).map((tab) => tab.id),
    ["b", "d", "a", "c"],
  );
  // Nothing pinned is exactly the input order.
  assert.deepEqual(orderSectionTabs(tabs, () => false).map((tab) => tab.id), ["a", "b", "c", "d"]);
});

test("Wave 4 A: collapsing a folder hides its rows but keeps its header, and never Unfiled", () => {
  let state = withFolders();
  const folderId = state.folders[0]!.id;
  // The project has to actually BE in the folder: an empty folder has nothing
  // to fold, and the test would be asserting a count of zero.
  state = moveProjectToFolder(state, "project-a", folderId);
  const section = [{ group: null, folded: false, tabs: [{ workspacePath: "a" }] }];

  const openView = buildProjectOrganizationView(state, section, () => "project-a");
  const open = openView.folders.find((view) => view.folder?.id === folderId)!;
  assert.equal(isFolderHidingRows(open), false, "an open folder hides nothing");
  assert.equal(open.count, 1);

  state = setFolderCollapsed(state, folderId, true);
  const collapsedView = buildProjectOrganizationView(state, section, () => "project-a");
  const collapsed = collapsedView.folders.find((view) => view.folder?.id === folderId)!;
  assert.equal(isFolderHidingRows(collapsed), true, "a collapsed folder hides its rows");
  assert.equal(collapsed.count, 1, "the count still names what is folded away, so the header can say so");
  assert.equal(collapsed.projects.length, 1, "the project is folded, not deleted");

  // Unfiled holds whatever is not filed; folding it would hide live projects
  // behind a header that offers no way to open them again.
  const unfiledView = buildProjectOrganizationView(
    setFolderCollapsed(state, folderId, false),
    section,
    () => "project-z",
  );
  const unfiled = unfiledView.folders.find((view) => view.unfiled)!;
  assert.equal(unfiled.collapsed, false);
  assert.equal(isFolderHidingRows(unfiled), false, "Unfiled can never hide its projects");
});
