import { useMemo, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { suggestZaicodeProviderPrefix, type ZaicodeRouterConnection } from "@zcode/shared";
import { useZaicodeRouter, zaicodeRouterCall, zaicodeRouterChange } from "@/zaicode/zaicodeRouter.js";

/**
 * Router -> Providers & keys: every 9router connection with its state, a
 * test and on/off; a form that adds an OpenAI- or Anthropic-compatible
 * provider with its key in one step (9router: provider node + connection),
 * and "another key" for an existing custom provider (9router rotates keys
 * of one provider as a key pool).
 */

type NodeType = "openai-compatible" | "anthropic-compatible";

const inputClass = "min-w-0 border border-border bg-background px-1 py-0.5 text-foreground";

function statusTone(connection: ZaicodeRouterConnection): string {
  if (!connection.isActive) return "text-foreground-subtlest";
  if (connection.testStatus === "active" || connection.testStatus === "success") return "text-[#7cc45a]";
  if (connection.lastError || connection.testStatus === "error" || connection.testStatus === "expired") return "text-destructive";
  return "text-foreground-subtle";
}

function AddProviderForm() {
  const nodes = useZaicodeRouter((state) => state.nodes);
  const [type, setType] = useState<NodeType>("openai-compatible");
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiType, setApiType] = useState<"chat" | "responses">("chat");
  const [apiKey, setApiKey] = useState("");
  const taken = nodes.map((node) => node.prefix);
  const effectivePrefix = prefix.trim() || suggestZaicodeProviderPrefix(name, taken);
  const canAdd = name.trim() && baseUrl.trim() && apiKey.trim();

  const add = async () => {
    const created = await zaicodeRouterCall<{ node?: { id?: string } }>({
      method: "POST",
      path: "/api/provider-nodes",
      body: { type, name: name.trim(), prefix: effectivePrefix, baseUrl: baseUrl.trim(), ...(type === "openai-compatible" ? { apiType } : {}) },
    });
    const nodeId = created.data?.node?.id;
    if (!created.ok || !nodeId) {
      toast(`Provider not added: ${created.message || "9router returned no node"}`);
      return;
    }
    const connected = await zaicodeRouterChange("Adding key", {
      method: "POST",
      path: "/api/providers",
      body: { provider: nodeId, apiKey: apiKey.trim(), name: name.trim() },
    });
    toast(connected.ok ? `${name.trim()} added as ${effectivePrefix}/…` : `Key not saved: ${connected.message}`);
    if (connected.ok) {
      setName("");
      setPrefix("");
      setBaseUrl("");
      setApiKey("");
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
      <Button size="sm" variant="secondary" className="self-start" disabled={!canAdd} onClick={() => void add()}>
        Add provider
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

  return (
    <section className="flex flex-col gap-2 border border-border bg-card p-3 text-ui-xs" data-zaicode-router-providers>
      <div className="flex items-center gap-2">
        <h2 className="text-ui-lg text-foreground">Providers &amp; keys</h2>
        <span className="text-foreground-subtlest">{connections.length} connections{busy ? ` · ${busy}…` : ""}</span>
        <input className={`${inputClass} ml-auto w-48`} placeholder="Filter…" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      <p className="text-foreground-subtle">
        OAuth subscriptions (Claude Code, Codex, Antigravity, …) are connected in the 9router dashboard (their login runs in the browser); they then show
        here and their models can join a pool.
      </p>
      <div className="flex max-h-[360px] flex-col overflow-y-auto border border-border">
        {shown.map((connection) => (
          <div key={connection.id} className="flex items-center gap-2 border-b border-border/50 px-1.5 py-0.5 last:border-b-0">
            <input
              type="checkbox"
              checked={connection.isActive}
              title={connection.isActive ? "On: 9router routes to it" : "Off: 9router skips it"}
              onChange={(event) =>
                void zaicodeRouterChange("Saving", { method: "PUT", path: `/api/providers/${connection.id}`, body: { isActive: event.target.checked } })
              }
            />
            <span className={cn("min-w-0 flex-1 truncate", statusTone(connection))} title={connection.lastError ?? connection.testStatus ?? ""}>
              {connection.name}
            </span>
            <span className="w-40 shrink-0 truncate text-foreground-subtlest" title={connection.baseUrl ?? connection.provider}>
              {connection.prefix ? `${connection.prefix}/…` : connection.provider}
            </span>
            <span className="w-14 shrink-0 text-foreground-subtlest">{connection.authType ?? ""}</span>
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
          </div>
        ))}
        {shown.length === 0 ? <div className="px-2 py-1 text-foreground-subtlest">Nothing matches.</div> : null}
      </div>
      <AddProviderForm />
      <AddKeyForm />
    </section>
  );
}
