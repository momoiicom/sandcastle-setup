// Parallel Planner with Completion Check + Review
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Check):  For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs, then a
//                               read-only completion checker verifies the work.
//                               If incomplete, feedback is sent back to the
//                               implementer for another attempt.
//   Phase 3 (Review):           Completed branches are reviewed in the same
//                               sandbox on the same branch (1 iteration). All
//                               issue pipelines run concurrently via
//                               Promise.allSettled().
//   Phase 4 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   pnpm exec tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "pnpm exec tsx .sandcastle/main.mts" }

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

const completionCheckSchema = z
  .object({
    complete: z.boolean(),
    summary: z.string(),
    missing: z.array(z.string()),
    feedback: z.string(),
  })
  .superRefine((check, ctx) => {
    if (check.complete && check.missing.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "A complete verdict must not include missing items.",
        path: ["missing"],
      });
    }
  });

type CompletionCheck = z.infer<typeof completionCheckSchema>;

type GitHubRepo = {
  owner: string;
  name: string;
};

type GitHubIssueLabels = {
  ensureInProgressLabel(): Promise<void>;
  addInProgress(issueId: string): Promise<void>;
  removeInProgress(issueId: string): Promise<void>;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Maximum implement→completion-check passes for one issue before giving up.
const MAX_IMPLEMENT_ATTEMPTS = 3;

const IN_PROGRESS_LABEL = "in-progress";
const IN_PROGRESS_LABEL_COLOR = "0969da";
const IN_PROGRESS_LABEL_DESCRIPTION = "Work is currently in progress";
const REVIEW_CLEAN_SIGNAL = "<review>NO_ACTIONABLE_FINDINGS</review>";

// Hooks run inside the sandbox before the agent starts each iteration.
// CI=true lets pnpm purge/recreate node_modules without a TTY.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "pnpm install" }] },
};

const sandboxProvider = docker({
  env: {
    CI: "true",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  },
  mounts: [
    // Codex CLI auth and session state from the host.
    { hostPath: "~/.codex", sandboxPath: "/home/agent/.codex" },
  ],
});

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full pnpm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function parseCompletionCheck(stdout: string): CompletionCheck {
  const matches = [
    ...stdout.matchAll(
      /<completion-check>\s*([\s\S]*?)\s*<\/completion-check>/g,
    ),
  ];

  if (matches.length === 0) {
    throw new Error("Completion checker did not emit <completion-check> JSON.");
  }

  const rawJson = matches[matches.length - 1]?.[1];
  if (!rawJson) {
    throw new Error("Completion checker emitted an empty verdict.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(
      `Completion checker emitted invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return completionCheckSchema.parse(parsed);
}

function formatCompletionFeedback(check: CompletionCheck): string {
  const missing =
    check.missing.length > 0
      ? check.missing.map((item) => `- ${item}`).join("\n")
      : "- No specific missing items were listed.";

  return [
    "A completion checker found that the issue is not done yet.",
    "",
    `Checker summary: ${check.summary}`,
    "",
    "Missing work:",
    missing,
    "",
    "Instructions for the next implementation pass:",
    check.feedback,
  ].join("\n");
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function codexReview(
  model: string,
  options: { baseBranch: string; effort: "low" | "medium" | "high" | "xhigh" },
): sandcastle.AgentProvider {
  return {
    name: "codex-review",
    env: {},
    captureSessions: false,
    buildPrintCommand({ prompt }) {
      const command = [
        `codex -m ${shellEscape(model)}`,
        `-c ${shellEscape(`model_reasoning_effort="${options.effort}"`)}`,
        "review",
        `--base ${shellEscape(options.baseBranch)}`,
        "-",
      ].join(" ");

      return {
        command: `sh -lc ${shellEscape(
          `${command}; status=$?; if [ "$status" -eq 0 ]; then printf '\\n<promise>COMPLETE</promise>\\n'; fi; exit "$status"`,
        )}`,
        stdin: prompt,
      };
    },
    parseStreamLine(line) {
      return [{ type: "text" as const, text: `${line}\n` }];
    },
  };
}

function formatReviewFeedback(stdout: string): string {
  const reviewOutput = stdout
    .replaceAll("<promise>COMPLETE</promise>", "")
    .trim();

  return [
    "Codex review found actionable issues. Address them before the branch can merge.",
    "",
    reviewOutput.length > 0
      ? reviewOutput
      : "Codex review did not provide details. Re-read the issue and branch diff, then improve the implementation before trying again.",
  ].join("\n");
}

async function loadSandcastleEnv(): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(".sandcastle/.env", "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  const env: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue = ""] = match;
    let value = rawValue.trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value.length > 0) {
      env[key] = value;
    }
  }

  return env;
}

function parseGitHubRepo(remoteUrl: string): GitHubRepo {
  const normalized = remoteUrl.trim().replace(/\.git$/, "");
  const match = normalized.match(
    /github\.com(?::|\/)([^/\s]+)\/([^/\s]+)$/,
  );

  if (!match) {
    throw new Error(`Could not parse GitHub repository from origin URL.`);
  }

  return { owner: match[1]!, name: match[2]! };
}

async function getGitHubRepo(env: Record<string, string>): Promise<GitHubRepo> {
  const repository = env.GITHUB_REPOSITORY ?? process.env.GITHUB_REPOSITORY;

  if (repository) {
    const [owner, name] = repository.split("/");
    if (owner && name) {
      return { owner, name };
    }
  }

  const { stdout } = await execFileAsync(
    "git",
    ["remote", "get-url", "origin"],
    { encoding: "utf8" },
  );

  return parseGitHubRepo(stdout);
}

async function getCurrentGitBranch(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
    encoding: "utf8",
  });

  const branch = stdout.trim();
  if (!branch) {
    throw new Error("Could not determine the current git branch.");
  }

  return branch;
}

async function readGitHubError(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body.length > 0 ? body : response.statusText;
  } catch {
    return response.statusText;
  }
}

async function githubFetch(
  env: Record<string, string>,
  repo: GitHubRepo,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;

  if (!token) {
    throw new Error(
      "GH_TOKEN or GITHUB_TOKEN is required to update GitHub issue labels.",
    );
  }

  return fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function assertGitHubOk(
  response: Response,
  method: string,
  path: string,
): Promise<void> {
  if (response.ok) {
    return;
  }

  const error = await readGitHubError(response);
  throw new Error(
    `GitHub ${method} ${path} failed (${response.status}): ${error}`,
  );
}

async function createGitHubIssueLabels(): Promise<GitHubIssueLabels> {
  const env = { ...process.env, ...(await loadSandcastleEnv()) };
  const repo = await getGitHubRepo(env);

  return {
    async ensureInProgressLabel() {
      const path = "/labels";
      const response = await githubFetch(env, repo, "POST", path, {
        name: IN_PROGRESS_LABEL,
        color: IN_PROGRESS_LABEL_COLOR,
        description: IN_PROGRESS_LABEL_DESCRIPTION,
      });

      if (response.status === 422) {
        return;
      }

      await assertGitHubOk(response, "POST", path);
    },

    async addInProgress(issueId: string) {
      const path = `/issues/${issueId}/labels`;
      const response = await githubFetch(env, repo, "POST", path, {
        labels: [IN_PROGRESS_LABEL],
      });

      await assertGitHubOk(response, "POST", path);
    },

    async removeInProgress(issueId: string) {
      const path = `/issues/${issueId}/labels/${encodeURIComponent(
        IN_PROGRESS_LABEL,
      )}`;
      const response = await githubFetch(env, repo, "DELETE", path);

      if (response.status === 404) {
        return;
      }

      await assertGitHubOk(response, "DELETE", path);
    },
  };
}

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: sandboxProvider,
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    // Opus for planning: dependency analysis benefits from deeper reasoning.
    agent: sandcastle.codex("gpt-5.5", { effort: "xhigh" }),
    promptFile: "./.sandcastle/plan-prompt.md",
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work in parallel:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  const issueLabels = await createGitHubIssueLabels();
  await issueLabels.ensureInProgressLabel();
  const targetBranch = await getCurrentGitBranch();

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Check + Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first, then a completion checker decides whether to retry or review.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      let inProgressAdded = false;
      let sandbox: sandcastle.Sandbox | undefined;

      try {
        await issueLabels.addInProgress(issue.id);
        inProgressAdded = true;

        sandbox = await sandcastle.createSandbox({
          branch: issue.branch,
          sandbox: sandboxProvider,
          hooks,
          copyToWorktree,
        });

        const commits: { sha: string }[] = [];
        let completionFeedback =
          "This is the first implementation attempt. Complete the issue as written.";
        let latestCheck: CompletionCheck | undefined;

        for (let attempt = 1; attempt <= MAX_IMPLEMENT_ATTEMPTS; attempt++) {
          const implement = await sandbox.run({
            name: `implementer-${attempt}`,
            maxIterations: 100,
            agent: sandcastle.codex("gpt-5.5", { effort: "medium" }),
            promptFile: "./.sandcastle/implement-prompt.md",
            promptArgs: {
              TASK_ID: issue.id,
              ISSUE_TITLE: issue.title,
              BRANCH: issue.branch,
              ATTEMPT: String(attempt),
              MAX_ATTEMPTS: String(MAX_IMPLEMENT_ATTEMPTS),
              COMPLETION_FEEDBACK: completionFeedback,
            },
          });

          commits.push(...implement.commits);

          const completionCheck = await sandbox.run({
            name: `completion-check-${attempt}`,
            maxIterations: 1,
            agent: sandcastle.codex("gpt-5.5", { effort: "xhigh" }),
            promptFile: "./.sandcastle/completion-check-prompt.md",
            promptArgs: {
              TASK_ID: issue.id,
              BRANCH: issue.branch,
            },
          });

          if (completionCheck.commits.length > 0) {
            return {
              readyToMerge: false,
              commits,
              reason: "Completion checker made commits during a read-only pass.",
            };
          }

          if (!completionCheck.completionSignal) {
            return {
              readyToMerge: false,
              commits,
              reason: "Completion checker did not signal completion.",
            };
          }

          latestCheck = parseCompletionCheck(completionCheck.stdout);

          if (!latestCheck.complete) {
            console.log(
              `  ${issue.id}: completion check failed on attempt ${attempt}/${MAX_IMPLEMENT_ATTEMPTS}`,
            );
            completionFeedback = formatCompletionFeedback(latestCheck);
            continue;
          }

          if (commits.length === 0) {
            return {
              readyToMerge: false,
              commits,
              completionCheck: latestCheck,
              reason: "Completion check passed, but no commits were produced.",
            };
          }

          const review = await sandbox.run({
            name: "reviewer",
            maxIterations: 1,
            agent: codexReview("gpt-5.5", {
              baseBranch: targetBranch,
              effort: "medium",
            }),
            promptFile: "./.sandcastle/review-prompt.md",
            promptArgs: {
              TASK_ID: issue.id,
              ISSUE_TITLE: issue.title,
              BRANCH: issue.branch,
            },
          });

          if (review.commits.length > 0) {
            return {
              readyToMerge: false,
              commits,
              completionCheck: latestCheck,
              reason: "Codex review made commits during a read-only pass.",
            };
          }

          if (!review.completionSignal) {
            return {
              readyToMerge: false,
              commits,
              completionCheck: latestCheck,
              reason: "Reviewer did not signal completion.",
            };
          }

          if (!review.stdout.includes(REVIEW_CLEAN_SIGNAL)) {
            console.log(
              `  ${issue.id}: codex review requested changes on attempt ${attempt}/${MAX_IMPLEMENT_ATTEMPTS}`,
            );
            completionFeedback = formatReviewFeedback(review.stdout);
            continue;
          }

          return {
            readyToMerge: true,
            commits,
            completionCheck: latestCheck,
          };
        }

        return {
          readyToMerge: false,
          commits,
          completionCheck: latestCheck,
          reason: `Completion check did not pass after ${MAX_IMPLEMENT_ATTEMPTS} attempt(s).`,
        };
      } catch (error) {
        if (inProgressAdded && !sandbox) {
          try {
            await issueLabels.removeInProgress(issue.id);
          } catch (removeError) {
            console.error(
              `  ✗ Failed to clean up ${IN_PROGRESS_LABEL} from issue ${
                issue.id
              } after sandbox setup failed: ${removeError}`,
            );
          }
        }

        throw error;
      } finally {
        await sandbox?.close();
      }
    }),
  );

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${issues[i]!.id} (${issues[i]!.branch}) failed: ${outcome.reason}`,
      );
    } else if (!outcome.value.readyToMerge) {
      console.warn(
        `  ! ${issues[i]!.id} (${issues[i]!.branch}) not ready to merge: ${
          outcome.value.reason ?? "completion check did not pass"
        }`,
      );
    }
  }

  // Only pass branches that passed the completion check and produced commits
  // to the merge phase.
  const completedIssues = settled
    .map((outcome, i) => ({ outcome, issue: issues[i]! }))
    .filter(
      (entry) =>
        entry.outcome.status === "fulfilled" &&
        entry.outcome.value.readyToMerge &&
        entry.outcome.value.commits.length > 0,
    )
    .map((entry) => entry.issue);

  const completedBranches = completedIssues.map((i) => i.branch);

  console.log(
    `\nExecution complete. ${completedBranches.length} branch(es) with commits:`,
  );
  for (const branch of completedBranches) {
    console.log(`  ${branch}`);
  }

  if (completedBranches.length === 0) {
    // No issue passed the completion/review gate this cycle.
    console.log("No completed branches to merge.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 4: Merge
  //
  // One agent merges all completed branches into the current branch,
  // resolving any conflicts and running tests to confirm everything works.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  const merge = await sandcastle.run({
    hooks,
    sandbox: sandboxProvider,
    name: "merger",
    maxIterations: 1,
    agent: sandcastle.codex("gpt-5.5", { effort: "xhigh" }),
    promptFile: "./.sandcastle/merge-prompt.md",
    promptArgs: {
      // A markdown list of branch names, one per line.
      BRANCHES: completedBranches.map((b) => `- ${b}`).join("\n"),
      // A markdown list of issue IDs and titles, one per line.
      ISSUES: completedIssues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
    },
  });

  if (!merge.completionSignal) {
    console.warn(
      "Merge agent did not signal completion. Keeping in-progress labels.",
    );
    continue;
  }

  const labelRemovals = await Promise.allSettled(
    completedIssues.map((issue) => issueLabels.removeInProgress(issue.id)),
  );

  for (const [i, removal] of labelRemovals.entries()) {
    if (removal.status === "rejected") {
      console.error(
        `  ✗ Failed to remove ${IN_PROGRESS_LABEL} from issue ${
          completedIssues[i]!.id
        }: ${removal.reason}`,
      );
    }
  }

  console.log("\nBranches merged.");
}

console.log("\nAll done.");
