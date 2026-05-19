import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GitHubReviewInboxSource,
  parseReviewDraftV1,
  templateReviewDraftV1,
} from "@aguil/agents-code-review-inbox";
import { writeJsonFile } from "@aguil/agents-core";

const LIST = "list";
const SHOW = "show";
const DRAFT = "draft";
const SUBMIT = "submit";

function printInboxUsage(): void {
  console.log(`Usage: agents code-review inbox <command> [options]

Inbox lists pull requests requesting your review on GitHub (not harness findings or agents triage).

Commands:
  list    List review assignments (default: you; optional team-requested PRs)
  show    Show one PR summary (JSON)
  draft   Write a review draft JSON file for local editing before submit
  submit  Post a review from a draft file (one PR per invocation)

Global options:
  --workspace <path>   Repository workspace (default: cwd)

list options:
  --format text|json   Output format (default: text)
  --include-team       Include PRs with team review requests for your teams

show options:
  --pr <n>             Pull request number (required)
  --repo <o/r>         owner/repo override (default: gh repo view)

draft options:
  --pr <n>             Pull request number (required)
  --repo <o/r>         owner/repo override (default: gh repo view)
  --output <path>      Draft file path (default: ./review-draft.<n>.json)

submit options:
  --draft <path>       Path to draft JSON (required)

Examples:
  agents code-review inbox list
  agents code-review inbox list --format json --include-team
  agents code-review inbox show --pr 42
  agents code-review inbox draft --pr 42 --output ./my-review.json
  agents code-review inbox submit --draft ./my-review.json
`);
}

interface InboxGlobal {
  readonly workspace: string;
}

interface ParsedList extends InboxGlobal {
  readonly command: typeof LIST;
  readonly format: "text" | "json";
  readonly includeTeam: boolean;
}

interface ParsedShow extends InboxGlobal {
  readonly command: typeof SHOW;
  readonly pr: number;
  readonly repo?: string;
}

interface ParsedDraft extends InboxGlobal {
  readonly command: typeof DRAFT;
  readonly pr: number;
  readonly repo?: string;
  readonly output: string;
}

interface ParsedSubmit extends InboxGlobal {
  readonly command: typeof SUBMIT;
  readonly draftPath: string;
}

type ParsedInbox = ParsedList | ParsedShow | ParsedDraft | ParsedSubmit;

function parsePr(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t.length === 0) return undefined;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

export async function runCodeReviewInboxCli(
  argv: readonly string[],
): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printInboxUsage();
    return 0;
  }

  let i = 0;
  let workspace = process.cwd();
  const rest: string[] = [];

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
    rest.push(t);
    i += 1;
  }

  const head = rest[0];
  if (
    head === undefined ||
    head === "--help" ||
    head === "-h" ||
    head.startsWith("-")
  ) {
    printInboxUsage();
    if (head?.startsWith("-")) {
      console.error(`Unexpected option '${head}' before subcommand.`);
      return 1;
    }
    return 0;
  }

  const sub = head;
  const tail = rest.slice(1);

  try {
    const parsed = parseInboxSubcommand(sub, tail, workspace);
    if (parsed === undefined) {
      console.error(`Unknown inbox subcommand '${sub}'.`);
      printInboxUsage();
      return 1;
    }
    return await dispatchInbox(parsed);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

function parseInboxSubcommand(
  sub: string,
  tail: readonly string[],
  workspace: string,
): ParsedInbox | undefined {
  if (sub === LIST) {
    let format: "text" | "json" = "text";
    let includeTeam = false;
    let j = 0;
    while (j < tail.length) {
      const t = tail[j];
      if (t === "--format") {
        const v = tail[j + 1];
        if (v !== "text" && v !== "json") {
          throw new Error("--format expects text or json.");
        }
        format = v;
        j += 2;
        continue;
      }
      if (t.startsWith("--format=")) {
        const v = t.slice("--format=".length);
        if (v !== "text" && v !== "json") {
          throw new Error("--format expects text or json.");
        }
        format = v;
        j += 1;
        continue;
      }
      if (t === "--include-team") {
        includeTeam = true;
        j += 1;
        continue;
      }
      throw new Error(`Unknown list option '${t}'.`);
    }
    return { command: LIST, workspace, format, includeTeam };
  }

  if (sub === SHOW) {
    const { pr, repo } = parsePrAndRepo(tail);
    return { command: SHOW, workspace, pr, repo };
  }

  if (sub === DRAFT) {
    const { pr, repo, output } = parseDraftArgs(tail, workspace);
    return { command: DRAFT, workspace, pr, repo, output };
  }

  if (sub === SUBMIT) {
    let draftPath: string | undefined;
    let j = 0;
    while (j < tail.length) {
      const t = tail[j];
      if (t === "--draft") {
        draftPath = tail[j + 1];
        if (draftPath === undefined || draftPath.startsWith("--")) {
          throw new Error("--draft expects a path.");
        }
        j += 2;
        continue;
      }
      if (t.startsWith("--draft=")) {
        draftPath = t.slice("--draft=".length);
        j += 1;
        continue;
      }
      throw new Error(`Unknown submit option '${t}'.`);
    }
    if (draftPath === undefined || draftPath.trim().length === 0) {
      throw new Error("submit requires --draft <path>.");
    }
    return {
      command: SUBMIT,
      workspace,
      draftPath: resolve(workspace, draftPath.trim()),
    };
  }

  return undefined;
}

function parsePrAndRepo(tail: readonly string[]): {
  readonly pr: number;
  readonly repo?: string;
} {
  let pr: number | undefined;
  let repo: string | undefined;
  let j = 0;
  while (j < tail.length) {
    const t = tail[j];
    if (t === "--pr") {
      pr = parsePr(tail[j + 1]);
      if (pr === undefined) {
        throw new Error("--pr expects a positive integer.");
      }
      j += 2;
      continue;
    }
    if (t.startsWith("--pr=")) {
      pr = parsePr(t.slice("--pr=".length));
      if (pr === undefined) {
        throw new Error("--pr expects a positive integer.");
      }
      j += 1;
      continue;
    }
    if (t === "--repo") {
      repo = tail[j + 1]?.trim();
      if (repo === undefined || repo.length === 0 || !repo.includes("/")) {
        throw new Error("--repo expects owner/name.");
      }
      j += 2;
      continue;
    }
    if (t.startsWith("--repo=")) {
      repo = t.slice("--repo=".length).trim();
      if (repo.length === 0 || !repo.includes("/")) {
        throw new Error("--repo expects owner/name.");
      }
      j += 1;
      continue;
    }
    throw new Error(`Unknown option '${t}'.`);
  }
  if (pr === undefined) {
    throw new Error("--pr is required.");
  }
  return repo !== undefined ? { pr, repo } : { pr };
}

function parseDraftArgs(
  tail: readonly string[],
  workspace: string,
): { readonly pr: number; readonly repo?: string; readonly output: string } {
  let output: string | undefined;
  const copied = [...tail];
  const filtered: string[] = [];
  let j = 0;
  while (j < copied.length) {
    const t = copied[j];
    if (t === "--output") {
      const v = copied[j + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error("--output expects a path.");
      }
      output = v;
      j += 2;
      continue;
    }
    if (t.startsWith("--output=")) {
      output = t.slice("--output=".length);
      j += 1;
      continue;
    }
    filtered.push(t);
    j += 1;
  }
  const { pr, repo } = parsePrAndRepo(filtered);
  const out =
    output !== undefined && output.trim().length > 0
      ? resolve(workspace, output.trim())
      : resolve(workspace, `review-draft.${pr}.json`);
  return repo !== undefined ? { pr, repo, output: out } : { pr, output: out };
}

async function dispatchInbox(parsed: ParsedInbox): Promise<number> {
  const source = new GitHubReviewInboxSource();

  if (parsed.command === LIST) {
    const items = await source.listAssignments({
      workspacePath: parsed.workspace,
      includeTeam: parsed.includeTeam,
    });
    if (parsed.format === "json") {
      console.log(
        `${JSON.stringify(
          {
            schemaId:
              "https://aguil.dev/schemas/agents/code-review-inbox-list/v1",
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            assignments: items,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      for (const a of items) {
        const tag =
          a.assignmentKind === "team" ? `team:${a.teamSlug ?? "?"}` : "me";
        console.log(
          `${a.repository}#${a.pullNumber}\t${tag}\t${a.title}\t${a.url}`,
        );
      }
    }
    return 0;
  }

  if (parsed.command === SHOW) {
    const repo =
      parsed.repo ??
      (await source.resolveDefaultRepository({
        workspacePath: parsed.workspace,
      }));
    const row = await source.viewPullRequestMetadata({
      workspacePath: parsed.workspace,
      repository: repo,
      pullNumber: parsed.pr,
    });
    console.log(`${JSON.stringify(row, null, 2)}\n`);
    return 0;
  }

  if (parsed.command === DRAFT) {
    const repo =
      parsed.repo ??
      (await source.resolveDefaultRepository({
        workspacePath: parsed.workspace,
      }));
    const draft = templateReviewDraftV1({
      repository: repo,
      pullNumber: parsed.pr,
    });
    await writeJsonFile(parsed.output, draft);
    console.log(`Wrote draft template to ${parsed.output}`);
    console.log(
      "Edit body and event (comment | approve | request_changes), then: agents code-review inbox submit --draft <path>",
    );
    return 0;
  }

  const raw = JSON.parse(await readFile(parsed.draftPath, "utf8")) as unknown;
  const draft = parseReviewDraftV1(raw);
  const result = await source.submitReview({
    workspacePath: parsed.workspace,
    draft,
  });
  console.log(`Submitted review on ${result.reviewUrl}`);
  return 0;
}
