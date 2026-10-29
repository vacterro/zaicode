import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readVerifiedNotices } from "./third-party-notices.mjs";

async function fixture(fields, run) {
  const root = await mkdtemp(join(tmpdir(), "zaicode-notices-"));
  const bytes = Buffer.from("Fixture license notices\n");
  const inventory = { schemaVersion: 1, inputs: {},
    noticesSha256: createHash("sha256").update(bytes).digest("hex"),
    reviewRequired: [], copied: [], exceptions: [], embedded: [], ...fields };
  await mkdir(join(root, "third-party"));
  await writeFile(join(root, "THIRD-PARTY-NOTICES.md"), bytes);
  await writeFile(join(root, "third-party/inventory.json"), JSON.stringify(inventory));
  try { await run(root, bytes); } finally { await rm(root, {recursive: true, force: true}); }
}

for (const field of ["copied", "embedded"]) {
  test(`strict notices cannot hide unresolved ${field} behind an empty summary`, async () => {
    await fixture({ [field]: [{ id: "Fixture component", reviewRequired: "Original notice absent" }] }, async root => {
      await assert.rejects(readVerifiedNotices(root, { requireComplete: true }), /Fixture component: Original notice absent/);
    });
  });
}
test("strict notices reject missing version-specific publisher material", async () => {
  await fixture({ exceptions: [{ package: "fixture@1.0.0", evidenceKind: "publisher metadata" }] }, async root => {
    await assert.rejects(readVerifiedNotices(root, { requireComplete: true }), /fixture@1.0.0/);
  });
});
test("ordinary source builds retain material limitations without claiming release completeness", async () => {
  await fixture({ copied: [{id:"Fixture", reviewRequired:"Unresolved"}] }, async (root, bytes) => {
    assert.deepEqual(await readVerifiedNotices(root), bytes);
  });
});
test("a complete inventory passes strict verification", async () => {
  await fixture({}, async (root, bytes) => {
    assert.deepEqual(await readVerifiedNotices(root, {requireComplete:true}), bytes);
  });
});
