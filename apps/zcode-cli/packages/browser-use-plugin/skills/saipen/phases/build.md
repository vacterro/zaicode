# Phase: BUILD

Implement the smallest safe complete change. Handle null/empty/error paths,
match repository style, and leave modernization for separate Work.

Before normative prose, apply CORE §1.1: it **names the defect class it eliminates** or is not written; cite existing law instead of restating it.

Before new code, use this one-pass reuse ladder:

1. project helper/module/pattern;
2. language standard library;
3. an existing dependency;
4. only then new code.

Adding a dependency is separate Work. If searching costs more than the small
implementation, write it and LOG that the bounded search found no reuse.

For a risky but reversible edit, LOG its rollback first. A destructive effect
(history/schema/database drop, mass or user-data deletion, irreversible
migration) still requires CORE/OPS authorization; a rollback note is not
permission. Wait with `WAIT: destructive-op -- <exact operation>` when Work
does not pre-authorize the exact reversible effect. Preserve unrelated dirty
changes.

Scope growth or broken neighbors become TODO tickets. UI/interface work also
loads UI.md.

On completion, LOG `RUN: build -> <what changed>` in the Event Graph skeleton,
then use the canonical checkpoint and enter VERIFY. If safe completion needs
missing human authority, enter BLOCKED with facts and preserve/remove only this
attempt's partial edits through VERIFY's failed-attempt recovery procedure.
