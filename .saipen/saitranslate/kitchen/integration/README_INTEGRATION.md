# ZAICODE integration strings

**v0.0.2**

Release surface for strings that cross a module boundary — messages that the
backend produces and the UI renders, or that the UI produces and the CLI
prints. These are the strings most often broken by a partial refactor, because
the producer and the consumer are edited in separate commits.

## What lives here

| Path | Role |
| --- | --- |
| `manifest.json` | The extracted catalogue, keyed by the boundary each string crosses. |
| `packages/` | Catalogue shards, one per owning package. |
| `apps/` | Catalogue shards, one per app entry point. |

## Rules that must survive translation

- **The key is the contract.** The string key, not the English text, is what
  both sides of the boundary agree on. Renaming a key in one package breaks the
  other.
- **Payload field names are not translated.** A JSON body, a protocol envelope
  field and a menu action id are read by code.
- **A fallback string is not a translation.** If the producer has no catalogue
  entry, the UI shows the raw key — that is a missing catalogue entry, and it
  belongs in the defect queue.

See the repository root [README.md](../../../README.md) for the full project.