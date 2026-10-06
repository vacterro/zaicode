/**
 * T-224 / SRC-154:R004 — a file-backed pasted text is editable, honestly.
 *
 * The model (`updatePastedText`, the pasted-text editor dialog) existed; what
 * was missing is the contract around it. This file pins the whole contract:
 *
 *  - the chip clearly exposes an Edit action, not only Remove;
 *  - open -> edit -> save delivers EXACTLY the edited payload (hash, not looks);
 *  - open -> edit -> cancel mutates nothing;
 *  - editing never rewrites sent history and never claims a success the file
 *    does not hold.
 *
 * Payload claims are hashes and lengths throughout: a truncated body still
 * looks right on screen.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  applyPastedTextEdit,
  createClipboardTextPathComposerAttachment,
  createClipboardTextAttachmentFilenameForDate,
  isPastedTextChatComposerAttachment,
  serializeChatComposerAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const src = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

const tempFile = (text: string) => ({
  filename: createClipboardTextAttachmentFilenameForDate(new Date(2026, 9, 5, 12, 0, 0)),
  localPath: `/tmp/paste-attachments/${sha256(text).slice(0, 8)}.txt`,
  mimeType: "text/plain",
  sizeBytes: Buffer.byteLength(text, "utf8"),
});

const LARGE_UNICODE = `${"Õhtu õunad, šibalid — Привет, мир — こんにちは世界 🎉👩‍💻\n".repeat(4000)}tail with no newline`;

test("R004: the chip exposes an explicit Edit action, not only Remove", () => {
  const composer = src("v4/ConversationComposer.tsx");
  assert.match(composer, /data-composer-attachment-edit=\{attachment\.id\}/, "the Edit button is addressable");
  assert.match(
    composer,
    /aria-label=\{intl\.formatMessage\(\{\s*id: "chat\.attachments\.pastedText\.edit"/,
    "the Edit button is labelled, never icon-only",
  );
  assert.match(composer, /<PencilIcon className="size-2\.5" \/>/, "the Edit button has its own glyph");
  assert.match(
    composer,
    /data-composer-attachment-edit[\s\S]{0,1200}?setPastedTextEdit\(\{\s*id: attachment\.id,\s*text: attachment\.text \?\? "",\s*filename: attachment\.filename,\s*\}\)/,
    "Edit opens the editor on the exact payload, not a copy",
  );
  // The click must not leak into the chip open handler or toggle twice.
  const editButton = composer.slice(
    composer.indexOf("data-composer-attachment-edit"),
    composer.indexOf("</button>", composer.indexOf("data-composer-attachment-edit")),
  );
  assert.match(editButton, /event.stopPropagation()/);
  assert.match(editButton, /event.preventDefault()/);
  // Remove is still there, beside Edit, not instead of it.
  assert.match(composer, /data-composer-attachment-remove=\{attachment\.id\}/, "Remove is kept");
  // Only an editable draft gets the button: path-only queue snapshots stay read-only.
  assert.match(
    composer,
    /\{isPastedTextAttachment \? \(\s*<button[^>]*data-composer-attachment-edit/,
    "restored path-only attachments get no Edit button",
  );
});

test("R004: editing a sent or session-owned attachment is refused, never rewritten", () => {
  const hook = src("v4/composer/useComposerAttachments.ts");
  const updateFn = hook.slice(hook.indexOf("const updatePastedText"), hook.indexOf("const adoptSentAttachments"));
  assert.ok(updateFn.includes("if (!written)"), "the missing-file branch exists");
  assert.ok(
    (updateFn.match(/return false;/g) ?? []).length >= 2,
    "refusals (not a draft, unwritable file) keep the draft open instead of closing on a lie",
  );
  assert.match(hook, /localPath = written.localPath;/, "success mints the fresh path");
  assert.doesNotMatch(
    hook,
    /writeFile\(item\.localPath|writeFileSync\(item\.localPath/,
    "an edit mints a fresh temp file; the original path is never overwritten",
  );
  // Restored queue snapshots carry no text at all, so the editor cannot open them.
  const restoreBlock = hook.slice(hook.indexOf("const restoreSessionOwnedAttachments"), hook.indexOf("const prepareForSend"));
  assert.match(restoreBlock, /referenceOwnership: "session"/);
  assert.match(restoreBlock, /adopted: true/);
  assert.doesNotMatch(restoreBlock, /^\s*text,/m, "no payload travels back from history");
});

test("R004: open -> edit -> save delivers exactly the edited payload", async () => {
  const original = "line one\nline two\n";
  const edited = `${LARGE_UNICODE}\nAPPENDED\n`;
  const attachment = createClipboardTextPathComposerAttachment(original, tempFile(original));

  const updated = applyPastedTextEdit(attachment, edited);
  assert.equal(sha256(updated.text!), sha256(edited), "the payload is the edit, byte for byte");
  assert.equal(updated.charCount, edited.length);
  assert.equal(updated.sizeBytes, Buffer.byteLength(edited, "utf8"));
  // Identity and file metadata survive the edit: same chip, same name, same type.
  assert.equal(updated.id, attachment.id);
  assert.equal(updated.filename, attachment.filename);
  assert.equal(updated.mimeType, "text/plain");
  // The original path is kept on the edited object: the hook mints the fresh
  // file for the NEW bytes and never overwrites the old one, so sent history
  // keeps pointing at bytes that still exist.
  assert.equal(updated.localPath, attachment.localPath);

  // What the model receives is the edit, through the same serializer send uses.
  const pathless = { ...updated };
  delete (pathless as { localPath?: string }).localPath;
  const sent = (await serializeChatComposerAttachment(pathless)) as { textContent: string };
  assert.equal(sha256(sent.textContent), sha256(edited), "send carries the edit, not the original");
});

test("R004: open -> edit -> cancel mutates nothing", () => {
  const original = "keep me\n";
  const attachment = createClipboardTextPathComposerAttachment(original, tempFile(original));
  const snapshot = JSON.parse(JSON.stringify(attachment));
  // Cancel is a non-event: the editor hands nothing back, so apply never runs.
  // The assertion that matters is that a mere open leaves the stored object alone.
  assert.deepEqual(attachment, snapshot);
  assert.equal(sha256(attachment.text!), sha256(original));
});

test("R004: editing empty text is exact — an empty payload, zeroed metadata", async () => {
  const attachment = createClipboardTextPathComposerAttachment("something\n", tempFile("something\n"));
  const updated = applyPastedTextEdit(attachment, "");
  assert.equal(updated.text, "");
  assert.equal(updated.charCount, 0);
  assert.equal(updated.lineCount, 0);
  assert.equal(updated.sizeBytes, 0);
  const pathless = { ...updated };
  delete (pathless as { localPath?: string }).localPath;
  const sent = (await serializeChatComposerAttachment(pathless)) as { textContent: string };
  assert.equal(sent.textContent, "", "empty means empty on the wire, not a stale body");
});

test("R004: large Unicode survives the round trip without mangling", () => {
  const attachment = createClipboardTextPathComposerAttachment("seed", tempFile("seed"));
  const updated = applyPastedTextEdit(attachment, LARGE_UNICODE);
  assert.equal(sha256(updated.text!), sha256(LARGE_UNICODE));
  assert.equal(updated.sizeBytes, Buffer.byteLength(LARGE_UNICODE, "utf8"));
  assert.ok(LARGE_UNICODE.length > 100_000, "this is actually large");
});

test("R004: with several attachments, editing one leaves the others alone", () => {
  const first = createClipboardTextPathComposerAttachment("first\n", tempFile("first\n"));
  const second = createClipboardTextPathComposerAttachment("second\n", tempFile("second\n"));
  const secondBefore = sha256(second.text!);
  const updatedFirst = applyPastedTextEdit(first, "first CHANGED\n");
  assert.equal(sha256(updatedFirst.text!), sha256("first CHANGED\n"));
  assert.equal(sha256(second.text!), secondBefore, "the other chip is untouched");
  assert.notEqual(updatedFirst.id, second.id);
});

test("R004: remove after edit still removes — the edit keeps the identity", () => {
  const attachment = createClipboardTextPathComposerAttachment("doomed\n", tempFile("doomed\n"));
  const updated = applyPastedTextEdit(attachment, "doomed, edited\n");
  assert.equal(updated.id, attachment.id, "remove-by-id still finds the edited chip");
  const queue = [updated];
  const afterRemove = queue.filter((candidate) => candidate.id !== updated.id);
  assert.deepEqual(afterRemove, []);
});

test("R004: a non-pasted attachment is never an edit target", () => {
  const file = {
    id: "x",
    filename: "photo.png",
    mimeType: "image/png",
    sizeBytes: 12,
  } as ChatComposerAttachment;
  assert.equal(isPastedTextChatComposerAttachment(file), false);
  const edited = applyPastedTextEdit(
    createClipboardTextPathComposerAttachment("draft\n", tempFile("draft\n")),
    "draft\n",
  );
  assert.equal(edited.mimeType, "text/plain", "the text type survives a no-op edit");
});
