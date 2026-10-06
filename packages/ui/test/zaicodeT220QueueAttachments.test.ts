// T-220 / SRC-151:R006 —— 队列行必须显示它携带的附件。
//
// 原文："Здесь когда авто goal cc all включен и отправляю это ... в queued строке
// пишется только goal cc all где нет даже ... индикатора что там файл вложен"。
// 载荷从来没有丢：intent 带 attachments，投影保留，edit-restore 已经把它交回 composer；
// 只有这一行渲染时丢掉了。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AttachmentRef } from "@zcode/shared";
import { QueueAttachmentBadge } from "../src/v4/ConversationQueuePanel.js";

const attachment = (fileName: string): AttachmentRef => ({
  ref: `att/${fileName}`,
  fileName,
  mime: "image/png",
  bytes: 2048,
});

const render = (attachments: readonly AttachmentRef[]) =>
  renderToStaticMarkup(
    createElement(QueueAttachmentBadge, { attachments, label: "Attachments" }),
  );

test("T-220: a queued send with a file says so, and names the file", () => {
  const html = render([attachment("clipboard.png")]);
  assert.match(html, /data-v4-queue-item-attachments="true"/);
  assert.match(html, /data-attachment-count="1"/);
  // 文件名必须可读（title），这是"到底附了哪个文件"的唯一线索。
  assert.match(html, /title="clipboard\.png"/);
  assert.match(html, /aria-label="Attachments"/);
  assert.match(html, />\s*1\s*</, "and the count is on screen, not only in the title");
});

test("T-220: several attachments report the number, not just a paperclip", () => {
  const html = render([attachment("a.png"), attachment("b.pdf"), attachment("c.txt")]);
  assert.match(html, /data-attachment-count="3"/);
  assert.match(html, /title="a\.png, b\.pdf, c\.txt"/);
  assert.match(html, />\s*3\s*</);
});

test("T-220: a text-only queued send draws no attachment indicator at all", () => {
  // Predictability #1: nothing appears unless there is something to report.
  assert.equal(render([]), "");
});

test("T-220: the queue row renders the badge from the item's own attachments", () => {
  const panel = readFileSync(
    join(import.meta.dirname, "../src/v4/ConversationQueuePanel.tsx"),
    "utf8",
  );
  // The badge must read item.attachments (the intent's refs), never a second source.
  assert.match(panel, /<QueueAttachmentBadge\s+attachments=\{item\.attachments\}/);
  assert.match(panel, /id: "chat\.composer\.attachment"/, "and label it with an existing key");
});