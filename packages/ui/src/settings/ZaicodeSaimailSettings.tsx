import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FolderOpen, Mail, XCircle } from "lucide-react";
import type { ZaicodeSaimailCheck, ZaicodeSaimailPostAction, ZaicodeSaimailPostStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZaicodeSaimailConfig, useZaicodeSaimailDesk } from "@/zaicode/zaicodeSaimail.js";
import { ZAICODE_SAIMAIL_WHAT } from "@/zaicode/ZaicodeSaimailHeaderButton.js";

const CHECK_ICON = { ok: CheckCircle2, warn: AlertTriangle, fail: XCircle } as const;
const CHECK_TONE = { ok: "text-foreground-subtle", warn: "text-[var(--color-warning)]", fail: "text-destructive" } as const;

/** Whether a check's repair is the pairing button (it carries the whole repair for every pairing fix). */
const isPairFix = (check: ZaicodeSaimailCheck) => check.fix === "pair" || check.fix === "reset-desk";

/**
 * Settings -> ZAICODE -> SAIMAIL: the local mailbox folder of this machine's
 * operator seat. ZAICODE only reads headers from it; agents get it as
 * SAIMAIL_WORKSPACE on the next ZAICODE start (SAIPEN then counts unread
 * telegrams at turn entry). "Create mailbox" runs `saimail-local init` for the
 * operator seat, and only on that explicit click.
 *
 * "Delivery" is what makes a letter able to arrive at all. A sender must be
 * registered in BOTH mailboxes, or the letter never leaves (RECIPIENT_UNKNOWN)
 * or is refused on arrival (UNKNOWN_SENDER_KEY) into a folder nothing watched.
 * The agents' own desk is paired with the operator mailbox by one click, and a
 * test letter proves the whole chain.
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
  const [post, setPost] = useState<ZaicodeSaimailPostStatus | null>(null);
  useEffect(() => setDraft(mailbox ?? ""), [mailbox]);
  const refreshPost = useCallback(() => {
    void platform
      .getZaicodeSaimailPost?.()
      .then(setPost)
      .catch(() => setPost(null));
  }, [platform]);
  useEffect(() => refreshPost(), [refreshPost, mailbox]);
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
      refreshPost();
      if (!result.ok) throw new Error(result.message);
      return `${result.message} Restart ZAICODE once so agents get SAIMAIL_WORKSPACE.`;
    });

  const runPost = (action: ZaicodeSaimailPostAction) =>
    run(async () => {
      const result = await platform.runZaicodeSaimailPost!(action);
      setPost(result.status);
      if (!result.ok) throw new Error(result.message);
      return result.message;
    });
  const canPost = Boolean(platform.runZaicodeSaimailPost);

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
    ? "Off. Type or pick a folder: Save uses a mailbox that is already there, Create mailbox here (shown once a folder is named) makes a new one."
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
      {post && post.overall !== "off" ? (
        <div className="mt-3 border-t border-border pt-3" data-zaicode-saimail-delivery={post.overall}>
          <h3 className="text-ui-base text-foreground">Delivery</h3>
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            A letter can only arrive when the sender is registered on both sides. Agents write from their own desk;
            one click pairs it with your mailbox.
          </p>
          <ul className="mt-2 flex flex-col gap-1" role="list">
            {post.checks.map((check) => {
              const Icon = CHECK_ICON[check.level];
              return (
                <li key={check.id} className="flex items-start gap-2 text-ui-xs" data-zaicode-saimail-check={check.id} data-level={check.level}>
                  <Icon className={`mt-0.5 size-3.5 shrink-0 ${CHECK_TONE[check.level]}`} aria-hidden />
                  <span className="min-w-0">
                    <span className="text-foreground">{check.title}</span>
                    <span className="text-foreground-subtle"> — {check.detail}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!canPost || busy || !post.cli.found || !post.operatorSeat}
              onClick={() => runPost("pair")}
              title="Creates the agent desk if needed and registers each side with the other"
            >
              {busy ? "Working…" : post.deskReady ? "Repair delivery" : "Set up delivery"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canPost || busy || !post.deskReady}
              onClick={() => runPost("test-letter")}
              title="Sends one letter from the agent desk to your mailbox"
            >
              Send test letter
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={refreshPost}>
              Check again
            </Button>
            {post.checks.some(isPairFix) && !post.deskReady ? (
              <span className="text-ui-xs text-foreground-subtle">Nothing is sent until you press the button.</span>
            ) : null}
          </div>
          <p className="mt-1 text-ui-xs text-foreground-subtle" title={post.deskPath}>
            Agent desk: {post.deskPath}
          </p>
        </div>
      ) : null}
      {notice ? <p className="mt-1 text-ui-xs text-foreground-subtle">{notice}</p> : null}
      {error ? <p className="mt-1 text-ui-xs text-destructive">{error}</p> : null}
    </section>
  );
}
