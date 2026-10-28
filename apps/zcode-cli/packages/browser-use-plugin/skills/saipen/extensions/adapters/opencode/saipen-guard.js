// SAIPEN guard adapter for OpenCode (SRC-028:R012 / SRC-030 Part 9).
//
// Installed by the bootstrap injectors into the GLOBAL LOCAL PLUGIN DIRECTORY
// the runtime actually discovers: `~/.config/opencode/plugins/saipen-guard.js`
// (plural `plugins/`; registry.json owns this path and the legacy singular
// surface the injector cleans up so the hook is never loaded twice).
//
// One file, no shared state: uninstall is `rm` of exactly this file, and
// re-install is an overwrite, so unrelated user plugins and configuration are
// never touched.
//
// Verified host contract (OpenCode 1.18.x, `opencode debug config`):
//   * the plugin factory is invoked with a context object
//     ({ project, client, worktree, directory, $ }) and NO session identity,
//   * `tool.execute.before(input, output)` receives the tool name on `input`
//     (`input.tool`, plus the host session on `input.sessionID`) and MUTABLE
//     tool arguments on `output.args`,
//   * throwing from the hook prevents the host tool from executing.
//
// Behavior contract:
//   allowed action            -> host tool proceeds (guard exit 0)
//   guard refusal             -> host tool does not execute (thrown error)
//   guard failure / invalid
//   output / unreachable      -> fail closed for consequential mutations
//   verified built-in reads   -> never consequential; no guard round trip
//
// This file TRANSLATES only: it forwards one bounded JSON event
// (event/host/cwd/tool_name/tool_input/actor/session_id) to
// `saipen guard --event-json -` and blocks on a nonzero exit. All protocol
// semantics -- target sets, patches, canonical operations, ownership -- live
// in the guard. The adapter never re-implements a protocol rule.
//
// Actor identity: the OpenCode session id is NOT a SAIPEN seat identity, so it
// is never used as the actor. `SAIPEN_AGENT` is an optional explicit
// actor/provenance carrier, not authentication. The optional SAIPEN launcher
// can set it together with SAIPEN_PROJECT_ROOT / SAIPEN_PROJECT_LINEAGE. With
// no carrier the event omits actor and Core inherits canonical `STATE.agent`
// through its existing protocol snapshot before applying every safety check.
//
// Factory startup writes one bounded per-process diagnostic under the OS temp
// root. `SAIPEN_GUARD_STARTUP_PROBE` optionally captures the same JSON line for
// native smoke. Both identify the module bytes loaded into this process.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_EVENT_BYTES = 256 * 1024;
const GUARD_TIMEOUT_MS = 15000;
const FLEET_TIMEOUT_MS = 120000;
const BUILD_ID = "T-1327-zero-manual-recovery-20260914.1";
const MAX_DIAGNOSTIC_BYTES = 4096;

// P0-1 (SRC-028:R012): system authority carries ONLY bounded machine facts.
// The model-visible bootstrap payload is a closed record -- binding code,
// canonical project root, project lineage, a bounded provenance enum and one
// fixed adapter-generated instruction. Arbitrary project- or environment-
// derived diagnostic prose (the guard's `detail`) is DIAGNOSTIC material and
// stays in the startup diagnostic, evidence and ordinary tool output; it is
// never promoted into a system message. These two bounds make that structural
// rather than a matter of the current code paths.
const MAX_BINDING_FACT_CHARS = 512;
const MAX_BINDING_CODE_CHARS = 64;
const BOUNDED_PROVENANCE = new Set([
  "explicit",
  "host-session",
  "git-worktree",
  "git-common",
  "ancestor",
]);

// Module-relative paths under the ES module runtime (no `__dirname`).
const MODULE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_PATH);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Capture at module evaluation, before a later injector can replace the file.
const LOADED_SHA256 = sha256(fs.readFileSync(MODULE_PATH));
const ACTIVE_DIAGNOSTIC = path.join(os.tmpdir(), `saipen-opencode-guard-active-${process.pid}.json`);
process.once("exit", () => {
  try { fs.unlinkSync(ACTIVE_DIAGNOSTIC); } catch (_error) { /* diagnostic only */ }
});

// Translation, not policy: these EXACT verified OpenCode built-in read-only
// tools cannot mutate the project, so the adapter never invokes the guard for
// them and a missing runtime cannot wedge diagnostics. The fast-path is
// identity-scoped: a namespaced/MCP/third-party tool whose last segment merely
// spells "read" is NOT read-only and goes to the guard (T-1317 P0-8).
const OPENCODE_READ_ONLY_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "webfetch",
  "skill",
  "question",
]);

// Exact native session-local state. OpenCode persists this in its own session
// database; it neither resolves nor writes a project path. Keep it separate
// from read tools so no Todo-like namespace or third-party identity inherits
// the bypass.
const OPENCODE_SESSION_LOCAL_TOOLS = new Set(["todowrite"]);

function isBuiltinNonProject(toolName) {
  const name = String(toolName === undefined || toolName === null ? "" : toolName)
    .trim()
    .toLowerCase();
  if (!name || name.includes("__") || name.includes(".")) return false;
  return OPENCODE_READ_ONLY_TOOLS.has(name) || OPENCODE_SESSION_LOCAL_TOOLS.has(name);
}

function contextStart(context) {
  // OpenCode's factory worktree is the verified project carrier. Directory is
  // the session location and may be a detached staging/drag directory.
  return (context && (context.worktree || context.directory)) || process.cwd();
}

// Every host-supplied context candidate, worktree FIRST (the verified project
// carrier), then the session directory. Deduplicated and order-preserving.
// Measured host fact: for a session started in a directory OpenCode does not
// recognize as a VCS worktree, `context.worktree` is the placeholder "/" while
// `context.directory` is the real project -- so a single worktree-first pick
// can lose a binding OpenCode actually supplied.
//
// The adapter's own process cwd is NOT a candidate while the host supplied any
// context: it would adopt an unrelated ambient repository (the driver/test
// process's cwd is the SAIPEN skill home) and would make a genuinely
// non-SAIPEN session look bound. It remains the LAST-RESORT start only when
// the host supplied no context at all, which is where it was before.
function contextCandidates(context) {
  const supplied = [
    (context && context.worktree) || null,
    (context && context.directory) || null,
  ].filter((value) => typeof value === "string" && value.trim());
  const values = supplied.length ? supplied : [process.cwd()];
  const seen = new Set();
  const candidates = [];
  for (const value of values) {
    const candidate = value.trim();
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function skillRoot() {
  if (process.env.SAIPEN_SKILL_ROOT) return process.env.SAIPEN_SKILL_ROOT;
  // Installed at <config>/opencode/plugins/saipen-guard.js, and the skill copy
  // lives at <config>/opencode/skills/saipen -- one directory up, two down.
  const sibling = path.resolve(MODULE_DIR, "..", "skills", "saipen");
  if (fs.existsSync(path.join(sibling, "tools", "saipen.py"))) return sibling;
  return path.join(os.homedir(), ".config", "opencode", "skills", "saipen");
}

function findPython() {
  const candidates = [process.env.SAIPEN_PYTHON, "python3", "python"].filter(Boolean);
  for (const name of candidates) {
    const probe = spawnSync(name, ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8", timeout: 5000,
    });
    if (!probe.error && probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  return null;
}

// The canonical `saipen <verb>` invocation the guard ADMITS (admission effect
// class "saipen_op") can only run if the HOST SHELL can RESOLVE `saipen`.
// Measured host fact (T-1318 AC-05): OpenCode's shell tool on Windows runs
// PowerShell, which resolves a command only through PATHEXT (.exe/.cmd/.bat);
// an extensionless POSIX script named `saipen` is invisible there. The
// canonical installer therefore materialises BOTH launcher families in the
// installed skill's `bin/`, and the guard puts that directory on PATH for the
// host's child processes. This is a translation fix, not an authority change:
// the guard still decides every verdict.
//
// OWNERSHIP (T-1319): the canonical installer (bootstrap/inject.ps1 /
// bootstrap/inject.sh) is the ONE launcher writer. It renders `bin/saipen` and
// `bin/saipen.cmd` from the single source owner `bootstrap/cli_launcher.py`
// into the STAGED skill before the atomic swap. The guard does NOT write
// launcher bytes: a second writer would let a stale install silently self-heal
// and hide an ownership regression. The guard only verifies the launchers
// exist and reference the INSTALLED `tools/saipen.py`, prepends the installed
// `bin/` to the host PATH, and reports drift through the startup diagnostic.
// Never throws: a launcher failure must never change a guard verdict.
const CLI_BIN_DIR = "bin";
const CLI_POSIX_NAME = "saipen";
const CLI_WINDOWS_NAME = "saipen.cmd";

function verifyCliLaunchers(skill, saipenPy) {
  const binDir = path.join(skill, CLI_BIN_DIR);
  try {
    if (!fs.existsSync(binDir)) return { binDir, state: "missing", detail: "bin directory absent" };
    const cmdPath = path.join(binDir, CLI_WINDOWS_NAME);
    const posixPath = path.join(binDir, CLI_POSIX_NAME);
    const missing = [];
    if (!fs.existsSync(cmdPath)) missing.push(CLI_WINDOWS_NAME);
    if (!fs.existsSync(posixPath)) missing.push(CLI_POSIX_NAME);
    if (missing.length) return { binDir, state: "missing", detail: `missing ${missing.join(",")}` };
    const cli = path.resolve(saipenPy).replace(/\\/g, "/").toLowerCase();
    const references = (value) =>
      String(value).replace(/\\/g, "/").toLowerCase().includes(cli);
    if (!references(fs.readFileSync(cmdPath, "utf8")) ||
        !references(fs.readFileSync(posixPath, "utf8"))) {
      return { binDir, state: "drift", detail: "launcher does not reference the installed saipen.py" };
    }
    return { binDir, state: "ok", detail: "" };
  } catch (error) {
    return { binDir, state: "drift", detail: String((error && error.code) || error) };
  }
}

// T-1327 TARGET C: report which installed GENERATION this process is running,
// read-only. The supported launch path (`saipen --agent <seat> launch opencode`)
// already proves and resyncs freshness BEFORE this module is loaded, so a
// current install is the normal case; this records the fact instead of
// assuming it. Resync is deliberately NOT attempted here: a loaded plugin can
// never be hot-replaced honestly, and the guard already fails closed with
// PLUGIN_RESTART_REQUIRED when the installed bytes move under a live process.
function probeRuntimeGeneration(pythonBin, saipenPy) {
  if (!pythonBin || !saipenPy) return null;
  try {
    const proc = spawnSync(
      pythonBin,
      [saipenPy, "runtime", "--prelaunch", "--adapter", "opencode", "--no-resync", "--json"],
      { encoding: "utf8", timeout: GUARD_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_EVENT_BYTES },
    );
    const payload = JSON.parse(proc.stdout || "");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return {
      code: boundedFact(payload.code, MAX_BINDING_CODE_CHARS),
      stale: payload.stale_before === true,
      fingerprint_match: payload.fingerprint_match === true,
      installed_fingerprint: boundedFact(payload.installed_fingerprint, 80),
      canonical_fingerprint: boundedFact(payload.canonical_fingerprint, 80),
    };
  } catch (_error) {
    // Diagnostic only: an unprovable canonical source is a legitimate state
    // for an installed runtime whose clone is gone, and never a tool verdict.
    return null;
  }
}

function prependCliBin(binDir) {
  if (!binDir || !fs.existsSync(binDir)) return null;
  try {
    const current = process.env.PATH || "";
    const entries = current.split(path.delimiter).filter(Boolean);
    const normalize = (entry) => {
      const resolved = path.resolve(entry);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const remaining = entries.filter((entry) => {
      try { return normalize(entry) !== normalize(binDir); } catch (_error) { return true; }
    });
    // An existing but trailing entry still lets an old launcher win. Move
    // this installation first while retaining every unrelated search path.
    const next = [binDir, ...remaining].join(path.delimiter);
    process.env.PATH = next;
    if (process.platform === "win32") process.env.Path = next;
    return binDir;
  } catch (_error) {
    return null;
  }
}

// Async child I/O avoids blocking the host event loop and does not depend on
// the runtime's spawnSync `input` option for the JSON event. Output is bounded.
function runPython(pythonBin, saipenPy, args, payload, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(pythonBin, [saipenPy, ...args], {
        cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
    } catch (error) {
      resolve({ status: null, error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let failure = null;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, error: failure });
    };
    const collect = (chunk, stream) => {
      const next = stream + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_EVENT_BYTES) {
        failure = new Error("guard output exceeded bound");
        failure.code = "OUTPUT_OVERFLOW";
        child.kill();
        return stream;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = collect(chunk, stdout); });
    child.stderr.on("data", (chunk) => { stderr = collect(chunk, stderr); });
    child.on("error", (error) => { failure = error; finish(null, null); });
    child.on("close", (status, signal) => finish(status, signal));
    child.stdin.on("error", () => { /* child exit is reported by close */ });
    const timer = setTimeout(() => {
      failure = new Error("guard timed out");
      failure.code = "ETIMEDOUT";
      child.kill();
      finish(null, null);
    }, timeoutMs);
    try {
      child.stdin.end(payload || "");
    } catch (error) {
      failure = error;
      child.kill();
      finish(null, null);
    }
  });
}

function runGuard(pythonBin, saipenPy, payload, cwd) {
  return runPython(
    pythonBin, saipenPy, ["guard", "--event-json", "-", "--json"],
    payload, cwd, GUARD_TIMEOUT_MS,
  );
}

function runFleetPrepare(pythonBin, saipenPy, binding, cwd, attemptedCondition, requireBinding) {
  const args = ["fleet", "prepare", "--cwd", cwd, "--json"];
  if (requireBinding) args.push("--require-binding");
  if (binding.project_root) args.push("--host-root", binding.project_root);
  if (binding.project_lineage) args.push("--host-lineage", binding.project_lineage);
  if (attemptedCondition) args.push("--attempted-condition", attemptedCondition);
  return runPython(pythonBin, saipenPy, args, null, cwd, FLEET_TIMEOUT_MS);
}

// Pure decision core: map one guard subprocess result onto block/allow. A refusal,
// a crash and an unreachable guard all
// block; only exit 0 allows.
function decide(result) {
  if (!result || typeof result.status !== "number") {
    return {
      block: true,
      code: "GUARD_UNREACHABLE",
      diagnostic: String((result && result.error && result.error.code) ||
                         (result && result.signal) || "process exited without status"),
    };
  }
  let code = "GUARD_REFUSED";
  try {
    const parsed = JSON.parse(result.stdout || "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        typeof parsed.admitted !== "boolean" || typeof parsed.code !== "string") {
      return { block: true, code: "GUARD_OUTPUT_INVALID" };
    }
    if (result.status === 0 && parsed.admitted === true) {
      return { block: false, code: parsed.code };
    }
    code = parsed.code;
  } catch (_error) {
    return { block: true, code: "GUARD_OUTPUT_INVALID" };
  }
  return { block: true, code };
}

function bindingActor() {
  const bound = process.env.SAIPEN_AGENT;
  return typeof bound === "string" && bound.trim() ? bound.trim() : null;
}

function buildEvent(context, toolName, toolInput, options) {
  const opts = options || {};
  const cwd = opts.cwd || contextStart(context);
  const actor = opts.actor === undefined ? bindingActor() : opts.actor;
  const event = {
    event: "before_tool",
    host: "opencode",
    cwd,
    tool_name: String(toolName),
    tool_input: toolInput && typeof toolInput === "object" ? toolInput : {},
  };
  if (actor) event.actor = actor;
  if (opts.sessionId) event.session_id = String(opts.sessionId);
  return event;
}

function parseGuardPayload(result) {
  try {
    const payload = JSON.parse((result && result.stdout) || "");
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch (_error) {
    return null;
  }
}

// ONE shape for every guard refusal the model reads, whichever branch throws it.
//
// T-1385, measured from OpenCode's own session store: all eleven
// PROTECTED_CANONICAL_NAMESPACE refusals the field recorded reached the model
// as `the host tool did not execute` and nothing else. The terminal-code branch
// threw its own shorter sentence before the branch that names the route and
// the attempted command, so the route never arrived, and seven different
// effects read as one refusal repeating.
function guardRefusal(verdict, guardPayload, toolName, args) {
  // T-1363: when the guard computed the exact command that carries this
  // request, the refusal names it. A bounded machine fact, capped like
  // every other one the adapter forwards -- never guard prose.
  const route =
    guardPayload && typeof guardPayload.canonical_next_command === "string"
      ? guardPayload.canonical_next_command.slice(0, MAX_EVENT_BYTES)
      : "";
  // T-1380: a refusal that does not say WHAT it refused reads identically
  // for every effect it stops, so two different commands blocked by one
  // standing project state were measured as the same refusal repeating
  // with nothing changed. The attempted command is a bounded machine fact
  // the adapter already holds; naming it is what makes two refusals two.
  const attempted =
    args && typeof args.command === "string"
      ? ` attempted: ${args.command.slice(0, 160)}`
      : "";
  return new Error(
    `SAIPEN_GUARD_REFUSAL: ${verdict.code}: the saipen guard refused tool '${toolName}'; ` +
      `the host tool did not execute` +
      (verdict.diagnostic ? ` (${verdict.diagnostic})` : "") +
      attempted +
      (route ? ` next: ${route}` : ""),
  );
}

// One bounded line of machine fact, or null. Control characters and newlines
// are stripped so no carried value can smuggle a second system-ahead line, a
// value over the bound is refused rather than truncated (an over-long root is
// not a root we can route on), and a non-string is never coerced into prose.
function boundedFact(value, limit) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned.length > (limit || MAX_BINDING_FACT_CHARS)) return null;
  return cleaned;
}

// One canonical roll call of the resolver against ONE host context candidate.
// The adapter reads no protocol rule here: it forwards one bounded event and
// reports the guard's bounded answer.
async function probeBindingCandidate(candidate, actor, pythonBin, saipenPy) {
  const payload = JSON.stringify(buildEvent(null, "read", {}, { actor, cwd: candidate }));
  if (Buffer.byteLength(payload, "utf8") > MAX_EVENT_BYTES) {
    return { code: "GUARD_EVENT_OVERFLOW" };
  }
  const result = await runGuard(pythonBin, saipenPy, payload, candidate);
  const parsed = parseGuardPayload(result);
  if (!parsed) {
    return { code: result && result.error ? "GUARD_UNREACHABLE" : "GUARD_OUTPUT_INVALID" };
  }
  return {
    code: boundedFact(parsed.code, MAX_BINDING_CODE_CHARS) || "GUARD_OUTPUT_INVALID",
    project_root: boundedFact(parsed.project_root),
    project_lineage: boundedFact(parsed.project_lineage),
    provenance: BOUNDED_PROVENANCE.has(parsed.provenance) ? parsed.provenance : null,
    // DIAGNOSTIC ONLY. Never serialized into a system message; see
    // bindingSystemMessage below.
    detail: typeof parsed.detail === "string" ? parsed.detail : "",
  };
}

async function resolveBootstrapBinding(context, actor, pythonBin, saipenPy) {
  const candidates = contextCandidates(context);
  const base = {
    context_directory: (context && context.directory) || null,
    context_worktree: (context && context.worktree) || null,
    host_candidates: candidates,
    //: The candidate the accepted binding came from; admission uses it as the
    //: event cwd so the resolved project, not a placeholder, judges the tool.
    resolved_from: null,
  };
  if (!pythonBin) return { ...base, code: "GUARD_UNREACHABLE" };
  let primary = null;
  for (const candidate of candidates) {
    const record = await probeBindingCandidate(candidate, actor, pythonBin, saipenPy);
    if (primary === null) primary = { ...base, ...record };
    if (record.project_root) {
      // Worktree-first: the FIRST candidate that yields a canonical binding
      // wins, so a valid worktree carrier is never displaced by the session
      // directory.
      return { ...base, resolved_from: candidate, ...record };
    }
  }
  // No candidate yielded a binding. Report the PRIMARY (worktree-first)
  // refusal under its own code. Losing candidates are never consulted to
  // overturn a refusal, and an asserted-but-invalid carrier fails identically
  // for every candidate, so no ambient fallback can appear here.
  return primary || { ...base, code: "GUARD_OUTPUT_INVALID" };
}

// The ONE adapter-generated instruction carried beside the machine facts. It
// is a fixed string chosen by the guard's bounded code, never composed from
// project content.
function bindingInstruction(binding) {
  if (binding.project_root) {
    return "Binding was resolved mechanically by the canonical SAIPEN resolver before tool " +
      "admission. Use project_root directly; do not run generic shell root discovery and " +
      "do not ask the user for a root. Read BOOT/STYLE and the bound project's .saipen " +
      "state. A later consequential-tool refusal means protocol repair is required, not " +
      "that the binding is unknown. For saipen continue, bare saipen, cc or сс, " +
      "run saipen continue --json after the boot reads, open load_path and execute " +
      "action in this turn; respect WAIT and actual refusals. Skill loading only " +
      "returns instructions, never Git status or completion evidence. Missing " +
      "state reads are your next tool calls, not a question for the user.";
  }
  if (binding.code === "NOT_SAIPEN_PROJECT") {
    return "No SAIPEN project or asserted binding exists; the guard is non-interfering.";
  }
  return "A claimed or discoverable SAIPEN binding did not validate. Fail closed with the " +
    "returned binding_code; do not fall back to an ambient repository.";
}

// The complete system-authority surface for the bootstrap binding: four bounded
// machine facts on one line, then the fixed instruction. No `detail`, no host
// context paths, no free-form protocol prose.
function bindingSystemMessage(binding) {
  const payload = {
    binding_code: binding.code,
    project_root: binding.project_root,
    project_lineage: binding.project_lineage,
    provenance: binding.provenance,
  };
  return `SAIPEN_BOOTSTRAP_BINDING ${JSON.stringify(payload)}\n${bindingInstruction(binding)}`;
}

function startupProbe(
  context, actor, skill, saipenPy, bootstrapBinding, cliBin, cliLauncher, runtimeGeneration,
) {
  const diagnostic = {
    build_id: BUILD_ID,
    runtime_generation: runtimeGeneration,
    module_sha256: LOADED_SHA256,
    module_path: MODULE_PATH,
    skill_root: skill,
    guard_runtime_path: saipenPy,
    cli_bin: cliBin || null,
    cli_launcher_status: cliLauncher ? cliLauncher.state : null,
    cli_launcher_detail: cliLauncher ? cliLauncher.detail : "",
    pid: process.pid,
    factory_started_ms: Date.now(),
    cwd: contextStart(context),
    context_directory: (context && context.directory) || null,
    context_worktree: (context && context.worktree) || null,
    binding_code: bootstrapBinding.code,
    project_root: bootstrapBinding.project_root || null,
    project_lineage: bootstrapBinding.project_lineage || null,
    root_resolution_provenance: bootstrapBinding.provenance || null,
    host_candidates: bootstrapBinding.host_candidates || null,
    resolved_from: bootstrapBinding.resolved_from || null,
    binding_detail: bootstrapBinding.detail || "",
    actor,
  };
  const line = JSON.stringify(diagnostic);
  if (Buffer.byteLength(line, "utf8") > MAX_DIAGNOSTIC_BYTES) return;
  try {
    fs.writeFileSync(ACTIVE_DIAGNOSTIC, `${line}\n`, { mode: 0o600 });
  } catch (_error) {
    // Diagnostic failure never changes a tool verdict.
  }
  const target = process.env.SAIPEN_GUARD_STARTUP_PROBE;
  if (!target) return;
  try {
    fs.appendFileSync(target, `${line}\n`);
  } catch (_error) {
    // Probe failure is diagnostic only and never changes a verdict.
  }
}

// ---------------------------------------------------------------------------
// T-1446 AUTO_RECALL / AUTO_KICK carrier. The plugin knows what only the host
// knows (session, provider, model, which user message is new); the canonical
// runtime answers with the execution a successor must adopt.

const RECALL_TIMEOUT_MS = 10000;
const MAX_RECALL_DIRECTIVE_BYTES = 4096;
const MAX_INGRESS_TEXT_CHARS = 2048;
const RECALL_UNAVAILABLE =
  "SAIPEN_AUTO_RECALL_UNAVAILABLE: the canonical recall could not be computed for this " +
  "request. Run `saipen continue --json` before interpreting any earlier user message.";
// A canonical SAIPEN invocation in a host shell: the launcher, its .cmd twin
// or the runtime script, followed by a verb.
const SAIPEN_COMMAND_RE = /(?:^|[\s;&|("'])saipen(?:\.cmd|\.py)?["']?\s+[a-z]/i;

const recallSessions = new Map();

function sessionMemory(sessionID) {
  const key = sessionID ? String(sessionID) : "";
  let memory = recallSessions.get(key);
  if (!memory) {
    memory = { seen: false, lastIncarnation: null, pending: null, last: null };
    recallSessions.set(key, memory);
  }
  return memory;
}

function consumeIngress(memory) {
  if (memory && memory.pending) {
    memory.last = memory.pending;
    memory.pending = null;
  }
}

function userMessageText(output) {
  const parts = output && Array.isArray(output.parts) ? output.parts : [];
  const text = parts
    .filter((part) => part && part.type === "text" && !part.synthetic &&
      typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text.slice(0, MAX_INGRESS_TEXT_CHARS);
}

function recallCarrier(input, memory) {
  const model = (input && input.model) || {};
  const provider =
    model.providerID || (model.provider && model.provider.id) || model.provider || "";
  const ingress = memory.pending
    ? { id: memory.pending.id, text: memory.pending.text, consumed: false }
    : memory.last
      ? { id: memory.last.id, text: memory.last.text, consumed: true }
      : null;
  return {
    host: "opencode",
    // Diagnostic incarnation identity only; never an actor (see SAIPEN_AGENT).
    "host_session": (input && input.sessionID) ? String(input.sessionID) : "",
    provider: typeof provider === "string" ? provider : "",
    model: String(model.id || model.modelID || ""),
    previous_incarnation: memory.lastIncarnation || "",
    cold: !memory.seen,
    ingress,
  };
}

// One recall costs a Python start (~185 ms measured) and runs synchronously
// before a model request, so an unchanged answer is reused: same carrier, same
// canonical file identities, younger than the TTL. Any canonical write changes
// STATE/BOARD/LOG identity and forces a fresh recall.
const RECALL_CACHE_TTL_MS = 30000;
let recallCache = null;

function canonicalIdentity(projectRoot) {
  return ["STATE.md", "BOARD.md", "LOG.md"].map((name) => {
    try {
      const stat = fs.statSync(path.join(projectRoot, ".saipen", name));
      return `${name}:${stat.size}:${stat.mtimeMs}`;
    } catch (_error) {
      return `${name}:missing`;
    }
  }).join("|");
}

function runRecall(pythonBin, saipenPy, projectRoot, carrier) {
  if (!pythonBin || !saipenPy || !projectRoot) return null;
  const key = `${projectRoot}\n${JSON.stringify(carrier)}\n${canonicalIdentity(projectRoot)}`;
  if (recallCache && recallCache.key === key &&
      Date.now() - recallCache.at < RECALL_CACHE_TTL_MS) {
    return recallCache.payload;
  }
  const payload = computeRecall(pythonBin, saipenPy, projectRoot, carrier);
  recallCache = payload ? { key, at: Date.now(), payload } : null;
  return payload;
}

function computeRecall(pythonBin, saipenPy, projectRoot, carrier) {
  try {
    const hex = Buffer.from(JSON.stringify(carrier), "utf8").toString("hex");
    const proc = spawnSync(
      pythonBin,
      [saipenPy, "autonomy", "recall", "--json", "--directive", "--carrier-hex", hex],
      {
        encoding: "utf8", timeout: RECALL_TIMEOUT_MS, windowsHide: true,
        maxBuffer: MAX_EVENT_BYTES, cwd: projectRoot,
      },
    );
    const payload = JSON.parse(proc.stdout || "");
    if (!payload || payload.ok !== true || typeof payload.directive !== "string") return null;
    if (Buffer.byteLength(payload.directive, "utf8") > MAX_RECALL_DIRECTIVE_BYTES) return null;
    return payload;
  } catch (_error) {
    // A recall that cannot be computed is reported to the model as exactly
    // that; it never changes a tool verdict and never invents a decision.
    return null;
  }
}

const SaipenGuard = async (context) => {
  const skill = skillRoot();
  const saipenPy = path.join(skill, "tools", "saipen.py");
  const guardInstalled = fs.existsSync(saipenPy);
  const pythonBin = guardInstalled ? findPython() : null;
  // Make the guard's own canonical `saipen <verb>` surface REACHABLE in the
  // host's shell before any tool runs (T-1318 AC-05 reachability fix). The
  // installer owns the launcher bytes; the guard only verifies + PATH-injects.
  const cliLauncher = guardInstalled
    ? verifyCliLaunchers(skill, saipenPy)
    : { binDir: null, state: "absent", detail: "" };
  const cliBin = guardInstalled ? prependCliBin(cliLauncher.binDir) : null;
  // Capture an optional explicit override once per plugin factory instance so
  // sequential calls use stable provenance. This plain environment value is
  // not authenticated identity.
  const launchActor = bindingActor();
  const bootstrapBinding = await resolveBootstrapBinding(
    context, launchActor, pythonBin, saipenPy,
  );
  const runtimeGeneration = probeRuntimeGeneration(pythonBin, saipenPy);
  startupProbe(
    context, launchActor, skill, saipenPy, bootstrapBinding, cliBin, cliLauncher,
    runtimeGeneration,
  );

  const systemMessage = bindingSystemMessage(bootstrapBinding);
  // The resolved project is the admission cwd. When no binding resolved this
  // is the legacy worktree-first start, so refusal behaviour is unchanged.
  const eventCwd = bootstrapBinding.resolved_from || contextStart(context);
  let attemptedCondition = null;

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!output || !Array.isArray(output.system)) return;
      output.system.push(systemMessage);
      // T-1446 AUTO_RECALL / AUTO_KICK. This hook runs before EVERY model
      // request -- including the first request a replacement model serves
      // after a router swaps providers mid-work (SAIFREN, SRC-105). The
      // canonical execution is recomputed here from project state on each
      // request, so the successor receives the decision instead of needing a
      // memory it does not have.
      if (bootstrapBinding.code !== "ADMITTED" || !bootstrapBinding.project_root) return;
      const sessionID = input && input.sessionID;
      const memory = sessionMemory(sessionID);
      const recall = runRecall(
        pythonBin, saipenPy, bootstrapBinding.project_root,
        recallCarrier(input, memory),
      );
      memory.seen = true;
      if (!recall) {
        output.system.push(RECALL_UNAVAILABLE);
        return;
      }
      if (typeof recall.agent_incarnation === "string") {
        memory.lastIncarnation = recall.agent_incarnation;
      }
      const decision = recall.turn && recall.turn.decision;
      if (decision && decision !== "ORDINARY") output.system.push(recall.directive);
    },
    "chat.message": async (input, output) => {
      // A NEW user message is user authority until an admitted canonical
      // SAIPEN command consumes it. Identity is the host's message id, never
      // prose similarity.
      const text = userMessageText(output);
      const id =
        (input && input.messageID) ||
        (output && output.message && output.message.id) ||
        null;
      if (!text && !id) return;
      const memory = sessionMemory(input && input.sessionID);
      memory.pending = { id: id ? String(id) : null, text: text || "" };
    },
    "tool.execute.before": async (input, output) => {
      // Safe diagnostics must remain reachable after an installer replaces
      // this module. Exact built-ins only; lookalikes still face freshness
      // and Core admission before any consequential effect.
      const toolName =
        input && typeof input.tool === "string" && input.tool.trim() ? input.tool : "unknown";
      if (isBuiltinNonProject(toolName)) return;
      // A running host keeps its imported module after an on-disk overwrite.
      // Report that generation mismatch before consequential admission.
      let installedSha256;
      try { installedSha256 = sha256(fs.readFileSync(MODULE_PATH)); } catch (_error) {
        installedSha256 = "missing";
      }
      if (installedSha256 !== LOADED_SHA256) {
        throw new Error(
          `SAIPEN_GUARD_REFUSAL: PLUGIN_RESTART_REQUIRED: loaded build=${BUILD_ID} ` +
            `sha256=${LOADED_SHA256}; installed sha256=${installedSha256}; ` +
            `restart OpenCode; the host tool did not execute`,
        );
      }
      // Tool name comes from the real hook INPUT; arguments come from the
      // real mutable hook OUTPUT. No adapter-local alternative schema.
      const args = output ? output.args : undefined;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        // A hook payload we cannot read is not evidence of a safe call.
        throw new Error(
          `SAIPEN_GUARD_PAYLOAD_INVALID: tool.execute.before supplied no readable ` +
            `output.args for tool '${toolName}'; refusing rather than guessing the effect`,
        );
      }

      if (!guardInstalled) {
        throw new Error(
          `SAIPEN_GUARD_UNINSTALLED: no saipen guard at '${saipenPy}'; ` +
            `the saipen guard could not be consulted for tool '${toolName}' ` +
            `(consequential mutations fail closed)`,
        );
      }
      if (!pythonBin) {
        throw new Error(
          `SAIPEN_GUARD_UNREACHABLE: no Python runtime found; ` +
            `the saipen guard could not be consulted for tool '${toolName}' ` +
            `(consequential mutations fail closed)`,
        );
      }

      // T-1384: export this session's identity for the command that is about
      // to run. The canonical CLI writes it beside the claim as a salted
      // digest, which is the only way a later window can be told apart from
      // the owner returning -- BOARD's `owner` is a NAME, and a name is not a
      // process. Set per event, from THIS event's own sessionID, immediately
      // before the tool executes, the same way and for the same reason this
      // adapter already puts the installed `bin/` on PATH (T-1318 AC-05).
      // A session the host did not name clears the value rather than leaving
      // the previous one: a stale identity would be a false witness.
      const hostSession = input && input.sessionID;
      if (hostSession) process.env.SAIPEN_HOST_SESSION = String(hostSession);
      else delete process.env.SAIPEN_HOST_SESSION;
      const payload = JSON.stringify(
        buildEvent(context, toolName, args, {
          actor: launchActor,
          sessionId: hostSession,
          cwd: eventCwd,
        }),
      );
      if (Buffer.byteLength(payload, "utf8") > MAX_EVENT_BYTES) {
        throw new Error("SAIPEN_GUARD_EVENT_OVERFLOW: tool input exceeds the bounded guard event size");
      }
      const result = await runGuard(pythonBin, saipenPy, payload, eventCwd);
      const verdict = decide(result);
      const guardPayload = parseGuardPayload(result);
      // Intrinsically forbidden effects and asserted binding conflicts keep
      // their exact guard refusal. Recovery cannot make such payloads safe.
      const terminalGuardCodes = new Set([
        "PROTECTED_CANONICAL_NAMESPACE", "PATH_ESCAPES_PROJECT", "TARGET_UNRESOLVED",
        "PROJECT_BINDING_INVALID", "PROJECT_LINEAGE_MISMATCH", "OWNERSHIP_CONFLICT",
      ]);
      if (verdict.block && terminalGuardCodes.has(verdict.code)) {
        throw guardRefusal(verdict, guardPayload, toolName, args);
      }
      // Fleet owns classification and the single canonical recovery attempt.
      // A repaired project NEVER receives this old tool payload: the hook
      // refuses it and the model must issue a fresh action against current bytes.
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const canonicalVerb = guardPayload && guardPayload.event && guardPayload.event.saipen_verb;
      if (/^saipen fleet (?:preflight|scan)(?:\s|$)/.test(command) &&
          canonicalVerb !== "fleet") {
        throw new Error(
          "SAIPEN_GUARD_REFUSAL: FLEET_INSPECTION_UNTRUSTED: the host tool did not execute",
        );
      }
      // T-1363 / CMD-EFFECT-01: the CANONICAL owner decides whether this
      // effect needs Fleet preparation. This adapter used to keep its own
      // answer -- a hard-coded list of `recover`, `ticket compact T-###` and
      // `fleet preflight|scan` -- and ran Fleet (which can execute `saipen
      // recover`) for everything else. Python meanwhile classified `status`,
      // `validate`, `--help` and `start` as effects that need nothing. The two
      // taxonomies drifted, and the drift IS the field bug: a read probe paid
      // the project's recovery debt and a new user request was unreachable
      // behind old debt. There is now ONE table, in REGISTRY.json, and the
      // guard event carries its verdict. A missing or non-boolean value is a
      // guard that did not answer, so it fails closed onto the Fleet path.
      const effect = guardPayload && guardPayload.event ? guardPayload.event : null;
      const fleetPreflight =
        effect && typeof effect.fleet_preflight === "boolean" ? effect.fleet_preflight : true;
      if (fleetPreflight) {
        const fleetResult = await runFleetPrepare(
          pythonBin, saipenPy, bootstrapBinding, eventCwd, attemptedCondition,
          /^saipen(?:\s|$)/.test(command),
        );
        const fleet = parseGuardPayload(fleetResult);
        if (!fleet || typeof fleet.classification !== "string" ||
            typeof fleet.code !== "string" || typeof fleet.requires_reissue !== "boolean") {
          throw new Error("SAIPEN_FLEET_REFUSAL: FLEET_OUTPUT_INVALID: the host tool did not execute");
        }
        if (typeof fleet.attempted_condition === "string") {
          attemptedCondition = fleet.attempted_condition;
        }
        if (fleet.requires_reissue) {
          throw new Error(
            `SAIPEN_FLEET_REFUSAL: ${fleet.code}: the host tool did not execute. ` +
            "Reread current canonical STATE/BOARD/LOG, reroute once, then issue a fresh " +
            "consequential action against current project bytes.",
          );
        }
        // T-1354. A project condition is not a licence to stop the agent.
        //
        // This used to continue only on BOUND_VALID/NON_SAIPEN, so ANY
        // recovery classification became a process-wide execution ban: a live
        // OpenCode session in a project whose only unresolved fact was one
        // 2026-09-02 ticket could read, glob and grep indefinitely and do
        // nothing else -- including writing an unrelated file under
        // V:\_TEMP_. It is permanent in two ways: an operator-only condition
        // cannot clear itself, and an automatable one whose repair can never
        // succeed keeps the ban too.
        //
        // The ban was also redundant. Asked about the SAME blocked project,
        // `evaluate_admission` already answers per operation and already
        // refuses the minimum unsafe one -- protected canonical paths, another
        // project's canonical state, recovery debt, invalid protocol state, no
        // active Work. That verdict is computed above and is thrown on right
        // below. What this gate adds, and keeps, is the part admission cannot
        // see: a stale payload (`requires_reissue`, above) and an identity that
        // does not resolve at all.
        //
        // Closed set, so an unrecognised classification still fails closed.
        const CONTINUE_ON = [
          "BOUND_VALID",
          "NON_SAIPEN",
          "BOUND_RECOVERY_REQUIRED_SAFE",
          "BOUND_RECOVERY_REQUIRED_BLOCKED",
        ];
        if (!CONTINUE_ON.includes(fleet.classification)) {
          throw new Error(
            `SAIPEN_FLEET_REFUSAL: ${verdict.block ? verdict.code : fleet.reason_code}: ` +
            `the host tool did not execute (${fleet.code}: ` +
            `${typeof fleet.reason === "string" ? fleet.reason.slice(0, 512) : "blocked"})`,
          );
        }
      }
      if (verdict.block) {
        throw guardRefusal(verdict, guardPayload, toolName, args);
      }
      // T-1446 AUTO_KICK: an admitted canonical SAIPEN command is the moment
      // the latest user message entered execution. From here on that message
      // is HISTORICAL ingress: evidence of a started execution, never a new
      // question for a replacement model to reinterpret.
      if (SAIPEN_COMMAND_RE.test(command)) consumeIngress(sessionMemory(hostSession));
    },
  };
};

export default SaipenGuard;
// OpenCode invokes every module export as a plugin factory. Helpers MUST
// remain private; exporting buildEvent installs an invalid event handler.
