# OpenCode adapter

- Skill route: `~/.config/opencode/skills/saipen/` copy (injector) --
  SKILL.md -> BOOT.md is the cold-start kernel.
- Global `~/.config/opencode/AGENTS.md` also carries the saipen block.
- Enforcement: BLOCKING via the installed guard plugin. The injector
  installs `~/.config/opencode/plugins/saipen-guard.js` -- the PLURAL global
  local plugin directory the supported runtime discovers (verified against
  OpenCode 1.18.x: `opencode debug config` reports the file as a global
  plugin origin and instantiates its factory). The singular legacy surface
  `~/.config/opencode/plugin/saipen-guard.js` is ALSO discovered by that
  runtime, so the injectors delete a stale copy of it on install and the
  uninstaller removes both: the hook must never load twice.
  Shipped artifact: `extensions/adapters/opencode/saipen-guard.js`.
  On every consequential tool call the plugin reads the tool from
  `input.tool` and its mutable arguments from `output.args`, then sends one
  bounded JSON event
  (`event`/`host`/`cwd`/`tool_name`/`tool_input`/`actor`/`session_id`) to
  `python <skill>/tools/saipen.py guard --event-json - --json`:
  - exit 0 -> the tool proceeds;
  - nonzero exit -> the plugin throws, so the tool does not execute;
  - guard failure, invalid output, unreadable `output.args` or no Python
    runtime -> fail closed for consequential mutations (verified built-in
    read-only tools skip the round trip and stay usable).
   Actor identity: an OpenCode session id is diagnostic only and is never a
   SAIPEN actor. `SAIPEN_AGENT` is an optional explicit actor/provenance carrier,
   not authentication. When it exists, the plugin forwards it and Core checks it
   against canonical ownership. The executing host identity is never a seat: the
   explicit launcher refuses a seat that names the host it is launching, so a
   host name can never be injected as project-seat authority. When absent in a
   valid SAIPEN project, the
   existing protocol snapshot inherits `STATE.agent` and runs the same ownership,
   recovery, protected-path and operation-safety checks.
  The optional explicit launcher is:
  `python ~/.config/opencode/skills/saipen/tools/saipen.py --agent <seat>
  launch opencode -- [OpenCode arguments]` (or the equivalent `saipen` CLI
  alias when installed).
  Explicit-envelope callers reuse `tools/saipen_engine/host_launch.py`; routine
  generic OpenCode launches do not need this path or a manual seat.
  The adapter never re-implements a protocol rule: multi-file patches, move
  endpoints, canonical-operation recognition and ownership are decided by the
  guard from the forwarded payload.
  The guard preflight refuses ordinary shell commands with an explicit
  `.saipen` namespace reference (quoted, Windows/POSIX separators, or simple
  traversal), while ordinary development shell commands and exact standalone
  `saipen <verb>` operations remain usable. It cannot prove targets hidden by
  dynamically computed or deliberately obfuscated arbitrary code; this is a
  reliability barrier, not an OS sandbox. The exact built-in `question` tool
  is non-mutating and remains usable during guard-runtime failure. Guard child
  execution uses bounded asynchronous I/O and reports a process error code
  when unreachable.
  The exact built-in `task` tool is admitted as consequential delegation only
  after normal state/actor/recovery checks. In the supported native runtime,
  its child session's source write succeeds and protected STATE/BOARD tool
  calls hit the same guard and are refused. This does not grant unknown or
  namespaced task-like tools a bypass; other runtime versions need their own
  child-hook proof before claiming the same boundary.
  Uninstall is deleting exactly `saipen-guard.js` (both surfaces); re-install
  is an overwrite, so unrelated plugins and configuration are never touched.
- Freshness: the registry declares this hook on the
  `freshness_surfaces` list, so `autoinject`/status compare the installed
  file against the shipped artifact; installed-but-unreadable reads UNKNOWN,
  never fresh. The injectors overwrite the plural artifact, remove the exact
  singular legacy copy, verify the installed SHA-256 equals the shipped file,
  and print the installed digest and restart requirement. `opencode debug
  config` must report exactly one SAIPEN hook origin. The factory records a
  bounded JSON diagnostic in the OS temp root named
  `saipen-opencode-guard-active-<pid>.json` while its process runs; an optional
  `SAIPEN_GUARD_STARTUP_PROBE` appends the same diagnostic for native smoke.
  It includes the build id, hash captured at module evaluation, loaded module
  path, skill root, and guard runtime path. A new OpenCode process started
  after installation must report that hash equal to the installed artifact.
  OpenCode does not hot-reload already imported plugin modules in the tested
  runtime; restart existing windows to deploy the new generation. A hook
  carrying this freshness check reports `PLUGIN_RESTART_REQUIRED` on a later
  consequential call if its loaded hash differs from its current file. Exact
  built-in reads, skill loading, questions and session-local Todo remain usable
  for diagnosis after replacement; namespaced lookalikes gain no exemption.
  The launcher always moves this installation's bin to the front of PATH,
  preserving unrelated entries, so an older launcher cannot win merely because
  the current bin was already present farther down the search path. The bound
  bootstrap instruction points resume commands to `saipen continue --json`
  and then to execution of its returned action (CMD-CONTINUE-01).
  Older generations
  without the check cannot self-diagnose; their processes still need restart.
- Prelaunch freshness: the supported launch
  (`saipen --agent <seat> launch opencode`) proves the installed generation
  through `saipen runtime --prelaunch --adapter opencode` BEFORE the host
  process exists, and resyncs through the canonical injector when it is
  stale, so no operator runs `inject.ps1` or compares hashes for an
  ordinary update. The launch is refused on any non-green prelaunch code
  rather than starting a host on unproven bytes. The factory additionally
  records the read-only verdict as `runtime_generation` in its startup
  diagnostic; it never resyncs from inside a loaded process. Consumer
  contract: `saipen/RUNTIME.md`, "Installed-runtime freshness".

Boot order: read `saipen/BOOT.md` first -- the cold-start kernel is all a
bare `saipen continue` needs. `saipen/BOOT/INDEX/CORE chain` is the constitution, reached
only when a rule question comes up. `saipen/STYLE.md` is a boot-read: apply it before any output.
Everything else: follow the BOOT/INDEX/CORE loading contract in `saipen/INDEX.md`.
