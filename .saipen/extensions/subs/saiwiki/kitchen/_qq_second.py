# -*- coding: utf-8 -*-
"""qq re-issued: same declared command, same delegation, same blocker.
Strengthen the blocked entry with the doc-surface evidence measured this turn."""
import os, time

S = r"V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/.saipen/extensions/subs/saiwiki"

def patch(name, pairs, expect=1):
    p = os.path.join(S, name)
    raw = open(p, "rb").read()
    crlf = raw.count(b"\r\n"); lf = raw.count(b"\n") - crlf
    ending = "\r\n" if crlf > lf else "\n"
    t = raw.replace(b"\r\n", b"\n").decode("utf-8")
    for old, new in pairs:
        if t.count(old) != expect:
            raise SystemExit("anchor count %d != %d for %r" % (t.count(old), expect, old[:60]))
        t = t.replace(old, new)
    open(p, "wb").write(t.replace("\n", ending).encode("utf-8"))
    print("patched", name)

cov_old = "- **coverage:** the whole answerable surface: this instance's own STATE/BOARD/LOG, project-local PROTOCOL.md and saiwiki.md, every wiki-shaped path under `.saipen/` (none), the project docs the pages would mirror, and the one maintained wiki on the machine (`_SAIPEN/.saipen/extensions/subs/saiwiki/`: 9 pages, package W-050, ready set of 11 identity files)."
cov_new = "- **coverage:** the whole answerable surface, measured twice: this instance's own STATE/BOARD/LOG, project-local PROTOCOL.md and saiwiki.md, every wiki-shaped path under `.saipen/` (none), the one maintained wiki on the machine (`_SAIPEN/.saipen/extensions/subs/saiwiki/`: 9 pages, package W-050, ready set of 11 identity files), and -- this second pass -- the project's own documentation surface: 12 documents under `docs/` (ZAICODE_ARCHITECTURE, ZAICODE_IMPLEMENTATION, ZAICODE_INSTALL, ZAICODE_UPSTREAM_DELTA, ZAICODE_SAIPEN_CLOUD, ZAICODE_FEEDBACK_COVERAGE, ZAICODE_ACCOUNT_INDEPENDENCE_VALIDATION, ZAICODE_BASELINE_RECEIPT, HANDOFF_A3_AUDIT, HANDOFF_LOCAL_OPERATOR, HANDOFF_PROTRAIL_CONTINUE, HANDOFF_SAIPEN_CROSS_PLATFORM), the root README set (README.md plus README.ded/ee/ja), UI.md, CHANGELOG.md, AGENTS.md, CLAUDE.md, and the only other wiki-shaped surface -- the in-product HELP pages, which the READMEs call a helper session and whose copy T-91/T-145 own."
patch("kitchen/OUTBOX.md", [(cov_old, cov_new)])

ins_old = "Do not create a project wiki from the ZAICODE product docs without that decision: the charter forbids authoring copy without a ticket, and a page set chosen by an agent is exactly the guess PROTOCOL section 2 exists to refuse."
ins_new = "A third reading is now on the table and costs the same one sentence: (c) this project has a wiki that mirrors its OWN documentation surface -- name the page set and the ID authority (`docs/*` alone, or `docs/*` plus the README set and `UI.md`), then prepare it against this project's fingerprint. Do not create a project wiki from the ZAICODE product docs without that decision: the charter forbids authoring copy without a ticket, the in-product HELP pages are product copy under T-91/T-145 and are not a mirrorable page set, and a scope chosen by an agent is exactly the guess PROTOCOL section 2 exists to refuse."
patch("kitchen/OUTBOX.md", [(ins_old, ins_new)])

det_old = "Consequence if nobody decides: `saipen sub list` reports this instance BLOCKED (the designed escalation for a sub that cannot reach a human), `qq` keeps spawning nothing useful in this project, and the next agent to read it re-derives the same two readings. The decision is one sentence; the work behind it is mechanical."
det_new = "Second pass, same command, same outcome, and one thing gained: the project's own documentation surface was measured so the decision costs one sentence rather than an investigation -- 12 documents under `docs/`, the root README set, `UI.md`, `CHANGELOG.md` and the two agent files are the only candidate page bodies on this side, and the in-product HELP pages the READMEs call a helper session are product copy owned by T-91/T-145 rather than a canonical ID source a producer may mirror. Consequence if nobody decides: `saipen sub list` reports this instance BLOCKED (the designed escalation for a sub that cannot reach a human), and every further `qq` re-runs the same delegation into the same wall. The decision is one sentence; the work behind it is mechanical."
patch("kitchen/OUTBOX.md", [(det_old, det_new)])

log = """
## 2026-10-05T23:52:00Z | RUN | BLOCKED
RUN: `qq` issued a second time, whole message -> `saipen prepare saiwiki` re-run -> `ROLE_NOT_RUN` again (same delegation, exit 1). Nothing about the blocker changed by being asked twice, and a blocked entry is never promoted to ready to satisfy a repeat. What changed is the evidence: this pass measured the project's own documentation surface -- 12 documents under `docs/`, the root README set incl. the localized README.ded/ee/ja, `UI.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md` -- and confirmed the only other wiki-shaped surface is the in-product HELP pages that the READMEs name as a helper session and that T-91/T-145 own as product copy. The blocked entry now carries that measurement and a third, equally cheap reading (c): mirror the project's own doc surface, if the operator says so. OUTBOX re-validated.
"""
p = os.path.join(S, "LOG.md")
raw = open(p, "rb").read()
t = raw.replace(b"\r\n", b"\n").decode("utf-8")
if not t.endswith("\n"):
    t += "\n"
t += log.replace("\r\n", "\n")
open(p, "wb").write(t.replace("\n", "\r\n" if raw.count(b"\r\n") > 0 else "\n").encode("utf-8"))
print("appended LOG.md")
