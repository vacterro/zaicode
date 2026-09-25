import { useState } from "react";
import { Users } from "lucide-react";
import type { ZaicodeAgentCreateInput, ZaicodeAgentDefinition, ZaicodeAgentTemplate } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZaicodePoolGroups } from "./ZaicodePoolPicker.js";
import { backendForPool, type ZaicodePoolGroup } from "./zaicodeRoutingModel.js";

/**
 * Ready-made teams for the ZAICODE workspace: one click adds a small set of
 * agents, each on the pool that suits its job (SAIOPP for the thinking work,
 * SAIFREN for the cheap work). The operator's own way of working is the
 * "Builder + Reviewer" team. Adding a team never duplicates an agent that is
 * already there (matched by name) and every agent stays fully editable.
 */

export interface ZaicodeTeamMember {
  templateId: string;
  name: string;
  /** Pool model id (SAIFREN / SAIOPP); the agent stays without a pool when it is not configured. */
  pool: string;
}

export interface ZaicodeTeamPreset {
  id: string;
  name: string;
  hint: string;
  members: readonly ZaicodeTeamMember[];
}

export const ZAICODE_TEAM_PRESETS: readonly ZaicodeTeamPreset[] = [
  {
    id: "solo",
    name: "Solo",
    hint: "One agent does a task end to end. The cheapest way to start.",
    members: [{ templateId: "zaicode-template:implementer", name: "Implementer", pool: "SAIFREN" }],
  },
  {
    id: "builder-reviewer",
    name: "Builder + Reviewer",
    hint: "How the operator works: a SAIPEN builder on the deep pool, a reviewer on the free pool checks every result.",
    members: [
      { templateId: "zaicode-template:saipen-operator", name: "Builder", pool: "SAIOPP" },
      { templateId: "zaicode-template:auditor", name: "Reviewer", pool: "SAIFREN" },
    ],
  },
  {
    id: "crew",
    name: "SAIPEN crew",
    hint: "Coordinator splits the work, Builder implements, Tester proves it, Auditor reviews. For long goals.",
    members: [
      { templateId: "zaicode-template:coordinator", name: "Coordinator", pool: "SAIOPP" },
      { templateId: "zaicode-template:saipen-operator", name: "Builder", pool: "SAIOPP" },
      { templateId: "zaicode-template:tester", name: "Tester", pool: "SAIFREN" },
      { templateId: "zaicode-template:auditor", name: "Auditor", pool: "SAIFREN" },
    ],
  },
  {
    id: "research-build",
    name: "Research → Build",
    hint: "A researcher reads docs and code first, an implementer builds from its notes.",
    members: [
      { templateId: "zaicode-template:researcher", name: "Researcher", pool: "SAIFREN" },
      { templateId: "zaicode-template:implementer", name: "Implementer", pool: "SAIOPP" },
    ],
  },
];

/** The create input for one member, or null when its template is unknown. */
export function zaicodeTeamMemberInput(
  member: ZaicodeTeamMember,
  templates: readonly ZaicodeAgentTemplate[],
  groups: readonly ZaicodePoolGroup[],
): ZaicodeAgentCreateInput | null {
  const template = templates.find((item) => item.id === member.templateId);
  if (!template) return null;
  const wanted = member.pool.toLowerCase();
  const pool = groups.flatMap((group) => group.options).find((option) => option.modelId.toLowerCase() === wanted);
  return {
    name: member.name,
    role: template.role,
    instructions: template.instructions,
    toolPolicy: { ...template.toolPolicy },
    templateId: template.id,
    ...(pool
      ? {
          modelSelection: { providerId: pool.providerId, modelId: pool.modelId },
          backend: backendForPool(pool.providerId, pool.providerLabel),
        }
      : {}),
  };
}

export function ZaicodeTeamPresetsStrip({
  agents,
  templates,
  busy,
  onCreate,
  onClose,
}: {
  agents: readonly ZaicodeAgentDefinition[];
  templates: readonly ZaicodeAgentTemplate[];
  busy: boolean;
  onCreate: (inputs: ZaicodeAgentCreateInput[]) => Promise<void>;
  onClose: () => void;
}) {
  const { groups } = useZaicodePoolGroups();
  const [result, setResult] = useState<string | null>(null);
  const names = new Set(agents.map((agent) => agent.name.trim().toLowerCase()));
  const pools = new Set(groups.flatMap((group) => group.options.map((option) => option.modelId.toLowerCase())));

  const apply = async (preset: ZaicodeTeamPreset) => {
    const inputs: ZaicodeAgentCreateInput[] = [];
    let present = 0;
    for (const member of preset.members) {
      if (names.has(member.name.toLowerCase())) {
        present += 1;
        continue;
      }
      const input = zaicodeTeamMemberInput(member, templates, groups);
      if (input) inputs.push(input);
    }
    await onCreate(inputs);
    const missingPools = [...new Set(preset.members.map((member) => member.pool))].filter(
      (pool) => !pools.has(pool.toLowerCase()),
    );
    setResult(
      `${preset.name}: added ${inputs.length} agent${inputs.length === 1 ? "" : "s"}` +
        (present > 0 ? `, ${present} already there` : "") +
        (missingPools.length > 0 ? `. No ${missingPools.join(" / ")} pool configured — pick a pool in each agent.` : "."),
    );
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-card px-3 py-2 text-ui-xs" data-zaicode-team-presets>
      <div className="flex items-center gap-2">
        <Users className="size-3.5 text-foreground-subtle" />
        <span className="font-medium text-foreground">Ready-made teams</span>
        <span className="text-foreground-subtle">One click adds the agents; edit or remove any of them later.</span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose}>
          Hide
        </Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-1.5">
        {ZAICODE_TEAM_PRESETS.map((preset) => {
          const allThere = preset.members.every((member) => names.has(member.name.toLowerCase()));
          return (
            <div key={preset.id} className="flex flex-col gap-1 border border-border bg-background p-2" data-zaicode-team-preset={preset.id}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-foreground">{preset.name}</span>
                <Button size="sm" variant="outline" disabled={busy || allThere} onClick={() => void apply(preset)}>
                  {allThere ? "Added" : "Add team"}
                </Button>
              </div>
              <span className="text-foreground-subtle">{preset.hint}</span>
              <span className="text-foreground-subtlest">
                {preset.members.map((member) => `${member.name} (${member.pool})`).join(" · ")}
              </span>
            </div>
          );
        })}
      </div>
      {result ? (
        <span className="text-foreground" role="status">
          {result}
        </span>
      ) : null}
    </div>
  );
}
