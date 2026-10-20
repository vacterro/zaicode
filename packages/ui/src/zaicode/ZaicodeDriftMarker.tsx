import { useMemo, useState } from "react";
import { Archive, ArchiveX, CircleAlert, FolderOpen, LoaderCircle, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { toast } from "@/components/ui/toast.js";
import {
  computeDriftProjectTotals,
  useDriftCaptureStore,
  type DriftCaptureMarker,
} from "./zaicodeDriftCaptureStore.js";
import { driftReceiptRetirement } from "./zaicodeDriftCaptureContract.js";

// SAIHANDOFF: a compact per-session marker for the drift evidence vault.
// It never shows a green state for evidence that was not re-hashed on disk,
// and it never deletes anything: the archive stays on disk when a marker is
// retired.

interface MarkerMeta {
  label: string;
  tone: string;
  Icon: typeof ShieldCheck;
}

const MARKER_META: Record<DriftCaptureMarker, MarkerMeta> = {
  NOT_CAPTURED: {
    label: "No drift evidence captured yet",
    tone: "text-foreground-subtlest",
    Icon: ShieldOff,
  },
  CAPTURING: { label: "Capturing drift evidence", tone: "text-info", Icon: LoaderCircle },
  SAVED_VERIFIED: {
    label: "Drift evidence saved and verified",
    tone: "text-success",
    Icon: ShieldCheck,
  },
  SAVED_WITH_NEW_ACTIVITY: {
    label: "Session changed after the last capture",
    tone: "text-warning",
    Icon: Archive,
  },
  FILE_MISSING: {
    label: "Saved evidence file is missing",
    tone: "text-danger",
    Icon: ArchiveX,
  },
  INTEGRITY_FAILED: {
    label: "Saved evidence failed its digest check",
    tone: "text-danger",
    Icon: CircleAlert,
  },
  CAPTURE_FAILED: { label: "Drift capture failed", tone: "text-danger", Icon: CircleAlert },
  UNVERIFIED: {
    label: "Drift evidence was never verified against the file system",
    tone: "text-foreground-subtle",
    Icon: ShieldOff,
  },
};

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? normalized : normalized.slice(0, index);
}

/** A file next to the evidence, keeping the separator style of the path. */
function siblingPath(path: string, name: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (index <= 0) return name;
  return `${trimmed.slice(0, index + 1)}${name}`;
}

export function ZaicodeDriftMarker({
  sessionId,
  workspacePath,
  workspaceIdentity,
  sessionUpdatedAt,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionUpdatedAt?: number;
}) {
  const marker = useDriftCaptureStore((state) =>
    state.markerFor(sessionId, workspacePath, workspaceIdentity, sessionUpdatedAt),
  );
  const receipt = useDriftCaptureStore((state) =>
    state.getReceipt(sessionId, workspacePath, workspaceIdentity),
  );
  const platform = usePlatform();
  if (marker === "NOT_CAPTURED") return null;
  const meta = MARKER_META[marker];
  const title = receipt?.capturedAt
    ? `${meta.label} — captured ${receipt.capturedAt}`
    : meta.label;
  return (
    <span className="inline-flex shrink-0 items-center" data-zaicode-drift-marker={marker}>
      <button
        type="button"
        className={`inline-flex items-center ${meta.tone}`}
        title={title}
        aria-label={title}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!receipt?.outputPath) {
            toast("No evidence file on disk for this session", { variant: "warning" });
            return;
          }
          void platform.openInFileManager(parentDirectory(receipt.outputPath));
        }}
      >
        <meta.Icon className="size-3.5" />
      </button>
    </span>
  );
}

export function ZaicodeDriftProjectTotals({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const receipts = useDriftCaptureStore((state) => state.receipts);
  const settings = useDriftCaptureStore((state) => state.settings);
  const removeReceipt = useDriftCaptureStore((state) => state.removeReceipt);
  const platform = usePlatform();
  const baseServices = useOptionalBaseWorkspaceServices();
  const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);
  const [deleting, setDeleting] = useState(false);
  const totals = useMemo(() => {
    const key = (workspaceIdentity ?? workspacePath).toLowerCase();
    return computeDriftProjectTotals(receipts).find((entry) => entry.projectKey === key);
  }, [receipts, workspaceIdentity, workspacePath]);
  const archiveDir = useMemo(() => {
    const key = (workspaceIdentity ?? workspacePath).toLowerCase();
    for (const receipt of Object.values(receipts)) {
      if ((receipt.workspaceIdentity ?? receipt.workspacePath).toLowerCase() !== key) continue;
      const match = /^(.*[\\/]projects[\\/][^\\/]+)/.exec(receipt.outputPath ?? "");
      if (match?.[1]) return match[1];
    }
    return undefined;
  }, [receipts, workspaceIdentity, workspacePath]);
  if (!totals || totals.sessions === 0) return null;

  // Evidence is deleted only on an explicit operator action, and only after
  // the confirmation the settings ask for. Nothing here runs automatically.
  const deleteEvidence = async () => {
    const fileService = baseServices?.fileService;
    if (!fileService) {
      toast("Host services unavailable", { variant: "warning" });
      return;
    }
    const key = (workspaceIdentity ?? workspacePath).toLowerCase();
    const projectReceipts = Object.values(receipts).filter(
      (receipt) => (receipt.workspaceIdentity ?? receipt.workspacePath).toLowerCase() === key,
    );
    const receiptPaths = projectReceipts.map((receipt) => ({
      receipt,
      paths: [
        receipt.outputPath,
        receipt.metadataPath,
        receipt.outputPath && siblingPath(receipt.outputPath, "sha256.txt"),
      ].filter((value): value is string => Boolean(value)),
    }));
    const paths = receiptPaths.flatMap((entry) => entry.paths);
    if (paths.length === 0) {
      toast("No archived evidence files to delete", { variant: "info" });
      return;
    }
    if (settings.confirmDeleteEvidence) {
      const confirmed = await requestConfirmation({
        title: "Delete archived drift evidence?",
        description: `${paths.length} file(s) are deleted permanently. This cannot be undone.`,
        confirmLabel: "Delete evidence",
        cancelLabel: "Keep evidence",
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
    }
    setDeleting(true);
    try {
      const result = await fileService.deleteFiles({ paths });
      // A receipt is retired only when its files are really gone from disk.
      // A failed delete keeps the marker, so the operator still sees the
      // archive and can retry instead of losing the pointer to live evidence.
      const retirement = driftReceiptRetirement(receiptPaths, result);
      receiptPaths.forEach((entry, index) => {
        if (!retirement.retired[index]) return;
        removeReceipt(entry.receipt.sessionId, entry.receipt.workspacePath, entry.receipt.workspaceIdentity);
      });
      toast(
        `Deleted ${result.deleted.length} evidence file(s)${
          result.failed.length ? `, ${result.failed.length} failed` : ""
        }${retirement.keptCount ? `, ${retirement.keptCount} archive marker(s) kept` : ""}`,
        { variant: result.failed.length || retirement.keptCount ? "warning" : "info" },
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: "warning" });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span
        className="text-ui-xs tabular-nums text-foreground-subtle"
        data-zaicode-drift-totals=""
        title={`${totals.verified} verified, ${totals.changed} changed, ${totals.failed} failed of ${totals.sessions} captured`}
      >
        {totals.verified}/{totals.sessions}
        {totals.changed > 0 ? ` · ${totals.changed} changed` : ""}
        {totals.failed > 0 ? ` · ${totals.failed} failed` : ""}
      </span>
      {archiveDir ? (
        <button
          type="button"
          className="inline-flex items-center text-foreground-subtlest hover:text-foreground"
          title="Open the drift evidence archive folder"
          aria-label="Open the drift evidence archive folder"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void platform.openInFileManager(archiveDir);
          }}
        >
          <FolderOpen className="size-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        className="inline-flex items-center text-foreground-subtlest hover:text-danger"
        title="Delete the archived drift evidence of this project"
        aria-label="Delete the archived drift evidence of this project"
        disabled={deleting}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void deleteEvidence();
        }}
      >
        <Trash2 className="size-3.5" />
      </button>
    </span>
  );
}
