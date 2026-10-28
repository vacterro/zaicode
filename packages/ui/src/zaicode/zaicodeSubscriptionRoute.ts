import type { ZaicodeEngineAccount } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { launchZaicodeWorker } from "./zaicodeWorkers.js";

/**
 * One route for "a prompt for the picked subscription tile" (composer and
 * START): the account's CLI starts as a worker in the project. No prompt = the
 * configured START prompt. SRC-062: SUBCHAT (the headless in-app chat) is gone
 * -- subscription accounts are models in the model menu now (SRC-061) -- so a
 * tile always means its CLI in a worker.
 */
export function routeZaicodeSubscriptionPrompt(account: ZaicodeEngineAccount, projectPath: string, prompt?: string): void {
  void launchZaicodeWorker({ account, projectPath, ...(prompt ? { prompt } : {}) }).then((result) => toast(result.message));
}
