import type { ZaicodeAgentToolPolicy, ZaicodeRouteBackend } from "@zcode/shared";

/** Build route and tool-policy fields emitted by the agent editor. */
export function buildZaicodeAgentEditorRoutingFields(
  backend: ZaicodeRouteBackend,
  currentToolPolicy: ZaicodeAgentToolPolicy | undefined,
  permissionPlan: boolean,
): { backend: ZaicodeRouteBackend; toolPolicy: ZaicodeAgentToolPolicy } {
  return {
    backend,
    toolPolicy: {
      ...currentToolPolicy,
      // Default is explicit yolo (full access); plan is opt-in via the switch.
      permissionMode: permissionPlan ? "plan" : "yolo",
    },
  };
}
