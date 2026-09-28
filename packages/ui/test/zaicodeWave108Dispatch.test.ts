import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import {
  conversationUserTurnInFlight,
  conversationUserTurnKey,
  resetConversationUserTurnLedger,
  sendUserTurnOnce,
} from "../src/v4/conversationUserTurnIdempotency.js";

/**
 * One physical submit, one logical user turn (SRC-070 item B).
 *
 * `saipen crew` was reported as submitting twice. The composer can reach the
 * uplink more than once for one action -- Enter and the send button share a
 * path, key repeat re-enters it, the queued-command effect re-runs on every
 * render of the editor, and a remounted composer replays -- and every pass
 * minted a fresh commandId, so nothing downstream could recognise the second
 * one as the same turn. The gate is in-flight only: a repeat that overlaps the
 * first joins it, a deliberate repeat later is a real new turn.
 */

function ack(commandId: string): CommandAck {
  return { commandId, status: "accepted" } as unknown as CommandAck;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("B1 one submit is one dispatch", async () => {
  resetConversationUserTurnLedger();
  let dispatched = 0;
  const request = sendUserTurnOnce(conversationUserTurnKey("s1", "saipen crew"), async () => {
    dispatched += 1;
    return ack("c1");
  });
  assert.equal((await request).commandId, "c1");
  assert.equal(dispatched, 1);
});

test("B2 rapid double submit and key repeat collapse onto the first request", async () => {
  resetConversationUserTurnLedger();
  const first = deferred<CommandAck>();
  let dispatched = 0;
  const send = () => {
    dispatched += 1;
    return first.promise;
  };
  const key = conversationUserTurnKey("s1", "saipen crew");
  const a = sendUserTurnOnce(key, send);
  const b = sendUserTurnOnce(key, send); // second click
  const c = sendUserTurnOnce(key, send); // key repeat
  assert.equal(dispatched, 1, "one physical action, one dispatch");
  first.resolve(ack("c1"));
  assert.equal((await a).commandId, "c1");
  assert.equal((await b).commandId, "c1", "the duplicate joins the first, it does not fail");
  assert.equal((await c).commandId, "c1");
});

test("B3 the gate is in-flight only: the same words sent later are a real turn", async () => {
  resetConversationUserTurnLedger();
  let dispatched = 0;
  const key = conversationUserTurnKey("s1", "continue");
  await sendUserTurnOnce(key, async () => {
    dispatched += 1;
    return ack("c1");
  });
  assert.equal(conversationUserTurnInFlight("s1", "continue"), false);
  await sendUserTurnOnce(key, async () => {
    dispatched += 1;
    return ack("c2");
  });
  assert.equal(dispatched, 2, "an accepted turn does not swallow the next one");
});

test("B4 a retry after a real transport failure is a new attempt, not a swallowed turn", async () => {
  resetConversationUserTurnLedger();
  const key = conversationUserTurnKey("s1", "saipen crew");
  let dispatched = 0;
  await assert.rejects(
    sendUserTurnOnce(key, async () => {
      dispatched += 1;
      throw new Error("transport closed");
    }),
    /transport closed/,
  );
  assert.equal(conversationUserTurnInFlight("s1", "saipen crew"), false, "a failed attempt is not held open");
  const retried = await sendUserTurnOnce(key, async () => {
    dispatched += 1;
    return ack("c2");
  });
  assert.equal(retried.commandId, "c2");
  assert.equal(dispatched, 2, "the retry is allowed through");
});

test("B5 different turns are never folded together", async () => {
  resetConversationUserTurnLedger();
  const first = deferred<CommandAck>();
  let dispatched = 0;
  const send = () => {
    dispatched += 1;
    return first.promise;
  };
  sendUserTurnOnce(conversationUserTurnKey("s1", "cc"), send);
  sendUserTurnOnce(conversationUserTurnKey("s2", "cc"), send);
  sendUserTurnOnce(conversationUserTurnKey("s1", "saipen crew"), send);
  sendUserTurnOnce(conversationUserTurnKey("s1", "CC"), send);
  assert.equal(dispatched, 4, "a different session, a different text and a different case are different turns");
  first.resolve(ack("c1"));
  await first.promise;
});

test("B6 a draft turn and the same text in a real session are different turns", () => {
  assert.notEqual(conversationUserTurnKey(null, "saipen crew"), conversationUserTurnKey("s1", "saipen crew"));
  assert.equal(conversationUserTurnKey(null, "x"), conversationUserTurnKey(null, "x"));
});

test("B7 the ledger outlives a composer remount, so a replayed submit still folds", async () => {
  resetConversationUserTurnLedger();
  const first = deferred<CommandAck>();
  let dispatched = 0;
  const send = () => {
    dispatched += 1;
    return first.promise;
  };
  const key = conversationUserTurnKey("s1", "saipen crew");
  sendUserTurnOnce(key, send);
  // The tree unmounts and mounts again; the ledger is module state, not a ref.
  sendUserTurnOnce(key, send);
  assert.equal(dispatched, 1);
  first.resolve(ack("c1"));
  await first.promise;
});

test("B8 the uplink routes the user turn through the gate and leaves other commands alone", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/v4/SessionPane.tsx"), "utf8");
  assert.match(source, /type === "sendText" && typeof payload\.text === "string"/);
  assert.match(source, /sendUserTurnOnce\(\s*conversationUserTurnKey\(targetSessionId, payload\.text\)/);
  // stop / clear / createSession must never be folded: they are not user turns.
  assert.equal(source.includes('type === "sendText" &&'), true);
  const gate = source.match(/ack =\s*\n?\s*type === "sendText"[\s\S]{0,400}?sendCommand\(envelope\)/);
  assert.ok(gate, "the duplicate path and the plain path both end at sendCommand");
});
