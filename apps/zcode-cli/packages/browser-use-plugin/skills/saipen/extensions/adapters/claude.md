# Claude adapter (Claude Code / claude.ai)

- Skill route: `~/.claude/skills/saipen/` junction carries SKILL.md ->
  RFC.md automatically; nothing extra needed.
- Plain chat without skills? Paste:
  `Read <clone>/saipen/BOOT.md first (cold-start kernel), then <clone>/saipen/BOOT.md + INDEX.md then CORE.md + STYLE.md on demand and follow them.`
- Write repo files with editor tools, never shell redirects -- BOM risk.
- Native todo lists mirror `.saipen/BOARD.md`, never replace it.

Everything else: follow the BOOT/INDEX/CORE loading contract in `saipen/INDEX.md`.
