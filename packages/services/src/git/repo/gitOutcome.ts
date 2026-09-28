import type { GitCommandExecutionResult } from "../providers/gitCommandProvider.js";

/**
 * What actually happened to a commit or a push (SRC-070 item E).
 *
 * Every non-zero exit used to collapse into one `git <verb> failed: <stderr>`
 * string that the UI dropped into a `{error}` template, so an operator could
 * not tell "the commit did not happen" from "there was nothing to commit" from
 * "the push was rejected because the remote moved" from "the network blipped".
 * Three of those were also plain false alarms: an output cap that SIGTERMs a
 * healthy push, a 15 s preflight timeout on a large repository, and an
 * orphaned child that arrives with no exit code at all.
 *
 * The classifier is what the honest report is built from. It never changes
 * what git did; it only names it. There is deliberately no force flag here:
 * a rejected push is the operator's decision to make, never the app's.
 */

export type GitCommitFailureCode =
  | "nothing-to-commit"
  | "identity-missing"
  | "hook-failed"
  | "pathspec-error"
  | "merge-in-progress"
  | "auth-failed"
  | "timed-out"
  | "output-truncated"
  | "spawn-failed"
  | "commit-failed";

export type GitPushFailureCode =
  | "non-fast-forward"
  | "auth-failed"
  | "no-upstream"
  | "hook-failed"
  | "remote-unreachable"
  | "timed-out"
  | "output-truncated"
  | "spawn-failed"
  | "push-failed";

export interface GitFailure {
  code: GitCommitFailureCode | GitPushFailureCode;
  /** A stable, operator-readable sentence. The UI shows this verbatim. */
  message: string;
  /** The raw git output, kept for the detail view. */
  detail: string;
}

function detailOf(result: GitCommandExecutionResult): string {
  return (
    result.stderr.trim() ||
    result.stdout.trim() ||
    `exitCode=${result.exitCode ?? "null"}`
  );
}

/**
 * Which repository the message is about, in words. The ZAICODE workspace is
 * two repositories: the outer one and the nested product checkout it ignores,
 * and "there is nothing to commit" means something completely different in
 * each. Naming it removes the most common wrong guess.
 */
export function repoLabel(repoRoot: string, workspacePath: string): string {
  const root = repoRoot.replace(/[\\/]+$/, "");
  const cut = Math.max(root.lastIndexOf("\\"), root.lastIndexOf("/"));
  const name = cut >= 0 ? root.slice(cut + 1) : root;
  const opened = workspacePath.replace(/[\\/]+$/, "");
  if (opened === root || !opened.startsWith(root)) return name;
  const inner = opened.slice(root.length).replace(/^[\\/]+/, "");
  return inner ? `${name} (${inner})` : name;
}

/**
 * The three states that are not "git refused": the command never got to run,
 * or was cut off while running. They must never be reported as a git failure
 * with a git error message attached.
 */
function transportFailure(
  result: GitCommandExecutionResult,
): GitFailure | null {
  if (result.timedOut) {
    return {
      code: "timed-out",
      message: `Git did not finish in time (${result.timeoutMs ?? result.durationMs}ms). The command may still have completed; check the repository before retrying.`,
      detail: detailOf(result),
    };
  }
  if (result.outputTruncated) {
    return {
      code: "output-truncated",
      message:
        "Git produced more output than the limit and was stopped. This is a limit, not a Git error; raise the limit or narrow the change.",
      detail: detailOf(result),
    };
  }
  if (result.exitCode === null || result.orphaned) {
    return {
      code: "spawn-failed",
      message:
        "The Git process ended without reporting an exit code. Nothing is known about the result; check the repository before retrying.",
      detail: detailOf(result),
    };
  }
  return null;
}

export function classifyGitCommitFailure(
  result: GitCommandExecutionResult,
  repoLabel: string,
): GitFailure | null {
  if (result.exitCode === 0) return null;
  const transport = transportFailure(result);
  if (transport) return transport;
  const detail = detailOf(result);
  if (
    /nothing to commit|nothing added to commit|no changes added to commit|working tree clean/i.test(
      detail,
    )
  ) {
    return {
      code: "nothing-to-commit",
      message: `There is nothing to commit in ${repoLabel}: the working tree has no staged or unstaged change.`,
      detail,
    };
  }
  if (
    /please tell me who you are|unable to auto-detect email address|no name was given|no email was given/i.test(
      detail,
    )
  ) {
    return {
      code: "identity-missing",
      message:
        "Git has no author configured for this repository. Set a user name and email, then commit again.",
      detail,
    };
  }
  if (
    /\.git\/hooks\/|hook (failed|rejected)|pre-commit|commit-msg/i.test(detail)
  ) {
    return {
      code: "hook-failed",
      message: `A Git hook rejected the commit in ${repoLabel}. The commit did not happen; fix what the hook reported and commit again.`,
      detail,
    };
  }
  if (
    /did not match any file|pathspec .* did not match|unknown revision/i.test(
      detail,
    )
  ) {
    return {
      code: "pathspec-error",
      message: `The commit named files that do not exist in ${repoLabel}, or the pathspec matched nothing.`,
      detail,
    };
  }
  if (
    /merge in progress|cherry-pick is in progress|rebase in progress|you have not concluded your merge/i.test(
      detail,
    )
  ) {
    return {
      code: "merge-in-progress",
      message:
        "A merge, rebase or cherry-pick is still in progress. Finish or abort it before committing.",
      detail,
    };
  }
  if (
    /permission denied|could not read username|terminal prompts disabled|authentication failed|403 forbidden/i.test(
      detail,
    )
  ) {
    return {
      code: "auth-failed",
      message:
        "Git refused the operation for authentication or permission reasons.",
      detail,
    };
  }
  return {
    code: "commit-failed",
    message: `The commit in ${repoLabel} did not succeed.`,
    detail,
  };
}

export function classifyGitPushFailure(
  result: GitCommandExecutionResult,
  repoLabel: string,
  branchName: string,
): GitFailure | null {
  if (result.exitCode === 0) return null;
  const transport = transportFailure(result);
  if (transport) return transport;
  const detail = detailOf(result);
  if (
    /non-fast-forward|fetch first|rejected .*fetch first|behind its remote counterpart|\[rejected\].*non-fast-forward/i.test(
      detail,
    )
  ) {
    return {
      code: "non-fast-forward",
      message: `The remote moved ahead of the local ${branchName}. Nothing was pushed. Fetch and integrate the remote commits, then push again.`,
      detail,
    };
  }
  if (
    /no upstream|has no upstream branch|current branch .* has no upstream/i.test(
      detail,
    )
  ) {
    return {
      code: "no-upstream",
      message: `${branchName} has no upstream branch, so there was nowhere to push. Set an upstream first.`,
      detail,
    };
  }
  if (
    /could not read username|terminal prompts disabled|authentication failed|permission|denied|403 forbidden|invalid username or password/i.test(
      detail,
    )
  ) {
    return {
      code: "auth-failed",
      message:
        "The remote refused the push for authentication or permission reasons. Nothing was pushed.",
      detail,
    };
  }
  if (/pre-push|\.git\/hooks\/|hook (failed|rejected)/i.test(detail)) {
    return {
      code: "hook-failed",
      message: `A pre-push hook rejected the push from ${repoLabel}. Nothing was pushed.`,
      detail,
    };
  }
  if (
    /could not resolve host|connection (refused|reset|timed out)|network is unreachable|failed to connect|early eof|ssl/i.test(
      detail,
    )
  ) {
    return {
      code: "remote-unreachable",
      message: `The remote could not be reached from ${repoLabel}, so nothing was pushed. This is a connection problem, not a Git problem.`,
      detail,
    };
  }
  if (
    /\[remote rejected\]|denyCurrentBranch|branch is currently checked out|protected branch/i.test(
      detail,
    )
  ) {
    return {
      code: "push-failed",
      message: `The remote rejected the push of ${branchName}. Nothing was pushed; the remote's rule has to be satisfied first.`,
      detail,
    };
  }
  return {
    code: "push-failed",
    message: `The push of ${branchName} from ${repoLabel} did not succeed. Nothing is known to have been pushed.`,
    detail,
  };
}

/** A failure that belongs to the preflight rather than to git push itself. */
export function classifyGitPreflightFailure(
  result: GitCommandExecutionResult,
  verb: string,
): GitFailure | null {
  if (result.exitCode === 0) return null;
  const transport = transportFailure(result);
  if (transport) {
    return {
      ...transport,
      message: `${transport.message} This happened while reading the repository status before ${verb}; ${verb} itself was never attempted.`,
    };
  }
  return {
    code: "push-failed",
    message: `Reading the repository status before ${verb} failed, so ${verb} was never attempted.`,
    detail: detailOf(result),
  };
}

/** Carries the classification so the UI can branch without re-parsing stderr. */
export class GitOutcomeError extends Error {
  readonly failure: GitFailure;

  constructor(failure: GitFailure) {
    super(failure.message);
    this.name = "GitOutcomeError";
    this.failure = failure;
  }
}
