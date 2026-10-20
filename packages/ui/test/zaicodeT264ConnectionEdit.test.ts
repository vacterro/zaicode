import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isZaicodeRouterCallAllowed, type ZaicodeRouterConnection } from "@zcode/shared";
import { buildZaicodeRouterConnectionEdit } from "../src/zaicode/zaicodeRouterConnectionEdit.js";

/**
 * T-264 connection editing: the generated PUT reaches only the one connection,
 * carries only the fields the operator actually changed, never clears a field
 * from a blank draft, and survives the shared allow-list unchanged.
 */

const connection: Pick<ZaicodeRouterConnection, "id" | "name" | "baseUrl"> = {
  id: "16c872af-f22f-41f5-adf2-ed38c6183861",
  name: "My provider",
  baseUrl: "https://api.example.com/v1",
};

test("T-264 edit: a renamed connection PUTs only the name", () => {
  const call = buildZaicodeRouterConnectionEdit(connection, { name: "  Better name ", baseUrl: connection.baseUrl! });
  assert.deepEqual(call, {
    method: "PUT",
    path: "/api/providers/16c872af-f22f-41f5-adf2-ed38c6183861",
    body: { name: "Better name" },
  });
});

test("T-264 edit: a moved endpoint PUTs only the base URL", () => {
  const call = buildZaicodeRouterConnectionEdit(connection, { name: connection.name, baseUrl: "https://api2.example.com/v1" });
  assert.deepEqual(call, {
    method: "PUT",
    path: "/api/providers/16c872af-f22f-41f5-adf2-ed38c6183861",
    body: { baseUrl: "https://api2.example.com/v1" },
  });
});

test("T-264 edit: unchanged or blank draft refuses the PUT instead of clearing fields", () => {
  assert.equal(buildZaicodeRouterConnectionEdit(connection, { name: connection.name, baseUrl: connection.baseUrl! }), null);
  // A blank field means "keep the stored value", so it never shows up in the body...
  const onlyBaseUrl = buildZaicodeRouterConnectionEdit(connection, { name: "", baseUrl: "https://new.example.com/v1" });
  assert.deepEqual((onlyBaseUrl as unknown as { body: Record<string, string> }).body, { baseUrl: "https://new.example.com/v1" });
  // ...and an entirely blank draft sends nothing at all.
  assert.equal(buildZaicodeRouterConnectionEdit(connection, { name: "   ", baseUrl: " " }), null);
});

test("T-264 edit: a connection without a stored base URL gains one only when drafted", () => {
  const oauth = { id: "conn-7", name: "Codex 1", baseUrl: null };
  assert.equal(buildZaicodeRouterConnectionEdit(oauth, { name: "Codex 1", baseUrl: "" }), null);
  assert.deepEqual(buildZaicodeRouterConnectionEdit(oauth, { name: "Codex 1", baseUrl: " https://api.openai.com/v1 " }), {
    method: "PUT",
    path: "/api/providers/conn-7",
    body: { baseUrl: "https://api.openai.com/v1" },
  });
});

test("T-264 edit: the generated call passes the shared router allow-list", () => {
  const call = buildZaicodeRouterConnectionEdit(connection, { name: "Renamed", baseUrl: "" });
  assert.ok(call);
  assert.equal(isZaicodeRouterCallAllowed(call), true);
});

test("T-264 UI: the Providers panel wires the edit helper and the OAuth sign-in affordance", () => {
  const source = readFileSync(new URL("../src/settings/ZaicodeRouterProviders.tsx", import.meta.url), "utf8");
  // Editing goes through the tested helper, never a hand-rolled PUT.
  assert.match(source, /buildZaicodeRouterConnectionEdit\(/);
  // OAuth rows point at 9router's own dashboard (D-8), so the onboarding
  // entry is visible without ZAICODE ever running the flow itself.
  assert.match(source, /authType === "oauth"/);
  assert.match(source, /openZaicodeRouterDashboard/);
});
