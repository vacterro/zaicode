# Publication boundary

The ZAICODE project is published in two layers, and only one of them may
carry the protocol's memory.

| layer | content | published as |
| --- | --- | --- |
| workspace | launcher, `install/`, `tools/launcher`, docs, product contract | `master` on the GitLab mirror |
| app | the `zcode/` product tree | the `zaicode` branch on the app host |
| memory | `.saipen/` (STATE, BOARD, LOG, evidence, receipts) | never |

`.saipen/` is the SAIPEN protocol's own memory of the workspace: the ticket
board, the event log, the evidence tree, the receipts. It is internal by
design. It carries the operator's host paths, the protocol's history and
machine-local handles, so it does not belong on a public branch tip.

## What is published, and how

The workspace branch is published with the memory tree stripped:

```
python tools/publish-workspace-mirror.py --remote gitlab --branch master
```

The script writes one forward commit per local commit: same message, same
author, same date, same tree minus `.saipen/`. History is never rewritten, the
local checkout keeps its memory, and the published tree gets a `.gitignore`
rule that keeps `.saipen/` out of any later clone.

Every other push is guarded. `tools/hooks/pre-push` refuses a push whose tree
still carries `.saipen/` and names this script. Enable it once per clone:

```
git config core.hooksPath tools/hooks
```

A plain `git push` of a branch that still tracks the memory tree is therefore
refused, not silently published.

## What an install gets

The installer clones the published workspace branch with a sparse checkout
that excludes `/.saipen/`, `/stats/` and `/_mycustompics/`
(`install/ZaicodeChecks.ps1`). A fresh install therefore contains no protocol
files at all -- the exclusion is the second line of defence behind the
publication boundary itself.

## Known residual

The published branch's HISTORY still contains the old `.saipen/` blobs; a
forward commit only changes the tree at the tip. They remain reachable by
commit id. Purging them means rewriting the public branch's history, which
invalidates every clone and needs the operator's explicit decision -- it is
not done here.
