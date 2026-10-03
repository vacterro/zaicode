import { useEffect, useState } from "react";
import { resolveWorkspaceKey } from "@zcode/shared";
import { Inbox } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useZaicodeAuditStore } from "./zaicodeAuditStore.js";
import { zaicodeOutboxCollectGuard } from "./zaicodeSubOutbox.js";
import { useZaicodeSubOutbox } from "./useZaicodeSubOutbox.js";

/**
 * SRC-112: the SubSaipen OUTBOX, in one row above the composer.
 *
 * A subSaipen leaves finished work in its OUTBOX and never touches the board.
 * Without a surface, that work sits invisible until someone goes looking, so
 * this row says how many packages are ready and offers the one action the
 * protocol defines: Collect, which is the canonical `saipen collect <producer>`
 * -- SAIPEN keeps admission and decides what becomes a ticket.
 *
 * Auto-continuation is the sidebar's own Auto switch, not a second one here:
 * one meaning for "nothing acts by itself". While it is ON and the composer
 * can send, a newly ready producer collects itself once -- guarded by a
 * signature, so a poll that sees the same package again never sends twice.
 */
export function ZaicodeSubOutboxChip({
  workspacePath,
  workspaceIdentity,
  disabled,
  onCommand,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  disabled: boolean;
  onCommand: (command: string) => boolean | void;
  className?: string;
}) {
  const outbox = useZaicodeSubOutbox(workspacePath, workspaceIdentity);
  const auto = useZaicodeAuditStore((state) => state.smartMode);
  const [open, setOpen] = useState(false);
  const producers = outbox?.producers ?? [];
  const workspaceKey = resolveWorkspaceKey({ workspacePath, workspaceIdentity });

  useEffect(() => {
    if (!auto || disabled || !outbox || outbox.readError) return;
    // 输入框暂时禁用不能清除已投递代；多个 composer 也共享同一工作区的保护。
    zaicodeOutboxCollectGuard.collect(workspaceKey, outbox.packages, onCommand);
  }, [auto, disabled, onCommand, outbox, workspaceKey]);

  if (!outbox) return null;
  const { counts } = outbox;
  if (!counts.actionable && !open) return null;

  const label = [
    counts.ready > 0 ? `${counts.ready} ready` : null,
    counts.blocked > 0 ? `${counts.blocked} blocked` : null,
    counts.draft > 0 ? `${counts.draft} in progress` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const listed = outbox.packages.filter(
    (entry) => entry.status === "ready" || entry.status === "blocked",
  );

  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}
      data-zaicode-sub-outbox={counts.ready}
    >
      <button
        type="button"
        className="flex h-6 min-w-0 shrink-0 items-center gap-1.5 border border-border px-2 text-ui-xs text-foreground hover:bg-hover"
        title={[
          outbox.readError
            ? `OUTBOX could not be read: ${outbox.readError}`
            : "SubSaipen packages in .saipen/extensions/subs/*/kitchen/OUTBOX.md",
          label,
          "Click: the full list.",
        ]
          .filter(Boolean)
          .join("\n")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-zaicode-sub-outbox-toggle
      >
        <Inbox className="size-3 shrink-0" />
        <span className="truncate tabular-nums">{label || "OUTBOX"}</span>
      </button>
      {counts.ready > 0 ? (
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1.5 border border-[var(--zaicode-highlight,var(--color-border-hover))] px-2 text-ui-xs text-foreground hover:bg-hover disabled:opacity-45"
          disabled={disabled}
          title={`Collect ${producers.join(", ")} -- the canonical saipen collect command; SAIPEN keeps admission and decides what becomes a ticket.`}
          onClick={() => {
            const accepted = zaicodeOutboxCollectGuard.collect(
              workspaceKey,
              outbox.packages,
              onCommand,
              true,
            );
            if (accepted.length > 0)
              toast(`Collecting ${accepted.join(", ")}.`, { durationMs: 5000 });
          }}
          data-zaicode-sub-outbox-collect={producers.join(",")}
        >
          COLLECT
        </button>
      ) : null}
      {open ? (
        <div className="flex min-w-0 basis-full flex-col gap-0.5 text-ui-xs text-foreground-subtlest">
          {listed.length === 0 ? (
            <span>No package is waiting. A subSaipen writes its OUTBOX when it finishes.</span>
          ) : (
            listed.map((entry) => (
              <span key={entry.id} className="truncate" title={entry.summary ?? entry.title}>
                <span className={entry.critical ? "text-destructive" : undefined}>
                  {entry.id} · {entry.status}
                </span>
                {entry.severity ? ` ${entry.severity}` : ""} — {entry.title}
              </span>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
