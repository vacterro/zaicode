# schemas/ -- state.schema.json is live, the rest reference

JSON Schemas for STATE/BOARD/LOG/OUTBOX. `state.schema.json` is machine-read:
`tools/validate.py` (the canonical validator, v7.24.0) checks STATE.md's
frontmatter against it directly -- required fields, enums, types. Editing
that schema changes what validation enforces; it is the single source of
truth for STATE's field list, keep it in lockstep with RFC.md § 1.2. This
includes every subSaipen's own `STATE.md` (v7.49.0) -- `tools/validate.py`
checks those against this same schema too, plus a couple of subSaipen-only
policy checks (`mode: read-only`, no write-requiring `phase`) layered on
top, never a separate restricted copy of the schema itself.

`board.schema.json` / `log.schema.json` / `outbox.schema.json` remain
descriptive reference only (they describe a parsed representation; the
validator checks the raw Markdown grammar natively, and OUTBOX.md isn't
checked at all yet). Do not extend them speculatively -- the Markdown
files in `templates/` and `extensions/subs/PROTOCOL.md` § 2 are the living
spec for these three.
