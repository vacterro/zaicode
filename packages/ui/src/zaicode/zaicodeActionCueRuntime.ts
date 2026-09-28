import { useEffect } from "react";
import { isZaicodeProductMode } from "@zcode/shared";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { readZaicodeSoundSettings } from "./zaicodeSoundSettingsModel.js";
import {
  admitZaicodeActionCue,
  createZaicodeCueGateMemory,
  zaicodeActionCueForSessionStatus,
  zaicodeActionCueForToolCall,
  type ZaicodeActionCueId,
} from "./zaicodeActionCues.js";
import type { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";

/**
 * Where the agent-action cues come from (Wave 3, part C).
 *
 * The runtime knows what a tool IS: its name, its presentation family and the
 * structured result that says whether a file was created. This module turns
 * that into event ids and hands them to the existing sound bus. It never reads
 * a rendered message, so the language the model answers in cannot change which
 * cue plays, and a cue can only exist as an id in the same Sounds table every
 * other event lives in.
 *
 * Every cue goes through the gate: a turn that reads 500 files is one turn,
 * not 500 clicks.
 */

export interface ZaicodeCueContext {
  sessionId: string;
  toolCallId?: string;
  toolName?: string;
  createdFile?: boolean;
}

export function emitZaicodeActionCue(cue: ZaicodeActionCueId, memory = defaultCueMemory(), now = Date.now()): boolean {
  if (!isZaicodeProductMode()) return false;
  const settings = readZaicodeSoundSettings();
  if (settings.muted || settings.events[cue]?.enabled !== true) return false;
  if (!admitZaicodeActionCue(cue, now, memory)) return false;
  playZaicodeSound(cue);
  return true;
}

let sharedMemory = createZaicodeCueGateMemory();

function defaultCueMemory() {
  return sharedMemory;
}

/** The structured "this created a file" signal, read from the tool's own result. */
function createdFileSignal(row: ToolCallRow): boolean {
  const display = row.display as { kind?: string; changeType?: string; operationKind?: string } | undefined;
  if (display?.changeType === "add") return true;
  if (display?.operationKind === "write") return true;
  return false;
}

function familyOf(toolName: string): string {
  // The presentation family is derived from the tool NAME, the same identity
  // the renderers route on, so the cue and the block on screen agree.
  if (/^(Read|View|NotebookRead)$/i.test(toolName)) return "file-read";
  if (/^(Grep|Glob|WebFetch|WebSearch)$/i.test(toolName)) return "search";
  if (/^(Write|Edit|ApplyPatch|MultiEdit)$/i.test(toolName)) return "file-write";
  if (/^(Bash|Shell|PowerShell|Terminal)$/i.test(toolName)) return "shell";
  if (/^(TodoWrite|TodoRead|UpdatePlan|ExitPlanMode)$/i.test(toolName)) return "plan-guidance";
  return "";
}

/**
 * Mount once with the app runtime. It watches the conversation projection and
 * emits a cue when a tool call reaches a terminal state, or when the session's
 * own status changes. Nothing here renders, and nothing here decides WHAT a
 * sound is: the Sounds table does.
 */
export function useZaicodeActionCues(store: ConversationProjectionStore | null | undefined): void {
  useEffect(() => {
    if (!isZaicodeProductMode() || !store) return;
    let seenTools = new Set<string>();
    let lastStatus: string | undefined;

    return store.subscribe(() => {
      const snapshot = store.getState().snapshot;
      if (!snapshot) return;

      const control = snapshot.control as { phase?: string; lastError?: unknown; apiRetry?: unknown };
      const status = control.phase === "running" ? "running" : control.lastError ? "failed" : control.phase ?? "";
      if (status !== lastStatus) {
        const cue = zaicodeActionCueForSessionStatus(status, lastStatus);
        lastStatus = status;
        if (cue) emitZaicodeActionCue(cue);
      }

      const rows = snapshot.rows?.window ?? [];
      for (const row of rows) {
        if (row.kind !== "toolCall") continue;
        const tool = row as ToolCallRow;
        if (tool.status === "running" || tool.status === "inputStreaming" || tool.status === "pendingApproval") continue;
        const key = `${snapshot.sessionId}:${tool.toolCallId}`;
        // A tool reaches one terminal state once; a re-render or a resync
        // replays the row without replaying the cue.
        if (seenTools.has(key)) continue;
        seenTools.add(key);
        if (seenTools.size > 2000) seenTools = new Set([...seenTools].slice(-1000));
        if (tool.status === "cancelled") {
          emitZaicodeActionCue("agent.cancel");
          continue;
        }
        if (tool.status === "error") {
          emitZaicodeActionCue("agent.failure");
          continue;
        }
        emitZaicodeActionCue(
          zaicodeActionCueForToolCall({ name: tool.toolName, family: familyOf(tool.toolName), createdFile: createdFileSignal(tool) }),
        );
      }
    });
  }, []);
}
