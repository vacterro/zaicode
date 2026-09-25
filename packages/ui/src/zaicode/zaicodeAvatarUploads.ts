/**
 * Photos the operator uploaded, kept as a list so an earlier one can be
 * picked again (SRC-035). Newest first; the same picture is stored once.
 * Pure list rules; the store lives in zaicodeProfiles.ts.
 */
export interface ZaicodeAvatarUpload {
  id: string;
  dataUri: string;
  addedAt: number;
}

export const ZAICODE_AVATAR_UPLOADS_MAX = 24;

export function normalizeZaicodeAvatarUploads(raw: unknown): ZaicodeAvatarUpload[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw
    .flatMap((row): ZaicodeAvatarUpload[] => {
      if (!row || typeof row !== "object") return [];
      const { id, dataUri, addedAt } = row as Record<string, unknown>;
      if (typeof id !== "string" || typeof dataUri !== "string" || !/^data:image\//i.test(dataUri)) return [];
      if (seen.has(dataUri)) return [];
      seen.add(dataUri);
      return [{ id, dataUri, addedAt: typeof addedAt === "number" ? addedAt : 0 }];
    })
    .slice(0, ZAICODE_AVATAR_UPLOADS_MAX);
}

/** Pure list update: the photo moves to the front; the oldest drop past the cap. */
export function addToZaicodeAvatarUploads(
  list: readonly ZaicodeAvatarUpload[],
  dataUri: string,
  now: number,
): ZaicodeAvatarUpload[] {
  const existing = list.find((upload) => upload.dataUri === dataUri);
  const entry = existing ?? { id: `upload-${now.toString(36)}`, dataUri, addedAt: now };
  return [entry, ...list.filter((upload) => upload.dataUri !== dataUri)].slice(0, ZAICODE_AVATAR_UPLOADS_MAX);
}

