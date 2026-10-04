# T-208 concurrent implementation review

Canonical position at inspection: SCOUT T-208, owner `saipen-cli`, event E-3236.
The initial product status did not include the preset implementation files.
Subsequent status and reads showed new modifications to those files and a new
`packages/ui/src/zaicode/zaicodePresetRehydrate.ts`, without any source write
from this reviewer. Preserve those changes until the active writer is coordinated.
`saipen autonomy --json` reports RUN_WORK, may_mutate true, but no runtime lease
or worker identity. It does not identify the other process changing the tree.

## Confirmed defect in the incoming timer rehydration

`reloadZaicodeTimerPrefs()` invokes `useZaicodeTimers.setState(load())`.
`load()` calls `createZaicodeProductivity`, whose restart semantics intentionally
set the timer to idle and reset its phase and remaining time. Reusing that
startup loader during a live preset apply interrupts an active timer.

Read-only reproduction from `zcode/packages/ui`:

```sh
node --import tsx --input-type=module -e 'import assert from "node:assert/strict"; import { useZaicodeTimers, reloadZaicodeTimerPrefs } from "./src/zaicode/zaicodeTimerStore.ts"; const timer = { ...useZaicodeTimers.getState().productivity, state: "running", phase: "break", remaining: 91, completedCycles: 4 }; useZaicodeTimers.setState({ productivity: timer }); reloadZaicodeTimerPrefs(); const after = useZaicodeTimers.getState().productivity; console.log(JSON.stringify({before: {state:timer.state,phase:timer.phase,remaining:timer.remaining,completedCycles:timer.completedCycles},after: {state:after.state,phase:after.phase,remaining:after.remaining,completedCycles:after.completedCycles}})); assert.equal(after.state, timer.state, "preset refresh must preserve an active productivity timer");'
```

Observed exit 1:

```json
{"before":{"state":"running","phase":"break","remaining":91,"completedCycles":4},"after":{"state":"idle","phase":"work","remaining":2730,"completedCycles":0}}
```

Required correction: distinguish stored preferences from live timer facts.
Preserve the timer run state, phase, remaining time, completed cycles, pending
alarm, active timer identities and live interval state when re-reading settings.
Test applying/resetting/undoing a timer preset with an active countdown.
The timer preset key also carries runtime counters and rules; audit the
section's local exclusions rather than assuming the key contains preferences only.

The old renderer reload fallback remains in `zaicodePresetEnv.ts` and
`zaicodePresetApply.ts`. The incoming dispatch currently returns true for all
families, making that fallback unreachable on the observed normal path, but
its presence requires review against the explicit never-restart criterion.
No packaged acceptance, completion, or PASS is claimed by this review.
