# Board

<!-- Ticket shape is RFC § 1.2's, exactly: a checkbox, the T-### id, a
     description, then only the fields that apply, space-pipe separated.
     Shown here WITHOUT its leading "- " on purpose (see below):

       [ ] T-001 short description | verify: pytest -q

     Other legal fields (RFC § 1.2): the dependency one, taking a
     comma-separated list of T-### this ticket waits on; owner and
     claim_time for claims (§ 1.4); blocker for facts + dead ends; verify as
     shown above. Named rather than shown here on purpose -- see below.

     A real line starts with "- ". Checkbox: [ ] open, [/] in progress
     (## DOING), [x] done (## DONE). A status change MOVES the line between
     sections -- cut and paste, never copy, or the same id ends up under two
     headings. All four headings below are required, even while empty.

     Why the example is de-fanged: neither validator skips HTML comments, so
     anything ticket-shaped in here is read as a real ticket on a brand-new,
     untouched board. Two separate traps, both hit for real while writing
     this very file: a full checkbox line parses as a live ticket, and the
     dependency field followed by an id is flagged as a dangling reference
     even without a leading dash -- tests/validate.sh scans for that field
     across the whole file, not only ticket lines, making it stricter here
     than tools/validate.py. So: no leading dash on any example, and never
     write that field name next to a concrete id anywhere in this file. -->

## DOING

## TODO

## DONE
- [x] T-22 [P1] ZAICODE whole-project review: everything works as intended, SAIPEN engine efficient in ZAICODE, add substantive improvements | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-016 | owner: opencode | claim_time: 2026-09-24T06:57:57Z | closure_mode: own_patch
- [x] T-21 [P1] ZAICODE: remove Disconnect (account-free), fix provider Rename menu item, disable onboarding profession wizard, disable upstream auto-update badge, add proje... | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-015 | owner: opencode | claim_time: 2026-09-24T06:38:27Z | closure_mode: own_patch
- [x] T-20 [P1] ZAICODE agent system (sidebar ZAICODE workspace: roster, queue, inspector, editor) redesign: make purpose, flow and activation obvious at first glance, fewer... | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-014 | owner: opencode | claim_time: 2026-09-24T06:15:59Z | closure_mode: own_patch
- [x] T-19 [P1] ZAICODE: task rename via right-click/Enter/F2 must edit inline in the sidebar row (like F2 in explorer), no separate dialog | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-013 | owner: opencode | claim_time: 2026-09-24T05:37:07Z | closure_mode: own_patch
- [x] T-16 [P1] Audit ZAICODE UI feedback: check which items done vs not done | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-010 | needs: T-17 | owner: opencode | claim_time: 2026-09-24T05:18:23Z | closure_mode: own_patch
- [x] T-17 [P1] Implement ZAICODE persistence, launcher, restart, branding, readable code blocks, todo, themes, profiles, router pools and SAIPEN access | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-011 | needs: T-18 | owner: opencode | claim_time: 2026-09-24T05:16:52Z | closure_mode: own_patch
- [x] T-18 [P1] ZAICODE UI batch: titlebar project click creates session, todo gauge above chat, START button + agent status (next/last action, next ticket), colored tooltip... | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-012 | owner: opencode | claim_time: 2026-09-24T05:14:46Z | closure_mode: own_patch
- [x] T-15 [P1] ZAICODE UI feedback batch: remove Connect button; add profiles with generic icons; make all icon/element placeholders hot-swappable for editing; add all Vint... | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-009 | owner: opencode | claim_time: 2026-09-24T02:26:02Z | closure_mode: own_patch
- [x] T-14 [P1] narrow post-T-13 reconciliation pass | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-008 | owner: opencode | claim_time: 2026-09-23T19:05:30Z | claim_session: ae20261280fccff28f8269440dc1a5f4 | closure_mode: own_patch
- [x] T-13 [P1] ZAICODE UX and routing-model clarification wave | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-007 | owner: opencode | claim_time: 2026-09-23T17:59:28Z | claim_session: ae20261280fccff28f8269440dc1a5f4 | closure_mode: own_patch
- [x] T-12 [P1] ZAICODE | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-005,SRC-006 | owner: opencode | claim_time: 2026-09-23T16:56:03Z | review_passes: 1 | claim_session: ae20261280fccff28f8269440dc1a5f4 | closure_mode: own_patch
- [x] T-11 [P1] ZAICODE | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-004 | owner: opencode | claim_time: 2026-09-22T01:46:10Z | claim_session: 777caf20462cc1aa966841b062235028 | closure_mode: own_patch
- [x] T-8 [P2] ZAICODE services on remote host: register zaicode-agents/zaicode-jobs in remoteWorkspaceServiceCollection, or surface an explicit unavailable state | verify: remoteWorkspaceServiceCollection.ts registers both descriptors and pnpm typecheck passes | owner: opencode | claim_time: 2026-09-22T01:16:22Z | claim_session: 777caf20462cc1aa966841b062235028 | closure_mode: own_patch
- [x] T-6 [P1] T-6 SRC-002 validation matrix | verify: 13/13 SRC-002 checks recorded with command/log evidence | owner: opencode | claim_time: 2026-09-22T01:00:15Z | claim_session: 777caf20462cc1aa966841b062235028 | closure_mode: own_patch
- [x] T-5 [P1] T-5 root UI.md product contract with account-independence invariants | verify: UI.md exists at ZAICODE root containing both SRC-002 invariant sentences | owner: opencode | claim_time: 2026-09-22T00:55:40Z | claim_session: 777caf20462cc1aa966841b062235028 | closure_mode: own_patch
- [x] T-4 [P1] T-4 ZAICODE standalone identity + profile isolation (app name/userData/data root/single-instance) | verify: isolated-profile launch proven; ZAICODE and production ZCode state paths disjoint and production files unmodified | owner: opencode | claim_time: 2026-09-22T00:52:11Z | claim_session: 777caf20462cc1aa966841b062235028 | closure_mode: own_patch
- [x] T-3 [P1] T-3 ZAICODE product capability layer: no-account startup + disable commercial UX (SRC-002) | verify: ZAICODE-mode desktop starts with zero providers, workspace opens, no login entry; pnpm typecheck+lint pass | owner: opencode | claim_time: 2026-09-22T00:48:45Z | claim_session: 777caf20462cc1aa966841b062235028 | closure_mode: own_patch
- [x] T-2 [P1] ZAICODE вЂ” ACCOUNT INDEPENDENCE / PRODUCT SEPARATION DELTA | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-002 | owner: opencode | claim_time: 2026-09-22T00:42:36Z | claim_session: 777caf20462cc1aa966841b062235028 | closure_mode: own_patch
- [x] T-1 [P1] ZAICODE | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-001 | needs: T-7 | claim_session: 777caf20462cc1aa966841b062235028 | owner: opencode | claim_time: 2026-09-22T00:24:58Z | closure_mode: own_patch
- [x] T-7 [P1] ZAICODE | verify: the requested change is present and demonstrated against the user own description of it | user_explicit: true | source_receipts: SRC-003 | owner: opencode | claim_time: 2026-09-22T00:24:14Z | claim_session: 777caf20462cc1aa966841b062235028 | closure_mode: own_patch

## BLOCKED
- [ ] T-9 [P3] ZAICODE interactive desktop E2E: click-through of workspace roster/queue/inspector and queue execution through the real runtime | verify: an automated or operator-run E2E scenario creates an agent, queues a task, dispatches it, and observes a terminal job state | blocker: OPERATOR_REQUIRED: interactive desktop E2E (agent create -> queue -> dispatch -> terminal state via real runtime) needs a configured provider and human-run desktop session; agent environment has no headless UI automation (playwright/browser automation banned by tooling hygiene, Electron runs leave long-lived processes); manual-verify steps are documented in docs/ZAICODE_ACCOUNT_INDEPENDENCE_VALIDATION.md; service-level path already covered by 10/10 unit tests | blocker_scope: ticket
- [ ] T-10 [P3] ZAICODE coordinator self-service delegation: expose queue delegation as a runtime tool so the coordinator agent can create a child job without operator input | verify: a coordinator job's tool call creates a linked child job through the same queue service and the depth-1 invariant still holds | owner: opencode | claim_time: 2026-09-22T01:09:00Z | claim_session: 777caf20462cc1aa966841b062235028 | blocker: NEEDS_OPERATOR_SCOPE_DECISION: agent-initiated delegation = new LLM-callable tool that creates side-effectful queue jobs; requires protocol port mirroring OffPeakCreate across ~14 upstream CLI/shared/services files plus per-turn tool visibility attribution; design sketch in LOG 2026-09-22; operator must decide which agents may spawn jobs and the limits before this is built | blocker_scope: ticket
