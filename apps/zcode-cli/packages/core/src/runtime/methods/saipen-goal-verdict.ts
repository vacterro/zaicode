import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GoalCompletionVerificationOutput } from "../deps.js";

/**
 * ZAICODE: deterministic /goal verdict for SAIPEN workspaces.
 *
 * In a project with `.saipen/`, /goal means "finish every ticket that can be
 * finished without a human". The board is the ground truth, so the verifier
 * reads BOARD.md + STATE.md instead of asking a model to re-read the whole
 * transcript (which on a long SAIPEN session took minutes and, on any
 * provider hiccup, reported "Goal incomplete" without progress).
 *
 * Whether work is left is SAIPEN's own answer when it can give one (`saipen
 * status --json`: claimed / top workable ticket, closure) -- ZAICODE's System
 * Read Model (T-41) does not re-interpret the protocol. BOARD.md + STATE.md
 * are the fallback when the projection is unavailable, and still name the
 * BLOCKED tickets the autonomy push below looks at.
 *
 * Returns null when the workspace has no SAIPEN memory, or when the board is
 * clear but the objective is not a SAIPEN continuation (the model verifier
 * then judges that objective).
 */

interface SaipenTicket {
  id: string;
  title: string;
  blocker?: string;
}

interface SaipenBoard {
  todo: SaipenTicket[];
  doing: SaipenTicket[];
  blocked: SaipenTicket[];
  done: number;
}

const IDLE_PHASES = new Set(["", "done", "idle", "none"]);

/** Objectives that mean "continue SAIPEN until the board is clear" (START sends `/goal cc all`). */
const SAIPEN_CONTINUATION_OBJECTIVE =
  /^(?:cc|сс|ccc|ссс|cc all|сс all|all|saipen(?: continue)?(?: all)?|continue(?: all)?|finish(?: all)?(?: tickets)?)[\s.!]*$/iu;

export function isSaipenContinuationObjective(objective: string): boolean {
  return SAIPEN_CONTINUATION_OBJECTIVE.test(objective.trim());
}

function frontMatterValue(content: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\r\\n]*))`, "m").exec(content);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

export function parseSaipenBoardForGoal(content: string): SaipenBoard {
  const board: SaipenBoard = { todo: [], doing: [], blocked: [], done: 0 };
  let section = "";
  for (const line of content.split(/\r?\n/)) {
    const heading = /^## (\w+)/.exec(line);
    if (heading) {
      section = heading[1]!.toUpperCase();
      continue;
    }
    const ticket = /^- \[[ /x]\] (T-\d+)\s+(?:\[P\d\]\s+)?([^|]*)/.exec(line.trim());
    if (!ticket) continue;
    const blockerMatch = /\|\s*(?:blocker|blocked):\s*([^|]+)/i.exec(line);
    const blocker = blockerMatch ? blockerMatch[1]!.trim() : undefined;
    const entry: SaipenTicket = { id: ticket[1]!, title: ticket[2]!.trim(), blocker };
    const realBlocker = Boolean(blocker && !/^(?:none|-|n\/a|null)$/i.test(blocker));
    // A TODO ticket that carries a blocker is blocked, not actionable.
    if (section === "TODO" && realBlocker) board.blocked.push(entry);
    else if (section === "TODO") board.todo.push(entry);
    else if (section === "DOING") board.doing.push(entry);
    else if (section === "BLOCKED") board.blocked.push(entry);
    else if (section === "DONE") board.done += 1;
  }
  return board;
}

/**
 * The only things a human is really needed for. Everything else a blocked
 * ticket or a WAIT can say — "missing README", "wiki is only a stub", "needs a
 * decision: 4 pages or an empty wiki", "no upstream answer" — is an
 * engineering choice the agent makes itself: pick the conventional default,
 * record the decision, do the work. (Operator request: "the agent must really
 * figure it out by itself".) Patterns cover English, Estonian and Russian.
 */
const HUMAN_ONLY_PATTERNS: readonly RegExp[] = [
  // secrets and accounts
  /credential|password|passphrase|\bsecret\b|api[\s_-]?key|(?:api|access|auth|bearer|github|npm|pypi)[\s_-]?token|\b2fa\b|\botp\b|captcha|\blog ?in\b|\bsign[\s-]?in\b|oauth|parool|salasõna|sisselogimi|пароль|логин|учётн|учетн|авториз|вход в/i,
  // money
  /payment|billing|purchase|invoice|credit card|subscription upgrade|maks(e|a)|arve|оплат|платеж|покупк/i,
  // hands and eyes on real things
  /physical|hardware|device in hand|plug|cable|printer|manual[\s-]?verif|visual(ly)? verif|füüsili|seadme|физическ|вручную провер|оборудован/i,
  // destructive or irreversible, needs explicit authority
  /destructive|irreversib|drop (table|database)|force[\s-]?push|delete (the )?(repo|branch|history)|wait:\s*destructive|pöördumatu|kustuta(da)? (repo|ajalugu)|необратим|удалить (репозитор|историю)/i,
  // legal and licensing
  /legal|licen[cs]e (approval|decision)|copyright|gdpr|juriidil|litsents|юридическ|лицензи/i,
  // explicitly an operator-only action
  /only (the )?(operator|human|user) can|operator must|human must|needs? (an? )?(operator|human)|operaator peab|kasutaja peab ise|только (оператор|пользователь)|оператор должен/i,
];

export function isHumanOnlyBlocker(text: string): boolean {
  return HUMAN_ONLY_PATTERNS.some((pattern) => pattern.test(text));
}

function isHumanBlockedTicket(ticket: SaipenTicket, stateNextAction: string): boolean {
  const text = `${ticket.blocker ?? ""} ${ticket.title}`;
  if (isHumanOnlyBlocker(text)) return true;
  // A WAIT that names this ticket with a human-only reason keeps it blocked too.
  return new RegExp(`\\b${ticket.id}\\b`).test(stateNextAction) && isHumanOnlyBlocker(stateNextAction);
}

/**
 * Loop guard: the same blocker is pushed back to the agent at most this many
 * times per process. A ticket the agent still cannot move after that is
 * accepted as blocked, so a goal never spins forever on one wall.
 */
const MAX_AUTONOMOUS_PUSHES = 2;
const autonomousPushes = new Map<string, number>();

function takeAutonomousPush(key: string): boolean {
  const count = autonomousPushes.get(key) ?? 0;
  if (count >= MAX_AUTONOMOUS_PUSHES) return false;
  autonomousPushes.set(key, count + 1);
  return true;
}

/** Test seam: forget the loop guard. */
export function resetSaipenGoalVerdictMemory(): void {
  autonomousPushes.clear();
}

/** The part of `saipen status --json` the verdict reads. */
export interface SaipenGoalProjection {
  phase: string;
  claimedTicket: string | null;
  topWorkableTicket: string | null;
  closureComplete: boolean | null;
  blocker: string | null;
}

function projectionText(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "none" ? value.trim() : null;
}

export function parseSaipenGoalProjection(output: string): SaipenGoalProjection | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || raw.ok === false || typeof raw.phase !== "string") return null;
  const automation = (raw.automation ?? {}) as Record<string, unknown>;
  return {
    phase: raw.phase,
    claimedTicket: projectionText(raw.claimed_ticket),
    topWorkableTicket: projectionText(raw.top_workable_ticket),
    closureComplete: typeof automation.closure_complete === "boolean" ? automation.closure_complete : null,
    blocker: projectionText(raw.blocker),
  };
}

const PROJECTION_TIMEOUT_MS = 20_000;
const PROJECTION_MAX_BYTES = 4 * 1024 * 1024;
const UNSAFE_CMD_PATH = /["%\r\n]/;

/** `saipen status --json` through the SAIPEN launcher (SAIPEN_HOME, else the home STATE names); null when unavailable. */
export function readSaipenGoalProjection(workspaceRoot: string, stateContent: string): Promise<SaipenGoalProjection | null> {
  const home = process.env.SAIPEN_HOME?.trim() || frontMatterValue(stateContent, "saipen_home");
  if (!home) return Promise.resolve(null);
  const windows = process.platform === "win32";
  const launcher = join(home, "bin", windows ? "saipen.cmd" : "saipen");
  if (!existsSync(launcher)) return Promise.resolve(null);
  // cmd.exe runs the .cmd launcher with every path quoted whole; a path that could escape the quotes is refused.
  if (windows && (UNSAFE_CMD_PATH.test(launcher) || UNSAFE_CMD_PATH.test(workspaceRoot))) return Promise.resolve(null);
  const [file, args] = windows
    ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${launcher}" status --json --project-root "${workspaceRoot}""`]]
    : [launcher, ["status", "--json", "--project-root", workspaceRoot]];
  // Asynchronous on purpose: the agent process keeps serving its stdio protocol while SAIPEN answers (2-4 s).
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: PROJECTION_TIMEOUT_MS,
        maxBuffer: PROJECTION_MAX_BYTES,
        windowsHide: true,
        windowsVerbatimArguments: windows,
      },
      (error, stdout) => resolve(error && !stdout ? null : parseSaipenGoalProjection(stdout)),
    );
  });
}

const DECIDE_YOURSELF =
  "Decide yourself: take the conventional engineering default, record it as a DEC line in LOG, implement it, close the ticket. Do not ask the operator; only credentials, payments, physical actions, destructive or legal steps need a human.";

export async function saipenGoalVerdict(input: {
  workspaceRoot: string;
  objective: string;
  /** Test seam: SAIPEN's projection (null = unavailable). Omitted = ask SAIPEN. */
  projection?: SaipenGoalProjection | null;
}): Promise<GoalCompletionVerificationOutput | null> {
  const memory = join(input.workspaceRoot, ".saipen");
  const boardPath = join(memory, "BOARD.md");
  const statePath = join(memory, "STATE.md");
  if (!existsSync(boardPath) || !existsSync(statePath)) return null;
  let board: SaipenBoard;
  let phase = "";
  let nextAction = "";
  let state = "";
  try {
    board = parseSaipenBoardForGoal(readFileSync(boardPath, "utf8"));
    state = readFileSync(statePath, "utf8");
    phase = frontMatterValue(state, "phase");
    nextAction = frontMatterValue(state, "next_action");
  } catch {
    return null;
  }

  const projection = input.projection === undefined ? await readSaipenGoalProjection(input.workspaceRoot, state) : input.projection;
  if (projection) {
    const open = projection.claimedTicket ?? projection.topWorkableTicket;
    if (open && projection.closureComplete !== true) {
      const title = [...board.doing, ...board.todo, ...board.blocked].find((ticket) => ticket.id === open)?.title ?? "";
      return {
        passed: false,
        reason: `SAIPEN reports open work: ${open} (phase ${projection.phase}).`,
        nextAction: `cc — continue SAIPEN: ${open} ${title}`.trim().slice(0, 200),
      };
    }
    // SAIPEN says nothing workable is left; the blocked-ticket handling below still applies.
    board = { ...board, doing: [], todo: [] };
    phase = "";
  }

  const actionable = [...board.doing, ...board.todo];
  const stateBusy = !IDLE_PHASES.has(phase.toLowerCase()) && !/^WAIT:/i.test(nextAction);
  if (actionable.length > 0 || stateBusy) {
    const next = actionable[0];
    return {
      passed: false,
      reason: next
        ? `SAIPEN board still has ${actionable.length} actionable ticket(s) (${board.doing.length} doing, ${board.todo.length} todo).`
        : `SAIPEN STATE is in phase ${phase} (${nextAction || "work in progress"}).`,
      nextAction: next ? `cc — continue SAIPEN: ${next.id} ${next.title}`.slice(0, 200) : "cc — continue SAIPEN",
    };
  }

  if (!isSaipenContinuationObjective(input.objective)) return null;

  // Blocked tickets whose blocker is an engineering choice go back to the agent.
  const autonomousBlockers = board.blocked.filter((ticket) => !isHumanBlockedTicket(ticket, nextAction));
  for (const next of autonomousBlockers) {
    if (!takeAutonomousPush(`${input.workspaceRoot}|${next.id}|${next.blocker ?? ""}`)) continue;
    return {
      passed: false,
      reason: `Ticket ${next.id} is BLOCKED on something the agent can resolve ("${(next.blocker || next.title).slice(0, 120)}"). ${DECIDE_YOURSELF}`,
      nextAction: `cc — unblock ${next.id} and resolve autonomously: make the standard engineering choice, implement missing files, and complete.`.slice(0, 200),
    };
  }

  // A WAIT that is not a human-only need is also the agent's to resolve.
  if (/^WAIT:/i.test(nextAction) && !isHumanOnlyBlocker(nextAction)) {
    if (takeAutonomousPush(`${input.workspaceRoot}|WAIT|${nextAction}`)) {
      return {
        passed: false,
        reason: `SAIPEN is waiting on "${nextAction.slice(0, 140)}", which needs no human. ${DECIDE_YOURSELF}`,
        nextAction: "cc — resolve the WAIT autonomously: decide, record the decision, continue the board.",
      };
    }
  }

  const blocked = board.blocked.map((ticket) => ticket.id).join(", ");
  return {
    passed: true,
    reason:
      board.blocked.length > 0
        ? `SAIPEN board clear of human-free work: ${board.done} done; ${board.blocked.length} blocked on a human (${blocked}).`
        : `SAIPEN board clear: ${board.done} done, nothing left.`,
    nextAction: "",
  };
}
