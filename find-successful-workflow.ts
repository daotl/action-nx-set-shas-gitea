import * as core from "@actions/core";
import * as github from "@actions/github";
import { giteaApi } from "gitea-js";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { PushEvent } from "@octokit/webhooks-definitions/schema";

const {
  repo: { repo, owner },
  eventName,
} = github.context;
process.env.GITHUB_TOKEN = process.argv[2];
const mainBranchName = process.argv[3];
const errorOnNoSuccessfulWorkflow = process.argv[4];
const _lastSuccessfulEvent = process.argv[5];
const workingDirectory = process.argv[6];
const _workflowId = process.argv[7];
const baseUrl = process.argv[8];
const defaultWorkingDirectory = ".";

const api = giteaApi(baseUrl, {
  token: process.env.GITHUB_TOKEN,
});

let BASE_SHA: string;
(async () => {
  if (workingDirectory !== defaultWorkingDirectory) {
    if (existsSync(workingDirectory)) {
      process.chdir(workingDirectory);
    } else {
      process.stdout.write("\n");
      process.stdout.write(
        `WARNING: Working directory '${workingDirectory}' doesn't exist.\n`,
      );
    }
  }

  const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf-8",
  });
  const HEAD_SHA = headResult.stdout;

  if (
    (["pull_request", "pull_request_target"].includes(eventName) &&
      !github.context.payload.pull_request.merged) ||
    eventName == "merge_group"
  ) {
    try {
      const mergeBaseRef = await findMergeBaseRef();
      const baseResult = spawnSync(
        "git",
        ["merge-base", `origin/${mainBranchName}`, mergeBaseRef],
        { encoding: "utf-8" },
      );
      BASE_SHA = baseResult.stdout;
    } catch (e) {
      core.setFailed(e.message);
      return;
    }
  } else {
    const pushPayload = github.context.payload as PushEvent;

    try {
      BASE_SHA = await findSuccessfulCommit(
        owner,
        repo,
        pushPayload.commits.at(-1)?.id ?? pushPayload.ref,
      );
    } catch (e) {
      core.setFailed(e.message);
      return;
    }

    if (!BASE_SHA) {
      if (errorOnNoSuccessfulWorkflow === "true") {
        reportFailure(mainBranchName);
        return;
      } else {
        process.stdout.write("\n");
        process.stdout.write(
          `WARNING: Unable to find a successful workflow run on 'origin/${mainBranchName}', or the latest successful workflow was connected to a commit which no longer exists on that branch (e.g. if that branch was rebased)\n`,
        );
        process.stdout.write(
          `We are therefore defaulting to use HEAD~1 on 'origin/${mainBranchName}'\n`,
        );
        process.stdout.write("\n");
        process.stdout.write(
          `NOTE: You can instead make this a hard error by setting 'error-on-no-successful-workflow' on the action in your workflow.\n`,
        );
        process.stdout.write("\n");

        const commitCountOutput = spawnSync(
          "git",
          ["rev-list", "--count", `origin/${mainBranchName}`],
          { encoding: "utf-8" },
        ).stdout;
        const commitCount = parseInt(
          stripNewLineEndings(commitCountOutput),
          10,
        );

        const LAST_COMMIT_CMD = `origin/${mainBranchName}${
          commitCount > 1 ? "~1" : ""
        }`;
        const baseRes = spawnSync("git", ["rev-parse", LAST_COMMIT_CMD], {
          encoding: "utf-8",
        });
        BASE_SHA = baseRes.stdout;
        core.setOutput("noPreviousBuild", "true");
      }
    } else {
      process.stdout.write("\n");
      process.stdout.write(
        `Found the last successful workflow run on 'origin/${mainBranchName}'\n`,
      );
      process.stdout.write(`Commit: ${BASE_SHA}\n`);
    }
  }
  core.setOutput("base", stripNewLineEndings(BASE_SHA));
  core.setOutput("head", stripNewLineEndings(HEAD_SHA));
})();

function reportFailure(branchName: string): void {
  core.setFailed(`
    Unable to find a successful workflow run on 'origin/${branchName}'
    NOTE: You have set 'error-on-no-successful-workflow' on the action so this is a hard error.

    Is it possible that you have no runs currently on 'origin/${branchName}'?
    - If yes, then you should run the workflow without this flag first.
    - If no, then you might have changed your git history and those commits no longer exist.`);
}

async function findMergeBaseRef(): Promise<string> {
  if (eventName == "merge_group") {
    const mergeQueueBranch = await findMergeQueueBranch();
    return `origin/${mergeQueueBranch}`;
  } else {
    return "HEAD";
  }
}

function findMergeQueuePr(): string {
  const { head_ref, base_sha } = github.context.payload.merge_group;
  const result = new RegExp(
    `^refs/heads/gh-readonly-queue/${mainBranchName}/pr-(\\d+)-${base_sha}$`,
  ).exec(head_ref);
  return result ? result.at(1) : undefined;
}

async function findMergeQueueBranch(): Promise<string> {
  const pull_number = findMergeQueuePr();
  if (!pull_number) {
    throw new Error("Failed to determine PR number");
  }
  process.stdout.write("\n");
  process.stdout.write(`Found PR #${pull_number} from merge queue branch\n`);

  const result = await api.repos.repoGetPullRequest(owner, repo, +pull_number);
  return result.data.head.ref;
}

/**
 * Strips LF line endings from given string
 */
function stripNewLineEndings(string: string): string {
  return string.replace("\n", "");
}

/**
 * Find last successful workflow run on the repo
 */
async function findSuccessfulCommit(
  owner: string,
  repo: string,
  sha: string,
): Promise<string> {
  let page = 1;
  try {
    while (true) {
      const { data: commitList } = await api.repos.repoGetAllCommits(
        owner,
        repo,
        {
          sha,
          stat: false,
          verification: false,
          files: false,
          page,
          limit: 10,
        },
      );

      if (!commitList.length) {
        return "";
      }

      for (const item of commitList) {
        const { data } = await api.repos.repoGetCombinedStatusByRef(
          owner,
          repo,
          item.sha,
        );

        if (data.state === "success") {
          return item.sha;
        }
      }
      page++;
    }
  } catch (e) {
    console.log("Error:", e);
    return "";
  }
}
