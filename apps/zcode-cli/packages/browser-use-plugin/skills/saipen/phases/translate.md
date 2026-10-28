# Phase: TRANSLATE

## Purpose and entry

Build or refresh the real translation surface inside
`.saipen/saitranslate/`, without mutating main-project files. Enter on
`saipen translate`. A dedicated parallel instance requires an initialized
`.saipen/`; otherwise tell the user to run `saipen set`.

## Isolation

- Main project bytes are read-only inputs. Translation sources, output and
  scratch stay under `.saipen/saitranslate/`; its `kitchen/` is distinct from
  Core's `.saipen/kitchen/`.
- A same-agent phase switch still checkpoints shared STATE/BOARD/LOG through
  CORE's ordinary contract.
- A dedicated parallel instance never writes the shared STATE while working.
  It continues from `.saipen/saitranslate/STATE.md` and writes only its own
  sandbox; shared STATE is reference-only. Its sole shared write is the final
  LOG event.
- Legacy root `.saitranslate/` may be moved once to the canonical location
  with a reference sweep and LOG evidence. If both exist, do not merge or
  guess: ticket the stale copy.

## Translation surface

Read the project and cover both real surfaces when present:

1. User-facing documentation: README and other top-level user documents that
   lack a hand-maintained locale sibling.
2. Actual in-app UI strings, but only when real source/i18n files prove they
   exist. Never invent screens, keys or bundles for a docs-only project.

Hand-maintained locale siblings stay outside TRANSLATE's drift ownership. The
root README mirrors (`README.ee.md`, `README.ded.md`, `README.ja.md`) are the
exception: keep them synchronized with `README.md` and preserve their language
switcher. UI-bearing projects use their existing locale format; docs-first
projects use translated documents. Output always stays in the translation
kitchen until collection.

The complete surface is 32 languages plus the Дед voice. **Six are the default
set, always and everywhere: English, Russian, Estonian, Ukrainian, Japanese,
and Дед.** They must exist and be current; remaining locales may report honest
partial coverage.

Core owns English, Russian, Estonian and Дед, and no bulk translation beyond
them. All other languages, including Japanese and Ukrainian, belong to a
dedicated `saitranslate`/`saiwiki` producer. Core may verify every locale and
must repair encoding/structural corruption, but tickets translation backlog
instead of absorbing it.

The 32 language locales are English, Russian, Estonian, Japanese, Ukrainian,
German, French, Spanish, Italian, Portuguese, Dutch, Polish, Swedish, Danish,
Finnish, Norwegian, Chinese, Korean, Thai, Vietnamese, Arabic, Hebrew,
Turkish, Hindi, Indonesian, Greek, Czech, Romanian, Hungarian, Bulgarian,
Slovak and Croatian. Use Unicode flag emoji as the baseline; use image assets
only when the product already has that asset pipeline. Дед is a STYLE.md voice
translation: terse and blunt but factually exact, never generic Russian.

## Actions and freshness

Every run rescans both real surfaces and compares them with translation-kitchen
output. Translate changed content; do not rebuild unchanged bytes or stamp an
untouched locale as refreshed.

Each translated locale README ends with
`<!-- source-digest: README.md sha256:<16 hex> -->`, computed from current
`README.md` after normalizing every version string to literal `VERSION`.
**Something signals it now, and keeping that signal honest is part of the
pass.** Recompute the marker only for locales actually translated. Version
normalization prevents a release badge bump from faking prose drift.

Before exit, check every discovered surface against every claimed locale.
Missing coverage is an explicit partial result, never rounded up to complete.

## Exit and handoff

A collectable run writes `.saipen/saitranslate/kitchen/OUTBOX.md` with the
PREPARE-owned fields `status`, `producer`, `source_head`, `coverage`,
`payload`, `verified`, `instructions`, including `producer: saitranslate`.
Only complete 32-language plus Дед coverage of every real surface may use
`status: ready`; otherwise use `draft` or `blocked` and name each gap.

LOG exactly `- DATE [E-###] [parent: E-###] RUN: translate -> done
@SHORT-HASH`, then transition to DONE. A dedicated parallel instance deletes
its transient `.saipen/saitranslate/STATE.md`; translation output remains.

Completion never integrates output. Only targeted `saipen collect
saitranslate` may consume a fresh ready handoff, create/claim the Core ticket,
and route it through VERIFY/REVIEW/SHIP. **No ready handoff means no main
write.**

Missing initialization -> instruct `saipen set`. Dual legacy/canonical roots
-> ticket conflict. Incomplete coverage -> draft/blocked with facts.
