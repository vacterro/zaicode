import { useEffect, useState } from "react";
import {
  ZAICODE_AGENT_ROLES,
  ZAICODE_DELEGATION_DEFAULT_POLICY,
  ZAICODE_DELEGATION_MAX_CHILDREN_LIMIT,
  type ZaicodeAgentRole,
  type ZaicodeDelegationPolicy,
} from "@zcode/shared";
import { ZaicodePrefCheck, ZaicodePrefStepper } from "@/zaicode/ZaicodePrefControls.js";
import type { ZaicodeServices } from "@/zaicode/zaicodeServices.js";

/**
 * Settings -> ZAICODE -> Delegation: how far a running coordinator may hand
 * work to helpers on its own (T-10). The limits are the operator's; the queue
 * service enforces them on every request.
 */
export function ZaicodeDelegationSettings({ services }: { services: ZaicodeServices }) {
  const [policy, setPolicy] = useState<ZaicodeDelegationPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void services.jobs
      .getDelegationPolicy()
      .then((value) => {
        if (!disposed) setPolicy(value);
      })
      .catch((caught: unknown) => {
        if (!disposed) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      disposed = true;
    };
  }, [services]);

  const save = (next: ZaicodeDelegationPolicy) => {
    setPolicy(next);
    void services.jobs
      .setDelegationPolicy(next)
      .then(setPolicy)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  };
  const toggleRole = (key: "parentRoles" | "childRoles", role: ZaicodeAgentRole, on: boolean) => {
    if (!policy) return;
    const current = new Set(policy[key]);
    if (on) current.add(role);
    else current.delete(role);
    save({ ...policy, [key]: ZAICODE_AGENT_ROLES.filter((item) => current.has(item)) });
  };

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 text-ui-xs" data-zaicode-delegation-settings>
      <div>
        <h2 className="text-ui-lg text-foreground">Delegation</h2>
        <p className="mt-1 max-w-[620px] text-ui-base text-foreground-subtle">
          A running coordinator job may hand parts of its task to helper agents by itself. Helpers run as ordinary queued jobs linked to their parent,
          cannot delegate further and do not take over the parent&apos;s SAIPEN Work; their results come back to the parent. 0 helpers switches it off.
        </p>
      </div>
      {error ? <p className="text-destructive">{error}</p> : null}
      {policy ? (
        <div className="flex max-w-[520px] flex-col gap-2">
          <ZaicodePrefStepper
            label="Helpers per coordinator run"
            value={policy.maxChildrenPerParent}
            min={0}
            max={ZAICODE_DELEGATION_MAX_CHILDREN_LIMIT}
            onChange={(value) => save({ ...policy, maxChildrenPerParent: value })}
          />
          <div className="flex flex-col gap-1">
            <span className="text-foreground-subtle">Roles that may delegate</span>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {ZAICODE_AGENT_ROLES.filter((role) => role === "coordinator" || role === "implementer").map((role) => (
                <ZaicodePrefCheck
                  key={role}
                  checked={policy.parentRoles.includes(role)}
                  onChange={(on) => toggleRole("parentRoles", role, on)}
                  label={role}
                />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-foreground-subtle">Helper roles</span>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {ZAICODE_AGENT_ROLES.filter((role) => role !== "coordinator").map((role) => (
                <ZaicodePrefCheck
                  key={role}
                  checked={policy.childRoles.includes(role)}
                  onChange={(on) => toggleRole("childRoles", role, on)}
                  label={role}
                />
              ))}
            </div>
          </div>
          <button
            type="button"
            className="self-start text-foreground-subtlest underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => save(ZAICODE_DELEGATION_DEFAULT_POLICY)}
          >
            Reset to the operator default (coordinator, 3 helpers)
          </button>
        </div>
      ) : null}
    </section>
  );
}
