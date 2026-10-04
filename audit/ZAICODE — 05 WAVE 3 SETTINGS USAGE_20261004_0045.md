ZAICODE

WAVE 3 — SETTINGS + USAGE PRODUCT UX

Use the existing tickets:
- T-199 / SRC-133
- T-203 / SRC-137
- T-205 / SRC-139
- T-206 / SRC-140

Do not create duplicates.

A. SETTINGS INFORMATION HIERARCHY — T-206

Reorder Settings by operator value.

Primary operational settings must appear before secondary/novelty/game surfaces.

SAIASUI and similar low-frequency sections must not greet a new user near the
top of Settings.

Introduce explicit section priority metadata rather than hard-coded one-off
movement.

Secondary sections:
- collapsible;
- collapsed by default.

Do not collapse critical configuration needed for initial setup.

The ordering should remain stable across localization.

B. SETTINGS SEARCH — T-203

Add an obvious Settings search input.

Search should match:
- section titles;
- setting labels;
- descriptions;
- relevant aliases/synonyms.

Do not expose internal translation keys or code property names as the normal
search result.

Selecting a result should:
- reveal/expand its section;
- scroll/focus the control;
- optionally highlight it briefly.

Search must work across sections that are collapsed by default.

Search indexing must update for current locale.

C. THEME-AWARE NATIVE CONTROLS — T-199

Audit bright white sliders/controls and other native-looking UI that violates the
active theme.

Centralize the required theme tokens.

Cover at least:
- range sliders;
- checkbox/radio-like custom controls;
- progress/meter surfaces;
- focused/hover states where white glare currently appears.

Do not hard-code one brown palette.
The control must derive from the active theme.

Test representative dark, light and Wintage/pixel palettes.

D. USAGE PANEL LIVE CONTROLS — T-205

Existing T-181 Usage UI improvements must be preserved.

Add refresh interval choices:
- 10 s
- 5 s
- 3 s
- 2 s
- 1 s

The selected interval must be visible and persisted appropriately.

Polling safety:
- one authoritative poll owner;
- no overlapping requests;
- a slower response must not accumulate concurrent polls;
- hidden/unmounted Usage surfaces must not keep duplicate pollers alive.

Remove redundant `Done`-style status text where it carries no useful
discriminating information.

Resizable columns:
allow the operator to widen/narrow the model/name/metric presentation so long
identities can fit.

Requirements:
- bounded min/max;
- no layout corruption;
- persist width if current panel layout is persistent;
- reset-to-default affordance;
- responsive fallback at narrow width.

Do not make 1-second polling the global default merely because it is available.

WAVE ACCEPTANCE

- Settings opens with high-value operational sections first;
- secondary sections are collapsed by default;
- search finds and opens controls across all sections/locales;
- no glaring white native controls under supported themes;
- Usage refresh choices work without overlapping poll storms;
- Usage columns resize/persist safely;
- T-181 identity/UUID protections remain green.
