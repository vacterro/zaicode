import type {
  ZaicodeRouterCall,
  ZaicodeRouterConnection,
} from "@zcode/shared";

/**
 * Editing one connection in place (T-264, SRC-169:R004): the connection list
 * already offers on/off, test and remove; the operator also needs to correct
 * a name or base URL without deleting the connection (and its key pool).
 *
 * A blank draft field means "leave this field alone", never "clear it":
 * 9router rejects an empty name/base URL and silently keeping the old value
 * is the only behavior that cannot lose data on a half-filled form. Nothing
 * changed -> null, so the caller reports "nothing changed" instead of
 * firing an empty PUT.
 */
export interface ZaicodeRouterConnectionDraft {
  name: string;
  baseUrl: string;
}

export function buildZaicodeRouterConnectionEdit(
  connection: Pick<ZaicodeRouterConnection, "id" | "name" | "baseUrl">,
  draft: ZaicodeRouterConnectionDraft,
): ZaicodeRouterCall | null {
  const body: Record<string, string> = {};
  const name = draft.name.trim();
  const baseUrl = draft.baseUrl.trim();
  if (name && name !== connection.name) body.name = name;
  if (baseUrl && baseUrl !== (connection.baseUrl ?? "")) body.baseUrl = baseUrl;
  if (Object.keys(body).length === 0) return null;
  return { method: "PUT", path: `/api/providers/${connection.id}`, body };
}
