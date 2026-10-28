import type { IZCodeAgentService } from "@zcode/services";
import { useWorkspaceOrContextServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  const services = useWorkspaceOrContextServices(workspacePath, preferredRemoteSessionId, workspaceIdentity);
  return services.zcodeAgentService;
}
