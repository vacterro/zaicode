# T-141 root publication blocker

The application was published to `origin/zaicode` as
`e90914815ad3c607132cc6aafeea0a106f848cb4`. Root publication on `master`
and tag `v0.0.2` have not started. No root release index was staged.

`saipen ship --dry-run --json` returned `VALIDATION_FAILED` on 2026-09-30:
release version parity requires the following nonexistent files:

- `.saipen/saitranslate/kitchen/cli/README_CLI.md`
- `.saipen/saitranslate/kitchen/docs/README_DOCS.md`
- `.saipen/saitranslate/kitchen/drafts/README_DRAFTS.md`
- `.saipen/saitranslate/kitchen/extras/README_EXTRAS.md`
- `.saipen/saitranslate/kitchen/integration/README_INTEGRATION.md`
- `.saipen/saitranslate/kitchen/integration-workspace/README_INTEGRATION-WORKSPACE.md`
- `.saipen/saitranslate/kitchen/outbox/README_OUTBOX.md`
- `.saipen/saitranslate/kitchen/payload/README_PAYLOAD.md`

Read-only inspection of the bound installation's
`tools/saipen_engine/release_contract.py:19` shows `locale_readme_paths`
enumerates every kitchen directory and constructs `README_<DIRECTORY>.md`.
These eight directories contain producer infrastructure, not locale mirrors.
The actual collected locale READMEs are under `docs/locales/<locale>/README.md`.

`VERSION`, the latest CHANGELOG entry, and 36 reviewed user-facing READMEs
have been prepared for 0.0.2. The root documentation proof records the
authenticated translation bytes and the narrowly defined version overlay
separately; producer payloads and their manifests were not rewritten.

The operator requested that SAIPEN protocol maintenance remain with the
other agent. No installation code or tests were changed to fix this gate.
No fake infrastructure README was created, and the gate was not bypassed.
The maintainer must resolve release-inventory discovery before root shipping
can resume through the canonical command. This is an external maintenance
dependency, not a request to weaken publication validation.

Resume: `saipen ship --dry-run --json`, then use the reviewed root scope and
canonical ship workflow if the corrected inventory accepts it.
