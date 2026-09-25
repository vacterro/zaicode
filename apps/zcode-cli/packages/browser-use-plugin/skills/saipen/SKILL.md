---
name: saipen
description: >
  SAIPEN (v7). Autonomous protocol. Trigger on "saipen set", "saipen",
  subcommands, and shortcuts (gg, hh, ff, xx, vv, zz, cc, ccc, st, sss, dd,
  aa, qq, qqq, ee, eee, pp, tt, sc; Cyrillic twins: сс, ссс, аа, ее, еее,
  рр, хх). Cold-start kernel loads first; phases modules load on demand per
  STATE. CORE.md is constitution; persistent .saipen/ memory continues work.
  Reply language: STYLE.md reply_language (default et; en/ru/auto). Voice:
  caveman-дед until "stop caveman" or "normal mode". Protocol dir is this
  skill's directory; project memory is <project_root>/.saipen/.
---

# saipen -- skill adapter

**`saipen continue`, bare `saipen`, `cc` and `сс` mean EXECUTE the current
work. Loading this skill only returns instructions; it does not run Git,
inspect the project, or complete a command.** After loading it, follow BOOT,
run `saipen continue --json`, read the returned `load_path` and project memory,
and perform the returned action in this turn. Do not ask what `continue`
means, repeat this skill call, or stop at "state not checked": read that state.
Only an observed refusal or a canonical WAIT can justify a blocked report;
include its exact evidence and take available safe recovery first.

Thin entry for skill-reading platforms. The system lives elsewhere:

0. **Resolve the cold route deterministically -- never by searching.** Run the
   installed launcher (`saipen status --json`) and read its `cold_route`
   block. It names the bound `project_root`, `protocol_dir`, `boot`, `style`,
   `phase_module` and the `.saipen/` memory files, and states
   `search_required: false`. Open those exact paths. Do NOT use the host's
   grep/glob/search tool to locate protocol files, and never conclude that
   protocol startup failed because a host search tool errored: a ripgrep or
   search fault is a HOST fault, unrelated to SAIPEN. If the launcher itself
   is unavailable, read `BOOT.md` and the documents beside this SKILL.md by
   their known paths -- still without searching.

   When a search IS genuinely needed and the host's own search tool returns a
   transport error (never for zero matches -- that is a normal empty result),
   use the canonical read-only fallback `saipen search --hex
   <hex-encoded-utf8>`. It needs no generic shell admission, so it still works
   while the protocol state is invalid. Do not fall back to `grep`/`bash`.

1. **Read `BOOT.md`** (the file in the same folder as this SKILL.md) -- the
   compact cold-start kernel: STATE -> BOARD -> LOG tail -> execute
   `next_action`. That is everything a bare `saipen continue` needs. **Read it
   once; this list names it once.**
2. **`BOOT.md` loads `STYLE.md` before any output** -- voice governs the first
   token, so the kernel's own step 1 opens it. Nothing here overrides that
   order.
3. **Rule question? Route through `INDEX.md`** (same folder), the document map.
4. **`CORE.md` only for the exact rule you looked up.** It is the constitution;
   do not read it speculatively.
5. **`RFC.md` is a compatibility redirect and nothing else.** It holds no
   rules, it is not a destination, and no step above sends you there.
6. **Phase modules in `phases/`** (same folder) -- loaded by boot per STATE.md
   phase.
7. UI work: also read `UI.md` (Win95 dark golden, Verdana, no AA).

Platform notes:
- Native task lists mirror `.saipen/BOARD.md`, never replace it.
- `<project_root>/.saipen/` remains the only project memory/checkpoint area.
  Global USERPERSON lives in the deterministic user-configuration directory
  (`SAIPEN_USER_CONFIG_HOME` override or platform default), never in `.saipen/`
  or `saipen_home`; it cannot bootstrap or become an ancestor project root.
- Prefer file tools over shell redirects -- UTF-8 no BOM.
- CORE.md decides. No rule here overrides it.
