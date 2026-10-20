import { useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { toast } from "@/components/ui/toast.js";
import { isZaicodeRouterErrorRecent, suggestZaicodeProviderPrefix, type ZaicodeRouterConnection } from "@zcode/shared";
import { getZaicodeRouterBridge, useZaicodeRouter, zaicodeRouterChange } from "@/zaicode/zaicodeRouter.js";
import { buildZaicodeRouterConnectionEdit } from "@/zaicode/zaicodeRouterConnectionEdit.js";
import {
  createProviderSubmission,
  createZaicodeProviderWithKey,
  type ZaicodeProviderCreateResult,
} from "@/zaicode/zaicodeRouterProviderCreate.js";
import { ZaicodeRouterProviderCatalogue } from "./ZaicodeRouterProviderCatalogue.js";

/**
 * Router -> Providers & keys: every 9router connection with its state, a
 * test and on/off; a form that adds an OpenAI- or Anthropic-compatible
 * provider with its key in one step (9router: provider node + connection),
 * and "another key" for an existing custom provider (9router rotates keys
 * of one provider as a key pool).
 */

type NodeType = "openai-compatible" | "anthropic-compatible";

const inputClass = "min-w-0 border border-border bg-background px-1 py-0.5 text-foreground";

/** 9router keeps a connection's last error until its next success; an old one is history, not a current fault (T-133). */
function isStaleError(connection: ZaicodeRouterConnection, now = Date.now()): boolean {
  return Boolean(connection.lastError) && !isZaicodeRouterErrorRecent(connection, now);
}

function statusTone(connection: ZaicodeRouterConnection): string {
  if (!connection.isActive) return "text-foreground-subtlest";
  if (connection.testStatus === "active" || connection.testStatus === "success") return "text-[#7cc45a]";
  if (connection.lastError && isStaleError(connection)) return "text-[var(--color-warning)]";
  if (connection.lastError || connection.testStatus === "error" || connection.testStatus === "expired") return "text-destructive";
  return "text-foreground-subtle";
}

/** The row's tooltip: the error and when it happened, on this PC's clock. */
function statusTitle(connection: ZaicodeRouterConnection): string {
  if (!connection.lastError) return connection.testStatus ?? "";
  const at = connection.lastErrorAt ? new Date(connection.lastErrorAt) : null;
  if (!at || Number.isNaN(at.getTime())) return connection.lastError;
  const when = at.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `${connection.lastError}\nLast error ${when}${isStaleError(connection) ? " (old: it clears on the next success)" : ""}`;
}

function AddProviderForm() {
  const nodes = useZaicodeRouter((state) => state.nodes);
  const refresh = useZaicodeRouter((state) => state.refresh);
  const [type, setType] = useState<NodeType>("openai-compatible");
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiType, setApiType] = useState<"chat" | "responses">("chat");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState<{ nodeId: string; message: string } | null>(null);
  const submission = useMemo(() => createProviderSubmission(), []);
  const taken = nodes.map((node) => node.prefix);
  const effectivePrefix = prefix.trim() || suggestZaicodeProviderPrefix(name, taken);
  const canAdd = Boolean(name.trim() && baseUrl.trim() && apiKey.trim()) && !busy;

  const finish = (result: ZaicodeProviderCreateResult | null, displayName: string, displayPrefix: string) => {
    if (result === null) return;
    if (result.kind === "created") {
      setPartial(null);
      setName("");
      setPrefix("");
      setBaseUrl("");
      setApiKey("");
      toast(result.reusedNode ? `${displayName} key saved on the existing provider node` : `${displayName} added as ${displayPrefix}/…`);
    } else if (result.kind === "node-failed") {
      toast(`Provider not added: ${result.message}`);
    } else {
      setPartial({ nodeId: result.nodeId, message: result.message });
      toast(`Provider node saved, but the key was not: ${result.message}. Press Add provider again to retry only the key step.`);
    }
  };

  const add = async () => {
    await refresh();
    const latest = useZaicodeRouter.getState().nodes;
    const displayName = name.trim();
    const displayPrefix = prefix.trim() || suggestZaicodeProviderPrefix(displayName, latest.map((node) => node.prefix));
    setBusy(true);
    try {
      const result = await submission.run(() =>
        createZaicodeProviderWithKey(
          (call) => zaicodeRouterChange("Adding provider", call).then((response) => response),
          latest,
          { type, name: displayName, prefix: displayPrefix, baseUrl: baseUrl.trim(), apiType, apiKey: apiKey.trim() },
        ),
      );
      finish(result, displayName, displayPrefix);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1 border border-border p-2">
      <strong className="font-normal text-foreground">Add a provider (OpenAI / Anthropic compatible)</strong>
      <div className="flex flex-wrap gap-px">
        {(["openai-compatible", "anthropic-compatible"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={cn(
              "border px-1.5",
              type === value ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground" : "border-border text-foreground-subtle",
            )}
            onClick={() => setType(value)}
          >
            {value === "openai-compatible" ? "OpenAI compatible" : "Anthropic compatible"}
          </button>
        ))}
        {type === "openai-compatible"
          ? (["chat", "responses"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={cn(
                  "ml-1 border px-1.5",
                  apiType === value ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground" : "border-border text-foreground-subtle",
                )}
                onClick={() => setApiType(value)}
                title={value === "chat" ? "/chat/completions (most providers)" : "/responses (OpenAI Responses API)"}
              >
                {value}
              </button>
            ))
          : null}
      </div>
      <div className="grid grid-cols-[6rem_1fr] items-center gap-1">
        <span className="text-foreground-subtle">Name</span>
        <input className={inputClass} value={name} placeholder="My provider" onChange={(event) => setName(event.target.value)} />
        <span className="text-foreground-subtle">Prefix</span>
        <input className={inputClass} value={prefix} placeholder={effectivePrefix} onChange={(event) => setPrefix(event.target.value)} title="Models are routed as prefix/model" />
        <span className="text-foreground-subtle">Base URL</span>
        <input
          className={`${inputClass} font-mono`}
          value={baseUrl}
          placeholder={type === "openai-compatible" ? "https://api.example.com/v1" : "https://api.example.com/v1"}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <span className="text-foreground-subtle">API key</span>
        <input className={`${inputClass} font-mono`} type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
      </div>
      {partial ? <p role="alert" className="text-error">Key pending on node {partial.nodeId}: {partial.message}</p> : null}
      <Button size="sm" variant="secondary" className="self-start" disabled={!canAdd} onClick={() => void add()}>
        {busy ? "Adding…" : partial ? "Retry key step" : "Add provider"}
      </Button>
    </div>
  );
}

function AddKeyForm() {
  const nodes = useZaicodeRouter((state) => state.nodes);
  const [nodeId, setNodeId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const llmNodes = nodes.filter((node) => node.type === "openai-compatible" || node.type === "anthropic-compatible");
  if (llmNodes.length === 0) return null;
  const node = llmNodes.find((item) => item.id === nodeId) ?? null;
  return (
    <div className="flex flex-wrap items-center gap-1 border border-border p-2">
      <strong className="mr-1 font-normal text-foreground">Another key for</strong>
      <select className={inputClass} value={nodeId} onChange={(event) => setNodeId(event.target.value)}>
        <option value="">pick a custom provider…</option>
        {llmNodes.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name} ({item.prefix})
          </option>
        ))}
      </select>
      <input
        className={`${inputClass} w-56 font-mono`}
        type="password"
        autoComplete="off"
        placeholder="API key"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={!node || !apiKey.trim()}
        onClick={() =>
          node &&
          void zaicodeRouterChange("Adding key", {
            method: "POST",
            path: "/api/providers",
            body: { provider: node.id, apiKey: apiKey.trim(), name: `${node.name} key` },
          }).then((result) => {
            toast(result.ok ? `Key added to ${node.name} (9router rotates the keys)` : `Key not saved: ${result.message}`);
            if (result.ok) setApiKey("");
          })
        }
      >
        Add key
      </Button>
    </div>
  );
}

export function ZaicodeRouterProviders() {
  const connections = useZaicodeRouter((state) => state.connections);
  const busy = useZaicodeRouter((state) => state.busy);
  const [filter, setFilter] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; baseUrl: string } | null>(null);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return [...connections]
      .filter((item) => !needle || `${item.name} ${item.provider} ${item.prefix ?? ""}`.toLowerCase().includes(needle))
      .sort((left, right) => Number(right.isActive) - Number(left.isActive) || left.name.localeCompare(right.name));
  }, [connections, filter]);

  const test = async (connection: ZaicodeRouterConnection) => {
    setTesting(connection.id);
    const result = await zaicodeRouterChange("Testing", { method: "POST", path: `/api/providers/${connection.id}/test` });
    setTesting(null);
    const valid = (result.data as { valid?: boolean; error?: string } | null)?.valid;
    toast(result.ok && valid ? `${connection.name}: works` : `${connection.name}: ${(result.data as { error?: string } | null)?.error ?? result.message ?? "failed"}`);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const connection = connections.find((item) => item.id === editing.id);
    if (!connection) {
      setEditing(null);
      return;
    }
    const call = buildZaicodeRouterConnectionEdit(connection, editing);
    if (!call) {
      toast("Nothing changed.");
      setEditing(null);
      return;
    }
    const savedName = editing.name.trim() || connection.name;
    const result = await zaicodeRouterChange("Saving", call);
    toast(result.ok ? `${savedName} updated` : `Not saved: ${result.message}`);
    if (result.ok) setEditing(null);
  };

  // The sign-in itself lives in 9router's own dashboard (D-8: ZAICODE never
  // runs OAuth flows through its proxy); this only opens that page there.
  const openSignIn = async () => {
    const report = await getZaicodeRouterBridge()?.openZaicodeRouterDashboard?.("providers");
    if (!report || !report.ok) toast("Could not open the router page: " + (report?.message ?? "no desktop bridge"));
  };

  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-3 text-ui-xs" data-zaicode-router-providers>
      <ZaicodeRouterProviderCatalogue />
      <details>
        <summary className="cursor-pointer text-foreground-subtle">Quick connection controls</summary>
        <div className="mt-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-ui-lg text-foreground">Providers &amp; keys</h2>
        <span className="text-foreground-subtlest">{connections.length} connections{busy ? ` · ${busy}…` : ""}</span>
        <input className={`${inputClass} ml-auto w-48`} placeholder="Filter…" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      <div className="flex max-h-[360px] flex-col overflow-y-auto border border-border">
        {shown.map((connection) => (
          <div key={connection.id} className="flex flex-wrap items-center gap-2 border-b border-border/50 px-1.5 py-0.5 last:border-b-0">
            <Checkbox
              checked={connection.isActive}
              title={connection.isActive ? "On: 9router routes to it" : "Off: 9router skips it"}
              onCheckedChange={(val) =>
                void zaicodeRouterChange("Saving", { method: "PUT", path: `/api/providers/${connection.id}`, body: { isActive: Boolean(val) } })
              }
            />
            {editing?.id === connection.id ? (
              <>
                <label className="flex items-center gap-1 text-foreground-subtlest">
                  Name
                  <input
                    className={`${inputClass} w-40`}
                    value={editing.name}
                    onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                  />
                </label>
                <label className="flex items-center gap-1 text-foreground-subtlest">
                  Base URL
                  <input
                    className={`${inputClass} w-56 font-mono`}
                    value={editing.baseUrl}
                    onChange={(event) => setEditing({ ...editing, baseUrl: event.target.value })}
                  />
                </label>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-5 px-1"
                  disabled={busy !== null}
                  title={busy ? `Waiting for: ${busy}` : "Save the changed fields to 9router"}
                  onClick={() => void saveEdit()}
                >
                  Save
                </Button>
                <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <span className={cn("min-w-0 flex-1 truncate", statusTone(connection))} title={statusTitle(connection)}>
                  {connection.name}
                </span>
                <span className="w-40 shrink-0 truncate text-foreground-subtlest" title={connection.baseUrl ?? connection.provider}>
                  {connection.prefix ? `${connection.prefix}/…` : connection.provider}
                </span>
                <span className="w-14 shrink-0 text-foreground-subtlest">{connection.authType ?? ""}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1"
                  title={`Edit the name or base URL of ${connection.name}`}
                  onClick={() => setEditing({ id: connection.id, name: connection.name, baseUrl: connection.baseUrl ?? "" })}
                >
                  Edit
                </Button>
                {connection.authType === "oauth" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-5 px-1"
                    title="Open the 9router dashboard to manage this account's sign-in"
                    onClick={() => void openSignIn()}
                  >
                    Sign-in
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" className="h-5 px-1" disabled={testing === connection.id} onClick={() => void test(connection)}>
                  {testing === connection.id ? "…" : "Test"}
                </Button>
                {confirmDelete === connection.id ? (
                  <span className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-5 px-1"
                      onClick={() => {
                        setConfirmDelete(null);
                        void zaicodeRouterChange("Removing", { method: "DELETE", path: `/api/providers/${connection.id}` }).then((result) =>
                          toast(result.ok ? `${connection.name} removed` : result.message),
                        );
                      }}
                    >
                      Remove
                    </Button>
                    <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => setConfirmDelete(null)}>
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => setConfirmDelete(connection.id)} title="Remove this connection from 9router">
                    ✕
                  </Button>
                )}
              </>
            )}
          </div>
        ))}
        {shown.length === 0 ? <div className="px-2 py-1 text-foreground-subtlest">Nothing matches.</div> : null}
      </div>
      <AddProviderForm />
      <AddKeyForm />
        </div>
      </details>
    </section>
  );
}
