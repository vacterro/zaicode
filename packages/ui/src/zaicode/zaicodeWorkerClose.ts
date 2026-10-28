import type { ConfirmDialogRequest } from "@/store/confirmDialogStore.js";
import { zaicodeWorkerTitle, type ZaicodeWorker } from "./zaicodeWorkers.js";

/**
 * Whether closing a worker asks first, and what it says (T-128). A running worker asks when the setting says so; one that
 * already ended closes without a question. The question is the app's own dialog (the operating system's froze the window
 * and beeped); this only builds it, so it can be read without a window.
 */
export function zaicodeWorkerCloseRequest(worker: ZaicodeWorker, confirmClose: boolean): ConfirmDialogRequest | null {
  if (worker.exitCode !== null || !confirmClose) return null;
  return {
    title: `Stop ${zaicodeWorkerTitle(worker)}?`,
    description: `The ${worker.label} process in ${worker.projectPath} ends and its terminal closes.`,
    confirmLabel: "Stop and close",
    confirmVariant: "destructive",
  };
}
