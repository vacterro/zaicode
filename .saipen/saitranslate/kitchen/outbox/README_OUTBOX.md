# ZAICODE translation outbox

**v0.0.2**

Release surface for translations that passed review and are waiting for
admission. An outbox entry is finished work with one step left to run: the
collector that moves it into the shipping catalogue.

## What lives here

| File | Role |
| --- | --- |
| `<locale>.b<NNNN>.txt` | The rendered translation, ready to read. |
| `<locale>.b<NNNN>.json` | The same translation with its key map and token integrity record. |
| `<locale>.b<NNNN>.done.json` | The admission receipt — what the collector actually took. |

## Rules

- **A batch is all-or-nothing.** The `.done.json` receipt records the batch that
  was admitted; a half-admitted batch leaves the shipping catalogue with
  strings from two different reviews.
- **An outbox entry is immutable.** Fixing a translation means producing a new
  batch, never editing an existing one — the receipt would then describe bytes
  that never existed.
- **Token integrity is verified before the receipt is written.** A `.json`
  without a matching `.done.json` is pending, not shipped.

See the repository root [README.md](../../../README.md) for the full project.