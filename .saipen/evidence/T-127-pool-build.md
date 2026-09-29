# T-127 -- adding sounds to a random-sound pool (SRC-090): what was wrong, what it is now, how it was checked

Product commit 104fa6c (zcode branch `zaicode`). Diagnosis and proposal: `T-125-T-126-customization-handoff.md` (section T-127).

## The operator's sentence

"The pool for random sounds is added in the least intuitive way: to add another sound I must first add a duplicate, or first confirm
another sound to add." (Settings > Sounds, event Switch project, pool mode.)

## What was wrong (in the code, not a guess)

- The one way to add a member was the button `add "<row.sound>"`: it added the sound the row's ordinary single dropdown pointed at, and
  `pool: [...pool.filter(entry.id !== row.sound), new]` made a second click on the same sound a no-op. To add a DIFFERENT sound the person
  had to change the single dropdown first (which also changed the fallback sound and previewed it), then press add.
- Switching to pool with an empty pool showed one button labelled with a sound nobody meant as a member.
- One member showed "100.00%" and a "pin" that can do nothing; members were hidden behind "show N member(s)".

## What it is now

- **One control adds sounds**: the sound picker in a several-choice mode, labelled "Add sounds to the pool...". Each pick (double-click,
  Enter, or the add/remove button on a row) flips that sound's membership; the list stays open with a check mark on the members, so a
  pool of five is five picks. Same tabs, search, audition and the Mine tab (T-126) as any picker.
- **Members are always listed**: listen button, name, length, weight, the share it really gets, pin, remove. No show/hide step.
  Pin appears with two or more members (or while one is pinned, so it can be let go).
- **Switching keeps what the person had**: single -> pool starts the pool with the sound the event plays (never empty, never lost);
  pool -> single keeps the heaviest member that can play; the pool is kept for the next switch.
- **A fair weight for a newcomer** (the mean of the members that count, not a fixed 1 that gives 1% beside 50 and 30); pinned shares hold
  the percentage they had before the newcomer.
- In pool mode the row's own sound cell reads "Pool: N sounds" (dashed, not a picker), so there is no second "which sound is it" control.
  An imported own file joins the pool instead of silently becoming the fallback. A preset carries a pool, and its own files with it.

## Checks

`pnpm run verify:pre-push` exit 0 (ui 742, services 85, desktop 169 pass 2 skipped, cli 30, oxlint 0 errors, architecture 0 new),
`pnpm run typecheck` exit 0. New suite `zaicodeSrc90PoolBuild.test.ts` (13). Red controls: 12 mutations each turn a named test red (pinned
share on join, newcomer weight, seed, heaviest, missing member as the sound, add-when-present, seeding action, pin with one member, member
list gone, toggle-and-stay-open, row summary, imported file joins the pool).

Real Electron (built `out/`, throw-away profile): Settings > Sounds, first event -> N: the pool starts with 1 member ("1 sound. Add another");
the pool's picker, two double-clicks on two different sounds -> 3 members with 33.33 / 33.34 / 33.33 %; a third double-click on a member removes
it and again adds it; three pin buttons; back to single draws no pool line; N again brings the same three members back. Screenshot read.

## Two oracles moved on purpose

`zaicodeWave3Cues.test.ts` "Wave 3 B" pinned SOURCE TEXT: `soundMode: pool ? "single" : "pool"` in the controls file, and the share/missing/locked markers there.
The flip now goes through `setZaicodeSoundSelectionMode` and the member list lives in `ZaicodePoolMembers.tsx` (it renders in a node test because it has no audio
import). The pin was rewritten to the new text with the same intent (the row offers single and pool; the shown share is the normalizer's), and the behaviour
that used to be implied is now run, not read (P5, P9). The "Src87 compact" pins (single-sound event draws no sub-row; the mode button is a cell; the pool line
follows the last column) passed unchanged.

## Not done

- The pool's stored `missing` flag is still only set by the old paths; a customization sound that vanished from the folder is shown as "(file not found)"
  live but is not written back as missing (the pick still skips nothing it cannot play). Small, left as is.
- Not heard through speakers.
