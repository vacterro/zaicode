ZAICODE

# Wave 3 — Audio engine v2 and action feedback

## Goal

Turn the existing sound customization into one coherent, measurable system: normalized loudness, random pools, structured agent-action cues and RPG file-spawn feedback. Reuse the current ZAICODE sound bus/settings rather than adding another playback engine.

## A. Global normalization for currently configured user sounds

Add a single obvious action in Sound Settings that analyzes the user-provided sounds currently assigned to active ZAICODE events, including active pool members, and computes non-destructive per-sound normalization compensation.

Do not rewrite source audio files. Persist analysis metadata and compensation/gain settings.

### Measurement

Do not normalize from peak alone. Use a deterministic loudness estimator suitable for short UI sounds. Prefer an existing project/dependency implementation if one exists; otherwise implement a documented gated-RMS/integrated-loudness approximation and separately guard against peak clipping. Cache analysis by content hash so reopening Settings does not repeatedly decode every file.

Use a robust reference such as the median/trimmed center of the active configured sound set so one pathological sound does not drag the entire set.

### Controls

Provide:
- `Normalize configured sounds` action;
- profile: `Soft`, `Standard`, `Aggressive`;
- user-adjustable negative automatic attenuation cap spanning **-24 dB through -48 dB**;
- before/after measured loudness and proposed gain for every affected sound;
- Preview before Apply;
- Apply atomically;
- Undo/Reset normalization without losing the user's original per-event sound selection.

Interpret the requested negative cap as a limit on automatic attenuation unless the existing mixer already defines a different explicit `cap` contract. Label the actual unit/meaning clearly. Do not silently reinterpret `-24 dB` as a playback loudness target. For upward correction, reuse the existing safe positive gain bounds or add the smallest explicit safe bound required to prevent clipping; never boost without a peak guard.

Soft/Standard/Aggressive must be centralized presets for correction strength, not three unrelated algorithms. Show the effective numbers in Advanced settings.

## B. Per-event sound pools

Every sound-capable event can operate in either:
- Single sound mode;
- Pool mode.

Pool mode requirements:
- add/remove user or bundled sounds;
- every entry has an explicit probability/weight;
- UI displays the normalized effective probability in real time;
- effective probabilities always sum to exactly 100% after rounding policy;
- changing one entry redistributes the remaining unlocked entries proportionally rather than lying about the total;
- one-item pool = 100%;
- all-zero/invalid weights normalize safely to a deterministic fallback;
- deleted/missing sound files are visibly invalid and are not silently selected;
- random choice uses the effective distribution, with deterministic injectable RNG in tests.

Normalization must analyze every active pool member.

## C. Structured agent-action sound and visual effects

Extend the existing semantic event catalog. Do not infer actions by scraping rendered English message text.

Map stable runtime/tool events into independently configurable sound/effect events, including at least the currently observable equivalents of:
- reasoning/thinking start and end (`thought for` presentation derives from this state);
- file read/open;
- search/grep/list;
- file edit/write;
- new file creation;
- shell/terminal command;
- generic tool invocation when no more specific mapping exists;
- plan/todo update where structurally available;
- response start;
- response completion;
- user-attention/request-for-input;
- retry/failure/cancel.

Each event row should support current sound controls, Pool mode, gain/mix controls and the existing configurable visual effect/highlight mechanism where an effect is meaningful. Keep call sites semantic: emit event identity and context, never hard-code filenames/effect styling in runtime code.

Rate-limit noisy repeated events so reading 500 tiny files does not produce unusable audio. Rate limiting must preserve meaningful completion/error cues and be configurable only where that control is useful.

## D. RPG Changes: `spawned` for new files

When the authoritative Changes stream identifies a genuinely added file, emit an RPG-style `spawned` event once for that file.

Requirements:
- create -> `spawned`;
- edit existing file -> existing change behavior, not spawned;
- rename/move uses the change model's real semantics and must not double-fire `spawned` unless the backend truly reports a new file identity;
- repeated snapshots of the same added file do not spawn repeatedly;
- batch creates may coalesce visually, but event accounting stays correct.

Make the spawned label/effect configurable through the existing RPG Changes settings architecture.

## E. Safety and performance

- Decoding/analyzing sounds must not block the renderer main thread for a large configured set.
- Missing/corrupt audio fails per item and does not abort the entire normalization pass.
- Settings changes during playback must not corrupt a currently playing buffer.
- Cache invalidates when file content changes, not merely when the filename changes.

## Wave acceptance

- one action produces a truthful preview and balanced normalization of all currently configured user sounds;
- Soft/Standard/Aggressive and -24..-48 dB negative cap materially affect the preview and apply path;
- pools honor the displayed probability distribution statistically and deterministically in tests;
- agent read/reasoning/tool actions can have distinct configurable sounds/effects;
- new files trigger `spawned` exactly once;
- no parallel sound engine or duplicate settings source is introduced;
- relevant tests and repository gates pass.
