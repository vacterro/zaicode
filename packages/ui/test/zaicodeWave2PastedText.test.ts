import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  applyPastedTextEdit,
  createClipboardTextPathComposerAttachment,
  createClipboardTextAttachmentFilenameForDate,
  isPastedTextChatComposerAttachment,
  pastedTextByteLength,
  pastedTextMetadata,
  serializeChatComposerAttachment,
  shouldCreateClipboardTextAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import { countClipboardTextLines } from "@/lib/chatAttachmentMetadata.js";

/**
 * Wave 2, part D: a large pasted text is a chip, never a shortened message.
 * Every claim here is a HASH or a LENGTH, because a truncated body still
 * looks right on screen.
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const tempFile = (text: string) => ({
  filename: createClipboardTextAttachmentFilenameForDate(new Date(2026, 8, 28, 14, 30, 12)),
  localPath: `/tmp/paste-attachments/${sha256(text).slice(0, 8)}.txt`,
  mimeType: "text/plain",
  sizeBytes: Buffer.byteLength(text, "utf8"),
});

/** Every paste the operator can make, including the ones that break naive code. */
const CASES: { name: string; text: string }[] = [
  { name: "just below the inline threshold", text: "a".repeat(15 * 1024 - 1) },
  { name: "just above the inline threshold", text: "a".repeat(15 * 1024) },
  { name: "very large", text: `${"line of pasted text\n".repeat(120_000)}` },
  { name: "CRLF line endings", text: "first\r\nsecond\r\nthird\r\n" },
  { name: "LF line endings", text: "first\nsecond\nthird\n" },
  { name: "mixed CR, LF and CRLF", text: "a\r\nb\nc\rd\r\n" },
  { name: "Estonian, Cyrillic and Japanese", text: "Õhtu õunad, šibalid\nПривет, мир\nこんにちは、世界\nTere õues" },
  { name: "emoji and surrogate pairs", text: "👩‍💻 shipped ✅ — family 👨‍👩‍👧‍👦\nDone 🎉" },
  { name: "a code fence", text: "```ts\nexport const x: number = 1;\n```\ntail" },
  { name: "JSON", text: JSON.stringify({ a: [1, 2, { b: "c" }], d: null }, null, 2) },
  { name: "a trailing newline", text: "ends with a newline\n" },
  { name: "no trailing newline", text: "no trailing newline" },
  { name: "an empty paste", text: "" },
  { name: "markdown that looks like a pasted-text label", text: "pasted text" },
  { name: "a JSON string holding the label", text: JSON.stringify({ body: "pasted text" }) },
];

test("Wave 2 D: the inline threshold is exactly where it says it is", () => {
  assert.equal(shouldCreateClipboardTextAttachment("a".repeat(15 * 1024 - 1)), false);
  assert.equal(shouldCreateClipboardTextAttachment("a".repeat(15 * 1024)), true);
  assert.equal(shouldCreateClipboardTextAttachment(""), false);
});

test("Wave 2 D: a pasted-text chip keeps the whole payload, and says how big it is", () => {
  for (const { name, text } of CASES) {
    const attachment = createClipboardTextPathComposerAttachment(text, tempFile(text));
    assert.equal(attachment.text, text, `${name}: the payload is kept, character for character`);
    assert.equal(sha256(attachment.text!), sha256(text), `${name}: the payload hashes to the same bytes`);
    assert.equal(attachment.sourceKind, "clipboard-text");
    assert.equal(attachment.charCount, text.length, `${name}: the character count matches`);
    assert.equal(attachment.lineCount, countClipboardTextLines(text), `${name}: the line count matches`);
    assert.equal(attachment.sizeBytes, Buffer.byteLength(text, "utf8"), `${name}: the size is the real byte size`);
    assert.equal(isPastedTextChatComposerAttachment(attachment), true);
  }
});

test("Wave 2 D: what the model receives is the exact text, never a label and never a truncation", async () => {
  for (const { name, text } of CASES) {
    // The path-less shape: what the web / remote edge has to send.
    const pathless = createClipboardTextPathComposerAttachment(text, { ...tempFile(text), localPath: undefined as unknown as string });
    delete (pathless as { localPath?: string }).localPath;
    const sent = await serializeChatComposerAttachment(pathless);
    assert.equal(sent.kind, "file", `${name}: sent as a file reference`);
    assert.notEqual(sent.kind, "image");
    const body = (sent as { textContent?: string }).textContent;
    assert.equal(typeof body, "string", `${name}: the body travels`);
    assert.equal(sha256(body!), sha256(text), `${name}: the body hashes to the pasted bytes`);
    assert.equal((sent as { sourceKind?: string }).sourceKind, "clipboard-text", `${name}: it is marked as pasted text`);
    if (text !== "pasted text") {
      assert.notEqual(body, "pasted text", `${name}: the placeholder is never the payload`);
      assert.doesNotMatch(body!, /已截断|truncated/i, `${name}: nothing is cut off`);
    }
    assert.equal((sent as { sizeBytes?: number }).sizeBytes, Buffer.byteLength(text, "utf8"), `${name}: the declared size is the real one`);
  }
});

test("Wave 2 D: a 200 KB paste is sent whole, past the inline size cap", async () => {
  const text = `${"x".repeat(99)}\n`.repeat(2000);
  assert.ok(text.length > 64 * 1024, "this is past the inline text cap the other attachments obey");
  const attachment = createClipboardTextPathComposerAttachment(text, tempFile(text));
  delete (attachment as { localPath?: string }).localPath;
  const sent = (await serializeChatComposerAttachment(attachment)) as { textContent: string };
  assert.equal(sent.textContent.length, text.length);
  assert.equal(sha256(sent.textContent), sha256(text));
});

test("Wave 2 D: edit then send delivers the edited text, and the untouched chip is not mutated", async () => {
  const original = "line one\nline two\n";
  const edited = "line one\nline two CHANGED\n追加した行\n";
  const attachment = createClipboardTextPathComposerAttachment(original, tempFile(original));
  const before = sha256(attachment.text!);

  const updated = applyPastedTextEdit(attachment, edited);
  assert.equal(sha256(updated.text!), sha256(edited), "the edit is what the model will get");
  assert.equal(updated.charCount, edited.length);
  assert.equal(updated.lineCount, 4, "the trailing newline opens the line the editor shows");
  assert.equal(updated.sizeBytes, Buffer.byteLength(edited, "utf8"));
  // Identity and the file the ref points at are deliberately kept: the write
  // that puts the new bytes in the file is the host's, not this function's.
  assert.equal(updated.id, attachment.id);
  assert.equal(updated.localPath, attachment.localPath);
  assert.equal(updated.filename, attachment.filename);
  // Cancelling is a non-event: the original still holds the original.
  assert.equal(sha256(attachment.text!), before);

  delete (updated as { localPath?: string }).localPath;
  const sent = (await serializeChatComposerAttachment(updated)) as { textContent: string };
  assert.equal(sha256(sent.textContent), sha256(edited));
});

test("Wave 2 D: reopening before send returns exactly the same content", () => {
  for (const { name, text } of CASES) {
    const attachment = createClipboardTextPathComposerAttachment(text, tempFile(text));
    // What the composer keeps is what the editor opens with, and what the
    // editor hands back unchanged is what stays.
    const opened = attachment.text!;
    const reclosed = applyPastedTextEdit({ ...attachment, text: opened }, opened);
    assert.equal(sha256(reclosed.text!), sha256(text), `${name}: open, close and reopen is a fixed point`);
    assert.equal(reclosed.charCount, attachment.charCount);
    assert.equal(reclosed.sizeBytes, attachment.sizeBytes);
  }
});

test("Wave 2 D: two pastes of the same text are two attachments, neither merged nor lost", () => {
  const text = "same text pasted twice\n".repeat(1000);
  const first = createClipboardTextPathComposerAttachment(text, tempFile(text));
  const second = createClipboardTextPathComposerAttachment(text, tempFile(text));
  assert.notEqual(first.id, second.id, "each paste is its own attachment");
  assert.equal(sha256(first.text!), sha256(second.text!));
  assert.equal(pastedTextMetadata(first.text!).lines, pastedTextMetadata(second.text!).lines);
});

test("Wave 2 D: the line count is right for CRLF, LF and the empty paste", () => {
  assert.equal(countClipboardTextLines(""), 0);
  assert.equal(countClipboardTextLines("a"), 1);
  assert.equal(countClipboardTextLines("a\nb"), 2);
  assert.equal(countClipboardTextLines("a\r\nb"), 2, "a CRLF is one line break, not two");
  assert.equal(countClipboardTextLines("a\r\nb\n"), 3);
  assert.equal(pastedTextMetadata("a\r\nb").chars, 4);
  assert.equal(pastedTextByteLength("Õ"), 2, "the size is bytes, not characters");
  assert.equal(pastedTextByteLength("👩‍💻"), 11, "an emoji sequence is what it weighs on the wire");
  assert.equal(pastedTextByteLength("👨‍👩‍👧‍👦"), 25);
});

test("Wave 2 D: the pasted-text filename is a real .txt, never the label", () => {
  const filename = createClipboardTextAttachmentFilenameForDate(new Date(2026, 8, 28, 14, 30, 12));
  assert.match(filename, /^pasted-text-\d{8}-\d{6}\.txt$/);
  assert.notEqual(filename, "pasted text");
});

test("Wave 2 D: a non-pasted attachment is untouched by the pasted-text helpers", () => {
  const file = { id: "x", filename: "a.txt", mimeType: "text/plain", sizeBytes: 3 } as ChatComposerAttachment;
  assert.equal(isPastedTextChatComposerAttachment(file), false);
});
