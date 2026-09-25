import type { ZaicodeEngineAccount } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { readZaicodeEnginesState } from "../zaicodeEngines.js";
import { launchZaicodeWorker } from "../zaicodeWorkers.js";
import { startZaicodeSubchat, zaicodeSubscriptionPromptGoesToChat } from "./zaicodeSubchatStore.js";

/**
 * One route for "a prompt for the picked subscription" (composer and START,
 * T-51): a SUBCHAT when the setting says chat and the account can chat
 * headless, otherwise a worker as before. No prompt = the configured START
 * prompt. A worker start always reports; a chat only reports a failure (the
 * chat itself is on screen).
 */
export function routeZaicodeSubscriptionPrompt(account: ZaicodeEngineAccount, projectPath: string, prompt?: string): void {
  if (zaicodeSubscriptionPromptGoesToChat(account)) {
    const text = prompt ?? readZaicodeEnginesState().config.workerPrompt;
    void startZaicodeSubchat({ account, projectPath, prompt: text }).then((result) => {
      if (result && !result.ok) toast(result.message);
    });
    return;
  }
  void launchZaicodeWorker({ account, projectPath, ...(prompt ? { prompt } : {}) }).then((result) => toast(result.message));
}
