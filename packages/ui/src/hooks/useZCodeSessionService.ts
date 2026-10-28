import type { IZCodeSessionService } from "@zcode/services";
import { useWorkspaceOrContextServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  const services = useWorkspaceOrContextServices(workspacePath, preferredRemoteSessionId, workspaceIdentity);
  return services.zcodeSessionService;
}
