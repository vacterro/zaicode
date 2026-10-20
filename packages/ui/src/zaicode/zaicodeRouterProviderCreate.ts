import type {
  ZaicodeRouterCall,
  ZaicodeRouterNode,
  ZaicodeRouterResponse,
} from "@zcode/shared";

/**
 * Transactional custom-provider creation (T-264 Phase C).
 *
 * 9router splits "add a provider" into two HTTP operations: create the
 * provider node, then attach the API key as a connection. The second can fail
 * after the first committed, so this helper makes the boundary recoverable:
 *
 * - reconcile first: an existing node with the same routing prefix (or the
 *   same name + base URL) is reused, so a retry or a reopened form never
 *   creates a duplicate node;
 * - partial success is reported precisely with the node id, and retrying is
 *   just running the helper again against refreshed nodes;
 * - nothing is ever deleted: a node whose ownership or use is uncertain is
 *   preserved, never compensated away.
 */

export interface ZaicodeProviderCreateInput {
  type: "openai-compatible" | "anthropic-compatible";
  name: string;
  prefix: string;
  baseUrl: string;
  apiType: "chat" | "responses";
  apiKey: string;
}

export type ZaicodeProviderCreateResult =
  | { kind: "created"; nodeId: string; reusedNode: boolean }
  | { kind: "node-failed"; message: string }
  | { kind: "key-failed"; nodeId: string; message: string };

const norm = (value: string) => value.trim().toLowerCase();

/** A node the router already holds for this provider, if any. */
export function findMatchingProviderNode(
  nodes: readonly ZaicodeRouterNode[],
  candidate: Pick<ZaicodeRouterNode, "prefix" | "name" | "baseUrl">,
): ZaicodeRouterNode | null {
  const prefix = norm(candidate.prefix);
  if (prefix) {
    const byPrefix = nodes.find((node) => norm(node.prefix) === prefix);
    if (byPrefix) return byPrefix;
  }
  const name = norm(candidate.name);
  const baseUrl = norm(candidate.baseUrl.replace(/\/+$/, ""));
  if (!name || !baseUrl) return null;
  return (
    nodes.find((node) => norm(node.name) === name && norm(node.baseUrl.replace(/\/+$/, "")) === baseUrl) ??
    null
  );
}

export async function createZaicodeProviderWithKey(
  call: (call: ZaicodeRouterCall) => Promise<ZaicodeRouterResponse>,
  nodes: readonly ZaicodeRouterNode[],
  input: ZaicodeProviderCreateInput,
): Promise<ZaicodeProviderCreateResult> {
  const name = input.name.trim();
  const prefix = input.prefix.trim();
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();
  if (!name || !prefix || !baseUrl || !apiKey) {
    return { kind: "node-failed", message: "Name, prefix, base URL and API key are all required." };
  }
  const existing = findMatchingProviderNode(nodes, { prefix, name, baseUrl });
  let nodeId = existing?.id;
  let reusedNode = false;
  if (!nodeId) {
    let created: ZaicodeRouterResponse;
    try {
      created = await call({
        method: "POST",
        path: "/api/provider-nodes",
        body: {
          type: input.type,
          name,
          prefix,
          baseUrl,
          ...(input.type === "openai-compatible" ? { apiType: input.apiType } : {}),
        },
      });
    } catch (error) {
      // A timeout here may still have committed server-side: report the node
      // step as failed, and let the next attempt reconcile the node list
      // instead of blindly creating a second node.
      return { kind: "node-failed", message: error instanceof Error ? error.message : "provider node request failed" };
    }
    nodeId = (created.data as { node?: { id?: string } } | null)?.node?.id;
    if (!created.ok || !nodeId) {
      return { kind: "node-failed", message: created.message || "9router returned no node" };
    }
  } else {
    reusedNode = true;
  }
  const connected = await call({
    method: "POST",
    path: "/api/providers",
    body: { provider: nodeId, apiKey, name },
  });
  if (!connected.ok) {
    return { kind: "key-failed", nodeId, message: connected.message || "9router refused the key" };
  }
  return { kind: "created", nodeId, reusedNode };
}

/**
 * Single-flight submission guard for the form. A second click while creation
 * is pending is ignored (returns null) instead of firing a duplicate pair of
 * mutations; the guard releases when the flight settles, success or failure.
 */
export function createProviderSubmission() {
  let inflight = false;
  return {
    get pending() {
      return inflight;
    },
    async run<T>(flight: () => Promise<T>): Promise<T | null> {
      if (inflight) return null;
      inflight = true;
      try {
        return await flight();
      } finally {
        inflight = false;
      }
    },
  };
}
