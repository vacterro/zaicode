ZAICODE

# Wave 4 — Project folders, pins and model-specific visual identity

## Goal

Improve navigation and visual identification without moving real project directories on disk or coupling appearance to unstable display names.

## A. Virtual project folders

Add an obvious folder system for ZAICODE's project list/workspace organization.

This is organizational metadata by default. Moving a project into a ZAICODE folder must **not** move/rename the actual filesystem project directory.

Minimum behavior:
- create folder;
- rename folder;
- delete folder safely;
- drag/drop project into folder;
- move project back to Unfiled/No folder;
- collapse/expand folder;
- persistent order;
- folder/project counts where useful;
- context menu and clear drop target;
- keyboard-accessible move action as an alternative to drag/drop.

Start with one folder level unless the existing data model already safely supports nesting. Do not invent recursive folder complexity merely because the word "folder" exists.

Deleting a virtual folder must preserve its projects and move them to Unfiled (or require an explicit alternative). Never delete a real project from disk through this organizational action.

Persist stable folder IDs and stable project identity references. A project path/name update must not silently orphan organization metadata if a stronger existing project ID exists.

## B. Project PIN system

Add a separate pin/unpin property for projects.

Requirements:
- obvious pin action and visible pinned state;
- pinned projects appear at the top of the relevant project view;
- pinning does not remove folder membership;
- unpin restores normal folder/order behavior;
- pin state persists across restart;
- stable ordering among multiple pinned projects (manual order or deterministic `pinnedAt` order);
- context menu and accessible direct action;
- no duplicate rendering of the same project unless the UI intentionally uses a single Pinned shortcut section whose entries navigate to the canonical project.

Folders answer "where is this project grouped?"; pins answer "keep this project easy to reach". Keep the concepts independent in state/schema.

## C. Highlights: global Default vs per-model Separate

Extend the existing Highlights/worker appearance system so the operator can visually distinguish the model actually working on a project.

State model:
- `Default`: use global/default highlight + worker appearance for every model without an override.
- `Separate`: for a selected provider/model identity, enable independent highlight/effect and worker-icon settings.

This must work for SAIFREN and SAIOPP and be generic for any selected model, not a pair of hard-coded special cases.

The operator specifically wants SAIFREN usable as the common/default appearance while SAIOPP can diverge when that model is active. Implement the schema so a global default can be configured once, then any concrete model can choose Default or Separate.

### Model identity

Key overrides by the stable provider/model identity used by actual runtime selection. Do not key solely by display label.

When work is running, choose the effective style from the **actual model selection that executed the work**, not merely the model currently highlighted in a picker.

Fallback chain:
1. exact model Separate override;
2. global Default;
3. shipped product fallback.

### Worker icon

Allow a per-model worker icon in Separate mode:
- bundled icons and supported custom image path/upload using the existing safe asset mechanism;
- preview in Settings;
- fallback to global worker icon if missing/invalid;
- no layout jump when models switch;
- icon changes live when the actual active worker/model changes;
- serialized safely with other appearance settings.

Do not duplicate the worker-state runtime. This is an appearance resolver layered on the current authoritative worker/model state.

## D. UX

Folders/pins must remain simple at first use:
- `New folder` visible near project navigation;
- drop highlight explains where the project will go;
- pin icon is recognizable and has a tooltip;
- destructive actions distinguish `Remove from folder`, `Unpin`, `Archive project`, and any real deletion.

## Wave acceptance

- projects can be grouped into persistent virtual folders without filesystem moves;
- deleting a virtual folder does not delete projects;
- pins independently keep projects at the top and persist;
- SAIFREN/SAIOPP and arbitrary models can inherit Default or use Separate appearance;
- the worker icon reflects the actual active model using deterministic fallback;
- relevant tests and repository gates pass.
