# App repository publication remediation (T-420)

Status: the **current tree is clean**; six already-published tips still carry
contaminated history. This document records the measured facts and the options,
and deliberately proposes no history rewrite.

Public-safe: no host path, no operator audio filename, no audio bytes.

---

## 1. What is clean now

Commit `13314481` on the app branch `zaicode` removes three per-machine files
from the vendored `skills/saipen` copy and adds a `.gitignore` for the runtime
marker. None of the three was source:

| File | Why it cannot be published |
| --- | --- |
| `.saipen_runtime.json` | per-machine provenance record naming this host's install root |
| `bin/saipen` | shell launcher rendered by the canonical installer, hardcodes one machine's interpreter |
| `bin/saipen.cmd` | the same for Windows |

Verified on that commit:

```
python tools/verify-publication-boundary.py --repo app --tip HEAD   # exit 0, PASS
node scripts/audio/verify-published-audio.mjs --ref HEAD            # exit 0, PASS
node scripts/audio/verify-private-data.mjs --mode source            # exit 0, PASS
node scripts/audio/verify-fallback-sounds.mjs                       # exit 0, 35 files
```

The previous tip failed the same two gates with `3 host path file(s)`.

## 2. What is still contaminated

Six published refs, three on each remote, name both problems:

| Ref pair | Host-path files | Audio files outside the allowlist |
| --- | --- | --- |
| `github-main` | 5 | 1311 |
| `github-master` | 5 | 1311 |
| `release/zaicode-v0.0.3` | 4 | 1311 |

`github-main` and `github-master` carry two further host-path files beyond the
three removed above, so they are not fixed by the same commit.

The audio count is a legacy property of those trees. The allowlist in the same
tree names 35 files, the current tree carries exactly those 35, and the
allowlist gate passes on it. So the finding is history, not a live defect.

## 3. Why this is not fixed by another commit

A new commit changes a tip. It does not change what an already-pushed tip
contains. The contaminated objects stay reachable from those refs and stay
downloadable by anyone who already has the URL, and they remain in every
existing clone and mirror.

Three options, each with its own cost:

### Option A — retire the refs, publish a clean line

- Point each affected branch at a clean commit, or delete the ref and publish a
  new one under a new name.
- Cost: anyone tracking `github-main` / `github-master` gets a rewritten history
  and a forced update; old clones keep the contaminated objects anyway.
- Risk: low for the repository, moderate for consumers.
- Needs: explicit operator approval. Never `--force` as a shortcut.

### Option B — rewrite the published history

- Filter the objects out of every affected branch and force-push.
- Cost: every clone, fork and mirror diverges; release assets that reference the
  old commit ids stop matching; the contaminated blobs remain on the server
  until its garbage collection runs.
- Risk: high, and it does not achieve deletion on any third-party host.
- Needs: explicit operator approval plus a coordinated consumer notice.

### Option C — accept and document

- Leave history alone, keep the tips as they are, and treat section 2 as a known
  and accepted exposure with a date and an owner.
- Cost: none to consumers; the audio and path exposure stays public.
- Risk: the exposure is permanent and must be restated in any security summary.
- Needs: operator decision to accept.

Recommendation: **Option A** on the next release boundary, run per ref and
verified by `tools/verify-publication-boundary.py --repo app --tip <ref>` before
and after. It clears future consumers without the cross-fork breakage of a
history rewrite, and it is reversible per ref.

## 4. Release artifacts

The packaged payload is judged separately from Git history:

```
pnpm sounds:audit-artifact    # allowlist inside packages/desktop/dist
pnpm privacy:audit-artifact   # host paths and private data inside the payload
```

Neither was run against a rebuilt artifact in this pass. The staged
`dist-next` payload used by the T-419 acceptance was built from the same source
revision and its build metadata names that revision, but it predates
`13314481`. A release built after this commit must re-run both artifact gates;
a clean source tree is not evidence about a payload built earlier.
