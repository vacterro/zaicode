import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  classifyGitCommitFailure,
  classifyGitPreflightFailure,
  classifyGitPushFailure,
  GitOutcomeError,
  repoLabel,
} from "../src/git/repo/gitOutcome.js";

/**
 * Commit/push reports the real outcome (SRC-070 item E).
 *
 * The operator saw a failure where git had not failed: an output cap that
 * SIGTERMs a healthy push, a 15 s preflight timeout on a big repository, and
 * an orphaned child that arrives with no exit code. And every genuine refusal
 * -- nothing to commit, a hook, a non-fast-forward, an auth problem -- arrived
 * as the same raw stderr string, so "commit failed" and "there was nothing to
 * commit" were indistinguishable.
 */

function result(over: Partial<Parameters<typeof classifyGitCommitFailure>[0]> = {}) {
  return {
    exitCode: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    outputTruncated: false,
    durationMs: 10,
    ...over,
  } as Parameters<typeof classifyGitCommitFailure>[0];
}

const LABEL = repoLabel("V:\\repo\\ZAICODE", "V:\\repo\\ZAICODE");

test("E1 a successful command is not a failure", () => {
  assert.equal(classifyGitCommitFailure(result({ exitCode: 0 }), LABEL), null);
  assert.equal(classifyGitPushFailure(result({ exitCode: 0 }), LABEL, "master"), null);
  assert.equal(classifyGitPreflightFailure(result({ exitCode: 0 }), "pushing"), null);
});

test("E2 nothing to commit is its own outcome, and it names the repository", () => {
  const failure = classifyGitCommitFailure(
    result({ stderr: "On branch master\nnothing to commit, working tree clean" }),
    LABEL,
  );
  assert.equal(failure?.code, "nothing-to-commit");
  assert.match(failure!.message, /nothing to commit/i);
  assert.match(failure!.message, /ZAICODE/, "the operator is told which repository was inspected");
});

test("E3 the two ZAICODE repositories are named apart", () => {
  assert.equal(repoLabel("V:\\repo\\ZAICODE", "V:\\repo\\ZAICODE"), "ZAICODE");
  assert.equal(repoLabel("V:\\repo\\ZAICODE\\zcode", "V:\\repo\\ZAICODE\\zcode"), "zcode");
  assert.equal(
    repoLabel("V:\\repo\\ZAICODE", "V:\\repo\\ZAICODE\\packages\\ui"),
    "ZAICODE (packages\\ui)",
  );
  const failure = classifyGitCommitFailure(
    result({ stderr: "nothing added to commit but untracked files present" }),
    repoLabel("V:\\repo\\ZAICODE", "V:\\repo\\ZAICODE\\zcode"),
  );
  assert.match(failure!.message, /zcode/, "the outer repo ignores the product tree, so the name matters");
});

test("E4 a hook refusal says the commit did not happen", () => {
  const failure = classifyGitCommitFailure(
    result({ stderr: ".git/hooks/pre-commit: line 3: pnpm lint\nexit 1" }),
    LABEL,
  );
  assert.equal(failure?.code, "hook-failed");
  assert.match(failure!.message, /did not happen/);
});

test("E5 a missing identity is named as configuration, not as a Git failure", () => {
  const failure = classifyGitCommitFailure(
    result({ stderr: "Author identity unknown\n*** Please tell me who you are." }),
    LABEL,
  );
  assert.equal(failure?.code, "identity-missing");
  assert.match(failure!.message, /user name and email/);
});

test("E6 a non-fast-forward push says nothing was pushed and what to do", () => {
  const failure = classifyGitPushFailure(
    result({ stderr: " ! [rejected]  master -> master (non-fast-forward)\nhint: Updates were rejected" }),
    LABEL,
    "master",
  );
  assert.equal(failure?.code, "non-fast-forward");
  assert.match(failure!.message, /Nothing was pushed/);
  assert.match(failure!.message, /master/);
  assert.match(failure!.message, /Fetch and integrate/);
});

test("E7 an unreachable remote is a connection problem, not a Git one", () => {
  const failure = classifyGitPushFailure(
    result({ stderr: "fatal: unable to access 'https://…': Failed to connect to github.com port 443" }),
    LABEL,
    "master",
  );
  assert.equal(failure?.code, "remote-unreachable");
  assert.match(failure!.message, /connection problem/);
});

test("E8 auth failures are told apart from everything else", () => {
  for (const stderr of [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "remote: Permission to owner/repo.git denied to user x",
    "remote: Invalid username or password",
  ]) {
    const failure = classifyGitPushFailure(result({ stderr }), LABEL, "master");
    assert.equal(failure?.code, "auth-failed", stderr);
    assert.match(failure!.message, /Nothing was pushed/);
  }
});

test("E9 the three false alarms are named as what they are", () => {
  const truncated = classifyGitPushFailure(
    result({ exitCode: null, outputTruncated: true, stderr: "" }),
    LABEL,
    "master",
  );
  assert.equal(truncated?.code, "output-truncated");
  assert.match(truncated!.message, /a limit, not a Git error/);

  const timedOut = classifyGitPushFailure(
    result({ timedOut: true, exitCode: null, timeoutMs: 600_000, durationMs: 600_000 }),
    LABEL,
    "master",
  );
  assert.equal(timedOut?.code, "timed-out");
  assert.match(timedOut!.message, /may still have completed/, "an unknown result is reported as unknown");

  const orphaned = classifyGitPushFailure(result({ exitCode: null, orphaned: true }), LABEL, "master");
  assert.equal(orphaned?.code, "spawn-failed");
  assert.match(orphaned!.message, /Nothing is known about the result/);
});

test("E10 a preflight failure is never reported as a push failure", () => {
  const failure = classifyGitPreflightFailure(
    result({ timedOut: true, exitCode: null, timeoutMs: 15_000, durationMs: 15_000 }),
    "pushing",
  );
  assert.equal(failure?.code, "timed-out");
  assert.match(failure!.message, /before pushing; pushing itself was never attempted/);
  assert.match(failure!.message, /was never attempted/, "the operator is told the push never ran");
});

test("E11 an unrecognised refusal is still honest, and keeps the raw output", () => {
  const failure = classifyGitCommitFailure(result({ stderr: "fatal: something entirely new" }), LABEL);
  assert.equal(failure?.code, "commit-failed");
  assert.match(failure!.detail, /something entirely new/);
});

test("E12 the error carries the classification so the UI does not re-parse stderr", () => {
  const failure = classifyGitPushFailure(result({ stderr: "non-fast-forward" }), LABEL, "main");
  const error = new GitOutcomeError(failure!);
  assert.ok(error instanceof Error);
  assert.equal(error.message, failure!.message);
  assert.equal(error.failure.code, "non-fast-forward");
});

test("E13 nothing anywhere in the product force-pushes", () => {
  const roots = [join(import.meta.dirname, "..", "src")];
  const banned = /--force-with-lease|git\s+push\s+.*--force|\bforcePush\b/;
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (banned.test(readFileSync(full, "utf8"))) offenders.push(full);
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], "a rejected push is the operator's decision, never the app's");
});

test("E14 the push path only ever builds these argument lists", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "git", "repo", "gitCliRepo.ts"), "utf8");
  // From the args block to the end of the command options: the only span where
  // a push flag could be added.
  const start = source.indexOf("args: hasTrackingBranch");
  assert.ok(start > 0, "the push args are the only place a flag could be added");
  const push = source.slice(start, source.indexOf("maxOutputBytes", start));
  assert.match(push, /\["push"\]/);
  assert.match(push, /\["push", "--set-upstream", remoteName \?\? "origin", branchName\]/);
  assert.equal(push.includes("--force"), false);
});
