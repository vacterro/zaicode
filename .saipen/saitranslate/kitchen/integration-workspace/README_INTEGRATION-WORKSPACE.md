# ZAICODE integration-workspace strings

**v0.0.2**

Release surface for the strings that belong to the integration workspace — the
cross-package shells where the UI, the services and the CLI meet. This subtree
holds full README mirrors rather than catalogues, because the integration
workspace is read as documentation before it is read as strings.

## What lives here

| Path | Role |
| --- | --- |
| `manifest.json` | The extracted catalogue for the workspace. |
| `README.ee.md`, `README.ded.md`, `README.ja.md` | Full README mirrors for the supported mirror locales. |
| `docs/` | Translated copies of the workspace documentation. |

## Rules that must survive translation

- **A mirror is not a fork.** `README.ee.md`, `README.ded.md` and `README.ja.md`
  are mirrors of the same document. A paragraph added to one and not the others
  is a parity defect, found at release.
- **Every mirror carries the same version badge** as the root `README.md`.
  Release parity is checked mechanically and a stale badge refuses the release.
- **Protected tokens are opaque**, exactly as in the `cli/` and `docs/`
  subtrees.

See the repository root [README.md](../../../README.md) for the full project.