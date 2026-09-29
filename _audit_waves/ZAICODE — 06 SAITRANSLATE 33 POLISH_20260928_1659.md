ZAICODE

# Wave 6 — SAITRANSLATE locale completion and localization polish

## Goal

Finish the long-deferred locale expansion using the current SAITRANSLATE protocol rather than guessing language names or generating partial files that only make the switcher look impressive.

## Current evidence

The 2026-09-28 snapshot records:
- current real UI/CLI locales were still `en-US` and `zh-CN` at the earlier SAITRANSLATE measurement;
- the protocol's target is **32 language locales plus the DED variant = 33 coverage targets**;
- Core owns EN/EE/RU/DED while the SAITRANSLATE producer owns the other 29 language locales;
- the earlier measurement counted 5,838 source keys and a six-figure missing-translation remainder. Recompute the count from current HEAD because the product has changed since then.

## A. Resolve the authoritative locale list

Do not hard-code a guessed list from this handoff.

At execution time read the currently installed SAIPEN `phases/translate.md` plus `.saipen/extensions/subs/saitranslate.md` and resolve the exact 32-locale language set and ownership split. Persist the resolved list in implementation evidence so future agents can verify parity.

If current protocol differs from the older 32+DED contract, report the drift before changing product scope; do not silently mix versions.

## B. Use SAITRANSLATE as producer

Follow the producer workflow:
- adopt/prepare SAITRANSLATE through canonical protocol commands;
- scan real source surfaces from current nested HEAD;
- generate/update locale drafts/package inside the role's authorized namespace;
- validate source digests/freshness;
- integrate through the explicit Core collection path and normal product gates.

Do not let SAITRANSLATE directly write the main product tree outside its protocol authority.

The operator previously intended the large translation body to be suitable for the SAIFREN pool. Use the available pool/batching mechanism if current protocol supports it, but every batch must preserve exact key identity and deterministic merge behavior.

## C. Real surfaces, not generated noise

At minimum cover the authoritative source sets identified by current project architecture:
- desktop/UI i18n source catalog under `packages/ui/src/i18n/**`;
- CLI i18n source catalog under `apps/zcode-cli/packages/i18n/**`;
- user-facing documentation included by current SAITRANSLATE scope.

Do not treat generated router/assets bundles as source locale authority.

## D. Catalog and switcher integrity

For every locale:
- exact key parity with the canonical source schema;
- no duplicate keys;
- no malformed ICU/template placeholders;
- placeholder/token parity with source;
- locale is selectable and persisted;
- UI and CLI agree on locale identifiers or use an explicit mapping;
- fallback is visible in tests and not used to disguise thousands of missing keys;
- DED remains an intentional variant, not counted as a natural-language locale in analytics if the product distinguishes those concepts.

Where a target language requires RTL behavior according to the resolved locale list, propagate document/component direction through the existing design system rather than manually reversing individual controls.

## E. Localization-driven layout regressions

Run representative long-string and compact-window checks after locale expansion. Fix:
- clipped settings labels;
- overlapping buttons/badges;
- fixed-width assumptions;
- ellipsis that hides the only actionable text;
- modal/footer rows that break under longer translations.

Use flex/grid min-width and wrapping ownership rather than locale-specific pixel hacks.

## F. Translation quality

Do not ship placeholder English copies as completed translations merely to reach 33 entries. Every locale must have a real translation source/runner and freshness digest. Preserve product/technical tokens, paths, command names and placeholders exactly where they are not translatable.

Because the corpus is large, it is acceptable to execute this wave in deterministic locale batches, but the ticket remains open until the declared target coverage passes.

## Tests required

- generated schema/key parity for every locale;
- placeholder parity;
- locale catalog contains the exact resolved set;
- UI switch/persist/restart smoke for representative locales including EN, EE, RU, zh-CN, at least one long-string locale, at least one non-Latin locale, and an RTL locale if present in the authoritative list;
- CLI locale selection smoke;
- no untranslated-key exception on representative primary flows;
- long-string layout snapshots/tests for settings/sidebar/composer/audit surfaces;
- current SAITRANSLATE freshness/digest validation.

## Wave acceptance

- exact current protocol target (expected 32 languages + DED) exists in real UI/CLI catalogs;
- every locale has source-key and placeholder parity;
- switching locale works and persists;
- translation package freshness is proven against current source;
- no major localization-induced clipping/overlap remains in primary ZAICODE workflows;
- all current repository gates pass.
