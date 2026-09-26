import type {
  ZaicodeSaipenBoardTicket,
  ZaicodeSaipenLogLine,
  ZaicodeSaipenSection,
} from "./zaicodeSaipenModel.js";

/**
 * Full-detail parsers for the SAIPEN side pane: every STATE.md field, every
 * BOARD.md ticket with its `| key: value` fields, and LOG.md event lines split
 * into their Event Graph parts. Read-only projections of files agents own.
 */

/** Every `key: value` pair of the STATE.md front matter, in order (quotes stripped). */
export function parseSaipenStateFields(content: string): [string, string][] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content);
  const body = match?.[1] ?? content;
  const fields: [string, string][] = [];
  for (const line of body.split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    fields.push([pair[1]!, pair[2]!.trim().replace(/^(["'])(.*)\1$/, "$2")]);
  }
  return fields;
}

const BOARD_SECTIONS: readonly ZaicodeSaipenSection[] = ["DOING", "TODO", "BLOCKED", "DONE"];

/** All BOARD.md tickets with section, priority and `| key: value` fields. */
export function parseSaipenBoardTickets(content: string): ZaicodeSaipenBoardTicket[] {
  const tickets: ZaicodeSaipenBoardTicket[] = [];
  let section: ZaicodeSaipenSection | null = null;
  for (const line of content.split(/\r?\n/)) {
    const heading = /^## (\w+)/.exec(line);
    if (heading) {
      const name = heading[1]!.toUpperCase();
      section = (BOARD_SECTIONS as readonly string[]).includes(name)
        ? (name as ZaicodeSaipenSection)
        : null;
      continue;
    }
    if (!section) continue;
    const match = /^- \[[ /x]\] (T-\d+)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const [head = "", ...rest] = match[2]!.split(" | ");
    const priority = /^\[(P\d)\]\s*/.exec(head);
    const fields: Record<string, string> = {};
    for (const part of rest) {
      const pair = /^([\w-]+):\s*(.*)$/.exec(part.trim());
      if (pair) fields[pair[1]!] = pair[2]!.trim();
    }
    tickets.push({
      id: match[1]!,
      section,
      priority: priority?.[1] ?? null,
      title: head
        .slice(priority?.[0].length ?? 0)
        .replace(/^#\s*/, "")
        .trim(),
      fields,
    });
  }
  return tickets;
}

/** LOG.md event lines (`- dd.mm.yy hh:mm [E-1] [parent: ..] [T-1] [agent: a] [op: ..] TAG: text`). */
export function parseSaipenLogLines(logTail: string, limit = 200): ZaicodeSaipenLogLine[] {
  const lines = logTail.split(/\r?\n/).filter((line) => line.startsWith("- "));
  return lines.slice(-limit).map((line) => {
    const stamp = /^- (\d\d\.\d\d\.\d\d) (\d\d:\d\d)\s*/.exec(line);
    let rest = stamp ? line.slice(stamp[0].length) : line.slice(2);
    let event: string | null = null;
    let ticket: string | null = null;
    let agent: string | null = null;
    for (;;) {
      const bracket = /^\[([^\]]*)\]\s*/.exec(rest);
      if (!bracket) break;
      const value = bracket[1]!.trim();
      if (/^E-\d+$/.test(value)) event = value;
      else if (/^T-\d+$/.test(value)) ticket = value;
      else if (value.startsWith("agent:")) agent = value.slice(6).trim();
      rest = rest.slice(bracket[0].length);
    }
    // Agents sometimes repeat the tag inside the checkpoint text ("RUN: RUN: ..."): show it once.
    rest = rest.replace(/^([A-Z]{2,5}):\s+\1:\s*/, "$1: ");
    const tag = /^([A-Z]{2,5}):\s*/.exec(rest);
    return {
      key: event ?? line,
      date: stamp?.[1] ?? null,
      time: stamp?.[2] ?? null,
      event,
      ticket,
      agent,
      tag: tag?.[1] ?? null,
      text: (tag ? rest.slice(tag[0].length) : rest).trim(),
    };
  });
}

export type ZaicodeLogOrder = "oldest-first" | "newest-first";

export type ZaicodeTicketOrder = "board" | "number";

/** `T-64` -> 64; tickets without a numeric id keep the file's relative order behind the numbered ones. */
function ticketNumber(id: string): number {
  const match = /^T-(\d+)$/.exec(id);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * BOARD tickets ordered for the side pane (SRC-049): `number` sorts T-2 before
 * T-10 inside every section (the operator asked to orient by the ticket
 * number), `board` keeps the file's order. Stable in both modes.
 */
export function sortZaicodeSaipenTickets(
  tickets: readonly ZaicodeSaipenBoardTicket[],
  order: ZaicodeTicketOrder,
): ZaicodeSaipenBoardTicket[] {
  if (order === "board") return [...tickets];
  return tickets
    .map((ticket, index) => ({ ticket, index }))
    .sort(
      (left, right) =>
        ticketNumber(left.ticket.id) - ticketNumber(right.ticket.id) || left.index - right.index,
    )
    .map((entry) => entry.ticket);
}

/**
 * Tickets whose id, title, priority or field values contain the query
 * (case-insensitive). An empty query returns everything unchanged.
 */
export function filterZaicodeSaipenTickets(
  tickets: readonly ZaicodeSaipenBoardTicket[],
  query: string,
): ZaicodeSaipenBoardTicket[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tickets];
  return tickets.filter((ticket) => {
    if (ticket.id.toLowerCase().includes(needle)) return true;
    if (ticket.title.toLowerCase().includes(needle)) return true;
    if (ticket.priority?.toLowerCase().includes(needle)) return true;
    for (const [key, value] of Object.entries(ticket.fields)) {
      if (key.toLowerCase().includes(needle)) return true;
      if (value.toLowerCase().includes(needle)) return true;
    }
    return false;
  });
}

/** `dd.mm.yy hh:mm` -> a string that sorts by time; lines without a stamp inherit the previous line's. */
function logSortKey(line: ZaicodeSaipenLogLine, previous: string): string {
  const date = /^(\d\d)\.(\d\d)\.(\d\d)$/.exec(line.date ?? "");
  if (!date) return previous;
  return `${date[3]}${date[2]}${date[1]} ${line.time ?? "00:00"}`;
}

/**
 * LOG lines ordered by their time stamp, either way (SRC-035). Equal stamps
 * keep the file's order (the Event Graph order), reversed for newest-first.
 */
export function sortZaicodeLogLines(lines: readonly ZaicodeSaipenLogLine[], order: ZaicodeLogOrder): ZaicodeSaipenLogLine[] {
  let previous = "";
  const keyed = lines.map((line, index) => {
    previous = logSortKey(line, previous);
    return { line, index, key: previous };
  });
  keyed.sort((left, right) => (left.key === right.key ? left.index - right.index : left.key < right.key ? -1 : 1));
  if (order === "newest-first") keyed.reverse();
  return keyed.map((entry) => entry.line);
}
