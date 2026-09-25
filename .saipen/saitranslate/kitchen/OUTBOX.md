# OUTBOX

## SAIT-001: translation coverage blocked
- **status:** blocked
- **summary:** Complete 32-language plus Дед translation is unavailable from the current product and source binding.
- **main_project_refs:** [UI.md, docs/ZAICODE_ACCOUNT_INDEPENDENCE_VALIDATION.md, docs/ZAICODE_ARCHITECTURE.md, docs/ZAICODE_BASELINE_RECEIPT.md, docs/ZAICODE_IMPLEMENTATION.md, docs/ZAICODE_UPSTREAM_DELTA.md, zcode/README.md, zcode/README.en.md, zcode/AGENTS.md, zcode/CONTEXT.md, zcode/DESIGN.md, zcode/NOTICE.md, zcode/THIRD-PARTY-NOTICES.md, zcode/apps/zcode-cli/README.md, zcode/packages/ui/src/i18n/IntlProvider.tsx, zcode/packages/ui/src/i18n/locales/en-US.ts, zcode/packages/ui/src/i18n/locales/zh-CN.ts, zcode/apps/zcode-cli/packages/i18n/src/locale.ts, zcode/apps/zcode-cli/packages/i18n/src/locales/en-US.ts, zcode/apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts]
- **critical:** false
- **severity:** P1
- **producer:** saitranslate
- **source_head:** 58d8b047de983a3819bf366cd016f1f6486805c8
- **source_tree_fingerprint:** git-delta-v1:5906a33570085787001cedb145ad2d34fec0bd6506dbc20d5665b0c80273fa43
- **role_revision:** sha256:7d18729f8d94eb58471ae3bb5fad9151e8499fea291e574b26439c5c89012e41
- **coverage:** Outer user docs: UI.md plus 5 files under docs/. Nested tracked Markdown inventory: 184 files; user-facing eligibility includes 7 top-level zcode docs plus package READMEs/guides, while generated bundles, caches, tests, and internal skill references are not translated surfaces. Real UI/CLI locale sources: packages/ui/src/i18n/** and apps/zcode-cli/packages/i18n/src/**. Existing product locales: en-US and zh-CN only. Required 32-language plus Дед coverage produced this run: 0/33.
- **payload:** None. This is a blocker-only handoff; no translation files or main-tree integration files are collectable.
- **verified:** BLOCKED -- outer identity is bound above; nested source HEAD is 872ad960de7ec172591f7e1952f7849229f94521 with git-delta-v1:2240bde2ba883994d2d2fa13d35a20c4dd291503b1afaacb29103433d0effe8f; outer .gitignore excludes /zcode/; supported locale unions are closed to en-US and zh-CN; UI catalog comparison finds settings.memory.viewer.disabled missing from zh-CN and zaicode.field.provider extra; CLI catalog comparison finds 178 en-US keys versus 175 zh-CN keys; no embedded translation runner exists.
- **instructions:** 1. Bind nested zcode source identity and inventory into the producer freshness contract. 2. Add the 32-locale UI/CLI union, schema, catalog, switcher, and source-key parity needed for real UI coverage; do not treat generated 9router locale assets as source. 3. Choose and implement a real translation runner, then rescan docs and UI surfaces from current nested HEAD. 4. Recompute source and role bindings, publish a complete package only after 32 locales plus Дед verify PASS, and only then run explicit eee collection.
- **details:** Generic saitranslate instance created by the existing bootstrap bug was archived under .saipen/recovery/subs/saitranslate/sub-clean-7347adf8/ and removed from the generic namespace. Canonical runtime lives only at .saipen/saitranslate/. No READY package was created because status is blocked and coverage is incomplete. Main project files remain read-only and unchanged by this producer.
