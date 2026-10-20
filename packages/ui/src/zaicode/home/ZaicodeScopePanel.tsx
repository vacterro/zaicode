import { useEffect, useState } from "react";
import { emptyZaicodeStatsTotals, type ZaicodeStatsTotals } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useServices } from "@/hooks/useServices.js";
import {
  ZAICODE_USAGE_SCOPE_LABEL,
  ZAICODE_USAGE_SCOPES,
  zaicodeScopeIsEmpty,
  zaicodeScopeRequest,
  zaicodeScopeSessionLabel,
  zaicodeScopeSummary,
  type ZaicodeUsageScopeId,
} from "./zaicodeUsageScope.js";

interface ScopeOption {
  key: string;
  label: string;
}

/**
 * REQ-012: usage attribution picker. Global / project / session slices all
 * come from recorded (project, session_id) attribution via getScopeTotals;
 * the picker only lists keys that actually appear in storage. Router-wide
 * usage stays on the Usage page — this panel is locally recorded usage.
 */
export function ZaicodeUsageScope() {
  const { zaicodeStatsService } = useServices();
  const [scope, setScope] = useState<ZaicodeUsageScopeId>("global");
  const [projects, setProjects] = useState<ScopeOption[]>([]);
  const [sessions, setSessions] = useState<{ id: string; label: string; project: string | null }[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [totals, setTotals] = useState<ZaicodeStatsTotals | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Scope keys come from storage, newest first; the first key preselects so no tab is a dead end.
  useEffect(() => {
    if (!zaicodeStatsService) return;
    let disposed = false;
    void Promise.all([zaicodeStatsService.getScopeProjects(), zaicodeStatsService.getScopeSessions(null)])
      .then(([projectRows, sessionRows]) => {
        if (disposed) return;
        setProjects(projectRows.map((row) => ({ key: row.project, label: `${row.project} · ${row.events} events` })));
        setSessions(sessionRows.map((row) => ({ id: row.sessionId, label: zaicodeScopeSessionLabel(row.sessionId, row.project), project: row.project })));
        setProject((current) => current ?? projectRows[0]?.project ?? null);
        setSessionId((current) => current ?? sessionRows[0]?.sessionId ?? null);
      })
      .catch((fetchError: unknown) => {
        if (!disposed) setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      });
    return () => {
      disposed = true;
    };
  }, [zaicodeStatsService]);

  useEffect(() => {
    const request = zaicodeScopeRequest(scope, { project, sessionId });
    if (!zaicodeStatsService || !request) {
      setTotals(null);
      return;
    }
    let disposed = false;
    setLoading(true);
    zaicodeStatsService
      .getScopeTotals(request.project, request.sessionId)
      .then((value) => {
        if (!disposed) {
          setTotals(value);
          setError(null);
        }
      })
      .catch((fetchError: unknown) => {
        if (!disposed) {
          setTotals(null);
          setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [zaicodeStatsService, scope, project, sessionId]);

  if (!zaicodeStatsService) return null;
  const shown = totals ?? emptyZaicodeStatsTotals();
  return (
    <div className="flex flex-col gap-1 border-t border-border/70 pt-1" data-zaicode-usage-scope>
      <span role="group" aria-label="Usage scope" className="flex gap-px">
        {ZAICODE_USAGE_SCOPES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={scope === value}
            className={cn(
              "border px-1",
              scope === value
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground"
                : "border-border hover:text-foreground",
            )}
            onClick={() => setScope(value)}
          >
            {ZAICODE_USAGE_SCOPE_LABEL[value]}
          </button>
        ))}
      </span>
      {scope !== "global" && (
        <span className="flex flex-wrap items-center gap-1">
          <select
            aria-label={scope === "project" ? "Project scope" : "Session project filter"}
            className="border border-border bg-background px-1"
            value={project ?? ""}
            onChange={(event) => {
              setProject(event.target.value || null);
              setSessionId(null);
            }}
          >
            {scope === "session" && <option value="">All projects</option>}
            {projects.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          {scope === "session" && (
            <select
              aria-label="Session scope"
              className="border border-border bg-background px-1"
              value={sessionId ?? ""}
              onChange={(event) => setSessionId(event.target.value || null)}
            >
              {sessions
                .filter((row) => !project || row.project === project)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label}
                  </option>
                ))}
            </select>
          )}
        </span>
      )}
      <span className="text-foreground" title={zaicodeScopeSummary(shown)}>
        {loading ? "Reading scope…" : zaicodeScopeSummary(shown)}
      </span>
      {error ? (
        <span className="text-foreground-subtle">Scope unavailable: {error}</span>
      ) : (
        totals &&
        zaicodeScopeIsEmpty(totals) && (
          <span className="text-foreground-subtle">No recorded events for this scope — not zero usage everywhere.</span>
        )
      )}
      <span className="text-[10px] text-foreground-subtlest">
        Locally recorded usage only. Router-wide usage stays on the Usage page.
      </span>
    </div>
  );
}
