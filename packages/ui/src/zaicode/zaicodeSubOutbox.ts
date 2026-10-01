/**
 * SRC-112: read-only projection of the SubSaipen OUTBOX files.
 *
 * A SubSaipen leaves finished work in `.saipen/extensions/subs/<role>/kitchen/OUTBOX.md`
 * (PROTOCOL.md § 2). ZAICODE never writes those files: it shows what is ready,
 * counts what a person must decide, and offers the Collect/continue commands.
 * The protocol keeps ownership of admission -- a button here only queues the
 * canonical `saipen collect <producer>` command.
 */

export type ZaicodeOutboxStatus = "ready" | "draft" | "blocked" | "reviewed" | "stale";

export const ZAICODE_OUTBOX_STATUSES: readonly ZaicodeOutboxStatus[] = [
  "ready",
  "draft",
  "blocked",
  "reviewed",
  "stale",
];

export interface ZaicodeOutboxPackage {
  /** `WIKI-001` from the `## WIKI-001: title` heading. */
  id: string;
  title: string;
  status: ZaicodeOutboxStatus | null;
  summary: string | null;
  producer: string | null;
  severity: string | null;
  critical: boolean;
}

/** One bold field of an OUTBOX package: `- **status:** ready`. */
function fieldValue(block: string, field: string): string | null {
  const match = new RegExp(`^\\s*-\\s+\\*\\*${field}:\\*\\*\\s*(.*)$`, "m").exec(block);
  const value = (match?.[1] ?? "").trim();
  return value || null;
}

export function parseZaicodeOutbox(content: string): ZaicodeOutboxPackage[] {
  const packages: ZaicodeOutboxPackage[] = [];
  // A package starts at `## <ID>: title` and runs until the next one.
  const heading = /^##\s+([A-Za-z][\w-]*-\d+)\s*:\s*(.+)$/gm;
  const starts: { id: string; title: string; at: number }[] = [];
  for (const match of content.matchAll(heading)) {
    starts.push({ id: match[1]!, title: match[2]!.trim(), at: match.index });
  }
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1]?.at ?? content.length;
    const block = content.slice(start.at, end);
    const rawStatus = fieldValue(block, "status");
    const status = ZAICODE_OUTBOX_STATUSES.find((candidate) => candidate === rawStatus) ?? null;
    packages.push({
      id: start.id,
      title: start.title,
      status,
      summary: fieldValue(block, "summary"),
      producer: fieldValue(block, "producer"),
      severity: fieldValue(block, "severity"),
      critical: fieldValue(block, "critical") === "true",
    });
  }
  return packages;
}

export interface ZaicodeOutboxCounts {
  ready: number;
  draft: number;
  blocked: number;
  reviewed: number;
  stale: number;
  /** `ready` plus `blocked`: what the outbox wants a person to look at. */
  actionable: number;
}

/** Packages a person must decide about: `ready` first, then what is blocked on something. */
export function zaicodeOutboxCounts(packages: readonly ZaicodeOutboxPackage[]): ZaicodeOutboxCounts {
  const counts: ZaicodeOutboxCounts = {
    ready: 0,
    draft: 0,
    blocked: 0,
    reviewed: 0,
    stale: 0,
    actionable: 0,
  };
  for (const entry of packages) {
    if (entry.status && entry.status in counts) counts[entry.status] += 1;
  }
  counts.actionable = counts.ready + counts.blocked;
  return counts;
}

/** Every producer that has at least one ready package, alphabetical. */
export function zaicodeReadyProducers(packages: readonly ZaicodeOutboxPackage[]): string[] {
  return [...new Set(packages.filter((entry) => entry.status === "ready").map((entry) => entry.producer ?? ""))]
    .filter(Boolean)
    .sort();
}

/**
 * The collect command for one role. PROTOCOL.md keeps admission with
 * `saipen collect <producer>`; ZAICODE only types it into the session.
 */
export function zaicodeCollectCommand(producer: string): string {
  return `saipen collect ${producer}`;
}

/** Roles a directory listing offers as SubSaipen instances (saihunt/, saiwiki/, ...). */
export function isZaicodeSubOutboxRole(entry: { name: string; type: string }): boolean {
  return entry.type === "directory" && !entry.name.startsWith(".") && entry.name !== "_shared";
}