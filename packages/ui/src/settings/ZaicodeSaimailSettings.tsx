import { useEffect, useState } from "react";
import { FolderOpen, Mail } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZaicodeSaimailConfig, useZaicodeSaimailDesk } from "@/zaicode/zaicodeSaimail.js";
import { ZAICODE_SAIMAIL_WHAT } from "@/zaicode/ZaicodeSaimailHeaderButton.js";

/**
 * Settings -> ZAICODE -> SAIMAIL: one field, the local mailbox folder of this
 * machine's operator seat. ZAICODE only reads headers from it; agents get it
 * as SAIMAIL_WORKSPACE on the next ZAICODE start (SAIPEN then counts unread
 * telegrams at turn entry). "Create mailbox" runs `saimail-local init` for the
 * operator seat, and only on that explicit click.
 */
export function ZaicodeSaimailSettings() {
  const platform = usePlatform();
  const { mailbox, desk } = useZaicodeSaimailDesk(null);
  const save = useZaicodeSaimailConfig((state) => state.set);
  const create = useZaicodeSaimailConfig((state) => state.create);
  const [draft, setDraft] = useState(mailbox ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(mailbox ?? ""), [mailbox]);
  const supported = Boolean(platform.setZaicodeSaimailWorkspace);
  const canCreate = Boolean(platform.initZaicodeSaimailWorkspace);
  const trimmed = draft.trim();
  const dirty = trimmed !== (mailbox ?? "");

  const run = (action: () => Promise<string | null>) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    void action()
      .then((message) => setNotice(message))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      )
      .finally(() => setBusy(false));
  };

  const apply = (value: string | null) =>
    run(async () => {
      await save(platform, value);
      return value
        ? "Saved. The mailbox shows in the title bar now; agents see SAIMAIL_WORKSPACE after the next ZAICODE start."
        : "SAIMAIL is off.";
    });

  const createHere = (folder: string) =>
    run(async () => {
      const result = await create(platform, folder);
      if (!result.ok) throw new Error(result.message);
      return `${result.message} Restart ZAICODE once so agents get SAIMAIL_WORKSPACE.`;
    });

  const browse = () => {
    void platform
      .selectDirectory()
      .then((folder) => {
        if (!folder) return;
        setDraft(folder);
        setNotice(null);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  };

  const status = !mailbox
    ? "Off. Pick a folder for your mailbox, then Save (or Create mailbox for a new one)."
    : desk
      ? `Connected: seat ${desk.seat}, ${desk.unread.length} unread.`
      : "This folder is not a SAIMAIL mailbox yet.";

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-ui-lg text-foreground">
        <Mail className="size-4" />
        SAIMAIL
      </h2>
      <p className="mt-1 text-ui-base text-foreground">{ZAICODE_SAIMAIL_WHAT}</p>
      <p className="mt-1 text-ui-xs text-foreground-subtle">
        ZAICODE shows only unread headers (kind, sender, topic) in the title bar and never opens or
        decrypts a message; reading stays an explicit agent step.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <Input
          value={draft}
          disabled={!supported || busy}
          placeholder="C:\mail\operator"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            setNotice(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && dirty) apply(trimmed || null);
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!supported || busy}
          onClick={browse}
          title="Choose a folder"
        >
          <FolderOpen className="size-3.5" />
          Browse…
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!supported || busy || !dirty}
          onClick={() => apply(trimmed || null)}
        >
          Save
        </Button>
        {mailbox ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={!supported || busy}
            onClick={() => apply(null)}
          >
            Off
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-ui-xs text-foreground">{status}</p>
      {canCreate && trimmed && (dirty || !desk) ? (
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => createHere(trimmed)}
            title={`saimail-local init --workspace "${trimmed}" --seat operator`}
          >
            <Mail className="size-3.5" />
            {busy ? "Working…" : "Create mailbox here"}
          </Button>
          <span className="min-w-0 truncate text-ui-xs text-foreground-subtle">
            New operator seat in this folder; an existing mailbox is kept as is.
          </span>
        </div>
      ) : null}
      {!supported ? (
        <p className="mt-1 text-ui-xs text-destructive">
          This build cannot store the mailbox path. Rebuild ZAICODE (pnpm bundle:zaicode).
        </p>
      ) : null}
      {notice ? <p className="mt-1 text-ui-xs text-foreground-subtle">{notice}</p> : null}
      {error ? <p className="mt-1 text-ui-xs text-destructive">{error}</p> : null}
    </section>
  );
}
