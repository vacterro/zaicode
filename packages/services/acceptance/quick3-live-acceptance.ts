/**
 * T-112 live acceptance: a real three-wave Quick3 campaign, against a real
 * model, through the real ZaicodeAuditService.
 *
 * What is real here: the service, the report gate, the campaign state machine,
 * the artifact synthesis and the Fix-with-SAIPEN handoff are the shipped code
 * under test. The auditor is a real model (local Ollama) that reads the real
 * source and writes a real report.
 *
 * What is substituted, stated plainly rather than glossed: the production
 * executor resolves a full host ServiceCollection and drives the desktop task
 * service, which cannot be stood up headlessly. Here the model turn is made
 * over Ollama's HTTP API instead. The campaign machinery under test is
 * unchanged.
 *
 * The auditor is given READ tools and no write tool at all, so "read-only" is
 * structural: it is not asked to be read-only, it is unable to be anything
 * else.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import { ZaicodeAgentRepo } from "../src/zaicode/zaicodeAgentRepo.js";
import { ZaicodeAgentService } from "../src/zaicode/zaicodeAgentService.js";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZaicodeJobService } from "../src/zaicode/zaicodeJobService.js";
import { ZaicodeAuditService } from "../src/zaicode/zaicodeAuditService.js";
import type { ZaicodeJobExecutor } from "../src/zaicode/zaicodeJobs.js";

const OLLAMA = process.env.QA_OLLAMA ?? "http://127.0.0.1:11434";
const MODEL = process.env.QA_MODEL ?? "qwen3.5:9b";
const REPO = resolvePath(process.cwd(), "..", "..");
const TARGET = process.env.QA_TARGET ?? join(REPO, "packages", "shared", "src");
const PROJECT = process.env.QA_PROJECT ?? "ZAICODE";
const WS = {
  workspaceKey: "acceptance-1",
  workspacePath: TARGET,
  projectName: PROJECT,
};
const READ_TOOL = "<read_file path=\"...\" />";
const LIST_TOOL = "<list_dir path=\"...\" />";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Read what the wave prompt told the auditor, the way the auditor reads it. */
interface Brief {
  reportPath: string;
  runId: string;
  predecessorSha: string | null;
  predecessorPath: string | null;
}
function readBrief(instructions: string): Brief | null {
  const reportPath = /Write the report to this exact file[^\n]*\n(.+)/.exec(instructions)?.[1]?.trim();
  if (!reportPath) return null;
  return {
    reportPath,
    runId: /- Run id: (\S+)/.exec(instructions)?.[1] ?? "",
    predecessorSha: /predecessor artifact sha256 `([0-9a-f]{64})`/.exec(instructions)?.[1] ?? null,
    predecessorPath: /Read (\S+) \(sha256/.exec(instructions)?.[1] ?? null,
  };
}

// ---- the auditor's READ-ONLY toolbox (there is no write tool) ----------------

function safeTarget(path: string): string | null {
  const full = resolvePath(TARGET, path);
  const root = resolvePath(TARGET);
  return full === root || full.startsWith(root + sep) ? full : null;
}

const MAX_READ = 90_000;
function readFile_(full: string): string {
  if (!existsSync(full)) return "(no such file)";
  if (statSync(full).size > MAX_READ) {
    return `(file is ${statSync(full).size} bytes; showing the first ${MAX_READ})\n${readFileSync(full, "utf8").slice(0, MAX_READ)}`;
  }
  return readFileSync(full, "utf8");
}
function listDir(full: string): string {
  if (!existsSync(full)) return "(no such directory)";
  return readdirSync(full, { withFileTypes: true })
    .map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`)
    .join("\n");
}

/** The model's read requests, in the only protocol it needs to learn. */
const READ_PROTOCOL = [
  'To read the source, emit lines of exactly this shape, one per line:',
  READ_TOOL,
  LIST_TOOL,
  "and nothing else in that line. The contents come back before your next message.",
  "Paths are relative to the project root you were given.",
].join("\n");

function applyReads(reply: string): { transcript: string; consumed: number } {
  const requests = [...reply.matchAll(/<(read_file|list_dir)\s+path="([^"]+)"\s*\/>/g)];
  if (requests.length === 0) return { transcript: "", consumed: 0 };
  const parts: string[] = [];
  for (const request of requests.slice(0, 8)) {
    const full = safeTarget(request[2]!);
    if (!full) {
      parts.push(`### ${request[2]}\n(refused: outside the project root)`);
      continue;
    }
    parts.push(`### ${request[2]}\n\`\`\`\n${request[1] === "read_file" ? readFile_(full) : listDir(full)}\n\`\`\``);
  }
  return { transcript: parts.join("\n"), consumed: requests.length };
}

async function askModel(messages: { role: string; content: string }[]): Promise<string> {
  // A local model server drops a long request under load. Two attempts with a
  // pause is enough to ride that out; a third failure is a real failure and is
  // allowed to propagate rather than being reported as an empty answer.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages, stream: false, options: { temperature: 0.2, num_ctx: 8192 } }),
      });
      if (!response.ok) throw new Error(`ollama ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const body = (await response.json()) as { message?: { content?: string } };
      return body.message?.content ?? "";
    } catch (error) {
      lastError = error;
      console.error(`    [model] attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  throw lastError;
}

// ---- the real campaign, driven by a real model ------------------------------

const log: string[] = [];
function say(line: string): void {
  console.log(line);
  log.push(line);
}

async function runWave(instructions: string, label: string): Promise<{ sessionId: string }> {
  const brief = readBrief(instructions);
  if (!brief) {
    console.error("  [auditor] could not read a brief out of the prompt:", label);
    return { sessionId: `no-brief-${label}` };
  }

  const transcript: { role: string; content: string }[] = [
    {
      role: "user",
      content: [
        instructions,
        "",
        "---",
        READ_PROTOCOL,
        "",
        `The project root is: ${TARGET}`,
        "Files at its top level:",
        listDir(TARGET).split("\n").slice(0, 60).join("\n"),
        "",
        "You must READ the real source before you claim anything. Cite file and line.",
        `Ask for several files in ONE message (one ${READ_TOOL} line each) to save turns.`,
      ].join("\n"),
    },
  ];

  for (let turn = 0; turn < 5; turn += 1) {
    const reply = await askModel(transcript);
    const { transcript: results } = applyReads(reply);
    if (!results) break;
    say(`    ${label}: read ${results.split("### ").length - 1} file(s), turn ${turn + 1}`);
    transcript.push({ role: "assistant", content: reply });
    transcript.push({
      role: "user",
      content: `Here are the results.\n\n${results}\n\nRead more if you need to; otherwise say READY.`,
    });
  }

  // The report is asked for in its own, self-contained turn. The model drifts
  // when it has to remember the contract across a long read transcript, and a
  // drifted report is a refused wave -- correct behaviour that proves nothing
  // about the chain. So the exact strings are restated here, not referred to.
  const contract = {
    terminal: /- It must contain the line `([^`]+)`/.exec(instructions)?.[1] ?? "",
    doneMarker: /- It must contain `([^`]+)`/.exec(instructions)?.[1] ?? "",
    ticket: /- File every finding under a ticket titled exactly `([^`]+)` -- for example `([^`]+)`/.exec(instructions),
    fields: /- Each finding must carry these fields, in this order: ([^.]+)\./.exec(instructions)?.[1] ?? "",
    noFindings: /- If you verify nothing, the report must contain exactly this line: `([^`]+)`/.exec(instructions)?.[1] ?? "",
    classification: /- Each performance finding must be classified as one of: ([^.]+)\./.exec(instructions)?.[1] ?? "",
  };
  transcript.push({
    role: "user",
    content: [
      "READY. Output the COMPLETE report as your whole next message, in markdown, and nothing else:",
      "no preamble, no code fence, no explanation of how you audited.",
      "",
      "The report must contain all of the following, exactly:",
      `- a line naming the project: ZAICODE`,
      `- a line naming the run: ${brief.runId}`,
      ...(brief.predecessorSha ? [`- a line naming the predecessor artifact sha256: ${brief.predecessorSha}`] : []),
      ...(contract.classification ? [`- each finding classified as one of: ${contract.classification}`] : []),
      "",
      "Findings, each as a ticket with every field on its own line, in this order:",
      `- ${contract.ticket?.[2] ?? "CORE-1"} <short title>`,
      ...(contract.fields ? contract.fields.split(",").map((field) => `${field.trim()}: <text>`) : []),
      "",
      `If you verified nothing, include this line instead: ${contract.noFindings}`,
      `Include a line starting with: ${contract.doneMarker}`,
      `And the VERY LAST line of your message must be exactly: ${contract.terminal}`,
      "Nothing at all after that line.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  });
  const report = stripFences(await askModel(transcript));

  await mkdir(join(brief.reportPath, ".."), { recursive: true });
  await writeFile(brief.reportPath, report, "utf8");
  say(`    ${label}: wrote ${brief.reportPath.split(sep).pop()} (${report.length} bytes)`);
  // Dump the tail: when a wave is refused, the last lines are the whole story.
  say(`      ...${JSON.stringify(report.slice(-160))}`);
  return { sessionId: `live-${label}` };
}

/** Models like to wrap the whole report in a fence; the gate wants the report. */
function stripFences(text: string): string {
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/m.exec(text.trim());
  if (fenced) return fenced[1]!.trim();
  return text.trim();
}

let jobServiceRef: ZaicodeJobService | null = null;
const executor: ZaicodeJobExecutor = async ({ job }) => {
  const handle = await runWave(job.instructions, job.title);
  const runId = job.runId ?? "";
  const attempt = job.attempt;
  setTimeout(() => {
    void jobServiceRef!
      .reportRunOutcome({ jobId: job.id, runId, attempt, outcome: "succeeded", resultSummary: "live audit wave" })
      .catch(() => undefined);
  }, 0);
  return { sessionId: handle.sessionId };
};

async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  say(`ZAICODE A3 (Quick3) live acceptance`);
  say(`  model      : ${MODEL} @ ${OLLAMA}`);
  say(`  target     : ${TARGET}`);
  say(`  project    : ${PROJECT}`);
  say("");

  const dir = await mkdtemp(join(tmpdir(), "zaicode-a3-live-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const auditRoot = join(dir, "audits");
  const agentRepo = new ZaicodeAgentRepo(dbPath, 500);
  const agentService = new ZaicodeAgentService({ repo: agentRepo });
  const jobRepo = new ZaicodeJobRepo(dbPath, 500);
  const jobService = new ZaicodeJobService({
    repo: jobRepo,
    getAgent: (id) => agentService.get(id),
    getExecutor: () => executor,
    logger: { warn: (message: string, error?: unknown) => console.error("  [queue]", message, error instanceof Error ? error.stack ?? error.message : error ?? "") },
  });
  jobServiceRef = jobService;
  await jobService.ensureReady();
  await jobService.setAutoRun(true);
  const audits = new ZaicodeAuditService({
    jobService,
    agentService,
    rootDir: () => auditRoot,
    // Without this the queue swallows why a wave failed and the acceptance
    // reports "blocked" with no cause -- exactly the ambiguity it must not have.
    logger: { warn: (message, error) => console.error("  [service]", message, error instanceof Error ? error.message : error ?? "") },
  });

  say("STEP 1  /a3 -> one campaign, one Core");
  const started = await audits.start(WS);
  const campaignId = started!.campaignId;
  say(`  run ${started!.runId}`);
  say(`  profile ${started!.profileId} ${started!.profileVersion} (${started!.manifestHash})`);
  say(`  source  ${started!.sourceIdentity}`);
  const jobsAfterStart = await jobService.list({ workspaceKey: WS.workspaceKey });
  say(`  queue   ${jobsAfterStart.jobs.length} job(s), ${jobsAfterStart.jobs.filter((j) => j.title.startsWith("A3 ")).length} wave(s)`);
  say("");

  say("STEP 2  three chained waves against the live model");
  let state = started!;
  // A real model reading real source takes minutes per wave; the poll waits
  // for a TERMINAL state rather than for a fixed number of rounds.
  const deadline = Date.now() + (Number(process.env.QA_TIMEOUT_MS ?? 45 * 60_000));
  let lastLine = "";
  for (;;) {
    if (Date.now() >= deadline || state.status === "complete" || state.status === "blocked") break;
    await settle(5000);
    state = (await audits.getState()).campaigns.find((c) => c.campaignId === campaignId)!;
    const wave = state.waves[state.currentWaveIndex];
    const line =
      `  [${state.status}] ${state.waves.filter((w) => w.status === "complete").length}/3 saved` +
      (wave?.attempt && wave.attempt > 1 ? ` · attempt ${wave.attempt}` : "") +
      (wave?.rejectReason ? ` · refused: ${wave.rejectReason}` : "");
    // Only print on a change: 45 minutes of identical lines helps nobody.
    if (line !== lastLine) {
      say(line);
      lastLine = line;
    }
  }

  say("");
  say("STEP 3  the four durable artifacts");
  const rows = state.waves.map((wave) => {
    const file = wave.reportFile ?? "";
    const path = join(auditRoot, campaignId, file);
    const onDisk = existsSync(path);
    say(
      `  ${file.padEnd(34)} ${onDisk ? "saved" : "MISSING"}  ${(wave.resultSha256 ?? "").slice(0, 16)}` +
        (wave.rejectReason ? `  <- ${wave.rejectReason}` : ""),
    );
    return onDisk;
  });
  const combinedName = state.combined?.file ?? "MISSING";
  const combinedPath = join(auditRoot, campaignId, combinedName);
  const combinedOnDisk = existsSync(combinedPath);
  say(`  ${combinedName.padEnd(34)} ${combinedOnDisk ? "saved" : "MISSING"}  ${(state.combined?.sha256 ?? "").slice(0, 16)}`);
  if (combinedOnDisk) {
    const bytes = readFileSync(combinedPath, "utf8");
    say(`    combined digest verified: ${sha256(bytes) === state.combined?.sha256}`);
  }
  say("");
  say(`  campaign status: ${state.status}`);
  say(`  verified findings: ${state.findings}`);

  say("");
  say("STEP 4  Fix with SAIPEN");
  let fixed = state;
  try {
    fixed = (await audits.fixWithSaipen(campaignId))!;
    const fixJob = (await jobService.list({ workspaceKey: WS.workspaceKey })).jobs.find(
      (j) => j.id === fixed.fixJobId,
    );
    say(`  job ${fixed.fixJobId} on the queue: ${Boolean(fixJob)}`);
    say(`  source drift: ${JSON.stringify(fixed.sourceDrift)}`);
    if (fixJob) {
      const names = fixed.combined!.sha256;
      say(`  the job names the artifact digest: ${fixJob.instructions.includes(names)}`);
      say(`  the job names the artifact file:   ${fixJob.instructions.includes(fixed.combined!.file)}`);
    }
  } catch (error) {
    say(`  refused: ${error instanceof Error ? error.message : String(error)}`);
  }

  const verdict =
    rows.every(Boolean) && combinedOnDisk && state.status === "complete" && Boolean(fixed.fixJobId);
  say("");
  say(`RESULT: ${verdict ? "PASS" : "INCOMPLETE"}`);

  jobService.dispose();
  agentRepo.close();
  jobRepo.close();
  await writeFile(join(process.cwd(), "acceptance-result.txt"), log.join("\n"), "utf8");
  process.exit(verdict ? 0 : 1);
}

void main();
