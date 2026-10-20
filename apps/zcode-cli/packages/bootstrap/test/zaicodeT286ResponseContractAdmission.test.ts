import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  responseContractDeclares,
  resolveResponseContractAdmission,
} from "@zcode/shared/zcode-protocol-v4";
import { inputIntentMetadata } from "../src/zcode-protocol-v4/commands/input-intent.js";
import {
  inputIntentMetadataFromCanonical,
  inputIntentMetadataFromQueueItem,
} from "../src/zcode-protocol-v4/commands/input-intent.js";
import {
  hashResponseContractDocument,
  readResponseContractDocuments,
  saipenContractHome,
  resolveSessionResponseContract,
} from "../src/zcode-protocol-v4/response-contract-admission.js";

// T-286 (SAIHANDOFF F-06): a captured session answered in freeform English while
// the copy-time contract declared `reply_language: et` and EXEC-RESPONSE-01, and
// nothing in the record said which contract was in force or whether it could be
// enforced. Acceptance: the required language and structure are recorded from the
// documents that were actually read, and anything the host cannot check is
// reported as a bounded limitation -- never silence, never an assumed language.
//
// These cases drive the REAL admission constructor and the REAL file resolver.

const STYLE_PINNED = [
  "---",
  "reply_language: et",
  "---",
  "",
  "# Style",
  "Chat tone: compressed.",
].join("\n");

const EXECUTION_PINNED = [
  "**EXEC-RESPONSE-01** (default): answer with the outcome first, then detail.",
  "The structure section below is mandatory.",
].join("\n");

test("T-286 A: a pinned language and an active EXEC-RESPONSE-01 are recorded, with what is unenforced", () => {
  const admission = resolveResponseContractAdmission({
    styleText: STYLE_PINNED,
    executionText: EXECUTION_PINNED,
    styleRef: "V:/saipen/saipen/STYLE.md",
    executionRef: "V:/saipen/saipen/EXECUTION.md",
    styleHash: hashResponseContractDocument(STYLE_PINNED),
    executionHash: hashResponseContractDocument(EXECUTION_PINNED),
  });

  assert.equal(admission.admissionMode, "observed");
  assert.equal(admission.replyLanguage, "et", "the pinned language is the recorded language");
  assert.deepEqual(admission.replyLanguageDeclarations, ["et"]);
  assert.deepEqual(admission.structureRules, ["EXEC-RESPONSE-01"]);
  assert.equal(responseContractDeclares(admission, "EXEC-RESPONSE-01"), true);
  assert.match(admission.styleHash ?? "", /^sha256:[0-9a-f]{12}$/);
  assert.match(admission.executionHash ?? "", /^sha256:[0-9a-f]{12}$/);
  assert.equal(admission.styleRef, "V:/saipen/saipen/STYLE.md");

  // The capability side is stated, not implied: today the host checks neither.
  assert.deepEqual(admission.enforcement, { language: "none", structure: "none" });
  assert.ok(admission.limitation, "an observed contract always carries its limitation");
  assert.match(admission.limitation, /not enforced/);
  assert.match(admission.limitation, /et/);
  assert.match(admission.limitation, /EXEC-RESPONSE-01/);
});

test("T-286 B: an unreadable contract is reported with its reason instead of silence", () => {
  const admission = resolveResponseContractAdmission(undefined);
  assert.equal(admission.admissionMode, "unavailable");
  assert.equal(admission.replyLanguage, null, "a language the document does not pin is never assumed");
  assert.deepEqual(admission.structureRules, []);
  assert.equal(admission.styleHash, null);
  assert.equal(responseContractDeclares(admission, "EXEC-RESPONSE-01"), false);
  assert.ok(admission.limitation?.startsWith("response contract not admitted"));
  assert.match(admission.limitation, /no STYLE\.md or EXECUTION\.md was readable/);

  // A half-readable pair keeps the half it read and names the half it did not.
  const partial = resolveResponseContractAdmission({ styleText: STYLE_PINNED });
  assert.equal(partial.admissionMode, "observed");
  assert.equal(partial.replyLanguage, "et");
  assert.match(partial.limitation ?? "", /no EXECUTION\.md was readable/);
});

test("T-286 C: a self-contradicting contract is unavailable, not resolved by a coin toss", () => {
  const admission = resolveResponseContractAdmission({
    styleText: "reply_language: et\n\n...\n\nreply_language: en\n",
    executionText: EXECUTION_PINNED,
  });
  assert.equal(admission.admissionMode, "unavailable");
  assert.deepEqual(admission.replyLanguageDeclarations, ["et", "en"]);
  assert.equal(admission.replyLanguage, null);
  assert.match(admission.limitation ?? "", /refuses to choose/);
  // The structure half is still recorded: the ambiguity is local, not contagious.
  assert.deepEqual(admission.structureRules, ["EXEC-RESPONSE-01"]);
});

test("T-286 D: the resolver reads the real documents, records their bytes and follows a change", () => {
  const home = mkdtempSync(join(tmpdir(), "saipen-t286-home-"));
  const project = mkdtempSync(join(tmpdir(), "saipen-t286-project-"));
  const other = mkdtempSync(join(tmpdir(), "saipen-t286-other-"));
  writeContract(home, STYLE_PINNED, EXECUTION_PINNED);
  writeContract(other, "reply_language: en\n", EXECUTION_PINNED);
  mkdirSync(join(project, ".saipen"), { recursive: true });
  writeFileSync(
    join(project, ".saipen", "STATE.md"),
    `---\nphase: BUILD\nsaipen_home: "${home.replace(/\\/g, "/")}"\n---\n`,
  );

  // The canonical STATE field is resolved ahead of the environment.
  const env = { SAIPEN_HOME: other } as NodeJS.ProcessEnv;
  assert.equal(saipenContractHome(project, env), home.replace(/\\/g, "/"));

  const documents = readResponseContractDocuments({ projectRoot: project, env });
  assert.equal(documents.styleHash, hashResponseContractDocument(STYLE_PINNED));
  assert.match(documents.styleRef ?? "", /STYLE\.md$/);
  assert.match(documents.executionRef ?? "", /EXECUTION\.md$/);

  const first = resolveSessionResponseContract({ projectRoot: project, env });
  assert.equal(first.admissionMode, "observed");
  assert.equal(first.replyLanguage, "et");

  // Copy-time pinning means the record must follow the document it hashed.
  writeContract(home, "reply_language: ru\n", EXECUTION_PINNED);
  const second = resolveSessionResponseContract({ projectRoot: project, env });
  assert.equal(second.replyLanguage, "ru");
  assert.notEqual(second.styleHash, first.styleHash);

  // With no STATE field at all the environment home is used; with neither, the
  // session records an unavailable contract rather than nothing.
  const bare = mkdtempSync(join(tmpdir(), "saipen-t286-bare-"));
  assert.equal(saipenContractHome(bare, {}), null);
  const none = resolveSessionResponseContract({ projectRoot: bare, env: {} as NodeJS.ProcessEnv });
  assert.equal(none.admissionMode, "unavailable");
  assert.ok(none.limitation, "an absent contract is still a record");
});

test("T-286 E: the admission constructor records the contract on every admitted input", () => {
  const envelope = {
    commandId: "cmd-t286",
    clientId: "client-1",
    sessionId: "s-1",
    type: "sendText",
    payload: {},
    issuedAt: 1,
  } as never;

  const injected = resolveResponseContractAdmission({
    styleText: STYLE_PINNED,
    executionText: EXECUTION_PINNED,
  });
  const intent = inputIntentMetadata(envelope, {
    text: "cc",
    requestedDelivery: "startNow",
    responseContract: injected,
  });
  assert.equal(intent.responseContract?.replyLanguage, "et");
  assert.equal(intent.provenance?.origin, "real_user", "T-283 provenance is untouched");

  // Without an injected record the constructor resolves the session's own files:
  // a record is always present, so a capture can never lack it silently.
  const resolved = inputIntentMetadata(envelope, { text: "cc", requestedDelivery: "startNow" });
  assert.ok(resolved.responseContract, "admission never leaves the contract unrecorded");
  assert.ok(resolved.responseContract.limitation);
});

test("T-286 F: a rebuilt or promoted input records the same contract identity", () => {
  const envelope = {
    commandId: "retry-cmd",
    clientId: "client-1",
    sessionId: "s-1",
    type: "retryTurn",
    payload: {},
    issuedAt: 1,
  } as never;
  const inherited = resolveResponseContractAdmission({
    styleText: STYLE_PINNED,
    executionText: EXECUTION_PINNED,
  });

  const retried = inputIntentMetadataFromCanonical(envelope, {
    kind: "sendText",
    text: "cc",
    responseContract: inherited,
  });
  assert.equal(retried.responseContract?.replyLanguage, "et");
  assert.equal(retried.responseContract?.styleHash, inherited.styleHash);

  // A promotion resolves the session's own documents; the record is present even
  // when the caller carries none, so a promoted turn is never unreadable.
  const promoted = inputIntentMetadataFromQueueItem(
    {
      sourceCommandId: "cmd-1",
      queueItemId: "queue_1",
      clientId: "client-1",
      kind: "sendText",
      text: "cc",
      attachments: [],
      delivery: { requested: "queue", admitted: "queue" },
      order: { admissionSeq: 3 },
      admittedAt: 11,
    } as never,
    "cc",
  );
  assert.ok(promoted.responseContract, "promotion still records the contract");
  assert.ok(promoted.responseContract.limitation);
});

function writeContract(home: string, styleText: string, executionText: string): void {
  mkdirSync(join(home, "saipen"), { recursive: true });
  writeFileSync(join(home, "saipen", "STYLE.md"), styleText);
  writeFileSync(join(home, "saipen", "EXECUTION.md"), executionText);
}
