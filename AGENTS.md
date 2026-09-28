# ZAICODE agent entry

This workspace runs under SAIPEN from the first response. Treat
`.saipen/STATE.md`, `.saipen/BOARD.md`, and `.saipen/LOG.md` in this root as the
canonical project state; conversation memory and this file do not override them.

Before any user-facing response, resolve `saipen_home` from the canonical
STATE and read its `saipen/STYLE.md` and `saipen/EXECUTION.md`. Follow that
installation's `saipen/BOOT.md` for routing and its installed `saipen` skill
for execution. A new actionable request enters through `saipen start`; `cc`
and `saipen continue` execute the returned `load_path` and `action` in the
same turn. Do not stop at a phase boundary while SAIPEN reports eligible
autonomous work.

The `zcode/` product is a separate Git repository. Preserve its own changes
and the current SAIPEN ticket owner when working across the workspace.
