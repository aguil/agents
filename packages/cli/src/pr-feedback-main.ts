import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GitHubReviewInboxSource } from "@aguil/agents-code-review-inbox";
import {
  collectPrFeedback,
  loadFeedbackDocument,
  parsePrFeedbackResponsesV1,
  submitPrFeedbackReplies,
} from "@aguil/agents-pr-feedback";
import { expandReposRoot, findClonePath } from "./code-review-workspace";

function printPrFeedbackUsage(): void {
  console.log(`Usage: agents pr-feedback <command> [options]

Commands:
  collect   Export unresolved review threads to feedback.json (scope A)
  submit    Post thread replies from a responses draft (operator-approved)

Global:
  --workspace <path>   Workspace for gh (default: cwd)
  --repos-root <path>  Clone root when resolving --repo (default ~/dev/repos)

collect:
  --pr <n>             Pull request number (required)
  --repo <owner/name>  Repository (default: gh repo view in workspace)
  --output <dir>       Output directory (default: .agents-pr-feedback/<repo>-<n>/)

submit:
  --draft <path>       pr-feedback-responses/v1 JSON (required)
  --feedback <path>    feedback.json from collect (default: sibling of draft or --output)
  --pr <n>             Validate PR number matches draft
  --repo <owner/name>  Validate repository matches draft
  --dry-run            Print replies without posting

Examples:
  agents pr-feedback collect --pr 42 --repo org/repo
  agents pr-feedback submit --draft ./responses.json --feedback ./.agents-pr-feedback/org-repo-42/feedback.json
`);
}

function parsePr(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s.trim());
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

export async function runPrFeedbackCli(
  argv: readonly string[],
): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printPrFeedbackUsage();
    return 0;
  }

  let workspace = process.cwd();
  let reposRootCli: string | undefined;
  const rest: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (t === "--workspace") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        console.error("--workspace expects a path.");
        return 1;
      }
      workspace = resolve(v);
      i += 2;
      continue;
    }
    if (t.startsWith("--workspace=")) {
      workspace = resolve(t.slice("--workspace=".length));
      i += 1;
      continue;
    }
    if (t === "--repos-root") {
      reposRootCli = argv[i + 1];
      if (reposRootCli === undefined || reposRootCli.startsWith("--")) {
        console.error("--repos-root expects a path.");
        return 1;
      }
      i += 2;
      continue;
    }
    if (t.startsWith("--repos-root=")) {
      reposRootCli = t.slice("--repos-root=".length);
      i += 1;
      continue;
    }
    rest.push(t);
    i += 1;
  }

  const cmd = rest[0];
  const tail = rest.slice(1);
  if (cmd !== "collect" && cmd !== "submit") {
    console.error(`Unknown pr-feedback command '${cmd ?? ""}'.`);
    printPrFeedbackUsage();
    return 1;
  }

  const reposAbs = expandReposRoot(
    reposRootCli !== undefined && reposRootCli.trim().length > 0
      ? reposRootCli.trim()
      : undefined,
  );

  if (cmd === "collect") {
    let pr: number | undefined;
    let repo: string | undefined;
    let output: string | undefined;
    let j = 0;
    while (j < tail.length) {
      const t = tail[j];
      if (t === "--pr") {
        pr = parsePr(tail[j + 1]);
        j += 2;
        continue;
      }
      if (t.startsWith("--pr=")) {
        pr = parsePr(t.slice("--pr=".length));
        j += 1;
        continue;
      }
      if (t === "--repo") {
        repo = tail[j + 1]?.trim();
        j += 2;
        continue;
      }
      if (t.startsWith("--repo=")) {
        repo = t.slice("--repo=".length).trim();
        j += 1;
        continue;
      }
      if (t === "--output") {
        output = tail[j + 1];
        j += 2;
        continue;
      }
      if (t.startsWith("--output=")) {
        output = t.slice("--output=".length);
        j += 1;
        continue;
      }
      console.error(`Unknown collect option '${t}'.`);
      return 1;
    }
    if (pr === undefined) {
      console.error("collect requires --pr <n>.");
      return 1;
    }
    let workspacePath = workspace;
    if (repo !== undefined) {
      const hit = await findClonePath(repo, reposAbs);
      if (hit !== undefined) {
        workspacePath = hit;
      }
    }
    const source = new GitHubReviewInboxSource();
    const repository =
      repo ?? (await source.resolveDefaultRepository({ workspacePath }));
    const { outputDir, document } = await collectPrFeedback({
      workspacePath,
      repository,
      pullNumber: pr,
      ...(output !== undefined ? { outputDir: output } : {}),
    });
    console.log(
      `Wrote ${document.items.length} item(s) to ${join(outputDir, "feedback.json")}`,
    );
    return 0;
  }

  let draftPath: string | undefined;
  let feedbackPath: string | undefined;
  let dryRun = false;
  let expectPr: number | undefined;
  let expectRepo: string | undefined;
  let j = 0;
  while (j < tail.length) {
    const t = tail[j];
    if (t === "--draft") {
      draftPath = tail[j + 1];
      j += 2;
      continue;
    }
    if (t.startsWith("--draft=")) {
      draftPath = t.slice("--draft=".length);
      j += 1;
      continue;
    }
    if (t === "--feedback") {
      feedbackPath = tail[j + 1];
      j += 2;
      continue;
    }
    if (t.startsWith("--feedback=")) {
      feedbackPath = t.slice("--feedback=".length);
      j += 1;
      continue;
    }
    if (t === "--dry-run") {
      dryRun = true;
      j += 1;
      continue;
    }
    if (t === "--pr") {
      expectPr = parsePr(tail[j + 1]);
      j += 2;
      continue;
    }
    if (t.startsWith("--pr=")) {
      expectPr = parsePr(t.slice("--pr=".length));
      j += 1;
      continue;
    }
    if (t === "--repo") {
      expectRepo = tail[j + 1]?.trim();
      j += 2;
      continue;
    }
    if (t.startsWith("--repo=")) {
      expectRepo = t.slice("--repo=".length).trim();
      j += 1;
      continue;
    }
    console.error(`Unknown submit option '${t}'.`);
    return 1;
  }

  if (draftPath === undefined || draftPath.trim().length === 0) {
    console.error("submit requires --draft <path>.");
    return 1;
  }

  const draftResolved = resolve(process.cwd(), draftPath.trim());
  const rawDraft = JSON.parse(await readFile(draftResolved, "utf8")) as unknown;
  const responses = parsePrFeedbackResponsesV1(rawDraft);

  if (expectPr !== undefined && expectPr !== responses.pullNumber) {
    console.error("--pr does not match draft pullNumber.");
    return 1;
  }
  if (expectRepo !== undefined && expectRepo !== responses.repository) {
    console.error("--repo does not match draft repository.");
    return 1;
  }

  let workspacePath = workspace;
  const hit = await findClonePath(responses.repository, reposAbs);
  if (hit !== undefined) {
    workspacePath = hit;
  }

  const feedbackResolved =
    feedbackPath !== undefined
      ? resolve(process.cwd(), feedbackPath.trim())
      : join(resolve(draftResolved, ".."), "feedback.json");
  const feedback = await loadFeedbackDocument(feedbackResolved);

  const { posted } = await submitPrFeedbackReplies({
    workspacePath,
    responses,
    feedback,
    dryRun,
  });

  if (dryRun) {
    console.log(`Dry-run: ${responses.replies.length} reply(ies) not posted.`);
  } else {
    console.log(
      `Posted ${posted} reply(ies) on ${responses.repository}#${responses.pullNumber}.`,
    );
  }
  return 0;
}
