import type { IZaicodeAgentService, IZaicodeJobService } from "@zcode/services";

export const ZAICODE_REMOTE_UNAVAILABLE_MESSAGE =
  "ZAICODE services are unavailable on this remote host; update the remote environment to enable agents and the queue.";

type ZaicodeRemoteConnectionServices = {
  zaicodeAgentService?: IZaicodeAgentService;
  zaicodeJobService?: IZaicodeJobService;
};

function rejectZaicodeRemoteCall(): Promise<never> {
  return Promise.reject(new Error(ZAICODE_REMOTE_UNAVAILABLE_MESSAGE));
}

function createUnavailableZaicodeAgentService(): IZaicodeAgentService {
  return {
    list: rejectZaicodeRemoteCall,
    get: rejectZaicodeRemoteCall,
    create: rejectZaicodeRemoteCall,
    update: rejectZaicodeRemoteCall,
    duplicate: rejectZaicodeRemoteCall,
    remove: rejectZaicodeRemoteCall,
    listTemplates: rejectZaicodeRemoteCall,
    createFromTemplate: rejectZaicodeRemoteCall,
  };
}

function createUnavailableZaicodeJobService(): IZaicodeJobService {
  return {
    list: rejectZaicodeRemoteCall,
    get: rejectZaicodeRemoteCall,
    create: rejectZaicodeRemoteCall,
    update: rejectZaicodeRemoteCall,
    reorder: rejectZaicodeRemoteCall,
    dispatch: rejectZaicodeRemoteCall,
    pump: rejectZaicodeRemoteCall,
    cancel: rejectZaicodeRemoteCall,
    retry: rejectZaicodeRemoteCall,
    resume: rejectZaicodeRemoteCall,
    remove: rejectZaicodeRemoteCall,
    reconcileStaleRuns: rejectZaicodeRemoteCall,
    getMaxConcurrency: rejectZaicodeRemoteCall,
    setMaxConcurrency: rejectZaicodeRemoteCall,
    getAutoRun: rejectZaicodeRemoteCall,
    setAutoRun: rejectZaicodeRemoteCall,
    reportRunOutcome: rejectZaicodeRemoteCall,
    delegateFromRun: rejectZaicodeRemoteCall,
    getDelegationPolicy: rejectZaicodeRemoteCall,
    setDelegationPolicy: rejectZaicodeRemoteCall,
    getDisabledWorkspaces: rejectZaicodeRemoteCall,
    setWorkspaceDisabled: rejectZaicodeRemoteCall,
  };
}

export function resolveZaicodeRemoteWorkspaceServices(
  connectionServices: ZaicodeRemoteConnectionServices,
): Required<ZaicodeRemoteConnectionServices> {
  return {
    zaicodeAgentService:
      connectionServices.zaicodeAgentService ?? createUnavailableZaicodeAgentService(),
    zaicodeJobService: connectionServices.zaicodeJobService ?? createUnavailableZaicodeJobService(),
  };
}
