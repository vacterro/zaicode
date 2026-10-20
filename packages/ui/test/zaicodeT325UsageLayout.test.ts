import assert from "node:assert/strict";
import test from "node:test";
import { useZaicodeUsage, openZaicodeUsage } from "../src/zaicode/zaicodeUsage.js";

test("T-325: the accepted column width survives page/sidebar/close and scope changes", () => {
  const previous = useZaicodeUsage.getState();
  try {
    previous.setNameColumnPercent(39);
    for (const mode of ["page", "sidebar", "closed", "sidebar"] as const) {
      openZaicodeUsage(mode);
      assert.equal(useZaicodeUsage.getState().nameColumnPercent, 39);
      assert.equal(useZaicodeUsage.getState().mode, mode);
    }
    for (const scope of ["project", "session", "global"] as const) {
      useZaicodeUsage.setState({ scope });
      assert.equal(useZaicodeUsage.getState().nameColumnPercent, 39);
    }
  } finally {
    useZaicodeUsage.setState(previous, true);
  }
});

test("T-325: invalid width edits preserve the accepted layout and bounded edits preserve scope", () => {
  const previous = useZaicodeUsage.getState();
  try {
    useZaicodeUsage.setState({ scope: "session", mode: "page" });
    previous.setNameColumnPercent(45);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      previous.setNameColumnPercent(invalid);
      assert.equal(useZaicodeUsage.getState().nameColumnPercent, 45);
    }
    previous.setNameColumnPercent(0);
    assert.equal(useZaicodeUsage.getState().nameColumnPercent, 12);
    previous.setNameColumnPercent(100);
    assert.equal(useZaicodeUsage.getState().nameColumnPercent, 70);
    assert.equal(useZaicodeUsage.getState().scope, "session");
    assert.equal(useZaicodeUsage.getState().mode, "page");
  } finally {
    useZaicodeUsage.setState(previous, true);
  }
});
