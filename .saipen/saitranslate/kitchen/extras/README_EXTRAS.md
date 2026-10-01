# ZAICODE supplementary strings

**v0.0.2**

Release surface for the user-visible strings that live outside the main product
catalog — the auxiliary surfaces that still have to be translated, reviewed and
shipped with every release.

## What lives here

| File | Role |
| --- | --- |
| `manifest.json` | The extracted catalogue for every source file in this subtree. |
| `source.json` | The source digests the manifest was extracted from. |
| `state.json` | Per-locale progress. |
| `drafts/` | In-progress translations. |
| `outbox/` | Reviewed translations ready for admission. |

## Source files covered

| Source | What it holds |
| --- | --- |
| `zcode/packages/ui/src/i18n/locales/saiasui.ts` | The SAI-ASUI aim-training surface: tempo labels, scoring and combo readouts. |
| `zcode/packages/shared/src/desktopMenu.ts` | Native application menu items and their accelerators. |
| `zcode/packages/ui/src/lib/builtinSkillI18n.ts` | Titles and descriptions of the built-in skills. |

## Rules

- **Protected tokens are opaque.** `{expression0}` and `{protectedN}` bind to
  runtime values; translate around them.
- **Menu accelerators keep their glyphs.** The `&`/`Ctrl`/`Shift` prefix in a
  menu entry is parsed, not displayed — translating it breaks the accelerator.
- **A draft is private until reviewed**, exactly as in `drafts/`.

See the repository root [README.md](../../../README.md) for the full project.