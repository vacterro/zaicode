# -*- coding: utf-8 -*-
"""qq -> saipen prepare saiwiki: the project has no defined maintained-wiki
page set, so the producer records a blocked entry with the missing fact."""
import os, time

S = r"V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/.saipen/extensions/subs/saiwiki"

def write(name, text):
    p = os.path.join(S, name)
    open(p, "wb").write(text.replace("\n", "\r\n").encode("utf-8"))
    print("wrote", name)

def append(name, text):
    p = os.path.join(S, name)
    raw = open(p, "rb").read()
    crlf = raw.count(b"\r\n"); lf = raw.count(b"\n") - crlf
    ending = "\r\n" if crlf > lf else "\n"
    t = raw.replace(b"\r\n", b"\n").decode("utf-8")
    if not t.endswith("\n"):
        t += "\n"
    t += text.replace("\r\n", "\n")
    open(p, "wb").write(t.replace("\n", ending).encode("utf-8"))
    print("appended", name)

state = """---
phase: BLOCKED
task: none
next_action: "RUN: idle -- blocked on the maintained-wiki scope; operator decides which page set this project's wiki is, then 'saipen prepare saiwiki' can run for real"
blocker: "the project has no maintained-wiki page set and no project-local canonical ID source to mirror (CONFORMANCE.md, the charter's example, exists only in the SAIPEN home); writing a ready package would mean inventing the page set"
agent: saiwiki
saipen_version: 7
schema_version: 3
style_contract: ded-069a4c52
saipen_home: "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_SAIPEN"
mode: read-only
transition_from: PLAN
updated: "2026-10-05T23:44:10Z"
role_revision: "sha256:54a42475a124ab0f27e83d600a284a9cc54d9668029c4828cfc48512b031df13"
---

<!-- BOUNDARY: you may write ONLY inside this folder
     (.saipen/extensions/subs/<your-name>/). Never .saipen/BOARD.md,
     .saipen/kitchen/, .saipen/LOG.md, .saipen/STATE.md (the MAIN
     project's own) -- those belong to Core, not you. -->
"""
write("STATE.md", state)

log = """
## 2026-10-05T23:44:00Z | RUN | PLAN
RUN: role adopted from `saipen prepare saiwiki` (`qq`), which spawned this instance for project _ZAICODE at 23:38:31Z. Read order held: own STATE/BOARD/LOG -> project-local PROTOCOL.md -> project-local saiwiki.md -> the canonical ID source -> the project docs. Charter kind PRODUCER, collect_policy explicit, write scope this folder only.

## 2026-10-05T23:44:05Z | RUN | BLOCKED
RUN: cannot prepare. The project has no maintained-wiki page set: `.saipen/` holds no wiki pages, no project-local CONFORMANCE.md, and the only canonical id-to-title source the charter names (`CONFORMANCE.md`) exists in the SAIPEN home, not here. The one maintained wiki on this machine is the home's own instance at `_SAIPEN/.saipen/extensions/subs/saiwiki/`, whose current package binds HEAD `025bf596` and whose HEAD is still `025bf596` -- already current, awaiting its own user brake, and outside this project root. Writing a ready package here would mean inventing the page set, which the charter's non-goals forbid and PROTOCOL section 2 forbids guessing through. Recorded as a blocked OUTBOX entry naming the exact missing fact.
"""
append("LOG.md", log)

pkg = """## WIKI-001: `qq` cannot prepare -- this project has no maintained-wiki page set, and the one wiki that exists is the SAIPEN home's own
- **status:** blocked
- **summary:** `saipen prepare saiwiki` spawned this project-local instance and delegated adoption, but the prepare cannot produce a ready package: project _ZAICODE defines no wiki page set and carries no project-local canonical ID source to mirror, while the maintained wiki that actually exists on this machine belongs to the SAIPEN home, is already current at its own HEAD (025bf596), and is awaiting its own user brake outside this project root.
- **main_project_refs:** [.saipen/extensions/subs/MANIFEST.md, .saipen/extensions/subs/saiwiki.md, .saipen/KNOWLEDGE/INDEX.md]
- **critical:** false
- **severity:** P3
- **producer:** saiwiki
- **source_head:** 4e2135523fda59b7f055667dd0fbd4a6fd039f3c
- **source_tree_fingerprint:** git-delta-v1:f96332c0981beae7abfe9a69e3eaa4aa4ba5be1cfe198d75997c3e2aaf0177d0
- **role_revision:** sha256:54a42475a124ab0f27e83d600a284a9cc54d9668029c4828cfc48512b031df13
- **coverage:** the whole answerable surface: this instance's own STATE/BOARD/LOG, project-local PROTOCOL.md and saiwiki.md, every wiki-shaped path under `.saipen/` (none), the project docs the pages would mirror, and the one maintained wiki on the machine (`_SAIPEN/.saipen/extensions/subs/saiwiki/`: 9 pages, package W-050, ready set of 11 identity files).
- **payload:** the decision itself, then the pages. Once the scope is named -- which page set is this project's wiki, and where its canonical IDs live -- preparing it is mechanical: build pages by ID from that source, bind source_head + source_tree_fingerprint + role_revision, mark the mirror marker the canonical source requires, and name every page in `coverage` and `payload`.
- **verified:** BLOCKED -- the absence is evidence, not an assumption: no file under `.saipen/` matches a wiki page set, no project-local CONFORMANCE.md exists (the kernel's lives at `_SAIPEN/saipen/CONFORMANCE.md`), and `_SAIPEN/.saipen/extensions/subs/saiwiki/STATE.md` shows the home instance DONE with `next_action: "WAIT: user brake -- prepare done"`, its package bound to `025bf596` equal to `git -C _SAIPEN rev-parse HEAD`. Nothing was written outside this folder.
- **instructions:** treat this as a request for one operator decision, not as integration work. Decide which of the two readings is meant: (a) this project has a wiki that should mirror the SAIPEN home's page set and canonical IDs -- then say so and prepare it here against this project's fingerprint; (b) the wiki belongs to the home only -- then this instance should be disposed with `saipen sub clean saiwiki` and `qq` should be run in the home project root instead. Do not create a project wiki from the ZAICODE product docs without that decision: the charter forbids authoring copy without a ticket, and a page set chosen by an agent is exactly the guess PROTOCOL section 2 exists to refuse.
- **details:**
  What happened: `qq` resolved to `saipen prepare saiwiki`, which refused with `ROLE_NOT_RUN` and instructed the current agent to adopt the role; the same command spawned this instance at 23:38:31Z with an empty board, an empty kitchen and `next_action: saipen plan`. Adoption followed the charter's read order and stopped at the point where the method needs a canonical source it does not have.
  Why this is a blocked entry and not a guess: the charter's method is "read the canonical source, build the page set by ID"; the only canonical id-to-title source it names is CONFORMANCE.md, and this project has none. Its non-goals forbid authoring product copy without a ticket. PROTOCOL section 2 states the rule this entry follows: when a finding depends on something the sub cannot determine from the project's own files, write `status: blocked` with the exact missing fact in `details`, never a plausible default.
  The one real wiki on this machine, stated so nobody re-derives it: `_SAIPEN/.saipen/extensions/subs/saiwiki/` holds 9 maintained pages; its latest package (W-050, force-fresh v8.1.0 truth: install/remove lifecycle, future-gate surface, inventory) binds source_head `025bf596c683464788ab698248e8a3c5eb44dfec`; `git -C _SAIPEN rev-parse HEAD` still returns the same commit, so that package is current rather than stale; its STATE sits at `WAIT: user brake` with an 11-file ready set, which means the home wiki is prepared and un-integrated by the operator's own choice, not by a defect.
  Consequence if nobody decides: `saipen sub list` reports this instance BLOCKED (the designed escalation for a sub that cannot reach a human), `qq` keeps spawning nothing useful in this project, and the next agent to read it re-derives the same two readings. The decision is one sentence; the work behind it is mechanical.
"""
append("kitchen/OUTBOX.md", pkg)
