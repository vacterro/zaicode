# SAIPEN Adaptive Runtime

This document owns runtime identity/capability semantics. CORE still owns Work,
state, commands, precedence, checkpointing, and completion. Runtime data is
replaceable session telemetry; it cannot make project truth provider-specific.

## Host bootstrap / runtime binding

A host that opens a SAIPEN-managed project must reach a canonical runtime before
it does ordinary work. One read-only operation answers that:

    saipen host bootstrap [--host <registry-id>] [--project-root PATH] [--json]

It resolves the binding in this order and never scans disks or guesses a path:

1. project binding -- `.saipen/` present, or an asserted carrier verifies;
2. a canonical `saipen` already resolves on PATH (reported, never trusted as
   the binding);
3. a SAIPEN-controlled pointer to the install -- the project's own
   `STATE.saipen_home` or an exported `SAIPEN_SKILL_ROOT` carrier;
4. the executing engine itself, which IS a canonical runtime.

`HOST_BOOTSTRAP_BOUND` is the only green code. Otherwise the single stable
diagnostic `SAIPEN_HOST_RUNTIME_UNAVAILABLE` names the exact unsupported
boundary (`project_binding`, `activation_contract`, `canonical_runtime`,
`direct_entrypoint`, `host_bridge`), the attempted candidates, and the
remediation. A diagnostic carries a `fingerprint` so a host suppresses repeated
output when nothing changed.

Three verdicts are never merged. **Runtime discovered** is what the resolver
proved from a candidate's own bytes; **host admitted** requires an explicit
`--host` to be a registered adapter, otherwise the verdict is
`HOST_UNSUPPORTED` with `ok: false` and the discovery kept as diagnostic data
under `runtime_discovered`/`runtime_boundary`; **transport reachable** is a
launcher discovery question, and only an executable launcher (POSIX `+x`, or a
Windows `.cmd` shim) or a `saipen` on PATH counts as one. This resolver probes
no cross-boundary transport: a file path inside another execution boundary is
never claimed as a bridge (`bridge.cross_boundary` is always false).

Fail-closed writes: a project whose absolute `STATE.saipen_home` does not
resolve to a usable SAIPEN install on this host refuses consequential mutation
(`HOME_REQUIRED`) at the same admission gate every other protocol brake uses.
Canonical operations and diagnostic reads stay available, so recovery is never
wedged.

The refusal is never a dead end when SAIPEN already proved a replacement:
`saipen rebind-home --auto` converges a DEAD persisted pointer onto the
already-PROVEN canonical runtime (the executing engine, or a verified installed
carrier -- never a scanned or guessed path), journaled as
`HOST_BINDING_CONVERGED` with the previous pointer in LOG evidence. It is
idempotent (`HOME_ALREADY_BOUND`, zero writes, on a live pointer) and refuses
`HOME_REQUIRED` naming the explicit form only when NO replacement proves. Both
`cc` and `start` run the same convergence before their ordinary work, so a
fresh supported host reaches canonical continue with no operator-supplied
runtime path. The explicit `saipen rebind-home <candidate>` remains the route
when the operator names an install the resolver cannot prove by itself. A host
with no before-tool hook surface (its `declared_strength` is ADVISORY) is
reported as such -- the resolver never claims enforcement an install cannot
provide.

`saipen host activation --project-root PATH` answers the narrower question --
does the MANAGED PROJECT's resolved runtime carry the canonical activation
contract (`ACTIVATION_PRESENT`). The argument is the project root (the thing
carrying `.saipen/`), never the install home: a flattened/installed runtime
home has no `.saipen/` of its own and must still answer green.

## Turn entry — AUTO_RECALL / AUTO_KICK (T-1446)

The agent is disposable; the execution is not. A host may replace the model,
provider or session in the middle of Work (a routed model pool does this
between two requests). The successor has no private memory, but it still sees
the old conversation, including the `cc` that started the mission.

    saipen autonomy recall [--carrier-json JSON | --carrier-hex HEX] [--directive] [--json]

is a read-only projection over STATE/BOARD/LOG plus a host carrier
(`host`, `host_session`, `provider`, `model`, `previous_incarnation`, `cold`,
`ingress: {id, text, consumed}`). It answers:

- `execution_epoch` -- anchored on the LOG event that claimed the Work, never
  on `claim_time` (checkpoints refresh that lease). A model or session change
  writes no claim event, so it cannot move the epoch;
- `agent_incarnation` -- the physical actor; `replacement_detected` reports a
  session change against `claim_session`, a model change against the previous
  incarnation, or a cold successor;
- the active Work, phase, last event and checkpoint, claim, lease, blocker,
  due gates, canonical next action and `exact_resume_command`;
- ONE turn-entry decision, in this order: `RECOVER` (unreadable state or
  pending recovery) > `USER_INPUT` (a genuinely new, unconsumed message) >
  `OPERATOR_WAIT` > `AUTO_KICK` (active executable DOING Work) >
  `RUN_CONTINUE` (the message is `cc`, old or new) > `ORDINARY`.

A kick decision means: run `saipen continue --json` before any conversational
text. A message becomes HISTORICAL only when the host saw an admitted canonical
`saipen` command after it; message identity comes from the host, never from
prose similarity, and unreadable input stays NEW. The directive a host injects
carries only closed-grammar fields, so project text never becomes system
instruction (P0-1).

Host seams. OpenCode: `saipen-guard.js` runs the recall in
`experimental.chat.system.transform`, which fires before EVERY model request,
takes message identity from `chat.message`, and marks consumption in
`tool.execute.before`. Hosts without a per-request hook get the rule only as
instruction text, which is not a recovery mechanism; that gap is an external
host boundary, not a solved case.

## Unattended execution owner (T-1446)

`supervisor.decide` names ONE verdict; `worker.supervise` acts on it. From
`<saipen_home>/tools`:

    python -m saipen_engine.worker supervise --project-root P \
        --agent-json '["opencode","run","--model","{model}","cc"]' \
        --model M [--fallback-model M2 ...] [--max-cycles N] \
        [--slice-timeout IDLE_S] [--max-slice-seconds HOST_S]

Each cycle: decide; stop cleanly on IDLE, OPERATOR_ACTION_DUE,
NO_PROGRESS_LOOP or AMBIGUOUS_AUTHORITY; await (never steal) a HEALTHY or
SUSPECT foreign lease; otherwise take ONE lease generation, launch the agent
host, heartbeat the lease for it while it lives, kill it on freeze or on an
outside fence, then fence the finished generation so nothing it still does can
mutate. QUALITY-TIME-01: `--slice-timeout` is the IDLE bound -- time without
durable canonical progress (STATE last_event/phase/task/next_action/blocker)
-- and every progress restarts it; `--max-slice-seconds` (default 4x) is the
host bound, and a progressing generation that reaches it ends SLICE_BOUNDED,
not failed: the next generation continues the same epoch. A fence takes
effect when written: a fenced generation reads EXPIRED, fails
`mutation_allowed` and cannot heartbeat itself back.

Failures use one closed vocabulary (`supervisor.FAILURE_CLASSES`): WORKER_CRASH
and HOST_RUNTIME_FAILURE replace the generation; RATE_LIMITED,
PROVIDER_UNAVAILABLE and NETWORK_UNAVAILABLE back off and retry;
QUOTA_EXHAUSTED and MODEL_UNAVAILABLE move to the next model ONLY from the
operator's `--fallback-model` list, otherwise stop with an operator action;
AUTH_FAILED always stops; UNKNOWN stops after a repeat. A class is read only
from error channels (stderr, non-JSON stdout, JSON error events), never from
the agent's own transcript; a silent nonzero exit is WORKER_CRASH. CAPABILITY_UNAVAILABLE
(an absent host, or a runtime without tools) is never read as reasoning
failure: it moves only to an authorized runtime, else stops as a truthful
blocker. Model identity lives in the runtime cache checkpoint, never in
STATE/BOARD/LOG. No failure writes
canonical state: Work, Source, checkpoint and epoch survive every class, and
only the agent incarnation changes.

## Wave 1 — identity and capabilities

`agent != model`. `--agent <id>` selects the acting SAIPEN seat and participates
in ownership/handover. It never identifies a provider or model. The read-only
projection is:

```text
saipen runtime [--runtime-info <json-file>] [--json]
```

Runtime metadata source precedence is explicit `--runtime-info`, then the
documented `SAIPEN_RUNTIME_INFO` JSON-file path, then UNKNOWN. No model/provider
is guessed from prose, the seat name, or the running executable. Metadata is
read once, bounded to 64 KiB, strict UTF-8 JSON, and must be a regular
non-symlink/non-reparse file. It is never persisted into STATE, BOARD, LOG, a
cache, or a handover.

Schema version 1 accepts optional `harness`, `provider`, `model`, `variant`, and
`capabilities`. Identity values are bounded strings or null. Capability values
are `true`, `false`, or null; absent values render as null (UNKNOWN):

```json
{
  "schema_version": 1,
  "harness": "opencode",
  "provider": "openai",
  "model": "example-model",
  "variant": "high",
  "capabilities": {
    "shell": true,
    "parallel_subagents": null,
    "structured_output": true
  }
}
```

The bounded capability vocabulary is operational: `shell`, `filesystem`,
`patch`, `browser`, `web`, `subagents`, `parallel_subagents`, `skills`, `mcp`,
`structured_output`, `persistent_session`, `context_compaction`,
`reasoning_effort`, `tool_search`, `programmatic_tool_calling`. It contains no
personality claims. A runtime document may not define `agent`.

## Wave 2 — executable task classes, strategies and context budgets

Wave 2 turns the strategy vocabulary into ONE deterministic decision instead of
prose. The read-only surface is:

```text
saipen runtime [--task-class IMPLEMENT|REPAIR|VERIFY|RESEARCH|AUDIT|MAINTENANCE]
              [--helper-reason isolated-research|independent-verification|
                              noisy-investigation|genuinely-parallel]
              [--control-plane] [--runtime-info <json-file>] [--json]
```

A task class describes the WORK, never a vendor, provider, model or seat, and
no strategy decision is ever persisted into STATE, BOARD, LOG, a cache, or a
handover. An out-of-vocabulary task class or helper reason is REFUSED
(`VALIDATION_FAILED`, zero writes); it is never coerced into the default.

The bounded strategy vocabulary is:

| strategy | reached from | helper ceiling | context class |
|---|---|---|---|
| `LONG_BUILD` | `IMPLEMENT`, `MAINTENANCE`, ordinary `REPAIR` | 0 by default | `ORDINARY` |
| `BOUNDED_RESEARCH` | `RESEARCH` | 1 ephemeral scout | `MINIMAL` |
| `VERIFY_ONLY` | `VERIFY`, `AUDIT` | 0, or 1 independent verifier | `BOUNDED` |
| `RECOVERY` | `REPAIR --control-plane` | 0 | `RECOVERY` |

`LONG_BUILD` is the DEFAULT. Ordinary implementation is one primary worker and
ZERO helpers: the expected topology is `parent 1 / subagents 0`. A helper needs
a concrete reason from the bounded list above; "more agents might be faster" is
deliberately absent, so an unnamed reason buys no helper at all. The highest
ceiling any justification buys is 2. Protocol/control-plane repair is RECOVERY
only when it is declared; it is never inferred from an ordinary repair.

Helper policy facts, stated exactly as far as they are enforced: recursion is
DENIED BY POLICY (`max_subagent_depth = 1`), while the host ENFORCEMENT of that
depth is reported `UNKNOWN`, because the capability vocabulary exposes no depth
control. A child never inherits the accumulated parent transcript: a child
packet carries only the objective, the relevant acceptance criteria, the
necessary paths, known evidence, explicit constraints, the small excerpts
needed to work, and the requested result format, and it is bounded by
`child_packet_ceiling_bytes`. A child RETURNS only the conclusion, the evidence,
changed paths, the focused test result, the unresolved blocker and the next
action. Research/scout and one-shot reviewer helpers are ephemeral; only the
primary implementation worker keeps continuity.

Context economy is bounded the same way for noisy deterministic commands: the
full output is saved ONCE as durable evidence, and only the command, exit code,
failure count, the relevant failures, a bounded tail and the artifact path are
returned to the model. Expensive validators are re-run at meaningful boundaries
after the relevant inputs change, not after every small edit.

Progress is judged by DURABLE progress — a repository diff, an acceptance
clause moved to VERIFIED, a new focused regression turning green, a blocker
narrowed by new evidence, a canonical checkpoint advanced, or a state
contradiction removed — never by model prose. Several expensive cycles without
durable progress trigger checkpoint/investigation-method change, NOT more
workers, and budget exhaustion is always reported as `PAUSED_BUDGET`; it is
never reported as DONE.

## Installed-runtime freshness (prelaunch)

A SAIPEN-managed host loads an INSTALLED runtime, not the canonical clone. The
installed generation is therefore protocol state, and proving it is SAIPEN's
job, never the operator's: comparing hashes by hand and re-running an injector
is not a supported workflow.

One operation owns it:

    saipen runtime --prelaunch --adapter <registry-id> [--no-resync] [--json]

It is install-scoped, so it runs OUTSIDE a bound project -- a stale runtime is
exactly the condition in which no project can be resolved yet.

Consumer contract, stable and machine-readable:

| `code` | meaning | may a host start? |
|--------|---------|-------------------|
| `RUNTIME_CURRENT` | installed generation already matches canonical; nothing was written | yes |
| `RUNTIME_RESYNCED` | installed generation was stale and the canonical installer restored it; verified | yes |
| `RUNTIME_STALE` | stale, and `--no-resync` was requested | no |
| `RUNTIME_RESYNC_FAILED` | the installer did not run, failed, or left a surface that still differs | no |
| `CANONICAL_RUNTIME_SOURCE_UNPROVEN` | no provenance marker and the executing tree fails the architecture proof, or the canonical shipped surface cannot be proven (nothing is installed from it) | no |
| `HOST_UNIDENTIFIED` | no adapter named and none inferable from provenance | no |

`ok` is true exactly for the two green codes. `requires_host_restart` is true
exactly when bytes changed, and the only honest consumer of that flag is a
launcher that starts the host AFTER the call: a loaded plugin is never
hot-replaced and a running process never changes generation in place.

Evidence carried on every result: `canonical_fingerprint`,
`installed_fingerprint`, `fingerprint_match`, `marker_fingerprint`,
`engine_diff`, `hook_problems`, `launcher_problems`, `provenance_problems`.
Freshness covers the ENGINE surface, the blocking guard plugin, the installed
`bin/` launchers (which must name the INSTALLED `tools/saipen.py`, never the
clone) and the installer-written provenance marker.

Both fingerprints are the ONE shipped-runtime generation identity
(`tools/saipen_engine/runtime_surface.py`): every `copy_trees` member and
required `files` entry of `MANIFEST.json`, LF-normalised text and byte-exact
binary, source and flattened layouts under one logical name. Each side is
digested over its OWN declared inventory, so an extra module in an installed
engine is a different generation, and `fingerprint_match` is the verdict --
`engine_diff` only names the files. The marker's `runtime_fingerprint` must be
that same canonical identity; a stamp or marker written into a tree never
proves the tree. The distribution report (`saipen status`) applies the same
rule: a home is current only when the bytes it holds, the engine its guard
hook delegates to, and the home its instruction block names all prove the
source's generation -- a matching stamp or Git head is provenance, not proof.

Authority is proven, never guessed, and PATH is never identity: the installer's
`.saipen_runtime.json` marker first, otherwise the executing tree when it
passes the shipped architecture proof -- and a canonical clone serves every
host, so it requires `--adapter` rather than inferring one.

The supported explicit launch (`saipen --agent <seat> launch <host>`) invokes
this before starting the host and refuses the launch on any non-green code, so
an ordinary session never reaches an unproven runtime. A host already running
when its installed bytes change is still refused per-tool with
`PLUGIN_RESTART_REQUIRED`; that refusal names a restart, not an injector.

## Staged delivery

Wave 1 supplies truthful identity/capability discovery. Wave 2 supplies the
executable strategy/context economy above. Neither claims a speed, quality,
token, or cost improvement.

1. Wave 3 adds thin OpenCode, Codex, Antigravity, and Claude Code adapters that
   map supported capabilities without copying Core semantics.
2. Wave 4 adds representative evaluations, telemetry, configuration comparison,
   and harness ablations.
3. Wave 5 permits explainable adaptive routing only from measured evidence.

Until those waves land, no strategy/model/evaluator recommendation is inferred.
Adapters must preserve UNKNOWN when the harness cannot establish a fact, must
not fake unsupported reasoning controls, and must keep canonical project state
portable across provider/model switches.
