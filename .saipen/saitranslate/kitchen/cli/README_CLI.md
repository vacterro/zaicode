# ZAICODE CLI strings

**v0.0.2**

Release surface for the `zcode` command-line interface. This directory is the
translation kitchen subtree for every user-visible string the CLI prints —
`zcode --help`, the per-command usage blocks, option descriptions and error
messages.

## What lives here

| File | Role |
| --- | --- |
| `manifest.json` | The extracted catalogue: every segment key, its exact source range and the protected tokens it contains. |
| `source.json` | The source digest this manifest was extracted from. |
| `state.json` | Per-locale progress through the catalogue. |
| `drafts/` | In-progress translations. |
| `outbox/` | Reviewed translations ready for admission. |

## Rules that must survive translation

- **Protected tokens are opaque.** `{expression0}`, `{protected7}` and
  `__MSG_0__` are bound to runtime values. Translate around them, never inside
  them, never reorder them across a sentence boundary, never drop one.
- **Placeholders keep their names.** `{protectedN}` is positional; the number
  is part of the contract with the calling code, not a counter to renumber.
- **Option names are not translated.** `--locale`, `--surface`,
  `--permission` and every other flag stay exactly as written.
- **A dropped token is a broken build**, not a style choice. The repair-key
  files in the sibling `docs/` subtree record which keys lost which tokens.

See the repository root [README.md](../../../README.md) for the full project.