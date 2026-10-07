# AUDAPACK debt — nested `zcode` component declared but not included

Recorded during T-251. **Not repaired in this wave** (out of ticket scope; the briefing forbids
promoting it into the active ticket).

Source: the audit archive's `.audapack/manifest.json` carries a `nested_git_components` entry for the
workspace's nested product repository:

| field | value |
|---|---|
| path | `zcode` |
| origin | `github.com/vacterro/zaicode` |
| head | `4f71888cdaf1a9fa1c875b05c825654097f6802e` |
| included | **false** |
| files | **0** |

So the archive names the product repository and its commit, but ships none of its files. Any audit
that reads the archive alone audits the SAIPEN memory, not the product: the tree the SRC-163 wave
actually measured (staged packaged app, `app.asar` sha256
`a9e6ef6f9ec66b2751a0f246add3d4562803e312e953eaee7c88c75df7f4489e`) is not in it.

Owner: AUDAPACK packaging (its manifest writer / include policy). Fix would be either an include of
the nested `zcode` tree or a manifest that marks the component absent-with-reason rather than present
with `files: 0`. The T-251 wave deliberately did not rewrite the archive manifest.
