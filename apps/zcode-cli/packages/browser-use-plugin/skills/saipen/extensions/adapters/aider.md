# Aider adapter

- `~/.aider.conf.yml` `read:` auto-loads BOOT.md + INDEX.md every session
  (injector writes it).
- Aider auto-commits: keep its commits, but SHIP versioning/tagging still
  follows the protocol, not aider defaults.

Boot order: read `saipen/BOOT.md` first -- the cold-start kernel is all a
bare `saipen continue` needs. `saipen/BOOT/INDEX/CORE chain` is the constitution, reached
only when a rule question comes up. `saipen/STYLE.md` is a boot-read: apply it before any output.
Everything else: follow the BOOT/INDEX/CORE loading contract in `saipen/INDEX.md`.
