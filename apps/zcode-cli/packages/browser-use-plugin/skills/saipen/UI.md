# saipen UI -- Golden Default (Wintage)

Applies to every interface: web, app, panel, dialog, HTML report, TUI, desktop tool, or embedded utility.

**Golden Default is the default palette.** Its values are copied exactly from
Wintage's shipped `themes/goldendefault.json`, not reconstructed from a generic
"dark golden" description. It is not one preset among several: it is what a
saipen interface looks like unless the user explicitly asks for another theme.
There is no second palette in this document to choose from.

**Vintage Golden names the design language; Golden Default names its palette.**
The design language supplies compact Win95 geometry, instant states and bevel
rules. The 21 values below supply colour. If a generic vintage-theme skill,
remembered prompt, screenshot estimate or old implementation gives
different colour values, this file wins. A model that follows those different
values has not followed the saipen UI contract.

## Intent

This UI is meant to feel:
- direct, legible, and calm
- compact without becoming cramped
- vintage without becoming decorative noise
- easy to scan on screenshots
- easy to maintain in code

The goal is not nostalgia as a costume. The goal is clarity that happens to look old-school.

## Core principles

1. **Hierarchy first.** Every screen must make the primary action obvious in under 2 seconds.
2. **One purpose per control.** A button, field, or label should do one thing only.
3. **Low noise.** No decoration that does not improve scanning, editing, or error prevention.
4. **Tight but breathable.** Compact layouts are required, but text must never feel jammed.
5. **Predictable behavior.** Same control type, same look, same behavior, everywhere.
6. **Token-only colors.** No ad hoc colors, no one-off hex values, no “just this one exception.”
7. **Screenshot legibility.** The UI must still read clearly when viewed as a static image.
8. **Maintenance-friendly.** Future edits should be obvious from the component structure alone.

## Iron laws

1. **Verdana, non-antialiased, everywhere, `!important`.** No subpixel smoothing. Sizes only 10/11/12/14/16px.
2. **Zero rounded corners, zero shadow, zero gradients, zero blur, zero transparency, zero animation, zero transition.**
3. **Depth is 2px bevel only.** Raised and sunken states are the only depth language allowed.
4. **Compact by default.** Fit **640x540 CSS pixels** without horizontal
   scroll. Prefer dense vertical rhythm over wide empty space. The number is
   the viewport the layout must survive, not the window it is designed for:
   540 rows because a 480 target kept forcing a scrollbar the moment a title
   bar, a status strip and one section header shared a screen. Vertical scroll
   is allowed and normal. Horizontal scroll on the page is not, ever.
5. **Color comes only from Golden Default tokens.** Every visible color must trace back to the palette below.
6. **Visible states must be instant.** Hover, focus, active, disabled, selected, and error must never rely on motion.
7. **Labels beat placeholders.** Placeholder text is never allowed to be the only explanation.
8. **No visual decoration without function.** If it does not clarify state or improve reading, remove it.

## Predictability -- the interface has no right to surprise the user

The rules above stop the UI from *looking* alive. These stop it from *acting*
alive. A computer is a tool. A hammer does not decide. Press the button, get
the result -- the same result, every time, and nothing else.

The failure this section prevents is not ugliness, it is **the user losing
their model of what the machine will do.** Once that is gone they stop
trusting the tool and start probing it, and every later design decision is
built on that distrust.

1. **Nothing happens unless the user asked for it.** No background refresh
   that changes what is on screen, no autosave that silently rewrites state,
   no polling that swaps content under a reading eye. If data went stale, say
   so and offer a control -- never act unasked. Data the user did not request
   arrives as an *offer*, not as a *change*.
2. **The layout never moves after it is drawn.** Late-arriving content must
   not reflow the page, push a button under a cursor already travelling
   toward it, or resize a panel because text got longer. Reserve the space
   up front. This is the single most common real-world surprise, and it costs
   a misclick every time -- which is not cosmetic if the button was `Delete`.
3. **Same input, same outcome.** A control does not change meaning with
   context, usage history, or how recently it was clicked. No adaptive menus
   that reorder by frequency, no button that becomes something else once a
   state flips. If two behaviors are needed, that is two controls.
4. **Nothing disappears on a timer.** Messages, errors, dialogs, and results
   stay until the user dismisses them. An auto-vanishing toast is a message
   the user is allowed to miss, so it was either unimportant (do not show it)
   or important (do not hide it). Undo lives in a menu, not in a countdown.
5. **State changes are visible or they did not happen.** If the tool modified
   something, the screen says what and where, in text. Silent success is
   indistinguishable from silent failure.
6. **Focus belongs to the user.** Nothing steals the caret, raises a window,
   or opens a dialog mid-keystroke. A background event that needs attention
   waits in a status region until looked at.
7. **Irreversible actions state their consequence before doing it**, in the
   confirm text, naming the actual object: `Delete 3 files from src/?` --
   never `Are you sure?`. And a destructive default is never the focused
   button.
8. **Long work reports progress in text, not motion.** `Reading 41/120
   files`, or a static `...` if the count is unknown. A spinner conveys "the
   process is not dead" and nothing else; a number conveys that plus how
   long, plus whether it is stuck.
9. **The one sanctioned movement is `button:active`'s 1px shift.** It is
   instant, it is physical feedback for a press the user themselves caused,
   and it is the entire motion budget. It is not precedent for anything else.

## Tokens + base CSS -- Golden Default

Paste this into every saipen UI implementation. These 21 values ARE Golden
Default. Naming the palette means these exact numbers, and an interface that
has drifted from them is wrong rather than merely different.

Canonical upstream evidence: Wintage `themes/goldendefault.json`. This copy is
self-contained so an injected agent does not need the Wintage repository, but
the values remain byte-for-byte identical to that shipped theme.

**Closed colour set.** An implementation MUST NOT alter these values or add a
second colour system. Domain-specific token names may alias one of these 21
values. A genuinely new colour requires the user's explicit theme request;
"the model thought it looked better" is never authorization.

```css
:root {
  --background:#1A1810;
  --backgroundSoft:#232018;
  --surface:#332E22;
  --surfaceRaised:#3D372A;
  --surfaceAlt:#453D30;

  --borderDark:#100E08;
  --borderHighlight:#F0D060;
  --bevelLight:#75663D;
  --borderMuted:#5A5040;

  --textPrimary:#D4C89A;
  --textSecondary:#9C9371;
  --textMuted:#6E674E;

  --accentTeal:#008080;
  --accentTealDeep:#004C4C;

  --success:#4A7A20;
  --warning:#7A7A20;
  --danger:#7A2020;
  --dangerText:#D66464;

  --selection:#3D372A;
  --compareBack:#14120C;
  --link:#F0D060;
}

* {
  font-family: Verdana, sans-serif !important;
  -webkit-font-smoothing: none !important;
  -moz-osx-font-smoothing: unset !important;
  font-smooth: never !important;
  text-rendering: optimizeSpeed !important;

  border-radius: 0 !important;
  transition: none !important;
  animation: none !important;
  box-shadow: none !important;
  text-shadow: none !important;
  box-sizing: border-box;
  margin: 0;
}

html, body {
  background: var(--background);
  color: var(--textPrimary);
  font-size: 12px;
  line-height: 1.2;
}

/* Iron law 4 forbids horizontal scroll; `overflow-x: hidden` did not enforce
   that, it hid the evidence. A too-wide element stopped producing a scrollbar
   and started producing unreachable content instead -- a column, a button or
   an error message clipped off the right edge with nothing on screen saying
   so, and a QA gate that could never fail. Overflow is prevented by layout,
   or it is scrolled inside the one element that is genuinely wide. */
body {
  overflow-x: auto;
}

/* The sanctioned escape for content that is honestly wider than the viewport:
   a table, a diagram, a code block. It scrolls itself; the page does not. */
.wide-scroll {
  overflow-x: auto;
  max-width: 100%;
}

.raised, button {
  border: 2px solid;
  border-color: var(--bevelLight) var(--borderDark) var(--borderDark) var(--bevelLight);
  background: var(--surfaceRaised);
}

.sunken, input, select, textarea {
  border: 2px solid;
  border-color: var(--borderDark) var(--bevelLight) var(--bevelLight) var(--borderDark);
  background: var(--surface);
}

button {
  padding: 2px 6px;
  min-width: 24px;
  min-height: 20px;
  color: var(--textPrimary);
  cursor: pointer;
}

/* The accessibility floor asks for 24px on primary targets and the compact
   default above is 20px. Both numbers are right and they are about different
   controls; leaving that unsaid meant every implementation picked one and
   silently broke the other. 20px is the dense default for secondary controls,
   24px is mandatory for the primary action on a screen. */
button.primary {
  min-height: 24px;
}

button:hover {
  background: var(--surfaceAlt);
}

button:active {
  border-color: var(--borderDark) var(--bevelLight) var(--bevelLight) var(--borderDark);
  background: var(--surface);
  transform: translate(1px, 1px);
}

button:focus-visible {
  outline: 1px dotted var(--textPrimary);
  outline-offset: -4px;
}

input, select, textarea {
  height: 20px;
  padding: 1px 3px;
  background: var(--compareBack);
  color: var(--textPrimary);
}

textarea {
  min-height: 64px;
  resize: none;
}

::selection {
  background: var(--selection);
  color: var(--textPrimary);
}

a, a:link, a:visited {
  color: var(--link);
}
```

## Typography rules

- Use a very small number of sizes: 10, 11, 12, 14, and 16px only.
- 12px is the default body size.
- 10px is for secondary metadata only.
- 14px is for section headers or important labels.
- 16px is reserved for the title bar or the main screen title.
- Never use mixed type styles just to “make it feel modern.” Modern is not a quality metric.
- Use weight sparingly. The interface should read through spacing, borders, and layout first, not font tricks.
- Keep line length short. Dense blocks of text are harder to scan than dense blocks of controls.

## Layout rules

- Padding is usually 1-2px inside controls, 4px in groups, 8px between sections, and 12-16px at outer margins.
- Prefer vertical stacking over wide horizontal spreading.
- Use aligned edges. Misalignment reads as bug, not style.
- Groups should share borders where practical.
- Every panel should show clear containment: window, section, group, control.
- Keep the number of simultaneous visual layers low. One background, one surface, one highlight is enough.
- Avoid empty space that has no structural job.
- The strongest information should be nearest the top-left within any screen region.

## Component rules

### Buttons
- Raised by default.
- Pressed state must be sunken with a 1px label shift.
- Button labels must use verbs: `Save file`, `Refresh list`, `Retry connection`.
- Never use generic labels like `OK` unless there is no meaningful action name available.
- Loading state is static `...`, never a spinner.
- Disabled buttons must remain visible, just quieter -- **quieter via
  `--textMuted` on the same raised surface, never via `opacity`.** Iron law 2
  bans transparency, and a faded control also fails the accessibility floor
  and vanishes in screenshots. A disabled control keeps its border and its
  place; only the label colour drops.
- A disabled button must be explainable. If the user cannot tell why it is
  disabled from what is on screen, say it in text next to the control --
  a dead button with no stated reason is a surprise the user cannot resolve.

### Inputs
- Inputs are always sunken.
- A visible label is mandatory.
- Placeholder text may suggest an example, but it must never replace a label.
- Focus state must be obvious and immediate.
- Prefer short inputs over wide empty boxes.
- Group related inputs tightly so the form reads as one unit.

### Tabs
- Active tab is sunken.
- Inactive tab is raised.
- Tabs touch or nearly touch. No gap that breaks the strip.
- Keep tab names short and task-based.

### Windows and dialogs
- Title bars are 20px tall and use `--surface`.
- Dialog bodies use `--surfaceRaised`.
- Outer margins stay within 12-16px.
- Dialogs should have one primary action and at most one secondary action.
- If a dialog needs more than one decision layer, it is probably the wrong component.

### Tables and lists
- Rows: 16-18px.
- Headers: raised.
- Selected row: sunken bevel **first**, `--selection` second. The bevel is what
  carries the selection; the colour only reinforces it. `--selection` and
  `--surfaceRaised` are declared to the same value in the palette above, so a
  selected row drawn on a raised surface with colour alone is invisible -- the
  user sees nothing selected and acts on the wrong row. Fix it in the rule,
  never in the palette: the 21 values are closed, and inventing a 22nd colour
  to resolve this is the exact drift the closed-set rule exists to stop.
- Keep column counts low.
- Use numeric alignment for numbers and dates.
- Avoid icons in every cell. Repetition creates noise and fatigue.
- Sort indicators must be tiny and unambiguous.

### Logs and diagnostics
- Display values on `--compareBack`.
- Use monospace only for raw technical values if absolutely necessary. If a fixed-width font is not required, keep Verdana.
- Errors should be specific and actionable.
- Never say “Something went wrong.”
- Every error should include the cause, the visible symptom, and one fix instruction.

### Status, alerts, and feedback
- Use color sparingly and consistently.
- Success, warning, and danger must mean different things and never overlap.
- Do not decorate alerts with extra visual drama.
- If a message is important, say it clearly. If it is not important, do not show it at all.

### Icons and ornament
- Use icons only when they reduce reading time or improve recognition.
- Prefer text labels over icon-only controls.
- Do not combine decorative icons with decorative borders with decorative color changes. Pick one signal, not three.
- Strip any symbol that does not help the task.

## Information architecture rules

- Primary tasks belong on the main surface.
- Secondary tools belong in a clear side region or lower strip.
- Rare actions should be hidden behind explicit control, not mixed with daily work.
- The screen should answer:
  1. What is this?
  2. What can I do here?
  3. What is selected?
  4. What changed?
- If a screen cannot answer those four questions, it is under-structured.

## Accessibility floor

Compactness never excuses illegibility.

- WCAG AA contrast minimum.
- Visible keyboard focus on every control.
- Full keyboard reach for all important actions.
- Primary targets: at least 24px (`button.primary` in the base CSS). This is
  the one place compactness yields.
- Secondary targets: at least 16px; the 20px default `button` clears it.
- Error text must be readable without color alone.
- Do not rely on fine visual distinctions that disappear in screenshots.
- Keep the selected state and focused state distinct.

## Maintenance rules

- Build with reusable components, not one-off screen hacks.
- Every token used in a component should come from the shared palette.
- Every spacing value should come from a small documented scale.
- Every state should have a single implementation path.
- If a style needs a special case, first check whether the component API is missing a real prop.
- Keep class names semantic and boring. Boring names are maintainable.
- Put the component rule next to the component, not buried in folklore.
- Favor explicit constants over magic numbers.

## QA before DONE

Before a screen is considered finished:

- No rounded corners.
- No animation frame.
- Verdana renders non-antialiased.
- The interface fits 640x540 CSS pixels with no horizontal scroll on the
  page. Checked by narrowing the viewport to 640 and looking for a bottom
  scrollbar -- not by trusting `overflow`, which can only hide one.
- Every hex value traces to a token.
- Labels are visible and specific.
- The primary action is obvious.
- The selected, focused, and disabled states are visually distinct, and the
  selected one is still identifiable with every colour removed.
- The UI remains readable as a screenshot.
- The UI remains understandable when stripped of color.
- Nothing on the screen moved, changed, or vanished without the user acting.
- Loaded the screen twice: it drew identically both times, and nothing
  reflowed after the first paint.
- Every message still on screen is there because nobody dismissed it yet.
- Every disabled control has a visible reason.
- Left the screen open and untouched for a minute: nothing happened.
- No control depends on hover alone.
- The result should feel calm, direct, and old-school in a disciplined way.

Log line:
`RUN: UI check <component> -> PASS/FAIL <detail>`

## Revision notes

This version tightens the original spec in four ways:
- less ambiguity in typography and layout
- more explicit accessibility and state rules
- stronger maintenance guidance for future edits
- fewer places where a designer or code generator can invent extra noise

And one rule that generates the rest: **a rule this document's own base CSS
violates is not a rule, it is a preference.** Four such contradictions were
found and closed at their own sites (T-1262); check for a fifth before adding
anything here.

## Final rule

If a detail does not help the user read, choose, or maintain the interface, remove it.
