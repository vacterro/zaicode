# ZAICODE product documentation strings

**v0.0.2**

Release surface for every user-visible string in the ZAICODE desktop product —
settings labels, dialog copy, empty states, error banners and the Help view.

## What lives here

| File | Role |
| --- | --- |
| `<locale>.json` | The translated catalogue for that locale. |
| `<locale>.review-keys.json` | Segments a reviewer has signed off. |
| `<locale>.reviewed.json` | The frozen review result for that locale. |
| `<locale>.repair-keys.json` | Segments whose protected tokens were lost and must be repaired before admission. |

## Rules that must survive translation

- **Protected tokens are opaque.** `{expression0}`, `{protected7}` and
  `__MSG_0__` are bound to runtime values. Translate around them, never inside
  them.
- **Keyboard hints keep their glyph.** `Ctrl+Shift+P`, `Esc`, `Enter` and every
  arrow mnemonic are labels on real keys; a translated word between the `+`
  signs is a broken shortcut.
- **A repaired segment is not a translated one.** A key listed in
  `<locale>.repair-keys.json` failed token integrity. It is not admissible into
  `<locale>.json` until the token set matches the source exactly.
- **Plural and gendered forms follow the target locale**, not the source
  grammar. The source English carries one form; the catalogue carries the slots
  the target needs.

See the repository root [README.md](../../../README.md) for the full project.