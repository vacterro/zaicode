// T-278 / SRC-198:R003 —— "Пусть это окно при Shift зажатии тогда показывает полный
// список всех."
//
// The clause is about the AI-limits hover window: while Shift is held it must list
// EVERY discovered account, including the ones an engine hide keeps out of the
// meter, in the operator's configured order. Two ingredients decide that, and both
// are pure functions the Shift branch feeds:
//
//   * the default projection is the filtered one -- `visibleZaicodeAccounts` and the
//     meter's own shown set drop engine-hidden accounts, so the reveal is opt-in;
//   * the reveal projection is `orderZaicodeAccounts(engines.accounts, accountOrder)`
//     -- ALL accounts, engine-hidden included, in configured order.
//
// The third ingredient, the keydown listener that flips the state, has no harness
// here: this package renders nothing without a DOM and adding one is separate Work.
// It is asserted as wiring, plainly, rather than left unsaid.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { orderZaicodeAccounts } from "../src/zaicode/zaicodeMeterPrefs.js";
import {
  visibleZaicodeAccounts,
  type ZaicodeEngineAccount,
  type ZaicodeEnginesState,
} from "../src/zaicode/zaicodeEngines.js";

const src = join(import.meta.dirname, "..", "src");

const account = (
  id: string,
  label: string,
): ZaicodeEngineAccount => ({
  id,
  vendor: "claude",
  short: id.slice(0, 2),
  label,
  source: `~/.${id}`,
  home: null,
  isDefaultHome: false,
  cli: null,
  status: "ready",
  statusDetail: "",
  fixCommand: null,
});

const VISIBLE = account("aaa", "Visible one");
const ALSO_VISIBLE = account("bbb", "Visible two");
const ENGINE_HIDDEN = account("ccc", "Hidden by an engine hide");

const engines = {
  accounts: [VISIBLE, ALSO_VISIBLE, ENGINE_HIDDEN],
  config: { hiddenAccounts: [ENGINE_HIDDEN.id] },
  limits: {},
} as unknown as ZaicodeEnginesState;

test("the meter's default projection stays filtered, so the reveal is opt-in", () => {
  const visible = visibleZaicodeAccounts(engines).map((entry) => entry.id);
  assert.deepEqual(visible, [VISIBLE.id, ALSO_VISIBLE.id]);
  assert.ok(
    !visible.includes(ENGINE_HIDDEN.id),
    "an engine-hidden account leaked into the ordinary projection",
  );
});

test("holding Shift projects every account, engine-hidden included, in configured order", () => {
  const order = [ENGINE_HIDDEN.id, VISIBLE.id];
  const revealed = orderZaicodeAccounts(engines.accounts, order).map((entry) => entry.id);
  assert.deepEqual(revealed, [ENGINE_HIDDEN.id, VISIBLE.id, ALSO_VISIBLE.id]);
  assert.ok(
    revealed.includes(ENGINE_HIDDEN.id),
    "the Shift projection must carry the account an engine hide keeps out of the meter",
  );
});

test("the Shift branch of the hover panel is wired to engines.accounts, not the filtered list", () => {
  const meter = readFileSync(join(src, "zaicode", "ZaicodeLimitMeter.tsx"), "utf8");
  const allAccountsBranch = /hoverShiftAll\s*\?\s*orderZaicodeAccounts\(engines\.accounts\b/;
  assert.ok(
    allAccountsBranch.test(meter),
    "the reveal branch must project every discovered account through the configured order",
  );
  assert.equal(
    allAccountsBranch.test(meter.replace("orderZaicodeAccounts(engines.accounts", "orderZaicodeAccounts(accounts")),
    false,
    "the wiring oracle rejects a filtered collection even when formatting is unchanged",
  );
  // The wiring, not a snapshot: the listener must clear the reveal on keyup and on
  // window blur, or the full list survives the operator letting go.
  assert.ok(
    meter.includes('document.addEventListener("keydown", key)') &&
      meter.includes('document.addEventListener("keyup", key)') &&
      meter.includes('window.addEventListener("blur", blur)'),
    "the Shift reveal must follow keydown, keyup and window blur",
  );
});
