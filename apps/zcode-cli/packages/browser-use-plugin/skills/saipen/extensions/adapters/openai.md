# OpenAI adapter (GPT / Codex-style chat)

- Use Code Interpreter / execution sandbox for VERIFY when available;
  without it, close tickets `conf: low` with MANUAL-VERIFY per protocol.
- Keep `.saipen/` files raw Markdown — no JSON re-encoding.
- No greetings, no apologies; report shape comes from STYLE.md.

Boot order: read `saipen/BOOT.md` first -- the cold-start kernel is all a
bare `saipen continue` needs. `saipen/BOOT/INDEX/CORE chain` is the constitution, reached
only when a rule question comes up. `saipen/STYLE.md` is a boot-read: apply it before any output.
Everything else: follow the BOOT/INDEX/CORE loading contract in `saipen/INDEX.md`.
