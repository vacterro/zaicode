import assert from "node:assert/strict";
import test from "node:test";
import type { ZaicodeRouterCall } from "@zcode/shared";
import { useZaicodeRouter, zaicodeRouterChange } from "../src/zaicode/zaicodeRouter.js";

test("renderer supplies the actually observed baseline with a pool drag", async () => {
  const calls: ZaicodeRouterCall[] = [];
  Object.assign(globalThis, {
    window: {
      zcode: {
        callZaicodeRouter: async (call: ZaicodeRouterCall) => {
          calls.push(call);
          return { ok: true, status: 200, data: {}, message: "" };
        },
      },
    },
  });
  useZaicodeRouter.setState({
    combos: [
      { id: "free", name: "SAIFREN", models: ["p/A", "p/B"], kind: null, strategy: "fallback" },
    ],
  });
  await zaicodeRouterChange("Saving pool", {
    method: "PUT",
    path: "/api/combos/free",
    body: { models: ["p/B", "p/A"] },
  });
  assert.deepEqual(calls[0]?.baselineModels, ["p/A", "p/B"]);
  assert.deepEqual(calls[0]?.body, { models: ["p/B", "p/A"] });
});

test("a delayed older refresh cannot replace a newer router projection", async () => {
  let release: () => void = () => {};
  let arrived: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let versions = 0;
  Object.assign(globalThis, {
    window: {
      zcode: {
        callZaicodeRouter: async (call: ZaicodeRouterCall) => {
          if (call.path === "/api/version" && ++versions === 1) {
            arrived();
            await held;
          }
          return {
            ok: true,
            status: 200,
            data:
              call.path === "/api/combos"
                ? { combos: [{ id: "new", name: "NEW", models: ["external/new"] }] }
                : {},
            message: "",
          };
        },
      },
    },
  });
  const old = useZaicodeRouter.getState().refresh();
  await entered;
  await useZaicodeRouter.getState().refresh();
  const newest = useZaicodeRouter.getState().combos;
  release();
  await old;
  assert.equal(useZaicodeRouter.getState().combos, newest);
  assert.equal(newest[0]?.name, "NEW");
});
