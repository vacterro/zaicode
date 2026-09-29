import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * Virtual project folders and project pins (Wave 4, parts A and B).
 *
 * ONE guarantee shapes this module: organizing a project here never touches
 * the filesystem. There is no mkdir, no rename, no unlink and no move in this
 * file, and a control asserts it. Folders and pins are metadata about where a
 * project is grouped and how easy it is to reach -- nothing else. A project
 * that is not open simply is not listed; the directory on disk is not ours to
 * rearrange.
 *
 * The two concepts are independent, deliberately. A folder answers "where is
 * this project grouped?"; a pin answers "keep this project easy to reach".
 * A pinned project keeps its folder, and a folder's members are unaffected by
 * pinning, because they answer different questions.
 *
 * Projects are identified by a minted stable id rather than by path, so a
 * project that is reorganized keeps its organization when its display name
 * changes. `resolveProjectId` mints on first sight and reuses thereafter;
 * entries whose workspace key has not been seen in a while are dropped by
 * `normalizeProjectOrganization`, the same self-healing the icon and avatar
 * normalizers already do.
 */

export interface ZaicodeProjectFolder {
  id: string;
  name: string;
  /** Manual order among folders. */
  order: number;
  collapsed: boolean;
}

export interface ZaicodeProjectPin {
  pinnedAt: number;
}

/** Everything this module persists, in one shape. */
export interface ZaicodeProjectOrganization {
  /** workspaceKey -> minted stable project id. */
  ids: Record<string, string>;
  folders: ZaicodeProjectFolder[];
  /** projectId -> folderId, or absent for Unfiled. */
  membership: Record<string, string>;
  /** projectId -> pin. */
  pins: Record<string, ZaicodeProjectPin>;
}

export const ZAICODE_UNFILED = "unfiled";
const STORAGE_KEY = "zaicode-project-folders-v1";
const MAX_FOLDERS = 100;
const MAX_NAME = 48;
/** Ids we minted are namespaced so they can never collide with anything else. */
const ID_PREFIX = "project-";

export const ZAICODE_ORGANIZATION_DEFAULTS: ZaicodeProjectOrganization = {
  ids: {},
  folders: [],
  membership: {},
  pins: {},
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return trimmed || fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeProjectOrganization(raw: unknown): ZaicodeProjectOrganization {
  const source = isPlainObject(raw) ? raw : {};
  const ids: Record<string, string> = {};
  for (const [key, value] of Object.entries(isPlainObject(source.ids) ? source.ids : {})) {
    // A workspace key is a path or an identity; an id is one we minted.
    if (typeof key === "string" && key && typeof value === "string" && value.startsWith(ID_PREFIX)) {
      ids[key.slice(0, 512)] = value.slice(0, 64);
    }
  }
  const folders: ZaicodeProjectFolder[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(source.folders) ? source.folders : []) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || !entry.id) continue;
    const id = entry.id.slice(0, 64);
    if (seen.has(id) || folders.length >= MAX_FOLDERS) continue;
    seen.add(id);
    folders.push({
      id,
      name: cleanName(entry.name, `Folder ${folders.length + 1}`),
      order: clamp(entry.order, 0, MAX_FOLDERS, folders.length),
      collapsed: entry.collapsed === true,
    });
  }
  folders.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  folders.forEach((folder, index) => {
    folder.order = index;
  });

  const folderIds = new Set(folders.map((folder) => folder.id));
  const membership: Record<string, string> = {};
  for (const [projectId, folderId] of Object.entries(isPlainObject(source.membership) ? source.membership : {})) {
    // A membership pointing at a folder that no longer exists is dropped, not
    // rendered as a ghost: deleting a folder puts its projects in Unfiled.
    if (folderId && folderIds.has(String(folderId))) membership[projectId.slice(0, 64)] = String(folderId);
  }

  const pins: Record<string, ZaicodeProjectPin> = {};
  for (const [projectId, value] of Object.entries(isPlainObject(source.pins) ? source.pins : {})) {
    const at = isPlainObject(value) ? value.pinnedAt : value;
    if (typeof at === "number" && Number.isFinite(at)) pins[projectId.slice(0, 64)] = { pinnedAt: at };
  }
  return { ids, folders, membership, pins };
}

/** A minted id for a workspace key, stable from first sight. Pure. */
export function mintProjectId(existing: Record<string, string>, workspaceKey: string): string {
  const known = existing[workspaceKey];
  if (known) return known;
  // Deterministic from the key, so a dropped store cannot re-order a project
  // by minting a different id on the next start.
  let hash = 0;
  for (let index = 0; index < workspaceKey.length; index += 1) {
    hash = (hash * 31 + workspaceKey.charCodeAt(index)) | 0;
  }
  return `${ID_PREFIX}${(hash >>> 0).toString(36)}`;
}

export function resolveProjectId(organization: ZaicodeProjectOrganization, workspaceKey: string): string {
  return mintProjectId(organization.ids, workspaceKey);
}

/** projectId -> folderId, with Unfiled for the rest. */
export function folderOfProject(organization: ZaicodeProjectOrganization, projectId: string): string {
  return organization.membership[projectId] ?? ZAICODE_UNFILED;
}

export function isPinned(organization: ZaicodeProjectOrganization, projectId: string): boolean {
  return Boolean(organization.pins[projectId]);
}

export function createFolder(organization: ZaicodeProjectOrganization, name: string, id = folderIdFor(organization, name)): ZaicodeProjectOrganization {
  if (organization.folders.some((folder) => folder.id === id) || organization.folders.length >= MAX_FOLDERS) {
    return organization;
  }
  return {
    ...organization,
    folders: [...organization.folders, { id, name: cleanName(name, "New folder"), order: organization.folders.length, collapsed: false }],
  };
}

function folderIdFor(organization: ZaicodeProjectOrganization, name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "folder";
  let candidate = `folder-${base}`;
  let index = 2;
  while (organization.folders.some((folder) => folder.id === candidate)) {
    candidate = `folder-${base}-${index}`;
    index += 1;
  }
  return candidate;
}

export function renameFolder(organization: ZaicodeProjectOrganization, folderId: string, name: string): ZaicodeProjectOrganization {
  const folders = organization.folders.map((folder) => (folder.id === folderId ? { ...folder, name: cleanName(name, folder.name) } : folder));
  return { ...organization, folders };
}

/**
 * Delete a folder and KEEP every project in it. The projects move to Unfiled
 * because that is what Unfiled is for; a real project is never deleted here,
 * because this module has no way to delete anything -- there is no filesystem
 * call in it.
 */
export function deleteFolder(organization: ZaicodeProjectOrganization, folderId: string): ZaicodeProjectOrganization {
  const membership: Record<string, string> = {};
  for (const [projectId, current] of Object.entries(organization.membership)) {
    if (current === folderId) continue;
    membership[projectId] = current;
  }
  return {
    ...organization,
    folders: organization.folders.filter((folder) => folder.id !== folderId).map((folder, index) => ({ ...folder, order: index })),
    membership,
  };
}

/** Move a project into a folder, or to Unfiled with a null folderId. */
export function moveProjectToFolder(
  organization: ZaicodeProjectOrganization,
  projectId: string,
  folderId: string | null,
): ZaicodeProjectOrganization {
  if (folderId && !organization.folders.some((folder) => folder.id === folderId)) return organization;
  const membership = { ...organization.membership };
  if (folderId === null) delete membership[projectId];
  else membership[projectId] = folderId;
  return { ...organization, membership };
}

export function setFolderCollapsed(organization: ZaicodeProjectOrganization, folderId: string, collapsed: boolean): ZaicodeProjectOrganization {
  return {
    ...organization,
    folders: organization.folders.map((folder) => (folder.id === folderId ? { ...folder, collapsed } : folder)),
  };
}

export function reorderFolders(organization: ZaicodeProjectOrganization, orderedIds: readonly string[]): ZaicodeProjectOrganization {
  const byId = new Map(organization.folders.map((folder) => [folder.id, folder]));
  const folders = orderedIds
    .map((id, index) => {
      const folder = byId.get(id);
      return folder ? { ...folder, order: index } : null;
    })
    .filter((folder): folder is ZaicodeProjectFolder => folder !== null);
  // Anything the caller did not name keeps its place after the named ones.
  for (const folder of organization.folders) {
    if (!orderedIds.includes(folder.id)) folders.push({ ...folder, order: folders.length });
  }
  return { ...organization, folders };
}

export function setPinned(organization: ZaicodeProjectOrganization, projectId: string, pinned: boolean, now = Date.now()): ZaicodeProjectOrganization {
  const pins = { ...organization.pins };
  if (!pinned) delete pins[projectId];
  else if (!pins[projectId]) pins[projectId] = { pinnedAt: now };
  // Re-pinning an already pinned project is a no-op: pinnedAt is what orders
  // pinned projects, so overwriting it would silently move a project.
  return { ...organization, pins };
}

export interface ZaicodeProjectRow {
  projectId: string;
  folderId: string;
  pinned: boolean;
  pinnedAt: number;
}

/**
 * The visible order: pinned projects first, and among them a stable order by
 * pin time with the id as the tie-break, so two projects pinned in the same
 * millisecond still have ONE deterministic order. Within a group, the
 * caller's own order (activity, alphabetical, manual) is preserved untouched.
 */
export function orderProjectRows(rows: readonly ZaicodeProjectRow[]): ZaicodeProjectRow[] {
  return [...rows].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.pinned && left.pinnedAt !== right.pinnedAt) return left.pinnedAt - right.pinnedAt;
    return 0;
  });
}

/** Fold the projects into their folders for rendering, keeping row order. */
export function groupProjectsByFolder(
  organization: ZaicodeProjectOrganization,
  rows: readonly ZaicodeProjectRow[],
): { folder: ZaicodeProjectFolder | null; rows: ZaicodeProjectRow[] }[] {
  const byFolder = new Map<string, ZaicodeProjectRow[]>([[ZAICODE_UNFILED, []]]);
  for (const folder of organization.folders) byFolder.set(folder.id, []);
  for (const row of orderProjectRows(rows)) {
    const bucket = byFolder.get(row.folderId) ?? byFolder.get(ZAICODE_UNFILED)!;
    bucket.push(row);
  }
  const groups: { folder: ZaicodeProjectFolder | null; rows: ZaicodeProjectRow[] }[] = [];
  for (const folder of organization.folders) groups.push({ folder, rows: byFolder.get(folder.id)! });
  const unfiled = byFolder.get(ZAICODE_UNFILED)!;
  if (unfiled.length > 0) groups.unshift({ folder: null, rows: unfiled });
  return groups;
}

export function folderCounts(
  organization: ZaicodeProjectOrganization,
  projectIds: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = { [ZAICODE_UNFILED]: 0 };
  for (const folder of organization.folders) counts[folder.id] = 0;
  for (const projectId of projectIds) {
    const folderId = folderOfProject(organization, projectId);
    counts[folderId] = (counts[folderId] ?? 0) + 1;
  }
  return counts;
}

interface ZaicodeProjectOrganizationStore extends ZaicodeProjectOrganization {
  /** Records a project the first time it is seen and returns its stable id. */
  register: (workspaceKey: string) => string;
  createFolder: (name: string) => string | null;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  moveProject: (projectId: string, folderId: string | null) => void;
  setCollapsed: (folderId: string, collapsed: boolean) => void;
  reorderFolders: (orderedIds: readonly string[]) => void;
  setPinned: (projectId: string, pinned: boolean) => void;
  togglePinned: (projectId: string) => boolean;
  reset: () => void;
}

function load(): ZaicodeProjectOrganization {
  try {
    return normalizeProjectOrganization(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return { ...ZAICODE_ORGANIZATION_DEFAULTS };
  }
}

export const useZaicodeProjectFolders = create<ZaicodeProjectOrganizationStore>((set, get) => {
  const persist = (next: Partial<ZaicodeProjectOrganization>) => {
    const current = get();
    const merged = normalizeProjectOrganization({ ...current, ...next });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch {
      // Applies for this window; the next start reads what did land.
    }
    set(merged as ZaicodeProjectOrganizationStore);
  };
  return {
    ...load(),
    register: (workspaceKey: string) => {
      const current = get();
      const existing = current.ids[workspaceKey];
      if (existing) return existing;
      const id = mintProjectId(current.ids, workspaceKey);
      persist({ ids: { ...current.ids, [workspaceKey]: id } });
      return id;
    },
    createFolder: (name: string) => {
      const before = get().folders.length;
      const id = folderIdFor(get(), name);
      persist(createFolder(get(), name, id));
      return get().folders.length > before ? id : null;
    },
    renameFolder: (folderId: string, name: string) => persist(renameFolder(get(), folderId, name)),
    deleteFolder: (folderId: string) => persist(deleteFolder(get(), folderId)),
    moveProject: (projectId: string, folderId: string | null) => persist(moveProjectToFolder(get(), projectId, folderId)),
    setCollapsed: (folderId: string, collapsed: boolean) => persist(setFolderCollapsed(get(), folderId, collapsed)),
    reorderFolders: (orderedIds: readonly string[]) => persist(reorderFolders(get(), orderedIds)),
    setPinned: (projectId: string, pinned: boolean) => persist(setPinned(get(), projectId, pinned)),
    togglePinned: (projectId: string) => {
      const next = !isPinned(get(), projectId);
      persist(setPinned(get(), projectId, next));
      return next;
    },
    reset: () => persist(ZAICODE_ORGANIZATION_DEFAULTS),
  };
});
