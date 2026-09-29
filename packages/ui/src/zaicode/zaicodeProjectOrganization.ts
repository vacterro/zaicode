import {
  ZAICODE_UNFILED,
  folderOfProject,
  isPinned,
  orderProjectRows,
  type ZaicodeProjectFolder,
  type ZaicodeProjectOrganization,
  type ZaicodeProjectRow,
} from "./zaicodeProjectFolders.js";

/**
 * The render plan for the project list (Wave 4).
 *
 * Folders, slots and pins are three independent axes over the same list of
 * projects, and the order they compose in is a product decision, so it lives
 * here as pure data rather than inside the 2000-line sidebar:
 *
 *   pinned projects first (by pin time), then the existing slot grouping,
 *   then folders as headers, then the caller's own order inside each group.
 *
 * The sidebar's live/slot logic is untouched: this only decides which folder
 * header a project sits under and what order it appears in within one.
 */

/** What the plan needs to know about a project: the two fields its id is built from. */
export interface ZaicodeProjectRef {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface ZaicodeProjectSectionGroup<T extends ZaicodeProjectRef = ZaicodeProjectRef> {
  group: string | null;
  tabs: readonly T[];
  folded: boolean;
}

export interface ZaicodeProjectFolderView {
  folder: ZaicodeProjectFolder | null;
  /** The Unfiled bucket, which is shown only when it has projects. */
  unfiled: boolean;
  count: number;
  collapsed: boolean;
  projects: readonly string[];
}

/** One project as the plan sees it: its stable id, its folder, its pin. */
export interface ZaicodeProjectPlanRow {
  projectId: string;
  /** The slot section it came from, kept so the sidebar can keep its own grouping. */
  group: string | null;
  pinned: boolean;
  pinnedAt: number;
  /** Its position in the caller's own order, used to break ties exactly. */
  index: number;
}

export function buildProjectPlan<T extends ZaicodeProjectRef>(
  organization: ZaicodeProjectOrganization,
  sections: readonly ZaicodeProjectSectionGroup<T>[],
  projectIdOf: (tab: T) => string,
): ZaicodeProjectPlanRow[] {
  const rows: ZaicodeProjectPlanRow[] = [];
  let index = 0;
  for (const section of sections) {
    for (const tab of section.tabs) {
      const projectId = projectIdOf(tab);
      rows.push({
        projectId,
        group: section.group,
        pinned: isPinned(organization, projectId),
        pinnedAt: organization.pins[projectId]?.pinnedAt ?? 0,
        index: index++,
      });
    }
  }
  // The shared ordering is the same function the folders use, fed plan rows
  // that carry the fields it needs; the extra `index` and `group` ride along.
  return orderProjectRows(rows as unknown as ZaicodeProjectRow[]) as unknown as ZaicodeProjectPlanRow[];
}

export function buildFolderViews(
  organization: ZaicodeProjectOrganization,
  rows: readonly ZaicodeProjectPlanRow[],
): ZaicodeProjectFolderView[] {
  const byFolder = new Map<string, string[]>([[ZAICODE_UNFILED, []]]);
  for (const folder of organization.folders) byFolder.set(folder.id, []);
  for (const row of rows) {
    const folderId = folderOfProject(organization, row.projectId);
    const bucket = byFolder.get(folderId);
    // A project in a folder that no longer exists shows up under Unfiled
    // rather than vanishing: organizing must never hide a project.
    (bucket ?? byFolder.get(ZAICODE_UNFILED)!).push(row.projectId);
  }
  const views: ZaicodeProjectFolderView[] = [];
  const unfiled = byFolder.get(ZAICODE_UNFILED)!;
  if (unfiled.length > 0) {
    views.push({ folder: null, unfiled: true, count: unfiled.length, collapsed: false, projects: unfiled });
  }
  for (const folder of organization.folders) {
    const projects = byFolder.get(folder.id)!;
    views.push({ folder, unfiled: false, count: projects.length, collapsed: folder.collapsed, projects });
  }
  return views;
}

/** A flat, ordered list of folder views plus the rows in each, for rendering. */
export interface ZaicodeProjectOrganizationView {
  folders: ZaicodeProjectFolderView[];
  rowByProject: Map<string, ZaicodeProjectPlanRow>;
}

export function buildProjectOrganizationView<T extends ZaicodeProjectRef>(
  organization: ZaicodeProjectOrganization,
  sections: readonly ZaicodeProjectSectionGroup<T>[],
  projectIdOf: (tab: T) => string,
): ZaicodeProjectOrganizationView {
  const rows = buildProjectPlan(organization, sections, projectIdOf);
  return {
    folders: buildFolderViews(organization, rows),
    rowByProject: new Map(rows.map((row) => [row.projectId, row])),
  };
}

/** The keyboard-accessible move: a project to a folder, or to Unfiled. */
export function moveTargetsFor(organization: ZaicodeProjectOrganization): { id: string; label: string }[] {
  return [
    { id: ZAICODE_UNFILED, label: "No folder" },
    ...organization.folders.map((folder) => ({ id: folder.id, label: folder.name })),
  ];
}

export function describeMoveTarget(folderId: string, organization: ZaicodeProjectOrganization): string {
  if (folderId === ZAICODE_UNFILED) return "No folder";
  return organization.folders.find((folder) => folder.id === folderId)?.name ?? "No folder";
}

/** Destructive actions, named so the menu never conflates them. */
export const ZAICODE_PROJECT_DESTRUCTIVE_LABELS = {
  removeFromFolder: "Remove from folder",
  unpin: "Unpin project",
  unfile: "Move to No folder",
  deleteFolder: "Delete folder (projects are kept)",
} as const;
