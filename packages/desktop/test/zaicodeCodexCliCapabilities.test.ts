import assert from "node:assert/strict";
import test from "node:test";
import { zaicodeCodexCliCapabilities } from "../src/main/zaicodeCodexCliCapabilities.js";

test("only advertised standalone options enable unattended Codex capabilities", () => {
  assert.deepEqual(zaicodeCodexCliCapabilities("  --no-daemon\n  --dangerously-bypass-hook-trust\n"), { noDaemon: true, hookTrustBypass: true });
  assert.deepEqual(zaicodeCodexCliCapabilities("description mentions --no-daemon, and --dangerously-bypass-hook-trusting\n"), { noDaemon: false, hookTrustBypass: false });
  assert.deepEqual(zaicodeCodexCliCapabilities(""), { noDaemon: false, hookTrustBypass: false });
});
