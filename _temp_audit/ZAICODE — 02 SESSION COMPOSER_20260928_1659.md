ZAICODE

# Wave 2 — Session text and composer integrity

## Goal

Make message presentation and large-input handling reliable enough that the operator can trust what is saved, edited and actually sent to the model.

## A. Session text Save / Export / Import

Existing evidence says Session text styling and presets were implemented, but the operator cannot tell whether Save/Export work and currently considers the behavior broken or unclear. Treat this as a current product defect until a live round-trip proves otherwise.

Trace the real Settings -> Session text implementation and establish one authoritative settings/preset model.

Required behavior:
- edits have an explicit dirty state;
- Save persists and gives immediate success/failure feedback;
- closing/reopening Settings reads the saved value, not stale component state;
- Export creates a real versioned artifact containing every supported Session text setting;
- Import validates schema/version, previews or clearly describes destructive replacement, and applies atomically;
- export -> reset -> import is a byte/semantic round-trip for all supported fields;
- invalid files fail without partially mutating settings;
- controls are discoverable without hidden hover-only knowledge.

Do not keep separate browser-only and desktop persistence models for the same settings.

## B. Style user messages as well as agent messages

Session text currently focuses on agent output. Add an explicit user-message style domain using the same typography/style infrastructure.

Minimum controls should match the meaningful subset of agent message controls: font family, size, weight, line height, text color, block/background/border treatment and code/quoted text behavior where applicable.

Provide a clear `Default / Separate` relationship:
- Default: user messages inherit the shared/base Session text theme.
- Separate: user-message overrides become editable and persist independently.

Do not duplicate rendering code. Resolve an effective style and feed both message renderers from the same schema.

## C. Per-session auto-continue

Add a session-scoped override rather than another global boolean.

State model:
- `Default`: inherit current global/default auto-continue policy;
- `On`: this session may auto-continue when the existing safe continuation rules permit;
- `Off`: this session never auto-continues automatically.

Requirements:
- visible from the active session/composer without visiting global Settings;
- persisted with session identity;
- does not leak to another session/project;
- switching the global default does not overwrite explicit per-session On/Off;
- cancellation, user interruption, required-human prompts, hard errors and protocol stop gates still win over auto-continue.

## D. Large pasted text attachment fidelity

The operator reports large pasted text sometimes collapses to an attachment/label such as `pasted text`, with no practical way to inspect/edit it before sending. This is a data-integrity issue, not cosmetic polish.

Required flow:
1. Paste text above the normal inline threshold.
2. ZAICODE may represent it as an attachment/chip for composer performance.
3. The chip shows meaningful metadata such as text attachment, size/line count, not a payload-substituting placeholder.
4. An obvious Expand/Edit action opens the complete text in a large editor directly from the composer.
5. Save writes the edited text back to the attachment payload.
6. Send delivers the exact complete edited text to the runtime/model.
7. Reopen before send returns the exact same content.

Never send the literal placeholder `pasted text` unless those are the actual pasted bytes.

Regression cases:
- text just below and just above threshold;
- very large text;
- CRLF and LF;
- Unicode/Cyrillic/Estonian/Japanese text;
- code fences and JSON;
- trailing newline;
- edit then send;
- duplicate paste attachments;
- cancel edit without mutation.

Use hashes/length assertions in tests so truncation cannot pass visually.

## E. UX clarity

Session text settings, export/import controls, user/agent tabs and the per-session auto-continue control must have plain labels/tooltips and Help anchors. Avoid a wall of unlabeled icons.

## Wave acceptance

- Session text Save survives restart/reopen.
- Export/Import passes a complete round-trip test and gives visible feedback.
- user messages can inherit or use separate styling.
- auto-continue can be overridden independently for each session.
- large pasted text is inspectable/editable and the model receives the exact payload, never a placeholder or truncated body.
- relevant UI/services/desktop tests and repository gates pass.
